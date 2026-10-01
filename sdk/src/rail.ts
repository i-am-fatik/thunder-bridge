import { type Resolved, resolve } from "../../core/lnurl.js";
import type { Send } from "../../core/outbound.js";
import { pinnedToTheAddressWeVerified } from "../../core/pinned.js";
import { NoWalletAvailable } from "../../core/refusal.js";
import { seal } from "../../core/sealed.js";
import { type Amount, amountNow, type Msat, msat } from "./amount.js";
import { type BankTransfer, type BankTransferParams, bankTransfer } from "./bank.js";
import type { ThunderBridge } from "./client.js";
import { NoWalletAvailableError } from "./errors.js";
import { type NwcRailConfig, nwcRail } from "./nwc.js";
import { medianOf, msatFor, type Ticker } from "./price.js";
import { toLightningUri } from "./qr.js";
import { relayedVerifyUrl, type VerifyPath, type VerifyThrough, verifiedThrough } from "./relay.js";

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
  /** The watched payment's id, which with `paymentHash` is what `firstSettled`, `payment` and `settled` take */
  id: string;

  paymentHash: string;

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

/** Who a Lightning rail pays and what one order costs there, whichever path verifies it */
export interface LightningRailSettings extends RailConfig {
  /** Priority list, the first address that can prove an invoice wins */
  paidTo: string | string[];

  /**
   * What to charge for one order, the order's own price converted at `rate` by
   * default. Give it a function and the price is whatever you say
   */
  amount?: (order: Order) => Amount;

  /** Where the default conversion gets its rate, the median of four venues by default */
  rate?: Ticker;

  /** Makes the gateway's mint safe to retry, so it applies with `gatewayMints` only */
  idempotencyKey?: (order: Order) => string | undefined;

  /**
   * What the watcher needs and the gateway must not read, sealed under `secret`
   * for the invoice's payment hash before it goes anywhere near the gateway
   */
  sealed?: { secret: string; data: (order: Order) => unknown };

  /** How the rail reaches wallets, pinned to the address it verified unless you say otherwise */
  send?: Send;
}

/**
 * A Lightning rail, bound once and then given one order at a time. With
 * `verifyThrough` the invoice is resolved here and the gateway polls your
 * `serve.lightningVerify`, learning neither who is paid nor how much. With
 * `gatewayMints` the gateway is told both, mints, and polls the wallet itself
 */
export type LightningRailConfig = LightningRailSettings & VerifyPath;

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

  /** Sealed before the gateway sees it, the way the Lightning rail does */
  sealed?: { secret: string; data: (order: Order) => unknown };

  /** The Czech variable symbol, taken off the reference's digits by default */
  variableSymbol?: (order: Order) => string | undefined;

  /**
   * Register on a gateway you do not own anyway. The sealed verify URL names
   * nothing about the order, but its operator still learns every watch you place
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
      sealed: config.sealed && { secret: config.sealed.secret, data: config.sealed.data(order) },
      variableSymbol: config.variableSymbol?.(order),
      webhookUrl: config.webhookUrl,
      allowPublicGateway: config.allowPublicGateway,
    });

    return {
      id: transfer.id,
      paymentHash: transfer.paymentHash,
      rail: config.name ?? BANK,
      scan: transfer.spd,
      qr: transfer.spd,
      expiresAt,
    };
  };
}

/**
 * Sell for Lightning. By default the address is resolved here and the gateway is
 * handed only a hash and a URL of yours, which costs one round trip and a server.
 * `gatewayMints` spends neither and tells the gateway the address list and the
 * amount instead.
 */
export function lightningRail(gateway: ThunderBridge, config: LightningRailConfig): Rail {
  const through = verifiedThrough(config);

  return through === null
    ? mintedByGateway(gateway, config)
    : resolvedHere(gateway, config, through);
}

function mintedByGateway(gateway: ThunderBridge, config: LightningRailSettings): Rail {
  return async (order) => {
    const payment = await gateway.mint(
      {
        paidTo: config.paidTo,
        amount: await msatForOrder(order, config.amount, config.rate),
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
      paymentHash: payment.paymentHash,
      rail: config.name ?? LIGHTNING,
      scan: payment.bolt11,
      qr: toLightningUri(payment.bolt11),
      expiresAt: payment.expiresAt,
    };
  };
}

function resolvedHere(
  gateway: ThunderBridge,
  config: LightningRailSettings,
  through: VerifyThrough,
): Rail {
  return async (order) => {
    const resolved = await invoiceFrom(
      config.paidTo,
      await msatForOrder(order, config.amount, config.rate),
      config.send,
    );
    const watched = await gateway.watch({
      paymentHash: resolved.paymentHash,
      verifyUrl: await relayedVerifyUrl(
        through.endpoint,
        { url: resolved.verifyUrl, hash: resolved.paymentHash },
        through.secret,
      ),
      expiresAt: resolved.expiresAt,
      trigger: config.trigger,
      replay: config.replay,
      sealed: config.sealed
        ? await seal(
            config.sealed.secret,
            JSON.stringify(config.sealed.data(order)),
            resolved.paymentHash,
          )
        : undefined,
      webhookUrl: config.webhookUrl,
    });

    return {
      id: watched.id,
      paymentHash: resolved.paymentHash,
      rail: config.name ?? LIGHTNING,
      scan: resolved.bolt11,
      qr: toLightningUri(resolved.bolt11),
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
export async function invoiceFrom(
  paidTo: string | string[],
  amount: Amount,
  send: Send = pinnedToTheAddressWeVerified,
): Promise<Resolved> {
  const addresses = typeof paidTo === "string" ? [paidTo] : paidTo;
  try {
    return await resolve(send, addresses, await amountNow(amount));
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
export async function msatForOrder(
  order: Order,
  amount: ((order: Order) => Amount) | undefined,
  rate: Ticker | undefined,
): Promise<Msat> {
  if (amount !== undefined) {
    return await amountNow(amount(order));
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

  /**
   * Lightning against a priority list of addresses, verified through your
   * `serve.lightningVerify`, or minted by the gateway when you say `gatewayMints`
   */
  lightning(config: LightningRailConfig): Rail {
    return lightningRail(this.gateway, config);
  }

  /** A bank transfer, proved the way a Lightning payment is */
  bank(config: BankRailConfig): Rail {
    return bankRail(this.gateway, config);
  }

  /**
   * Lightning against a wallet of your own over NIP-47, for a wallet that has no
   * LUD-21 address to be watched at. Your node mints the invoice and releases the
   * preimage, so the proof comes from one hop nearer than any hosted address can
   * manage, and the gateway sees a hash and a URL of yours
   */
  nwc(config: NwcRailConfig): Rail {
    return nwcRail(this.gateway, config);
  }

  /**
   * One bank transfer without building a rail first, for a shop that asks for
   * them one at a time rather than beside another payment method
   */
  transfer(params: BankTransferParams): Promise<BankTransfer> {
    return bankTransfer(this.gateway, params);
  }
}
