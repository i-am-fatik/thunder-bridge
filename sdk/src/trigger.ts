import { equalInConstantTime, hmacHex } from "../../core/hmac.js";
import { resolve } from "../../core/lnurl.js";
import type { Send } from "../../core/outbound.js";
import { pinnedToTheAddressWeVerified } from "../../core/pinned.js";
import { seal } from "../../core/sealed.js";
import { sha256Hex } from "../../core/sha256.js";
import type { Amount } from "./amount.js";
import { amountNow, msat } from "./amount.js";
import type { ThunderBridge } from "./client.js";
import { isProblemType, PAYMENT_ALREADY_WATCHED, ProblemError } from "./errors.js";
import { relayedVerifyUrl } from "./relay.js";

const NONCE_BYTES = 16;

/** An LNURL-pay endpoint of your own: whose wallets it stands for, and what it charges */
export interface TriggerConfig {
  /** Priority list, quoted at payRequest and then pinned for the callback */
  paidTo: string | string[];

  /**
   * What this trigger costs right now, asked once per payRequest. `fiat` makes it
   * a live rate, and any function of your own makes it a time of day rule.
   *
   * Give it a `{ least, most }` range instead and the payer chooses inside it,
   * which is what a tip jar is. One amount pins the price and the wallet offers
   * no field to type in
   */
  amount: Amount | Range;

  /**
   * Signs the callback URL. Without it anyone could call the callback and make
   * this endpoint mint invoices on wallets of their choosing
   */
  secret: string;

  /** Groups every payment here so `follow` can watch the place, keep it off the QR */
  watchSecret?: string;

  /**
   * How many settlements of this place the gateway keeps replayable past the hour
   * it would otherwise forget them in, up to the ceiling its operator set. What a
   * page that opens later still gets to see. Needs `watchSecret`
   */
  replay?: number;

  /** How the endpoint reaches wallets, pinned to the address it verified unless you say otherwise */
  send?: Send;

  /** Override when a proxy hides the public URL from the request, no trailing slash */
  baseUrl?: string;

  /**
   * Resolve the address here and hand the gateway only a hash and a URL to poll,
   * instead of asking it to mint. It then cannot tell who is being paid beyond
   * the domain in the verify URL, nor how much at all, so the only refusal left
   * to it is refusing everyone. Costs one more round trip and gives up the
   * gateway's CORS proxying, which a server does not need anyway.
   *
   * A gateway that enforces its verify challenge will not poll a wallet's own
   * LUD-21 URL, so pass `relayThrough` as well and the poll comes to you
   */
  blind?: boolean;

  /**
   * Where your own `serve.verify` endpoint is mounted, and the secret it was
   * given. The wallet's URL is sealed inside the one the gateway is handed, so
   * the gateway polls you and learns neither the wallet nor its provider
   */
  relayThrough?: { endpoint: string; secret: string };

  /**
   * What the watcher needs and the gateway must not have. `data` returns it and
   * `secret` encrypts it, so there is no way to hand the gateway something it
   * can read. Needs 32 characters of randomness, not a passphrase, and every
   * watcher of this trigger holds the same one
   */
  sealed?: { secret: string; data: (minted: Minted) => unknown };
}

/** What a blind mint produced, which is what the sealed payload is built from */
/**
 * What a payer may choose to send, when the endpoint lets them choose at all.
 * Both ends are asked once per payRequest, so a fiat range moves with the rate
 */
export interface Range {
  least: Amount;
  most: Amount;
}

/** What a blind mint produced, which is what the sealed payload is built from */
export interface Minted {
  lnAddress: string;
  amountMsat: number;
  bolt11: string;
  paymentHash: string;
  verifyUrl: string;
  expiresAt: number;
}

/**
 * A trigger's live stream is opened with a ticket rather than with the watch
 * secret, so something has to hold the secret and trade it for tickets. That is
 * what these two endpoints are, and they are the only place the gateway's token
 * has to be
 */
export interface WatchTicketConfig {
  /** The trigger to open, the same secret `serve.lnurlPay` groups its payments under */
  watchSecret: string;

  /**
   * How many of this trigger's settlements the socket replays on connect, so a
   * page opened late still shows what it missed, up to the gateway's ceiling
   */
  replay?: number;
}

/**
 * An LNURL-pay endpoint standing in front of a priority list of addresses, as a
 * Fetch handler so it runs on Deno Deploy, Workers, Hono, Next and Node alike.
 *
 * It answers both halves of the flow on one path. A bare request is the
 * payRequest and quotes the list, and a signed one is the callback and mints.
 * The winner is chosen at payRequest and pinned into the callback URL because
 * LUD-06 binds the invoice to the metadata already served: if the callback
 * picked a different address the payer's wallet would refuse the invoice.
 *
 * Nothing is stored between the two, so this holds no state of its own.
 */
export function lnurlPayEndpoint(
  gateway: ThunderBridge,
  config: TriggerConfig,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const url = new URL(request.url);
    const asked = url.searchParams.get("to");

    try {
      return asked === null
        ? await offer(gateway, config, url)
        : await mint(gateway, config, url, asked);
    } catch (failure: unknown) {
      return refuse(failure instanceof Error ? failure.message : "the trigger could not be served");
    }
  };
}

/**
 * Trades the watch secret for a socket ticket, for a board that is not public.
 * The caller has to know the secret already, so all this adds is that the secret
 * stops travelling in socket URLs, where the gateway, every proxy in front of it
 * and the browser's own history all keep a copy. Anyone without it gets a 403.
 *
 * POST to it before every connect, because a ticket lives one minute.
 */
export function watchTicketEndpoint(
  gateway: ThunderBridge,
  config: WatchTicketConfig,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const offered = await offeredSecret(request);
    if (!equalInConstantTime(sha256Hex(offered), sha256Hex(config.watchSecret))) {
      return Response.json({ reason: "not the watch secret" }, { status: 403 });
    }

    return await issue(gateway, config);
  };
}

/**
 * Mints a socket ticket for anybody who asks, for a board meant to be read by
 * strangers. It reads no body and refuses nobody, which makes the trigger's
 * whole stream public: every viewer gets each settlement's preimage, verify url
 * and payment hash.
 *
 * Only for a trigger where that is the point. Gate anything on those preimages
 * and a viewer of the board is holding the unlock.
 */
export function publicWatchTicketEndpoint(
  gateway: ThunderBridge,
  config: WatchTicketConfig,
): (request: Request) => Promise<Response> {
  return () => issue(gateway, config);
}

async function offer(gateway: ThunderBridge, config: TriggerConfig, url: URL): Promise<Response> {
  const { least, most } = await spread(config.amount);
  const quote = await gateway.quote({ paidTo: config.paidTo, amount: msat(least) });

  const nonce = randomNonce();
  const callback = new URL(config.baseUrl ?? `${url.origin}${url.pathname}`);
  callback.searchParams.set("to", quote.lnAddress);
  callback.searchParams.set("least", String(least));
  callback.searchParams.set("most", String(most));
  callback.searchParams.set("n", nonce);
  callback.searchParams.set("sig", await sign(config.secret, quote.lnAddress, least, most, nonce));

  return Response.json({
    tag: "payRequest",
    callback: callback.toString(),
    metadata: quote.metadata,
    minSendable: least,
    maxSendable: most,
  });
}

async function spread(amount: Amount | Range): Promise<{ least: number; most: number }> {
  if (typeof amount === "number" || typeof amount === "function") {
    const pinned = await amountNow(amount);

    return { least: pinned, most: pinned };
  }

  const least = await amountNow(amount.least);
  const most = await amountNow(amount.most);
  if (most < least) {
    throw new Error(`a range cannot end at ${most} msat when it starts at ${least}`);
  }

  return { least, most };
}

async function mint(
  gateway: ThunderBridge,
  config: TriggerConfig,
  url: URL,
  address: string,
): Promise<Response> {
  const least = Number(url.searchParams.get("least"));
  const most = Number(url.searchParams.get("most"));
  const nonce = url.searchParams.get("n") ?? "";
  const signature = url.searchParams.get("sig") ?? "";
  const expected = await sign(config.secret, address, least, most, nonce);
  if (!equalInConstantTime(signature, expected)) {
    return refuse("this callback was not signed here");
  }

  const asked = url.searchParams.get("amount");
  const amountMsat = asked === null ? least : Number(asked);
  if (!Number.isSafeInteger(amountMsat) || amountMsat < least || amountMsat > most) {
    return refuse(
      least === most
        ? `this trigger costs exactly ${least} msat`
        : `this trigger takes between ${least} and ${most} msat`,
    );
  }

  const minted = config.blind
    ? await mintBlind(gateway, config, address, amountMsat)
    : await mintThroughGateway(gateway, config, address, amountMsat, nonce);

  return Response.json({
    status: "OK",
    pr: minted.bolt11,
    routes: [],
    verify: minted.verifyUrl,
  });
}

async function mintThroughGateway(
  gateway: ThunderBridge,
  config: TriggerConfig,
  address: string,
  amountMsat: number,
  nonce: string,
): Promise<{ bolt11: string; verifyUrl: string }> {
  const payment = await gateway.mint(
    { paidTo: address, amount: msat(amountMsat) },
    { idempotencyKey: nonce, trigger: config.watchSecret, replay: config.replay },
  );

  return { bolt11: payment.bolt11, verifyUrl: payment.verifyUrl };
}

async function mintBlind(
  gateway: ThunderBridge,
  config: TriggerConfig,
  address: string,
  amountMsat: number,
): Promise<{ bolt11: string; verifyUrl: string }> {
  const resolved = await resolve(
    config.send ?? pinnedToTheAddressWeVerified,
    [address],
    amountMsat,
  );
  const minted: Minted = { ...resolved, amountMsat, lnAddress: resolved.address };
  const locked = config.sealed;
  const relay = config.relayThrough;

  try {
    await gateway.watch({
      paymentHash: resolved.paymentHash,
      verifyUrl: relay
        ? await relayedVerifyUrl(
            relay.endpoint,
            { url: resolved.verifyUrl, hash: resolved.paymentHash },
            relay.secret,
          )
        : resolved.verifyUrl,
      expiresAt: resolved.expiresAt,
      trigger: config.watchSecret,
      replay: config.replay,
      sealed: locked ? await seal(locked.secret, JSON.stringify(locked.data(minted))) : undefined,
    });
  } catch (refused: unknown) {
    if (!alreadyWatched(refused)) {
      throw refused;
    }
  }

  return { bolt11: resolved.bolt11, verifyUrl: resolved.verifyUrl };
}

function alreadyWatched(refused: unknown): boolean {
  return refused instanceof ProblemError && isProblemType(refused, PAYMENT_ALREADY_WATCHED);
}

function sign(
  secret: string,
  address: string,
  least: number,
  most: number,
  nonce: string,
): Promise<string> {
  return hmacHex(secret, `${address}|${least}|${most}|${nonce}`);
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
}

function refuse(reason: string): Response {
  return Response.json({ status: "ERROR", reason });
}

async function issue(gateway: ThunderBridge, config: WatchTicketConfig): Promise<Response> {
  const issued = await gateway.ticket(config.watchSecret, { replay: config.replay });

  return Response.json({
    ticket: issued.ticket,
    expires_at: new Date(issued.expiresAt * 1000).toISOString(),
  });
}

async function offeredSecret(request: Request): Promise<string> {
  const body = (await request.json().catch(() => null)) as { secret?: unknown } | null;

  return typeof body?.secret === "string" ? body.secret : "";
}
