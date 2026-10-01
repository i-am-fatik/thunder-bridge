import { GATEWAY_SIGNS, signerOf } from "../../core/signature.js";
import type { Payment, Settlement } from "./types.js";
import { agreesWithItself } from "./verify.js";
import { paymentFromWire, settlementFromWire } from "./wire.js";

const CHALLENGE = "webhook-challenge";
const VERIFY_CHALLENGE = "verify-challenge";

/**
 * How far the gateway's clock may drift from yours before a webhook is refused,
 * and the URL you registered when a proxy in front of you hands requests on under
 * another one. A delivery is signed for the URL it was sent to, so one made for
 * somebody else's endpoint is refused here
 */
export type WebhookOptions = { toleranceSecs?: number; url?: string };

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

  return body === null ? null : proved(decoded(body, paymentFromWire));
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

  return body === null ? null : proved(decoded(body, settlementFromWire));
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
  const body = await request.clone().text();
  const signer = await signerOf(
    { method: request.method, url: options.url ?? request.url, headers: request.headers },
    body,
    GATEWAY_SIGNS,
    options.toleranceSecs,
  );

  return signer !== null && signer.keyid === credential.publicKey.toLowerCase() ? body : null;
}

function proved<T extends Payment | Settlement>(read: T | null): T | null {
  return read !== null && read.status === "paid" && !agreesWithItself(read) ? null : read;
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
