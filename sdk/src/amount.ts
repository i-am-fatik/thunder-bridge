import { minorScaleOf, minorUnitsOf } from "./currency.js";
import { medianOf, msatFor, type Ticker } from "./price.js";

const MSAT_PER_SAT = 1000;
const MAX_SATS = Number.MAX_SAFE_INTEGER / MSAT_PER_SAT;

/**
 * What a payment is worth, in millisatoshi. A whole number is that many
 * millisatoshi, and a function is a price worked out when the invoice is minted,
 * which is what a fiat price has to be.
 *
 * Build one with `sats`, `msat` or `fiat` rather than by hand. A bare number is
 * accepted so a caller who already holds millisatoshi passes it straight through
 */
export type Amount = number | (() => number | Promise<number>);

/** How a fiat price is turned into millisatoshi at the moment of minting */
export interface FiatOptions {
  /**
   * Where the rate comes from, the median of the four MiCA authorised venues by
   * default. Pass your own to price off one venue, off your own book, or off a
   * number you already hold
   */
  rate?: Ticker;

  /**
   * What you add over the rate, in basis points, none by default. A Lightning
   * invoice lives an hour and a bank transfer takes days, so a shop pricing in
   * fiat carries that volatility whether or not it charges for it
   */
  spreadBps?: number;
}

/** A whole number of satoshi, so `sats(21)` is 21000 millisatoshi */
export function sats(whole: number): number {
  if (!Number.isInteger(whole) || whole < 1 || whole > MAX_SATS) {
    throw new Error(`${whole} is not a whole number of satoshi this can pay`);
  }

  return whole * MSAT_PER_SAT;
}

/** An exact number of millisatoshi, for a price that is already in the smallest unit */
export function msat(exact: number): number {
  if (!Number.isSafeInteger(exact) || exact < 1) {
    throw new Error(`${exact} is not a whole number of millisatoshi this can pay`);
  }

  return exact;
}

/**
 * A price named in fiat, converted when the invoice is minted rather than now.
 *
 * The major amount may be a string, which is read exactly, digit by digit. Given
 * a number it is rounded to the currency's ISO 4217 minor unit, because binary
 * floating point cannot hold 4.99 and a payment library that pretends otherwise
 * moves the wrong amount.
 *
 * Every conversion asks the rate afresh, so two calls a second apart can differ.
 * That is the honest behaviour for a fiat price and the reason the amount is a
 * function rather than a number
 */
export function fiat(
  major: number | string,
  currency: string,
  options?: FiatOptions,
): () => Promise<number> {
  const amountMinor = minorFrom(major, currency);
  const rate = options?.rate ?? medianOf();

  return async () => msatFor(amountMinor, await rate(currency), { spreadBps: options?.spreadBps });
}

/** What an `Amount` comes to right now, which is the only place a price is asked for */
export async function millisatoshi(amount: Amount): Promise<number> {
  const settled = typeof amount === "function" ? await amount() : amount;
  if (!Number.isSafeInteger(settled) || settled < 1) {
    throw new Error(`${settled} is not a whole number of millisatoshi this can pay`);
  }

  return settled;
}

function minorFrom(major: number | string, currency: string): number {
  const digits = minorUnitsOf(currency);
  if (typeof major === "number") {
    const minor = Math.round(major * minorScaleOf(currency));
    if (!Number.isSafeInteger(minor) || minor < 1) {
      throw new Error(`${major} is not a ${currency.toUpperCase()} price this can charge`);
    }

    return minor;
  }

  const parsed = /^(\d+)(?:[.,](\d+))?$/.exec(major.trim());
  if (parsed === null) {
    throw new Error(`${major} is not a decimal ${currency.toUpperCase()} amount`);
  }

  const fraction = parsed[2] ?? "";
  if (fraction.length > digits) {
    throw new Error(
      `${major} has more decimals than ${currency.toUpperCase()} has, which is ${digits}`,
    );
  }

  const minor = Number(`${parsed[1]}${fraction.padEnd(digits, "0")}`);
  if (!Number.isSafeInteger(minor) || minor < 1) {
    throw new Error(`${major} is not a ${currency.toUpperCase()} price this can charge`);
  }

  return minor;
}
