/** Where a payment stands, `paid` is the only status that carries a preimage */
export type PaymentStatus = "pending" | "paid" | "expired";

/** A payment as the gateway reports it, every field is checkable against the recipient */
export interface Payment {
  id: string;
  lnAddress: string;
  amountMsat: number;
  status: PaymentStatus;
  paymentHash: string;
  bolt11: string;
  preimage: string | null;
  expiresAt: number;
  createdAt: number;
  verifyUrl: string;
}

/**
 * `lnAddresses` is a priority list, the gateway takes the first one that can
 * issue a provable invoice for `amountMsat` and the rest are the fallback
 */
export interface CreatePaymentParams {
  lnAddresses: string[];
  amountMsat: number;
  webhookUrl?: string;
  webhookSecret?: string;
}

/**
 * `lnAddresses` is the same priority list `createPayment` takes, and quoting it
 * mints nothing and charges the recipient's wallet nothing
 */
export interface CreateQuoteParams {
  lnAddresses: string[];
  amountMsat: number;
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
 * What the gateway reports about a payment it is watching, for a trigger stream
 * or for one you minted yourself. `lnAddress` and `amountMsat` are null when the
 * gateway was never told them, which is the point of `watchPayment`: what the
 * watcher needs but the gateway should not know travels in `sealed` instead
 */
export interface TriggerEvent {
  id: string;
  paymentHash: string;
  verifyUrl: string;
  status: PaymentStatus;
  preimage: string | null;
  expiresAt: number;
  createdAt: number;
  sealed: string | null;
  lnAddress: string | null;
  amountMsat: number | null;
}

/**
 * An invoice you obtained yourself, handed over to be watched. The gateway is
 * given no address and no amount, so it cannot refuse one recipient rather than
 * all of them
 */
export interface WatchPaymentParams {
  paymentHash: string;
  verifyUrl: string;
  expiresAt: number;
  trigger?: string;
  sealed?: string;
}

/** Why one wallet in the list could not be used */
export type WalletReason =
  | "address-unusable"
  | "unreachable"
  | "amount-not-accepted"
  | "cannot-prove-delivery"
  | "invoice-refused";

export interface WalletFailure {
  address: string;
  reason: WalletReason;
}
