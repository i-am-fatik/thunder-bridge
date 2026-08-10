import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Payment } from "../src/types";
import {
  parseWatchedWebhook,
  parseWatchedWebhookRequest,
  parseWebhook,
  parseWebhookRequest,
  verifyWebhookSignature,
} from "../src/webhook";

const SECRET = "whsec_bd41a4f0c8e94d0fa1b7";
const OTHER_SECRET = "whsec_0000000000000000ffff";

const PAYMENT: Payment = {
  id: "pay_7f3c9d21",
  lnAddress: "i_am_fatik@btcpay.3d3d.cz",
  amountMsat: 21000000,
  status: "paid",
  paymentHash: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  bolt11: "lnbc210000n1pjfillerinvoice",
  preimage: "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
  expiresAt: 1754000600,
  createdAt: 1753999999,
  verifyUrl: "https://btcpay.3d3d.cz/lnurlp/verify/7f3c9d21",
};

const BODY = JSON.stringify({
  id: PAYMENT.id,
  ln_address: PAYMENT.lnAddress,
  incoming_amount: { value: String(PAYMENT.amountMsat), asset_code: "BTC", asset_scale: 11 },
  status: PAYMENT.status,
  bolt11: PAYMENT.bolt11,
  payment_hash: PAYMENT.paymentHash,
  verify_url: PAYMENT.verifyUrl,
  preimage: PAYMENT.preimage,
  expires_at: new Date(PAYMENT.expiresAt * 1000).toISOString(),
  created_at: new Date(PAYMENT.createdAt * 1000).toISOString(),
});

function now(): string {
  return String(Math.floor(Date.now() / 1000));
}

function hmacHex(body: string, secret: string, timestamp: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

function header(body: string, secret: string, timestamp: string): string {
  return `sha256=${hmacHex(body, secret, timestamp)}`;
}

describe("verifyWebhookSignature", () => {
  it("accepts the signature the gateway sends, carrying its sha256= prefix", async () => {
    const stamp = now();
    await expect(
      verifyWebhookSignature(BODY, header(BODY, SECRET, stamp), SECRET, stamp),
    ).resolves.toBe(true);
  });

  it("accepts the same signature with the sha256= prefix stripped off", async () => {
    const stamp = now();
    await expect(
      verifyWebhookSignature(BODY, hmacHex(BODY, SECRET, stamp), SECRET, stamp),
    ).resolves.toBe(true);
  });

  it("accepts a signature whose hex digits arrived uppercased", async () => {
    const stamp = now();
    const upper = `sha256=${hmacHex(BODY, SECRET, stamp).toUpperCase()}`;
    await expect(verifyWebhookSignature(BODY, upper, SECRET, stamp)).resolves.toBe(true);
  });

  it("rejects a body tampered with by a single byte", async () => {
    const stamp = now();
    const tampered = BODY.replace('"value":"21000000"', '"value":"21000001"');
    await expect(
      verifyWebhookSignature(tampered, header(BODY, SECRET, stamp), SECRET, stamp),
    ).resolves.toBe(false);
  });

  it("rejects a signature computed under a different secret", async () => {
    const stamp = now();
    await expect(
      verifyWebhookSignature(BODY, header(BODY, OTHER_SECRET, stamp), SECRET, stamp),
    ).resolves.toBe(false);
  });

  it("rejects a replay of a body and signature captured long enough ago", async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    await expect(
      verifyWebhookSignature(BODY, header(BODY, SECRET, stale), SECRET, stale),
    ).resolves.toBe(false);
  });

  it("accepts that same old delivery when the caller widens the tolerance", async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    await expect(
      verifyWebhookSignature(BODY, header(BODY, SECRET, stale), SECRET, stale, {
        toleranceSecs: 7200,
      }),
    ).resolves.toBe(true);
  });

  it("rejects a signature lifted onto a different timestamp", async () => {
    const stamp = now();
    const moved = String(Number(stamp) - 60);
    await expect(
      verifyWebhookSignature(BODY, header(BODY, SECRET, stamp), SECRET, moved),
    ).resolves.toBe(false);
  });

  it("rejects a timestamp that is not a number at all", async () => {
    const stamp = now();
    await expect(
      verifyWebhookSignature(BODY, header(BODY, SECRET, stamp), SECRET, "yesterday"),
    ).resolves.toBe(false);
  });

  it("returns false instead of throwing when the signature is truncated", async () => {
    const stamp = now();
    const cut = `sha256=${hmacHex(BODY, SECRET, stamp).slice(0, 40)}`;
    await expect(verifyWebhookSignature(BODY, cut, SECRET, stamp)).resolves.toBe(false);
  });

  it("returns false instead of throwing when the signature is longer than a sha256 digest", async () => {
    const stamp = now();
    const long = `sha256=${hmacHex(BODY, SECRET, stamp)}deadbeef`;
    await expect(verifyWebhookSignature(BODY, long, SECRET, stamp)).resolves.toBe(false);
  });

  it("verifies a Uint8Array body exactly as it verifies the same bytes as a string", async () => {
    const stamp = now();
    const signature = header(BODY, SECRET, stamp);
    const bytes = new TextEncoder().encode(BODY);
    await expect(verifyWebhookSignature(bytes, signature, SECRET, stamp)).resolves.toBe(true);
    await expect(verifyWebhookSignature(bytes, signature, OTHER_SECRET, stamp)).resolves.toBe(
      false,
    );
  });
});

describe("parseWebhook", () => {
  it("returns the parsed payment when the signature holds", async () => {
    const stamp = now();
    await expect(parseWebhook(BODY, header(BODY, SECRET, stamp), SECRET, stamp)).resolves.toEqual(
      PAYMENT,
    );
  });

  it("returns null and never parses the body when the signature does not hold", async () => {
    const stamp = now();
    await expect(
      parseWebhook(BODY, header(BODY, OTHER_SECRET, stamp), SECRET, stamp),
    ).resolves.toBeNull();
  });
});

describe("parseWebhookRequest", () => {
  it("reads the signature and timestamp headers off a Fetch API Request", async () => {
    const stamp = now();
    const request = new Request("https://app.example.com/hooks/thunder-bridge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature": header(BODY, SECRET, stamp),
        "x-timestamp": stamp,
      },
      body: BODY,
    });
    await expect(parseWebhookRequest(request, SECRET)).resolves.toEqual(PAYMENT);
  });

  it("returns null when the request carries no x-signature header at all", async () => {
    const request = new Request("https://app.example.com/hooks/thunder-bridge", {
      method: "POST",
      headers: { "content-type": "application/json", "x-timestamp": now() },
      body: BODY,
    });
    await expect(parseWebhookRequest(request, SECRET)).resolves.toBeNull();
  });

  it("returns null when the request carries no x-timestamp header at all", async () => {
    const stamp = now();
    const request = new Request("https://app.example.com/hooks/thunder-bridge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature": header(BODY, SECRET, stamp),
      },
      body: BODY,
    });
    await expect(parseWebhookRequest(request, SECRET)).resolves.toBeNull();
  });
});

describe("a bank transfer's webhook, which names no address, amount or invoice", () => {
  const WATCHED = JSON.stringify({
    id: "9500f6c684d69021968e8d3f98536812ff3e7505c3928154f7663068c8396a11",
    status: "paid",
    payment_hash: "fa3b58ce01b89960260dbdc03a933733b2bbe2a53377baea6958a1d3c3166d69",
    verify_url: "https://shop.example.org/verify/bank?ref=ORDER-MSNM5N4N&minor=1&cc=CZK&sig=325f",
    preimage: "63d16c80a9b84c53b36bc0128a48af5057f32b1a2a3c4cbd761ce94a795a9b54",
    expires_at: "2026-08-10T20:17:32.000Z",
    created_at: "2026-08-10T19:17:32.000Z",
  });

  it("is refused by parseWebhook, because that shape wants an address and an invoice", async () => {
    const stamped = now();

    await expect(
      parseWebhook(WATCHED, header(WATCHED, SECRET, stamped), SECRET, stamped),
    ).resolves.toBeNull();
  });

  it("parses through parseWatchedWebhook, preimage and all", async () => {
    const stamped = now();

    const event = await parseWatchedWebhook(
      WATCHED,
      header(WATCHED, SECRET, stamped),
      SECRET,
      stamped,
    );

    expect(event?.status).toBe("paid");
    expect(event?.preimage).toBe(
      "63d16c80a9b84c53b36bc0128a48af5057f32b1a2a3c4cbd761ce94a795a9b54",
    );
    expect(event?.lnAddress).toBeNull();
    expect(event?.amountMsat).toBeNull();
  });

  it("still refuses a body signed with the wrong secret", async () => {
    const stamped = now();

    await expect(
      parseWatchedWebhook(WATCHED, header(WATCHED, OTHER_SECRET, stamped), SECRET, stamped),
    ).resolves.toBeNull();
  });

  it("reads the same body off a Request", async () => {
    const stamped = now();
    const request = new Request("https://shop.example.org/hooks/bank", {
      method: "POST",
      headers: {
        "x-signature": header(WATCHED, SECRET, stamped),
        "x-timestamp": stamped,
        "content-type": "application/json",
      },
      body: WATCHED,
    });

    await expect(parseWatchedWebhookRequest(request, SECRET)).resolves.toMatchObject({
      status: "paid",
    });
  });
});

describe("a correctly signed body that is not a payment", () => {
  it("comes back as null instead of throwing out of the handler", async () => {
    const stamp = now();
    const body = "<html>gateway error</html>";

    await expect(
      parseWebhook(body, header(body, SECRET, stamp), SECRET, stamp),
    ).resolves.toBeNull();
  });
});
