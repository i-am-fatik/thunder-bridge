import { equalInConstantTime, hmacHex } from "../../core/hmac.js";
import type { Payment } from "./types.js";
import { paymentFromWire } from "./wire.js";

const SIGNATURE_HEADER = "x-signature";
const TIMESTAMP_HEADER = "x-timestamp";
const SIGNATURE_PREFIX = "sha256=";
const DEFAULT_TOLERANCE_SECS = 300;

/** How far the gateway's clock may drift from yours before a webhook is refused */
export type WebhookOptions = { toleranceSecs?: number };

/** Verify the `X-Signature` header against the raw body and the `X-Timestamp` that came with it */
export async function verifyWebhookSignature(
  body: string | Uint8Array,
  signature: string,
  secret: string,
  timestamp: string,
  options: WebhookOptions = {},
): Promise<boolean> {
  if (!recent(timestamp, options.toleranceSecs ?? DEFAULT_TOLERANCE_SECS)) return false;
  const received = signature.startsWith(SIGNATURE_PREFIX)
    ? signature.slice(SIGNATURE_PREFIX.length)
    : signature;
  return equalInConstantTime(await sign(secret, timestamp, body), received.toLowerCase());
}

/** Verify and parse in one step, returns null on a bad signature or a body that is not a payment */
export async function parseWebhook(
  body: string | Uint8Array,
  signature: string,
  secret: string,
  timestamp: string,
  options: WebhookOptions = {},
): Promise<Payment | null> {
  if (!(await verifyWebhookSignature(body, signature, secret, timestamp, options))) return null;
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
  secret: string,
  options: WebhookOptions = {},
): Promise<Payment | null> {
  const signature = request.headers.get(SIGNATURE_HEADER);
  const timestamp = request.headers.get(TIMESTAMP_HEADER);
  if (signature === null || timestamp === null) return null;
  return parseWebhook(await request.text(), signature, secret, timestamp, options);
}

function recent(timestamp: string, toleranceSecs: number): boolean {
  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return false;
  return Math.abs(Math.floor(Date.now() / 1000) - sent) <= toleranceSecs;
}

async function sign(
  secret: string,
  timestamp: string,
  body: string | Uint8Array,
): Promise<string> {
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
