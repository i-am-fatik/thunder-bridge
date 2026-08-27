import { decodeInvoice, preimageMatchesHash } from "../../core/bolt11.js";
import { type WalletReason, WalletRefused } from "../../core/refusal.js";
import { seal, unseal } from "../../core/sealed.js";
import {
  conversationKeyFor,
  decryptNip44,
  encryptNip44,
  type NostrEvent,
  publicKeyFor,
  signEvent,
  verifyEvent,
} from "./nostr.js";
import { answerVerifyChallengeRequest } from "./webhook.js";

const REQUEST_KIND = 23194;
const RESPONSE_KIND = 23195;
const NIP44_V2 = "nip44_v2";
const SCHEME = "nostr+walletconnect:";
const HEX_32_BYTES = /^[0-9a-f]{64}$/i;
const DEFAULT_ASK_TIMEOUT_MS = 10_000;
const PAY_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_EVERY_SECS = 5;
const HASH = "h";

const REFUSAL_BY_CODE: Record<string, WalletReason> = {
  INSUFFICIENT_BALANCE: "amount-not-accepted",
  QUOTA_EXCEEDED: "amount-not-accepted",
  RESTRICTED: "address-unusable",
  UNAUTHORIZED: "address-unusable",
  UNSUPPORTED_ENCRYPTION: "address-unusable",
};

/** A wallet reachable over NIP-47, as its `nostr+walletconnect://` URI describes it */
export interface NwcConnection {
  /** The wallet service's public key, which is what its answers have to be signed by */
  walletPubkey: string;

  /** Where to reach it, tried in order until one answers */
  relays: string[];

  /** Our own private key on this connection, and the only thing that authorises it */
  secret: string;
}

/** A minted invoice and everything needed to watch it */
export interface NwcInvoice {
  bolt11: string;
  paymentHash: string;
  expiresAt: number;
}

export interface NwcVerifyConfig {
  /** The wallet this endpoint speaks for. It never leaves this process */
  connection: NwcConnection;

  /** The secret the payment hash was sealed with, and nothing else uses it */
  secret: string;

  /** How often the gateway should ask, in seconds, sent as `Cache-Control: max-age`, `5` by default */
  pollEverySecs?: number;

  /** How long one `lookup_invoice` may take before the wallet counts as unreachable, `10_000` by default */
  askTimeoutMs?: number;
}

/**
 * Read a `nostr+walletconnect://` URI. Refuses a relay that is not `wss`, for the
 * reason the gateway refuses a verify URL that is not https
 */
export function nwcConnection(uri: string): NwcConnection {
  const parsed = parsedUri(uri);
  const walletPubkey = parsed.pathname.replace(/^\/+/, "") || parsed.host;
  const secret = parsed.searchParams.get("secret") ?? "";
  const relays = parsed.searchParams.getAll("relay");

  if (!HEX_32_BYTES.test(walletPubkey)) {
    throw new WalletRefused("address-unusable", "an nwc uri names a 32-byte wallet pubkey");
  }
  if (!HEX_32_BYTES.test(secret)) {
    throw new WalletRefused("address-unusable", "an nwc uri carries a 32-byte hex secret");
  }
  if (relays.length === 0 || !relays.every(isSecureRelay)) {
    throw new WalletRefused("address-unusable", "every nwc relay has to be a wss URL");
  }

  return { walletPubkey: walletPubkey.toLowerCase(), relays, secret: secret.toLowerCase() };
}

/** Mint an invoice on the connected wallet, decoded so the caller need not trust its word */
export async function nwcInvoice(
  connection: NwcConnection,
  amountMsat: number,
  description: string,
  timeoutMs = DEFAULT_ASK_TIMEOUT_MS,
): Promise<NwcInvoice> {
  const answered = await askWallet(
    connection,
    "make_invoice",
    { amount: amountMsat, description },
    timeoutMs,
  );
  const bolt11 = String((answered as { invoice?: unknown }).invoice ?? "");
  const issued = decodeInvoice(bolt11);

  if (issued.paymentHash === null || issued.expiresAt === null) {
    throw new WalletRefused("invoice-refused", "the nwc wallet issued an invoice we cannot decode");
  }
  if (issued.amountMsat !== amountMsat) {
    throw new WalletRefused(
      "invoice-refused",
      `the nwc wallet issued an invoice for ${issued.amountMsat} msat, not ${amountMsat}`,
    );
  }

  return { bolt11, paymentHash: issued.paymentHash, expiresAt: issued.expiresAt };
}

/**
 * Mint a hold invoice on a hash the wallet does not hold the preimage for, which
 * is what lets an operator be paid only by paying somebody else first. The hash
 * has to come from the recipient's own invoice, and the invoice that comes back
 * is decoded rather than believed
 */
export async function nwcHoldInvoice(
  connection: NwcConnection,
  held: {
    paymentHash: string;
    amountMsat: number;
    description: string;
    expirySecs: number;
    minCltvExpiryDelta?: number;
  },
  timeoutMs = DEFAULT_ASK_TIMEOUT_MS,
): Promise<NwcInvoice> {
  const answered = await askWallet(
    connection,
    "make_hold_invoice",
    {
      amount: held.amountMsat,
      description: held.description,
      payment_hash: held.paymentHash,
      expiry: held.expirySecs,
      ...(held.minCltvExpiryDelta === undefined
        ? {}
        : { min_cltv_expiry_delta: held.minCltvExpiryDelta }),
    },
    timeoutMs,
  );
  const bolt11 = String((answered as { invoice?: unknown }).invoice ?? "");
  const issued = decodeInvoice(bolt11);

  if (issued.paymentHash === null || issued.expiresAt === null) {
    throw new WalletRefused("invoice-refused", "the nwc wallet held an invoice we cannot decode");
  }
  if (issued.paymentHash.toLowerCase() !== held.paymentHash.toLowerCase()) {
    throw new WalletRefused(
      "invoice-refused",
      `the nwc wallet held ${issued.paymentHash} rather than the ${held.paymentHash} asked for`,
    );
  }
  if (issued.amountMsat !== held.amountMsat) {
    throw new WalletRefused(
      "invoice-refused",
      `the nwc wallet held an invoice for ${issued.amountMsat} msat, not ${held.amountMsat}`,
    );
  }

  return { bolt11, paymentHash: issued.paymentHash, expiresAt: issued.expiresAt };
}

/**
 * The preimage the wallet released for this hash, null while it has released
 * none. A preimage that does not hash to what was asked for is a lie rather than
 * an answer, so it throws instead of being passed on
 */
export async function nwcSettlement(
  connection: NwcConnection,
  paymentHash: string,
  timeoutMs = DEFAULT_ASK_TIMEOUT_MS,
): Promise<string | null> {
  const answered = await askWallet(
    connection,
    "lookup_invoice",
    { payment_hash: paymentHash },
    timeoutMs,
  );
  const preimage = (answered as { preimage?: unknown }).preimage;

  if (typeof preimage !== "string" || preimage.length === 0) {
    return null;
  }
  if (!preimageMatchesHash(preimage, paymentHash)) {
    throw new Error(`the nwc wallet returned a preimage that does not hash to ${paymentHash}`);
  }

  return preimage;
}

/**
 * Pay an invoice and keep the preimage the network handed back. Whoever pays
 * learns it, which is what makes delivery provable to a recipient publishing no
 * LUD-21 of their own. A preimage that does not hash to the invoice's own hash is
 * a lie rather than a receipt, so it throws instead of being passed on
 */
export async function nwcPay(
  connection: NwcConnection,
  bolt11: string,
  timeoutMs = PAY_TIMEOUT_MS,
): Promise<string> {
  const owed = decodeInvoice(bolt11);
  if (owed.paymentHash === null) {
    throw new WalletRefused("invoice-refused", "the invoice to pay carries no payment hash");
  }

  const answered = await askWallet(connection, "pay_invoice", { invoice: bolt11 }, timeoutMs);
  const preimage = (answered as { preimage?: unknown }).preimage;

  if (typeof preimage !== "string" || !preimageMatchesHash(preimage, owed.paymentHash)) {
    throw new Error(`the nwc wallet paid and returned no preimage hashing to ${owed.paymentHash}`);
  }

  return preimage;
}

/**
 * A verify endpoint of your own that asks your wallet over NIP-47, so the gateway
 * polls you and never learns the connection, the relay, or which wallet it is.
 *
 * `nwcVerifyUrl` seals the payment hash into the query with your secret, which is
 * what stops a stranger driving your wallet through this handler. It answers the
 * LUD-21 shape the gateway already speaks, so nothing on that side changes.
 *
 * A wallet it cannot reach answers `502` rather than "not settled", because those
 * are different claims and only one of them is true.
 */
export function nwcVerifyEndpoint(
  config: NwcVerifyConfig,
): (request: Request) => Promise<Response> {
  const paced = {
    "cache-control": `max-age=${config.pollEverySecs ?? DEFAULT_POLL_EVERY_SECS}`,
  };

  return async (request: Request) => {
    const consented = await answerVerifyChallengeRequest(request);
    if (consented !== null) {
      return consented;
    }

    const sealed = new URL(request.url).searchParams.get(HASH);
    if (sealed === null) {
      return Response.json({ settled: false }, { status: 400 });
    }

    const paymentHash = await unseal(config.secret, sealed);
    if (paymentHash === null) {
      return Response.json({ settled: false }, { status: 403 });
    }

    const preimage = await nwcSettlement(config.connection, paymentHash, config.askTimeoutMs).catch(
      () => undefined,
    );
    if (preimage === undefined) {
      return Response.json({ settled: false }, { status: 502 });
    }

    return Response.json({ settled: preimage !== null, preimage }, { headers: paced });
  };
}

/**
 * The URL to hand the gateway, with the payment hash sealed inside it. Point it at
 * wherever `nwcVerifyEndpoint` is mounted
 */
export async function nwcVerifyUrl(
  endpoint: string,
  paymentHash: string,
  secret: string,
): Promise<string> {
  const sealed = new URL(endpoint);
  sealed.searchParams.set(HASH, await seal(secret, paymentHash));

  return sealed.toString();
}

/**
 * One NIP-47 call, for a method this SDK does not wrap. The wallet's own info
 * event lists what it will answer, and anything it refuses comes back as a
 * `WalletRefused` carrying the code it named
 */
export async function askWallet(
  connection: NwcConnection,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = DEFAULT_ASK_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const key = conversationKeyFor(connection.secret, connection.walletPubkey);
  const request = signEvent(connection.secret, {
    kind: REQUEST_KIND,
    tags: [
      ["p", connection.walletPubkey],
      ["encryption", NIP44_V2],
    ],
    content: encryptNip44(key, JSON.stringify({ method, params })),
    created_at: Math.floor(Date.now() / 1000),
  });

  const answer = await overFirstRelayThatAnswers(connection, request, timeoutMs);

  return resultOf(JSON.parse(decryptNip44(key, answer.content)) as Record<string, unknown>, method);
}

function resultOf(said: Record<string, unknown>, method: string): Record<string, unknown> {
  const failure = said.error as { code?: string; message?: string } | null | undefined;
  if (failure) {
    throw new WalletRefused(
      REFUSAL_BY_CODE[failure.code ?? ""] ?? "invoice-refused",
      `the nwc wallet refused ${method}: ${failure.code ?? "unknown"} ${failure.message ?? ""}`.trim(),
    );
  }

  const result = said.result;
  if (result === null || typeof result !== "object") {
    throw new WalletRefused("invoice-refused", `the nwc wallet answered ${method} with no result`);
  }

  return result as Record<string, unknown>;
}

async function overFirstRelayThatAnswers(
  connection: NwcConnection,
  request: NostrEvent,
  timeoutMs: number,
): Promise<NostrEvent> {
  const deadline = AbortSignal.timeout(timeoutMs);
  let lastFailure: unknown = null;

  for (const relay of connection.relays) {
    if (deadline.aborted) {
      break;
    }
    try {
      return await overRelay(relay, connection, request, deadline);
    } catch (failure: unknown) {
      lastFailure = failure;
    }
  }

  throw new WalletRefused("unreachable", `no nwc relay answered: ${String(lastFailure)}`);
}

function overRelay(
  relay: string,
  connection: NwcConnection,
  request: NostrEvent,
  deadline: AbortSignal,
): Promise<NostrEvent> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relay);
    const subscription = request.id.slice(0, 16);
    const expired = () => {
      close();
      reject(new Error(`${relay} did not answer before the deadline`));
    };
    deadline.addEventListener("abort", expired);

    function close() {
      deadline.removeEventListener("abort", expired);
      socket.close();
    }

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify([
          "REQ",
          subscription,
          {
            kinds: [RESPONSE_KIND],
            authors: [connection.walletPubkey],
            "#p": [publicKeyFor(connection.secret)],
            "#e": [request.id],
          },
        ]),
      );
      socket.send(JSON.stringify(["EVENT", request]));
    });

    socket.addEventListener("error", () => {
      close();
      reject(new Error(`${relay} could not be reached`));
    });

    socket.addEventListener("message", (delivered) => {
      const frame = String(delivered.data);
      const rejection = rejectionOf(frame, request.id);
      if (rejection !== null) {
        close();
        reject(new Error(`${relay} refused the request: ${rejection}`));
        return;
      }

      const answer = answeredEvent(frame, subscription, connection, request.id);
      if (answer === null) {
        return;
      }
      close();
      resolve(answer);
    });
  });
}

function rejectionOf(frame: string, requestId: string): string | null {
  const parsed = parsedFrame(frame);
  if (parsed === null || parsed[0] !== "OK" || parsed[1] !== requestId || parsed[2] !== false) {
    return null;
  }

  return typeof parsed[3] === "string" && parsed[3].length > 0 ? parsed[3] : "no reason given";
}

function answeredEvent(
  frame: string,
  subscription: string,
  connection: NwcConnection,
  requestId: string,
): NostrEvent | null {
  const parsed = parsedFrame(frame);
  if (parsed === null || parsed[0] !== "EVENT" || parsed[1] !== subscription) {
    return null;
  }

  const event = parsed[2] as NostrEvent;
  const answers =
    event?.kind === RESPONSE_KIND &&
    event.pubkey === connection.walletPubkey &&
    Array.isArray(event.tags) &&
    event.tags.some((tag) => tag?.[0] === "e" && tag[1] === requestId) &&
    verifyEvent(event);

  return answers ? event : null;
}

function parsedFrame(frame: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(frame);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parsedUri(uri: string): URL {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== SCHEME) {
      throw new Error(parsed.protocol);
    }
    return parsed;
  } catch {
    throw new WalletRefused("address-unusable", `an nwc uri starts with ${SCHEME}//`);
  }
}

function isSecureRelay(relay: string): boolean {
  try {
    return new URL(relay).protocol === "wss:";
  } catch {
    return false;
  }
}
