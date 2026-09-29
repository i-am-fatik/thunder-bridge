import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverySigned } from "../../core/delivery.js";
import { type SigningKey, signingKeyFromSeed } from "../../core/ed25519.js";
import { ThunderBridge } from "../src/client";
import { ProblemError } from "../src/errors";
import type { Settlement } from "../src/types";
import { bolt11 } from "./encode";
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

async function delivered(
  body: string,
  key: Promise<SigningKey> = KEY,
  arrivingAt = HOOK,
): Promise<Request> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signing = await key;
  const signature = await signing.sign(deliverySigned(HOOK, timestamp, body));

  return new Request(arrivingAt, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-v2": `ed25519=${signature}`,
      "x-timestamp": timestamp,
    },
    body,
  });
}

afterEach(() => {
  vi.useRealTimers();
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

  it("refuses a paid delivery that proves nothing the way it refuses a bad signature", async () => {
    stubFetch(await keyRoutes());
    const onSettled = vi.fn();
    const onUnproven = vi.fn();
    const route = new ThunderBridge(GATEWAY).serve.webhook({ onSettled, onUnproven });
    const lying = JSON.stringify({ ...JSON.parse(SETTLED), preimage: "ff".repeat(32) });

    const answer = await route(await delivered(lying));

    expect(answer.status).toBe(401);
    expect(onSettled).not.toHaveBeenCalled();
    expect(onUnproven).not.toHaveBeenCalled();
  });

  it("answers 202 and calls nobody for an expiry nobody asked to hear about", async () => {
    stubFetch(await keyRoutes());
    const onSettled = vi.fn();
    const route = new ThunderBridge(GATEWAY).serve.webhook({ onSettled });
    const expired = JSON.stringify({ ...JSON.parse(SETTLED), status: "expired", preimage: null });

    const answer = await route(await delivered(expired));

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

  it("acts on a delivery replayed while its signature is still believable only once", async () => {
    stubFetch(await keyRoutes());
    const onSettled = vi.fn();
    const route = new ThunderBridge(GATEWAY).serve.webhook({ onSettled });
    const captured = await delivered(SETTLED);
    const replayed = captured.clone();
    const another = JSON.stringify({ ...JSON.parse(SETTLED), id: "7c2e11ab" });

    const first = await route(captured);
    const replay = await route(replayed);
    const retry = await route(await delivered(SETTLED));
    await route(await delivered(another));

    expect([first.status, replay.status, retry.status]).toEqual([200, 200, 200]);
    expect(onSettled.mock.calls.map(([one]) => one.id)).toEqual(["9500f6c6", "7c2e11ab"]);
  });

  it("holds a second delivery until the first is handled, rather than acting on both", async () => {
    stubFetch(await keyRoutes());
    let finish = () => {};
    const onSettled = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const route = new ThunderBridge(GATEWAY).serve.webhook({ onSettled });

    let released = false;
    let answeredBeforeRelease = false;
    const first = route(await delivered(SETTLED));
    const second = route(await delivered(SETTLED)).then((answer) => {
      answeredBeforeRelease = !released;
      return answer;
    });
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    released = true;
    finish();

    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(answeredBeforeRelease).toBe(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("acts again on a retry once the callback failed the first time", async () => {
    stubFetch(await keyRoutes());
    const onSettled = vi.fn().mockRejectedValueOnce(new Error("the database was down"));
    const route = new ThunderBridge(GATEWAY).serve.webhook({ onSettled });

    await expect(route(await delivered(SETTLED))).rejects.toThrow("the database was down");
    const retry = await route(await delivered(SETTLED));

    expect(retry.status).toBe(200);
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it("forgets a settlement once no delivery of it could still be believed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    stubFetch(await keyRoutes());
    const onSettled = vi.fn();
    const route = new ThunderBridge(GATEWAY).serve.webhook({ onSettled, toleranceSecs: 60 });

    await route(await delivered(SETTLED));
    vi.setSystemTime(Date.now() + 119_000);
    await route(await delivered(SETTLED));
    expect(onSettled).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 2_000);
    await route(await delivered(SETTLED));
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it("acts on a whole payment an older gateway posts only once too", async () => {
    stubFetch(await keyRoutes());
    const onPayment = vi.fn();
    const route = new ThunderBridge(GATEWAY).serve.webhook({ onPayment });
    const payment = JSON.stringify({
      id: "pay_7f3c9d21",
      ln_address: "tips@wallet.example",
      incoming_amount: { value: "21000", asset_code: "BTC", asset_scale: 11 },
      status: "paid",
      bolt11: bolt11({ paymentHash: HASH, amountMsat: 21_000 }),
      payment_hash: HASH,
      verify_url: "https://wallet.example/verify/7f3c9d21",
      preimage: PREIMAGE,
      expires_at: "2026-08-13T09:51:00.000Z",
      created_at: "2026-08-13T09:41:00.000Z",
    });

    await route(await delivered(payment));
    await route(await delivered(payment));

    expect(onPayment).toHaveBeenCalledTimes(1);
  });

  it("checks a delivery against the URL it was registered under, when a proxy renames it", async () => {
    stubFetch(await keyRoutes());
    const onSettled = vi.fn();
    const behindProxy = "http://shop:3000/hooks/paid";

    const unnamed = new ThunderBridge(GATEWAY).serve.webhook({ onSettled });
    const named = new ThunderBridge(GATEWAY).serve.webhook({ onSettled, url: HOOK });

    expect((await unnamed(await delivered(SETTLED, KEY, behindProxy))).status).toBe(401);
    expect((await named(await delivered(SETTLED, KEY, behindProxy))).status).toBe(200);
    expect(onSettled).toHaveBeenCalledTimes(1);
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
