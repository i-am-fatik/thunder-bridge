import type { Credit, Statement } from "./bank.js";

const BASE_URL = "https://fioapi.fio.cz/v1/rest";
const MINOR_UNITS = 100;
const MILLIS = 1000;
const DATE_CHARS = "2026-08-04".length;
const DEFAULT_MIN_INTERVAL_SECS = 30;
const TOO_SOON = 409;
const BOOKED_AT = "column0";
const AMOUNT = "column1";
const CURRENCY = "column14";
const VARIABLE_SYMBOL = "column5";
const USER_IDENTIFICATION = "column7";
const MESSAGE_FOR_RECIPIENT = "column16";
const PAYER_REFERENCE = "column27";
const WHERE_A_PAYER_WRITES = [
  MESSAGE_FOR_RECIPIENT,
  VARIABLE_SYMBOL,
  USER_IDENTIFICATION,
  PAYER_REFERENCE,
];
const UTC_OFFSET = /^[+-]\d{4}$/;

export interface FioConfig {
  /**
   * A token with "Sledování účtu" rights, which is read only and cannot move
   * money. One token is one account, which is why this takes no account number.
   *
   * Give it several and they are used in turn. Fio's window is per token rather
   * than per account, so five tokens on one account is a read every six seconds,
   * and generating another token for the same account is what Fio's own
   * documentation suggests when one is not enough
   */
  token: string | string[];

  /**
   * Fio's window for one token, 30 seconds. No token is ever asked twice inside
   * it, and the gap between reads is this divided by however many tokens were
   * given, so the answers stay evenly spaced rather than arriving in bursts.
   * Inside that gap the last answer is handed back. Only helps a process that
   * stays up
   */
  minIntervalSecs?: number;

  /** Override to point at a mock */
  baseUrl?: string;
}

type Cell = { value: string | number | null } | null | undefined;
type FioTransaction = Record<string, Cell>;

interface FioStatement {
  accountStatement?: {
    transactionList?: { transaction?: FioTransaction[] | null } | null;
  };
}

/**
 * Read one Fio account as a `Statement`, so a bank transfer proves itself the
 * way a Lightning payment does.
 *
 * The token is the read only kind, generated in internetbanking under Nastavení
 * and API, and it is the whole configuration: a token belongs to one account, so
 * there is no account number to get wrong. It cannot pay anyone, and the worst a
 * leaked one costs you is that someone else can read the statement.
 *
 * Every field on a Fio transaction is optional and arrives as `null` when it is
 * absent, the amount carries its direction in its sign rather than in a flag,
 * and the date is a day and a UTC offset, `2026-07-15+0200`. This reads all
 * three the way the bank answers them and treats a missing field as absent
 * rather than guessing.
 */
export function fioStatement(config: FioConfig): Statement {
  const named = typeof config.token === "string" ? [config.token] : config.token;
  if (named.length === 0) throw new Error("fioStatement needs at least one token to read with");

  const usedAt = new Map(named.map((token) => [token, Number.NEGATIVE_INFINITY]));
  const tokenWindowMs = (config.minIntervalSecs ?? DEFAULT_MIN_INTERVAL_SECS) * MILLIS;
  const paceMs = tokenWindowMs / usedAt.size;
  let lastRead = Number.NEGATIVE_INFINITY;
  let credits: Credit[] = [];

  return async (sinceUnix: number) => {
    const now = Date.now();
    if (now - lastRead < paceMs) return credits;

    const idlest = longestUnused(usedAt);
    if (now - idlest.usedAt < tokenWindowMs) return credits;

    usedAt.set(idlest.token, now);
    lastRead = now;

    const url = [
      config.baseUrl ?? BASE_URL,
      "periods",
      idlest.token,
      asDate(sinceUnix),
      asDate(Math.floor(now / MILLIS)),
      "transactions.json",
    ].join("/");

    const answer = await fetch(url, { headers: { accept: "application/json" } });
    if (answer.status === TOO_SOON) {
      throw new Error("fio refuses a second read of this token inside its 30 second window");
    }
    if (!answer.ok) throw new Error(`fio answered ${answer.status} reading the statement`);

    const read = (await answer.json()) as FioStatement;
    credits = (read.accountStatement?.transactionList?.transaction ?? [])
      .filter(isCredit)
      .map(asCredit);

    return credits;
  };
}

function longestUnused(usedAt: Map<string, number>): { token: string; usedAt: number } {
  let token = "";
  let idleSince = Number.POSITIVE_INFINITY;
  for (const [candidate, at] of usedAt) {
    if (at < idleSince) {
      token = candidate;
      idleSince = at;
    }
  }

  return { token, usedAt: idleSince };
}

function isCredit(transaction: FioTransaction): boolean {
  return numberIn(transaction[AMOUNT]) > 0;
}

function asCredit(transaction: FioTransaction): Credit {
  return {
    amountMinor: Math.round(numberIn(transaction[AMOUNT]) * MINOR_UNITS),
    currency: textIn(transaction[CURRENCY]),
    reference: WHERE_A_PAYER_WRITES.map((column) => textIn(transaction[column]))
      .filter((written) => written.length > 0)
      .join(" "),
    bookedAt: bookedAtIn(transaction[BOOKED_AT]),
  };
}

function bookedAtIn(cell: Cell): number {
  const value = cell?.value;
  if (typeof value === "number") return Math.floor(value / MILLIS);

  const at = Date.parse(asIso8601(textIn(cell)));

  return Number.isFinite(at) ? Math.floor(at / MILLIS) : 0;
}

function asIso8601(booked: string): string {
  const day = booked.slice(0, DATE_CHARS);
  const zone = booked.slice(DATE_CHARS);
  if (!UTC_OFFSET.test(zone)) return `${day}T00:00:00Z`;

  return `${day}T00:00:00${zone.slice(0, 3)}:${zone.slice(3)}`;
}

function numberIn(cell: Cell): number {
  const value = Number(cell?.value ?? Number.NaN);

  return Number.isFinite(value) ? value : 0;
}

function textIn(cell: Cell): string {
  const value = cell?.value;

  return value === null || value === undefined ? "" : String(value).trim();
}

function asDate(unix: number): string {
  return new Date(unix * MILLIS).toISOString().slice(0, DATE_CHARS);
}
