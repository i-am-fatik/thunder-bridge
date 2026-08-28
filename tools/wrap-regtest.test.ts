import { beforeAll, describe, expect, it } from "vitest";
import {
	decodeInvoice,
	preimageMatchesHash,
	proveWrapped,
	WrapRefusedError,
	wrapFeeCeiling,
} from "../sdk/dist/index.js";
import {
	DUE_MSAT,
	ensureWrapCanFlow,
	LISTED_FEE_MSAT,
	nodesUp,
	payeeStatusOf,
	payInBackground,
	RECIPIENT_EXPIRY,
	recipientInvoice,
	untilHeld,
	WRAP_EXPIRY,
	wrapOn,
	wrapper,
} from "./regtest-nodes.ts";

describe.skipIf(!nodesUp())("what the SDK reads off invoices real nodes minted", () => {
	it("decodes a Core Lightning invoice the way the gateway needs it", () => {
		const recipient = recipientInvoice();
		const read = decodeInvoice(recipient.bolt11);

		expect(read.paymentHash).toBe(recipient.paymentHash);
		expect(read.amountMsat).toBe(DUE_MSAT);
		expect(read.expiresAt).not.toBeNull();
	});

	it("decodes an LND hold invoice minted on a hash that LND does not own", () => {
		const recipient = recipientInvoice();
		const read = decodeInvoice(wrapOn(recipient.paymentHash, DUE_MSAT + LISTED_FEE_MSAT));

		expect(read.paymentHash).toBe(recipient.paymentHash);
		expect(read.amountMsat).toBe(DUE_MSAT + LISTED_FEE_MSAT);
	});

	it("proves a real wrap against the real invoice it wraps", () => {
		const recipient = recipientInvoice();
		const wrapped = wrapOn(recipient.paymentHash, DUE_MSAT + LISTED_FEE_MSAT);

		expect(() => proveWrapped(wrapped, recipient.bolt11)).not.toThrow();
		expect(LISTED_FEE_MSAT).toBeLessThan(wrapFeeCeiling(DUE_MSAT));
	});

	it("refuses a real wrap minted on somebody else's hash", () => {
		const recipient = recipientInvoice();
		const elsewhere = recipientInvoice();
		const wrapped = wrapOn(elsewhere.paymentHash, DUE_MSAT + LISTED_FEE_MSAT);

		expect(() => proveWrapped(wrapped, recipient.bolt11)).toThrow(WrapRefusedError);
	});

	it("refuses a real wrap charging over the client's allowance", () => {
		const recipient = recipientInvoice();
		const greedy = wrapOn(recipient.paymentHash, DUE_MSAT + wrapFeeCeiling(DUE_MSAT) + 1000);

		expect(() => proveWrapped(greedy, recipient.bolt11)).toThrow(WrapRefusedError);
	});

	it("refuses a real wrap that outlives the invoice it has to forward to", () => {
		const recipient = recipientInvoice(DUE_MSAT, WRAP_EXPIRY);
		const outliving = wrapOn(recipient.paymentHash, DUE_MSAT + LISTED_FEE_MSAT, RECIPIENT_EXPIRY);

		expect(() => proveWrapped(outliving, recipient.bolt11)).toThrow(WrapRefusedError);
	});

	it("refuses a wrap that cannot cover what the recipient asked for", () => {
		const recipient = recipientInvoice();
		const short = wrapOn(recipient.paymentHash, DUE_MSAT - 1000);

		expect(() => proveWrapped(short, recipient.bolt11)).toThrow(WrapRefusedError);
	});

	it("refuses to mint a second wrap on a hash this node already carries", () => {
		const recipient = recipientInvoice();
		wrapOn(recipient.paymentHash, DUE_MSAT + LISTED_FEE_MSAT);

		expect(() => wrapOn(recipient.paymentHash, DUE_MSAT + LISTED_FEE_MSAT)).toThrow(
			/already exists/,
		);
	});
});

describe.skipIf(!nodesUp())("the loop the operator actually runs", () => {
	beforeAll(() => {
		ensureWrapCanFlow();
	});

	it("settles both legs on one preimage, and the SDK proves that preimage", async () => {
		const recipient = recipientInvoice();
		const wrapped = wrapOn(recipient.paymentHash, DUE_MSAT + LISTED_FEE_MSAT);

		expect(() => proveWrapped(wrapped, recipient.bolt11)).not.toThrow();

		const paid = payInBackground(wrapped);
		await untilHeld(recipient.paymentHash);

		const forward = wrapper("payinvoice", "--force", "--json", recipient.bolt11);
		const preimage = String(forward.payment_preimage);

		expect(forward.status).toBe("SUCCEEDED");
		expect(preimageMatchesHash(preimage, recipient.paymentHash)).toBe(true);

		wrapper("settleinvoice", preimage);
		await paid;

		expect(wrapper("lookupinvoice", recipient.paymentHash).state).toBe("SETTLED");
		expect(payeeStatusOf(recipient.paymentHash)).toBe("paid");
	}, 90_000);
});
