import { expect, test, vi } from "vitest";

import type { Send } from "../core/outbound.ts";
import {
	byDomain,
	lud16Of,
	type Measured,
	measure,
	type Verdict,
	verdictOf,
} from "./lud21-harvest.ts";

vi.mock("node:dns/promises", () => ({ lookup: everyHostResolvesPublic }));

async function everyHostResolvesPublic(): Promise<{ address: string; family: number }[]> {
	return [{ address: "203.0.113.1", family: 4 }];
}

function sampled(verdicts: Verdict[]): Measured[] {
	return verdicts.map((verdict, index) => ({
		address: `someone${index}@example.com`,
		verdict,
		note: "",
	}));
}

test("one usable address proves a domain, however many broken ones sit beside it", () => {
	expect(verdictOf(sampled(["unreachable", "unreachable", "usable"]))).toBe("usable");
	expect(verdictOf(sampled(["no-verify", "usable"]))).toBe("usable");
});

test("broken addresses settle nothing, which is not the same as no verify", () => {
	expect(verdictOf(sampled(["unreachable", "unreachable"]))).toBe("unsettled");
	expect(verdictOf(sampled(["amount-refused", "unreachable"]))).toBe("unsettled");
	expect(verdictOf(sampled(["no-verify", "unreachable"]))).toBe("unsettled");
});

test("a domain is only cleared of verify when every address sampled said so", () => {
	expect(verdictOf(sampled(["no-verify", "no-verify"]))).toBe("no-verify");
});

test("a verify that names no preimage outranks the broken ones beside it", () => {
	expect(verdictOf(sampled(["unreachable", "verify-without-preimage"]))).toBe(
		"verify-without-preimage",
	);
});

test("an address is read off a profile, and junk is passed over rather than guessed at", () => {
	expect(lud16Of(JSON.stringify({ lud16: "Someone@Example.COM" }))).toBe("someone@example.com");
	expect(lud16Of(JSON.stringify({ lud16: "  someone@example.com  " }))).toBe("someone@example.com");
	expect(lud16Of(JSON.stringify({ lud16: "not-an-address" }))).toBe(null);
	expect(lud16Of(JSON.stringify({ lud16: 21 }))).toBe(null);
	expect(lud16Of(JSON.stringify({ name: "no address at all" }))).toBe(null);
	expect(lud16Of("not json")).toBe(null);
});

test("support belongs to the domain, so addresses group under it", () => {
	const grouped = byDomain(["a@one.example", "b@one.example", "c@two.example"]);
	expect(grouped.get("one.example")).toEqual(["a@one.example", "b@one.example"]);
	expect(grouped.get("two.example")).toEqual(["c@two.example"]);
});

const WELL_KNOWN = "https://wallet.example/.well-known/lnurlp/someone";
const CALLBACK = "https://wallet.example/callback";
const VERIFY = "https://wallet.example/verify/abc";

function answering(routes: Record<string, unknown>): Send {
	return async (url) => {
		const body = routes[url];
		return body === undefined ? new Response("no route", { status: 404 }) : Response.json(body);
	};
}

function servedBy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		[WELL_KNOWN]: {
			tag: "payRequest",
			callback: CALLBACK,
			minSendable: 1_000,
			maxSendable: 100_000_000,
		},
		[`${CALLBACK}?amount=1000`]: { pr: "lnbc1", verify: VERIFY },
		[VERIFY]: { status: "OK", settled: false, preimage: null },
		...overrides,
	};
}

test("a wallet answering settled and preimage is usable", async () => {
	const send = answering(servedBy());
	const measured = await measure(send, "someone@wallet.example");
	expect(measured.verdict).toBe("usable");
});

test("a verify answering without a preimage key is what the denylist is for", async () => {
	const send = answering(servedBy({ [VERIFY]: { status: "OK", settled: false, pr: "lnbc1" } }));
	const measured = await measure(send, "someone@wallet.example");
	expect(measured.verdict).toBe("verify-without-preimage");
	expect(measured.note).toContain("pr");
});

test("a settled that is not a boolean proves nothing either", async () => {
	const send = answering(
		servedBy({ [VERIFY]: { status: "OK", settled: "false", preimage: null } }),
	);
	expect((await measure(send, "someone@wallet.example")).verdict).toBe("verify-without-preimage");
});

test("an invoice carrying no verify URL is the wallet this service cannot serve", async () => {
	const send = answering(servedBy({ [`${CALLBACK}?amount=1000`]: { pr: "lnbc1" } }));
	expect((await measure(send, "someone@wallet.example")).verdict).toBe("no-verify");
});

test("a broken account reads as unreachable rather than as a wallet without verify", async () => {
	const send = answering(servedBy({ [`${CALLBACK}?amount=1000`]: undefined }));
	expect((await measure(send, "someone@wallet.example")).verdict).toBe("unreachable");

	expect((await measure(answering({}), "someone@wallet.example")).verdict).toBe("unreachable");
});

test("an amount no wallet on the domain would take is its own answer", async () => {
	const send = answering(
		servedBy({
			[WELL_KNOWN]: {
				tag: "payRequest",
				callback: CALLBACK,
				minSendable: 1_000,
				maxSendable: 500,
			},
		}),
	);
	const measured = await measure(send, "someone@wallet.example");
	expect(measured.verdict).toBe("amount-refused");
	expect(measured.note).toContain("500");
});

test("a callback that already carries a query keeps it", async () => {
	const withQuery = "https://wallet.example/callback?id=7";
	const send = answering({
		[WELL_KNOWN]: {
			tag: "payRequest",
			callback: withQuery,
			minSendable: 1_000,
			maxSendable: 100_000_000,
		},
		[`${withQuery}&amount=1000`]: { pr: "lnbc1", verify: VERIFY },
		[VERIFY]: { status: "OK", settled: false, preimage: null },
	});
	expect((await measure(send, "someone@wallet.example")).verdict).toBe("usable");
});
