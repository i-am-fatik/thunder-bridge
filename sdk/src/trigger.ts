import { equalInConstantTime, hmacHex } from "../../core/hmac.js";
import { resolve } from "../../core/lnurl.js";
import { seal } from "../../core/sealed.js";
import { sha256Hex } from "../../core/sha256.js";
import type { ThunderBridge } from "./client.js";
import { isProblemType, PAYMENT_ALREADY_WATCHED, ProblemError } from "./errors.js";

const NONCE_BYTES = 16;

export interface TriggerConfig {
  /** The gateway that quotes the addresses and mints the invoice */
  gateway: ThunderBridge;

  /** Priority list, quoted at payRequest and then pinned for the callback */
  lnAddresses: string[];

  /**
   * What this trigger costs right now, called once per payRequest. A plain
   * function, so a fiat peg or a time of day rule is just code you write
   */
  amountMsat: () => number | Promise<number>;

  /**
   * Signs the callback URL. Without it anyone could call the callback and make
   * this endpoint mint invoices on wallets of their choosing
   */
  secret: string;

  /** Groups every payment here so `followTrigger` can watch the place, keep it off the QR */
  watchSecret?: string;

  /**
   * How many settlements of this place the gateway keeps replayable past the hour
   * it would otherwise forget them in, up to the ceiling its operator set. What a
   * page that opens later still gets to see. Needs `watchSecret`
   */
  replay?: number;

  /** Override when a proxy hides the public URL from the request, no trailing slash */
  baseUrl?: string;

  /**
   * Resolve the address here and hand the gateway only a hash and a URL to poll,
   * instead of asking it to mint. It then cannot tell who is being paid beyond
   * the domain in the verify URL, nor how much at all, so the only refusal left
   * to it is refusing everyone. Costs one more round trip and gives up the
   * gateway's CORS proxying, which a server does not need anyway
   */
  blind?: boolean;

  /**
   * What the watcher needs and the gateway must not have. `data` returns it and
   * `secret` encrypts it, so there is no way to hand the gateway something it
   * can read. Needs 32 characters of randomness, not a passphrase, and every
   * watcher of this trigger holds the same one
   */
  sealed?: { secret: string; data: (minted: Minted) => unknown };
}

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
  /** The gateway that mints the ticket, holding the token this keeps off the wire */
  gateway: ThunderBridge;

  /** The trigger to open, the same secret `lnurlPayEndpoint` groups its payments under */
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
export function lnurlPayEndpoint(config: TriggerConfig): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const url = new URL(request.url);
    const asked = url.searchParams.get("to");

    try {
      return asked === null ? await offer(config, url) : await mint(config, url, asked);
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
  config: WatchTicketConfig,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const offered = await offeredSecret(request);
    if (!equalInConstantTime(sha256Hex(offered), sha256Hex(config.watchSecret))) {
      return Response.json({ reason: "not the watch secret" }, { status: 403 });
    }

    return await issue(config);
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
  config: WatchTicketConfig,
): (request: Request) => Promise<Response> {
  return () => issue(config);
}

async function offer(config: TriggerConfig, url: URL): Promise<Response> {
  const amountMsat = await config.amountMsat();
  const quote = await config.gateway.createQuote({
    lnAddresses: config.lnAddresses,
    amountMsat,
  });

  const nonce = randomNonce();
  const callback = new URL(config.baseUrl ?? `${url.origin}${url.pathname}`);
  callback.searchParams.set("to", quote.lnAddress);
  callback.searchParams.set("msat", String(amountMsat));
  callback.searchParams.set("n", nonce);
  callback.searchParams.set("sig", await sign(config.secret, quote.lnAddress, amountMsat, nonce));

  return Response.json({
    tag: "payRequest",
    callback: callback.toString(),
    metadata: quote.metadata,
    minSendable: amountMsat,
    maxSendable: amountMsat,
  });
}

async function mint(config: TriggerConfig, url: URL, address: string): Promise<Response> {
  const amountMsat = Number(url.searchParams.get("msat"));
  const nonce = url.searchParams.get("n") ?? "";
  const signature = url.searchParams.get("sig") ?? "";
  const expected = await sign(config.secret, address, amountMsat, nonce);
  if (!equalInConstantTime(signature, expected)) {
    return refuse("this callback was not signed here");
  }

  const wanted = url.searchParams.get("amount");
  if (wanted !== null && Number(wanted) !== amountMsat) {
    return refuse(`this trigger costs exactly ${amountMsat} msat`);
  }

  const minted = config.blind
    ? await mintBlind(config, address, amountMsat)
    : await mintThroughGateway(config, address, amountMsat, nonce);

  return Response.json({
    status: "OK",
    pr: minted.bolt11,
    routes: [],
    verify: minted.verifyUrl,
  });
}

async function mintThroughGateway(
  config: TriggerConfig,
  address: string,
  amountMsat: number,
  nonce: string,
): Promise<{ bolt11: string; verifyUrl: string }> {
  const payment = await config.gateway.createPayment(
    { lnAddresses: [address], amountMsat },
    { idempotencyKey: nonce, trigger: config.watchSecret, replay: config.replay },
  );

  return { bolt11: payment.bolt11, verifyUrl: payment.verifyUrl };
}

async function mintBlind(
  config: TriggerConfig,
  address: string,
  amountMsat: number,
): Promise<{ bolt11: string; verifyUrl: string }> {
  const resolved = await resolve([address], amountMsat);
  const minted: Minted = { ...resolved, amountMsat, lnAddress: resolved.address };
  const locked = config.sealed;

  try {
    await config.gateway.watchPayment({
      paymentHash: resolved.paymentHash,
      verifyUrl: resolved.verifyUrl,
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

function sign(secret: string, address: string, amountMsat: number, nonce: string): Promise<string> {
  return hmacHex(secret, `${address}|${amountMsat}|${nonce}`);
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

async function issue(config: WatchTicketConfig): Promise<Response> {
  const issued = await config.gateway.createSocketTicket({
    trigger: config.watchSecret,
    replay: config.replay,
  });

  return Response.json({
    ticket: issued.ticket,
    expires_at: new Date(issued.expiresAt * 1000).toISOString(),
  });
}

async function offeredSecret(request: Request): Promise<string> {
  const body = (await request.json().catch(() => null)) as { secret?: unknown } | null;

  return typeof body?.secret === "string" ? body.secret : "";
}
