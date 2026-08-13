import { type Resolved, resolve } from "../../core/lnurl.js";
import { NoWalletAvailable } from "../../core/refusal.js";
import { bankTransfer } from "./bank.js";
import type { ThunderBridge } from "./client.js";
import { NoWalletAvailableError } from "./errors.js";
import { encodeForQr } from "./qr.js";
import { relayedVerifyUrl } from "./relay.js";

const BANK = "bank";
const LIGHTNING = "lightning";

/** What a shop knows about a sale before any rail exists */
export interface Order {
  /** The bank matches it on the statement, and Lightning keys idempotency on it */
  reference: string;

  /** The price in the smallest unit of `currency`, so 48055 is 480.55 CZK */
  amountMinor: number;

  /** ISO 4217. The bank rail moves this, Lightning reads it only through your own `amountMsat` */
  currency: string;
}

/** One way to pay one order, already registered with the gateway */
export interface Leg {
  /** The watched payment's id, which is what `firstToSettle`, `getWatched` and `waitForWatched` take */
  id: string;

  /** Which rail made it, so a shop can label a leg without knowing how it was built */
  rail: string;

  /** What the payer reads, a BOLT11 invoice or a Short Payment Descriptor */
  scan: string;

  /** The same thing as a QR has to encode it, which is not always `scan` itself */
  qr: string;

  expiresAt: number;
}

/**
 * A payment method. Everything that differs between rails is bound once when the
 * rail is built, so the only thing passed per sale is which sale it is
 */
export type Rail = (order: Order) => Promise<Leg>;

export interface BankRailConfig {
  /** The gateway that will watch these transfers. It has to be one of your own */
  gateway: ThunderBridge;

  /** Long lived and server side. Every preimage is derived from it, so losing it loses every proof */
  secret: string;

  /** The account the money goes to, as an IBAN */
  iban: string;

  /** Where `bankVerifyEndpoint` is mounted, a public https URL with no query of its own */
  verifyUrl: string;

  /**
   * When this order stops being payable, in unix seconds. Re-offering one order
   * has to return the same second every time, because the gateway compares the
   * expiry to decide whether a repeated watch is the same watch
   */
  expiresAt: (order: Order) => number;

  /** Groups every leg on the same secret, so one `followTrigger` socket hears them all */
  trigger?: string;

  /** Handed back untouched on that stream. Stable across re-offers, for the reason `expiresAt` is */
  sealed?: (order: Order) => string | Promise<string>;

  /** Up to ten digits, for accounting systems that still want one */
  variableSymbol?: (order: Order) => string | undefined;

  webhookUrl?: string;

  /** Register on a gateway you do not own anyway, on the terms `bankTransfer` sets out */
  allowPublicGateway?: boolean;

  /** What `Leg.rail` reads, for a shop running more than one account */
  name?: string;
}

export interface LightningRailConfig {
  /** The gateway that mints the invoice */
  gateway: ThunderBridge;

  /** Priority list, the gateway takes the first that can issue a provable invoice */
  lnAddresses: string[];

  /** What this order costs in millisatoshi. A shop pricing in fiat writes `msatFor` and its own ticker */
  amountMsat: (order: Order) => number | Promise<number>;

  /** Groups every leg on the same secret, so one `followTrigger` socket hears them all */
  trigger?: string;

  /**
   * Makes the mint safe to retry. Unset nothing is sent, because a key stable
   * across re-offers is one the gateway can join against the bank leg's reference
   */
  idempotencyKey?: (order: Order) => string | undefined;

  webhookUrl?: string;

  /** What `Leg.rail` reads, for a shop running more than one wallet */
  name?: string;
}

export interface BlindLightningRailConfig {
  /** The gateway that watches an invoice it was never allowed to mint */
  gateway: ThunderBridge;

  /** Priority list, resolved here rather than by the gateway */
  lnAddresses: string[];

  /** What this order costs in millisatoshi */
  amountMsat: (order: Order) => number | Promise<number>;

  /** Groups every leg on the same secret, so one `followTrigger` socket hears them all */
  trigger?: string;

  /** Only a watched leg has anywhere to carry this */
  sealed?: (order: Order) => string | Promise<string>;

  webhookUrl?: string;

  /**
   * Where your own `lightningVerifyEndpoint` is mounted, and the secret it
   * unseals with. Set both and the gateway is handed your URL rather than the
   * wallet's, so it polls you, never a third party, and learns nothing about
   * which provider the recipient uses. Leave them out and it polls the wallet
   */
  relayVerifyThrough?: { endpoint: string; secret: string };

  /** What `Leg.rail` reads, for a shop running more than one wallet */
  name?: string;
}

/**
 * Sell for a bank transfer. The money moves straight to your account and the
 * gateway is told a hash, a URL and an expiry, never the amount or the reference.
 *
 * Which bank is read back is `bankVerifyEndpoint`'s business, not this one's, so
 * a rail built here serves Fio and anything else behind a `Statement`.
 */
export function bankRail(config: BankRailConfig): Rail {
  return async (order) => {
    const expiresAt = config.expiresAt(order);
    const transfer = await bankTransfer({
      gateway: config.gateway,
      secret: config.secret,
      iban: config.iban,
      verifyUrl: config.verifyUrl,
      reference: order.reference,
      amountMinor: order.amountMinor,
      currency: order.currency,
      expiresAt,
      trigger: config.trigger,
      sealed: await config.sealed?.(order),
      variableSymbol: config.variableSymbol?.(order),
      webhookUrl: config.webhookUrl,
      allowPublicGateway: config.allowPublicGateway,
    });

    return {
      id: transfer.id,
      rail: config.name ?? BANK,
      scan: transfer.spd,
      qr: transfer.spd,
      expiresAt,
    };
  };
}

/**
 * Sell for Lightning, with the gateway minting the invoice. It is told the
 * address list and the amount, which is the round trip `blindLightningRail`
 * spends to avoid.
 */
export function lightningRail(config: LightningRailConfig): Rail {
  return async (order) => {
    const payment = await config.gateway.createPayment(
      {
        lnAddresses: config.lnAddresses,
        amountMsat: await config.amountMsat(order),
        webhookUrl: config.webhookUrl,
        },
      { idempotencyKey: config.idempotencyKey?.(order), trigger: config.trigger },
    );

    return {
      id: payment.id,
      rail: config.name ?? LIGHTNING,
      scan: payment.bolt11,
      qr: encodeForQr(payment.bolt11),
      expiresAt: payment.expiresAt,
    };
  };
}

/**
 * Sell for Lightning, resolving the address here and handing the gateway only a
 * hash and a URL to poll. It costs one more round trip and the gateway learns
 * neither who is being paid nor how much, so the only refusal left to it is
 * refusing everyone.
 */
export function blindLightningRail(config: BlindLightningRailConfig): Rail {
  return async (order) => {
    const resolved = await invoiceFrom(config.lnAddresses, await config.amountMsat(order));
    const relay = config.relayVerifyThrough;
    const watched = await config.gateway.watchPayment({
      paymentHash: resolved.paymentHash,
      verifyUrl: relay
        ? await relayedVerifyUrl(
            relay.endpoint,
            { url: resolved.verifyUrl, hash: resolved.paymentHash },
            relay.secret,
          )
        : resolved.verifyUrl,
      expiresAt: resolved.expiresAt,
      trigger: config.trigger,
      sealed: await config.sealed?.(order),
      webhookUrl: config.webhookUrl,
    });

    return {
      id: watched.id,
      rail: config.name ?? LIGHTNING,
      scan: resolved.bolt11,
      qr: encodeForQr(resolved.bolt11),
      expiresAt: resolved.expiresAt,
    };
  };
}

async function invoiceFrom(lnAddresses: string[], amountMsat: number): Promise<Resolved> {
  try {
    return await resolve(lnAddresses, amountMsat);
  } catch (refused: unknown) {
    if (refused instanceof NoWalletAvailable) {
      throw new NoWalletAvailableError({ title: refused.message }, refused.wallets);
    }
    throw refused;
  }
}
