import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sats } from "../src/amount";
import { ThunderBridge } from "../src/client";
import { bolt11 } from "./encode";
import { jsonResponse, type Routes, stubFetch } from "./harness";

const GATEWAY = "https://gateway.example.net";
const LN_ADDRESS = "alice@example.com";
const VERIFY_URL = "https://example.com/lnurl/verify/1a2b3c";
const AMOUNT_MSAT = 21_000;
const PREIMAGE = "11".repeat(32);
const PAYMENT_HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");
const METADATA = '[["text/plain","a coffee for alice"]]';
const INVOICE = bolt11({
  paymentHash: PAYMENT_HASH,
  amountMsat: AMOUNT_MSAT,
  descriptionHash: createHash("sha256").update(METADATA, "utf8").digest("hex"),
});

class FakeSocket {
  static readonly opened: FakeSocket[] = [];

  closeCalls = 0;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }

  close(): void {
    this.closeCalls += 1;
  }
}

function theSocket(): FakeSocket {
  expect(FakeSocket.opened).toHaveLength(1);

  return FakeSocket.opened[0] as FakeSocket;
}

function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pay_0001",
    ln_address: LN_ADDRESS,
    incoming_amount: { value: String(AMOUNT_MSAT), asset_code: "BTC", asset_scale: 11 },
    status: "pending",
    bolt11: INVOICE,
    payment_hash: PAYMENT_HASH,
    verify_url: VERIFY_URL,
    preimage: null,
    expires_at: new Date(1_900_000_600 * 1000).toISOString(),
    created_at: new Date(1_900_000_000 * 1000).toISOString(),
    ...overrides,
  };
}

function minting(): Routes {
  return { [`${GATEWAY}/incoming-payments`]: () => jsonResponse(wire(), 201) };
}

function selling(): ThunderBridge {
  return new ThunderBridge(GATEWAY, { verify: false });
}

beforeEach(() => {
  FakeSocket.opened.length = 0;
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sell", () => {
  it("hands back the invoice, its QR and everything a checkout page shows", async () => {
    stubFetch(minting());

    const sale = await selling().sell({ to: LN_ADDRESS, amount: sats(21) });

    expect(sale.id).toBe("pay_0001");
    expect(sale.bolt11).toBe(INVOICE);
    expect(sale.paymentHash).toBe(PAYMENT_HASH);
    expect(sale.lnAddress).toBe(LN_ADDRESS);
    expect(sale.amountMsat).toBe(AMOUNT_MSAT);
    expect(sale.expiresAt).toBe(1_900_000_600);
    expect(sale.qr.startsWith("<svg")).toBe(true);
  });

  it("takes one address as a string, so the common case is not a list of one", async () => {
    const calls = stubFetch(minting());

    await selling().sell({ to: LN_ADDRESS, amount: sats(21) });

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body["ln_addresses"]).toEqual([LN_ADDRESS]);
  });

  it("draws the QR at the size and colour the page asked for", async () => {
    stubFetch(minting());

    const sale = await selling().sell({
      to: LN_ADDRESS,
      amount: sats(21),
      qr: { size: 128, color: "#a8530c" },
    });

    expect(sale.qr).toContain('width="128"');
    expect(sale.qr).toContain("#a8530c");
  });

  it("resolves the wait once the money is proven to have arrived", async () => {
    stubFetch(minting());
    const sale = await selling().sell({ to: LN_ADDRESS, amount: sats(21) });

    const waiting = sale.paid();
    theSocket().onmessage?.({
      data: JSON.stringify(wire({ status: "paid", preimage: PREIMAGE })),
    });

    await expect(waiting).resolves.toMatchObject({ status: "paid", preimage: PREIMAGE });
  });

  it("rejects the wait when the invoice expires unpaid, rather than resolving a non-payment", async () => {
    stubFetch(minting());
    const sale = await selling().sell({ to: LN_ADDRESS, amount: sats(21) });

    const waiting = sale.paid();
    theSocket().onmessage?.({ data: JSON.stringify(wire({ status: "expired" })) });

    await expect(waiting).rejects.toThrow("ended expired");
  });

  it("calls back instead of awaiting, for a page with something else to do", async () => {
    stubFetch(minting());
    const sale = await selling().sell({ to: LN_ADDRESS, amount: sats(21) });
    const paid = vi.fn();

    sale.onPaid(paid);
    theSocket().onmessage?.({
      data: JSON.stringify(wire({ status: "paid", preimage: PREIMAGE })),
    });
    await vi.waitFor(() => expect(paid).toHaveBeenCalledTimes(1));

    expect(paid.mock.calls[0]?.[0]).toMatchObject({ preimage: PREIMAGE });
  });

  it("stops waiting when the returned function is called, and reports nothing after", async () => {
    stubFetch(minting());
    const sale = await selling().sell({ to: LN_ADDRESS, amount: sats(21) });
    const paid = vi.fn();
    const failed = vi.fn();

    const stop = sale.onPaid(paid, failed);
    stop();
    await vi.waitFor(() => expect(theSocket().closeCalls).toBe(1));

    expect(paid).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });
});

describe("sale.prove", () => {
  it("asks the recipient's own server rather than the gateway, and hands back its preimage", async () => {
    stubFetch({
      ...minting(),
      "https://example.com/.well-known/lnurlp/alice": () =>
        jsonResponse({
          tag: "payRequest",
          callback: "https://example.com/lnurl/pay/alice",
          metadata: METADATA,
          minSendable: 1_000,
          maxSendable: 100_000_000,
        }),
      [VERIFY_URL]: () => jsonResponse({ pr: INVOICE, settled: true, preimage: PREIMAGE }),
    });
    const sale = await selling().sell({ to: LN_ADDRESS, amount: sats(21) });

    await expect(sale.prove()).resolves.toBe(PREIMAGE);
  });
});
