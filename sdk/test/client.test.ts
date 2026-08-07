import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThunderBridge } from "../src/client";
import {
  GatewayCheatError,
  IdempotencyConflictError,
  isProblemType,
  NO_WALLET_AVAILABLE,
  NoWalletAvailableError,
  PAYMENT_ALREADY_WATCHED,
  ProblemError,
} from "../src/errors";
import type { Payment, TriggerEvent } from "../src/types";
import { bolt11 } from "./encode";
import { jsonResponse, problemResponse, stubFetch, type FetchCall, type Routes } from "./harness";

const GATEWAY = "https://gateway.example.net";
const LN_ADDRESS = "alice@example.com";
const PAY_REQUEST_URL = "https://example.com/.well-known/lnurlp/alice";
const CALLBACK_URL = "https://example.com/lnurl/pay/alice";
const VERIFY_URL = "https://example.com/lnurl/verify/1a2b3c";
const METADATA = '[["text/plain","one coffee for alice"]]';
const AMOUNT_MSAT = 21_000_000;
const PREIMAGE = "11".repeat(32);
const PAYMENT_HASH = sha256Hex(Buffer.from(PREIMAGE, "hex"));
const INVOICE = bolt11({
  paymentHash: PAYMENT_HASH,
  amountMsat: AMOUNT_MSAT,
  descriptionHash: sha256Hex(METADATA),
});
const SOMEONE_ELSES_INVOICE = bolt11({
  paymentHash: "cd".repeat(32),
  amountMsat: AMOUNT_MSAT,
  descriptionHash: sha256Hex(METADATA),
});

function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function pendingPayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: "pay_0001",
    lnAddress: LN_ADDRESS,
    amountMsat: AMOUNT_MSAT,
    status: "pending",
    paymentHash: PAYMENT_HASH,
    bolt11: INVOICE,
    preimage: null,
    expiresAt: 1_900_000_600,
    createdAt: 1_900_000_000,
    verifyUrl: VERIFY_URL,
    ...overrides,
  };
}

function settledPayment(overrides: Partial<Payment> = {}): Payment {
  return pendingPayment({ status: "paid", preimage: PREIMAGE, ...overrides });
}

function amount(msat: number): Record<string, unknown> {
  return { value: String(msat), asset_code: "BTC", asset_scale: 11 };
}

function wireOf(payment: Payment): Record<string, unknown> {
  return {
    id: payment.id,
    ln_address: payment.lnAddress,
    incoming_amount: amount(payment.amountMsat),
    status: payment.status,
    bolt11: payment.bolt11,
    payment_hash: payment.paymentHash,
    verify_url: payment.verifyUrl,
    preimage: payment.preimage,
    expires_at: new Date(payment.expiresAt * 1000).toISOString(),
    created_at: new Date(payment.createdAt * 1000).toISOString(),
  };
}

function recipientServing(issuedInvoice = INVOICE): Routes {
  return {
    [PAY_REQUEST_URL]: () =>
      jsonResponse({
        callback: CALLBACK_URL,
        metadata: METADATA,
        minSendable: 1_000,
        maxSendable: 100_000_000,
        tag: "payRequest",
      }),
    [VERIFY_URL]: () =>
      jsonResponse({ status: "OK", settled: false, preimage: null, pr: issuedInvoice }),
  };
}

function gatewayMints(payment: Payment): Routes {
  return { [`${GATEWAY}/incoming-payments`]: () => jsonResponse(wireOf(payment), 201) };
}

function gatewayQuotes(overrides: Record<string, unknown> = {}): Routes {
  return {
    [`${GATEWAY}/quotes`]: () =>
      jsonResponse({
        ln_address: LN_ADDRESS,
        amount: amount(AMOUNT_MSAT),
        fee: amount(0),
        min_amount: amount(1_000),
        max_amount: amount(100_000_000),
        metadata: METADATA,
        refusals: [],
        ...overrides,
      }),
  };
}

function postedBody(calls: FetchCall[]): Record<string, unknown> {
  return JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
}

function headersOf(call: FetchCall): Record<string, string> {
  return (call.init?.headers ?? {}) as Record<string, string>;
}

class FakeSocket {
  static readonly opened: FakeSocket[] = [];

  readonly url: string;
  closeCalls = 0;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.opened.push(this);
  }

  close(): void {
    this.closeCalls += 1;
  }

  deliver(payment: Payment): void {
    this.onmessage?.({ data: JSON.stringify(wireOf(payment)) });
  }

  breakConnection(): void {
    this.onerror?.();
    this.onclose?.();
  }

  closeFromServer(): void {
    this.onclose?.();
  }
}

function theSocket(): FakeSocket {
  expect(FakeSocket.opened).toHaveLength(1);
  return FakeSocket.opened[0];
}

interface Tracked<T> {
  outcomes: string[];
  value?: T;
  error?: unknown;
}

function track<T>(promise: Promise<T>): Tracked<T> {
  const tracked: Tracked<T> = { outcomes: [] };
  void promise.then(
    (value) => {
      tracked.outcomes.push("resolved");
      tracked.value = value;
    },
    (error: unknown) => {
      tracked.outcomes.push("rejected");
      tracked.error = error;
    },
  );
  return tracked;
}

async function drainMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  FakeSocket.opened.length = 0;
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createPayment", () => {
  it("posts the address list and the amount as snake_case JSON to the incoming-payments path", async () => {
    const calls = stubFetch({ ...gatewayMints(pendingPayment()), ...recipientServing() });

    await new ThunderBridge(GATEWAY).createPayment({
      lnAddresses: [LN_ADDRESS, "bob@example.org"],
      amountMsat: AMOUNT_MSAT,
    });

    expect(calls[0].url).toBe(`${GATEWAY}/incoming-payments`);
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.headers).toEqual({ "content-type": "application/json" });
    expect(postedBody(calls)).toEqual({
      ln_addresses: [LN_ADDRESS, "bob@example.org"],
      incoming_amount: { value: String(AMOUNT_MSAT), asset_code: "BTC", asset_scale: 11 },
    });
  });

  it("sends the amount as a string, never as the JSON number it is in TypeScript", async () => {
    const calls = stubFetch({ ...gatewayMints(pendingPayment()), ...recipientServing() });

    await new ThunderBridge(GATEWAY).createPayment({
      lnAddresses: [LN_ADDRESS],
      amountMsat: AMOUNT_MSAT,
    });

    const amount = postedBody(calls)["incoming_amount"] as Record<string, unknown>;
    expect(typeof amount["value"]).toBe("string");
    expect(String(calls[0].init?.body)).not.toContain(`"value":${AMOUNT_MSAT}`);
  });

  it("sends the webhook url and secret nested under one webhook object when they are given", async () => {
    const calls = stubFetch({ ...gatewayMints(pendingPayment()), ...recipientServing() });

    await new ThunderBridge(GATEWAY).createPayment({
      lnAddresses: [LN_ADDRESS],
      amountMsat: AMOUNT_MSAT,
      webhookUrl: "https://shop.example.org/hooks/lightning",
      webhookSecret: "s3cret",
    });

    expect(postedBody(calls)).toEqual({
      ln_addresses: [LN_ADDRESS],
      incoming_amount: { value: String(AMOUNT_MSAT), asset_code: "BTC", asset_scale: 11 },
      webhook: { url: "https://shop.example.org/hooks/lightning", secret: "s3cret" },
    });
  });

  it("omits the webhook key from the body entirely when no webhook was asked for", async () => {
    const calls = stubFetch({ ...gatewayMints(pendingPayment()), ...recipientServing() });

    await new ThunderBridge(GATEWAY).createPayment({
      lnAddresses: [LN_ADDRESS],
      amountMsat: AMOUNT_MSAT,
    });

    expect(Object.keys(postedBody(calls))).toEqual(["ln_addresses", "incoming_amount"]);
  });

  it("does not double the slash in the request path when the base URL ends in one", async () => {
    const calls = stubFetch({ ...gatewayMints(pendingPayment()), ...recipientServing() });

    await new ThunderBridge(`${GATEWAY}/`).createPayment({
      lnAddresses: [LN_ADDRESS],
      amountMsat: AMOUNT_MSAT,
    });

    expect(calls[0].url).toBe(`${GATEWAY}/incoming-payments`);
  });

  it("returns the payment once the recipient's own server confirms it issued the invoice", async () => {
    const minted = pendingPayment();
    const calls = stubFetch({ ...gatewayMints(minted), ...recipientServing() });

    const payment = await new ThunderBridge(GATEWAY).createPayment({
      lnAddresses: [LN_ADDRESS],
      amountMsat: AMOUNT_MSAT,
    });

    expect(payment).toEqual(minted);
    expect(calls.map((call) => call.url)).toEqual([
      `${GATEWAY}/incoming-payments`,
      PAY_REQUEST_URL,
      VERIFY_URL,
    ]);
  });

  it("throws GatewayCheatError when the recipient's server never issued the invoice returned", async () => {
    stubFetch({
      ...gatewayMints(pendingPayment()),
      ...recipientServing(SOMEONE_ELSES_INVOICE),
    });

    const rejection = await new ThunderBridge(GATEWAY)
      .createPayment({ lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(GatewayCheatError);
    expect((rejection as GatewayCheatError).code).toBe("invoice_not_issued");
    expect((rejection as GatewayCheatError).paymentId).toBe("pay_0001");
  });

  it("throws GatewayCheatError when the invoice does not carry the payment hash the gateway claims", async () => {
    stubFetch({
      ...gatewayMints(pendingPayment({ paymentHash: "ab".repeat(32) })),
      ...recipientServing(),
    });

    const rejection = await new ThunderBridge(GATEWAY)
      .createPayment({ lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(GatewayCheatError);
    expect((rejection as GatewayCheatError).code).toBe("hash_mismatch");
  });

  it("throws GatewayCheatError when the gateway chose an address that was never on the list", async () => {
    stubFetch({ ...gatewayMints(pendingPayment({ lnAddress: "mallory@evil.example" })) });

    const rejection = await new ThunderBridge(GATEWAY)
      .createPayment({ lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(GatewayCheatError);
    expect((rejection as GatewayCheatError).code).toBe("address_not_requested");
  });

  it("hands back an unprovable payment without ever contacting the recipient when verification is off", async () => {
    const unprovable = pendingPayment({ paymentHash: "ab".repeat(32) });
    const calls = stubFetch({ ...gatewayMints(unprovable), ...recipientServing() });

    const payment = await new ThunderBridge(GATEWAY, { verify: false }).createPayment({
      lnAddresses: [LN_ADDRESS],
      amountMsat: AMOUNT_MSAT,
    });

    expect(payment).toEqual(unprovable);
    expect(calls.map((call) => call.url)).toEqual([`${GATEWAY}/incoming-payments`]);
  });

  it("turns a no-wallet-available problem into a NoWalletAvailableError keeping every wallet reason", async () => {
    const wallets = [
      { address: LN_ADDRESS, reason: "unreachable" },
      { address: "bob@example.org", reason: "invoice-refused" },
    ];
    stubFetch({
      [`${GATEWAY}/incoming-payments`]: () =>
        problemResponse(
          {
            type: "urn:problem-type:thunder-bridge:no-wallet-available",
            title: "No wallet could issue a provable invoice",
            status: 502,
            wallets,
          },
          502,
        ),
    });

    const rejection = await new ThunderBridge(GATEWAY)
      .createPayment({ lnAddresses: [LN_ADDRESS, "bob@example.org"], amountMsat: AMOUNT_MSAT })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(NoWalletAvailableError);
    expect(rejection).toBeInstanceOf(ProblemError);
    expect((rejection as NoWalletAvailableError).wallets).toEqual(wallets);
    expect((rejection as NoWalletAvailableError).type).toBe(
      "urn:problem-type:thunder-bridge:no-wallet-available",
    );
    expect((rejection as NoWalletAvailableError).status).toBe(502);
  });

  it("turns any other problem document into a ProblemError keeping type, title, status and detail", async () => {
    stubFetch({
      [`${GATEWAY}/incoming-payments`]: () =>
        problemResponse(
          {
            type: "urn:problem-type:thunder-bridge:invalid-request",
            title: "The request could not be read",
            status: 400,
            detail: "amount_msat must be a positive number",
          },
          400,
        ),
    });

    const rejection = await new ThunderBridge(GATEWAY)
      .createPayment({ lnAddresses: [LN_ADDRESS], amountMsat: -1 })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(ProblemError);
    expect(rejection).not.toBeInstanceOf(NoWalletAvailableError);
    expect(rejection as ProblemError).toMatchObject({
      type: "urn:problem-type:thunder-bridge:invalid-request",
      title: "The request could not be read",
      status: 400,
      detail: "amount_msat must be a positive number",
      message: "The request could not be read: amount_msat must be a positive number",
    });
  });

  it("still produces a ProblemError carrying the HTTP status when the error body is not JSON", async () => {
    stubFetch({
      [`${GATEWAY}/incoming-payments`]: () =>
        new Response("<html>502 Bad Gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    });

    const rejection = await new ThunderBridge(GATEWAY)
      .createPayment({ lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(ProblemError);
    expect((rejection as ProblemError).status).toBe(502);
    expect((rejection as ProblemError).type).toBe("about:blank");
    expect((rejection as ProblemError).detail).toBeNull();
  });

  it("sends the idempotency key as a header when one is given", async () => {
    const calls = stubFetch({ ...gatewayMints(pendingPayment()), ...recipientServing() });

    await new ThunderBridge(GATEWAY).createPayment(
      { lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT },
      { idempotencyKey: "retry-me-0001" },
    );

    expect(headersOf(calls[0])).toMatchObject({
      "content-type": "application/json",
      "idempotency-key": "retry-me-0001",
    });
  });

  it("sends no idempotency header at all when no key was given", async () => {
    const calls = stubFetch({ ...gatewayMints(pendingPayment()), ...recipientServing() });

    await new ThunderBridge(GATEWAY).createPayment({
      lnAddresses: [LN_ADDRESS],
      amountMsat: AMOUNT_MSAT,
    });

    expect(headersOf(calls[0])).not.toHaveProperty("idempotency-key");
  });

  it("throws IdempotencyConflictError request-in-flight while the first attempt is still resolving", async () => {
    stubFetch({
      [`${GATEWAY}/incoming-payments`]: () =>
        problemResponse(
          {
            type: "urn:problem-type:thunder-bridge:request-in-flight",
            title: "A request with this Idempotency-Key is still running",
            status: 409,
          },
          409,
        ),
    });

    const rejection = await new ThunderBridge(GATEWAY)
      .createPayment(
        { lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT },
        { idempotencyKey: "retry-me-0001" },
      )
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(IdempotencyConflictError);
    expect(rejection).toBeInstanceOf(ProblemError);
    expect((rejection as IdempotencyConflictError).conflict).toBe("request-in-flight");
    expect((rejection as IdempotencyConflictError).status).toBe(409);
  });

  it("throws IdempotencyConflictError key-reused when the key was claimed by a different request", async () => {
    stubFetch({
      [`${GATEWAY}/incoming-payments`]: () =>
        problemResponse(
          {
            type: "urn:problem-type:thunder-bridge:idempotency-key-reused",
            title: "This Idempotency-Key was used for a different request",
            status: 409,
          },
          409,
        ),
    });

    const rejection = await new ThunderBridge(GATEWAY)
      .createPayment(
        { lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT },
        { idempotencyKey: "retry-me-0001" },
      )
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(IdempotencyConflictError);
    expect((rejection as IdempotencyConflictError).conflict).toBe("key-reused");
  });

  it("reports a replay whose payment was pruned as a plain problem, never as a second mint", async () => {
    stubFetch({
      [`${GATEWAY}/incoming-payments`]: () =>
        problemResponse(
          { type: "about:blank", title: "Gone", status: 410, detail: "already pruned" },
          410,
        ),
    });

    const rejection = await new ThunderBridge(GATEWAY)
      .createPayment(
        { lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT },
        { idempotencyKey: "retry-me-0001" },
      )
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(ProblemError);
    expect(rejection).not.toBeInstanceOf(IdempotencyConflictError);
    expect((rejection as ProblemError).status).toBe(410);
  });

  it("verifies a replayed payment against the recipient exactly as it verifies a fresh one", async () => {
    stubFetch({
      [`${GATEWAY}/incoming-payments`]: () =>
        jsonResponse(wireOf(pendingPayment({ bolt11: SOMEONE_ELSES_INVOICE })), 201),
      ...recipientServing(),
    });

    const rejection = await new ThunderBridge(GATEWAY)
      .createPayment(
        { lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT },
        { idempotencyKey: "retry-me-0001" },
      )
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(GatewayCheatError);
  });
});

describe("createQuote", () => {
  it("posts the address list and the amount to the quotes path, with amount as a string", async () => {
    const calls = stubFetch(gatewayQuotes());

    await new ThunderBridge(GATEWAY).createQuote({
      lnAddresses: [LN_ADDRESS, "bob@example.org"],
      amountMsat: AMOUNT_MSAT,
    });

    expect(calls[0].url).toBe(`${GATEWAY}/quotes`);
    expect(postedBody(calls)).toEqual({
      ln_addresses: [LN_ADDRESS, "bob@example.org"],
      amount: { value: String(AMOUNT_MSAT), asset_code: "BTC", asset_scale: 11 },
    });
  });

  it("reads the wire quote back as millisatoshi numbers with the refusals kept in order", async () => {
    stubFetch(
      gatewayQuotes({
        refusals: [
          { address: "bob@example.org", reason: "unreachable" },
          { address: "carol@example.org", reason: "cannot-prove-delivery" },
        ],
      }),
    );

    const quote = await new ThunderBridge(GATEWAY).createQuote({
      lnAddresses: [LN_ADDRESS],
      amountMsat: AMOUNT_MSAT,
    });

    expect(quote).toEqual({
      lnAddress: LN_ADDRESS,
      amountMsat: AMOUNT_MSAT,
      feeMsat: 0,
      minMsat: 1_000,
      maxMsat: 100_000_000,
      metadata: METADATA,
      refusals: [
        { address: "bob@example.org", reason: "unreachable" },
        { address: "carol@example.org", reason: "cannot-prove-delivery" },
      ],
    });
  });

  it("never contacts the recipient, because a quote mints nothing there is to verify", async () => {
    const calls = stubFetch(gatewayQuotes());

    await new ThunderBridge(GATEWAY).createQuote({
      lnAddresses: [LN_ADDRESS],
      amountMsat: AMOUNT_MSAT,
    });

    expect(calls.map((call) => call.url)).toEqual([`${GATEWAY}/quotes`]);
  });

  it("turns a no-wallet-available problem into a NoWalletAvailableError just as create does", async () => {
    const wallets = [{ address: LN_ADDRESS, reason: "amount-not-accepted" }];
    stubFetch({
      [`${GATEWAY}/quotes`]: () =>
        problemResponse(
          {
            type: "urn:problem-type:thunder-bridge:no-wallet-available",
            title: "No wallet would take this amount",
            status: 400,
            wallets,
          },
          400,
        ),
    });

    const rejection = await new ThunderBridge(GATEWAY)
      .createQuote({ lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(NoWalletAvailableError);
    expect((rejection as NoWalletAvailableError).wallets).toEqual(wallets);
  });

  it("refuses a quote whose amount is denominated in something other than millisatoshi", async () => {
    stubFetch({
      [`${GATEWAY}/quotes`]: () =>
        jsonResponse({
          ln_address: LN_ADDRESS,
          amount: { value: "21", asset_code: "USD", asset_scale: 2 },
          fee: { value: "0", asset_code: "BTC", asset_scale: 11 },
          min_amount: { value: "1000", asset_code: "BTC", asset_scale: 11 },
          max_amount: { value: "100000000", asset_code: "BTC", asset_scale: 11 },
          metadata: METADATA,
          refusals: [],
        }),
    });

    const rejection = await new ThunderBridge(GATEWAY)
      .createQuote({ lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(ProblemError);
    expect((rejection as ProblemError).title).toBe(
      "The gateway answered with something that is not a quote",
    );
  });

  it("refuses a quote carrying a refusal reason it does not know", async () => {
    stubFetch(gatewayQuotes({ refusals: [{ address: "bob@example.org", reason: "vibes" }] }));

    const rejection = await new ThunderBridge(GATEWAY)
      .createQuote({ lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(ProblemError);
  });

  it("keeps a zero fee as zero rather than reading it as a missing amount", async () => {
    stubFetch(gatewayQuotes());

    const quote = await new ThunderBridge(GATEWAY).createQuote({
      lnAddresses: [LN_ADDRESS],
      amountMsat: AMOUNT_MSAT,
    });

    expect(quote.feeMsat).toBe(0);
  });
});

describe("getPayment", () => {
  it("reads the payment back from the payment path with the id escaped", async () => {
    const calls = stubFetch({
      [`${GATEWAY}/incoming-payments/pay%2F0001`]: () => jsonResponse(wireOf(pendingPayment())),
    });

    await new ThunderBridge(GATEWAY).getPayment("pay/0001");

    expect(calls.map((call) => call.url)).toEqual([`${GATEWAY}/incoming-payments/pay%2F0001`]);
  });

  it("returns null when the gateway has never heard of the payment", async () => {
    stubFetch({
      [`${GATEWAY}/incoming-payments/pay_0001`]: () => problemResponse({ title: "Not Found" }, 404),
    });

    await expect(new ThunderBridge(GATEWAY).getPayment("pay_0001")).resolves.toBeNull();
  });

  it("throws the problem document when the read fails for any reason other than not found", async () => {
    stubFetch({
      [`${GATEWAY}/incoming-payments/pay_0001`]: () =>
        problemResponse({ title: "Internal Server Error", status: 500 }, 500),
    });

    const rejection = await new ThunderBridge(GATEWAY)
      .getPayment("pay_0001")
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(ProblemError);
    expect((rejection as ProblemError).status).toBe(500);
    expect((rejection as ProblemError).title).toBe("Internal Server Error");
  });

  it("returns a settlement whose preimage hashes to the payment hash", async () => {
    const settled = settledPayment();
    stubFetch({ [`${GATEWAY}/incoming-payments/pay_0001`]: () => jsonResponse(wireOf(settled)) });

    await expect(new ThunderBridge(GATEWAY).getPayment("pay_0001")).resolves.toEqual(settled);
  });

  it("throws GatewayCheatError preimage_mismatch when a reported settlement does not hash to the payment hash", async () => {
    stubFetch({
      [`${GATEWAY}/incoming-payments/pay_0001`]: () =>
        jsonResponse(wireOf(settledPayment({ preimage: "22".repeat(32) }))),
    });

    const rejection = await new ThunderBridge(GATEWAY)
      .getPayment("pay_0001")
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(GatewayCheatError);
    expect((rejection as GatewayCheatError).code).toBe("preimage_mismatch");
    expect((rejection as GatewayCheatError).paymentId).toBe("pay_0001");
  });

  it("throws GatewayCheatError preimage_mismatch when the gateway claims paid and carries no preimage", async () => {
    stubFetch({
      [`${GATEWAY}/incoming-payments/pay_0001`]: () =>
        jsonResponse(wireOf(settledPayment({ preimage: null }))),
    });

    const rejection = await new ThunderBridge(GATEWAY)
      .getPayment("pay_0001")
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(GatewayCheatError);
    expect((rejection as GatewayCheatError).code).toBe("preimage_mismatch");
  });

  it("returns a settlement with an unmatched preimage as it stands when verification is off", async () => {
    const lying = settledPayment({ preimage: "22".repeat(32) });
    stubFetch({ [`${GATEWAY}/incoming-payments/pay_0001`]: () => jsonResponse(wireOf(lying)) });

    const payment = await new ThunderBridge(GATEWAY, { verify: false }).getPayment("pay_0001");

    expect(payment).toEqual(lying);
  });
});

describe("waitForPayment", () => {
  it("follows the payment over the websocket scheme of the base URL with the id escaped", () => {
    const waiting = track(new ThunderBridge(`${GATEWAY}/`).waitForPayment("pay/0001"));

    expect(theSocket().url).toBe("wss://gateway.example.net/ws/incoming-payments/pay%2F0001");
    expect(waiting.outcomes).toEqual([]);
  });

  it("resolves with the payment as soon as a paid frame arrives", async () => {
    const settled = settledPayment();
    const waiting = new ThunderBridge(GATEWAY).waitForPayment("pay_0001");

    theSocket().deliver(settled);

    await expect(waiting).resolves.toEqual(settled);
  });

  it("resolves when the payment expires", async () => {
    const expired = pendingPayment({ status: "expired" });
    const waiting = new ThunderBridge(GATEWAY).waitForPayment("pay_0001");

    theSocket().deliver(expired);

    await expect(waiting).resolves.toEqual(expired);
  });

  it("keeps waiting through pending frames and settles only on the terminal one", async () => {
    const settled = settledPayment();
    const waiting = track(new ThunderBridge(GATEWAY).waitForPayment("pay_0001"));

    theSocket().deliver(pendingPayment());
    theSocket().deliver(pendingPayment({ expiresAt: 1_900_000_900 }));
    await drainMicrotasks();
    expect(waiting.outcomes).toEqual([]);

    theSocket().deliver(settled);
    await drainMicrotasks();

    expect(waiting.outcomes).toEqual(["resolved"]);
    expect(waiting.value).toEqual(settled);
  });

  it("closes the socket itself once it has what it was waiting for", async () => {
    const waiting = track(new ThunderBridge(GATEWAY).waitForPayment("pay_0001"));

    theSocket().deliver(settledPayment());
    await drainMicrotasks();

    expect(theSocket().closeCalls).toBe(1);
    expect(waiting.outcomes).toEqual(["resolved"]);
  });

  it("settles exactly once when the server closes the socket right after the terminal frame", async () => {
    const settled = settledPayment();
    const waiting = track(new ThunderBridge(GATEWAY).waitForPayment("pay_0001"));

    theSocket().deliver(settled);
    theSocket().closeFromServer();
    await drainMicrotasks();

    expect(waiting.outcomes).toEqual(["resolved"]);
    expect(waiting.value).toEqual(settled);
    expect(theSocket().closeCalls).toBe(1);
  });

  it("rejects as soon as the abort signal fires and stops listening to the socket", async () => {
    const controller = new AbortController();
    const waiting = track(
      new ThunderBridge(GATEWAY).waitForPayment("pay_0001", { signal: controller.signal }),
    );

    controller.abort();
    await drainMicrotasks();

    expect(waiting.outcomes).toEqual(["rejected"]);
    expect((waiting.error as Error).message).toBe("waiting for payment pay_0001 was aborted");
    expect(theSocket().closeCalls).toBe(1);
  });

  it("ignores an abort that arrives after the payment already settled", async () => {
    const controller = new AbortController();
    const settled = settledPayment();
    const waiting = track(
      new ThunderBridge(GATEWAY).waitForPayment("pay_0001", { signal: controller.signal }),
    );

    theSocket().deliver(settled);
    controller.abort();
    await drainMicrotasks();

    expect(waiting.outcomes).toEqual(["resolved"]);
    expect(waiting.value).toEqual(settled);
  });

  it("rejects with GatewayCheatError when the paid frame carries a preimage that does not hash", async () => {
    const waiting = new ThunderBridge(GATEWAY).waitForPayment("pay_0001");

    theSocket().deliver(settledPayment({ preimage: "22".repeat(32) }));

    await expect(waiting).rejects.toBeInstanceOf(GatewayCheatError);
  });

  it("accepts a paid frame with an unmatched preimage when verification is off", async () => {
    const lying = settledPayment({ preimage: "22".repeat(32) });
    const waiting = new ThunderBridge(GATEWAY, { verify: false }).waitForPayment("pay_0001");

    theSocket().deliver(lying);

    await expect(waiting).resolves.toEqual(lying);
  });
});

describe("firstToSettle", () => {
  function legs(): FakeSocket[] {
    expect(FakeSocket.opened).toHaveLength(2);
    return FakeSocket.opened;
  }

  it("opens one socket per leg", () => {
    track(new ThunderBridge(GATEWAY).firstToSettle(["bank_01", "ln_01"]));

    expect(legs().map((socket) => socket.url)).toEqual([
      "wss://gateway.example.net/ws/incoming-payments/bank_01",
      "wss://gateway.example.net/ws/incoming-payments/ln_01",
    ]);
  });

  it("keeps the leg that was paid and stops waiting on the other", async () => {
    const paid = settledPayment({ id: "bank_01" });
    const winner = new ThunderBridge(GATEWAY).firstToSettle(["bank_01", "ln_01"]);

    legs()[0].deliver(paid);

    await expect(winner).resolves.toMatchObject({ id: paid.id, preimage: paid.preimage });
    await drainMicrotasks();
    expect(legs()[1].closeCalls).toBeGreaterThan(0);
  });

  it("waits on the rest when a leg only expires, because an expiry is a loser", async () => {
    const paid = settledPayment({ id: "ln_01" });
    const winner = track(new ThunderBridge(GATEWAY).firstToSettle(["bank_01", "ln_01"]));

    legs()[1].deliver(pendingPayment({ id: "ln_01", status: "expired" }));
    await drainMicrotasks();
    expect(winner.outcomes).toEqual([]);

    legs()[0].deliver(paid);
    await drainMicrotasks();

    expect(winner.outcomes).toEqual(["resolved"]);
    expect(winner.value).toMatchObject({ id: paid.id, preimage: paid.preimage });
  });

  it("answers null when every leg ended unpaid", async () => {
    const winner = new ThunderBridge(GATEWAY).firstToSettle(["bank_01", "ln_01"]);

    legs()[0].deliver(pendingPayment({ id: "bank_01", status: "expired" }));
    legs()[1].deliver(pendingPayment({ id: "ln_01", status: "expired" }));

    await expect(winner).resolves.toBeNull();
  });

  it("answers null for nothing to wait on, and opens no socket", async () => {
    await expect(new ThunderBridge(GATEWAY).firstToSettle([])).resolves.toBeNull();

    expect(FakeSocket.opened).toHaveLength(0);
  });

  it("surfaces a refusal only when it cost the last leg", async () => {
    const paid = settledPayment({ id: "ln_01" });
    const winner = new ThunderBridge(GATEWAY).firstToSettle(["bank_01", "ln_01"]);

    legs()[0].onmessage?.({ data: "not json at all" });
    legs()[1].deliver(paid);

    await expect(winner).resolves.toMatchObject({ id: paid.id, preimage: paid.preimage });
  });

  it("throws what refused when no leg was paid", async () => {
    const winner = new ThunderBridge(GATEWAY).firstToSettle(["bank_01", "ln_01"]);

    legs()[0].onmessage?.({ data: "not json at all" });
    legs()[1].deliver(pendingPayment({ id: "ln_01", status: "expired" }));

    await expect(winner).rejects.toThrow();
  });
});

describe("waitForPayment through a dropped socket", () => {
  const LONGEST_WAIT_MS = 30_000;
  const TOKEN = "only-my-app-holds-this";

  function lastSocket(): FakeSocket {
    return FakeSocket.opened[FakeSocket.opened.length - 1];
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects after a drop and settles on the frame the next socket replays", async () => {
    const settled = settledPayment();
    const waiting = track(new ThunderBridge(GATEWAY).waitForPayment("pay_0001"));

    lastSocket().deliver(pendingPayment());
    lastSocket().closeFromServer();
    await vi.advanceTimersByTimeAsync(LONGEST_WAIT_MS);
    expect(FakeSocket.opened).toHaveLength(2);

    lastSocket().deliver(settled);
    await vi.advanceTimersByTimeAsync(0);

    expect(waiting.outcomes).toEqual(["resolved"]);
    expect(waiting.value).toEqual(settled);
  });

  it("gives up after a few tries when no frame ever arrives, rather than hammering a wrong id", async () => {
    const waiting = track(new ThunderBridge(GATEWAY).waitForPayment("pay_0001"));

    for (let round = 0; round < 8; round += 1) {
      lastSocket().breakConnection();
      await vi.advanceTimersByTimeAsync(LONGEST_WAIT_MS);
    }

    expect(FakeSocket.opened).toHaveLength(5);
    expect(waiting.outcomes).toEqual(["rejected"]);
    expect((waiting.error as Error).message).toBe("no gateway answered for payment pay_0001");
  });

  it("stops reconnecting once the payment's own expiry has passed", async () => {
    const waiting = track(new ThunderBridge(GATEWAY).waitForPayment("pay_0001"));

    lastSocket().deliver(pendingPayment({ expiresAt: 1_000_000 }));
    lastSocket().closeFromServer();
    await vi.advanceTimersByTimeAsync(LONGEST_WAIT_MS);

    expect(FakeSocket.opened).toHaveLength(1);
    expect(waiting.outcomes).toEqual(["rejected"]);
    expect((waiting.error as Error).message).toContain("past its expiry");
  });

  it("opens no further socket when aborted during the wait between tries", async () => {
    const controller = new AbortController();
    const waiting = track(
      new ThunderBridge(GATEWAY).waitForPayment("pay_0001", { signal: controller.signal }),
    );

    lastSocket().closeFromServer();
    controller.abort();
    await vi.advanceTimersByTimeAsync(LONGEST_WAIT_MS);

    expect(FakeSocket.opened).toHaveLength(1);
    expect(waiting.outcomes).toEqual(["rejected"]);
  });

  it("mints a fresh ticket for every attempt, because a minute-old one is expired", async () => {
    const calls = stubFetch({
      [`${GATEWAY}/ws-tickets`]: () =>
        jsonResponse({ ticket: "1.p.abc.9.ff.mac", expires_at: "x" }),
    });
    track(new ThunderBridge(GATEWAY, { token: TOKEN, verify: false }).waitForPayment("pay_0001"));
    await vi.advanceTimersByTimeAsync(0);

    lastSocket().deliver(pendingPayment());
    lastSocket().closeFromServer();
    await vi.advanceTimersByTimeAsync(LONGEST_WAIT_MS);

    expect(calls).toHaveLength(2);
    expect(FakeSocket.opened).toHaveLength(2);
  });

  it("waits from the first delay again after each frame, not from a growing one", async () => {
    const firstWaitMs = 3_000;
    track(new ThunderBridge(GATEWAY).waitForPayment("pay_0001"));

    for (let round = 0; round < 3; round += 1) {
      lastSocket().deliver(pendingPayment());
      lastSocket().closeFromServer();
      await vi.advanceTimersByTimeAsync(firstWaitMs);
    }

    expect(FakeSocket.opened).toHaveLength(4);
  });

  it("keeps trying when the gateway is too dead to even mint a ticket", async () => {
    const calls = stubFetch({});
    const waiting = track(new ThunderBridge(GATEWAY, { token: TOKEN }).waitForPayment("pay_0001"));

    for (let round = 0; round < 8; round += 1) await vi.advanceTimersByTimeAsync(LONGEST_WAIT_MS);

    expect(calls).toHaveLength(5);
    expect(FakeSocket.opened).toHaveLength(0);
    expect((waiting.error as Error).message).toBe("no gateway answered for payment pay_0001");
  });

  it("gives up at once when the gateway answers the mint with a refusal", async () => {
    stubFetch({
      [`${GATEWAY}/ws-tickets`]: () => problemResponse({ title: "Unauthorized" }, 401),
    });
    const waiting = track(
      new ThunderBridge(GATEWAY, { token: "the-wrong-one" }).waitForPayment("pay_0001"),
    );

    await vi.advanceTimersByTimeAsync(LONGEST_WAIT_MS);

    expect(waiting.error).toBeInstanceOf(ProblemError);
  });

  it("keeps checking the preimage on a socket it reconnected, not only the first one", async () => {
    const waiting = track(new ThunderBridge(GATEWAY).waitForPayment("pay_0001"));

    lastSocket().deliver(pendingPayment());
    lastSocket().closeFromServer();
    await vi.advanceTimersByTimeAsync(LONGEST_WAIT_MS);

    lastSocket().deliver(settledPayment({ preimage: "22".repeat(32) }));
    await vi.advanceTimersByTimeAsync(0);

    expect(waiting.outcomes).toEqual(["rejected"]);
    expect(waiting.error).toBeInstanceOf(GatewayCheatError);
  });
});

describe("what the client will not take on faith", () => {
  it("refuses an invoice for more than the caller asked for", async () => {
    const inflated = 100 * AMOUNT_MSAT;
    const overcharged = pendingPayment({
      amountMsat: inflated,
      bolt11: bolt11({
        paymentHash: PAYMENT_HASH,
        amountMsat: inflated,
        descriptionHash: sha256Hex(METADATA),
      }),
    });
    stubFetch({ ...gatewayMints(overcharged), ...recipientServing(overcharged.bolt11) });

    const refusal = await new ThunderBridge(GATEWAY)
      .createPayment({ lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(GatewayCheatError);
    expect((refusal as GatewayCheatError).code).toBe("amount_mismatch");
  });

  it("rejects at once when the abort signal has already fired, without opening a socket", async () => {
    const waiting = new ThunderBridge(GATEWAY).waitForPayment("pay_0001", {
      signal: AbortSignal.abort(),
    });

    await expect(waiting).rejects.toThrow("was aborted");
    expect(FakeSocket.opened).toHaveLength(0);
  });

  it("rejects rather than hanging when the socket delivers something that is not JSON", async () => {
    const waiting = track(new ThunderBridge(GATEWAY).waitForPayment("pay_0001"));

    theSocket().onmessage?.({ data: "<html>502 Bad Gateway</html>" });
    await drainMicrotasks();

    expect(waiting.outcomes).toEqual(["rejected"]);
    expect(theSocket().closeCalls).toBe(1);
  });

  it("keeps the transport status when the problem document claims a different one", async () => {
    stubFetch({
      [`${GATEWAY}/incoming-payments/pay_0001`]: () =>
        problemResponse({ title: "fine", status: 200 }, 500),
    });

    const refusal = await new ThunderBridge(GATEWAY)
      .getPayment("pay_0001")
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ProblemError);
    expect((refusal as ProblemError).status).toBe(500);
  });

  it("hands back an empty wallet list when the gateway sends something that is not one", async () => {
    stubFetch({
      [`${GATEWAY}/incoming-payments`]: () =>
        problemResponse(
          {
            type: "urn:problem-type:thunder-bridge:no-wallet-available",
            title: "No wallet could issue a provable invoice",
            wallets: "every single one of them",
          },
          502,
        ),
    });

    const refusal = await new ThunderBridge(GATEWAY)
      .createPayment({ lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(NoWalletAvailableError);
    expect((refusal as NoWalletAvailableError).wallets).toEqual([]);
  });

  it.each(["not json", '"a string"', "null", "[]"])(
    "reports a problem rather than a parse error when a success body is %s",
    async (body) => {
      stubFetch({ [`${GATEWAY}/incoming-payments`]: () => new Response(body, { status: 201 }) });

      const refusal = await new ThunderBridge(GATEWAY)
        .createPayment({ lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT })
        .catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(ProblemError);
    },
  );

  it.each([
    { value: "21000000", asset_code: "USD", asset_scale: 2 },
    { value: "21000000", asset_code: "BTC", asset_scale: 8 },
    { value: 21_000_000, asset_code: "BTC", asset_scale: 11 },
  ])("refuses an amount of %o instead of reading it as millisatoshi", async (amount) => {
    const foreign = { ...wireOf(pendingPayment()), incoming_amount: amount };
    stubFetch({
      [`${GATEWAY}/incoming-payments`]: () => jsonResponse(foreign, 201),
      ...recipientServing(),
    });

    const refusal = await new ThunderBridge(GATEWAY)
      .createPayment({ lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ProblemError);
  });

  it("reports a problem rather than a parse error when a success body is not JSON", async () => {
    stubFetch({
      [`${GATEWAY}/incoming-payments`]: () => new Response("not json", { status: 201 }),
    });

    const refusal = await new ThunderBridge(GATEWAY)
      .createPayment({ lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ProblemError);
  });
});

describe("followTrigger", () => {
  const WATCH_SECRET = "the-overlay-holds-this";

  function following(options: Partial<Parameters<ThunderBridge["followTrigger"]>[1]> = {}) {
    const seen: TriggerEvent[] = [];
    const stop = new ThunderBridge(GATEWAY, { verify: false }).followTrigger(WATCH_SECRET, {
      onPayment: (payment) => seen.push(payment),
      reconnectDelayMs: 0,
      ...options,
    });

    return { seen, stop };
  }

  it("subscribes with the secret rather than with a payment id", () => {
    const { stop } = following();

    expect(theSocket().url).toBe(`wss://gateway.example.net/ws/triggers/${WATCH_SECRET}`);

    stop();
  });

  it("hands over the replay and then every live payment, pending ones included", () => {
    const { seen, stop } = following();

    theSocket().deliver(settledPayment());
    theSocket().deliver(pendingPayment({ id: "pay_0002" }));

    expect(seen.map((payment) => payment.id)).toEqual(["pay_0001", "pay_0002"]);
    stop();
  });

  it("reconnects on its own, because a trigger has no terminal state to stop at", async () => {
    const { stop } = following();

    theSocket().closeFromServer();
    await drainMicrotasks();

    expect(FakeSocket.opened).toHaveLength(2);
    stop();
  });

  it("stops reconnecting once the returned function is called", async () => {
    const { stop } = following();

    stop();
    FakeSocket.opened[0].closeFromServer();
    await drainMicrotasks();

    expect(FakeSocket.opened).toHaveLength(1);
  });

  it("stays subscribed through a frame it cannot read, reporting it instead of dying", () => {
    const errors: unknown[] = [];
    const { seen, stop } = following({ onError: (error) => errors.push(error) });

    theSocket().onmessage?.({ data: "not json" });
    theSocket().deliver(settledPayment());

    expect(errors).toHaveLength(1);
    expect(seen).toHaveLength(1);
    stop();
  });

  it("refuses a settlement whose preimage does not hash, exactly as the payment socket does", () => {
    const errors: unknown[] = [];
    const seen: TriggerEvent[] = [];
    const stop = new ThunderBridge(GATEWAY).followTrigger(WATCH_SECRET, {
      onPayment: (payment) => seen.push(payment),
      onError: (error) => errors.push(error),
    });

    theSocket().deliver(settledPayment({ preimage: "00".repeat(32) }));

    expect(seen).toEqual([]);
    expect(errors[0]).toBeInstanceOf(GatewayCheatError);
    stop();
  });
});

describe("a private gateway", () => {
  const TOKEN = "only-my-app-holds-this";

  it("sends the bearer on every call it makes, reads included", async () => {
    const calls = stubFetch({
      ...gatewayMints(pendingPayment()),
      ...gatewayQuotes(),
      [`${GATEWAY}/incoming-payments/pay_0001`]: () => jsonResponse(wireOf(pendingPayment())),
      ...recipientServing(),
    });
    const gateway = new ThunderBridge(GATEWAY, { token: TOKEN, verify: false });

    await gateway.createPayment({ lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT });
    await gateway.createQuote({ lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT });
    await gateway.getPayment("pay_0001");

    const toGateway = calls.filter((call) => call.url.startsWith(GATEWAY));
    expect(toGateway).toHaveLength(3);
    for (const call of toGateway) {
      expect(headersOf(call)["authorization"]).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("sends no authorization at all when no token was configured", async () => {
    const calls = stubFetch({ ...gatewayMints(pendingPayment()), ...recipientServing() });

    await new ThunderBridge(GATEWAY, { verify: false }).createPayment({
      lnAddresses: [LN_ADDRESS],
      amountMsat: AMOUNT_MSAT,
    });

    expect(headersOf(calls[0])).not.toHaveProperty("authorization");
  });

  it("lists what the gateway is watching, newest first, saying how far it scanned", async () => {
    stubFetch({
      [`${GATEWAY}/incoming-payments?limit=10`]: () =>
        jsonResponse({
          payments: [wireOf(settledPayment()), wireOf(pendingPayment({ id: "pay_0002" }))],
          settled_scanned: 1_000,
        }),
    });

    const listed = await new ThunderBridge(GATEWAY, { token: TOKEN, verify: false }).listPayments(
      10,
    );

    expect(listed.payments.map((one) => one.id)).toEqual(["pay_0001", "pay_0002"]);
    expect(listed.scanned).toBe(1_000);
  });

  it("turns a public gateway's 404 into a problem rather than an empty list", async () => {
    stubFetch({
      [`${GATEWAY}/incoming-payments`]: () =>
        problemResponse({ title: "Not Found", status: 404 }, 404),
    });

    const rejection = await new ThunderBridge(GATEWAY, { token: TOKEN })
      .listPayments()
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(ProblemError);
    expect((rejection as ProblemError).status).toBe(404);
  });
});

describe("followTrigger with tickets", () => {
  const WATCH_SECRET = "the-overlay-holds-this";
  const TICKET = "1.t.abc.123.ff.mac";

  function minting(routes: Routes = {}): FetchCall[] {
    return stubFetch({
      [`${GATEWAY}/ws-tickets`]: () => jsonResponse({ ticket: TICKET, expires_at: "x" }),
      ...routes,
    });
  }

  it("puts a ticket in the socket URL and never the secret", async () => {
    minting();
    const stop = new ThunderBridge(GATEWAY, { verify: false }).followTrigger(WATCH_SECRET, {
      onPayment: () => {},
      tickets: true,
    });
    await drainMicrotasks();

    expect(theSocket().url).toBe(`wss://gateway.example.net/ws/tickets/${TICKET}`);
    expect(theSocket().url).not.toContain(WATCH_SECRET);
    stop();
  });

  it("asks for the ticket with the secret in the body, where logs do not reach", async () => {
    const calls = minting();
    const stop = new ThunderBridge(GATEWAY, { verify: false }).followTrigger(WATCH_SECRET, {
      onPayment: () => {},
      tickets: true,
    });
    await drainMicrotasks();

    expect(calls[0].url).toBe(`${GATEWAY}/ws-tickets`);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ trigger_secret: WATCH_SECRET });
    stop();
  });

  it("mints a fresh ticket for every reconnect, because a minute-old one is expired", async () => {
    const calls = minting();
    const stop = new ThunderBridge(GATEWAY, { verify: false }).followTrigger(WATCH_SECRET, {
      onPayment: () => {},
      tickets: true,
      reconnectDelayMs: 0,
    });
    await drainMicrotasks();

    FakeSocket.opened[0].closeFromServer();
    await drainMicrotasks();
    await drainMicrotasks();

    expect(calls.filter((call) => call.url.endsWith("/ws-tickets"))).toHaveLength(2);
    expect(FakeSocket.opened).toHaveLength(2);
    stop();
  });

  it("reports a failed mint and keeps trying rather than ending the follow", async () => {
    const errors: unknown[] = [];
    minting({
      [`${GATEWAY}/ws-tickets`]: () => problemResponse({ title: "Unauthorized" }, 401),
    });
    const stop = new ThunderBridge(GATEWAY, { verify: false }).followTrigger(WATCH_SECRET, {
      onPayment: () => {},
      onError: (error) => errors.push(error),
      tickets: true,
      reconnectDelayMs: 0,
    });
    await drainMicrotasks();

    expect(errors[0]).toBeInstanceOf(ProblemError);
    expect(FakeSocket.opened).toHaveLength(0);
    stop();
  });

  it("opens no socket when stopped while the ticket was still being minted", async () => {
    minting();
    const stop = new ThunderBridge(GATEWAY, { verify: false }).followTrigger(WATCH_SECRET, {
      onPayment: () => {},
      tickets: true,
    });
    stop();
    await drainMicrotasks();

    expect(FakeSocket.opened).toHaveLength(0);
  });
});

describe("waitForPayment with tickets", () => {
  const TICKET = "1.p.abc.123.ff.mac";
  const TOKEN = "only-my-app-holds-this";

  function minting(routes: Routes = {}): FetchCall[] {
    return stubFetch({
      [`${GATEWAY}/ws-tickets`]: () => jsonResponse({ ticket: TICKET, expires_at: "x" }),
      ...routes,
    });
  }

  it("puts a ticket in the socket URL and never the payment id", async () => {
    minting();
    const waiting = track(
      new ThunderBridge(GATEWAY, { verify: false }).waitForPayment("pay_0001", { tickets: true }),
    );
    await drainMicrotasks();

    expect(theSocket().url).toBe(`wss://gateway.example.net/ws/tickets/${TICKET}`);
    expect(waiting.outcomes).toEqual([]);
  });

  it("asks for the ticket with the payment id in the body, where logs do not reach", async () => {
    const calls = minting();
    track(
      new ThunderBridge(GATEWAY, { verify: false }).waitForPayment("pay_0001", { tickets: true }),
    );
    await drainMicrotasks();

    expect(calls[0].url).toBe(`${GATEWAY}/ws-tickets`);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ payment_id: "pay_0001" });
  });

  it("tickets by itself once a token is set, because no socket can carry a header", async () => {
    const calls = minting();
    track(new ThunderBridge(GATEWAY, { token: TOKEN, verify: false }).waitForPayment("pay_0001"));
    await drainMicrotasks();

    expect(theSocket().url).toBe(`wss://gateway.example.net/ws/tickets/${TICKET}`);
    expect(headersOf(calls[0])["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("does the same for followTrigger, so the two behave alike on a private gateway", async () => {
    minting();
    const stop = new ThunderBridge(GATEWAY, { token: TOKEN, verify: false }).followTrigger(
      "the-overlay-holds-this",
      { onPayment: () => {} },
    );
    await drainMicrotasks();

    expect(theSocket().url).toBe(`wss://gateway.example.net/ws/tickets/${TICKET}`);
    stop();
  });

  it("rejects the wait when the mint is refused, rather than waiting on a socket it never opened", async () => {
    minting({ [`${GATEWAY}/ws-tickets`]: () => problemResponse({ title: "Unauthorized" }, 401) });
    const waiting = track(
      new ThunderBridge(GATEWAY, { token: TOKEN, verify: false }).waitForPayment("pay_0001"),
    );
    await drainMicrotasks();

    expect(waiting.outcomes).toEqual(["rejected"]);
    expect(waiting.error).toBeInstanceOf(ProblemError);
    expect(FakeSocket.opened).toHaveLength(0);
  });

  it("opens no socket when aborted while the ticket was still being minted", async () => {
    minting();
    const controller = new AbortController();
    const waiting = track(
      new ThunderBridge(GATEWAY, { token: TOKEN, verify: false }).waitForPayment("pay_0001", {
        signal: controller.signal,
      }),
    );
    controller.abort();
    await drainMicrotasks();

    expect(FakeSocket.opened).toHaveLength(0);
    expect(waiting.outcomes).toEqual(["rejected"]);
  });

  it("mints nothing on a public gateway, where the id in the path is the capability", async () => {
    const calls = minting();
    track(new ThunderBridge(GATEWAY, { verify: false }).waitForPayment("pay_0001"));

    expect(theSocket().url).toBe("wss://gateway.example.net/ws/incoming-payments/pay_0001");
    expect(calls).toHaveLength(0);
  });
});

describe("watchPayment", () => {
  const WATCH_HASH = "ab".repeat(32);
  const WATCH_VERIFY = "https://coinos.io/api/lnurl/verify/blind";
  const EXPIRES_AT = 1_900_000_600;

  function watchable(overrides: Record<string, unknown> = {}) {
    return {
      paymentHash: WATCH_HASH,
      verifyUrl: WATCH_VERIFY,
      expiresAt: EXPIRES_AT,
      ...overrides,
    };
  }

  function gatewayWatches(overrides: Record<string, unknown> = {}): Routes {
    return {
      [`${GATEWAY}/watched-payments`]: () =>
        jsonResponse(
          {
            id: "watch_0001",
            status: "pending",
            payment_hash: WATCH_HASH,
            verify_url: WATCH_VERIFY,
            preimage: null,
            expires_at: new Date(EXPIRES_AT * 1000).toISOString(),
            created_at: new Date(1_900_000_000 * 1000).toISOString(),
            ...overrides,
          },
          201,
        ),
    };
  }

  it("hands over a hash, a URL and an expiry, and deliberately nothing else", async () => {
    const calls = stubFetch(gatewayWatches());

    await new ThunderBridge(GATEWAY).watchPayment(watchable());

    expect(calls[0].url).toBe(`${GATEWAY}/watched-payments`);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      payment_hash: WATCH_HASH,
      verify_url: WATCH_VERIFY,
      expires_at: "2030-03-17T17:56:40.000Z",
    });
  });

  it("sends the trigger as a hash, so the watch secret never reaches the gateway", async () => {
    const calls = stubFetch(gatewayWatches());

    await new ThunderBridge(GATEWAY).watchPayment(watchable({ trigger: "the-overlay-holds-this" }));

    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(body["trigger"]).toBe(sha256Hex("the-overlay-holds-this"));
    expect(String(calls[0].init?.body)).not.toContain("the-overlay-holds-this");
  });

  it("refuses a trigger short enough to guess, because nothing rate limits a guess at it", async () => {
    stubFetch(gatewayWatches());

    await expect(
      new ThunderBridge(GATEWAY).watchPayment(watchable({ trigger: "shop1" })),
    ).rejects.toThrow(/at least 16 characters/);
  });

  it("passes a sealed blob through untouched, since only the watcher can read it", async () => {
    const calls = stubFetch(gatewayWatches());

    await new ThunderBridge(GATEWAY).watchPayment(watchable({ sealed: "v1.opaque" }));

    expect(JSON.parse(String(calls[0].init?.body))["sealed"]).toBe("v1.opaque");
  });

  it("reads back an event whose address and amount are null, because nobody was told them", async () => {
    stubFetch(gatewayWatches());

    const watched = await new ThunderBridge(GATEWAY).watchPayment(watchable());

    expect(watched).toEqual({
      id: "watch_0001",
      paymentHash: WATCH_HASH,
      verifyUrl: WATCH_VERIFY,
      status: "pending",
      preimage: null,
      expiresAt: EXPIRES_AT,
      createdAt: 1_900_000_000,
      sealed: null,
      lnAddress: null,
      amountMsat: null,
    });
  });

  it("carries the bearer on a private gateway", async () => {
    const calls = stubFetch(gatewayWatches());

    await new ThunderBridge(GATEWAY, { token: "only-mine" }).watchPayment(watchable());

    expect(headersOf(calls[0])["authorization"]).toBe("Bearer only-mine");
  });

  it("surfaces an already-watched hash as a branchable problem, not a generic failure", async () => {
    stubFetch({
      [`${GATEWAY}/watched-payments`]: () =>
        problemResponse(
          {
            type: "urn:problem-type:thunder-bridge:payment-already-watched",
            title: "This payment hash is already being watched here",
            status: 409,
          },
          409,
        ),
    });

    const rejection = await new ThunderBridge(GATEWAY)
      .watchPayment(watchable())
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(ProblemError);
    expect((rejection as ProblemError).type).toBe(PAYMENT_ALREADY_WATCHED);
    expect((rejection as ProblemError).status).toBe(409);
  });

  it("reports a 2xx body that is not a watched payment rather than handing back a half object", async () => {
    stubFetch({
      [`${GATEWAY}/watched-payments`]: () => jsonResponse({ id: "watch_0001" }, 201),
    });

    const rejection = await new ThunderBridge(GATEWAY)
      .watchPayment(watchable())
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(ProblemError);
    expect((rejection as ProblemError).title).toContain("not a watched payment");
  });

  it("refuses an expiry it cannot put on the wire, instead of throwing a bare RangeError", async () => {
    stubFetch(gatewayWatches());
    const gateway = new ThunderBridge(GATEWAY);

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 8.64e15]) {
      const rejection = await gateway
        .watchPayment(watchable({ expiresAt: bad }))
        .catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toMatch(/expiresAt/);
    }
  });
});

describe("the problem namespace after the rename", () => {
  it("leaves an error from the retired namespace as a plain problem", async () => {
    stubFetch({
      [`${GATEWAY}/incoming-payments`]: () =>
        problemResponse(
          {
            type: "urn:problem-type:thunder-bridge-direct:no-wallet-available",
            title: "No wallet could issue a provable invoice",
            wallets: [{ address: LN_ADDRESS, reason: "unreachable" }],
          },
          502,
        ),
    });

    const refused = await new ThunderBridge(GATEWAY)
      .createPayment({ lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT })
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ProblemError);
    expect(refused).not.toBeInstanceOf(NoWalletAvailableError);
    expect((refused as ProblemError).status).toBe(502);
  });

  it("types one emitting the new namespace, which is what the gateway sends now", async () => {
    stubFetch({
      [`${GATEWAY}/incoming-payments`]: () =>
        problemResponse(
          { type: NO_WALLET_AVAILABLE, title: "No wallet could issue a provable invoice" },
          502,
        ),
    });

    const refused = await new ThunderBridge(GATEWAY)
      .createPayment({ lnAddresses: [LN_ADDRESS], amountMsat: AMOUNT_MSAT })
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(NoWalletAvailableError);
  });

  it("leaves a foreign namespace as a plain problem", () => {
    expect(
      isProblemType(
        { type: "urn:problem-type:someone-else:no-wallet-available" },
        NO_WALLET_AVAILABLE,
      ),
    ).toBe(false);
  });
});

describe("a payment the gateway only watches", () => {
  const WATCHED = "watch_0001";
  const HASH = "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925";
  const PREIMAGE_FOR = "00".repeat(32);

  function blindWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: WATCHED,
      status: "pending",
      payment_hash: HASH,
      verify_url: "https://coinos.io/api/lnurl/verify/blind",
      preimage: null,
      expires_at: new Date(1_900_000_600 * 1000).toISOString(),
      created_at: new Date(1_900_000_000 * 1000).toISOString(),
      ...overrides,
    };
  }

  it("reads back with getWatched, which asks for no address and no invoice", async () => {
    stubFetch({ [`${GATEWAY}/incoming-payments/${WATCHED}`]: () => jsonResponse(blindWire()) });

    const watched = await new ThunderBridge(GATEWAY).getWatched(WATCHED);

    expect(watched?.id).toBe(WATCHED);
    expect(watched?.lnAddress).toBeNull();
    expect(watched?.amountMsat).toBeNull();
  });

  it("is null from getWatched when the gateway never heard of it", async () => {
    stubFetch({
      [`${GATEWAY}/incoming-payments/${WATCHED}`]: () =>
        problemResponse({ title: "Not Found" }, 404),
    });

    expect(await new ThunderBridge(GATEWAY).getWatched(WATCHED)).toBeNull();
  });

  it("refuses a settlement whose preimage does not hash to the payment hash", async () => {
    stubFetch({
      [`${GATEWAY}/incoming-payments/${WATCHED}`]: () =>
        jsonResponse(blindWire({ status: "paid", preimage: "11".repeat(32) })),
    });

    await expect(new ThunderBridge(GATEWAY).getWatched(WATCHED)).rejects.toBeInstanceOf(
      GatewayCheatError,
    );
  });

  it("sends getPayment to waitForWatched rather than answering nonsense", async () => {
    stubFetch({ [`${GATEWAY}/incoming-payments/${WATCHED}`]: () => jsonResponse(blindWire()) });

    await expect(new ThunderBridge(GATEWAY).getPayment(WATCHED)).rejects.toThrow(ProblemError);
  });

  it("settles on the socket through waitForWatched", async () => {
    const waiting = new ThunderBridge(GATEWAY).waitForWatched(WATCHED);

    theSocket().onmessage?.({
      data: JSON.stringify(blindWire({ status: "paid", preimage: PREIMAGE_FOR })),
    });

    const settled = await waiting;
    expect(settled.status).toBe("paid");
    expect(settled.preimage).toBe(PREIMAGE_FOR);
  });

  it("tells waitForPayment to use the other one, instead of a parse failure", async () => {
    const waiting = new ThunderBridge(GATEWAY).waitForPayment(WATCHED);

    theSocket().onmessage?.({ data: JSON.stringify(blindWire({ status: "expired" })) });

    await expect(waiting).rejects.toThrow("waitForWatched");
  });

  it("wins a two-rail race without an address or an invoice", async () => {
    const winning = new ThunderBridge(GATEWAY).firstToSettle([WATCHED, "ln_01"]);

    FakeSocket.opened[0].onmessage?.({
      data: JSON.stringify(blindWire({ status: "paid", preimage: PREIMAGE_FOR })),
    });

    const winner = await winning;
    expect(winner?.id).toBe(WATCHED);
    expect(winner?.preimage).toBe(PREIMAGE_FOR);
  });
});

describe("refusesStrangers", () => {
  const PROBE = `${GATEWAY}/incoming-payments/is-this-gateway-yours`;

  it("reads a refusal of an unauthenticated read as a gateway that is yours", async () => {
    stubFetch({ [PROBE]: () => problemResponse({}, 401) });

    expect(await new ThunderBridge(GATEWAY).refusesStrangers()).toBe(true);
  });

  it("reads anything else as open, so a made-up token cannot make an instance private", async () => {
    stubFetch({ [PROBE]: () => jsonResponse({}, 404) });

    expect(await new ThunderBridge(GATEWAY, { token: "wishful" }).refusesStrangers()).toBe(false);
  });

  it("counts an unreachable gateway as open, so the doubt fails closed", async () => {
    stubFetch({});

    expect(await new ThunderBridge(GATEWAY).refusesStrangers()).toBe(false);
  });

  it("asks once and remembers, because an instance does not change its mind", async () => {
    const calls = stubFetch({ [PROBE]: () => problemResponse({}, 401) });
    const gateway = new ThunderBridge(GATEWAY);

    await gateway.refusesStrangers();
    await gateway.refusesStrangers();

    expect(calls).toHaveLength(1);
  });
});
