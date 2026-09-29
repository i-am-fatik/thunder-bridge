import { hmacHex } from "./hmac.ts";

const VERSION = "v2";
const UNPADDED_VERSION = "v1";
const PURPOSE_VERSION = "v3";
const IV_BYTES = 12;
const MIN_SECRET_CHARS = 32;
const MAX_PLAIN_BYTES = 3000;
const SIZE_CLASSES = [256, 1024, MAX_PLAIN_BYTES];
const END_OF_TEXT = 0x80;
const INFO = "thunder-bridge/sealed";

/** What one of the SDK's own blobs is for, so a blob sealed for one can never be read as another */
export type Purpose = "relay" | "bank-verify" | "nwc-verify";

/**
 * Encrypt what the watcher needs and the gateway must not have. The gateway
 * stores the result and hands it back untouched, so anything readable you put
 * in `sealed` is something you told it, which is what blind mode exists to avoid
 */
export async function seal(
	secret: string,
	plaintext: string,
	paymentHash?: string,
): Promise<string> {
	return await sealUnder(
		await keyFor(secret, INFO),
		plaintext,
		crypto.getRandomValues(new Uint8Array(IV_BYTES)),
		VERSION,
		boundTo(paymentHash),
	);
}

/**
 * Seal one of the SDK's own blobs under a key only its purpose derives, so a
 * gateway holding a relay's blob cannot hand it to a bank endpoint sharing the
 * secret. A `stable` blob seals one plaintext to one blob every time, so
 * re-offering an order hands the gateway the watch it already holds rather than a
 * second one that differs only in noise. Its nonce is derived from the content,
 * so two different plaintexts never share one
 */
export async function sealFor(
	purpose: Purpose,
	secret: string,
	plaintext: string,
	{ stable = false }: { stable?: boolean } = {},
): Promise<string> {
	return await sealUnder(
		await keyFor(secret, `${INFO}/${purpose}`),
		plaintext,
		stable ? await nonceOf(secret, plaintext) : crypto.getRandomValues(new Uint8Array(IV_BYTES)),
		PURPOSE_VERSION,
		new TextEncoder().encode(PURPOSE_VERSION),
	);
}

/**
 * Read back a blob `sealFor` sealed for this purpose. A blob an older release
 * sealed before purposes existed still opens, so a watch already running keeps
 * being answered
 */
export async function unsealFor(
	purpose: Purpose,
	secret: string,
	sealed: string,
): Promise<string | null> {
	if (!sealed.startsWith(`${PURPOSE_VERSION}.`)) {
		return await unseal(secret, sealed);
	}

	return await opened(
		await keyFor(secret, `${INFO}/${purpose}`),
		sealed.slice(PURPOSE_VERSION.length + 1),
		new TextEncoder().encode(PURPOSE_VERSION),
	);
}

async function nonceOf(secret: string, plaintext: string): Promise<Uint8Array<ArrayBuffer>> {
	const derived = await hmacHex(secret, `sealed-nonce|${plaintext}`);
	const nonce = new Uint8Array(IV_BYTES);
	for (let at = 0; at < IV_BYTES; at++) {
		nonce[at] = Number.parseInt(derived.slice(at * 2, at * 2 + 2), 16);
	}

	return nonce;
}

async function sealUnder(
	key: CryptoKey,
	plaintext: string,
	iv: Uint8Array<ArrayBuffer>,
	version: string,
	additionalData: Uint8Array<ArrayBuffer>,
): Promise<string> {
	const body = padToClass(plaintext);
	const cipher = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, body),
	);
	const joined = new Uint8Array(iv.length + cipher.length);
	joined.set(iv);
	joined.set(cipher, iv.length);

	return `${version}.${toBase64Url(joined)}`;
}

/**
 * Read a sealed blob back, null when it was sealed with another secret, edited
 * on the way, or is not one of ours. A secret too short to be a key throws,
 * because that is your bug rather than someone else's input
 */
export async function unseal(
	secret: string,
	sealed: string,
	paymentHash?: string,
): Promise<string | null> {
	const key = await keyFor(secret, INFO);
	const padded = sealed.startsWith(`${VERSION}.`);
	const unbound = !padded && sealed.startsWith(`${UNPADDED_VERSION}.`);
	if (!padded && (!unbound || paymentHash !== undefined)) {
		return null;
	}

	return await opened(
		key,
		sealed.slice(VERSION.length + 1),
		padded ? boundTo(paymentHash) : undefined,
	);
}

async function opened(
	key: CryptoKey,
	encoded: string,
	additionalData: Uint8Array<ArrayBuffer> | undefined,
): Promise<string | null> {
	const joined = fromBase64Url(encoded);
	if (joined === null || joined.length <= IV_BYTES) {
		return null;
	}

	try {
		const body = new Uint8Array(
			await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: joined.slice(0, IV_BYTES), additionalData },
				key,
				joined.slice(IV_BYTES),
			),
		);
		const text = additionalData === undefined ? body : unpad(body);
		return text === null ? null : new TextDecoder().decode(text);
	} catch {
		return null;
	}
}

/**
 * Refuse a secret too short to derive a key from, at the moment someone mounts
 * something on it rather than on the first request that needed it
 */
export function refuseAWeakSecret(secret: string): void {
	if (secret.length < MIN_SECRET_CHARS) {
		throw new Error(`the sealing secret needs ${MIN_SECRET_CHARS} characters of randomness`);
	}
}

function boundTo(paymentHash: string | undefined): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(
		paymentHash === undefined ? VERSION : `${VERSION}|${paymentHash.toLowerCase()}`,
	);
}

function padToClass(plaintext: string): Uint8Array<ArrayBuffer> {
	const text = new TextEncoder().encode(plaintext);
	const size = SIZE_CLASSES.find((limit) => text.length <= limit);
	if (size === undefined) {
		throw new Error(`sealed takes at most ${MAX_PLAIN_BYTES} bytes, this was ${text.length}`);
	}

	const body = new Uint8Array(size + 1);
	body.set(text);
	body[text.length] = END_OF_TEXT;

	return body;
}

function unpad(body: Uint8Array): Uint8Array | null {
	const end = body.lastIndexOf(END_OF_TEXT);
	return end === -1 ? null : body.subarray(0, end);
}

async function keyFor(secret: string, info: string): Promise<CryptoKey> {
	refuseAWeakSecret(secret);

	const material = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		"HKDF",
		false,
		["deriveKey"],
	);

	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new Uint8Array(0),
			info: new TextEncoder().encode(info),
		},
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
	if (text.length === 0 || !/^[A-Za-z0-9_-]+$/.test(text)) {
		return null;
	}

	try {
		const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
		const bytes = new Uint8Array(binary.length);
		for (let at = 0; at < bytes.length; at++) {
			bytes[at] = binary.charCodeAt(at);
		}

		return bytes;
	} catch {
		return null;
	}
}
