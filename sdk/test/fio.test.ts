import { afterEach, describe, expect, it, vi } from "vitest";
import { fioStatement } from "../src/fio";
import { type FetchCall, jsonResponse } from "./harness";

const TOKEN = "t".repeat(64);
const BASE = "https://fioapi.fio.cz/v1/rest";
const SINCE = 1_780_000_000;
const BOOKED_MILLIS = 1_785_931_200_000;

function cell(value: string | number | null): { value: string | number | null } {
  return { value };
}

function transaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    column22: cell(1_148_734_530),
    column0: cell(BOOKED_MILLIS),
    column1: cell(480.55),
    column14: cell("CZK"),
    column16: cell("ORDER-2026-77"),
    column5: null,
    column7: null,
    column27: null,
    ...overrides,
  };
}

function statementOf(...transactions: Record<string, unknown>[]): unknown {
  return {
    accountStatement: {
      info: { accountId: "2400222222", currency: "CZK" },
      transactionList: { transaction: transactions },
    },
  };
}

function fioServing(body: unknown, status = 200): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse(body, status);
    }),
  );

  return calls;
}

function reading(): ReturnType<typeof fioStatement> {
  return fioStatement({ token: TOKEN, minIntervalSecs: 0 });
}

describe("fioStatement", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for the period the statement covers, with the token in the path", async () => {
    const calls = fioServing(statementOf());

    await reading()(SINCE);

    expect(calls[0]!.url.startsWith(`${BASE}/periods/${TOKEN}/`)).toBe(true);
    expect(calls[0]!.url).toContain(`/${new Date(SINCE * 1000).toISOString().slice(0, 10)}/`);
    expect(calls[0]!.url.endsWith("/transactions.json")).toBe(true);
  });

  it("reads a credit into the shape the verify endpoint matches on", async () => {
    fioServing(statementOf(transaction()));

    const credits = await reading()(SINCE);

    expect(credits).toEqual([
      {
        amountMinor: 48_055,
        currency: "CZK",
        reference: "ORDER-2026-77",
        bookedAt: BOOKED_MILLIS / 1000,
      },
    ]);
  });

  it("keeps money that came in and drops money that went out", async () => {
    fioServing(statementOf(transaction(), transaction({ column1: cell(-480.55) })));

    const credits = await reading()(SINCE);

    expect(credits).toHaveLength(1);
  });

  it("gathers every field a payer can write into, and skips the ones Fio left null", async () => {
    fioServing(
      statementOf(
        transaction({
          column16: cell("note"),
          column5: cell("1234567890"),
          column7: cell("Novak, Jan"),
          column27: cell("2000000003"),
        }),
      ),
    );

    const credits = await reading()(SINCE);

    expect(credits[0]!.reference).toBe("note 1234567890 Novak, Jan 2000000003");
  });

  it("survives a transaction where every optional field is null", async () => {
    fioServing(statementOf({ column1: cell(1), column0: null, column14: null }));

    const credits = await reading()(SINCE);

    expect(credits).toEqual([{ amountMinor: 100, currency: "", reference: "", bookedAt: 0 }]);
  });

  it("reads an empty period, whether the list is empty or absent", async () => {
    fioServing({ accountStatement: { transactionList: null } });

    expect(await reading()(SINCE)).toEqual([]);
  });

  it("names the rate limit rather than reporting a bare conflict", async () => {
    fioServing({}, 409);

    await expect(reading()(SINCE)).rejects.toThrow("30 second window");
  });

  it("says it could not read the statement on any other refusal", async () => {
    fioServing({}, 401);

    await expect(reading()(SINCE)).rejects.toThrow("fio answered 401");
  });

  it("uses each token in turn, always the one unused longest", async () => {
    const calls = fioServing(statementOf(transaction()));
    const statement = fioStatement({ token: ["one", "two", "three"], minIntervalSecs: 0 });

    await statement(SINCE);
    await statement(SINCE);
    await statement(SINCE);
    await statement(SINCE);

    const used = calls.map((call) => new URL(call.url).pathname.split("/")[4]);
    expect(used).toEqual(["one", "two", "three", "one"]);
  });

  it("never asks one token twice inside its own window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const calls = fioServing(statementOf(transaction()));
    const statement = fioStatement({ token: ["one", "two"] });

    const used: (string | undefined)[] = [];
    for (let second = 0; second <= 60; second += 1) {
      vi.setSystemTime(second * 1000);
      await statement(SINCE);
    }
    for (const call of calls) used.push(new URL(call.url).pathname.split("/")[4]);
    vi.useRealTimers();

    expect(used).toEqual(["one", "two", "one", "two", "one"]);
  });

  it("counts a token given twice only once, so it buys no extra reads", async () => {
    const calls = fioServing(statementOf(transaction()));
    const statement = fioStatement({ token: ["one", "one"], minIntervalSecs: 0 });

    await statement(SINCE);
    await statement(SINCE);

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => new URL(call.url).pathname.split("/")[4])).toEqual(["one", "one"]);
  });

  it("refuses a list with no token in it", () => {
    expect(() => fioStatement({ token: [] })).toThrow("at least one token");
  });

  it("holds the last answer rather than reading twice inside the window", async () => {
    const calls = fioServing(statementOf(transaction()));
    const statement = fioStatement({ token: TOKEN });

    const first = await statement(SINCE);
    const second = await statement(SINCE);

    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("reads again once the window has passed", async () => {
    const calls = fioServing(statementOf(transaction()));
    const statement = fioStatement({ token: TOKEN, minIntervalSecs: 0 });

    await statement(SINCE);
    await statement(SINCE);

    expect(calls).toHaveLength(2);
  });
});
