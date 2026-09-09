import type { ThunderBridge, WaitOptions } from "./client.js";
import { invoiceToSvg, type QrOptions } from "./qr.js";
import type { Charge, MintedPayment, Payment } from "./types.js";
import { proveSettlement } from "./verify.js";

/**
 * What to ask for: who is paid, how much, and how the QR should look. Every
 * field beyond `paidTo` and `amount` has a default, so the shortest request
 * names two
 */
export interface PaymentRequestInit extends Charge, PaymentRequestOptions {}

/** What `requestPayment` takes beyond the charge itself */
export interface PaymentRequestOptions extends WaitOptions {
  /** Makes the mint safe to retry, so a reloaded checkout replays one invoice */
  idempotencyKey?: string;

  /** Groups this request with every other one carrying the same secret, for `follow` */
  trigger?: string;

  /** How many of that trigger's settlements the gateway keeps replayable past the hour */
  replay?: number;

  /** Size and colour of `qr`, 256 pixels and black by default */
  qr?: QrOptions;
}

/**
 * One payment asked for: the invoice to show, the QR to draw it with, and one
 * way to find out it was paid. Everything on it is already proved against the
 * recipient's own server, so nothing here is the gateway's word
 */
export interface PaymentRequest {
  /** What the gateway calls this payment, which is what `payment` and `settled` take */
  readonly id: string;

  readonly bolt11: string;
  readonly paymentHash: string;
  readonly lnAddress: string;
  readonly amountMsat: number;

  /** When the invoice stops being payable, in unix seconds */
  readonly expiresAt: number;

  /** The invoice as an SVG QR, ready to put in an element's `innerHTML` */
  readonly qr: string;

  /** The payment as the gateway first reported it, for anything the fields above leave out */
  readonly payment: MintedPayment;

  /**
   * Resolves once the money has arrived, and rejects when the invoice expires
   * unpaid or the wait is aborted. It follows a WebSocket and reconnects through
   * a drop, so this is one await rather than a poll.
   *
   * `gateway.settled(id)` is the wider question and ends on an expiry too. This
   * one is about the payment that was asked for, and one that expired was never paid
   */
  paid(options?: WaitOptions): Promise<MintedPayment>;

  /**
   * The same wait as a callback, for a page that has something else to do.
   * Returns a function that stops waiting
   */
  onPaid(arrived: (payment: MintedPayment) => void, failed?: (reason: unknown) => void): () => void;

  /**
   * Ask the recipient's own server whether it settled, and get the preimage it
   * released or null. This is the only answer that comes from somewhere other
   * than the gateway, so it is the one to ask when a payment matters
   */
  prove(): Promise<string | null>;
}

export function paymentRequestOf(
  gateway: ThunderBridge,
  payment: MintedPayment,
  options?: PaymentRequestOptions,
): PaymentRequest {
  return {
    id: payment.id,
    bolt11: payment.bolt11,
    paymentHash: payment.paymentHash,
    lnAddress: payment.lnAddress,
    amountMsat: payment.amountMsat,
    expiresAt: payment.expiresAt,
    qr: invoiceToSvg(payment.bolt11, options?.qr),
    payment,

    paid: async (waiting?: WaitOptions) =>
      paidOnly(await gateway.settled(payment.id, { ...waitingOf(options), ...waiting })),

    prove: () =>
      proveSettlement(payment, { paidTo: [payment.lnAddress], amountMsat: payment.amountMsat }),

    onPaid: (arrived, failed) => {
      const stop = new AbortController();
      const waiting = waitingOf(options);
      const signal = waiting.signal ? AbortSignal.any([stop.signal, waiting.signal]) : stop.signal;

      gateway
        .settled(payment.id, { ...waiting, signal })
        .then((ended) => arrived(paidOnly(ended)))
        .catch((reason: unknown) => {
          if (!stop.signal.aborted) {
            failed?.(reason);
          }
        });

      return () => stop.abort();
    },
  };
}

function paidOnly(ended: Payment): MintedPayment {
  if (ended.status !== "paid") {
    throw new Error(`payment ${ended.id} ended ${ended.status} rather than paid`);
  }
  if (ended.kind !== "minted") {
    throw new Error(`payment ${ended.id} came back without the invoice it was minted with`);
  }

  return ended;
}

function waitingOf(options?: PaymentRequestOptions): WaitOptions {
  return { signal: options?.signal, tickets: options?.tickets };
}
