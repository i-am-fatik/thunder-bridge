import { describe, expect, it } from "vitest";
import { decodeInvoice } from "../../core/bolt11.js";
import { bolt11 } from "./encode";

const PAYMENT_HASH = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const DESCRIPTION_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const AMOUNT_MSAT = 21_000_000;
const EXPIRES_AT = 3600;

const NOTHING_DECODED = {
  paymentHash: null,
  descriptionHash: null,
  amountMsat: null,
  expiresAt: null,
};

describe("decodeInvoice", () => {
  it("round-trips the payment hash, description hash and amount the invoice was built with", () => {
    const invoice = bolt11({
      paymentHash: PAYMENT_HASH,
      descriptionHash: DESCRIPTION_HASH,
      amountMsat: AMOUNT_MSAT,
    });
    expect(decodeInvoice(invoice)).toEqual({
      paymentHash: PAYMENT_HASH,
      descriptionHash: DESCRIPTION_HASH,
      amountMsat: AMOUNT_MSAT,
      expiresAt: EXPIRES_AT,
    });
  });

  it("reports amountMsat null for an amountless invoice while still reading its hashes", () => {
    const invoice = bolt11({ paymentHash: PAYMENT_HASH, descriptionHash: DESCRIPTION_HASH });
    expect(decodeInvoice(invoice)).toEqual({
      paymentHash: PAYMENT_HASH,
      descriptionHash: DESCRIPTION_HASH,
      amountMsat: null,
      expiresAt: EXPIRES_AT,
    });
  });

  it("reports descriptionHash null for an invoice carrying a plain d description and no h tag", () => {
    const invoice = bolt11({
      paymentHash: PAYMENT_HASH,
      description: "coffee for the maintainer",
      amountMsat: AMOUNT_MSAT,
    });
    expect(decodeInvoice(invoice)).toEqual({
      paymentHash: PAYMENT_HASH,
      descriptionHash: null,
      amountMsat: AMOUNT_MSAT,
      expiresAt: EXPIRES_AT,
    });
  });

  it("yields an all-null invoice for garbage instead of throwing", () => {
    expect(decodeInvoice("this is not an invoice")).toEqual(NOTHING_DECODED);
  });

  it("yields an all-null invoice for an empty string instead of throwing", () => {
    expect(decodeInvoice("")).toEqual(NOTHING_DECODED);
  });

  it("yields an all-null invoice for a BOLT12 offer instead of trying to read it as BOLT11", () => {
    const offer =
      "lno1pg257enxv4ezqcneype82um50ynhxgrwdajx283qfwdpl28qqmc78ymlvhmxcsywdk5wrjnj36jryg";
    expect(decodeInvoice(offer)).toEqual(NOTHING_DECODED);
  });

  it("yields an all-null invoice for a bech32 string holding a character outside the charset", () => {
    const invoice = bolt11({ paymentHash: PAYMENT_HASH, amountMsat: AMOUNT_MSAT });
    expect(decodeInvoice(invoice.replace("q", "b"))).toEqual(NOTHING_DECODED);
  });

  it("decodes a testnet lntb invoice the same way it decodes mainnet", () => {
    const invoice = bolt11({
      paymentHash: PAYMENT_HASH,
      descriptionHash: DESCRIPTION_HASH,
      amountMsat: AMOUNT_MSAT,
      network: "tb",
    });
    expect(invoice.startsWith("lntb")).toBe(true);
    expect(decodeInvoice(invoice)).toEqual({
      paymentHash: PAYMENT_HASH,
      descriptionHash: DESCRIPTION_HASH,
      amountMsat: AMOUNT_MSAT,
      expiresAt: EXPIRES_AT,
    });
  });

  it("decodes an uppercased invoice to exactly what the lowercase one decodes to", () => {
    const invoice = bolt11({
      paymentHash: PAYMENT_HASH,
      descriptionHash: DESCRIPTION_HASH,
      amountMsat: AMOUNT_MSAT,
    });
    expect(decodeInvoice(invoice.toUpperCase())).toEqual(decodeInvoice(invoice));
  });

  it("stops at a tagged field whose length runs past the signature rather than looping or throwing", () => {
    const invoice = bolt11({
      paymentHash: PAYMENT_HASH,
      descriptionHash: DESCRIPTION_HASH,
      amountMsat: AMOUNT_MSAT,
    });
    expect(decodeInvoice(invoice.slice(0, -1))).toEqual({
      paymentHash: PAYMENT_HASH,
      descriptionHash: null,
      amountMsat: AMOUNT_MSAT,
      expiresAt: EXPIRES_AT,
    });
    expect(decodeInvoice(invoice.slice(0, invoice.length >> 1))).toEqual({
      paymentHash: null,
      descriptionHash: null,
      amountMsat: AMOUNT_MSAT,
      expiresAt: null,
    });
  });
});
