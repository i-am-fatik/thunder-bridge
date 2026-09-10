import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { bolt11 } from "../../sdk/test/encode.ts";
import { jsonResponse, type Routes, stubFetch } from "../../sdk/test/harness.ts";
import { DEMO_GATEWAY, resumeAWait } from "./main.ts";

const ID = "pay_7f3a2c";
const LN_ADDRESS = "iamfatik@blink.sv";
const WELL_KNOWN = "https://blink.sv/.well-known/lnurlp/iamfatik";
const CALLBACK = "https://blink.sv/lnurlp/iamfatik/callback";
const VERIFY_URL = "https://blink.sv/lnurlp/iamfatik/verify/7f3a";
const AMOUNT_MSAT = 21_000;
const METADATA = JSON.stringify([["text/plain", "a tip for fatik"]]);
const PREIMAGE = "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100";
const PAYMENT_HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");
const INVOICE = bolt11({
  paymentHash: PAYMENT_HASH,
  amountMsat: AMOUNT_MSAT,
  descriptionHash: createHash("sha256").update(METADATA, "utf8").digest("hex"),
});

function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
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

function remembering(overrides: Routes = {}): Routes {
  return {
    [`${DEMO_GATEWAY}/incoming-payments/${ID}`]: () => jsonResponse(wire()),
    [WELL_KNOWN]: () =>
      jsonResponse({
        tag: "payRequest",
        callback: CALLBACK,
        metadata: METADATA,
        minSendable: 1_000,
        maxSendable: 100_000_000,
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

test("the id alone redraws the QR and picks the wait back up", async () => {
  stubFetch(remembering());
  const into = { innerHTML: "" };

  const settling = resumeAWait(into, ID);
  await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(1));

  expect(into.innerHTML).toContain("<svg");
  expect(FakeSocket.opened[0]?.url).toContain(ID);

  const socket = FakeSocket.opened[0] as FakeSocket;
  socket.onmessage?.({ data: JSON.stringify(wire({ status: "paid", preimage: PREIMAGE })) });

  expect(await settling).toBe(PREIMAGE);
});

test("a payment the gateway never heard of is refused before any socket opens", async () => {
  stubFetch({ [`${DEMO_GATEWAY}/incoming-payments/${ID}`]: () => jsonResponse(null, 404) });
  const into = { innerHTML: "" };

  await expect(resumeAWait(into, ID)).rejects.toThrow("is not an invoice this gateway minted");
  expect(FakeSocket.opened).toHaveLength(0);
  expect(into.innerHTML).toBe("");
});
