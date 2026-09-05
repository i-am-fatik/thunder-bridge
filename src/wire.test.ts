import { expect, test } from "vitest";

import type { Payment } from "./payment.ts";
import { MalformedRequest } from "./problem.ts";
import { paymentToWire, readCreateRequest, readReplayAsk, readTicketRequest } from "./wire.ts";

function payment(): Payment {
	return {
		id: "irrelevant",
		lnAddress: "charter@coinos.io",
		amountMsat: 21_000,
		status: "pending",
		paymentHash: "aa".repeat(32),
		bolt11: "lnbc210n1",
		preimage: null,
		expiresAt: 1_800_000_000,
		createdAt: 1_700_000_000,
		verifyUrl: "https://coinos.io/api/lnurl/verify/1",
		trigger: null,
		replay: 0,
		sealed: null,
		caller: null,
		webhooks: [{ url: "https://example.com/hook" }],
	};
}

function asked(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ln_addresses: ["charter@coinos.io"],
		incoming_amount: { value: "21000", asset_code: "BTC", asset_scale: 11 },
		...over,
	};
}

function refusal(body: unknown): string {
	try {
		readCreateRequest(body);
	} catch (error: unknown) {
		if (error instanceof MalformedRequest) {
			return error.message;
		}
		throw error;
	}
	throw new Error("the request was accepted");
}

test("the webhook never reaches a client but the proof url must", () => {
	const json = JSON.stringify(paymentToWire(payment()));

	expect(json).not.toContain("hunter2");
	expect(json).not.toContain("example.com");
	expect(json).toContain("https://coinos.io/api/lnurl/verify/1");
	expect(json).toContain("charter@coinos.io");
});

test("every field leaves as snake_case, and the amount as a string with its scale", () => {
	const wire = paymentToWire(payment());

	expect(Object.keys(wire).every((field) => /^[a-z][a-z_0-9]*$/.test(field))).toBe(true);
	expect(wire.incoming_amount).toEqual({ value: "21000", asset_code: "BTC", asset_scale: 11 });
	expect(wire.expires_at).toBe("2027-01-15T08:00:00.000Z");
	expect(wire.created_at).toBe("2023-11-14T22:13:20.000Z");
});

test("a reader is told which of the two shapes it holds, rather than guessing from what is missing", () => {
	expect(paymentToWire(payment()).kind).toBe("minted");

	const watched = paymentToWire({ ...payment(), lnAddress: null, amountMsat: null, bolt11: null });
	expect(watched.kind).toBe("watched");
	expect(watched.ln_address).toBe(undefined);
	expect(watched.incoming_amount).toBe(undefined);
	expect(watched.bolt11).toBe(undefined);
});

test("an amount is read back to the millisatoshi it came from", () => {
	expect(readCreateRequest(asked()).amountMsat).toBe(21_000);
});

test("an amount in any other asset or scale is refused, never reinterpreted", () => {
	const dollars = { value: "21000", asset_code: "USD", asset_scale: 2 };
	const satoshi = { value: "21", asset_code: "BTC", asset_scale: 8 };

	expect(refusal(asked({ incoming_amount: dollars }))).toContain("BTC");
	expect(refusal(asked({ incoming_amount: satoshi }))).toContain("scale 11");
});

test("an amount that is a JSON number is refused, because that is the float this avoids", () => {
	const numeric = { value: 21_000, asset_code: "BTC", asset_scale: 11 };

	expect(refusal(asked({ incoming_amount: numeric }))).toContain("decimal string");
});

test("an amount past the safe integer range is refused rather than rounded", () => {
	const huge = { value: "9007199254740993", asset_code: "BTC", asset_scale: 11 };

	expect(refusal(asked({ incoming_amount: huge }))).toContain("positive count");
});

test("a webhook arrives nested, and a private url never does", () => {
	const nested = asked({ webhook: { url: "https://example.com/hook" } });
	expect(readCreateRequest(nested).webhook).toEqual({ url: "https://example.com/hook" });

	expect(readCreateRequest(asked()).webhook).toBeNull();
	expect(refusal(asked({ webhook: { url: "http://169.254.169.254/latest" } }))).toContain(
		"webhook.url",
	);
});

test("an empty or oversized address list is refused", () => {
	expect(refusal(asked({ ln_addresses: [] }))).toContain("non-empty");
	expect(refusal(asked({ ln_addresses: "charter@coinos.io" }))).toContain("non-empty");
	expect(refusal(asked({ ln_addresses: Array(17).fill("charter@coinos.io") }))).toContain("16");
});

test("every field that is kept has a length, so nothing unbounded is stored or signed", () => {
	const long = "a".repeat(400);
	expect(refusal(asked({ ln_addresses: [`${long}@coinos.io`] }))).toContain("320 characters");
});

test("a webhook secret is refused rather than ignored, so nobody thinks it is holding one", () => {
	expect(
		refusal(asked({ webhook: { url: "https://example.com/hook", secret: "hunter2" } })),
	).toContain("webhook.secret is gone");
});

test("a list may not stack one domain, because that is a fan-out at somebody's server", () => {
	const four = ["a@wallet.example", "b@wallet.example", "c@wallet.example", "d@wallet.example"];

	expect(refusal(asked({ ln_addresses: four }))).toContain("wallet.example more than 3 times");
	expect(refusal(asked({ ln_addresses: [...four.slice(0, 3), "e@WALLET.example"] }))).toContain(
		"more than 3 times",
	);
});

test("a priority list of different providers is what it was always for", () => {
	const providers = [
		"me@coinos.io",
		"me@blink.sv",
		"me@getalby.com",
		"a@wallet.example",
		"b@wallet.example",
		"c@wallet.example",
	];

	expect(readCreateRequest(asked({ ln_addresses: providers })).addresses).toEqual(providers);
});

test("replay is a whole number of settlements to keep, and only means something with a trigger", () => {
	const trigger = "ab".repeat(32);
	const asked = {
		ln_addresses: ["charter@coinos.io"],
		incoming_amount: { value: "21000", asset_code: "BTC", asset_scale: 11 },
	};

	expect(readCreateRequest({ ...asked, trigger, replay: 10 }).replay).toBe(10);
	expect(readCreateRequest({ ...asked, trigger }).replay).toBe(0);
	expect(() => readCreateRequest({ ...asked, trigger, replay: -1 })).toThrow(/whole number/);
	expect(() => readCreateRequest({ ...asked, trigger, replay: 1.5 })).toThrow(/whole number/);
	expect(() => readCreateRequest({ ...asked, trigger, replay: "10" })).toThrow(/whole number/);
	expect(() => readCreateRequest({ ...asked, replay: 10 })).toThrow(/needs a trigger/);
});

test("a ticket may ask how much to replay, within the ceiling a socket is ever handed", () => {
	expect(readTicketRequest({ trigger_secret: "s" })).toMatchObject({ replay: null });
	expect(readTicketRequest({ trigger_secret: "s", replay: 25 })).toMatchObject({ replay: 25 });
	expect(() => readTicketRequest({ trigger_secret: "s", replay: 501 })).toThrow(/0 to 500/);
	expect(() => readTicketRequest({ trigger_secret: "s", replay: -1 })).toThrow(/0 to 500/);
	expect(readReplayAsk("25")).toBe(25);
	expect(readReplayAsk(null)).toBeNull();
	expect(() => readReplayAsk("")).toThrow(/0 to 500/);
	expect(() => readReplayAsk("many")).toThrow(/0 to 500/);
});
