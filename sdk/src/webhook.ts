import { verifyHex } from "../../core/ed25519.js";
import { equalInConstantTime, hmacHex } from "../../core/hmac.js";
import type { Payment, TriggerEvent } from "./types.js";
import { paymentFromWire, triggerEventFromWire } from "./wire.js";

const SIGNATURE_HEADER = "x-signature";
const TIMESTAMP_HEADER = "x-timestamp";
const SHARED_SECRET_PREFIX = "sha256=";
const GATEWAY_KEY_PREFIX = "ed25519=";
const DEFAULT_TOLERANCE_SECS = 300;
const CHALLENGE = "webhook-challenge";
const VERIFY_CHALLENGE = "verify-challenge";

/** How far the gateway's clock may drift from yours before a webhook is refused */
export type WebhookOptions = { toleranceSecs?: number };

/**
 * What checks a delivery. A string is the `webhook.secret` you registered. Pass
 * `{ publicKey }` instead, the hex from the gateway's `/webhook-key`, when you
 * registered no secret and would rather it held nothing of yours
 */
export type WebhookCredential = string | { publicKey: string };

/** Verify the `X-Signature` header against the raw body and the `X-Timestamp` that came with it */
export async function verifyWebhookSignature(
  body: string | Uint8Array,
  signature: string,
  credential: WebhookCredential,
  timestamp: string,
  options: WebhookOptions = {},
): Promise<boolean> {
  if (!recent(timestamp, options.toleranceSecs ?? DEFAULT_TOLERANCE_SECS)) return false;

  if (typeof credential !== "string") {
    if (!signature.startsWith(GATEWAY_KEY_PREFIX)) return false;
    return verifyHex(
      credential.publicKey.toLowerCase(),
      signature.slice(GATEWAY_KEY_PREFIX.length).toLowerCase(),
      signed(timestamp, body),
    );
  }

  if (signature.startsWith(GATEWAY_KEY_PREFIX)) return false;
  const received = signature.startsWith(SHARED_SECRET_PREFIX)
    ? signature.slice(SHARED_SECRET_PREFIX.length)
    : signature;

  return equalInConstantTime(await sign(credential, timestamp, body), received.toLowerCase());
}

/** Verify and parse in one step, returns null on a bad signature or a body that is not a payment */
export async function parseWebhook(
  body: string | Uint8Array,
  signature: string,
  credential: WebhookCredential,
  timestamp: string,
  options: WebhookOptions = {},
): Promise<Payment | null> {
  if (!(await verifyWebhookSignature(body, signature, credential, timestamp, options))) return null;
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  try {
    return paymentFromWire(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Verify and parse from a Fetch API `Request` as used by Hono, Next, SvelteKit,
 * Cloudflare Workers and Deno, WebCrypto only so it runs anywhere fetch does
 */
export async function parseWebhookRequest(
  request: Request,
  credential: WebhookCredential,
  options: WebhookOptions = {},
): Promise<Payment | null> {
  const signature = request.headers.get(SIGNATURE_HEADER);
  const timestamp = request.headers.get(TIMESTAMP_HEADER);
  if (signature === null || timestamp === null) return null;
  return parseWebhook(await request.text(), signature, credential, timestamp, options);
}

/**
 * The same, for a payment the gateway only watched. A bank transfer and a blind
 * Lightning leg carry no address, amount or invoice, so they arrive in the shape
 * `followTrigger` and `getWatched` hand back rather than the minted one
 */
export async function parseWatchedWebhook(
  body: string | Uint8Array,
  signature: string,
  credential: WebhookCredential,
  timestamp: string,
  options: WebhookOptions = {},
): Promise<TriggerEvent | null> {
  if (!(await verifyWebhookSignature(body, signature, credential, timestamp, options))) return null;
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  try {
    return triggerEventFromWire(JSON.parse(text));
  } catch {
    return null;
  }
}

/** `parseWatchedWebhook` from a Fetch API `Request`, the way `parseWebhookRequest` is */
export async function parseWatchedWebhookRequest(
  request: Request,
  credential: WebhookCredential,
  options: WebhookOptions = {},
): Promise<TriggerEvent | null> {
  const signature = request.headers.get(SIGNATURE_HEADER);
  const timestamp = request.headers.get(TIMESTAMP_HEADER);
  if (signature === null || timestamp === null) return null;
  return parseWatchedWebhook(await request.text(), signature, credential, timestamp, options);
}

/**
 * Answer the one challenge the gateway sends before it will watch a payment your
 * webhook is registered on. Returns the body to send back with a 200, or null when
 * this delivery is not a challenge, so a handler tries this first and then parses
 */
export async function answerWebhookChallenge(
  body: string | Uint8Array,
  signature: string,
  credential: WebhookCredential,
  timestamp: string,
  options: WebhookOptions = {},
): Promise<string | null> {
  if (!(await verifyWebhookSignature(body, signature, credential, timestamp, options))) return null;

  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  const nonce = challenged(text);
  if (nonce === null) return null;
  if (typeof credential !== "string") return JSON.stringify({ nonce });

  return JSON.stringify({
    nonce,
    signature: `${SHARED_SECRET_PREFIX}${await hmacHex(credential, nonce)}`,
  });
}

/**
 * `answerWebhookChallenge` from a Fetch API `Request`, leaving the body unread so
 * the same handler can go on to `parseWebhookRequest` when this was no challenge
 */
export async function answerWebhookChallengeRequest(
  request: Request,
  credential: WebhookCredential,
  options: WebhookOptions = {},
): Promise<Response | null> {
  const signature = request.headers.get(SIGNATURE_HEADER);
  const timestamp = request.headers.get(TIMESTAMP_HEADER);
  if (signature === null || timestamp === null) return null;

  const answer = await answerWebhookChallenge(
    await request.clone().text(),
    signature,
    credential,
    timestamp,
    options,
  );

  return answer === null
    ? null
    : new Response(answer, { headers: { "content-type": "application/json" } });
}

function challenged(text: string): string | null {
  return nonceOf(text, CHALLENGE);
}

function nonceOf(text: string, type: string): string | null {
  try {
    const said = JSON.parse(text) as Record<string, unknown>;
    if (said["type"] !== type || typeof said["nonce"] !== "string") return null;

    return said["nonce"];
  } catch {
    return null;
  }
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
export function answerVerifyChallenge(body: string): string | null {
  const nonce = nonceOf(body, VERIFY_CHALLENGE);

  return nonce === null ? null : JSON.stringify({ nonce });
}

/** {@link answerVerifyChallenge} against a `Request`, leaving its body unread */
export async function answerVerifyChallengeRequest(request: Request): Promise<Response | null> {
  if (request.method !== "POST") return null;

  const answer = answerVerifyChallenge(await request.clone().text());

  return answer === null
    ? null
    : new Response(answer, { headers: { "content-type": "application/json" } });
}

function recent(timestamp: string, toleranceSecs: number): boolean {
  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return false;
  return Math.abs(Math.floor(Date.now() / 1000) - sent) <= toleranceSecs;
}

async function sign(secret: string, timestamp: string, body: string | Uint8Array): Promise<string> {
  return hmacHex(secret, signed(timestamp, body));
}

function signed(timestamp: string, body: string | Uint8Array): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const stamp = encoder.encode(`${timestamp}.`);
  const rest = typeof body === "string" ? encoder.encode(body) : new Uint8Array(body);
  const payload = new Uint8Array(stamp.length + rest.length);
  payload.set(stamp);
  payload.set(rest, stamp.length);

  return payload;
}
