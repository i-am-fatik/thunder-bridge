import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { preimageMatchesHash } from "../../core/bolt11.js";
import { proveWrapped, wrapFeeCeiling } from "../src/verify";
import { bolt11 } from "./encode";

const PREIMAGE = "5c".repeat(32);
const HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");
const OTHER_HASH = createHash("sha256").update("elsewhere").digest("hex");
const DUE_MSAT = 21_000_000;
const OPERATOR_PRICE = DUE_MSAT * 0.0075;
const RECIPIENT_EXPIRY = 3600;
const WRAP_EXPIRY = 600;

function invoice(amountMsat: number, expirySecs: number, paymentHash = HASH): string {
  return bolt11({ paymentHash, amountMsat, expirySecs, description: "wrapped probe" });
}

const RECIPIENT = invoice(DUE_MSAT, RECIPIENT_EXPIRY);

describe("what the operator may charge", () => {
  it("allows one percent by default, which is above what an operator lists", () => {
    expect(wrapFeeCeiling(DUE_MSAT)).toBe(210_000);
    expect(wrapFeeCeiling(DUE_MSAT)).toBeGreaterThan(OPERATOR_PRICE);
  });

  it("never drops below a satoshi, however small the payment", () => {
    expect(wrapFeeCeiling(1000)).toBe(1000);
    expect(wrapFeeCeiling(100)).toBe(1000);
  });

  it("takes the proportion once it clears the floor", () => {
    expect(wrapFeeCeiling(200_000)).toBe(2000);
    expect(wrapFeeCeiling(100_000)).toBe(1000);
  });

  it("lets a client set both", () => {
    expect(wrapFeeCeiling(DUE_MSAT, { proportion: 0.02 })).toBe(420_000);
    expect(wrapFeeCeiling(1000, { baseMsat: 5000 })).toBe(5000);
  });
});

describe("binding a wrapped invoice to the recipient's", () => {
  it("takes a wrap that shares the hash and stays inside the allowance", () => {
    const wrapped = invoice(DUE_MSAT + 210_000, WRAP_EXPIRY);

    expect(() => proveWrapped(wrapped, RECIPIENT)).not.toThrow();
  });

  it("takes an operator charging its list price, which sits under the allowance", () => {
    const listed = invoice(DUE_MSAT + OPERATOR_PRICE, WRAP_EXPIRY);

    expect(() => proveWrapped(listed, RECIPIENT)).not.toThrow();
  });

  it("takes a wrap that charges nothing at all", () => {
    expect(() => proveWrapped(invoice(DUE_MSAT, WRAP_EXPIRY), RECIPIENT)).not.toThrow();
  });

  it("refuses a wrap on another hash, which would settle without paying anyone", () => {
    const forged = invoice(DUE_MSAT + 1000, WRAP_EXPIRY, OTHER_HASH);

    expect(() => proveWrapped(forged, RECIPIENT)).toThrow(/hash_mismatch/);
  });

  it("refuses a wrap asking over the allowance", () => {
    const greedy = invoice(DUE_MSAT + 210_100, WRAP_EXPIRY);

    expect(() => proveWrapped(greedy, RECIPIENT)).toThrow(/fee_above_allowance/);
  });

  it("refuses a wrap that cannot cover what the recipient asked", () => {
    const short = invoice(DUE_MSAT - 100, WRAP_EXPIRY);

    expect(() => proveWrapped(short, RECIPIENT)).toThrow(/amount_below_recipient/);
  });

  it("refuses a wrap outliving the invoice it has to forward to", () => {
    const outliving = invoice(DUE_MSAT + 1000, RECIPIENT_EXPIRY + 60);

    expect(() => proveWrapped(outliving, RECIPIENT)).toThrow(/recipient_expires_first/);
  });

  it("refuses a wrap expiring at the same second, which leaves no room to deliver", () => {
    const tight = invoice(DUE_MSAT + 1000, RECIPIENT_EXPIRY);

    expect(() => proveWrapped(tight, RECIPIENT)).toThrow(/recipient_expires_first/);
  });

  it("refuses anything it cannot decode", () => {
    expect(() => proveWrapped("not an invoice", RECIPIENT)).toThrow(/undecodable/);
    expect(() => proveWrapped(invoice(DUE_MSAT, WRAP_EXPIRY), "nonsense")).toThrow(/undecodable/);
  });

  it("honours a client who allows more than the default", () => {
    const dearer = invoice(DUE_MSAT + 300_000, WRAP_EXPIRY);

    expect(() => proveWrapped(dearer, RECIPIENT)).toThrow(/fee_above_allowance/);
    expect(() => proveWrapped(dearer, RECIPIENT, { proportion: 0.02 })).not.toThrow();
  });

  it("honours a client who allows less than an operator charges", () => {
    const listed = invoice(DUE_MSAT + OPERATOR_PRICE, WRAP_EXPIRY);

    expect(() => proveWrapped(listed, RECIPIENT, { proportion: 0.005 })).toThrow(
      /fee_above_allowance/,
    );
  });
});

describe("proving the hold payment went through", () => {
  it("needs no new check, because one preimage settles both invoices", () => {
    const wrapped = invoice(DUE_MSAT + OPERATOR_PRICE, WRAP_EXPIRY);
    proveWrapped(wrapped, RECIPIENT);

    expect(preimageMatchesHash(PREIMAGE, HASH)).toBe(true);
  });
});
