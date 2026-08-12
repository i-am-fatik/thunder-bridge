import type { LookupAllOptions } from "node:dns";

import { expect, test, vi } from "vitest";

import { addressesToReach, ask, resolvesNothingPrivate } from "./outbound.ts";

vi.mock("node:dns/promises", async (importOriginal) => {
	const dns = await importOriginal<typeof import("node:dns/promises")>();
	return {
		...dns,
		lookup: (host: string, options: LookupAllOptions) =>
			host === "nothing.example" ? Promise.reject(new Error("ENOTFOUND")) : dns.lookup(host, options),
	};
});

const ENTRY = "https://93.184.216.34/pay";
const ELSEWHERE = "https://198.51.100.7/pay";
const READ_LIMIT = 262_144;

function answering(answer: (url: string, sent: RequestInit) => Response): {
	seen: string[];
	restore: () => void;
} {
	const real = globalThis.fetch;
	const seen: string[] = [];
	globalThis.fetch = ((target: string | URL | Request, sent?: RequestInit) => {
		seen.push(String(target));
		return Promise.resolve(answer(String(target), sent ?? {}));
	}) as typeof fetch;

	return { seen, restore: () => void (globalThis.fetch = real) };
}

function redirect(to: string, status = 302): Response {
	return new Response(null, { status, headers: { location: to } });
}

test("a redirect is refused and never followed when it leaves what we will reach", async () => {
	for (const somewhere of [
		"http://other.example/pay",
		"https://10.0.0.7/admin",
		"https://169.254.169.254/latest/meta-data/",
		"https://[fd00::1]/admin",
	]) {
		const { seen, restore } = answering(() => redirect(somewhere));
		try {
			await expect(ask(ENTRY)).rejects.toThrow(/not a public https URL/);
			expect(seen).toEqual([ENTRY]);
		} finally {
			restore();
		}
	}
});

test("a redirect to another public server is followed and its answer comes back", async () => {
	const { seen, restore } = answering((url) =>
		url === ENTRY ? redirect(ELSEWHERE) : Response.json({ pr: "lnbc1" }),
	);
	try {
		const answer = await ask(ENTRY);
		expect(JSON.parse(answer.body)).toEqual({ pr: "lnbc1" });
		expect(seen).toEqual([ENTRY, ELSEWHERE]);
	} finally {
		restore();
	}
});

test("a server that keeps redirecting is given up on", async () => {
	const { seen, restore } = answering(() => redirect(ELSEWHERE));
	try {
		await expect(ask(ENTRY)).rejects.toThrow(/redirected more than 2 times/);
		expect(seen).toHaveLength(3);
	} finally {
		restore();
	}
});

test("a redirect that does not keep the method drops the body with it", async () => {
	const sent: RequestInit[] = [];
	const { restore } = answering((url, options) => {
		sent.push(options);
		return url === ENTRY ? redirect(ELSEWHERE, 303) : new Response("done");
	});
	try {
		await ask(ENTRY, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
		expect(sent[0]).toMatchObject({ method: "POST", body: "{}" });
		expect(sent[1]).toMatchObject({ method: "GET" });
		expect(sent[1]?.body).toBeUndefined();
		expect(sent[1]?.headers).toEqual({});
	} finally {
		restore();
	}
});

test("a redirect that keeps the method carries the body on", async () => {
	const sent: RequestInit[] = [];
	const { restore } = answering((url, options) => {
		sent.push(options);
		return url === ENTRY ? redirect(ELSEWHERE, 308) : new Response("done");
	});
	try {
		await ask(ENTRY, { method: "POST", body: "{}" });
		expect(sent[1]).toMatchObject({ method: "POST", body: "{}" });
	} finally {
		restore();
	}
});

test("a server that never stops talking is cut off, not read to the end", async () => {
	const chunk = 65_536;
	let pulled = 0;
	const forever = new ReadableStream({
		pull(stream) {
			pulled += 1;
			stream.enqueue(new Uint8Array(chunk).fill(97));
		},
	});
	const { restore } = answering(() => new Response(forever));
	try {
		const answer = await ask(ENTRY);

		expect(answer.truncated).toBe(true);
		expect(pulled).toBeLessThanOrEqual(READ_LIMIT / chunk + 2);
		expect(answer.body.length).toBeLessThanOrEqual(READ_LIMIT + chunk);
	} finally {
		restore();
	}
});

test("an answer that fits is not marked truncated", async () => {
	const { restore } = answering(() => new Response("a".repeat(READ_LIMIT)));
	try {
		const answer = await ask(ENTRY);
		expect(answer.truncated).toBe(false);
		expect(answer.body).toHaveLength(READ_LIMIT);
	} finally {
		restore();
	}
});

test("an empty answer is read without a body to read", async () => {
	const { restore } = answering(() => new Response(null, { status: 204 }));
	try {
		const answer = await ask(ENTRY);
		expect(answer).toMatchObject({ status: 204, ok: true, body: "", truncated: false });
	} finally {
		restore();
	}
});

test("a redirect that does not say where to is refused rather than retried", async () => {
	const { seen, restore } = answering(() => new Response(null, { status: 302 }));
	try {
		await expect(ask(ENTRY, { method: "POST", body: "{}" })).rejects.toThrow(/without saying where to/);
		expect(seen).toEqual([ENTRY]);
	} finally {
		restore();
	}
});

test("credentials do not travel to a second origin", async () => {
	const sent: RequestInit[] = [];
	const { restore } = answering((url, options) => {
		sent.push(options);
		return url === ENTRY ? redirect(ELSEWHERE, 307) : new Response("done");
	});
	try {
		await ask(ENTRY, { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" });
		expect(sent[0]?.headers).toEqual({ authorization: "Bearer secret" });
		expect(sent[1]?.headers).toEqual({});
	} finally {
		restore();
	}
});

test("credentials do travel to another path on the same origin", async () => {
	const sent: RequestInit[] = [];
	const { restore } = answering((url, options) => {
		sent.push(options);
		return url === ENTRY ? redirect("https://93.184.216.34/moved", 307) : new Response("done");
	});
	try {
		await ask(ENTRY, { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" });
		expect(sent[1]?.headers).toEqual({ authorization: "Bearer secret" });
	} finally {
		restore();
	}
});

test("a name that resolves to a private address is not one we reach", async () => {
	expect(await resolvesNothingPrivate("https://127.0.0.1/")).toBe(false);
	expect(await resolvesNothingPrivate("https://[::1]/")).toBe(false);
	expect(await resolvesNothingPrivate("https://10.11.12.13/")).toBe(false);
});

test("a name nothing answers for is refused here, not left to the connection", async () => {
	expect(await resolvesNothingPrivate("https://nothing.example/")).toBe(false);
	await expect(addressesToReach("https://nothing.example/")).rejects.toThrow(
		"resolves to an address we do not reach",
	);
});

test("what is verified is handed on, so nothing resolves the name a second time", async () => {
	const at = await addressesToReach("https://example.com/");

	expect(at.length).toBeGreaterThan(0);
	expect(at.every((one) => typeof one.address === "string" && one.family > 0)).toBe(true);
});
