import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThunderBridge } from "../src/client";
import {
  conversationKeyFor,
  decryptNip44,
  encryptNip44,
  type NostrEvent,
  publicKeyFor,
  signEvent,
} from "../src/nostr";
import {
  nwcConnection,
  nwcHoldInvoice,
  nwcInvoice,
  nwcSettlement,
  nwcVerifyEndpoint,
  nwcVerifyUrl,
} from "../src/nwc";
import { nwcRail } from "../src/rail";

const WALLET_KEY = "11".repeat(32);
const CLIENT_KEY = "22".repeat(32);
const STRANGER_KEY = "33".repeat(32);
const SEALING_SECRET = "nwc_endpoint_9f2c1b7e40a8d635be07";
const MOUNT = "https://shop.example/verify/nwc";
const RELAY = "wss://relay.example";
const PREIMAGE = "7a".repeat(32);
const HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");
const INVOICE_1000 =
  "lnbc10n1p4grehzpp5ms4qetmpapwnzl270m6mtffcnd94kpg4la42m0d0dgefmwnakh0sdqqcqzzsxqrrsssp5vgz427q4jhup4d6lzvzyytgef9ste2f5tpnzvlzg86td3ts5x24s9qxpqysgq9gupgtf9a3rtch3dvskc2cwlexpyp47evhw8pvctcct9p0w048sx2vq5dy26j2rkfn06m9glrpd08qen8zlr0pe4vdk744wmeggwtqcqjz7pu2";
const INVOICE_1000_HASH = "dc2a0caf61e85d317d5e7ef5b5a5389b4b5b0515ff6aadbdaf6a329dba7db5df";

function uriFor(relays: string[] = [RELAY]): string {
  const query = relays.map((relay) => `relay=${encodeURIComponent(relay)}`).join("&");
  return `nostr+walletconnect://${publicKeyFor(WALLET_KEY)}?${query}&secret=${CLIENT_KEY}`;
}

interface FakeWallet {
  answer?: (method: string, params: Record<string, unknown>) => Record<string, unknown>;
  signWith?: string;
  claimPubkey?: string;
  silent?: boolean;
  refuseConnection?: boolean;
  mangle?: (event: NostrEvent) => unknown;
  rejectWith?: string;
}

function relaySpeaking(wallet: FakeWallet): {
  asked: string[];
  published: { tags: string[][] }[];
} {
  const asked: string[] = [];
  const published: { tags: string[][] }[] = [];
  const key = conversationKeyFor(WALLET_KEY, publicKeyFor(CLIENT_KEY));

  class FakeSocket {
    private listeners = new Map<string, ((event: unknown) => void)[]>();
    private subscription = "";

    constructor(readonly url: string) {
      queueMicrotask(() => {
        if (wallet.refuseConnection) {
          this.emit("error", {});
          return;
        }
        this.emit("open", {});
      });
    }

    addEventListener(name: string, listener: (event: unknown) => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    }

    close() {}

    send(frame: string) {
      const parsed = JSON.parse(frame) as [string, ...unknown[]];
      if (parsed[0] === "REQ") {
        this.subscription = parsed[1] as string;
        return;
      }

      const request = parsed[1] as { id: string; content: string; tags: string[][] };
      published.push(request);
      if (wallet.rejectWith) {
        queueMicrotask(() =>
          this.emit("message", {
            data: JSON.stringify(["OK", request.id, false, wallet.rejectWith]),
          }),
        );
        return;
      }
      const said = JSON.parse(decryptNip44(key, request.content)) as {
        method: string;
        params: Record<string, unknown>;
      };
      asked.push(said.method);
      if (wallet.silent) {
        return;
      }

      const answered = wallet.answer?.(said.method, said.params) ?? { result: {} };
      const event = signEvent(wallet.signWith ?? WALLET_KEY, {
        kind: 23195,
        tags: [
          ["p", publicKeyFor(CLIENT_KEY)],
          ["e", request.id],
        ],
        content: encryptNip44(key, JSON.stringify(answered)),
        created_at: Math.floor(Date.now() / 1000),
      });
      const claimed = wallet.claimPubkey ? { ...event, pubkey: wallet.claimPubkey } : event;
      const delivered = wallet.mangle?.(claimed) ?? claimed;

      queueMicrotask(() =>
        this.emit("message", { data: JSON.stringify(["EVENT", this.subscription, delivered]) }),
      );
    }

    private emit(name: string, event: unknown) {
      for (const listener of this.listeners.get(name) ?? []) {
        listener(event);
      }
    }
  }

  vi.stubGlobal("WebSocket", FakeSocket);

  return { asked, published };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reading an nwc uri", () => {
  it("takes the wallet key, the relays and the secret", () => {
    const connection = nwcConnection(uriFor(["wss://one.example", "wss://two.example"]));

    expect(connection.walletPubkey).toBe(publicKeyFor(WALLET_KEY));
    expect(connection.relays).toEqual(["wss://one.example", "wss://two.example"]);
    expect(connection.secret).toBe(CLIENT_KEY);
  });

  it("refuses a relay that is not wss", () => {
    expect(() => nwcConnection(uriFor(["ws://plain.example"]))).toThrow(/wss/);
  });

  it("refuses a uri with no relay at all", () => {
    expect(() =>
      nwcConnection(`nostr+walletconnect://${publicKeyFor(WALLET_KEY)}?secret=${CLIENT_KEY}`),
    ).toThrow(/relay/);
  });

  it("refuses a secret that is not 32 bytes of hex", () => {
    expect(() =>
      nwcConnection(`nostr+walletconnect://${publicKeyFor(WALLET_KEY)}?relay=${RELAY}&secret=nope`),
    ).toThrow(/secret/);
  });

  it("refuses something that is not an nwc uri", () => {
    expect(() => nwcConnection("https://example.com")).toThrow(/nostr\+walletconnect/);
  });

  it("names the scheme rather than echoing a uri, which carries the spend key", () => {
    const wrongScheme = uriFor().replace("nostr+walletconnect:", "https:");

    expect(() => nwcConnection(wrongScheme)).toThrow(/nostr\+walletconnect/);
    expect(() => nwcConnection(wrongScheme)).not.toThrow(new RegExp(CLIENT_KEY));
  });
});

describe("asking the wallet", () => {
  it("mints an invoice and decodes it rather than trusting the wallet's word", async () => {
    const relay = relaySpeaking({ answer: () => ({ result: { invoice: INVOICE_1000 } }) });
    const minted = await nwcInvoice(nwcConnection(uriFor()), 1000, "order-1");

    expect(relay.asked).toEqual(["make_invoice"]);
    expect(minted.bolt11).toBe(INVOICE_1000);
    expect(minted.paymentHash).toHaveLength(64);
  });

  it("refuses an invoice minted for another amount", async () => {
    relaySpeaking({ answer: () => ({ result: { invoice: INVOICE_1000 } }) });

    await expect(nwcInvoice(nwcConnection(uriFor()), 5000, "order-1")).rejects.toThrow(/not 5000/);
  });

  it("passes the error the wallet named", async () => {
    relaySpeaking({
      answer: () => ({ error: { code: "INSUFFICIENT_BALANCE", message: "no funds" } }),
    });

    await expect(nwcInvoice(nwcConnection(uriFor()), 1000, "order-1")).rejects.toThrow(
      /INSUFFICIENT_BALANCE/,
    );
  });

  it("calls a wallet that answered refused rather than unreachable, whatever it said", async () => {
    const said = [
      { code: "INTERNAL", reason: "invoice-refused" },
      { code: "NOT_FOUND", reason: "invoice-refused" },
      { code: "INSUFFICIENT_BALANCE", reason: "amount-not-accepted" },
      { code: "QUOTA_EXCEEDED", reason: "amount-not-accepted" },
      { code: "RESTRICTED", reason: "address-unusable" },
    ];

    for (const { code, reason } of said) {
      relaySpeaking({ answer: () => ({ error: { code, message: "no" } }) });
      await expect(nwcInvoice(nwcConnection(uriFor()), 1000, "x")).rejects.toMatchObject({ reason });
    }
  });

  it("calls a connection the wallet will not serve address-unusable, not a wallet fault", async () => {
    relaySpeaking({
      answer: () => ({ error: { code: "RESTRICTED", message: "this app may not create invoices" } }),
    });

    await expect(nwcInvoice(nwcConnection(uriFor()), 1000, "x")).rejects.toThrow(/RESTRICTED/);
  });

  it("tells the wallet which encryption it used, without which nip-47 reads it as nip04", async () => {
    const relay = relaySpeaking({ answer: () => ({ result: { preimage: null } }) });
    await nwcSettlement(nwcConnection(uriFor()), HASH);

    expect(relay.published[0]?.tags).toContainEqual(["encryption", "nip44_v2"]);
  });

  it("fails on the relay's own refusal rather than waiting out the timeout", async () => {
    relaySpeaking({ rejectWith: "blocked: pubkey not admitted" });

    await expect(nwcSettlement(nwcConnection(uriFor()), HASH)).rejects.toThrow(/not admitted/);
  });

  it("holds an invoice on a hash the wallet was handed", async () => {
    const relay = relaySpeaking({ answer: () => ({ result: { invoice: INVOICE_1000 } }) });
    const held = await nwcHoldInvoice(nwcConnection(uriFor()), {
      paymentHash: INVOICE_1000_HASH,
      amountMsat: 1000,
      description: "held",
      expirySecs: 300,
    });

    expect(relay.asked).toEqual(["make_hold_invoice"]);
    expect(held.paymentHash).toBe(INVOICE_1000_HASH);
  });

  it("refuses a hold the wallet put on a different hash than it was asked for", async () => {
    relaySpeaking({ answer: () => ({ result: { invoice: INVOICE_1000 } }) });

    await expect(
      nwcHoldInvoice(nwcConnection(uriFor()), {
        paymentHash: "ab".repeat(32),
        amountMsat: 1000,
        description: "held",
        expirySecs: 300,
      }),
    ).rejects.toThrow(/rather than the/);
  });

  it("reads a preimage the wallet released", async () => {
    relaySpeaking({ answer: () => ({ result: { preimage: PREIMAGE } }) });

    await expect(nwcSettlement(nwcConnection(uriFor()), HASH)).resolves.toBe(PREIMAGE);
  });

  it("reads an unpaid invoice as no preimage rather than as an error", async () => {
    relaySpeaking({ answer: () => ({ result: { preimage: null } }) });

    await expect(nwcSettlement(nwcConnection(uriFor()), HASH)).resolves.toBeNull();
  });

  it("throws on a preimage that does not hash to what was asked for", async () => {
    relaySpeaking({ answer: () => ({ result: { preimage: "ab".repeat(32) } }) });

    await expect(nwcSettlement(nwcConnection(uriFor()), HASH)).rejects.toThrow(/does not hash/);
  });

  it("tries the next relay when the first will not connect", async () => {
    relaySpeaking({ refuseConnection: true });

    await expect(
      nwcSettlement(nwcConnection(uriFor(["wss://down.example", "wss://also-down.example"])), HASH),
    ).rejects.toThrow(/no nwc relay answered/);
  });

  it("spends one deadline over every relay rather than one deadline each", async () => {
    const relay = relaySpeaking({ silent: true });
    const connection = nwcConnection(uriFor(["wss://one.example", "wss://two.example"]));

    await expect(nwcSettlement(connection, HASH, 40)).rejects.toThrow(/no nwc relay answered/);
    expect(relay.asked).toEqual(["lookup_invoice"]);
  });

  it("gives up on a relay that never answers", async () => {
    relaySpeaking({ silent: true });

    await expect(nwcSettlement(nwcConnection(uriFor()), HASH, 40)).rejects.toThrow(/no nwc relay/);
  });
});

describe("a hostile relay", () => {
  it("is ignored when it signs the answer with another key", async () => {
    relaySpeaking({
      answer: () => ({ result: { preimage: PREIMAGE } }),
      signWith: STRANGER_KEY,
    });

    await expect(nwcSettlement(nwcConnection(uriFor()), HASH, 40)).rejects.toThrow(/no nwc relay/);
  });

  it("is ignored when it sends an event whose tags are not tags at all", async () => {
    relaySpeaking({
      answer: () => ({ result: { preimage: PREIMAGE } }),
      mangle: (event) => ({ ...event, tags: "not an array" }),
    });

    await expect(nwcSettlement(nwcConnection(uriFor()), HASH, 40)).rejects.toThrow(/no nwc relay/);
  });

  it("is ignored when it claims the wallet's key over another key's signature", async () => {
    relaySpeaking({
      answer: () => ({ result: { preimage: PREIMAGE } }),
      signWith: STRANGER_KEY,
      claimPubkey: publicKeyFor(WALLET_KEY),
    });

    await expect(nwcSettlement(nwcConnection(uriFor()), HASH, 40)).rejects.toThrow(/no nwc relay/);
  });
});

describe("the verify endpoint", () => {
  async function askedFor(url: string) {
    return nwcVerifyEndpoint({
      connection: nwcConnection(uriFor()),
      secret: SEALING_SECRET,
      askTimeoutMs: 40,
    })(new Request(url));
  }

  it("answers the lud-21 shape once the wallet released the preimage", async () => {
    relaySpeaking({ answer: () => ({ result: { preimage: PREIMAGE } }) });
    const answer = await askedFor(await nwcVerifyUrl(MOUNT, HASH, SEALING_SECRET));

    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("max-age=5");
    expect(await answer.json()).toEqual({ settled: true, preimage: PREIMAGE });
  });

  it("answers not settled while the invoice is unpaid", async () => {
    relaySpeaking({ answer: () => ({ result: { preimage: null } }) });
    const answer = await askedFor(await nwcVerifyUrl(MOUNT, HASH, SEALING_SECRET));

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ settled: false, preimage: null });
  });

  it("answers 502 rather than not-settled when the wallet cannot be reached", async () => {
    relaySpeaking({ silent: true });
    const answer = await askedFor(await nwcVerifyUrl(MOUNT, HASH, SEALING_SECRET));

    expect(answer.status).toBe(502);
  });

  it("refuses a hash sealed with another secret", async () => {
    relaySpeaking({ answer: () => ({ result: { preimage: PREIMAGE } }) });
    const forged = await nwcVerifyUrl(MOUNT, HASH, "someone_elses_secret_e41b0d92c7a6f358");
    const answer = await askedFor(forged);

    expect(answer.status).toBe(403);
  });

  it("refuses a bare hash nobody sealed", async () => {
    relaySpeaking({ answer: () => ({ result: { preimage: PREIMAGE } }) });
    const answer = await askedFor(`${MOUNT}?h=${HASH}`);

    expect(answer.status).toBe(403);
  });

  it("refuses a request naming no hash at all", async () => {
    relaySpeaking({ answer: () => ({ result: { preimage: PREIMAGE } }) });

    expect((await askedFor(MOUNT)).status).toBe(400);
  });

  it("seals a different url every time, so one cannot be recognised by another", async () => {
    const once = await nwcVerifyUrl(MOUNT, HASH, SEALING_SECRET);
    const twice = await nwcVerifyUrl(MOUNT, HASH, SEALING_SECRET);

    expect(once).not.toBe(twice);
    expect(once).not.toContain(HASH);
  });
});

describe("the rail", () => {
  const order = { reference: "order-1", amountMinor: 48_055, currency: "CZK" };

  function gatewayTaking(watched: Record<string, unknown>[]) {
    return {
      watchPayment: async (params: Record<string, unknown>) => {
        watched.push(params);
        return { id: "wp_1" };
      },
    } as unknown as ThunderBridge;
  }

  it("mints on the wallet and hands the gateway a url of ours", async () => {
    relaySpeaking({ answer: () => ({ result: { invoice: INVOICE_1000 } }) });
    const watched: Record<string, unknown>[] = [];
    const leg = await nwcRail({
      gateway: gatewayTaking(watched),
      connection: nwcConnection(uriFor()),
      amountMsat: () => 1000,
      verifyThrough: { endpoint: MOUNT, secret: SEALING_SECRET },
    })(order);

    expect(leg.scan).toBe(INVOICE_1000);
    expect(leg.rail).toBe("lightning");
    expect(String(watched[0]?.verifyUrl).startsWith(`${MOUNT}?h=`)).toBe(true);
  });

  it("tells the gateway nothing about the wallet it just used", async () => {
    relaySpeaking({ answer: () => ({ result: { invoice: INVOICE_1000 } }) });
    const watched: Record<string, unknown>[] = [];
    await nwcRail({
      gateway: gatewayTaking(watched),
      connection: nwcConnection(uriFor()),
      amountMsat: () => 1000,
      verifyThrough: { endpoint: MOUNT, secret: SEALING_SECRET },
    })(order);

    const told = JSON.stringify(watched[0]);
    expect(told).not.toContain(CLIENT_KEY);
    expect(told).not.toContain(publicKeyFor(WALLET_KEY));
    expect(told).not.toContain("relay.example");
  });
});
