import { afterEach, expect, test, vi } from "vitest";

import { jsonResponse, type Routes, stubFetch } from "../../sdk/test/harness.ts";
import { DEMO_GATEWAY, payMe } from "./main.ts";

const ENDPOINT = "https://shop.example.org/lnurlp/tips";
const SECRET = "a-long-lived-server-side-secret";
const LN_ADDRESS = "iamfatik@blink.sv";

function quoting(): Routes {
  return {
    [`${DEMO_GATEWAY}/quotes`]: () =>
      jsonResponse({
        ln_address: LN_ADDRESS,
        amount: { value: "21000", asset_code: "BTC", asset_scale: 11 },
        fee: { value: "0", asset_code: "BTC", asset_scale: 11 },
        min_amount: { value: "1000", asset_code: "BTC", asset_scale: 11 },
        max_amount: { value: "50000000000", asset_code: "BTC", asset_scale: 11 },
        metadata: JSON.stringify([["text/plain", "a tip for fatik"]]),
        refusals: [],
      }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("the endpoint answers a payRequest, and the range is what the payer gets to choose inside", async () => {
  stubFetch(quoting());
  const into = { innerHTML: "" };

  const handler = payMe(into, ENDPOINT, SECRET);
  const answer = await handler(new Request(ENDPOINT));
  const served = (await answer.json()) as Record<string, unknown>;

  expect(answer.status).toBe(200);
  expect(served.tag).toBe("payRequest");
  expect(served.minSendable).toBe(21_000);
  expect(served.maxSendable).toBe(210_000_000);
  expect(String(served.callback)).toContain(ENDPOINT);
});

test("the QR is drawn for your own url, not for the address behind it", () => {
  const into = { innerHTML: "" };

  payMe(into, ENDPOINT, SECRET);

  expect(into.innerHTML).toContain("<svg");
  expect(into.innerHTML).not.toContain(LN_ADDRESS);
});
