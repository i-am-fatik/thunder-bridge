import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SigningKey, signingKeyFromSeed } from "../../core/ed25519.js";
import { ThunderBridge } from "../src/client";
import { ProblemError } from "../src/errors";
import type { Settlement } from "../src/types";
import { jsonResponse, type Routes, stubFetch } from "./harness";

const GATEWAY = "https://gateway.example.net";
const HOOK = "https://shop.example.org/hooks/paid";
const KEY = signingKeyFromSeed(new Uint8Array(32).fill(9));
const OTHER = signingKeyFromSeed(new Uint8Array(32).fill(1));
const PREIMAGE = "4d".repeat(32);
const HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");

const SETTLED = JSON.stringify({
  id: "9500f6c6",
  status: "paid",
  payment_hash: HASH,
  preimage: PREIMAGE,
  settled_at: "2026-08-13T09:41:00.000Z",
});

function publishing(): Routes {
  return {
    [`${GATEWAY}/webhook-key`]: () => {
      throw new Error("the key is fetched lazily and this route is replaced per test");
    },
  };
}

async function keyRoutes(): Promise<Routes> {
  const key = await KEY;

  return {
    [`${GATEWAY}/webhook-key`]: () =>
      jsonResponse({ algorithm: "ed25519", public_key: key.publicKeyHex }),
  };
}

async function delivered(body: string, key: Promise<SigningKey> = KEY): Promise<Request> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signing = await key;
  const signature = await signing.sign(new TextEncoder().encode(`${timestamp}.${body}`));

  return new Request(HOOK, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature": `ed25519=${signature}`,
      "x-timestamp": timestamp,
    },
    body,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("serve.webhook", () => {
  it("calls back with a settlement that proves itself, and answers ok", async () => {
    stubFetch(await keyRoutes());
    const settled: Settlement[] = [];
    const route = new ThunderBridge(GATEWAY).serve.webhook({
      onSettled: (one) => void settled.push(one),
    });

    const answer = await route(await delivered(SETTLED));

    expect(answer.status).toBe(200);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.preimage).toBe(PREIMAGE);
  });

  it("answers 202 and calls nobody when the delivery proves nothing", async () => {
    stubFetch(await keyRoutes());
    const onSettled = vi.fn();
    const route = new ThunderBridge(GATEWAY).serve.webhook({ onSettled });
    const lying = JSON.stringify({ ...JSON.parse(SETTLED), preimage: "ff".repeat(32) });

    const answer = await route(await delivered(lying));

    expect(answer.status).toBe(202);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("hands an unproven delivery to whoever asked for one", async () => {
    stubFetch(await keyRoutes());
    const onUnproven = vi.fn();
    const route = new ThunderBridge(GATEWAY).serve.webhook({ onSettled: vi.fn(), onUnproven });
    const expired = JSON.stringify({ ...JSON.parse(SETTLED), status: "expired", preimage: null });

    const answer = await route(await delivered(expired));

    expect(answer.status).toBe(200);
    expect(onUnproven).toHaveBeenCalledTimes(1);
  });

  it("answers 401 to a delivery nobody the gateway published signed", async () => {
    stubFetch(await keyRoutes());
    const onSettled = vi.fn();
    const route = new ThunderBridge(GATEWAY).serve.webhook({ onSettled });

    const answer = await route(await delivered(SETTLED, OTHER));

    expect(answer.status).toBe(401);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("answers the gateway's challenge before it will be posted to at all", async () => {
    stubFetch(await keyRoutes());
    const onSettled = vi.fn();
    const route = new ThunderBridge(GATEWAY).serve.webhook({ onSettled });
    const nonce = "a".repeat(64);

    const answer = await route(
      await delivered(JSON.stringify({ type: "webhook-challenge", nonce })),
    );

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ nonce });
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("reads the gateway's key once, however many deliveries arrive", async () => {
    const calls = stubFetch(await keyRoutes());
    const route = new ThunderBridge(GATEWAY).serve.webhook({ onSettled: vi.fn() });

    await route(await delivered(SETTLED));
    await route(await delivered(SETTLED));

    expect(calls.filter((call) => call.url.endsWith("/webhook-key"))).toHaveLength(1);
  });

  it("asks the gateway again after a read of its key failed, rather than caching the failure", async () => {
    const key = await KEY;
    let asked = 0;
    stubFetch({
      [`${GATEWAY}/webhook-key`]: () => {
        asked += 1;

        return asked === 1
          ? jsonResponse({ title: "Service Unavailable" }, 503)
          : jsonResponse({ algorithm: "ed25519", public_key: key.publicKeyHex });
      },
    });
    const gateway = new ThunderBridge(GATEWAY);

    await expect(gateway.webhookKey()).rejects.toThrow(ProblemError);
    await expect(gateway.webhookKey()).resolves.toBe(key.publicKeyHex);
    expect(asked).toBe(2);
  });

  it("uses the key the caller pinned instead of asking the gateway for one", async () => {
    const calls = stubFetch(publishing());
    const key = await KEY;
    const route = new ThunderBridge(GATEWAY).serve.webhook({
      onSettled: vi.fn(),
      credential: { publicKey: key.publicKeyHex },
    });

    const answer = await route(await delivered(SETTLED));

    expect(answer.status).toBe(200);
    expect(calls).toHaveLength(0);
  });
});
