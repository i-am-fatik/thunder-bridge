import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callerKey, paymentNamedBy } from "../../core/caller.js";
import { bankAgent, type BankOrder, bankTransfer, type Credit } from "../src/bank";
import { ThunderBridge } from "../src/client";

vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "203.0.113.1", family: 4 }],
}));

const SECRET = "keep-me-server-side-and-thirty-two-plus";
const REFERENCE = "ORDER-2026-77";
const AMOUNT_MINOR = 48_055;
const IBAN = "CZ6508000000192000145399";
const GATEWAY = "https://gateway.example.net";
const EXPIRES_AT = 1_900_000_000;
const TICKET = "2.a.ticket";

class FakeSocket {
  static readonly opened: FakeSocket[] = [];

  readonly sent: string[] = [];
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }

  send(frame: string): void {
    this.sent.push(frame);
  }

  close(): void {
    this.closeCalls += 1;
  }

  said(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1] ?? "{}") as Record<string, unknown>;
  }
}

function credit(overrides: Partial<Credit> = {}): Credit {
  return {
    amountMinor: AMOUNT_MINOR,
    currency: "CZK",
    reference: `PLATBA ${REFERENCE} DIKY`,
    bookedAt: 1_780_000_000,
    ...overrides,
  };
}

function order(credits: Credit[]): BankOrder {
  return {
    iban: IBAN,
    reference: REFERENCE,
    amountMinor: AMOUNT_MINOR,
    statement: async () => credits,
  };
}

const watched: Array<Record<string, unknown>> = [];

function serving(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/ws-tickets")) {
        return Response.json({ ticket: TICKET, expires_at: new Date(EXPIRES_AT * 1000).toISOString() });
      }
      if (url.includes("is-this-gateway-yours")) {
        return Response.json({}, { status: 401 });
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      watched.push(body);
      const mine = paymentNamedBy(
        (await callerKey(SECRET)).publicKeyHex,
        String(body["payment_hash"]),
      );

      return Response.json(
        {
          id: mine,
          status: "pending",
          payment_hash: body["payment_hash"],
          verify_url: body["verify_url"],
          preimage: null,
          expires_at: new Date(EXPIRES_AT * 1000).toISOString(),
          created_at: new Date(1_800_000_000 * 1000).toISOString(),
        },
        { status: 201 },
      );
    }),
  );
  vi.stubGlobal("WebSocket", FakeSocket);
}

async function settled(): Promise<void> {
  for (let tick = 0; tick < 30; tick += 1) {
    await new Promise((done) => setTimeout(done, 0));
  }
}

function owned(): ThunderBridge {
  return new ThunderBridge(GATEWAY, { token: "hunter2", secret: SECRET });
}

beforeEach(() => {
  watched.length = 0;
  FakeSocket.opened.length = 0;
  serving();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a transfer answered by an agent", () => {
  it("hands the gateway this caller's name instead of a url to fetch", async () => {
    const transfer = await bankTransfer(owned(), {
      secret: SECRET,
      reference: REFERENCE,
      amountMinor: AMOUNT_MINOR,
      iban: IBAN,
      expiresAt: EXPIRES_AT,
      answerBy: "agent",
    });

    expect(transfer.verifyUrl).toBe(`agent:${(await callerKey(SECRET)).publicKeyHex}`);
    expect(transfer.verifyUrl).not.toContain("q=");
    expect(watched[0]?.["verify_url"]).toBe(transfer.verifyUrl);
  });

  it("still draws the same QR the payer scans", async () => {
    const transfer = await bankTransfer(owned(), {
      secret: SECRET,
      reference: REFERENCE,
      amountMinor: AMOUNT_MINOR,
      iban: IBAN,
      expiresAt: EXPIRES_AT,
      answerBy: "agent",
    });

    expect(transfer.spd).toBe(`SPD*1.0*ACC:${IBAN}*AM:480.55*CC:CZK*MSG:${REFERENCE}`);
  });

  it("refuses a polled transfer with no url to be polled at", async () => {
    await expect(
      bankTransfer(owned(), {
        secret: SECRET,
        reference: REFERENCE,
        amountMinor: AMOUNT_MINOR,
        iban: IBAN,
        expiresAt: EXPIRES_AT,
      }),
    ).rejects.toThrow("needs the verify url");
  });
});

describe("bankAgent", () => {
  async function attending(orders: (hash: string) => BankOrder | null) {
    const transfer = await bankTransfer(owned(), {
      secret: SECRET,
      reference: REFERENCE,
      amountMinor: AMOUNT_MINOR,
      iban: IBAN,
      expiresAt: EXPIRES_AT,
      answerBy: "agent",
    });
    const stop = bankAgent({ gateway: owned(), secret: SECRET, orders });
    await settled();

    return { transfer, stop, socket: FakeSocket.opened[0]! };
  }

  it("opens one socket on a ticket, so the secret never reaches a url", async () => {
    const { socket, stop } = await attending(() => null);

    expect(socket.url).toBe(`wss://gateway.example.net/ws/tickets/${encodeURIComponent(TICKET)}`);
    stop();
    expect(socket.closeCalls).toBe(1);
  });

  it("answers a preimage that hashes to what the gateway was given", async () => {
    const { transfer, socket } = await attending(() => order([credit()]));

    socket.onmessage?.({ data: JSON.stringify({ ask: "a1", payment_hash: transfer.paymentHash }) });
    await settled();

    const said = socket.said();
    expect(said["ask"]).toBe("a1");
    expect(said["settled"]).toBe(true);
    expect(
      createHash("sha256").update(Buffer.from(String(said["preimage"]), "hex")).digest("hex"),
    ).toBe(transfer.paymentHash);
  });

  it("says nothing settled while the statement holds nothing that pays it", async () => {
    const { transfer, socket } = await attending(() => order([credit({ amountMinor: 1 })]));

    socket.onmessage?.({ data: JSON.stringify({ ask: "a2", payment_hash: transfer.paymentHash }) });
    await settled();

    expect(socket.said()).toEqual({ ask: "a2", settled: false });
  });

  it("says nothing settled for a payment that is none of its own", async () => {
    const { socket } = await attending(() => null);

    socket.onmessage?.({ data: JSON.stringify({ ask: "a3", payment_hash: "ff".repeat(32) }) });
    await settled();

    expect(socket.said()).toEqual({ ask: "a3", settled: false });
  });

  it("looks the order up by the payment the gateway named, not by something of its own", async () => {
    const asked: string[] = [];
    const { transfer, socket } = await attending((paymentHash) => {
      asked.push(paymentHash);
      return null;
    });

    socket.onmessage?.({ data: JSON.stringify({ ask: "a4", payment_hash: transfer.paymentHash }) });
    await settled();

    expect(asked).toEqual([transfer.paymentHash]);
  });

  it("ignores a frame that is not an ask rather than answering it", async () => {
    const { socket } = await attending(() => order([credit()]));

    socket.onmessage?.({ data: "not json" });
    socket.onmessage?.({ data: JSON.stringify({ hello: true }) });
    await settled();

    expect(socket.sent).toHaveLength(0);
  });

  it("refuses to attend on a secret too short to derive a preimage from", () => {
    expect(() => bankAgent({ gateway: owned(), secret: "short", orders: () => null })).toThrow(
      "32 characters",
    );
  });
});
