import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSettled } from "../../core/lnurl.js";
import { lightningVerifyEndpoint, relayedVerifyUrl } from "../src/relay";

const SECRET = "relay_2f0c8a4e7b1d9c05e3a71486bf20";
const MOUNT = "https://shop.example/verify/lightning";
const WALLET = "https://lnurl.blink.sv/verify/f0e1d2c3";
const PREIMAGE = "4d".repeat(32);
const HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");

function walletSaying(body: unknown, calls: string[] = []): string[] {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: RequestInfo | URL) => {
      calls.push(String(url));
      return Promise.resolve(Response.json(body));
    }),
  );

  return calls;
}

async function relayed(): Promise<string> {
  return relayedVerifyUrl(MOUNT, { url: WALLET, hash: HASH }, SECRET);
}

describe("lightningVerifyEndpoint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hands the gateway a URL of yours that names no wallet anywhere in it", async () => {
    const url = await relayed();

    expect(url.startsWith(MOUNT)).toBe(true);
    expect(url).not.toContain("blink");
    expect(url).not.toContain(HASH);
  });

  it("asks the wallet and relays what it said, without deciding anything", async () => {
    const asked = walletSaying({ settled: true, preimage: PREIMAGE });
    const answer = await lightningVerifyEndpoint({ secret: SECRET })(new Request(await relayed()));

    expect(asked).toEqual([WALLET]);
    expect(await answer.json()).toEqual({ settled: true, preimage: PREIMAGE });
  });

  it("says unsettled while the wallet does, and names the pace it wants", async () => {
    walletSaying({ settled: false });
    const answer = await lightningVerifyEndpoint({ secret: SECRET, pollEverySecs: 3 })(
      new Request(await relayed()),
    );

    expect(await answer.json()).toEqual({ settled: false, preimage: null });
    expect(answer.headers.get("cache-control")).toBe("max-age=3");
  });

  it("never passes on a preimage that does not hash to what was sealed", async () => {
    walletSaying({ settled: true, preimage: "ff".repeat(32) });
    const answer = await lightningVerifyEndpoint({ secret: SECRET })(new Request(await relayed()));

    expect(answer.status).toBe(502);
    expect(await answer.json()).toEqual({ settled: false });
  });

  it("cannot be opened by anyone holding a different secret", async () => {
    const answer = await lightningVerifyEndpoint({ secret: "another_secret_32_characters_long" })(
      new Request(await relayed()),
    );

    expect(answer.status).toBe(403);
  });

  it("says it could not ask rather than saying nothing settled, when the wallet is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ENOTFOUND"))),
    );
    const answer = await lightningVerifyEndpoint({ secret: SECRET })(new Request(await relayed()));

    expect(answer.status).toBe(502);
  });

  it("refuses a request carrying no sealed wallet at all", async () => {
    const answer = await lightningVerifyEndpoint({ secret: SECRET })(new Request(MOUNT));

    expect(answer.status).toBe(400);
  });

  it("answers the shape the gateway's own settlement check reads", async () => {
    const url = await relayed();
    const handler = lightningVerifyEndpoint({ secret: SECRET });
    vi.stubGlobal(
      "fetch",
      vi.fn((target: RequestInfo | URL) =>
        String(target) === WALLET
          ? Promise.resolve(Response.json({ settled: true, preimage: PREIMAGE }))
          : handler(new Request(String(target))),
      ),
    );

    expect(await checkSettled(url, HASH)).toEqual({ preimage: PREIMAGE, pace: 5 });
  });
});
