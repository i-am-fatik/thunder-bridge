import type { RequestOptions } from "node:https";
import { Readable } from "node:stream";

import { expect, test, vi } from "vitest";

import { pinnedToTheAddressWeVerified } from "./pinned.ts";

type Answering = { statusCode: number; headers: Record<string, string | string[]>; body: string[] };

const asked: RequestOptions[] = [];
const written: string[] = [];
let answering: Answering = { statusCode: 200, headers: {}, body: ["{}"] };
let destroyed: Error | null = null;

vi.mock("node:https", () => ({
	request: (options: RequestOptions, whenAnswered: (answer: Readable) => void) => {
		asked.push(options);
		const call = Object.assign(new Readable({ read() {} }), {
			write: (chunk: string) => void written.push(chunk),
			end: () => {
				const answer = Object.assign(Readable.from(answering.body.map((one) => Buffer.from(one))), {
					statusCode: answering.statusCode,
					headers: answering.headers,
				});
				queueMicrotask(() => whenAnswered(answer as unknown as Readable));
			},
			destroy: (error: Error) => void (destroyed = error),
		});

		return call;
	},
}));

const VERIFIED = [{ address: "93.184.216.34", family: 4 }];

function freshly(): void {
	asked.length = 0;
	written.length = 0;
	destroyed = null;
	answering = { statusCode: 200, headers: {}, body: ["{}"] };
}

function optionsOf(index = 0): RequestOptions {
	const options = asked[index];
	if (options === undefined) {
		throw new Error("nothing was asked");
	}

	return options;
}

function addressesItWouldConnectTo(options: RequestOptions): unknown {
	let given: unknown = null;
	const lookup = options.lookup as unknown as (
		name: string,
		hints: { all?: boolean },
		done: (error: null, found: unknown) => void,
	) => void;
	lookup("example.com", { all: true }, (_error, found) => void (given = found));

	return given;
}

test("it connects to the address already verified and never asks the name again", async () => {
	freshly();
	await pinnedToTheAddressWeVerified(
		"https://example.com/pay",
		{},
		AbortSignal.timeout(5000),
		VERIFIED,
	);

	const options = optionsOf();
	expect(options.host).toBe("example.com");
	expect(options.agent).toBe(false);
	expect(addressesItWouldConnectTo(options)).toEqual([{ address: "93.184.216.34", family: 4 }]);
});

test("the certificate is still checked against the name, not against the address", async () => {
	freshly();
	await pinnedToTheAddressWeVerified(
		"https://example.com/pay",
		{},
		AbortSignal.timeout(5000),
		VERIFIED,
	);

	expect(optionsOf().servername).toBe("example.com");
	expect((optionsOf().headers as Record<string, string>)["host"]).toBe("example.com");
});

test("a port of its own is kept, and so is the Host that names it", async () => {
	freshly();
	await pinnedToTheAddressWeVerified(
		"https://wallet.example:8443/pay?id=7",
		{},
		AbortSignal.timeout(5000),
		VERIFIED,
	);

	expect(optionsOf().port).toBe(8443);
	expect(optionsOf().path).toBe("/pay?id=7");
	expect((optionsOf().headers as Record<string, string>)["host"]).toBe("wallet.example:8443");
});

test("the method, the headers and the body all travel", async () => {
	freshly();
	await pinnedToTheAddressWeVerified(
		"https://example.com/hook",
		{ method: "POST", headers: { "content-type": "application/json" }, body: '{"nonce":"a"}' },
		AbortSignal.timeout(5000),
		VERIFIED,
	);

	expect(optionsOf().method).toBe("POST");
	expect((optionsOf().headers as Record<string, string>)["content-type"]).toBe("application/json");
	expect(written).toEqual(['{"nonce":"a"}']);
});

test("what came back is a Response the rest of the code already knows how to read", async () => {
	freshly();
	answering = {
		statusCode: 200,
		headers: { "cache-control": "max-age=5", "ratelimit-limit": "12;w=60" },
		body: ['{"settled":false}'],
	};
	const answer = await pinnedToTheAddressWeVerified(
		"https://example.com/verify",
		{},
		AbortSignal.timeout(5000),
		VERIFIED,
	);

	expect(answer.status).toBe(200);
	expect(answer.headers.get("cache-control")).toBe("max-age=5");
	expect(answer.headers.get("ratelimit-limit")).toBe("12;w=60");
	expect(await answer.json()).toEqual({ settled: false });
});

test("a redirect comes back with its location, so the guard runs on the next hop too", async () => {
	freshly();
	answering = { statusCode: 302, headers: { location: "https://elsewhere.example/pay" }, body: [] };
	const answer = await pinnedToTheAddressWeVerified(
		"https://example.com/pay",
		{},
		AbortSignal.timeout(5000),
		VERIFIED,
	);

	expect(answer.status).toBe(302);
	expect(answer.headers.get("location")).toBe("https://elsewhere.example/pay");
});

test("a status that carries no body is not given one", async () => {
	freshly();
	answering = { statusCode: 204, headers: {}, body: [] };
	const answer = await pinnedToTheAddressWeVerified(
		"https://example.com/pay",
		{},
		AbortSignal.timeout(5000),
		VERIFIED,
	);

	expect(answer.status).toBe(204);
	expect(answer.body).toBeNull();
});

test("a header sent more than once keeps every value", async () => {
	freshly();
	answering = { statusCode: 200, headers: { "set-cookie": ["a=1", "b=2"] }, body: ["{}"] };
	const answer = await pinnedToTheAddressWeVerified(
		"https://example.com/pay",
		{},
		AbortSignal.timeout(5000),
		VERIFIED,
	);

	expect(answer.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
});

test("nothing is attempted once the deadline has already passed", async () => {
	freshly();
	const already = AbortSignal.abort(new Error("too late"));

	await expect(
		pinnedToTheAddressWeVerified("https://example.com/pay", {}, already, VERIFIED),
	).rejects.toThrow("too late");
	expect(asked).toHaveLength(0);
});

test("a deadline reached mid-flight tears the call down", async () => {
	freshly();
	const deadline = new AbortController();
	const answered = pinnedToTheAddressWeVerified(
		"https://example.com/pay",
		{},
		deadline.signal,
		VERIFIED,
	);
	deadline.abort();
	await answered;

	expect(destroyed).toBeInstanceOf(Error);
});

test("no address to connect to is refused rather than resolved from scratch", () => {
	freshly();

	expect(() =>
		pinnedToTheAddressWeVerified("https://example.com/pay", {}, AbortSignal.timeout(5000), []),
	).toThrow("resolved to nothing worth connecting to");
	expect(asked).toHaveLength(0);
});
