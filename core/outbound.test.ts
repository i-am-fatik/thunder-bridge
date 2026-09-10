import type { LookupAllOptions } from "node:dns";

import { expect, test, vi } from "vitest";

import {
	addressesToReach,
	ask,
	resolvesNothingPrivate,
	type Send,
	type Sent,
	type Verified,
} from "./outbound.ts";

vi.mock("node:dns/promises", async (importOriginal) => {
	const dns = await importOriginal<typeof import("node:dns/promises")>();
	return {
		...dns,
		lookup: (host: string, options: LookupAllOptions) =>
			host === "nothing.example"
				? Promise.reject(new Error("ENOTFOUND"))
				: dns.lookup(host, options),
	};
});

const ENTRY = "https://93.184.216.34/pay";
const ELSEWHERE = "https://198.51.100.7/pay";
const READ_LIMIT = 262_144;

function answering(answer: (url: string, sent: Sent) => Response): {
	send: Send;
	seen: string[];
} {
	const seen: string[] = [];
	const send: Send = async (url, sent) => {
		seen.push(url);
		return answer(url, sent);
	};

	return { send, seen };
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
		const { send, seen } = answering(() => redirect(somewhere));
		await expect(ask(send, ENTRY)).rejects.toThrow(/not a public https URL/);
		expect(seen).toEqual([ENTRY]);
	}
});

test("a redirect to another public server is followed and its answer comes back", async () => {
	const { send, seen } = answering((url) =>
		url === ENTRY ? redirect(ELSEWHERE) : Response.json({ pr: "lnbc1" }),
	);
	const answer = await ask(send, ENTRY);
	expect(JSON.parse(answer.body)).toEqual({ pr: "lnbc1" });
	expect(seen).toEqual([ENTRY, ELSEWHERE]);
});

test("a server that keeps redirecting is given up on", async () => {
	const { send, seen } = answering(() => redirect(ELSEWHERE));
	await expect(ask(send, ENTRY)).rejects.toThrow(/redirected more than 2 times/);
	expect(seen).toHaveLength(3);
});

test("a redirect that does not keep the method drops the body with it", async () => {
	const sent: Sent[] = [];
	const { send } = answering((url, options) => {
		sent.push(options);
		return url === ENTRY ? redirect(ELSEWHERE, 303) : new Response("done");
	});
	await ask(send, ENTRY, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	expect(sent[0]).toMatchObject({ method: "POST", body: "{}" });
	expect(sent[1]).toMatchObject({ method: "GET" });
	expect(sent[1]?.body).toBeUndefined();
	expect(sent[1]?.headers).toEqual({});
});

test("a redirect that keeps the method carries the body on", async () => {
	const sent: Sent[] = [];
	const { send } = answering((url, options) => {
		sent.push(options);
		return url === ENTRY ? redirect(ELSEWHERE, 308) : new Response("done");
	});
	await ask(send, ENTRY, { method: "POST", body: "{}" });
	expect(sent[1]).toMatchObject({ method: "POST", body: "{}" });
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
	const { send } = answering(() => new Response(forever));
	const answer = await ask(send, ENTRY);

	expect(answer.truncated).toBe(true);
	expect(pulled).toBeLessThanOrEqual(READ_LIMIT / chunk + 2);
	expect(answer.body.length).toBeLessThanOrEqual(READ_LIMIT + chunk);
});

test("an answer that fits is not marked truncated", async () => {
	const { send } = answering(() => new Response("a".repeat(READ_LIMIT)));
	const answer = await ask(send, ENTRY);
	expect(answer.truncated).toBe(false);
	expect(answer.body).toHaveLength(READ_LIMIT);
});

test("an empty answer is read without a body to read", async () => {
	const { send } = answering(() => new Response(null, { status: 204 }));
	const answer = await ask(send, ENTRY);
	expect(answer).toMatchObject({ status: 204, ok: true, body: "", truncated: false });
});

test("a redirect that does not say where to is refused rather than retried", async () => {
	const { send, seen } = answering(() => new Response(null, { status: 302 }));
	await expect(ask(send, ENTRY, { method: "POST", body: "{}" })).rejects.toThrow(
		/without saying where to/,
	);
	expect(seen).toEqual([ENTRY]);
});

test("credentials do not travel to a second origin", async () => {
	const sent: Sent[] = [];
	const { send } = answering((url, options) => {
		sent.push(options);
		return url === ENTRY ? redirect(ELSEWHERE, 307) : new Response("done");
	});
	await ask(send, ENTRY, {
		method: "POST",
		headers: { authorization: "Bearer secret" },
		body: "{}",
	});
	expect(sent[0]?.headers).toEqual({ authorization: "Bearer secret" });
	expect(sent[1]?.headers).toEqual({});
});

test("credentials do travel to another path on the same origin", async () => {
	const sent: Sent[] = [];
	const { send } = answering((url, options) => {
		sent.push(options);
		return url === ENTRY ? redirect("https://93.184.216.34/moved", 307) : new Response("done");
	});
	await ask(send, ENTRY, {
		method: "POST",
		headers: { authorization: "Bearer secret" },
		body: "{}",
	});
	expect(sent[1]?.headers).toEqual({ authorization: "Bearer secret" });
});

test("the transport is handed the addresses that were verified, so it never resolves the name itself", async () => {
	const handed: Verified[][] = [];
	const send: Send = async (_url, _sent, _signal, at) => {
		handed.push([...at]);
		return new Response("done");
	};

	await ask(send, ENTRY);

	expect(handed).toEqual([[{ address: "93.184.216.34", family: 4 }]]);
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
