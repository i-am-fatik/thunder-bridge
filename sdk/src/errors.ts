import type { WalletFailure } from "./types.js";

/**
 * The way a gateway was caught out, every code is a check that held against the
 * recipient's own server and failed against what the gateway returned
 */
export type GatewayCheatCode =
  | "address_not_requested"
  | "hash_mismatch"
  | "amount_mismatch"
  | "description_hash_mismatch"
  | "verify_url_foreign"
  | "invoice_not_issued"
  | "preimage_mismatch"
  | "id_not_mine";

/**
 * Thrown when the gateway demonstrably misbehaved, the invoice it returned is
 * not the one the address you asked for issued, or a settlement it reported
 * carries a preimage that does not hash to the payment hash
 */
export class GatewayCheatError extends Error {
  readonly code: GatewayCheatCode;
  readonly paymentId: string;

  constructor(code: GatewayCheatCode, paymentId: string) {
    super(`gateway verification failed: ${code}`);
    this.name = "GatewayCheatError";
    this.code = code;
    this.paymentId = paymentId;
  }
}

/**
 * The way a wrapping operator was caught out. Every code is the wrapped invoice
 * failing to bind to the recipient's own, which is the only thing that makes
 * paying the wrap the same act as paying the recipient
 */
export type WrapRefusalCode =
  | "undecodable"
  | "hash_mismatch"
  | "amount_below_recipient"
  | "fee_above_allowance"
  | "recipient_expires_first";

/**
 * Thrown when a wrapped invoice does not bind to the recipient's. Paying it
 * would be paying the operator on its word rather than on the shared payment
 * hash, which is the whole of what makes wrapping safe
 */
export class WrapRefusedError extends Error {
  readonly code: WrapRefusalCode;

  constructor(code: WrapRefusalCode, detail: string) {
    super(`wrapped invoice refused: ${code}, ${detail}`);
    this.name = "WrapRefusedError";
    this.code = code;
  }
}

/**
 * Thrown when the recipient's own server could not be reached to check the
 * invoice against, a CORS-blocked browser or a provider that is down, this is
 * not proof the gateway cheated and it is not proof it did not
 */
export class UnverifiedRecipientError extends Error {
  readonly lnAddress: string;
  readonly paymentId: string;

  constructor(lnAddress: string, paymentId: string, cause: unknown) {
    super(`could not reach ${lnAddress} to verify the invoice: ${String(cause)}`);
    this.name = "UnverifiedRecipientError";
    this.lnAddress = lnAddress;
    this.paymentId = paymentId;
  }
}

/** An RFC 9457 problem document the gateway answered with */
export class ProblemError extends Error {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string | null;

  constructor(problem: { type?: string; title?: string; status?: number; detail?: string }) {
    const title = problem.title ?? "Request failed";
    super(problem.detail ? `${title}: ${problem.detail}` : title);
    this.name = "ProblemError";
    this.type = problem.type ?? "about:blank";
    this.title = title;
    this.status = problem.status ?? 0;
    this.detail = problem.detail ?? null;
  }
}

/** Whether a problem document carries this type */
export function isProblemType(problem: { type?: string }, type: string): boolean {
  return problem.type === type;
}

export const NO_WALLET_AVAILABLE = "urn:problem-type:thunder-bridge:no-wallet-available";
export const REQUEST_IN_FLIGHT = "urn:problem-type:thunder-bridge:request-in-flight";
export const IDEMPOTENCY_KEY_REUSED = "urn:problem-type:thunder-bridge:idempotency-key-reused";
export const PAYMENT_ALREADY_WATCHED = "urn:problem-type:thunder-bridge:payment-already-watched";

/**
 * Why an `Idempotency-Key` was refused, `request-in-flight` is the benign one and
 * `key-reused` means the same key was sent for a different request
 */
export type IdempotencyConflict = "request-in-flight" | "key-reused";

/**
 * Thrown when an `Idempotency-Key` is held by another request. On
 * `request-in-flight` the first attempt is still resolving, so wait and read the
 * payment back rather than retrying. `key-reused` is a bug in the caller: the key
 * is bound to the addresses, amount and webhook that claimed it
 */
export class IdempotencyConflictError extends ProblemError {
  readonly conflict: IdempotencyConflict;

  constructor(
    problem: { type?: string; title?: string; status?: number; detail?: string },
    conflict: IdempotencyConflict,
  ) {
    super(problem);
    this.name = "IdempotencyConflictError";
    this.conflict = conflict;
  }
}

/** Thrown when no wallet on your list could issue a provable invoice, `wallets` says why each refused */
export class NoWalletAvailableError extends ProblemError {
  readonly wallets: WalletFailure[];

  constructor(
    problem: { title?: string; status?: number; detail?: string },
    wallets: WalletFailure[],
  ) {
    super({ ...problem, type: NO_WALLET_AVAILABLE });
    this.name = "NoWalletAvailableError";
    this.wallets = wallets;
  }
}
