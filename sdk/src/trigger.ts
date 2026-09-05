import { equalInConstantTime, hmacHex } from "../../core/hmac.js";
import { resolve } from "../../core/lnurl.js";
import { seal } from "../../core/sealed.js";
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
