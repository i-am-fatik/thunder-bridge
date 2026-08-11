import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preimageMatchesHash } from "../../core/bolt11.js";
import { checkSettled } from "../../core/lnurl.js";
import { bankVerifyEndpoint, type Credit } from "../src/bank";
import { ThunderBridge } from "../src/client";
import { NoWalletAvailableError } from "../src/errors";
import {
  type BankRailConfig,
  type BlindLightningRailConfig,
  bankRail,
  blindLightningRail,
  type Leg,
  type LightningRailConfig,
  lightningRail,
  type Order,
  type Rail,
} from "../src/rail";
import { bolt11 } from "./encode";
import { jsonResponse, type Routes, stubFetch } from "./harness";

const GATEWAY = "https://gateway.example.net";
const LN_ADDRESS = "alice@example.com";
const PAY_REQUEST = "https://example.com/.well-known/lnurlp/alice";
const CALLBACK = "https://example.com/lnurl/pay/alice";
const VERIFY = "https://example.com/lnurl/verify/1a2b3c";
const METADATA = '[["text/plain","one coffee for alice"]]';
const AMOUNT_MSAT = 21_000_000;
const PAYMENT_HASH = "ab".repeat(32);
const SECRET = "keep-me-server-side";
const IBAN = "CZ6508000000192000145399";
const MOUNT = "https://shop.example.org/verify/bank";
const EXPIRES_AT = 1_900_000_000;

const INVOICE = bolt11({
  paymentHash: PAYMENT_HASH,
  amountMsat: AMOUNT_MSAT,
  descriptionHash: createHash("sha256").update(METADATA).digest("hex"),
});

const ORDER: Order = { reference: "ORDER-2026-77", amountMinor: 48_055, currency: "CZK" };

function railsServing(overrides: Routes = {}): Routes {
  return {
    [`${GATEWAY}/incoming-payments/is-this-gateway-yours`]: () => jsonResponse({}, 401),
    [`${GATEWAY}/watched-payments`]: () =>
      jsonResponse(
        {
          id: "watch_0001",
          status: "pending",
          payment_hash: PAYMENT_HASH,
          verify_url: VERIFY,
          preimage: null,
          expires_at: new Date(EXPIRES_AT * 1000).toISOString(),
          created_at: new Date(1_800_000_000 * 1000).toISOString(),
        },
        201,
      ),
    [`${GATEWAY}/incoming-payments`]: () =>
      jsonResponse(
        {
          id: "pay_0001",
          ln_address: LN_ADDRESS,
          incoming_amount: { value: String(AMOUNT_MSAT), asset_code: "BTC", asset_scale: 11 },
          status: "pending",
          bolt11: INVOICE,
          payment_hash: PAYMENT_HASH,
          verify_url: VERIFY,
          preimage: null,
          expires_at: new Date(1_900_000_600 * 1000).toISOString(),
          created_at: new Date(1_900_000_000 * 1000).toISOString(),
        },
        201,
      ),
    [PAY_REQUEST]: () =>
      jsonResponse({
        tag: "payRequest",
        callback: CALLBACK,
        metadata: METADATA,
        minSendable: 1_000,
        maxSendable: 100_000_000,
      }),
    [`${CALLBACK}?amount=${AMOUNT_MSAT}`]: () => jsonResponse({ pr: INVOICE, verify: VERIFY }),
    ...overrides,
  };
}

function bank(overrides: Partial<BankRailConfig> = {}): Rail {
  return bankRail({
    gateway: new ThunderBridge(GATEWAY, { token: "hunter2" }),
    secret: SECRET,
    iban: IBAN,
    verifyUrl: MOUNT,
    expiresAt: () => EXPIRES_AT,
    ...overrides,
  });
}

function lightning(overrides: Partial<LightningRailConfig> = {}): Rail {
  return lightningRail({
    gateway: new ThunderBridge(GATEWAY, { verify: false }),
    lnAddresses: [LN_ADDRESS],
    amountMsat: () => AMOUNT_MSAT,
    ...overrides,
  });
}

function blind(overrides: Partial<BlindLightningRailConfig> = {}): Rail {
  return blindLightningRail({
    gateway: new ThunderBridge(GATEWAY, { verify: false, token: "hunter2" }),
    lnAddresses: [LN_ADDRESS],
    amountMsat: () => AMOUNT_MSAT,
    ...overrides,
  });
}

function bodyOf(url: string, calls: { url: string; init: RequestInit | undefined }[]) {
  const call = calls.find((made) => made.url === url);

  return JSON.parse(String(call?.init?.body ?? "{}")) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("every rail answers the same question", () => {
  it("hands back the same five fields whichever rail built the leg", async () => {
    stubFetch(railsServing());
    const rails: Rail[] = [bank(), lightning(), blind()];

    const legs: Leg[] = [];
    for (const rail of rails) legs.push(await rail(ORDER));

    for (const leg of legs) {
      expect(Object.keys(leg).sort()).toEqual(["expiresAt", "id", "qr", "rail", "scan"]);
      expect(typeof leg.id).toBe("string");
      expect(leg.scan.length).toBeGreaterThan(0);
      expect(leg.qr.length).toBeGreaterThan(0);
    }
  });

  it("names its own rail, so a shop labels a leg without knowing how it was built", async () => {
    stubFetch(railsServing());

    expect((await bank()(ORDER)).rail).toBe("bank");
    expect((await lightning()(ORDER)).rail).toBe("lightning");
    expect((await bank({ name: "fio" })(ORDER)).rail).toBe("fio");
  });

  it("survives a round trip through JSON, because nothing on a leg is a function", async () => {
    stubFetch(railsServing());
    const leg = await lightning()(ORDER);

    expect(JSON.parse(JSON.stringify(leg))).toEqual(leg);
  });
});

describe("bankRail", () => {
  it("takes the reference, the amount and the currency from the order and nothing else", async () => {
    stubFetch(railsServing());

    const leg = await bank()(ORDER);

    expect(leg.scan).toContain(`ACC:${IBAN}`);
    expect(leg.scan).toContain("AM:480.55");
    expect(leg.scan).toContain("CC:CZK");
    expect(leg.scan).toContain(`MSG:${ORDER.reference}`);
  });

  it("renders the descriptor as its own QR, because a banking app scans it as it stands", async () => {
    stubFetch(railsServing());

    const leg = await bank()(ORDER);

    expect(leg.qr).toBe(leg.scan);
  });

  it("offers one order at the same expiry every time, so a re-offer is the same watch", async () => {
    const calls = stubFetch(railsServing());
    const rail = bank();

    await rail(ORDER);
    await rail(ORDER);

    const [first, second] = calls.filter((call) => call.url === `${GATEWAY}/watched-payments`);
    expect(JSON.parse(String(first?.init?.body))).toEqual(JSON.parse(String(second?.init?.body)));
  });

  it("posts a hash, a URL and an expiry, keeping the account out of it", async () => {
    const calls = stubFetch(railsServing());

    await bank()(ORDER);

    const body = bodyOf(`${GATEWAY}/watched-payments`, calls);
    expect(Object.keys(body).sort()).toEqual(["expires_at", "payment_hash", "verify_url"]);
    expect(JSON.stringify(body)).not.toContain(IBAN);
  });

  it("asks for a webhook when given one, which is the only way a bank leg tells a server anything", async () => {
    const calls = stubFetch(railsServing());

    await bank({ webhookUrl: "https://shop.example.org/hooks/bank", webhookSecret: "s".repeat(32) })(
      ORDER,
    );

    expect(bodyOf(`${GATEWAY}/watched-payments`, calls)["webhook"]).toEqual({
      url: "https://shop.example.org/hooks/bank",
      secret: "s".repeat(32),
    });
  });

  it("still names the amount and the reference in the verify URL, which is why the gateway must be yours", async () => {
    const calls = stubFetch(railsServing());

    await bank()(ORDER);

    const polled = new URL(String(bodyOf(`${GATEWAY}/watched-payments`, calls)["verify_url"]));
    expect(polled.searchParams.get("minor")).toBe(String(ORDER.amountMinor));
    expect(polled.searchParams.get("ref")).toBe(ORDER.reference);
  });
});

describe("lightningRail", () => {
  it("sends no idempotency key unless one was asked for, because a stable one is joinable", async () => {
    const calls = stubFetch(railsServing());

    await lightning()(ORDER);

    const call = calls.find((made) => made.url === `${GATEWAY}/incoming-payments`);
    expect(call?.init?.headers).not.toHaveProperty("idempotency-key");
  });

  it("sends the key when the shop writes one, keyed off the order", async () => {
    const calls = stubFetch(railsServing());

    await lightning({ idempotencyKey: (order) => order.reference })(ORDER);

    const call = calls.find((made) => made.url === `${GATEWAY}/incoming-payments`);
    expect(call?.init?.headers).toMatchObject({ "idempotency-key": ORDER.reference });
  });

  it("keeps the raw invoice on scan and puts the URI scheme only on the QR", async () => {
    stubFetch(railsServing());

    const leg = await lightning()(ORDER);

    expect(leg.scan).toBe(INVOICE);
    expect(leg.qr).toBe(`LIGHTNING:${INVOICE.toUpperCase()}`);
  });

  it("prices the order through the shop's own function, not through the gateway", async () => {
    stubFetch(railsServing());
    const priced = vi.fn(() => AMOUNT_MSAT);

    await lightning({ amountMsat: priced })(ORDER);

    expect(priced).toHaveBeenCalledWith(ORDER);
  });
});

describe("blindLightningRail", () => {
  it("hands the gateway a hash and a URL, and never the address or the amount", async () => {
    const calls = stubFetch(railsServing());

    await blind()(ORDER);

    const body = bodyOf(`${GATEWAY}/watched-payments`, calls);
    expect(body["payment_hash"]).toBe(PAYMENT_HASH);
    expect(body["verify_url"]).toBe(VERIFY);
    expect(JSON.stringify(body)).not.toContain(LN_ADDRESS);
    expect(JSON.stringify(body)).not.toContain(String(AMOUNT_MSAT));
  });

  it("never asks the gateway to mint", async () => {
    const calls = stubFetch(railsServing());

    await blind()(ORDER);

    expect(calls.some((call) => call.url === `${GATEWAY}/incoming-payments`)).toBe(false);
  });

  it("refuses with the same error type the minting rail throws, so one catch covers both", async () => {
    stubFetch(railsServing({ [PAY_REQUEST]: () => jsonResponse({ status: "ERROR" }, 404) }));

    await expect(blind()(ORDER)).rejects.toBeInstanceOf(NoWalletAvailableError);
  });
});

describe("a leg the bank rail built, against the gateway's own settlement check", () => {
  function paidInto(...credits: Credit[]): void {
    const handler = bankVerifyEndpoint({ secret: SECRET, statement: async () => credits });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: RequestInfo | URL) => handler(new Request(String(url)))),
    );
  }

  async function toldToTheGateway(): Promise<{ paymentHash: string; verifyUrl: string }> {
    const calls = stubFetch(railsServing());
    await bank()(ORDER);
    const told = bodyOf(`${GATEWAY}/watched-payments`, calls);

    return { paymentHash: String(told["payment_hash"]), verifyUrl: String(told["verify_url"]) };
  }

  it("settles once the money is on the statement, with nothing added to the gateway", async () => {
    const told = await toldToTheGateway();
    paidInto({
      amountMinor: ORDER.amountMinor,
      currency: ORDER.currency,
      reference: `PLATBA ${ORDER.reference} DIKY`,
      bookedAt: 1_780_000_000,
    });

    const { preimage } = await checkSettled(told.verifyUrl, told.paymentHash);

    expect(preimage).toMatch(/^[0-9a-f]{64}$/);
    expect(preimageMatchesHash(String(preimage), told.paymentHash)).toBe(true);
  });

  it("stays unsettled while nothing has landed", async () => {
    const told = await toldToTheGateway();
    paidInto();

    expect((await checkSettled(told.verifyUrl, told.paymentHash)).preimage).toBeNull();
  });

  it("does not settle on a credit for a different order", async () => {
    const told = await toldToTheGateway();
    paidInto({
      amountMinor: ORDER.amountMinor,
      currency: ORDER.currency,
      reference: "ORDER-SOMEONE-ELSE",
      bookedAt: 1_780_000_000,
    });

    expect((await checkSettled(told.verifyUrl, told.paymentHash)).preimage).toBeNull();
  });
});
