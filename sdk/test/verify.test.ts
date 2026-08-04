import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayCheatCode } from "../src/errors";
import { GatewayCheatError, UnverifiedRecipientError } from "../src/errors";
import type { CreatePaymentParams, Payment } from "../src/types";
import { preimageMatchesHash } from "../../core/bolt11.js";
import { isProvablyPaid, proveOrigin, proveSettlement } from "../src/verify";
import { bolt11 } from "./encode";

const ADDRESS = "fatik@agora.gripe";
const WELL_KNOWN = "https://agora.gripe/.well-known/lnurlp/fatik";
const CALLBACK = "https://agora.gripe/lnurlp/fatik/callback";
const VERIFY_URL = "https://agora.gripe/lnurlp/fatik/verify/7f3a";
const AMOUNT_MSAT = 21_000_000;
const METADATA = JSON.stringify([["text/plain", "a coffee for fatik"]]);
const METADATA_OF_ANOTHER_USER = JSON.stringify([["text/plain", "a coffee for the gateway"]]);
const PREIMAGE = "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100";

function sha256OfText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256OfHex(hex: string): string {
  return createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
}

const PAYMENT_HASH = sha256OfHex(PREIMAGE);
const HONEST_INVOICE = bolt11({
  paymentHash: PAYMENT_HASH,
  amountMsat: AMOUNT_MSAT,
  descriptionHash: sha256OfText(METADATA),
});

function asked(lnAddresses: string[], amountMsat = AMOUNT_MSAT): CreatePaymentParams {
  return { lnAddresses, amountMsat };
}

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: "pay_7f3a2c",
    lnAddress: ADDRESS,
    amountMsat: AMOUNT_MSAT,
    status: "pending",
    paymentHash: PAYMENT_HASH,
    bolt11: HONEST_INVOICE,
    preimage: null,
    expiresAt: 1_800_000_600,
    createdAt: 1_800_000_000,
    verifyUrl: VERIFY_URL,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function payRequestOf(overrides: Record<string, unknown> = {}): unknown {
  return {
    tag: "payRequest",
    callback: CALLBACK,
    metadata: METADATA,
    minSendable: 1_000,
    maxSendable: 100_000_000,
    ...overrides,
  };
}

function verificationOf(overrides: Record<string, unknown> = {}): unknown {
  return { status: "OK", settled: false, preimage: null, pr: HONEST_INVOICE, ...overrides };
}

type Route = () => Response | Promise<Response>;

function stubNetwork(routes: Record<string, Route> = {}) {
  const calls = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const route = routes[url];
    if (route === undefined) throw new TypeError(`fetch failed: nothing answers at ${url}`);
    return route();
  });
  vi.stubGlobal("fetch", calls);
  return calls;
}

function stubHonestRecipient(overrides: Record<string, Route> = {}) {
  return stubNetwork({
    [WELL_KNOWN]: () => jsonResponse(payRequestOf()),
    [VERIFY_URL]: () => jsonResponse(verificationOf()),
    ...overrides,
  });
}

async function rejectionFrom(attempt: Promise<unknown>): Promise<unknown> {
  return attempt.then(
    () => {
      throw new Error("expected the proof to fail, but it passed");
    },
    (error: unknown) => error,
  );
}

async function cheatCodeFrom(attempt: Promise<unknown>): Promise<GatewayCheatCode> {
  const error = await rejectionFrom(attempt);
  expect(error).toBeInstanceOf(GatewayCheatError);
  return (error as GatewayCheatError).code;
}

async function unverifiedFrom(attempt: Promise<unknown>): Promise<UnverifiedRecipientError> {
  const error = await rejectionFrom(attempt);
  expect(error).toBeInstanceOf(UnverifiedRecipientError);
  expect(error).not.toBeInstanceOf(GatewayCheatError);
  return error as UnverifiedRecipientError;
}

afterEach(() => vi.unstubAllGlobals());

describe("proveOrigin", () => {
  it("passes an honest payment and asks nobody but the recipient's own server", async () => {
    const calls = stubHonestRecipient();

    await expect(proveOrigin(payment(), asked([ADDRESS]))).resolves.toBeUndefined();

    expect(calls.mock.calls.map(([url]) => String(url))).toEqual([WELL_KNOWN, VERIFY_URL]);
  });

  it("asks about the account the caller named, not the one the gateway spelled back", async () => {
    const calls = stubHonestRecipient();
    const shouted = payment({ lnAddress: "FaTiK@Agora.Gripe" });

    await expect(proveOrigin(shouted, asked([ADDRESS]))).resolves.toBeUndefined();
    expect(calls.mock.calls.map(([url]) => String(url))).toEqual([WELL_KNOWN, VERIFY_URL]);
  });

  it("treats the domain as case-insensitive because host names are", async () => {
    const calls = stubHonestRecipient();

    await expect(proveOrigin(payment(), asked(["fatik@Agora.Gripe"]))).resolves.toBeUndefined();
    expect(calls.mock.calls.map(([url]) => String(url))).toEqual([WELL_KNOWN, VERIFY_URL]);
  });

  it("passes when the address the gateway chose is not the first one the caller listed", async () => {
    stubHonestRecipient();

    await expect(
      proveOrigin(payment(), asked(["preferred@example.com", ADDRESS])),
    ).resolves.toBeUndefined();
  });

  it("reports address_not_requested when the gateway paid an address the caller never listed", async () => {
    const calls = stubHonestRecipient();

    const code = await cheatCodeFrom(proveOrigin(payment(), asked(["someone-else@agora.gripe"])));

    expect(code).toBe("address_not_requested");
    expect(calls).not.toHaveBeenCalled();
  });

  it("reports hash_mismatch when the invoice does not carry the payment hash the API claims", async () => {
    const calls = stubHonestRecipient();
    const foreign = payment({ paymentHash: sha256OfHex("00".repeat(32)) });

    expect(await cheatCodeFrom(proveOrigin(foreign, asked([ADDRESS])))).toBe("hash_mismatch");
    expect(calls).not.toHaveBeenCalled();
  });

  it("reports hash_mismatch rather than crashing when the bolt11 cannot be decoded at all", async () => {
    stubHonestRecipient();
    const garbled = payment({ bolt11: "this is not an invoice" });

    expect(await cheatCodeFrom(proveOrigin(garbled, asked([ADDRESS])))).toBe("hash_mismatch");
  });

  it("reports hash_mismatch when the bolt11 field holds a BOLT12 offer instead", async () => {
    stubHonestRecipient();
    const offer = payment({ bolt11: `lno1${"qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(4)}` });

    expect(await cheatCodeFrom(proveOrigin(offer, asked([ADDRESS])))).toBe("hash_mismatch");
  });

  it("reports amount_mismatch when the invoice is not for the amount the API claims", async () => {
    const calls = stubHonestRecipient();
    const inflated = payment({ amountMsat: AMOUNT_MSAT + 100_000 });

    expect(await cheatCodeFrom(proveOrigin(inflated, asked([ADDRESS])))).toBe("amount_mismatch");
    expect(calls).not.toHaveBeenCalled();
  });

  it("reports description_hash_mismatch when the invoice is pinned to another user's metadata", async () => {
    stubHonestRecipient();
    const substituted = payment({
      bolt11: bolt11({
        paymentHash: PAYMENT_HASH,
        amountMsat: AMOUNT_MSAT,
        descriptionHash: sha256OfText(METADATA_OF_ANOTHER_USER),
      }),
    });

    expect(await cheatCodeFrom(proveOrigin(substituted, asked([ADDRESS])))).toBe(
      "description_hash_mismatch",
    );
  });

  it("reports description_hash_mismatch when the invoice carries a plain description and no hash", async () => {
    stubHonestRecipient();
    const unpinned = payment({
      bolt11: bolt11({
        paymentHash: PAYMENT_HASH,
        amountMsat: AMOUNT_MSAT,
        description: "a coffee for fatik",
      }),
    });

    expect(await cheatCodeFrom(proveOrigin(unpinned, asked([ADDRESS])))).toBe(
      "description_hash_mismatch",
    );
  });

  it("reports verify_url_foreign when the verify URL does not share an origin with the callback", async () => {
    const calls = stubHonestRecipient();
    const gatewayHosted = payment({ verifyUrl: "https://gateway.example/lnurlp/verify/7f3a" });

    expect(await cheatCodeFrom(proveOrigin(gatewayHosted, asked([ADDRESS])))).toBe(
      "verify_url_foreign",
    );
    expect(calls.mock.calls.map(([url]) => String(url))).toEqual([WELL_KNOWN]);
  });

  it("reports verify_url_foreign when the verify URL is not a URL at all", async () => {
    stubHonestRecipient();
    const nonsense = payment({ verifyUrl: "" });

    expect(await cheatCodeFrom(proveOrigin(nonsense, asked([ADDRESS])))).toBe("verify_url_foreign");
  });

  it("reports invoice_not_issued when the verify endpoint echoes a different invoice", async () => {
    stubHonestRecipient({
      [VERIFY_URL]: () =>
        jsonResponse(
          verificationOf({
            pr: bolt11({ paymentHash: sha256OfHex("11".repeat(32)), amountMsat: AMOUNT_MSAT }),
          }),
        ),
    });

    expect(await cheatCodeFrom(proveOrigin(payment(), asked([ADDRESS])))).toBe(
      "invoice_not_issued",
    );
  });

  it("reports invoice_not_issued when the verify endpoint echoes no invoice at all", async () => {
    stubHonestRecipient({
      [VERIFY_URL]: () => jsonResponse({ status: "ERROR", reason: "unknown payment" }),
    });

    expect(await cheatCodeFrom(proveOrigin(payment(), asked([ADDRESS])))).toBe(
      "invoice_not_issued",
    );
  });

  it("accepts a verify echo that differs from the invoice only in letter case", async () => {
    stubHonestRecipient({
      [VERIFY_URL]: () => jsonResponse(verificationOf({ pr: HONEST_INVOICE.toUpperCase() })),
    });

    await expect(proveOrigin(payment(), asked([ADDRESS]))).resolves.toBeUndefined();
  });

  it("stays unverified rather than accusing when the well-known endpoint is unreachable", async () => {
    stubNetwork();

    const error = await unverifiedFrom(proveOrigin(payment(), asked([ADDRESS])));

    expect(error.lnAddress).toBe(ADDRESS);
    expect(error.paymentId).toBe("pay_7f3a2c");
  });

  it("stays unverified rather than accusing when the well-known endpoint answers non-2xx", async () => {
    const calls = stubHonestRecipient({
      [WELL_KNOWN]: () => jsonResponse({ status: "ERROR" }, 503),
    });

    await unverifiedFrom(proveOrigin(payment(), asked([ADDRESS])));

    expect(calls.mock.calls.map(([url]) => String(url))).toEqual([WELL_KNOWN]);
  });

  it("stays unverified rather than accusing when the verify URL is unreachable", async () => {
    stubNetwork({ [WELL_KNOWN]: () => jsonResponse(payRequestOf()) });

    await unverifiedFrom(proveOrigin(payment(), asked([ADDRESS])));
  });

  it("stays unverified when the well-known endpoint answers 200 but serves no metadata", async () => {
    const calls = stubHonestRecipient({
      [WELL_KNOWN]: () => jsonResponse(payRequestOf({ metadata: undefined })),
    });

    await unverifiedFrom(proveOrigin(payment(), asked([ADDRESS])));

    expect(calls.mock.calls.map(([url]) => String(url))).toEqual([WELL_KNOWN]);
  });

  it("stays unverified when the well-known endpoint answers 200 but serves no callback", async () => {
    stubHonestRecipient({
      [WELL_KNOWN]: () => jsonResponse(payRequestOf({ callback: undefined })),
    });

    await unverifiedFrom(proveOrigin(payment(), asked([ADDRESS])));
  });

  it("stays unverified when the chosen address carries no domain to ask", async () => {
    const calls = stubHonestRecipient();
    const domainless = payment({ lnAddress: "fatik" });

    await unverifiedFrom(proveOrigin(domainless, asked(["fatik"])));

    expect(calls).not.toHaveBeenCalled();
  });
});

describe("the SSRF guard", () => {
  it.each([
    "fatik@localhost",
    "fatik@127.0.0.1",
    "fatik@192.168.1.10",
    "fatik@10.0.0.7",
    "fatik@172.16.0.3",
    "fatik@wallet.localhost",
  ])("never fetches anything to check an invoice from %s", async (lnAddress) => {
    const calls = stubHonestRecipient();

    const error = await unverifiedFrom(proveOrigin(payment({ lnAddress }), asked([lnAddress])));

    expect(error.lnAddress).toBe(lnAddress);
    expect(calls).not.toHaveBeenCalled();
  });

  it("never fetches a verify URL on a private host even when the callback vouches for it", async () => {
    const privateVerifyUrl = "https://10.10.0.5/lnurlp/fatik/verify/7f3a";
    const calls = stubHonestRecipient({
      [WELL_KNOWN]: () =>
        jsonResponse(payRequestOf({ callback: "https://10.10.0.5/lnurlp/fatik/callback" })),
    });

    await unverifiedFrom(proveOrigin(payment({ verifyUrl: privateVerifyUrl }), asked([ADDRESS])));

    expect(calls.mock.calls.map(([url]) => String(url))).toEqual([WELL_KNOWN]);
  });
});

describe("isProvablyPaid", () => {
  it("is true for a paid payment whose preimage hashes to the payment hash", () => {
    expect(isProvablyPaid(payment({ status: "paid", preimage: PREIMAGE }))).toBe(true);
  });

  it("is false for a paid payment whose preimage hashes to something else", () => {
    expect(isProvablyPaid(payment({ status: "paid", preimage: "00".repeat(32) }))).toBe(false);
  });

  it("is false for a paid payment that reports no preimage", () => {
    expect(isProvablyPaid(payment({ status: "paid", preimage: null }))).toBe(false);
  });

  it("is false for a pending payment even when a matching preimage is somehow present", () => {
    expect(isProvablyPaid(payment({ status: "pending", preimage: PREIMAGE }))).toBe(false);
  });

  it("is false for an expired payment even when a matching preimage is somehow present", () => {
    expect(isProvablyPaid(payment({ status: "expired", preimage: PREIMAGE }))).toBe(false);
  });

  it("is false for a paid payment whose preimage is not hexadecimal", () => {
    expect(isProvablyPaid(payment({ status: "paid", preimage: "zz".repeat(32) }))).toBe(false);
  });

  it("is false for a paid payment whose preimage has an odd number of hex digits", () => {
    expect(isProvablyPaid(payment({ status: "paid", preimage: PREIMAGE.slice(1) }))).toBe(false);
  });

  it("is false for a paid payment whose preimage is empty", () => {
    expect(isProvablyPaid(payment({ status: "paid", preimage: "" }))).toBe(false);
  });
});

describe("preimageMatchesHash", () => {
  it("is true for the secret behind the payment hash", () => {
    expect(preimageMatchesHash(PREIMAGE, PAYMENT_HASH)).toBe(true);
  });

  it("is true when the payment hash is given in upper case", () => {
    expect(preimageMatchesHash(PREIMAGE, PAYMENT_HASH.toUpperCase())).toBe(true);
  });

  it("is true when the preimage is given in upper case", () => {
    expect(preimageMatchesHash(PREIMAGE.toUpperCase(), PAYMENT_HASH)).toBe(true);
  });

  it("is false for a preimage that hashes to a different payment hash", () => {
    expect(preimageMatchesHash("00".repeat(32), PAYMENT_HASH)).toBe(false);
  });

  it("is false for an empty preimage", () => {
    expect(preimageMatchesHash("", PAYMENT_HASH)).toBe(false);
  });

  it("is false for a preimage with an odd number of hex digits", () => {
    expect(preimageMatchesHash(PREIMAGE.slice(1), PAYMENT_HASH)).toBe(false);
  });

  it("is false for a preimage that is not hexadecimal", () => {
    expect(preimageMatchesHash("not hex at all", PAYMENT_HASH)).toBe(false);
  });

  it("is false when the payment hash is empty", () => {
    expect(preimageMatchesHash(PREIMAGE, "")).toBe(false);
  });
});

describe("the amount the caller asked for", () => {
  it("is checked against the request and not only against the gateway's own echo", async () => {
    const calls = stubHonestRecipient();
    const inflated = 100 * AMOUNT_MSAT;
    const overcharged = payment({
      amountMsat: inflated,
      bolt11: bolt11({
        paymentHash: PAYMENT_HASH,
        amountMsat: inflated,
        descriptionHash: sha256OfText(METADATA),
      }),
    });

    expect(await cheatCodeFrom(proveOrigin(overcharged, asked([ADDRESS])))).toBe("amount_mismatch");
    expect(calls).not.toHaveBeenCalled();
  });

  it("refuses an amountless invoice a payer's wallet would let them fill in", async () => {
    const calls = stubHonestRecipient();
    const open = payment({
      bolt11: bolt11({ paymentHash: PAYMENT_HASH, descriptionHash: sha256OfText(METADATA) }),
    });

    expect(await cheatCodeFrom(proveOrigin(open, asked([ADDRESS])))).toBe("amount_mismatch");
    expect(calls).not.toHaveBeenCalled();
  });

  it("refuses a gateway that reports no amount at all", async () => {
    stubHonestRecipient();
    const silent = payment({ amountMsat: null as unknown as number });

    expect(await cheatCodeFrom(proveOrigin(silent, asked([ADDRESS])))).toBe("amount_mismatch");
  });
});

describe("proveSettlement", () => {
  it("returns the preimage the recipient's own server released", async () => {
    stubHonestRecipient({
      [VERIFY_URL]: () => jsonResponse(verificationOf({ settled: true, preimage: PREIMAGE })),
    });

    await expect(proveSettlement(payment(), asked([ADDRESS]))).resolves.toBe(PREIMAGE);
  });

  it("returns null while the recipient still says nothing has settled", async () => {
    stubHonestRecipient();

    await expect(proveSettlement(payment(), asked([ADDRESS]))).resolves.toBeNull();
  });

  it("reports preimage_mismatch when the released preimage does not open the invoice", async () => {
    stubHonestRecipient({
      [VERIFY_URL]: () =>
        jsonResponse(verificationOf({ settled: true, preimage: "00".repeat(32) })),
    });

    expect(await cheatCodeFrom(proveSettlement(payment(), asked([ADDRESS])))).toBe(
      "preimage_mismatch",
    );
  });

  it("will not read a settlement off a verify url the gateway pointed at itself", async () => {
    stubHonestRecipient();
    const elsewhere = payment({ verifyUrl: "https://gateway.example/verify/7f3a" });

    expect(await cheatCodeFrom(proveSettlement(elsewhere, asked([ADDRESS])))).toBe(
      "verify_url_foreign",
    );
  });
});

describe("a settlement the gateway invented for itself", () => {
  it("is not provable, because the hash it names is not the invoice's", () => {
    const invented = "22".repeat(32);
    const forged = payment({
      status: "paid",
      preimage: invented,
      paymentHash: sha256OfHex(invented),
    });

    expect(isProvablyPaid(forged)).toBe(false);
  });
});

describe("the host guard beyond the obvious literals", () => {
  it.each(["fatik@localhost.", "fatik@nas", "fatik@wallet.lan", "fatik@host.internal"])(
    "never fetches anything to check an invoice from %s",
    async (lnAddress) => {
      const calls = stubHonestRecipient();

      await unverifiedFrom(proveOrigin(payment({ lnAddress }), asked([lnAddress])));

      expect(calls).not.toHaveBeenCalled();
    },
  );
});

describe("a recipient answering with the wrong shape", () => {
  it("reports invoice_not_issued rather than crashing when pr is not a string", async () => {
    stubHonestRecipient({ [VERIFY_URL]: () => jsonResponse(verificationOf({ pr: 42 })) });

    expect(await cheatCodeFrom(proveOrigin(payment(), asked([ADDRESS])))).toBe(
      "invoice_not_issued",
    );
  });

  it("stays unverified rather than crashing when the well-known answers JSON null", async () => {
    stubHonestRecipient({ [WELL_KNOWN]: () => jsonResponse(null) });

    await unverifiedFrom(proveOrigin(payment(), asked([ADDRESS])));
  });
});
