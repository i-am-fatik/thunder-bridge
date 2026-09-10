import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { bolt11 } from "../../sdk/test/encode.ts";
import { jsonResponse, type Routes, stubFetch } from "../../sdk/test/harness.ts";
import { checkout, DEMO_GATEWAY } from "./main.ts";

const LN_ADDRESS = "iamfatik@blink.sv";
const WELL_KNOWN = "https://blink.sv/.well-known/lnurlp/iamfatik";
const CALLBACK = "https://blink.sv/lnurlp/iamfatik/callback";
const VERIFY_URL = "https://blink.sv/lnurlp/iamfatik/verify/7f3a";
const COINBASE = "https://api.coinbase.com/v2/prices/BTC-USD/spot";
const KRAKEN = "https://api.kraken.com/0/public/Ticker?pair=XBTUSD";
const AT_TWENTY_ONE_CENTS = 212_100;
const METADATA = JSON.stringify([["text/plain", "a coffee for fatik"]]);
const PREIMAGE = "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100";
const PAYMENT_HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");
const INVOICE = bolt11({
  paymentHash: PAYMENT_HASH,
  amountMsat: AT_TWENTY_ONE_CENTS,
  descriptionHash: createHash("sha256").update(METADATA, "utf8").digest("hex"),
});

function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pay_7f3a2c",
    ln_address: LN_ADDRESS,
    incoming_amount: {
      value: String(AT_TWENTY_ONE_CENTS),
      asset_code: "BTC",
      asset_scale: 11,
    },
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

function venuesAt(coinbaseUsd: string, krakenUsd: string): Routes {
  return {
    [COINBASE]: () => jsonResponse({ data: { amount: coinbaseUsd, currency: "USD" } }),
    [KRAKEN]: () => jsonResponse({ error: [], result: { XXBTZUSD: { c: [krakenUsd] } } }),
  };
}

function shop(overrides: Routes = {}): Routes {
  return {
    ...venuesAt("100000.00", "100000.00"),
    [`${DEMO_GATEWAY}/incoming-payments`]: () => jsonResponse(wire(), 201),
    [WELL_KNOWN]: () =>
      jsonResponse({
        tag: "payRequest",
        callback: CALLBACK,
        metadata: METADATA,
        minSendable: 1_000,
        maxSendable: 100_000_000_000,
      }),
    [VERIFY_URL]: () =>
      jsonResponse({ status: "OK", settled: true, preimage: PREIMAGE, pr: INVOICE }),
    ...overrides,
  };
}

class FakeSocket {
  static readonly opened: FakeSocket[] = [];

  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }

  close(): void {}
}

beforeEach(() => {
  FakeSocket.opened.length = 0;
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("21 cents is asked for as millisatoshi, at the median of the venues plus the spread", async () => {
  const calls = stubFetch(shop());
  const into = { innerHTML: "" };

  const settling = checkout(into);
  await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(1));
  const socket = FakeSocket.opened[0] as FakeSocket;
  socket.onmessage?.({ data: JSON.stringify(wire({ status: "paid", preimage: PREIMAGE })) });

  expect(await settling).toBe(PREIMAGE);

  const minted = calls.find(({ url }) => url.endsWith("/incoming-payments"));
  expect(JSON.parse(String(minted?.init?.body)).incoming_amount.value).toBe(
    String(AT_TWENTY_ONE_CENTS),
  );
});

test("venues further apart than the shop allows refuse the price, so nothing is minted", async () => {
  const calls = stubFetch(shop(venuesAt("100000.00", "101000.00")));
  const into = { innerHTML: "" };

  await expect(checkout(into)).rejects.toThrow(/spread|venues/);
  expect(calls.some(({ url }) => url.endsWith("/incoming-payments"))).toBe(false);
  expect(into.innerHTML).toBe("");
});
