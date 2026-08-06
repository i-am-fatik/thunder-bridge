import { expect, test } from "vitest";

import { ask, BODY_LIMIT_BYTES, resolvesPublic } from "./outbound.ts";

const ENTRY = "https://wallet.example/pay";
const ELSEWHERE = "https://other.example/pay";
const METADATA_SERVICE = "http://169.254.169.254/latest/meta-data/";

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

test("a redirect towards the metadata service is refused and never followed", async () => {
	const { seen, restore } = answering(() => redirect(METADATA_SERVICE));
	try {
		await expect(ask(ENTRY)).rejects.toThrow(/not a public https URL/);
		expect(seen).toEqual([ENTRY]);
	} finally {
		restore();
	}
});

test("a redirect towards a private address is refused even when it stays on https", async () => {
	const { seen, restore } = answering(() => redirect("https://10.0.0.7/admin"));
	try {
		await expect(ask(ENTRY)).rejects.toThrow(/not a public https URL/);
		expect(seen).toEqual([ENTRY]);
	} finally {
		restore();
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

test("an answer longer than we read comes back marked truncated", async () => {
	const { restore } = answering(() => new Response("a".repeat(BODY_LIMIT_BYTES + 1)));
	try {
		const answer = await ask(ENTRY);
		expect(answer.truncated).toBe(true);
		expect(answer.body.length).toBeLessThanOrEqual(BODY_LIMIT_BYTES + 1);
	} finally {
		restore();
	}
});

test("an answer that fits is not marked truncated", async () => {
	const { restore } = answering(() => new Response("a".repeat(BODY_LIMIT_BYTES)));
	try {
		const answer = await ask(ENTRY);
		expect(answer.truncated).toBe(false);
		expect(answer.body).toHaveLength(BODY_LIMIT_BYTES);
	} finally {
		restore();
	}
});

test("an empty answer is read without a body to read", async () => {
	const { restore } = answering(() => new Response(null, { status: 204 }));
	try {
		const answer = await ask(ENTRY);
		expect(answer).toEqual({ status: 204, ok: true, body: "", truncated: false });
	} finally {
		restore();
	}
});

test("a name that resolves to a private address is not one we reach", async () => {
	expect(await resolvesPublic("https://127.0.0.1/")).toBe(false);
	expect(await resolvesPublic("https://[::1]/")).toBe(false);
	expect(await resolvesPublic("https://10.11.12.13/")).toBe(false);
});

test("a name nothing answers for is left to the connection to refuse", async () => {
	expect(await resolvesPublic("https://nothing.example/")).toBe(true);
});
