import { msat } from "../src/amount";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThunderBridge } from "../src/client";
import { unseal } from "../../core/sealed.js";
import { ProblemError } from "../src/errors";
import {
  lnurlPayEndpoint,
  publicWatchTicketEndpoint,
  type Minted,
  type TriggerConfig,
  watchTicketEndpoint,
  type WatchTicketConfig,
} from "../src/trigger";
import { bolt11 } from "./encode";
import { jsonResponse, problemResponse, stubFetch, throughFetch, type FetchCall, type Routes } from "./harness";

const GATEWAY = "https://gateway.example.net";
const MOUNT = "https://tips.example.org/pay/coffee";
const WINNER = "alice@coinos.io";
const FALLBACK = "alice@getalby.com";
const METADATA = '[["text/plain","Paying alice@coinos.io"]]';
const OTHER_METADATA = '[["text/plain","Paying alice@getalby.com"]]';
const AMOUNT_MSAT = 21_000;
const PAYMENT_HASH = "ab".repeat(32);
const SECRET = "keep-me-server-side";
const SEALING_SECRET = "s".repeat(32);

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const INVOICE = bolt11({
  paymentHash: PAYMENT_HASH,
  amountMsat: AMOUNT_MSAT,
  descriptionHash: sha256Hex(METADATA),
});

function amount(msat: number): Record<string, unknown> {
  return { value: String(msat), asset_code: "BTC", asset_scale: 11 };
}

function gatewayServing(overrides: Record<string, unknown> = {}): Routes {
  return {
    [`${GATEWAY}/quotes`]: () =>
      jsonResponse({
        ln_address: WINNER,
        amount: amount(AMOUNT_MSAT),
        fee: amount(0),
        min_amount: amount(1_000),
        max_amount: amount(100_000_000),
        metadata: METADATA,
        refusals: [{ address: FALLBACK, reason: "unreachable" }],
        ...overrides,
      }),
    [`${GATEWAY}/incoming-payments`]: () =>
      jsonResponse(
        {
          id: "pay_0001",
          ln_address: WINNER,
          incoming_amount: amount(AMOUNT_MSAT),
          status: "pending",
          bolt11: INVOICE,
          payment_hash: PAYMENT_HASH,
          verify_url: "https://coinos.io/api/lnurl/verify/1a2b",
          preimage: null,
          expires_at: new Date(1_900_000_600 * 1000).toISOString(),
          created_at: new Date(1_900_000_000 * 1000).toISOString(),
        },
        201,
      ),
  };
}

function endpoint(overrides: Partial<TriggerConfig> = {}) {
  return lnurlPayEndpoint(new ThunderBridge(GATEWAY, { verify: false }), {
    send: throughFetch,
    paidTo: [FALLBACK, WINNER],
    amount: () => msat(AMOUNT_MSAT),
    secret: SECRET,
    ...overrides,
  });
}

async function payRequest(handler: (request: Request) => Promise<Response>) {
  const response = await handler(new Request(MOUNT));
  return (await response.json()) as Record<string, string & number>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the payRequest half", () => {
  it("answers the five fields LUD-06 requires, with the price fixed by min equal to max", async () => {
    stubFetch(gatewayServing());

    const offer = await payRequest(endpoint());

    expect(offer["tag"]).toBe("payRequest");
    expect(offer["metadata"]).toBe(METADATA);
    expect(offer["minSendable"]).toBe(AMOUNT_MSAT);
    expect(offer["maxSendable"]).toBe(AMOUNT_MSAT);
    expect(String(offer["callback"]).startsWith(MOUNT)).toBe(true);
  });

  it("serves the winner's metadata verbatim, never the fallback's", async () => {
    stubFetch(gatewayServing({ metadata: METADATA }));

    const offer = await payRequest(endpoint());

    expect(offer["metadata"]).toBe(METADATA);
    expect(offer["metadata"]).not.toBe(OTHER_METADATA);
  });

  it("pins the quoted winner into the callback so the callback cannot pick another", async () => {
    stubFetch(gatewayServing());

    const callback = new URL((await payRequest(endpoint())).callback);

    expect(callback.searchParams.get("to")).toBe(WINNER);
    expect(callback.searchParams.get("least")).toBe(String(AMOUNT_MSAT));
    expect(callback.searchParams.get("most")).toBe(String(AMOUNT_MSAT));
    expect(callback.searchParams.get("sig")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("calls the price function once per payRequest, so a fiat peg can move between them", async () => {
    stubFetch(gatewayServing());
    const prices = [21_000, 42_000];
    const handler = endpoint({ amount: () => msat(prices.shift() ?? 1) });

    expect((await payRequest(handler))["minSendable"]).toBe(21_000);
    expect((await payRequest(handler))["minSendable"]).toBe(42_000);
  });

  it("mints nothing, so a wallet that walks away costs the recipient nothing", async () => {
    const calls = stubFetch(gatewayServing());

    await payRequest(endpoint());

    expect(calls.map((call) => call.url)).toEqual([`${GATEWAY}/quotes`]);
  });

  it("uses the configured base URL when a proxy hides the public one", async () => {
    stubFetch(gatewayServing());

    const offer = await payRequest(endpoint({ baseUrl: "https://public.example/lnurl" }));

    expect(String(offer["callback"]).startsWith("https://public.example/lnurl?")).toBe(true);
  });
});

describe("the callback half", () => {
  async function callbackFor(handler: (request: Request) => Promise<Response>): Promise<URL> {
    return new URL((await payRequest(handler)).callback);
  }

  it("returns the invoice with the empty routes array LUD-06 requires and the LUD-21 verify URL", async () => {
    stubFetch(gatewayServing());
    const handler = endpoint();
    const callback = await callbackFor(handler);

    const minted = (await (await handler(new Request(callback))).json()) as Record<string, unknown>;

    expect(minted["pr"]).toBe(INVOICE);
    expect(minted["routes"]).toEqual([]);
    expect(minted["verify"]).toBe("https://coinos.io/api/lnurl/verify/1a2b");
    expect(minted["status"]).toBe("OK");
  });

  it("binds the invoice to the metadata already served, which is what LUD-06 makes the wallet check", async () => {
    stubFetch(gatewayServing());
    const handler = endpoint();

    const offer = await payRequest(handler);
    const minted = (await (
      await handler(new Request(offer.callback))
    ).json()) as Record<string, string>;

    const { decodeInvoice } = await import("../../core/bolt11.js");
    expect(decodeInvoice(minted["pr"]!).descriptionHash).toBe(sha256Hex(offer["metadata"]!));
  });

  it("mints against the pinned address alone, never against the whole list again", async () => {
    const calls = stubFetch(gatewayServing());
    const handler = endpoint();
    const callback = await callbackFor(handler);

    await handler(new Request(callback));

    const body = JSON.parse(String(calls[1]!.init?.body)) as Record<string, unknown>;
    expect(body["ln_addresses"]).toEqual([WINNER]);
  });

  it("reuses the nonce as the idempotency key, so a wallet retry does not mint twice", async () => {
    const calls = stubFetch(gatewayServing());
    const handler = endpoint();
    const callback = await callbackFor(handler);

    await handler(new Request(callback));

    const headers = calls[1]!.init?.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe(callback.searchParams.get("n"));
  });

  it("carries the watch secret to the gateway as a hash, never in the clear", async () => {
    const calls = stubFetch(gatewayServing());
    const handler = endpoint({ watchSecret: "the-overlay-holds-this" });
    const callback = await callbackFor(handler);

    await handler(new Request(callback));

    const body = JSON.parse(String(calls[1]!.init?.body)) as Record<string, unknown>;
    expect(body["trigger"]).toBe(sha256Hex("the-overlay-holds-this"));
    expect(JSON.stringify(body)).not.toContain("the-overlay-holds-this");
  });

  it("asks the gateway to keep as many settlements as the place was built with", async () => {
    const calls = stubFetch(gatewayServing());
    const handler = endpoint({ watchSecret: "the-overlay-holds-this", replay: 10 });
    const callback = await callbackFor(handler);

    await handler(new Request(callback));

    const body = JSON.parse(String(calls[1]!.init?.body)) as Record<string, unknown>;
    expect(body["replay"]).toBe(10);
  });

  it("asks for nothing to be kept unless told, which is what the gateway does anyway", async () => {
    const calls = stubFetch(gatewayServing());
    const handler = endpoint({ watchSecret: "the-overlay-holds-this" });

    await handler(new Request(await callbackFor(handler)));

    expect(JSON.parse(String(calls[1]!.init?.body))).not.toHaveProperty("replay");
  });

  it("refuses a swapped recipient, so nobody can mint on a wallet of their choosing", async () => {
    stubFetch(gatewayServing());
    const handler = endpoint();
    const callback = await callbackFor(handler);
    callback.searchParams.set("to", "attacker@example.com");

    const refused = (await (await handler(new Request(callback))).json()) as Record<string, string>;

    expect(refused["status"]).toBe("ERROR");
    expect(refused["reason"]).toContain("not signed here");
  });

  it("refuses a raised amount", async () => {
    stubFetch(gatewayServing());
    const handler = endpoint();
    const callback = await callbackFor(handler);
    callback.searchParams.set("most", "100000000");

    const refused = (await (await handler(new Request(callback))).json()) as Record<string, string>;

    expect(refused["status"]).toBe("ERROR");
  });

  it("refuses a wallet that asks to pay something other than the fixed price", async () => {
    stubFetch(gatewayServing());
    const handler = endpoint();
    const callback = await callbackFor(handler);
    callback.searchParams.set("amount", "1000");

    const refused = (await (await handler(new Request(callback))).json()) as Record<string, string>;

    expect(refused["status"]).toBe("ERROR");
    expect(refused["reason"]).toContain(`exactly ${AMOUNT_MSAT}`);
  });

  it("accepts the wallet echoing back the exact amount it was told", async () => {
    stubFetch(gatewayServing());
    const handler = endpoint();
    const callback = await callbackFor(handler);
    callback.searchParams.set("amount", String(AMOUNT_MSAT));

    const minted = (await (await handler(new Request(callback))).json()) as Record<string, unknown>;

    expect(minted["pr"]).toBe(INVOICE);
  });
});

describe("the blind half, where the gateway is told nothing worth censoring on", () => {
  const CALLBACK = "https://coinos.io/lnurl/pay/alice";
  const VERIFY = "https://coinos.io/lnurl/verify/blind";

  function recipientAndBlindGateway(): Routes {
    return {
      [`${GATEWAY}/quotes`]: () =>
        jsonResponse({
          ln_address: WINNER,
          amount: amount(AMOUNT_MSAT),
          fee: amount(0),
          min_amount: amount(1_000),
          max_amount: amount(100_000_000),
          metadata: METADATA,
          refusals: [],
        }),
      "https://coinos.io/.well-known/lnurlp/alice": () =>
        jsonResponse({
          tag: "payRequest",
          callback: CALLBACK,
          metadata: METADATA,
          minSendable: 1_000,
          maxSendable: 100_000_000,
        }),
      [`${CALLBACK}?amount=${AMOUNT_MSAT}`]: () => jsonResponse({ pr: INVOICE, verify: VERIFY }),
      [`${GATEWAY}/watched-payments`]: () =>
        jsonResponse(
          {
            id: "watch_0001",
            status: "pending",
            payment_hash: PAYMENT_HASH,
            verify_url: VERIFY,
            preimage: null,
            expires_at: new Date(1_900_000_600 * 1000).toISOString(),
            created_at: new Date(1_900_000_000 * 1000).toISOString(),
          },
          201,
        ),
    };
  }

  it("hands the gateway a hash and a URL, and never the address or the amount", async () => {
    const calls = stubFetch(recipientAndBlindGateway());
    const handler = endpoint({ blind: true });

    const offer = await payRequest(handler);
    const minted = (await (
      await handler(new Request(offer.callback))
    ).json()) as Record<string, string>;

    expect(minted["pr"]).toBe(INVOICE);
    const watch = calls.find((call) => call.url === `${GATEWAY}/watched-payments`);
    const body = JSON.parse(String(watch?.init?.body)) as Record<string, unknown>;
    expect(body["payment_hash"]).toBe(PAYMENT_HASH);
    expect(body["verify_url"]).toBe(VERIFY);
    expect(body).not.toHaveProperty("ln_addresses");
    expect(body).not.toHaveProperty("incoming_amount");
    expect(JSON.stringify(body)).not.toContain(WINNER);
    expect(JSON.stringify(body)).not.toContain(String(AMOUNT_MSAT));
  });

  it("asks the blind watch to keep settlements too, since the socket is the same either way", async () => {
    const calls = stubFetch(recipientAndBlindGateway());
    const handler = endpoint({ blind: true, watchSecret: "the-overlay-holds-this", replay: 10 });

    await handler(new Request((await payRequest(handler)).callback));

    const watch = calls.find((call) => call.url === `${GATEWAY}/watched-payments`);
    const body = JSON.parse(String(watch?.init?.body)) as Record<string, unknown>;
    expect(body["replay"]).toBe(10);
  });

  it("never asks the gateway to mint, so the gateway never sees the callback either", async () => {
    const calls = stubFetch(recipientAndBlindGateway());
    const handler = endpoint({ blind: true });

    await handler(new Request((await payRequest(handler)).callback));

    expect(calls.map((call) => call.url)).not.toContain(`${GATEWAY}/incoming-payments`);
  });

  it("encrypts what the watcher needs, so the gateway is handed nothing readable", async () => {
    const calls = stubFetch(recipientAndBlindGateway());
    const handler = endpoint({
      blind: true,
      sealed: {
        secret: SEALING_SECRET,
        data: (minted: Minted) => ({ amountMsat: minted.amountMsat, lnAddress: minted.lnAddress }),
      },
    });

    await handler(new Request((await payRequest(handler)).callback));

    const watch = calls.find((call) => call.url === `${GATEWAY}/watched-payments`);
    const body = JSON.parse(String(watch?.init?.body)) as Record<string, unknown>;
    const sealed = String(body["sealed"]);

    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain(String(AMOUNT_MSAT));
    expect(sealed).not.toContain(WINNER);
    expect(JSON.stringify(body)).not.toContain(String(AMOUNT_MSAT));
    expect(JSON.stringify(body)).not.toContain(WINNER);
  });

  it("hands the watcher back exactly what was sealed, and nobody else", async () => {
    const calls = stubFetch(recipientAndBlindGateway());
    const handler = endpoint({
      blind: true,
      sealed: { secret: SEALING_SECRET, data: (minted: Minted) => ({ amountMsat: minted.amountMsat }) },
    });

    await handler(new Request((await payRequest(handler)).callback));

    const watch = calls.find((call) => call.url === `${GATEWAY}/watched-payments`);
    const sealed = String((JSON.parse(String(watch?.init?.body)) as Record<string, unknown>)["sealed"]);

    expect(JSON.parse((await unseal(SEALING_SECRET, sealed)) ?? "null")).toEqual({
      amountMsat: AMOUNT_MSAT,
    });
    expect(await unseal("z".repeat(32), sealed)).toBeNull();
  });

  it("survives a gateway that says the invoice is already watched, and still serves it", async () => {
    stubFetch({
      ...recipientAndBlindGateway(),
      [`${GATEWAY}/watched-payments`]: () =>
        new Response(
          JSON.stringify({
            type: "urn:problem-type:thunder-bridge:payment-already-watched",
            title: "This payment hash is already being watched here",
            status: 409,
          }),
          { status: 409, headers: { "content-type": "application/problem+json" } },
        ),
    });
    const handler = endpoint({ blind: true });

    const offer = await payRequest(handler);
    const minted = (await (
      await handler(new Request(offer.callback))
    ).json()) as Record<string, unknown>;

    expect(minted["pr"]).toBe(INVOICE);
    expect(minted["status"]).toBe("OK");
  });

  it("does not swallow any other refusal from the gateway", async () => {
    stubFetch({
      ...recipientAndBlindGateway(),
      [`${GATEWAY}/watched-payments`]: () =>
        new Response(JSON.stringify({ title: "Unauthorized", status: 401 }), {
          status: 401,
          headers: { "content-type": "application/problem+json" },
        }),
    });
    const handler = endpoint({ blind: true });

    const offer = await payRequest(handler);
    const answer = (await (
      await handler(new Request(offer.callback))
    ).json()) as Record<string, string>;

    expect(answer["status"]).toBe("ERROR");
    expect(answer["pr"]).toBeUndefined();
  });

  it("still refuses an unsigned callback before resolving anything", async () => {
    const calls = stubFetch(recipientAndBlindGateway());
    const handler = endpoint({ blind: true });
    const callback = new URL((await payRequest(handler)).callback);
    callback.searchParams.set("to", "attacker@example.com");

    const refused = (await (await handler(new Request(callback))).json()) as Record<string, string>;

    expect(refused["status"]).toBe("ERROR");
    expect(calls.map((call) => call.url)).not.toContain(`${GATEWAY}/watched-payments`);
  });
});

describe("the binding finding 1 is about", () => {
  it("refuses to hand out an invoice bound to metadata other than the one it served", async () => {
    const fallbackInvoice = bolt11({
      paymentHash: PAYMENT_HASH,
      amountMsat: AMOUNT_MSAT,
      descriptionHash: sha256Hex(OTHER_METADATA),
    });
    stubFetch({
      ...gatewayServing(),
      [`${GATEWAY}/incoming-payments`]: () =>
        jsonResponse(
          {
            id: "pay_0002",
            ln_address: WINNER,
            incoming_amount: amount(AMOUNT_MSAT),
            status: "pending",
            bolt11: fallbackInvoice,
            payment_hash: PAYMENT_HASH,
            verify_url: "https://coinos.io/lnurl/verify/1a2b",
            preimage: null,
            expires_at: new Date(1_900_000_600 * 1000).toISOString(),
            created_at: new Date(1_900_000_000 * 1000).toISOString(),
          },
          201,
        ),
      "https://coinos.io/.well-known/lnurlp/alice": () =>
        jsonResponse({
          callback: "https://coinos.io/lnurl/pay/alice",
          metadata: METADATA,
          minSendable: 1_000,
          maxSendable: 100_000_000,
          tag: "payRequest",
        }),
      "https://coinos.io/lnurl/verify/1a2b": () =>
        jsonResponse({ status: "OK", settled: false, preimage: null, pr: fallbackInvoice }),
    });

    const handler = lnurlPayEndpoint(new ThunderBridge(GATEWAY), {
    send: throughFetch,
      paidTo: [FALLBACK, WINNER],
      amount: () => msat(AMOUNT_MSAT),
      secret: SECRET,
    });
    const offer = await payRequest(handler);
    const answer = (await (
      await handler(new Request(offer.callback))
    ).json()) as Record<string, string>;

    expect(answer["status"]).toBe("ERROR");
    expect(answer["pr"]).toBeUndefined();
  });
});

describe("what a wallet is told when it cannot be served", () => {
  it("reports an LNURL error document rather than throwing at the wallet", async () => {
    stubFetch({
      [`${GATEWAY}/quotes`]: () =>
        new Response(
          JSON.stringify({
            type: "urn:problem-type:thunder-bridge:no-wallet-available",
            title: "No wallet would take this amount",
            status: 400,
            wallets: [],
          }),
          { status: 400, headers: { "content-type": "application/problem+json" } },
        ),
    });

    const refused = await payRequest(endpoint());

    expect(refused["status"]).toBe("ERROR");
    expect(typeof refused["reason"]).toBe("string");
  });
});

describe("the watch ticket endpoints, which trade the secret for a pass that expires", () => {
  const WATCH_SECRET = "the-board-holds-this";
  const TOKEN = "only-the-endpoint-holds-this";
  const TICKET = "2.t.abc.1900000060.ff.10.mac";
  const EXPIRES_AT = "2030-03-08T19:07:40.000Z";

  function minting(routes: Routes = {}): FetchCall[] {
    return stubFetch({
      [`${GATEWAY}/ws-tickets`]: () => jsonResponse({ ticket: TICKET, expires_at: EXPIRES_AT }),
      ...routes,
    });
  }

  function asking(secret?: string): Request {
    return new Request(`${MOUNT}/ticket`, {
      method: "POST",
      body: secret === undefined ? "" : JSON.stringify({ secret }),
    });
  }

  function owner(): ThunderBridge {
    return new ThunderBridge(GATEWAY, { token: TOKEN, verify: false });
  }

  function board(replay?: number): WatchTicketConfig {
    return { watchSecret: WATCH_SECRET, replay };
  }

  it("hands back the gateway's own ticket and expiry when the secret is right", async () => {
    minting();

    const answer = await watchTicketEndpoint(owner(), board())(asking(WATCH_SECRET));

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ticket: TICKET, expires_at: EXPIRES_AT });
  });

  it("refuses a wrong secret and a body with none, without troubling the gateway", async () => {
    const calls = minting();

    expect((await watchTicketEndpoint(owner(), board())(asking("nearly-the-one"))).status).toBe(403);
    expect((await watchTicketEndpoint(owner(), board())(asking())).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("mints for a caller offering nothing when the board is public", async () => {
    minting();

    const answer = await publicWatchTicketEndpoint(owner(), board())(asking());

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ticket: TICKET, expires_at: EXPIRES_AT });
  });

  it("mints for a wrong secret when the board is public, because it reads no body", async () => {
    minting();

    const answer = await publicWatchTicketEndpoint(owner(), board())(asking("nearly-the-one"));

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ticket: TICKET, expires_at: EXPIRES_AT });
  });

  it("refuses a gateway that says no, and one that says yes without a ticket", async () => {
    minting({ [`${GATEWAY}/ws-tickets`]: () => problemResponse({ title: "Unauthorized" }, 401) });

    await expect(watchTicketEndpoint(owner(), board())(asking(WATCH_SECRET))).rejects.toThrow(ProblemError);

    minting({ [`${GATEWAY}/ws-tickets`]: () => jsonResponse({ ticket: TICKET }) });

    await expect(watchTicketEndpoint(owner(), board())(asking(WATCH_SECRET))).rejects.toThrow(
      /not a ticket/,
    );
  });

  it("asks the gateway for a replay depth only when one was configured", async () => {
    const asked = minting();
    await publicWatchTicketEndpoint(owner(), board(25))(asking());

    expect(JSON.parse(String(asked[0]?.init?.body))).toEqual({
      trigger_secret: WATCH_SECRET,
      replay: 25,
    });

    const bare = minting();
    await publicWatchTicketEndpoint(owner(), board())(asking());

    expect(JSON.parse(String(bare[0]?.init?.body))).toEqual({ trigger_secret: WATCH_SECRET });
  });
});

describe("a trigger a payer chooses the amount on", () => {
  async function callbackFor(handler: (request: Request) => Promise<Response>): Promise<URL> {
    return new URL((await payRequest(handler)).callback);
  }

  function jar(least: number, most: number) {
    return lnurlPayEndpoint(new ThunderBridge(GATEWAY, { verify: false }), {
    send: throughFetch,
      paidTo: [FALLBACK, WINNER],
      amount: { least: msat(least), most: msat(most) },
      secret: SECRET,
    });
  }

  it("offers the range rather than one price, so a wallet shows a field to type in", async () => {
    stubFetch(gatewayServing());

    const offer = await payRequest(jar(1_000, 1_000_000));

    expect(offer["minSendable"]).toBe(1_000);
    expect(offer["maxSendable"]).toBe(1_000_000);
  });

  it("mints exactly what the payer asked for inside the range", async () => {
    const calls = stubFetch(gatewayServing());
    const handler = jar(1_000, 1_000_000);
    const callback = await callbackFor(handler);
    callback.searchParams.set("amount", "50000");

    const answer = (await (await handler(new Request(callback))).json()) as Record<string, string>;

    expect(answer["status"]).toBe("OK");
    const minted = calls.find((call) => call.url === `${GATEWAY}/incoming-payments`);
    const body = JSON.parse(String(minted?.init?.body)) as Record<string, { value?: string }>;
    expect(body["incoming_amount"]?.value).toBe("50000");
  });

  it("refuses an amount under the floor and over the ceiling, naming the range", async () => {
    stubFetch(gatewayServing());
    const handler = jar(1_000, 1_000_000);

    for (const asked of ["999", "1000001"]) {
      const callback = await callbackFor(handler);
      callback.searchParams.set("amount", asked);
      const refused = (await (await handler(new Request(callback))).json()) as Record<
        string,
        string
      >;

      expect(refused["status"]).toBe("ERROR");
      expect(refused["reason"]).toContain("between 1000 and 1000000");
    }
  });

  it("takes the floor when a wallet names no amount at all", async () => {
    const calls = stubFetch(gatewayServing());
    const handler = jar(1_000, 1_000_000);

    await handler(new Request(await callbackFor(handler)));

    const minted = calls.find((call) => call.url === `${GATEWAY}/incoming-payments`);
    const body = JSON.parse(String(minted?.init?.body)) as Record<string, { value?: string }>;
    expect(body["incoming_amount"]?.value).toBe("1000");
  });

  it("refuses a range that ends below where it starts, rather than serving nonsense", async () => {
    stubFetch(gatewayServing());

    const offer = await payRequest(jar(1_000_000, 1_000));

    expect(offer["status"]).toBe("ERROR");
    expect(offer["reason"]).toContain("cannot end at 1000 msat when it starts at 1000000");
  });
});
