import { minorScaleOf } from "./currency.js";

const MSAT_PER_BTC = 100_000_000_000;
const BASIS_POINTS = 10_000;
const DEFAULT_HOLD_SECS = 60;
const DEFAULT_MIN_VENUES = 2;
const DEFAULT_MAX_SPREAD_BPS = 200;
const MILLIS = 1000;

/**
 * How many minor units of `currency` one bitcoin costs at one venue, so 134883815
 * is 1,348,838.15 CZK. Throws when that venue does not quote that currency, which
 * is a normal answer rather than a fault: Kraken and Bitstamp have no CZK pair
 *
 * This is the plugin seam for prices. Another venue is another function of this
 * shape
 */
export type Ticker = (currency: string) => Promise<number>;

export interface MedianOptions {
  /**
   * How many venues have to answer before a price is usable. Two is the floor
   * worth having, because one venue is a number nobody checked
   */
  minVenues?: number;

  /**
   * Refuse the lot when the cheapest and dearest answers are further apart than
   * this many basis points. Venues normally sit inside 50, so a wider spread means
   * one of them is broken or stale rather than that the market moved
   */
  maxSpreadBps?: number;

  /** Hold the last answer this long per currency, so an order page is not four requests */
  holdForSecs?: number;
}

/** Coinbase, CASP authorised in Luxembourg. Quotes CZK, EUR and most fiat */
export function coinbase(baseUrl = "https://api.coinbase.com"): Ticker {
  return async (currency: string) => {
    const asked = currency.toUpperCase();
    const answer = await asJson(`${baseUrl}/v2/prices/BTC-${asked}/spot`, "coinbase");
    const quoted = (answer as { data?: { amount?: string; currency?: string } }).data;
    if (quoted?.currency !== asked) {
      throw new Error(`coinbase quoted ${quoted?.currency} when asked for ${asked}`);
    }

    return asMinor(quoted.amount, "coinbase", asked);
  };
}

/** Kraken, CASP authorised by the Central Bank of Ireland. Quotes EUR and USD, no CZK */
export function kraken(baseUrl = "https://api.kraken.com"): Ticker {
  return async (currency: string) => {
    const asked = currency.toUpperCase();
    const answer = (await asJson(`${baseUrl}/0/public/Ticker?pair=XBT${asked}`, "kraken")) as {
      error?: string[];
      result?: Record<string, { c?: string[] }>;
    };
    if (answer.error?.length) throw new Error(`kraken refused XBT${asked}: ${answer.error[0]}`);

    const pairs = Object.values(answer.result ?? {});
    if (pairs.length !== 1) {
      throw new Error(`kraken answered ${pairs.length} pairs for XBT${asked}`);
    }

    return asMinor(pairs[0]?.c?.[0], "kraken", asked);
  };
}

/**
 * Bitstamp, CASP authorised by the CSSF in Luxembourg. Quotes EUR and USD, no CZK.
 *
 * An unknown pair is answered with a `200` and the whole ticker list, whose first
 * entry is BTC/USD, so asking it for CZK and reading the number would quote a
 * bitcoin at 64,000 crowns. Anything but a single object is therefore refused
 */
export function bitstamp(baseUrl = "https://www.bitstamp.net"): Ticker {
  return async (currency: string) => {
    const pair = `btc${currency.toLowerCase()}`;
    const answer = await asJson(`${baseUrl}/api/v2/ticker/${pair}/`, "bitstamp");
    if (Array.isArray(answer)) throw new Error(`bitstamp has no ${pair} pair`);

    return asMinor((answer as { last?: string }).last, "bitstamp", currency);
  };
}

/** Coinmate, on the ESMA CASP register, Czech and the one with a real BTC/CZK book */
export function coinmate(baseUrl = "https://coinmate.io"): Ticker {
  return async (currency: string) => {
    const pair = `BTC_${currency.toUpperCase()}`;
    const answer = (await asJson(`${baseUrl}/api/ticker?currencyPair=${pair}`, "coinmate")) as {
      error?: boolean;
      errorMessage?: string;
      data?: { last?: number };
    };
    if (answer.error !== false) {
      throw new Error(`coinmate refused ${pair}: ${answer.errorMessage ?? "no reason"}`);
    }

    return asMinor(answer.data?.last, "coinmate", currency);
  };
}

/**
 * Ask several venues and take the middle answer, refusing the lot when they
 * disagree too much.
 *
 * The default is the four MiCA authorised venues below, and every one of them is
 * replaceable: pass your own list, or one venue, or a function that reads a price
 * you already have. A venue that does not quote the currency is skipped rather
 * than fatal, which for CZK leaves Coinbase and Coinmate.
 *
 * The middle is taken rather than the mean so one stuck venue moves the answer by
 * nothing instead of by half its error, and the spread check is what catches the
 * stuck venue that stays inside the pack.
 */
export function medianOf(
  tickers: Ticker[] = [coinbase(), kraken(), bitstamp(), coinmate()],
  options: MedianOptions = {},
): Ticker {
  const holdFor = (options.holdForSecs ?? DEFAULT_HOLD_SECS) * MILLIS;
  const minVenues = options.minVenues ?? DEFAULT_MIN_VENUES;
  const maxSpread = options.maxSpreadBps ?? DEFAULT_MAX_SPREAD_BPS;
  const held = new Map<string, { at: number; price: number }>();

  return async (currency: string) => {
    const asked = currency.toUpperCase();
    const remembered = held.get(asked);
    if (remembered && Date.now() - remembered.at < holdFor) return remembered.price;

    const answers = await Promise.allSettled(tickers.map((ticker) => ticker(asked)));
    const quoted = answers
      .filter((answer): answer is PromiseFulfilledResult<number> => answer.status === "fulfilled")
      .map((answer) => answer.value)
      .sort((one, other) => one - other);

    if (quoted.length < minVenues) {
      throw new Error(
        `${quoted.length} of ${tickers.length} venues quoted ${asked}, ${minVenues} wanted: ${refusals(answers)}`,
      );
    }

    const spread = spreadBpsOf(quoted);
    if (spread > maxSpread) {
      throw new Error(
        `venues disagree on ${asked} by ${Math.round(spread)} bps, more than the ${maxSpread} allowed: ${quoted.join(", ")}`,
      );
    }

    const price = middleOf(quoted);
    held.set(asked, { at: Date.now(), price });

    return price;
  };
}

/**
 * What to ask for over Lightning for a price named in fiat, in millisatoshi.
 *
 * `priceMinorPerBtc` is what a `Ticker` returns. The arithmetic is exact, in
 * BigInt, because a million crown order times a hundred billion millisatoshi
 * leaves what a double can count, and it rounds up, because the extra
 * millisatoshi is worth nothing and belongs to the recipient rather than to a
 * rounding rule.
 *
 * `spreadBps` is yours to set, in basis points, and defaults to none. A Lightning
 * invoice lives an hour and a bank transfer takes days, so a shop pricing in fiat is
 * carrying that volatility whether or not it charges for it
 */
export function msatFor(
  amountMinor: number,
  priceMinorPerBtc: number,
  options: { spreadBps?: number } = {},
): number {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new Error("amountMinor must be a whole number of minor units above zero");
  }
  if (!Number.isFinite(priceMinorPerBtc) || priceMinorPerBtc <= 0) {
    throw new Error(`${priceMinorPerBtc} is not a usable price`);
  }

  const spreadBps = options.spreadBps ?? 0;
  if (!Number.isInteger(spreadBps) || spreadBps < 0) {
    throw new Error("spreadBps must be a whole number of basis points, none or more");
  }

  const wanted = BigInt(amountMinor) * BigInt(MSAT_PER_BTC) * BigInt(BASIS_POINTS + spreadBps);
  const per = BigInt(Math.round(priceMinorPerBtc)) * BigInt(BASIS_POINTS);
  const msat = (wanted + per - 1n) / per;
  if (msat > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${amountMinor} at ${priceMinorPerBtc} is more millisatoshi than exist`);
  }

  return Number(msat);
}

async function asJson(url: string, venue: string): Promise<unknown> {
  const answer = await fetch(url, { headers: { accept: "application/json" } });
  if (!answer.ok) throw new Error(`${venue} answered ${answer.status}`);

  return answer.json();
}

function asMinor(quoted: string | number | undefined, venue: string, currency: string): number {
  const major = Number(quoted);
  if (!Number.isFinite(major) || major <= 0) {
    throw new Error(`${venue} quoted ${String(quoted)} for ${currency.toUpperCase()}`);
  }

  return Math.round(major * minorScaleOf(currency));
}

function spreadBpsOf(sorted: number[]): number {
  const lowest = sorted[0] ?? 0;
  const highest = sorted[sorted.length - 1] ?? 0;

  return lowest === 0 ? Number.POSITIVE_INFINITY : ((highest - lowest) / lowest) * BASIS_POINTS;
}

function middleOf(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;

  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

function refusals(answers: PromiseSettledResult<number>[]): string {
  return answers
    .filter((answer): answer is PromiseRejectedResult => answer.status === "rejected")
    .map((answer) =>
      answer.reason instanceof Error ? answer.reason.message : String(answer.reason),
    )
    .join("; ");
}
