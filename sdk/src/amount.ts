import { minorScaleOf, minorUnitsOf } from "./currency.js";
import { AmountError } from "./errors.js";
import { medianOf, msatFor, type Ticker } from "./price.js";

declare const brand: unique symbol;

const MSAT_PER_SAT = 1000;
const MAX_SATS = Math.floor(Number.MAX_SAFE_INTEGER / MSAT_PER_SAT);

/**
 * A whole number of millisatoshi that came from `sats`, `msat` or `fiat`, and
 * could not have come from anywhere else.
 *
 * The brand is why: a bare number is not one of these, so `21` cannot be passed
 * where a price is wanted and quietly mean twenty-one thousandths of a satoshi.
 * It costs nothing at runtime, where the value is an ordinary number
 */
export type Msat = number & { readonly [brand]: "Msat" };

/**
 * What a payment is worth. A `Msat` is a price known now, and a function is one
 * worked out when the invoice is minted, which is what a fiat price has to be.
 *
 * Build one with `sats`, `msat` or `fiat`
 */
export type Amount = Msat | (() => Msat | Promise<Msat>);

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
export function sats(whole: number): Msat {
  if (!Number.isInteger(whole) || whole < 1 || whole > MAX_SATS) {
    throw new AmountError("not-whole-satoshi", `${whole} is not a payable count of satoshi`);
  }

  return (whole * MSAT_PER_SAT) as Msat;
}

/** An exact number of millisatoshi, for a price already in the smallest unit */
export function msat(exact: number): Msat {
  if (!Number.isSafeInteger(exact) || exact < 1) {
    throw new AmountError(
      "not-whole-millisatoshi",
      `${exact} is not a payable count of millisatoshi`,
    );
  }

  return exact as Msat;
}

/**
 * A price named in fiat, converted when the invoice is minted rather than now.
 *
 * Name it as a string and it is read digit by digit, exactly. Name it as a
 * number and it is rounded to the currency's ISO 4217 minor unit, because
 * binary floating point cannot hold 4.99 and a payment library that pretends
 * otherwise moves the wrong amount.
 *
 * Every conversion asks the rate afresh, so two calls a second apart can
 * differ. That is the honest behaviour for a fiat price, and the reason an
 * amount is a function rather than a number
 */
export function fiat(
  major: number | string,
  currency: string,
  options?: FiatOptions,
): () => Promise<Msat> {
  const amountMinor = minorFrom(major, currency);
  const rate = options?.rate ?? medianOf();

  return async () =>
    msat(msatFor(amountMinor, await rate(currency), { spreadBps: options?.spreadBps }));
}

/**
 * What an `Amount` comes to right now. A fiat price asks its rate here, so two
 * calls a second apart give two numbers, and this is the only place that happens
 */
export async function amountNow(amount: Amount): Promise<Msat> {
  return typeof amount === "function" ? msat(await amount()) : msat(amount);
}

function minorFrom(major: number | string, currency: string): number {
  const digits = minorUnitsOf(currency);
  if (typeof major === "number") {
    return payable(Math.round(major * minorScaleOf(currency)), major, currency);
  }

  const parsed = /^(\d+)(?:[.,](\d+))?$/.exec(major.trim());
  if (parsed === null) {
    throw new AmountError(
      "not-a-decimal",
      `${major} is not a decimal ${currency.toUpperCase()} amount`,
    );
  }

  const fraction = parsed[2] ?? "";
  if (fraction.length > digits) {
    throw new AmountError(
      "too-precise",
      `${major} carries more decimals than ${currency.toUpperCase()} has, which is ${digits}`,
    );
  }

  return payable(Number(`${parsed[1]}${fraction.padEnd(digits, "0")}`), major, currency);
}

function payable(minor: number, major: number | string, currency: string): number {
  if (!Number.isSafeInteger(minor) || minor < 1) {
    throw new AmountError(
      "not-a-decimal",
      `${major} is not a ${currency.toUpperCase()} price this can charge`,
    );
  }

  return minor;
}
