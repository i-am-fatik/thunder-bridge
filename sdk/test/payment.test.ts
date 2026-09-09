import { describe, expect, it } from "vitest";
import type { Payment } from "../src/types";
import { mintedFromWire, paymentFromWire } from "../src/wire";

const HASH = "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925";
const INVOICE = "lnbc210n1pjfillerinvoice";

function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pay_0001",
    status: "pending",
    payment_hash: HASH,
    verify_url: "https://example.com/lnurl/verify/1a2b",
    preimage: null,
    expires_at: new Date(1_900_000_600 * 1000).toISOString(),
    created_at: new Date(1_900_000_000 * 1000).toISOString(),
    ...overrides,
  };
}

function minted(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return wire({
    ln_address: "alice@example.com",
    incoming_amount: { value: "21000", asset_code: "BTC", asset_scale: 11 },
    bolt11: INVOICE,
    ...overrides,
  });
}

describe("the shape a payment comes back as", () => {
  it("reads a minted payment with the address, the amount and the invoice all present", () => {
    const payment = paymentFromWire(minted());

    expect(payment).toMatchObject({ kind: "minted", lnAddress: "alice@example.com" });
  });

  it("reads a handed-over payment as carrying none of the three", () => {
    const payment = paymentFromWire(wire());

    expect(payment).toMatchObject({ kind: "watched", lnAddress: null, bolt11: null });
  });

  it("refuses a record carrying some of the three, which no gateway writes", () => {
    expect(paymentFromWire(wire({ ln_address: "alice@example.com" }))).toBeNull();
    expect(paymentFromWire(minted({ bolt11: undefined }))).toBeNull();
    expect(paymentFromWire(minted({ incoming_amount: undefined }))).toBeNull();
  });

  it("refuses a minted record whose amount is not an amount, rather than reading it as watched", () => {
    expect(paymentFromWire(minted({ incoming_amount: { value: "-1" } }))).toBeNull();
  });

  it("keeps only what was minted when a mint is what was asked for", () => {
    expect(mintedFromWire(minted())).toMatchObject({ kind: "minted" });
    expect(mintedFromWire(wire())).toBeNull();
  });
});

describe("what the type lets a caller write", () => {
  it("narrows the three fields on kind alone, with no assertion anywhere", () => {
    const payment = paymentFromWire(minted()) as Payment;
    const shown: string[] = [];

    if (payment.kind === "minted") {
      shown.push(payment.bolt11, payment.lnAddress, String(payment.amountMsat));
    }

    expect(shown).toHaveLength(3);
  });

  it("refuses to read an invoice off a watched payment", () => {
    const payment = paymentFromWire(wire()) as Payment;

    if (payment.kind === "watched") {
      // @ts-expect-error a watched payment carries no invoice to slice
      const nothing: string = payment.bolt11;

      expect(nothing).toBeNull();
    }
  });
});
