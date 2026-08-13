import { hexToBytes } from "./bytes.ts";
import { signingKeyFromSeed, type SigningKey, verifyHex } from "./ed25519.ts";
import { hmacHex } from "./hmac.ts";
import { sha256Hex } from "./sha256.ts";

const KEY_HEADER = "x-client-key";
const SIGNATURE_HEADER = "x-signature";
const TIMESTAMP_HEADER = "x-timestamp";
const PREFIX = "ed25519=";
const TOLERANCE_SECS = 300;
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
 * Headers that say who is calling and prove it, over the method, the path, the
 * body and a timestamp, so a captured request cannot be replayed at another route
 * or after {@link TOLERANCE_SECS}
 */
export async function signedAs(
	key: SigningKey,
	method: string,
	path: string,
	body: string,
): Promise<Record<string, string>> {
	const timestamp = String(Math.floor(Date.now() / 1000));

	return {
		[KEY_HEADER]: key.publicKeyHex,
		[TIMESTAMP_HEADER]: timestamp,
		[SIGNATURE_HEADER]: `${PREFIX}${await key.sign(spoken(timestamp, method, path, body))}`,
	};
}

/**
 * Who is calling, or null when nobody proved it. A gateway that requires callers
 * to be named refuses on null, one that does not treats it as an anonymous call
 */
export async function callerOf(
	headers: Headers,
	method: string,
	path: string,
	body: string,
): Promise<string | null> {
	const key = headers.get(KEY_HEADER)?.toLowerCase();
	const signature = headers.get(SIGNATURE_HEADER);
	const timestamp = headers.get(TIMESTAMP_HEADER);
	if (!key || signature === null || timestamp === null) return null;
	if (!signature.startsWith(PREFIX) || !recent(timestamp)) return null;

	const proven = await verifyHex(
		key,
		signature.slice(PREFIX.length).toLowerCase(),
		spoken(timestamp, method, path, body),
	);

	return proven ? key : null;
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
	if (!Number.isFinite(sent)) return false;

	return Math.abs(Math.floor(Date.now() / 1000) - sent) <= TOLERANCE_SECS;
}
