import { verifyHex } from "../../core/ed25519.js";
import type { Payment, Settlement } from "./types.js";
import { paymentFromWire, settlementFromWire } from "./wire.js";

const SIGNATURE_HEADER = "x-signature";
const TIMESTAMP_HEADER = "x-timestamp";
const GATEWAY_KEY_PREFIX = "ed25519=";
const DEFAULT_TOLERANCE_SECS = 300;
const CHALLENGE = "webhook-challenge";
const VERIFY_CHALLENGE = "verify-challenge";

/** How far the gateway's clock may drift from yours before a webhook is refused */
export type WebhookOptions = { toleranceSecs?: number };

/**
 * What checks a delivery: the hex the gateway publishes at `/webhook-key`. There
 * is no shared secret to register, so a gateway holds nothing of yours. Rotating
 * its cluster key rotates this too, so a signature that stops verifying is a
 * reason to read the key again before it is a reason to distrust the gateway
 */
export type WebhookCredential = { publicKey: string };

/**
 * Verify a delivery and read the payment out of it, from a Fetch API `Request` as
 * used by Hono, Next, SvelteKit, Cloudflare Workers and Deno. WebCrypto only, so
 * it runs anywhere fetch does.
 *
 * Null on a bad signature or a body that is not a payment, so a handler that gets
 * null did not just miss a payment, it was handed something it had no reason to
 * believe. The body is left unread on the way out, so the same handler can go on
 * to read it as something else
 */
export async function readPayment(
  request: Request,
  credential: WebhookCredential,
  options: WebhookOptions = {},
): Promise<Payment | null> {
  const body = await believable(request, credential, options);

  return body === null ? null : decoded(body, paymentFromWire);
}

/**
 * Verify a delivery and read the settlement out of it, which is the shape a
 * webhook registered on a payment receives. Null on anything not worth believing,
 * the way `readPayment` is
 */
export async function readSettlement(
  request: Request,
  credential: WebhookCredential,
  options: WebhookOptions = {},
): Promise<Settlement | null> {
  const body = await believable(request, credential, options);

  return body === null ? null : decoded(body, settlementFromWire);
}

/**
 * Answer the one challenge the gateway sends before it will watch a payment your
 * webhook is registered on. Returns the response to send back, or null when this
 * delivery is not a challenge, so a handler tries this first and then reads.
 *
 * The request's body is left unread either way
 */
export async function answerWebhookChallenge(
  request: Request,
  credential: WebhookCredential,
  options: WebhookOptions = {},
): Promise<Response | null> {
  const body = await believable(request, credential, options);
  const nonce = body === null ? null : nonceOf(body, CHALLENGE);

  return nonce === null ? null : answered(nonce);
}

/**
 * Answer the challenge the gateway sends a verify URL before it will poll it,
 * which is how a caller shows the endpoint agreed to the traffic rather than
 * merely being named. Returns null for anything that is not a challenge, so a
 * verify endpoint hands the request on to its own reading of a payment.
 *
 * The nonce is echoed to whoever asked, which grants them nothing, so there is
 * no signature to check here and no secret to hold
 */
export async function answerVerifyChallenge(request: Request): Promise<Response | null> {
  if (request.method !== "POST") {
    return null;
  }

  const nonce = nonceOf(await request.clone().text(), VERIFY_CHALLENGE);

  return nonce === null ? null : answered(nonce);
}

async function believable(
  request: Request,
  credential: WebhookCredential,
  options: WebhookOptions,
): Promise<string | null> {
  const signature = request.headers.get(SIGNATURE_HEADER);
  const timestamp = request.headers.get(TIMESTAMP_HEADER);
  if (signature === null || timestamp === null) {
    return null;
  }
  if (!recent(timestamp, options.toleranceSecs ?? DEFAULT_TOLERANCE_SECS)) {
    return null;
  }
  if (!signature.startsWith(GATEWAY_KEY_PREFIX)) {
    return null;
  }

  const body = await request.clone().text();
  const signed = await verifyHex(
    credential.publicKey.toLowerCase(),
    signature.slice(GATEWAY_KEY_PREFIX.length).toLowerCase(),
    stamped(timestamp, body),
  );

  return signed ? body : null;
}

function decoded<T>(body: string, from: (wire: unknown) => T | null): T | null {
  try {
    return from(JSON.parse(body));
  } catch {
    return null;
  }
}

function answered(nonce: string): Response {
  return new Response(JSON.stringify({ nonce }), {
    headers: { "content-type": "application/json" },
  });
}

function nonceOf(text: string, type: string): string | null {
  try {
    const said = JSON.parse(text) as Record<string, unknown>;
    if (said["type"] !== type || typeof said["nonce"] !== "string") {
      return null;
    }

    return said["nonce"];
  } catch {
    return null;
  }
}

function recent(timestamp: string, toleranceSecs: number): boolean {
  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) {
    return false;
  }

  return Math.abs(Math.floor(Date.now() / 1000) - sent) <= toleranceSecs;
}

function stamped(timestamp: string, body: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${timestamp}.${body}`);
}
