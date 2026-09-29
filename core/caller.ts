import { bytesToHex, hexToBytes } from "./bytes.ts";
import { type SigningKey, signingKeyFromSeed, verifyHex } from "./ed25519.ts";
import { hmacHex } from "./hmac.ts";
import { sha256Hex } from "./sha256.ts";

const KEY_HEADER = "x-client-key";
const SIGNATURE_HEADER = "x-signature";
const TIMESTAMP_HEADER = "x-timestamp";
const NONCE_HEADER = "x-nonce";
const PREFIX = "ed25519=";
export const TOLERANCE_SECS = 300;
const NONCE_BYTES = 16;
const NONCE = /^[0-9a-f]{32}$/;

/** What a signature covers besides the request itself, and how to tell a replay */
export type Hearing = {
	/** The host this request was sent to, as this gateway knows itself */
	host: string;
	/** False for a nonce this caller already spent while its signature could still be believed */
	fresh: (caller: string, nonce: string) => boolean;
};
const SIGNING_LABEL = "request-signing";

/**
 * The key a client speaks as, derived from the same long lived secret its
 * preimages and its sealed records come from, so holding that secret is the whole
 * of being that client and there is nothing else to keep
 */
export async function callerKey(secret: string): Promise<SigningKey> {
	return await signingKeyFromSeed(hexToBytes(await hmacHex(secret, SIGNING_LABEL)));
}

/**
 * What a payment is called, from the key that created it and the hash it settles
 * against. Both sides work it out from the same public facts, so a client knows
 * the name before it asks and every gateway watching that payment agrees on it.
 *
 * Nothing here is secret. An id was a capability once and is not one any more,
 * because a payment is handed only to the key that created it
 */
export function paymentNamedBy(caller: string, paymentHash: string): string {
	return sha256Hex(`${caller}.payment-id.${paymentHash}`);
}

/**
 * Headers that say who is calling and prove it, over the host, the method, the
 * path, the body, a timestamp and a nonce, so a captured request cannot be
 * replayed at another gateway, at another route, a second time, or after
 * {@link TOLERANCE_SECS}
 */
export async function signedAs(
	key: SigningKey,
	method: string,
	path: string,
	body: string,
	host: string,
): Promise<Record<string, string>> {
	const timestamp = String(Math.floor(Date.now() / 1000));
	const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));

	return {
		[KEY_HEADER]: key.publicKeyHex,
		[TIMESTAMP_HEADER]: timestamp,
		[NONCE_HEADER]: nonce,
		[SIGNATURE_HEADER]: `${PREFIX}${await key.sign(spokenTo(host, timestamp, nonce, method, path, body))}`,
	};
}

/**
 * Who is calling, or null when nobody proved it. A gateway that requires callers
 * to be named refuses on null, one that does not treats it as an anonymous call.
 *
 * A request signed without a nonce is what a client older than the nonce sends,
 * and it is still believed for its timestamp window, because nothing a newer
 * client signs can be read as one
 */
export async function callerOf(
	headers: Headers,
	method: string,
	path: string,
	body: string,
	hearing: Hearing,
): Promise<string | null> {
	const key = headers.get(KEY_HEADER)?.toLowerCase();
	const signature = headers.get(SIGNATURE_HEADER);
	const timestamp = headers.get(TIMESTAMP_HEADER);
	const nonce = headers.get(NONCE_HEADER)?.toLowerCase() ?? null;
	if (!key || signature === null || timestamp === null) {
		return null;
	}
	if (!signature.startsWith(PREFIX) || !recent(timestamp)) {
		return null;
	}
	if (nonce !== null && !NONCE.test(nonce)) {
		return null;
	}

	const proven = await verifyHex(
		key,
		signature.slice(PREFIX.length).toLowerCase(),
		nonce === null
			? spoken(timestamp, method, path, body)
			: spokenTo(hearing.host, timestamp, nonce, method, path, body),
	);

	return proven && (nonce === null || hearing.fresh(key, nonce)) ? key : null;
}

function spokenTo(
	host: string,
	timestamp: string,
	nonce: string,
	method: string,
	path: string,
	body: string,
): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(
		["v2", host.toLowerCase(), timestamp, nonce, method.toUpperCase(), path, sha256Hex(body)].join(
			"\n",
		),
	);
}

function spoken(
	timestamp: string,
	method: string,
	path: string,
	body: string,
): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(
		`${timestamp}.${method.toUpperCase()}.${path}.${sha256Hex(body)}`,
	);
}

function recent(timestamp: string): boolean {
	const sent = Number(timestamp);
	if (!Number.isFinite(sent)) {
		return false;
	}

	return Math.abs(Math.floor(Date.now() / 1000) - sent) <= TOLERANCE_SECS;
}
