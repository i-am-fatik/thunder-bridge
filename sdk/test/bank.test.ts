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
import { jsonResponse, throughFetch, type FetchCall } from "./harness";

vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "203.0.113.1", family: 4 }],
}));

const SECRET = "keep-me-server-side-and-thirty-two-plus";
const OTHER_IBAN = "CZ9455000000001028912385";
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

const PROBE = "/incoming-payments/is-this-gateway-yours";

function watching(
  answer?: (body: Record<string, unknown>) => Response,
  servesStrangers = false,
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith(PROBE)) {
        return jsonResponse({}, servesStrangers ? 404 : 401);
      }
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

function owned(): ThunderBridge {
  return new ThunderBridge(GATEWAY, { token: "hunter2" });
}

function asking(overrides: Partial<BankTransferParams> = {}): BankTransferParams {
  return {
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

  return bankTransfer(owned(), asking(overrides));
}

async function verified(statement: Statement, url: string): Promise<Response> {
  return bankVerifyEndpoint({ secret: SECRET, iban: IBAN, statement })(new Request(url));
}

describe("bankTransfer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a QR platba payload a banking app can read", async () => {
    const transfer = await asked();

    expect(transfer.spd).toBe(`SPD*1.0*ACC:${IBAN}*AM:480.55*CC:CZK*MSG:${REFERENCE}`);
  });

  it("takes an account however it was spelled and draws one clean QR from it", async () => {
    const spaced = await asked({ iban: "cz65 0800 0000 1920 0014 5399" });
    const plain = await asked();

    expect(spaced.spd).toBe(plain.spd);
    expect(spaced.paymentHash).toBe(plain.paymentHash);
  });

  it("carries the variable symbol only when one was asked for", async () => {
    const transfer = await asked({ variableSymbol: "1234567890" });

    expect(transfer.spd).toContain("*X-VS:1234567890");
  });

  it("puts one sealed blob in the verify url and nothing else", async () => {
    const transfer = await asked();
    const url = new URL(transfer.verifyUrl);

    expect(url.origin + url.pathname).toBe(MOUNT);
    expect([...url.searchParams.keys()]).toEqual(["q"]);
    expect(url.searchParams.get("q")).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
  });

  it("tells whoever carries the url neither the account, the amount nor the reference", async () => {
    const transfer = await asked();

    expect(transfer.verifyUrl).not.toContain(REFERENCE);
    expect(transfer.verifyUrl).not.toContain(String(AMOUNT_MINOR));
    expect(transfer.verifyUrl).not.toContain("480.55");
    expect(transfer.verifyUrl).not.toContain(IBAN);
    expect(transfer.verifyUrl).not.toContain("CZK");
  });

  it("names a different payment for the same order paid into another account", async () => {
    const here = await asked();
    const there = await asked({ iban: OTHER_IBAN });

    expect(there.paymentHash).not.toBe(here.paymentHash);
  });

  it("refuses a secret too short to seal with, rather than sealing weakly", async () => {
    watching();

    await expect(bankTransfer(owned(), asking({ secret: "too-short" }))).rejects.toThrow(
      "32 characters",
    );
  });

  it("registers the watch itself, with the hash and nothing else the gateway does not need", async () => {
    const calls = watching();

    const transfer = await bankTransfer(owned(), asking());

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

    await bankTransfer(owned(), asking({ trigger: "the-shop-holds-this", sealed: "v1.opaque" }));

    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(body["trigger"]).toBe(createHash("sha256").update("the-shop-holds-this").digest("hex"));
    expect(body["sealed"]).toBe("v1.opaque");
  });

  it("asks the gateway to keep the trigger's settlements when the transfer says how many", async () => {
    const calls = watching();

    await bankTransfer(owned(), asking({ trigger: "the-shop-holds-this", replay: 10 }));

    expect((JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>)["replay"]).toBe(10);
  });

  it("sends the bearer, because a gateway of your own asks for one", async () => {
    const calls = watching();

    await bankTransfer(owned(), asking());

    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe(
      "Bearer hunter2",
    );
  });

  it("refuses a gateway that serves strangers, because its operator would read the order book", async () => {
    watching(undefined, true);

    await expect(bankTransfer(new ThunderBridge(GATEWAY), asking())).rejects.toThrow(
      "not yours",
    );
  });

  it("refuses a gateway that serves strangers even when a token was configured against it", async () => {
    watching(undefined, true);

    await expect(
      bankTransfer(new ThunderBridge(GATEWAY, { token: "wishful" }), asking()),
    ).rejects.toThrow("not yours");
  });

  it("accepts a gateway that refuses strangers, whatever the caller configured", async () => {
    watching();

    const transfer = await bankTransfer(new ThunderBridge(GATEWAY), asking());

    expect(transfer.id).toBe(WATCH_ID);
  });

  it("registers on a public gateway only when told the order book is not worth hiding", async () => {
    const calls = watching(undefined, true);

    const transfer = await bankTransfer(
      new ThunderBridge(GATEWAY),
      asking({ allowPublicGateway: true }),
    );

    expect(transfer.id).toBe(WATCH_ID);
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("refuses before it registers anything, so a bad ask reaches no gateway", async () => {
    const calls = watching();

    await expect(bankTransfer(owned(), asking({ secret: "short" }))).rejects.toThrow("32 characters");
    await expect(bankTransfer(owned(), asking({ iban: "12345" }))).rejects.toThrow("is not an IBAN");
    await expect(bankTransfer(owned(), asking({ amountMinor: 0 }))).rejects.toThrow("above zero");
    await expect(bankTransfer(owned(), asking({ amountMinor: 1.5 }))).rejects.toThrow("whole number");
    await expect(bankTransfer(owned(), asking({ reference: "" }))).rejects.toThrow("no reference");
    await expect(bankTransfer(owned(), asking({ reference: "A*B" }))).rejects.toThrow("asterisk");
    await expect(bankTransfer(owned(), asking({ variableSymbol: "nope" }))).rejects.toThrow("ten digits");
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

  it("agrees to be polled, so the gateway does not take a caller's word for it", async () => {
    const transfer = await asked();
    const handler = bankVerifyEndpoint({ secret: SECRET, iban: IBAN, statement: statementOf() });
    const answer = await handler(
      new Request(transfer.verifyUrl, {
        method: "POST",
        body: JSON.stringify({ type: "verify-challenge", nonce: "a1b2c3" }),
      }),
    );

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ nonce: "a1b2c3" });
  });

  it("reads a payment as before when the POST is not a challenge", async () => {
    const transfer = await asked();
    const handler = bankVerifyEndpoint({ secret: SECRET, iban: IBAN, statement: statementOf() });
    const answer = await handler(
      new Request(transfer.verifyUrl, { method: "POST", body: JSON.stringify({ type: "other" }) }),
    );

    expect(await answer.json()).toEqual({ settled: false });
  });

  it("names the pace it wants to be polled at, so the gateway does not pick one", async () => {
    const transfer = await asked();
    const answer = await verified(statementOf(), transfer.verifyUrl);

    expect(answer.headers.get("cache-control")).toBe("max-age=30");
  });

  it("takes a pace of your own, because a bank that moves hourly should say so", async () => {
    const transfer = await asked();
    const url = new URL(transfer.verifyUrl);
    const handler = bankVerifyEndpoint({
      secret: SECRET,
      iban: IBAN,
      statement: statementOf(),
      pollEverySecs: 900,
    });

    expect((await handler(new Request(url))).headers.get("cache-control")).toBe("max-age=900");
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

  it("refuses a question it did not seal, so it is no statement oracle", async () => {
    const answer = await verified(statementOf(credit()), `${MOUNT}?q=v1.AAAAAAAAAAAAAAAAAAAA`);

    expect(answer.status).toBe(403);
    expect(await answer.json()).toEqual({ settled: false });
  });

  it("refuses a blob edited on the way, however small the edit", async () => {
    const transfer = await asked();
    const sealed = new URL(transfer.verifyUrl).searchParams.get("q") ?? "";
    const at = Math.floor(sealed.length / 2);
    const flipped = sealed.slice(0, at) + (sealed[at] === "A" ? "B" : "A") + sealed.slice(at + 1);

    const answer = await verified(statementOf(credit()), `${MOUNT}?q=${flipped}`);

    expect(answer.status).toBe(403);
  });

  it("refuses a question sealed for another account, even holding the same secret", async () => {
    const transfer = await asked({ iban: OTHER_IBAN });
    const handler = bankVerifyEndpoint({
      secret: SECRET,
      iban: IBAN,
      statement: statementOf(credit()),
    });

    const answer = await handler(new Request(transfer.verifyUrl));

    expect(answer.status).toBe(403);
    expect(await answer.json()).toEqual({ settled: false });
  });

  it("answers the account it was mounted for, when that is the one asked about", async () => {
    const transfer = await asked({ iban: OTHER_IBAN });
    const handler = bankVerifyEndpoint({
      secret: SECRET,
      iban: OTHER_IBAN,
      statement: statementOf(credit()),
    });

    expect(await (await handler(new Request(transfer.verifyUrl))).json()).toEqual({
      settled: true,
      preimage: expect.any(String),
    });
  });

  it("carries a reference with a pipe in it through the seal unharmed", async () => {
    const reference = "ORDER|2026|77";
    const transfer = await asked({ reference });
    const answer = await verified(
      statementOf(credit({ reference: `PLATBA ${reference} DIKY` })),
      transfer.verifyUrl,
    );

    expect(await answer.json()).toEqual({ settled: true, preimage: expect.any(String) });
  });

  it("refuses to mount on a secret too short to seal with", () => {
    expect(() =>
      bankVerifyEndpoint({ secret: "too-short", iban: IBAN, statement: statementOf() }),
    ).toThrow("32 characters");
  });

  it("refuses to mount on something that is not an account", () => {
    expect(() =>
      bankVerifyEndpoint({ secret: SECRET, iban: "12345", statement: statementOf() }),
    ).toThrow("is not an IBAN");
  });

  it("answers for its account however the operator spelled it", async () => {
    const transfer = await asked();
    const handler = bankVerifyEndpoint({
      secret: SECRET,
      iban: "cz65 0800 0000 1920 0014 5399",
      statement: statementOf(credit()),
    });

    expect(await (await handler(new Request(transfer.verifyUrl))).json()).toEqual({
      settled: true,
      preimage: expect.any(String),
    });
  });

  it("refuses the query shape it used to answer, rather than reading it", async () => {
    const answer = await verified(
      statementOf(credit()),
      `${MOUNT}?ref=${REFERENCE}&minor=${AMOUNT_MINOR}&cc=CZK&sig=${"f".repeat(64)}`,
    );

    expect(answer.status).toBe(400);
  });

  it("refuses a query carrying no sealed blob at all", async () => {
    const answer = await verified(statementOf(credit()), `${MOUNT}?ref=x`);

    expect(answer.status).toBe(400);
  });
});

describe("a bank transfer against the gateway's own settlement check", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mounted(config: { secret: string; iban: string; statement: Statement }): void {
    const handler = bankVerifyEndpoint(config);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: RequestInfo | URL) => handler(new Request(String(url)))),
    );
  }

  it("settles with nothing added to the gateway", async () => {
    const transfer = await asked();
    mounted({ secret: SECRET, iban: IBAN, statement: statementOf(credit()) });

    expect((await checkSettled(throughFetch, transfer.verifyUrl, transfer.paymentHash)).preimage).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("stays unsettled while nothing has landed, and says how soon to ask again", async () => {
    const transfer = await asked();
    mounted({ secret: SECRET, iban: IBAN, statement: statementOf() });

    expect(await checkSettled(throughFetch, transfer.verifyUrl, transfer.paymentHash)).toEqual({
      preimage: null,
      pace: 30,
      ceiling: null,
    });
  });

  it("cannot be settled by a server holding a different secret", async () => {
    const transfer = await asked();
    mounted({ secret: "not-the-secret-but-also-thirty-two", iban: IBAN, statement: statementOf(credit()) });

    await expect(checkSettled(throughFetch, transfer.verifyUrl, transfer.paymentHash)).rejects.toThrow(
      "answered 403",
    );
  });

  it("cannot be settled by a preimage that was not derived from the secret", async () => {
    const transfer = await asked();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ settled: true, preimage: "11".repeat(32) })),
    );

    await expect(checkSettled(throughFetch, transfer.verifyUrl, transfer.paymentHash)).rejects.toThrow(
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
      transfers.push(await bankTransfer(owned(), asking({ reference: `ORDER-${order}` })));
    }

    const statement = fioStatement({ token: "one-token" });
    const counted = fioServing(
      orders.map((order) => credit({ reference: `PLATBA ORDER-${order}` })),
    );
    const verify = bankVerifyEndpoint({ secret: SECRET, iban: IBAN, statement });

    const answers = [];
    for (const transfer of transfers) {
      answers.push(await (await verify(new Request(transfer.verifyUrl))).json());
    }

    expect(counted.reads).toBe(1);
    expect(answers.every((answer) => (answer as { settled: boolean }).settled)).toBe(true);
  });
});
