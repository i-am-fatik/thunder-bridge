import { hexToBytes } from "./bytes.ts";
import { type SigningKey, signingKeyFromSeed } from "./ed25519.ts";
import { hmacHex } from "./hmac.ts";
import { sha256Hex } from "./sha256.ts";
import { CLIENT_SIGNS, signedBy, signerOf } from "./signature.ts";

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
 * Headers that say who is calling and prove it, as an RFC 9421 message signature
 * over the host, the method, the path and query, the content, a time and a nonce,
 * so a captured request cannot be replayed at another gateway, at another route, a
 * second time, or after five minutes
 */
export async function signedAs(
	key: SigningKey,
	method: string,
	path: string,
	body: string,
	host: string,
): Promise<Record<string, string>> {
	return await signedBy(
		key,
		CLIENT_SIGNS,
		{ method, url: `https://${host}${path}`, authority: host },
		body,
	);
}

/**
 * Who is calling, or null when nobody proved it. A gateway that requires callers
 * to be named refuses on null, one that does not treats it as an anonymous call.
 */
export async function callerOf(
	headers: Headers,
	method: string,
	path: string,
	body: string,
	hearing: Hearing,
): Promise<string | null> {
	const signer = await signerOf(
		{ method, url: `https://gateway.invalid${path}`, authority: hearing.host, headers },
		body,
		CLIENT_SIGNS,
	);
	if (signer === null || signer.nonce === null || !NONCE.test(signer.nonce)) {
		return null;
	}

	return hearing.fresh(signer.keyid, signer.nonce) ? signer.keyid : null;
}
