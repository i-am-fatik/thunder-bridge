import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type SigningKey, signingKeyFromSeed } from "../../core/ed25519.js";
import type { MintedPayment } from "../src/types";
import { carriesProof } from "../src/verify";
import {
  answerWebhookChallenge,
  readPayment,
  readSettlement,
  type WebhookCredential,
} from "../src/webhook";

const KEY = signingKeyFromSeed(new Uint8Array(32).fill(9));
const OTHER = signingKeyFromSeed(new Uint8Array(32).fill(1));
const HOOK = "https://app.example.com/hooks/thunder-bridge";

const PAYMENT: MintedPayment = {
  id: "pay_7f3c9d21",
  kind: "minted",
  lnAddress: "i_am_fatik@btcpay.3d3d.cz",
  amountMsat: 21000000,
  status: "paid",
  paymentHash: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  bolt11: "lnbc210000n1pjfillerinvoice",
  preimage: "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
  expiresAt: 1754000600,
  createdAt: 1753999999,
  verifyUrl: "https://btcpay.3d3d.cz/lnurlp/verify/7f3c9d21",
  sealed: null,
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

function stale(): string {
  return String(Math.floor(Date.now() / 1000) - 3600);
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

interface Sent {
  signature?: string;
  timestamp?: string;
  signedWith?: Promise<SigningKey>;
  url?: string;
}

async function delivery(body: string, sent: Sent = {}): Promise<Request> {
  const timestamp = sent.timestamp ?? now();
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signature = sent.signature ?? (await signedBy(body, timestamp, sent.signedWith));
  if (signature !== "") {
    headers["x-signature"] = signature;
  }
  if (sent.timestamp !== "") {
    headers["x-timestamp"] = timestamp;
  }

  return new Request(sent.url ?? HOOK, { method: "POST", headers, body });
}

describe("the signature a delivery has to carry", () => {
  it("accepts the one the gateway sends, carrying its ed25519= prefix", async () => {
    await expect(readPayment(await delivery(BODY), await published())).resolves.toEqual(PAYMENT);
  });

  it("rejects a body tampered with by a single byte", async () => {
    const stamp = now();
    const tampered = BODY.replace('"value":"21000000"', '"value":"21000001"');
    const request = await delivery(tampered, {
      timestamp: stamp,
      signature: await signedBy(BODY, stamp),
    });

    await expect(readPayment(request, await published())).resolves.toBeNull();
  });

  it("rejects a signature made under a different key", async () => {
    const request = await delivery(BODY, { signedWith: OTHER });

    await expect(readPayment(request, await published())).resolves.toBeNull();
  });

  it("rejects a replay of a body and signature captured long enough ago", async () => {
    const request = await delivery(BODY, { timestamp: stale() });

    await expect(readPayment(request, await published())).resolves.toBeNull();
  });

  it("accepts that same old delivery when the caller widens the tolerance", async () => {
    const request = await delivery(BODY, { timestamp: stale() });

    await expect(
      readPayment(request, await published(), { toleranceSecs: 7200 }),
    ).resolves.toEqual(PAYMENT);
  });

  it("rejects a signature lifted onto a different timestamp", async () => {
    const stamp = now();
    const request = await delivery(BODY, {
      timestamp: String(Number(stamp) - 60),
      signature: await signedBy(BODY, stamp),
    });

    await expect(readPayment(request, await published())).resolves.toBeNull();
  });

  it("rejects a timestamp that is not a number at all", async () => {
    const request = await delivery(BODY, { timestamp: "yesterday" });

    await expect(readPayment(request, await published())).resolves.toBeNull();
  });

  it("refuses the shared secret scheme that used to be accepted here", async () => {
    const stamp = now();
    const hmac = createHmac("sha256", "whsec_bd41a4f0c8e94d0fa1b7")
      .update(`${stamp}.${BODY}`, "utf8")
      .digest("hex");

    for (const offered of [`sha256=${hmac}`, hmac]) {
      const request = await delivery(BODY, { timestamp: stamp, signature: offered });
      await expect(readPayment(request, await published())).resolves.toBeNull();
    }
  });

  it("returns null when the request carries no x-signature header at all", async () => {
    const request = await delivery(BODY, { signature: "" });

    await expect(readPayment(request, await published())).resolves.toBeNull();
  });

  it("returns null when the request carries no x-timestamp header at all", async () => {
    const stamp = now();
    const request = new Request(HOOK, {
      method: "POST",
      headers: { "x-signature": await signedBy(BODY, stamp) },
      body: BODY,
    });

    await expect(readPayment(request, await published())).resolves.toBeNull();
  });
});

describe("a bank transfer's delivery, which names no address, amount or invoice", () => {
  const WATCHED = JSON.stringify({
    id: "9500f6c684d69021968e8d3f98536812ff3e7505c3928154f7663068c8396a11",
    status: "paid",
    payment_hash: "fa3b58ce01b89960260dbdc03a933733b2bbe2a53377baea6958a1d3c3166d69",
    verify_url: "https://shop.example.org/verify/bank?ref=ORDER-MSNM5N4N&minor=1&cc=CZK&sig=325f",
    preimage: "63d16c80a9b84c53b36bc0128a48af5057f32b1a2a3c4cbd761ce94a795a9b54",
    expires_at: "2026-08-10T20:17:32.000Z",
    created_at: "2026-08-10T19:17:32.000Z",
  });

  it("reads through the same reader a minted one does, preimage and all", async () => {
    const read = await readPayment(await delivery(WATCHED), await published());

    expect(read?.status).toBe("paid");
    expect(read?.preimage).toBe(
      "63d16c80a9b84c53b36bc0128a48af5057f32b1a2a3c4cbd761ce94a795a9b54",
    );
    expect(read?.lnAddress).toBeNull();
    expect(read?.amountMsat).toBeNull();
    expect(read?.bolt11).toBeNull();
  });

  it("still refuses a body signed with the wrong key", async () => {
    const request = await delivery(WATCHED, { signedWith: OTHER });

    await expect(readPayment(request, await published())).resolves.toBeNull();
  });

  it("says which shape it is, whether the gateway sent a kind or is old enough not to", async () => {
    const said = JSON.stringify({ ...JSON.parse(WATCHED), kind: "watched" });

    const inferred = await readPayment(await delivery(WATCHED), await published());
    const told = await readPayment(await delivery(said), await published());

    expect(inferred?.kind).toBe("watched");
    expect(told?.kind).toBe("watched");
  });
});

describe("a correctly signed body that is not a payment", () => {
  it("comes back as null instead of throwing out of the handler", async () => {
    const request = await delivery("<html>gateway error</html>");

    await expect(readPayment(request, await published())).resolves.toBeNull();
  });
});

describe("answerWebhookChallenge", () => {
  const NONCE = "a".repeat(64);
  const CHALLENGE_BODY = JSON.stringify({ type: "webhook-challenge", nonce: NONCE });

  it("echoes the nonce alone, because the gateway holds nothing of yours to sign with", async () => {
    const answer = await answerWebhookChallenge(
      await delivery(CHALLENGE_BODY),
      await published(),
    );

    expect(answer?.headers.get("content-type")).toBe("application/json");
    expect(((await answer?.json()) as { nonce: string }).nonce).toBe(NONCE);
  });

  it("answers nothing to a challenge another key signed", async () => {
    const request = await delivery(CHALLENGE_BODY, { signedWith: OTHER });

    await expect(answerWebhookChallenge(request, await published())).resolves.toBeNull();
  });

  it("leaves a real settlement to the readers, and hands the body on unread", async () => {
    const request = await delivery(BODY);

    expect(await answerWebhookChallenge(request, await published())).toBeNull();
    expect((await readPayment(request, await published()))?.id).toBe(PAYMENT.id);
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
    const settled = await readSettlement(await delivery(SETTLED), await published());

    expect(settled?.id).toBe("9500f6c684d69021968e8d3f98536812ff3e7505c3928154f7663068c8396a11");
    expect(settled?.status).toBe("paid");
    expect(settled?.preimage).toBe(REAL_PREIMAGE);
    expect(settled?.settledAt).toBe(Math.floor(Date.parse("2026-08-13T09:41:00.000Z") / 1000));
    expect(SETTLED).not.toContain("verify_url");
    expect(SETTLED).not.toContain("sealed");
  });

  it("is not a payment, so the payment reader refuses it", async () => {
    await expect(readPayment(await delivery(SETTLED), await published())).resolves.toBeNull();
  });

  it("proves itself, because the preimage is checked against the hash it names", async () => {
    const settled = await readSettlement(await delivery(SETTLED), await published());

    expect(settled && carriesProof(settled)).toBe(true);
  });

  it("does not prove itself when the preimage hashes to something else", async () => {
    const lying = JSON.stringify({ ...JSON.parse(SETTLED), preimage: "ff".repeat(32) });

    const settled = await readSettlement(await delivery(lying), await published());

    expect(settled && carriesProof(settled)).toBe(false);
  });

  it("refuses a delivery missing any part of what would be acted on", async () => {
    for (const missing of ["id", "payment_hash", "settled_at", "status"]) {
      const partial = JSON.parse(SETTLED) as Record<string, unknown>;
      delete partial[missing];
      const body = JSON.stringify(partial);

      await expect(readSettlement(await delivery(body), await published())).resolves.toBeNull();
    }
  });

  it("is null when nobody the receiver trusts signed it", async () => {
    const request = await delivery(SETTLED, { signedWith: OTHER });

    await expect(readSettlement(request, await published())).resolves.toBeNull();
  });
});
