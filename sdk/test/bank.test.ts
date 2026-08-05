import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSettled } from "../../core/lnurl.js";
import {
  type BankTransfer,
  type BankTransferParams,
  bankTransfer,
  bankVerifyEndpoint,
  type Credit,
  type Statement,
} from "../src/bank";
import { ThunderBridge } from "../src/client";
import { fioStatement } from "../src/fio";
import { type FetchCall, jsonResponse } from "./harness";

const SECRET = "keep-me-server-side";
const REFERENCE = "ORDER-2026-77";
const AMOUNT_MINOR = 48_055;
const IBAN = "CZ6508000000192000145399";
const MOUNT = "https://shop.example.org/verify/bank";
const GATEWAY = "https://gateway.example.net";
const EXPIRES_AT = 1_900_000_000;
const WATCH_ID = "watch_0001";

function credit(overrides: Partial<Credit> = {}): Credit {
  return {
    amountMinor: AMOUNT_MINOR,
    currency: "CZK",
    reference: `PLATBA ${REFERENCE} DIKY`,
    bookedAt: 1_780_000_000,
    ...overrides,
  };
}

function statementOf(...credits: Credit[]): Statement {
  return async () => credits;
}

function watching(answer?: (body: Record<string, unknown>) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (answer) return answer(body);

      return jsonResponse(
        {
          id: WATCH_ID,
          status: "pending",
          payment_hash: body["payment_hash"],
          verify_url: body["verify_url"],
          preimage: null,
          expires_at: new Date(EXPIRES_AT * 1000).toISOString(),
          created_at: new Date(1_800_000_000 * 1000).toISOString(),
        },
        201,
      );
    }),
  );

  return calls;
}

function asking(overrides: Partial<BankTransferParams> = {}): BankTransferParams {
  return {
    gateway: new ThunderBridge(GATEWAY, { token: "hunter2" }),
    secret: SECRET,
    reference: REFERENCE,
    amountMinor: AMOUNT_MINOR,
    iban: IBAN,
    verifyUrl: MOUNT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

async function asked(overrides: Partial<BankTransferParams> = {}): Promise<BankTransfer> {
  watching();

  return bankTransfer(asking(overrides));
}

async function verified(statement: Statement, url: string): Promise<Response> {
  return bankVerifyEndpoint({ secret: SECRET, statement })(new Request(url));
}

describe("bankTransfer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a QR platba payload a banking app can read", async () => {
    const transfer = await asked();

    expect(transfer.spd).toBe(`SPD*1.0*ACC:${IBAN}*AM:480.55*CC:CZK*MSG:${REFERENCE}`);
  });

  it("carries the variable symbol only when one was asked for", async () => {
    const transfer = await asked({ variableSymbol: "1234567890" });

    expect(transfer.spd).toContain("*X-VS:1234567890");
  });

  it("puts what to look for and a signature over it in the verify url", async () => {
    const transfer = await asked();
    const url = new URL(transfer.verifyUrl);

    expect(url.origin + url.pathname).toBe(MOUNT);
    expect(url.searchParams.get("ref")).toBe(REFERENCE);
    expect(url.searchParams.get("minor")).toBe(String(AMOUNT_MINOR));
    expect(url.searchParams.get("cc")).toBe("CZK");
    expect(url.searchParams.get("sig")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("registers the watch itself, with the hash and nothing else the gateway does not need", async () => {
    const calls = watching();

    const transfer = await bankTransfer(asking());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${GATEWAY}/watched-payments`);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      payment_hash: transfer.paymentHash,
      verify_url: transfer.verifyUrl,
      expires_at: new Date(EXPIRES_AT * 1000).toISOString(),
    });
    expect(transfer.id).toBe(WATCH_ID);
  });

  it("puts the trigger on the watch as a hash, so one socket hears both rails", async () => {
    const calls = watching();

    await bankTransfer(asking({ trigger: "the-shop-holds-this", sealed: "v1.opaque" }));

    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(body["trigger"]).toBe(createHash("sha256").update("the-shop-holds-this").digest("hex"));
    expect(body["sealed"]).toBe("v1.opaque");
  });

  it("sends the bearer, because a gateway of your own asks for one", async () => {
    const calls = watching();

    await bankTransfer(asking());

    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe(
      "Bearer hunter2",
    );
  });

  it("refuses a gateway with no token, because its operator would read the order book", async () => {
    watching();

    await expect(bankTransfer(asking({ gateway: new ThunderBridge(GATEWAY) }))).rejects.toThrow(
      "not yours",
    );
  });

  it("registers on a public gateway only when told the order book is not worth hiding", async () => {
    const calls = watching();

    const transfer = await bankTransfer(
      asking({ gateway: new ThunderBridge(GATEWAY), allowPublicGateway: true }),
    );

    expect(transfer.id).toBe(WATCH_ID);
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("refuses before it registers anything, so a bad ask reaches no gateway", async () => {
    const calls = watching();

    await expect(bankTransfer(asking({ iban: "12345" }))).rejects.toThrow("is not an IBAN");
    await expect(bankTransfer(asking({ amountMinor: 0 }))).rejects.toThrow("above zero");
    await expect(bankTransfer(asking({ amountMinor: 1.5 }))).rejects.toThrow("whole number");
    await expect(bankTransfer(asking({ reference: "" }))).rejects.toThrow("no reference");
    await expect(bankTransfer(asking({ reference: "A*B" }))).rejects.toThrow("asterisk");
    await expect(bankTransfer(asking({ variableSymbol: "nope" }))).rejects.toThrow("ten digits");
    expect(calls).toHaveLength(0);
  });
});

describe("bankVerifyEndpoint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says nothing settled while the statement is empty", async () => {
    const transfer = await asked();
    const answer = await verified(statementOf(), transfer.verifyUrl);

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ settled: false });
  });

  it("releases a preimage that hashes to what the gateway was given", async () => {
    const transfer = await asked();
    const answer = await verified(statementOf(credit()), transfer.verifyUrl);
    const body = (await answer.json()) as { settled: boolean; preimage: string };

    expect(body.settled).toBe(true);
    expect(createHash("sha256").update(Buffer.from(body.preimage, "hex")).digest("hex")).toBe(
      transfer.paymentHash,
    );
  });

  it("holds out for the exact amount and currency", async () => {
    const transfer = await asked();
    const short = await verified(statementOf(credit({ amountMinor: 48_054 })), transfer.verifyUrl);
    const foreign = await verified(statementOf(credit({ currency: "EUR" })), transfer.verifyUrl);

    expect(await short.json()).toEqual({ settled: false });
    expect(await foreign.json()).toEqual({ settled: false });
  });

  it("needs the reference on the transfer, whatever case it comes back in", async () => {
    const transfer = await asked();
    const shouted = await verified(
      statementOf(credit({ reference: REFERENCE.toLowerCase() })),
      transfer.verifyUrl,
    );
    const wiped = await verified(statementOf(credit({ reference: "thanks" })), transfer.verifyUrl);

    expect(await shouted.json()).toEqual({ settled: true, preimage: expect.any(String) });
    expect(await wiped.json()).toEqual({ settled: false });
  });

  it("refuses to answer a question it did not sign, so it is no statement oracle", async () => {
    const transfer = await asked();
    const forged = new URL(transfer.verifyUrl);
    forged.searchParams.set("sig", "f".repeat(64));

    const answer = await verified(statementOf(credit()), forged.toString());

    expect(answer.status).toBe(403);
    expect(await answer.json()).toEqual({ settled: false });
  });

  it("refuses a probe for a different amount under a signature that was minted for this one", async () => {
    const transfer = await asked();
    const moved = new URL(transfer.verifyUrl);
    moved.searchParams.set("minor", "1");

    const answer = await verified(statementOf(credit({ amountMinor: 1 })), moved.toString());

    expect(answer.status).toBe(403);
  });

  it("refuses a query missing what it needs", async () => {
    const answer = await verified(statementOf(credit()), `${MOUNT}?ref=x`);

    expect(answer.status).toBe(400);
  });
});

describe("a bank transfer against the gateway's own settlement check", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mounted(config: { secret: string; statement: Statement }): void {
    const handler = bankVerifyEndpoint(config);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: RequestInfo | URL) => handler(new Request(String(url)))),
    );
  }

  it("settles with nothing added to the gateway", async () => {
    const transfer = await asked();
    mounted({ secret: SECRET, statement: statementOf(credit()) });

    expect(await checkSettled(transfer.verifyUrl, transfer.paymentHash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stays unsettled while nothing has landed", async () => {
    const transfer = await asked();
    mounted({ secret: SECRET, statement: statementOf() });

    expect(await checkSettled(transfer.verifyUrl, transfer.paymentHash)).toBeNull();
  });

  it("cannot be settled by a server holding a different secret", async () => {
    const transfer = await asked();
    mounted({ secret: "not-the-secret", statement: statementOf(credit()) });

    await expect(checkSettled(transfer.verifyUrl, transfer.paymentHash)).rejects.toThrow(
      "answered 403",
    );
  });

  it("cannot be settled by a preimage that was not derived from the secret", async () => {
    const transfer = await asked();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ settled: true, preimage: "11".repeat(32) })),
    );

    await expect(checkSettled(transfer.verifyUrl, transfer.paymentHash)).rejects.toThrow(
      "does not hash to",
    );
  });
});

describe("one statement read answers every order at once", () => {
  const FIO = "https://fioapi.fio.cz/v1/rest";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function fioServing(credits: Credit[]): { reads: number } {
    const counted = { reads: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.startsWith(FIO)) throw new Error(`nothing else should be fetched, got ${url}`);
        counted.reads += 1;
        return jsonResponse({
          accountStatement: {
            transactionList: {
              transaction: credits.map((paid) => ({
                column1: { value: paid.amountMinor / 100 },
                column14: { value: paid.currency },
                column16: { value: paid.reference },
                column0: { value: paid.bookedAt * 1000 },
              })),
            },
          },
        });
      }),
    );

    return counted;
  }

  it("reads the bank once for five orders, because Fio lists the whole account", async () => {
    watching();
    const orders = ["A", "B", "C", "D", "E"];
    const transfers = [];
    for (const order of orders) {
      transfers.push(await bankTransfer(asking({ reference: `ORDER-${order}` })));
    }

    const statement = fioStatement({ token: "one-token" });
    const counted = fioServing(
      orders.map((order) => credit({ reference: `PLATBA ORDER-${order}` })),
    );
    const verify = bankVerifyEndpoint({ secret: SECRET, statement });

    const answers = [];
    for (const transfer of transfers) {
      answers.push(await (await verify(new Request(transfer.verifyUrl))).json());
    }

    expect(counted.reads).toBe(1);
    expect(answers.every((answer) => (answer as { settled: boolean }).settled)).toBe(true);
  });
});
