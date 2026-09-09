import { type Resolved, resolve } from "../../core/lnurl.js";
import { NoWalletAvailable } from "../../core/refusal.js";
import { type Amount, type Msat, millisatoshi, msat } from "./amount.js";
import { type BankTransfer, type BankTransferParams, bankTransfer } from "./bank.js";
import type { ThunderBridge } from "./client.js";
import { NoWalletAvailableError } from "./errors.js";
import { medianOf, msatFor, type Ticker } from "./price.js";
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

  /** ISO 4217. The bank rail moves this, Lightning converts it at `rate` */
  currency: string;
}

/** One way to pay one order, already registered with the gateway */
export interface Leg {
  /** The watched payment's id, which is what `firstSettled`, `payment` and `settled` take */
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

/** What every rail takes, whatever it moves */
export interface RailConfig {
  /** Groups every payment from this rail so `follow` can watch the shop */
  trigger?: string;

  /** How many of that trigger's settlements the gateway keeps replayable past the hour */
  replay?: number;

  /** Where the gateway posts once the money lands, a public https URL */
  webhookUrl?: string;

  /** What `Leg.rail` says, so two rails of one kind can be told apart */
  name?: string;
}

/** A Lightning rail the gateway mints for, bound once and then given one order at a time */
export interface LightningRailConfig extends RailConfig {
  /** Priority list, the first address that can prove an invoice wins */
  to: string | string[];

  /**
   * What to charge for one order, the order's own price converted at `rate` by
   * default. Give it a function and the price is whatever you say
   */
  amount?: (order: Order) => Amount;

  /** Where the default conversion gets its rate, the median of four venues by default */
  rate?: Ticker;

  /** Makes the mint safe to retry, the order's reference by default */
  idempotencyKey?: (order: Order) => string | undefined;
}

/** The same rail with the invoice resolved here, so the gateway is told neither address nor amount */
export interface BlindLightningRailConfig extends LightningRailConfig {
  /**
   * What the watcher needs and the gateway must not read, sealed with `seal`
   * before it goes anywhere near the gateway
   */
  sealed?: (order: Order) => string | Promise<string>;

  /**
   * Where your own `serve.verify` endpoint is mounted, and its secret. Without
   * it the gateway is handed the wallet's own URL, which a gateway enforcing its
   * verify challenge will refuse to poll
   */
  relayThrough?: { endpoint: string; secret: string };
}

/** A bank rail: the account the money lands in, and where its arrival is read back from */
export interface BankRailConfig extends RailConfig {
  /** Long lived and server side. Every preimage is derived from it, so losing it loses every proof */
  secret: string;

  /** The account the money goes to, as an IBAN */
  iban: string;

  /** Where `serve.bankVerify` is mounted, a public https URL with no query of its own */
  verifyUrl: string;

  /** When this leg stops being payable, in unix seconds */
  expiresAt: (order: Order) => number;

  /** Sealed before the gateway sees it, the way the blind Lightning rail does */
  sealed?: (order: Order) => string | Promise<string>;

  /** The Czech variable symbol, taken off the reference's digits by default */
  variableSymbol?: (order: Order) => string | undefined;

  /**
   * Register on a gateway you do not own anyway. The verify URL names the amount
   * and the reference, so its operator could read your order book off the watches
   */
  allowPublicGateway?: boolean;
}

/**
 * Sell for a bank transfer. The money moves straight to your account and the
 * gateway is told a hash, a URL and an expiry, never the amount or the reference.
 *
 * Which bank is read back is `serve.bankVerify`'s business, not this one's, so
 * a rail built here serves Fio and anything else behind a `Statement`.
 */
export function bankRail(gateway: ThunderBridge, config: BankRailConfig): Rail {
  return async (order) => {
    const expiresAt = config.expiresAt(order);
    const transfer = await bankTransfer(gateway, {
      secret: config.secret,
      iban: config.iban,
      verifyUrl: config.verifyUrl,
      reference: order.reference,
      amountMinor: order.amountMinor,
      currency: order.currency,
      expiresAt,
      trigger: config.trigger,
      replay: config.replay,
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
 * address list and the amount, which is the round trip `blindLightning` spends
 * to avoid.
 */
export function lightningRail(gateway: ThunderBridge, config: LightningRailConfig): Rail {
  return async (order) => {
    const payment = await gateway.mint(
      {
        to: config.to,
        amount: await pricedFor(order, config.amount, config.rate),
        webhookUrl: config.webhookUrl,
      },
      {
        idempotencyKey: config.idempotencyKey?.(order),
        trigger: config.trigger,
        replay: config.replay,
      },
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
export function blindLightningRail(gateway: ThunderBridge, config: BlindLightningRailConfig): Rail {
  return async (order) => {
    const resolved = await invoiceFrom(
      config.to,
      await pricedFor(order, config.amount, config.rate),
    );
    const relay = config.relayThrough;
    const watched = await gateway.watch({
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
      replay: config.replay,
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

/**
 * A provable invoice from the first address on the list that will issue one, which
 * is what a client mints for itself rather than asking a gateway to. Everything the
 * gateway needs to watch it comes back with everything you need to prove it came
 * from the address you asked for, so you can hand over the first and keep the second.
 *
 * Server side: it resolves hostnames and refuses a private one, which no browser can
 * do. Throws `NoWalletAvailableError` when no address on the list would serve
 */
export async function invoiceFrom(to: string | string[], amount: Amount): Promise<Resolved> {
  const addresses = typeof to === "string" ? [to] : to;
  try {
    return await resolve(addresses, await millisatoshi(amount));
  } catch (refused: unknown) {
    if (refused instanceof NoWalletAvailable) {
      throw new NoWalletAvailableError({ title: refused.message }, refused.wallets);
    }
    throw refused;
  }
}

/**
 * What one order costs on a Lightning rail: whatever the rail says, or the
 * order's own fiat price converted at the rate when nothing says otherwise
 */
export async function pricedFor(
  order: Order,
  amount: ((order: Order) => Amount) | undefined,
  rate: Ticker | undefined,
): Promise<Msat> {
  if (amount !== undefined) {
    return await millisatoshi(amount(order));
  }

  return msat(msatFor(order.amountMinor, await (rate ?? medianOf())(order.currency)));
}

/**
 * One call per sale, whatever the rail moves. Each of these was a free function
 * taking the gateway as a config field, and reaching them through the gateway is
 * what deleted that field
 */
export class Rails {
  constructor(private readonly gateway: ThunderBridge) {}

  /** Lightning, with the gateway minting against a priority list of addresses */
  lightning(config: LightningRailConfig): Rail {
    return lightningRail(this.gateway, config);
  }

  /**
   * Lightning, with the invoice resolved here so the gateway is told neither the
   * address nor the amount
   */
  blindLightning(config: BlindLightningRailConfig): Rail {
    return blindLightningRail(this.gateway, config);
  }

  /** A bank transfer, proved the way a Lightning payment is */
  bank(config: BankRailConfig): Rail {
    return bankRail(this.gateway, config);
  }

  /**
   * One bank transfer without building a rail first, for a shop that asks for
   * them one at a time rather than beside another payment method
   */
  transfer(params: BankTransferParams): Promise<BankTransfer> {
    return bankTransfer(this.gateway, params);
  }
}
