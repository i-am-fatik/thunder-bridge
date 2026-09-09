import type { Amount } from "./amount.js";

/** Where a payment stands, `paid` is the only status that carries a preimage */
export type PaymentStatus = "pending" | "paid" | "expired";

interface Reported {
  id: string;
  status: PaymentStatus;
  paymentHash: string;
  verifyUrl: string;
  preimage: string | null;
  expiresAt: number;
  createdAt: number;

  /** What the watcher needs and the gateway cannot read, `unseal` opens it */
  sealed: string | null;
}

/**
 * A payment the gateway minted. It resolved the address itself, so it knows who
 * is paid, how much, and which invoice says so, and none of the three can be
 * null here
 */
export interface MintedPayment extends Reported {
  kind: "minted";
  lnAddress: string;
  amountMsat: number;
  bolt11: string;
}

/**
 * A payment the gateway was handed rather than asked to mint. It was told a hash,
 * a URL and an expiry and nothing else, which is the point of `watch`, so the
 * address, the amount and the invoice are all absent rather than merely unknown
 */
export interface WatchedPayment extends Reported {
  kind: "watched";
  lnAddress: null;
  amountMsat: null;
  bolt11: null;
}

/**
 * A payment as the gateway reports it, of either sort. Check `kind` and the
 * three fields a watched payment does not carry stop being null, so nothing here
 * needs an assertion to read
 */
export type Payment = MintedPayment | WatchedPayment;

/**
 * Who is paid and how much. `to` is a priority list when it is an array: the
 * gateway takes the first address that can issue a provable invoice for the
 * amount and the rest are the fallback
 */
export interface Charge {
  paidTo: string | string[];
  amount: Amount;

  /** Where the gateway posts the settlement, signed with the key it publishes */
  webhookUrl?: string;
}

/**
 * A charge with its price settled, which is what a proof compares the gateway's
 * answer against. Asking a fiat price twice gives two numbers, so the proof is
 * handed the one that was actually asked for
 */
export interface Priced {
  paidTo: string[];
  amountMsat: number;
}

/**
 * An invoice you obtained yourself, handed over to be watched. The gateway is
 * given no address and no amount, so it cannot refuse one recipient rather than
 * all of them
 */
export interface Handover {
  paymentHash: string;
  verifyUrl: string;
  expiresAt: number;

  /** Groups this payment with every other one carrying the same secret */
  trigger?: string;

  /**
   * How many of this trigger's settlements the gateway keeps replayable past the
   * hour it would otherwise forget them in, up to the ceiling its operator set.
   * Needs `trigger`, defaults to none
   */
  replay?: number;

  /** Sealed with `seal`, so the gateway stores what it cannot read */
  sealed?: string;

  webhookUrl?: string;
}

/**
 * Which address would serve an amount, and what the ones ahead of it refused.
 * `feeMsat` is always zero, the payer pays the recipient's own invoice and the
 * gateway is never in the money's path
 */
export interface Quote {
  lnAddress: string;
  amountMsat: number;
  feeMsat: number;
  minMsat: number;
  maxMsat: number;
  metadata: string;
  refusals: WalletFailure[];
}

/**
 * A one minute pass onto one trigger's stream. It opens that trigger and nothing
 * else, which is what makes it the thing to hand a browser when the trigger
 * secret is not. `expiresAt` is unix seconds, like every other time here
 */
export interface SocketTicket {
  ticket: string;
  expiresAt: number;
}

/** Why one wallet in the list could not be used */
export type WalletReason =
  | "address-unusable"
  | "unreachable"
  | "amount-not-accepted"
  | "cannot-prove-delivery"
  | "invoice-refused";

/** One wallet on the list that could not be used, and the reason it could not */
export interface WalletFailure {
  address: string;
  reason: WalletReason;
}

/**
 * What a delivery carries. Everything needed to act on a settlement and to check
 * it, and nothing else, so a retry is the same size every time
 */
export interface Settlement {
  id: string;
  status: PaymentStatus;
  paymentHash: string;
  preimage: string | null;
  settledAt: number;
}
