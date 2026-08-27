import { decodeInvoice, preimageMatchesHash } from "../../core/bolt11.js";
import { sha256Hex } from "../../core/sha256.js";
import { publicHttps, sameOrigin } from "../../core/url.js";
import {
  type GatewayCheatCode,
  GatewayCheatError,
  UnverifiedRecipientError,
  type WrapRefusalCode,
  WrapRefusedError,
} from "./errors.js";
import type { CreatePaymentParams, Payment } from "./types.js";

const HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_WRAP_PROPORTION = 0.01;
const DEFAULT_WRAP_BASE_MSAT = 1000;

/**
 * What a wrapping operator may charge over the recipient's own amount. This is a
 * ceiling the client sets rather than a price the operator names, so it sits
 * above what any operator lists and refuses only the ones reaching past it
 */
export interface WrapAllowance {
  /** As a fraction of the recipient's amount, `0.01` by default */
  proportion?: number;

  /** The floor in millisatoshi whatever the fraction works out to, `1000` by default */
  baseMsat?: number;
}

interface PayRequest {
  callback?: unknown;
  metadata?: unknown;
}

interface Verification {
  pr?: unknown;
  settled?: unknown;
  preimage?: unknown;
}

/**
 * Prove the invoice really is the one the recipient issued for what you asked,
 * before the payer ever sees it, both fetches go straight to the recipient's own
 * server and none of them goes back to the gateway
 *
 * Throws `GatewayCheatError` when a check fails and `UnverifiedRecipientError`
 * when the recipient could not be reached to run one
 */
export async function proveOrigin(payment: Payment, request: CreatePaymentParams): Promise<void> {
  const cheat = (code: GatewayCheatCode) => new GatewayCheatError(code, payment.id);

  const listed = request.lnAddresses.find((address) =>
    equalIgnoringCase(address, payment.lnAddress),
  );
  if (listed === undefined) {
    throw cheat("address_not_requested");
  }
  if (payment.amountMsat !== request.amountMsat) {
    throw cheat("amount_mismatch");
  }

  const invoice = decodeInvoice(payment.bolt11);
  if (
    invoice.paymentHash === null ||
    !equalIgnoringCase(invoice.paymentHash, payment.paymentHash)
  ) {
    throw cheat("hash_mismatch");
  }
  if (invoice.amountMsat !== request.amountMsat) {
    throw cheat("amount_mismatch");
  }

  const payRequest = await payRequestFor(listed, payment);
  if (typeof payRequest.metadata !== "string" || typeof payRequest.callback !== "string") {
    throw new UnverifiedRecipientError(payment.lnAddress, payment.id, "no payRequest served");
  }
  if (invoice.descriptionHash !== sha256Hex(payRequest.metadata)) {
    throw cheat("description_hash_mismatch");
  }
  if (!sameOrigin(payment.verifyUrl, payRequest.callback)) {
    throw cheat("verify_url_foreign");
  }

  const issued = await reachable<Verification>(payment.verifyUrl, payment);
  if (typeof issued.pr !== "string" || !equalIgnoringCase(issued.pr, payment.bolt11)) {
    throw cheat("invoice_not_issued");
  }
}

/**
 * Prove the money arrived by asking the recipient's own server, not the gateway,
 * returns the preimage when the recipient says it settled and null when it says
 * it has not, and runs the full origin proof first because a verify url the
 * gateway made up would otherwise answer for itself
 */
export async function proveSettlement(
  payment: Payment,
  request: CreatePaymentParams,
): Promise<string | null> {
  await proveOrigin(payment, request);

  const verified = await reachable<Verification>(payment.verifyUrl, payment);
  if (verified.settled !== true || typeof verified.preimage !== "string") {
    return null;
  }
  if (!preimageMatchesHash(verified.preimage, payment.paymentHash)) {
    throw new GatewayCheatError("preimage_mismatch", payment.id);
  }
  return verified.preimage;
}

/**
 * True when the gateway's own report of a settlement is at least self-consistent,
 * the preimage hashes to the payment hash the invoice itself carries, this is a
 * sanity check and not a proof, only `proveSettlement` asks the recipient
 */
export function isProvablyPaid(payment: Payment): boolean {
  if (payment.status !== "paid" || payment.preimage === null) {
    return false;
  }
  const invoiceHash = decodeInvoice(payment.bolt11).paymentHash;
  if (invoiceHash === null || !equalIgnoringCase(invoiceHash, payment.paymentHash)) {
    return false;
  }
  return preimageMatchesHash(payment.preimage, invoiceHash);
}

/**
 * The most an operator may add over the recipient's own amount, in millisatoshi.
 * The proportion is what routing and the liquidity behind it costs, and the base
 * is the floor it never drops below, because a fraction of a small payment
 * rounds to nothing the operator can work for
 */
export function wrapFeeCeiling(amountMsat: number, allowance?: WrapAllowance): number {
  const proportional = amountMsat * (allowance?.proportion ?? DEFAULT_WRAP_PROPORTION);
  return Math.max(allowance?.baseMsat ?? DEFAULT_WRAP_BASE_MSAT, Math.floor(proportional));
}

/**
 * Prove a wrapping operator's invoice is the recipient's own payment in
 * disguise, so paying it can only settle by the operator paying the recipient.
 *
 * It compares two invoices and asks nobody anything, so it runs in a browser and
 * costs no round trip. Prove the recipient's own invoice with `proveOrigin`
 * first, because this says nothing about where that one came from.
 *
 * There is no settlement check here and there does not need to be. Both invoices
 * carry one payment hash, so the preimage that settles the wrap is the preimage
 * the recipient released, and `proveSettlement` already reads it from the
 * recipient's own server.
 *
 * Throws `WrapRefusedError` naming which binding failed
 */
export function proveWrapped(wrapped: string, recipient: string, allowance?: WrapAllowance): void {
  const offered = decodeInvoice(wrapped);
  const owed = decodeInvoice(recipient);
  const refuse = (code: WrapRefusalCode, detail: string) => {
    throw new WrapRefusedError(code, detail);
  };

  if (offered.paymentHash === null || offered.amountMsat === null || offered.expiresAt === null) {
    refuse("undecodable", "the wrapped invoice carries no hash, amount or expiry");
  }
  if (owed.paymentHash === null || owed.amountMsat === null || owed.expiresAt === null) {
    refuse("undecodable", "the recipient's invoice carries no hash, amount or expiry");
  }
  if (offered.paymentHash?.toLowerCase() !== owed.paymentHash?.toLowerCase()) {
    refuse("hash_mismatch", "settling the wrap would not settle the recipient");
  }

  const asked = offered.amountMsat ?? 0;
  const due = owed.amountMsat ?? 0;
  if (asked < due) {
    refuse("amount_below_recipient", `${asked} msat cannot forward ${due} msat`);
  }

  const ceiling = wrapFeeCeiling(due, allowance);
  if (asked - due > ceiling) {
    refuse("fee_above_allowance", `${asked - due} msat over ${due}, and ${ceiling} was allowed`);
  }
  if ((owed.expiresAt ?? 0) <= (offered.expiresAt ?? 0)) {
    refuse("recipient_expires_first", "the operator could be paid and find it cannot deliver");
  }
}

async function payRequestFor(listed: string, payment: Payment): Promise<PayRequest> {
  const at = listed.indexOf("@");
  const name = listed.slice(0, at);
  const domain = listed.slice(at + 1).toLowerCase();
  if (at < 1 || !publicHttps(`https://${domain}/`)) {
    throw new UnverifiedRecipientError(payment.lnAddress, payment.id, "not a usable address");
  }
  return reachable<PayRequest>(`https://${domain}/.well-known/lnurlp/${name}`, payment);
}

async function reachable<T>(url: string, payment: Payment): Promise<T> {
  try {
    if (!publicHttps(url)) {
      throw new Error(`${url} is not a public https URL`);
    }
    const response = await fetch(url, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`answered ${response.status}`);
    }
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object") {
      throw new Error("answered with no JSON object");
    }
    return body as T;
  } catch (cause: unknown) {
    throw new UnverifiedRecipientError(payment.lnAddress, payment.id, cause);
  }
}

function equalIgnoringCase(one: string, other: string): boolean {
  return one.toLowerCase() === other.toLowerCase();
}
