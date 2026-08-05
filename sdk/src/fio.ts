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

export interface FioConfig {
  /**
   * A token with "Sledování účtu" rights, which is read only and cannot move
   * money. One token is one account, which is why this takes no account number
   */
  token: string;

  /**
   * Fio asks for at most one read per token every 30 seconds, and the gateway
   * polls faster than that, so the last answer is held for this long and handed
   * back instead of asking again. Only helps a process that stays up
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
 * and the date is unix milliseconds. This reads all three the way the bank
 * documents them and treats a missing field as absent rather than guessing.
 */
export function fioStatement(config: FioConfig): Statement {
  const holdFor = (config.minIntervalSecs ?? DEFAULT_MIN_INTERVAL_SECS) * MILLIS;
  let asked = 0;
  let credits: Credit[] = [];

  return async (sinceUnix: number) => {
    if (Date.now() - asked < holdFor) return credits;

    const url = [
      config.baseUrl ?? BASE_URL,
      "periods",
      config.token,
      asDate(sinceUnix),
      asDate(Math.floor(Date.now() / MILLIS)),
      "transactions.json",
    ].join("/");

    const answer = await fetch(url, { headers: { accept: "application/json" } });
    if (answer.status === TOO_SOON) {
      throw new Error("fio refuses a second read of this token inside its 30 second window");
    }
    if (!answer.ok) throw new Error(`fio answered ${answer.status} reading the statement`);

    const read = (await answer.json()) as FioStatement;
    asked = Date.now();
    credits = (read.accountStatement?.transactionList?.transaction ?? [])
      .filter(isCredit)
      .map(asCredit);

    return credits;
  };
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
    bookedAt: Math.floor(numberIn(transaction[BOOKED_AT]) / MILLIS),
  };
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
