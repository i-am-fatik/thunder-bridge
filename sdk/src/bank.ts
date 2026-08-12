import { bytesToHex, hexToBytes } from "../../core/bytes.js";
import { equalInConstantTime, hmacHex } from "../../core/hmac.js";
import { sha256 } from "../../core/sha256.js";
import type { ThunderBridge } from "./client.js";
import { minorScaleOf, minorUnitsOf } from "./currency.js";
import { answerVerifyChallengeRequest } from "./webhook.js";

const DEFAULT_CURRENCY = "CZK";
const DEFAULT_LOOK_BACK_SECS = 7 * 24 * 60 * 60;
const DEFAULT_POLL_EVERY_SECS = 30;
const IBAN = /^[A-Z]{2}[0-9]{2}[0-9A-Z]{8,30}$/;
const FORBIDDEN_IN_SPD = "*";

/** One incoming payment as the bank booked it, in the smallest unit of its currency */
export interface Credit {
  amountMinor: number;
  currency: string;
  /** Whatever the payer wrote, wherever this bank puts it. Matching is a substring, so noise around it is fine */
  reference: string;

  /**
   * Unix seconds. A bank that books a day rather than an instant, as Fio does,
   * gives the day's midnight in its own zone, so rendering this in UTC can show
   * the day before. Nothing here matches on it, it is yours to read
   */
  bookedAt: number;
}

/**
 * Recent credits on one account, oldest or newest first, it makes no difference.
 * This is the whole plugin seam: a bank is a function of this shape, and
 * `fioStatement` is one implementation of it
 */
export type Statement = (sinceUnix: number) => Promise<Credit[]>;

export interface BankTransferParams {
  /**
   * The gateway that will watch this transfer. It has to be one of your own,
   * meaning one you gave a token, unless `allowPublicGateway` says otherwise
   */
  gateway: ThunderBridge;

  /** Long lived and server side. The preimage is derived from it, so losing it loses every proof */
  secret: string;

  /** What the payer must leave on the transfer, an order id or a nonce. It is matched, not stored */
  reference: string;

  /** The price in the smallest unit, so 48055 is 480.55 CZK */
  amountMinor: number;

  /** The account the money goes to, as an IBAN */
  iban: string;

  /** Where `bankVerifyEndpoint` is mounted, a public https URL with no query of its own */
  verifyUrl: string;

  /** When the offer dies, in unix seconds. Money in a bank moves on banking days, so give it days */
  expiresAt: number;

  /** Defaults to CZK */
  currency?: string;

  /** Up to ten digits, for accounting systems that still want one */
  variableSymbol?: string;

  /**
   * Groups this transfer with everything else paid to the same secret, so one
   * `followTrigger` socket hears about it. Give the Lightning leg of the same
   * order the same secret and both rails arrive on one stream
   */
  trigger?: string;

  /**
   * Handed back untouched on that stream, so a watcher learns which order settled
   * without asking anyone. `seal` it and the gateway cannot read it either
   */
  sealed?: string;

  /**
   * Where the gateway posts once the money lands, a public https URL. Without one
   * a transfer is only ever learned by following the trigger or asking
   */
  webhookUrl?: string;

  /** Signs that delivery, so `verifyWebhookSignature` can tell it came from the gateway */
  webhookSecret?: string;

  /**
   * Register on a gateway you do not own anyway. The verify URL names the amount
   * and the reference, so its operator ends up reading your order book, and the
   * URL itself answers whether that order was paid. Say true only when the order
   * book is not worth hiding
   */
  allowPublicGateway?: boolean;
}

export interface BankTransfer {
  /** The watched payment's id at the gateway, which is how you read this order back */
  id: string;

  /** What the gateway was given, and what the preimage has to hash to */
  paymentHash: string;

  /** The same URL you mounted, carrying what to look for and a signature over it */
  verifyUrl: string;

  /** The payer scans this, it is a Short Payment Descriptor, the Czech QR platba format */
  spd: string;
}

export interface BankVerifyConfig {
  /** The same secret `bankTransfer` was given */
  secret: string;

  /** The account to read */
  statement: Statement;

  /** How far back a credit still counts, seven days by default */
  lookBackSecs?: number;

  /**
   * How often you want the gateway to ask, in seconds. It goes out as
   * `Cache-Control: max-age`, so the pace is yours to set rather than the
   * gateway's, and a bank that updates once a minute should say so instead of
   * being polled every few seconds. Thirty by default, clamped to an hour
   */
  pollEverySecs?: number;
}

/**
 * Ask for a bank transfer and put it under the gateway's watch, so it settles
 * the way a Lightning payment does.
 *
 * A BOLT11 payment proves settlement with a preimage whose sha256 the payer's
 * invoice pins. A bank transfer has no such thing, so this mints one: the
 * preimage is an HMAC of what is being asked for, and its hash is what the
 * gateway is given. The money still moves straight to your account, and the
 * gateway still learns only a hash and a URL to poll.
 *
 * What the preimage proves is therefore what LUD-21 proves and no more: that
 * the server holding the secret saw the money arrive. It is the recipient's
 * own word, made unforgeable by anyone else.
 *
 * The gateway has to be one of your own. Unlike a blind Lightning watch, which
 * hands over a hash and an opaque wallet URL, this hands over a URL naming the
 * amount and the reference, so whoever runs the gateway can read your order book
 * from the watches alone.
 */
export async function bankTransfer(params: BankTransferParams): Promise<BankTransfer> {
  const currency = params.currency ?? DEFAULT_CURRENCY;
  refuseUnusable(params, currency);
  await refuseAnOpenGateway(params);
  const spd = shortPaymentDescriptor(params, currency);
  const subject = subjectOf(params.reference, params.amountMinor, currency);

  const polling = new URL(params.verifyUrl);
  polling.searchParams.set("ref", params.reference);
  polling.searchParams.set("minor", String(params.amountMinor));
  polling.searchParams.set("cc", currency);
  polling.searchParams.set("sig", await hmacHex(params.secret, `verify|${subject}`));
  const verifyUrl = polling.toString();

  const watched = await params.gateway.watchPayment({
    paymentHash: hashOf(await hmacHex(params.secret, `preimage|${subject}`)),
    verifyUrl,
    expiresAt: params.expiresAt,
    trigger: params.trigger,
    sealed: params.sealed,
    webhookUrl: params.webhookUrl,
    webhookSecret: params.webhookSecret,
  });

  return { id: watched.id, paymentHash: watched.paymentHash, verifyUrl, spd };
}

/**
 * The verify endpoint the gateway polls, as a Fetch handler, so it runs wherever
 * `lnurlPayEndpoint` does.
 *
 * It answers the LUD-21 shape: `settled` false until a matching credit is on the
 * statement, then `settled` true with the preimage. Nothing is stored, because
 * the preimage is derived again from the secret every time it is asked for.
 *
 * The query has to carry the signature `bankTransfer` put there. Without that
 * check this would answer "did anyone send you 480.55 with this note" to whoever
 * asked, which is your bank statement handed out one question at a time.
 */
export function bankVerifyEndpoint(
  config: BankVerifyConfig,
): (request: Request) => Promise<Response> {
  const paced = {
    "cache-control": `max-age=${config.pollEverySecs ?? DEFAULT_POLL_EVERY_SECS}`,
  };

  return async (request: Request) => {
    const consented = await answerVerifyChallengeRequest(request);
    if (consented !== null) return consented;

    const asked = readQuery(new URL(request.url));
    if (asked === null) return Response.json({ settled: false }, { status: 400 });

    const subject = subjectOf(asked.reference, asked.amountMinor, asked.currency);
    const expected = await hmacHex(config.secret, `verify|${subject}`);
    if (!equalInConstantTime(asked.signature, expected)) {
      return Response.json({ settled: false }, { status: 403 });
    }

    const since = unixNow() - (config.lookBackSecs ?? DEFAULT_LOOK_BACK_SECS);
    const landed = (await config.statement(since)).some((credit) => pays(credit, asked));
    if (!landed) return Response.json({ settled: false }, { headers: paced });

    return Response.json(
      { settled: true, preimage: await hmacHex(config.secret, `preimage|${subject}`) },
      { headers: paced },
    );
  };
}

interface Asked {
  reference: string;
  amountMinor: number;
  currency: string;
  signature: string;
}

function readQuery(url: URL): Asked | null {
  const reference = url.searchParams.get("ref");
  const minor = Number(url.searchParams.get("minor"));
  const currency = url.searchParams.get("cc");
  const signature = url.searchParams.get("sig");
  if (!reference || !currency || !signature) return null;
  if (!Number.isInteger(minor) || minor <= 0) return null;

  return { reference, amountMinor: minor, currency, signature };
}

function pays(credit: Credit, asked: Asked): boolean {
  return (
    credit.amountMinor === asked.amountMinor &&
    credit.currency.toUpperCase() === asked.currency.toUpperCase() &&
    credit.reference.toUpperCase().includes(asked.reference.toUpperCase())
  );
}

function subjectOf(reference: string, amountMinor: number, currency: string): string {
  return `${reference}|${amountMinor}|${currency.toUpperCase()}`;
}

function hashOf(preimage: string): string {
  return bytesToHex(sha256(hexToBytes(preimage)));
}

function shortPaymentDescriptor(params: BankTransferParams, currency: string): string {
  const fields = [
    `ACC:${params.iban}`,
    `AM:${major(params.amountMinor, currency)}`,
    `CC:${currency.toUpperCase()}`,
    `MSG:${params.reference}`,
  ];
  if (params.variableSymbol) fields.push(`X-VS:${params.variableSymbol}`);

  return `SPD*1.0*${fields.join("*")}`;
}

function major(amountMinor: number, currency: string): string {
  return (amountMinor / minorScaleOf(currency)).toFixed(minorUnitsOf(currency));
}

async function refuseAnOpenGateway(params: BankTransferParams): Promise<void> {
  if (params.allowPublicGateway === true) return;
  if (await params.gateway.refusesStrangers()) return;

  throw new Error(
    "this gateway serves callers with no token, so it is not yours, and its operator would read the amount and the reference off every verify URL. Point at one that answers 401 to a stranger, or say allowPublicGateway",
  );
}

function refuseUnusable(params: BankTransferParams, currency: string): void {
  if (!IBAN.test(params.iban)) throw new Error(`${params.iban} is not an IBAN`);
  if (!Number.isInteger(params.amountMinor) || params.amountMinor <= 0) {
    throw new Error("amountMinor must be a whole number of minor units above zero");
  }
  if (params.reference.length === 0) {
    throw new Error("a transfer with no reference cannot be found");
  }
  if (params.reference.includes(FORBIDDEN_IN_SPD)) {
    throw new Error("a reference cannot contain an asterisk, it separates the QR fields");
  }
  if (params.variableSymbol && !/^[0-9]{1,10}$/.test(params.variableSymbol)) {
    throw new Error("a variable symbol is up to ten digits");
  }
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}
