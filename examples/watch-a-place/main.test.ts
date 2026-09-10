import { createHash } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";

import { bolt11 } from "../../sdk/test/encode.ts";
import { watchAPlace } from "./main.ts";

const PREIMAGE = "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100";
const PAYMENT_HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");
const INVOICE = bolt11({ paymentHash: PAYMENT_HASH, amountMsat: 77_000 });

class FakeSocket {
  static readonly opened: FakeSocket[] = [];

  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalls = 0;

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }

  close(): void {
    this.closeCalls += 1;
  }
}

afterEach(() => {
  FakeSocket.opened.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("every settlement at the place is handed over, and the socket carries the secret", async () => {
  vi.stubGlobal("WebSocket", FakeSocket);
  const arrived: number[] = [];

  const stop = watchAPlace("a-second-weaker-key", (settled) => arrived.push(settled.amountMsat));
  await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(1));
  const socket = FakeSocket.opened[0] as FakeSocket;

  expect(socket.url).toContain("a-second-weaker-key");
  socket.onmessage?.({
    data: JSON.stringify({
      id: "pay_7f3a2c",
      kind: "minted",
      ln_address: "iamfatik@blink.sv",
      incoming_amount: { value: "77000", asset_code: "BTC", asset_scale: 11 },
      status: "paid",
      bolt11: INVOICE,
      payment_hash: PAYMENT_HASH,
      verify_url: "https://lnurl.blink.sv/verify/7f3a",
      preimage: PREIMAGE,
      expires_at: new Date(1_900_000_600 * 1000).toISOString(),
      created_at: new Date(1_900_000_000 * 1000).toISOString(),
    }),
  });

  expect(arrived).toEqual([77_000]);

  stop();

  expect(socket.closeCalls).toBeGreaterThan(0);
});
