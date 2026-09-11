import { bytesToHex, hexToBytes } from "../../core/bytes.js";
import { callerKey } from "../../core/caller.js";
import { hmacHex } from "../../core/hmac.js";
import { refuseAWeakSecret, sealStable, unseal } from "../../core/sealed.js";
import { sha256 } from "../../core/sha256.js";
import type { ThunderBridge } from "./client.js";
import { minorScaleOf, minorUnitsOf } from "./currency.js";
import { answerVerifyChallenge } from "./webhook.js";

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

/** One transfer to ask for: what is owed, where it lands, and where its arrival is read back from */
export interface BankTransferParams {
  /**
   * Long lived and server side, at least 32 characters. The preimage is derived
   * from it and the verify query is sealed with it, so losing it loses every proof
   */
  secret: string;

  /** What the payer must leave on the transfer, an order id or a nonce. It is matched, not stored */
  reference: string;

  /** The price in the smallest unit, so 48055 is 480.55 CZK */
  amountMinor: number;

  /** The account the money goes to, as an IBAN */
  iban: string;

  /**
   * Where `bankVerifyEndpoint` is mounted, a public https URL with no query of
   * its own. Not needed when `answerBy` is "agent", because then nothing is polled
   */
  verifyUrl?: string;

  /**
   * How the gateway gets its answer. "poll" hands it a URL it fetches, which
   * needs a public host. "agent" hands it this caller's name instead, and the
   * socket `bankAgent` holds open answers for it, which needs no host at all
   */
  answerBy?: "poll" | "agent";

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

  /** How many settlements of that trigger the gateway keeps replayable past the hour, needs `trigger` */
  replay?: number;

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

  /**
   * Register on a gateway you do not own anyway. The sealed verify URL tells its
   * operator nothing about the order, but the URL itself still answers whether
   * that order was paid. Say true only when that much is not worth hiding
   */
  allowPublicGateway?: boolean;
}

/** A transfer the gateway is now watching, and the descriptor the payer scans */
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

/** The endpoint the gateway polls for a bank transfer, answering off your own statement */
export interface BankVerifyConfig {
  /** The same secret `bankTransfer` was given */
  secret: string;

  /** The IBAN this endpoint answers for, refusing a question sealed for another account */
  iban: string;

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
 * The gateway is handed a hash, an expiry and a URL whose query is sealed to the
 * same secret, so a watch names neither the account, the amount nor the reference
 * and the order book cannot be read off the watches.
 */
export async function bankTransfer(
  gateway: ThunderBridge,
  params: BankTransferParams,
): Promise<BankTransfer> {
  const currency = params.currency ?? DEFAULT_CURRENCY;
  const iban = accountOf(params.iban);
  refuseUnusable(params, iban, currency);
  await refuseAnOpenGateway(gateway, params);
  const spd = shortPaymentDescriptor(params, iban, currency);
  const subject = subjectOf(iban, params.amountMinor, currency, params.reference);

  const verifyUrl = await answeredAt(params, subject);

  const watched = await gateway.watch({
    paymentHash: hashOf(await hmacHex(params.secret, `preimage|${subject}`)),
    verifyUrl,
    expiresAt: params.expiresAt,
    trigger: params.trigger,
    replay: params.replay,
    sealed: params.sealed,
    webhookUrl: params.webhookUrl,
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
 * The query carries one sealed blob `bankTransfer` put there, naming the account,
 * the amount and the reference. Only the holder of the secret can write one, so
 * opening it is the whole of the check, and whoever carried it past the gateway
 * read nothing on the way. Without that this would answer "did anyone send you
 * 480.55 with this note" to whoever asked, which is your bank statement handed out
 * one question at a time.
 */
export function bankVerifyEndpoint(
  config: BankVerifyConfig,
): (request: Request) => Promise<Response> {
  refuseAWeakSecret(config.secret);
  const answersFor = accountOf(config.iban);
  if (!IBAN.test(answersFor)) {
    throw new Error(`${config.iban} is not an IBAN, so this endpoint answers for no account`);
  }

  const paced = {
    "cache-control": `max-age=${config.pollEverySecs ?? DEFAULT_POLL_EVERY_SECS}`,
  };

  return async (request: Request) => {
    const consented = await answerVerifyChallenge(request);
    if (consented !== null) {
      return consented;
    }

    const sealed = new URL(request.url).searchParams.get("q");
    if (sealed === null) {
      return Response.json({ settled: false }, { status: 400 });
    }

    const subject = await unseal(config.secret, sealed);
    const asked = subject === null ? null : askedFrom(subject);
    if (asked === null || asked.iban !== answersFor) {
      return Response.json({ settled: false }, { status: 403 });
    }

    const preimage = await creditedPreimage({
      secret: config.secret,
      asked,
      statement: config.statement,
      lookBackSecs: config.lookBackSecs,
    });

    return preimage === null
      ? Response.json({ settled: false }, { headers: paced })
      : Response.json({ settled: true, preimage }, { headers: paced });
  };
}

async function answeredAt(params: BankTransferParams, subject: string): Promise<string> {
  if (params.answerBy === "agent") {
    return `agent:${(await callerKey(params.secret)).publicKeyHex}`;
  }

  const polling = new URL(params.verifyUrl ?? "");
  polling.searchParams.set("q", await sealStable(params.secret, subject));

  return polling.toString();
}

/** One order this caller is waiting on, and the account it is waiting on it in */
export interface BankOrder {
  iban: string;
  reference: string;
  amountMinor: number;
  currency?: string;
  statement: Statement;
}

/** What a caller needs to answer for its own transfers over a socket */
export interface BankAgentConfig {
  /** The gateway holding the watches this caller raised */
  gateway: ThunderBridge;

  /** The same secret `bankTransfer` was given, never leaving this device */
  secret: string;

  /** What the payment the gateway is asking about was asking for, or null when it is none of ours */
  orders: (paymentHash: string) => Promise<BankOrder | null> | BankOrder | null;

  /** How far back a credit still counts, seven days by default */
  lookBackSecs?: number;

  /** Called when a connection drops or a frame is refused, the socket keeps going */
  onError?: (error: unknown) => void;
}

/**
 * Answer the gateway over a socket this device opens, so a transfer addressed to
 * this caller settles from a till behind NAT, a browser tab or a phone. The
 * preimage is derived here from the secret, so the gateway is told only that one
 * exists and can check it against the hash it already holds.
 *
 * Call the returned function to stop attending. Whatever is still open is asked
 * again on the gateway's own schedule, so leaving and coming back loses nothing
 */
export function bankAgent(config: BankAgentConfig): () => void {
  refuseAWeakSecret(config.secret);

  return config.gateway.attend({
    onError: config.onError,
    answer: async (paymentHash) => {
      const order = await config.orders(paymentHash);
      if (order === null) {
        return null;
      }

      const currency = order.currency ?? DEFAULT_CURRENCY;

      return await creditedPreimage({
        secret: config.secret,
        asked: {
          iban: accountOf(order.iban),
          reference: order.reference,
          amountMinor: order.amountMinor,
          currency,
        },
        statement: order.statement,
        lookBackSecs: config.lookBackSecs,
      });
    },
  });
}

async function creditedPreimage(params: {
  secret: string;
  asked: Asked;
  statement: Statement;
  lookBackSecs?: number;
}): Promise<string | null> {
  const since = unixNow() - (params.lookBackSecs ?? DEFAULT_LOOK_BACK_SECS);
  const landed = (await params.statement(since)).some((credit) => pays(credit, params.asked));
  if (!landed) {
    return null;
  }

  const { iban, amountMinor, currency, reference } = params.asked;

  return await hmacHex(
    params.secret,
    `preimage|${subjectOf(iban, amountMinor, currency, reference)}`,
  );
}

interface Asked {
  iban: string;
  reference: string;
  amountMinor: number;
  currency: string;
}

function askedFrom(subject: string): Asked | null {
  const [iban, minorText, currency, ...rest] = subject.split("|");
  const reference = rest.join("|");
  const amountMinor = Number(minorText);
  if (!iban || !currency || reference.length === 0) {
    return null;
  }
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    return null;
  }

  return { iban, reference, amountMinor, currency };
}

function pays(credit: Credit, asked: Asked): boolean {
  return (
    credit.amountMinor === asked.amountMinor &&
    credit.currency.toUpperCase() === asked.currency.toUpperCase() &&
    credit.reference.toUpperCase().includes(asked.reference.toUpperCase())
  );
}

function subjectOf(iban: string, amountMinor: number, currency: string, reference: string): string {
  return `${iban}|${amountMinor}|${currency.toUpperCase()}|${reference}`;
}

function hashOf(preimage: string): string {
  return bytesToHex(sha256(hexToBytes(preimage)));
}

function shortPaymentDescriptor(
  params: BankTransferParams,
  iban: string,
  currency: string,
): string {
  const fields = [
    `ACC:${iban}`,
    `AM:${major(params.amountMinor, currency)}`,
    `CC:${currency.toUpperCase()}`,
    `MSG:${params.reference}`,
  ];
  if (params.variableSymbol) {
    fields.push(`X-VS:${params.variableSymbol}`);
  }

  return `SPD*1.0*${fields.join("*")}`;
}

function major(amountMinor: number, currency: string): string {
  return (amountMinor / minorScaleOf(currency)).toFixed(minorUnitsOf(currency));
}

async function refuseAnOpenGateway(
  gateway: ThunderBridge,
  params: BankTransferParams,
): Promise<void> {
  if (params.allowPublicGateway === true) {
    return;
  }
  if (await gateway.refusesStrangers()) {
    return;
  }

  throw new Error(
    "this gateway serves callers with no token, so it is not yours, and its operator would learn every watch you place. Point at one that answers 401 to a stranger, or say allowPublicGateway",
  );
}

function refuseUnusable(params: BankTransferParams, iban: string, currency: string): void {
  refuseAWeakSecret(params.secret);
  if (params.answerBy !== "agent" && params.verifyUrl === undefined) {
    throw new Error("a transfer the gateway polls needs the verify url it is polled at");
  }
  if (!IBAN.test(iban)) {
    throw new Error(`${params.iban} is not an IBAN`);
  }
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

function accountOf(iban: string): string {
  return iban.replace(/\s+/g, "").toUpperCase();
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}
