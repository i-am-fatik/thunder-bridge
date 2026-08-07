import { expect, test } from "vitest";

import type { Payment } from "./payment.ts";
import { MalformedRequest } from "./problem.ts";
import { readCreateRequest, paymentToWire } from "./wire.ts";

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
		sealed: null,
		webhooks: [{ url: "https://example.com/hook", secret: "hunter2" }],
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
		if (error instanceof MalformedRequest) return error.message;
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
	const nested = asked({ webhook: { url: "https://example.com/hook", secret: "hunter2" } });
	expect(readCreateRequest(nested).webhook).toEqual({
		url: "https://example.com/hook",
		secret: "hunter2",
	});

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
	expect(
		refusal(asked({ webhook: { url: "https://example.com/hook", secret: long } })),
	).toContain("256 characters");
});
