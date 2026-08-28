import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type SigningKey, signingKeyFromSeed } from "../../core/ed25519.js";
import type { Payment } from "../src/types";
import {
  answerWebhookChallenge,
  answerWebhookChallengeRequest,
  parseWatchedWebhook,
  parseWatchedWebhookRequest,
  parseWebhook,
  parseSettlement,
  parseSettlementRequest,
  parseWebhookRequest,
  isProvablySettled,
  verifyWebhookSignature,
  type WebhookCredential,
} from "../src/webhook";

const KEY = signingKeyFromSeed(new Uint8Array(32).fill(9));
const OTHER = signingKeyFromSeed(new Uint8Array(32).fill(1));

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

async function signedBy(
  body: string,
  timestamp: string,
  key: Promise<SigningKey> = KEY,
): Promise<string> {
  const signing = await key;

  return `ed25519=${await signing.sign(new TextEncoder().encode(`${timestamp}.${body}`))}`;
}

async function published(key: Promise<SigningKey> = KEY): Promise<WebhookCredential> {
  return { publicKey: (await key).publicKeyHex };
}

describe("verifyWebhookSignature", () => {
  it("accepts the signature the gateway sends, carrying its ed25519= prefix", async () => {
    const stamp = now();
    await expect(
      verifyWebhookSignature(BODY, await signedBy(BODY, stamp), await published(), stamp),
    ).resolves.toBe(true);
  });

  it("rejects a body tampered with by a single byte", async () => {
    const stamp = now();
    const tampered = BODY.replace('"value":"21000000"', '"value":"21000001"');
    await expect(
      verifyWebhookSignature(tampered, await signedBy(BODY, stamp), await published(), stamp),
    ).resolves.toBe(false);
  });

  it("rejects a signature made under a different key", async () => {
    const stamp = now();
    await expect(
      verifyWebhookSignature(BODY, await signedBy(BODY, stamp, OTHER), await published(), stamp),
    ).resolves.toBe(false);
  });

  it("rejects a replay of a body and signature captured long enough ago", async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    await expect(
      verifyWebhookSignature(BODY, await signedBy(BODY, stale), await published(), stale),
    ).resolves.toBe(false);
  });

  it("accepts that same old delivery when the caller widens the tolerance", async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    await expect(
      verifyWebhookSignature(BODY, await signedBy(BODY, stale), await published(), stale, {
        toleranceSecs: 7200,
      }),
    ).resolves.toBe(true);
  });

  it("rejects a signature lifted onto a different timestamp", async () => {
    const stamp = now();
    const moved = String(Number(stamp) - 60);
    await expect(
      verifyWebhookSignature(BODY, await signedBy(BODY, stamp), await published(), moved),
    ).resolves.toBe(false);
  });

  it("rejects a timestamp that is not a number at all", async () => {
    const stamp = now();
    await expect(
      verifyWebhookSignature(BODY, await signedBy(BODY, stamp), await published(), "yesterday"),
    ).resolves.toBe(false);
  });

  it("verifies a Uint8Array body exactly as it verifies the same bytes as a string", async () => {
    const stamp = now();
    const signature = await signedBy(BODY, stamp);
    const bytes = new TextEncoder().encode(BODY);
    await expect(verifyWebhookSignature(bytes, signature, await published(), stamp)).resolves.toBe(true);
    await expect(
      verifyWebhookSignature(bytes, signature, await published(OTHER), stamp),
    ).resolves.toBe(false);
  });
});

describe("parseWebhook", () => {
  it("returns the parsed payment when the signature holds", async () => {
    const stamp = now();
    await expect(parseWebhook(BODY, await signedBy(BODY, stamp), await published(), stamp)).resolves.toEqual(
      PAYMENT,
    );
  });

  it("returns null and never parses the body when the signature does not hold", async () => {
    const stamp = now();
    await expect(
      parseWebhook(BODY, await signedBy(BODY, stamp, OTHER), await published(), stamp),
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
        "x-signature": await signedBy(BODY, stamp),
        "x-timestamp": stamp,
      },
      body: BODY,
    });
    await expect(parseWebhookRequest(request, await published())).resolves.toEqual(PAYMENT);
  });

  it("returns null when the request carries no x-signature header at all", async () => {
    const request = new Request("https://app.example.com/hooks/thunder-bridge", {
      method: "POST",
      headers: { "content-type": "application/json", "x-timestamp": now() },
      body: BODY,
    });
    await expect(parseWebhookRequest(request, await published())).resolves.toBeNull();
  });

  it("returns null when the request carries no x-timestamp header at all", async () => {
    const stamp = now();
    const request = new Request("https://app.example.com/hooks/thunder-bridge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature": await signedBy(BODY, stamp),
      },
      body: BODY,
    });
    await expect(parseWebhookRequest(request, await published())).resolves.toBeNull();
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
      parseWebhook(WATCHED, await signedBy(WATCHED, stamped), await published(), stamped),
    ).resolves.toBeNull();
  });

  it("parses through parseWatchedWebhook, preimage and all", async () => {
    const stamped = now();

    const event = await parseWatchedWebhook(
      WATCHED,
      await signedBy(WATCHED, stamped),
      await published(),
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
      parseWatchedWebhook(WATCHED, await signedBy(WATCHED, stamped, OTHER), await published(), stamped),
    ).resolves.toBeNull();
  });

  it("says which shape it is, whether the gateway sent a kind or is old enough not to", async () => {
    const stamped = now();
    const said = JSON.stringify({ ...JSON.parse(WATCHED), kind: "watched" });

    const inferred = await parseWatchedWebhook(
      WATCHED,
      await signedBy(WATCHED, stamped),
      await published(),
      stamped,
    );
    const told = await parseWatchedWebhook(said, await signedBy(said, stamped), await published(), stamped);

    expect(inferred?.kind).toBe("watched");
    expect(told?.kind).toBe("watched");
  });

  it("reads the same body off a Request", async () => {
    const stamped = now();
    const request = new Request("https://shop.example.org/hooks/bank", {
      method: "POST",
      headers: {
        "x-signature": await signedBy(WATCHED, stamped),
        "x-timestamp": stamped,
        "content-type": "application/json",
      },
      body: WATCHED,
    });

    await expect(parseWatchedWebhookRequest(request, await published())).resolves.toMatchObject({
      status: "paid",
    });
  });
});

describe("a correctly signed body that is not a payment", () => {
  it("comes back as null instead of throwing out of the handler", async () => {
    const stamp = now();
    const body = "<html>gateway error</html>";

    await expect(
      parseWebhook(body, await signedBy(body, stamp), await published(), stamp),
    ).resolves.toBeNull();
  });
});

describe("a delivery the gateway signed with its own key", () => {
  const KEY = signingKeyFromSeed(new Uint8Array(32).fill(9));

  async function signedByGateway(body: string, timestamp: string): Promise<string> {
    const key = await KEY;
    return `ed25519=${await key.sign(new TextEncoder().encode(`${timestamp}.${body}`))}`;
  }

  async function published(): Promise<{ publicKey: string }> {
    return { publicKey: (await KEY).publicKeyHex };
  }

  it("verifies against the key the gateway publishes, with no secret anywhere", async () => {
    const stamp = now();

    await expect(
      verifyWebhookSignature(BODY, await signedByGateway(BODY, stamp), await published(), stamp),
    ).resolves.toBe(true);
  });

  it("parses into a payment the same way a shared secret does", async () => {
    const stamp = now();

    await expect(
      parseWebhook(BODY, await signedByGateway(BODY, stamp), await published(), stamp),
    ).resolves.toMatchObject({ id: PAYMENT.id, preimage: PAYMENT.preimage });
  });

  it("refuses a body changed after it was signed", async () => {
    const stamp = now();
    const signature = await signedByGateway(BODY, stamp);
    const tampered = BODY.replace(String(PAYMENT.preimage), "ff".repeat(32));

    await expect(
      verifyWebhookSignature(tampered, signature, await published(), stamp),
    ).resolves.toBe(false);
  });

  it("refuses a signature made with another gateway's key", async () => {
    const stamp = now();
    const other = await signingKeyFromSeed(new Uint8Array(32).fill(1));
    const theirs = `ed25519=${await other.sign(new TextEncoder().encode(`${stamp}.${BODY}`))}`;

    await expect(verifyWebhookSignature(BODY, theirs, await published(), stamp)).resolves.toBe(
      false,
    );
  });

  it("refuses a stale delivery, because the timestamp is inside what was signed", async () => {
    const old = String(Math.floor(Date.now() / 1000) - 3600);

    await expect(
      verifyWebhookSignature(BODY, await signedByGateway(BODY, old), await published(), old),
    ).resolves.toBe(false);
  });

  it("refuses the shared secret scheme that used to be accepted here", async () => {
    const stamp = now();
    const hmac = createHmac("sha256", "whsec_bd41a4f0c8e94d0fa1b7")
      .update(`${stamp}.${BODY}`, "utf8")
      .digest("hex");

    await expect(
      verifyWebhookSignature(BODY, `sha256=${hmac}`, await published(), stamp),
    ).resolves.toBe(false);
    await expect(verifyWebhookSignature(BODY, hmac, await published(), stamp)).resolves.toBe(false);
  });
});

describe("answerWebhookChallenge", () => {
  const NONCE = "a".repeat(64);
  const CHALLENGE_BODY = JSON.stringify({ type: "webhook-challenge", nonce: NONCE });

  it("echoes the nonce alone, because the gateway holds nothing of yours to sign with", async () => {
    const stamp = now();
    const key = await signingKeyFromSeed(new Uint8Array(32).fill(9));
    const signed = `ed25519=${await key.sign(new TextEncoder().encode(`${stamp}.${CHALLENGE_BODY}`))}`;

    const answer = await answerWebhookChallenge(
      CHALLENGE_BODY,
      signed,
      {
        publicKey: key.publicKeyHex,
      },
      stamp,
    );

    expect(JSON.parse(String(answer))).toEqual({ nonce: NONCE });
  });

  it("answers nothing to a challenge another key signed", async () => {
    const stamp = now();

    await expect(
      answerWebhookChallenge(
        CHALLENGE_BODY,
        await signedBy(CHALLENGE_BODY, stamp, OTHER),
        await published(),
        stamp,
      ),
    ).resolves.toBeNull();
  });

  it("leaves a real settlement to the parsers, and hands the body on unread", async () => {
    const stamp = now();
    const request = new Request("https://shop.example/hooks/paid", {
      method: "POST",
      headers: { "x-signature": await signedBy(BODY, stamp), "x-timestamp": stamp },
      body: BODY,
    });

    expect(await answerWebhookChallengeRequest(request, await published())).toBeNull();
    expect((await parseWebhookRequest(request, await published()))?.id).toBe(PAYMENT.id);
  });

  it("answers a challenge that arrives as a Request with a JSON body", async () => {
    const stamp = now();
    const request = new Request("https://shop.example/hooks/paid", {
      method: "POST",
      headers: { "x-signature": await signedBy(CHALLENGE_BODY, stamp), "x-timestamp": stamp },
      body: CHALLENGE_BODY,
    });

    const answer = await answerWebhookChallengeRequest(request, await published());

    expect(answer?.headers.get("content-type")).toBe("application/json");
    expect(((await answer?.json()) as { nonce: string }).nonce).toBe(NONCE);
  });
});

describe("a delivery in the shape the gateway sends now", () => {
  const REAL_PREIMAGE = "4d".repeat(32);
  const REAL_HASH = createHash("sha256").update(Buffer.from(REAL_PREIMAGE, "hex")).digest("hex");
  const SETTLED = JSON.stringify({
    id: "9500f6c684d69021968e8d3f98536812ff3e7505c3928154f7663068c8396a11",
    status: "paid",
    payment_hash: REAL_HASH,
    preimage: REAL_PREIMAGE,
    settled_at: "2026-08-13T09:41:00.000Z",
  });

  it("parses, and carries nothing it does not need", async () => {
    const stamp = now();

    const settled = await parseSettlement(SETTLED, await signedBy(SETTLED, stamp), await published(), stamp);

    expect(settled?.id).toBe("9500f6c684d69021968e8d3f98536812ff3e7505c3928154f7663068c8396a11");
    expect(settled?.status).toBe("paid");
    expect(settled?.preimage).toBe(REAL_PREIMAGE);
    expect(settled?.settledAt).toBe(Math.floor(Date.parse("2026-08-13T09:41:00.000Z") / 1000));
    expect(SETTLED).not.toContain("verify_url");
    expect(SETTLED).not.toContain("sealed");
  });

  it("proves itself, because the preimage is checked against the hash it names", async () => {
    const stamp = now();
    const settled = await parseSettlement(SETTLED, await signedBy(SETTLED, stamp), await published(), stamp);

    expect(settled && isProvablySettled(settled)).toBe(true);
  });

  it("does not prove itself when the preimage hashes to something else", async () => {
    const stamp = now();
    const lying = JSON.stringify({ ...JSON.parse(SETTLED), preimage: "ff".repeat(32) });

    const settled = await parseSettlement(lying, await signedBy(lying, stamp), await published(), stamp);

    expect(settled && isProvablySettled(settled)).toBe(false);
  });

  it("refuses a delivery missing any part of what would be acted on", async () => {
    const stamp = now();

    for (const missing of ["id", "payment_hash", "settled_at", "status"]) {
      const partial = JSON.parse(SETTLED) as Record<string, unknown>;
      delete partial[missing];
      const body = JSON.stringify(partial);

      await expect(
        parseSettlement(body, await signedBy(body, stamp), await published(), stamp),
      ).resolves.toBeNull();
    }
  });

  it("is null when nobody the receiver trusts signed it", async () => {
    const stamp = now();

    await expect(
      parseSettlement(SETTLED, await signedBy(SETTLED, stamp, OTHER), await published(), stamp),
    ).resolves.toBeNull();
  });

  it("reads the same delivery off a Request", async () => {
    const stamp = now();
    const request = new Request("https://shop.example/hooks/paid", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature": await signedBy(SETTLED, stamp),
        "x-timestamp": stamp,
      },
      body: SETTLED,
    });

    await expect(parseSettlementRequest(request, await published())).resolves.toMatchObject({
      status: "paid",
    });
  });
});
