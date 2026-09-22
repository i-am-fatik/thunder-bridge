import { hmacHex } from "./hmac.ts";

const VERSION = "v2";
const UNPADDED_VERSION = "v1";
const IV_BYTES = 12;
const MIN_SECRET_CHARS = 32;
const MAX_PLAIN_BYTES = 3000;
const SIZE_CLASSES = [256, 1024, MAX_PLAIN_BYTES];
const END_OF_TEXT = 0x80;
const INFO = new TextEncoder().encode("thunder-bridge/sealed");
const BOUND_TO_VERSION = new TextEncoder().encode(VERSION);

/**
 * Encrypt what the watcher needs and the gateway must not have. The gateway
 * stores the result and hands it back untouched, so anything readable you put
 * in `sealed` is something you told it, which is what blind mode exists to avoid
 */
export async function seal(secret: string, plaintext: string): Promise<string> {
	return await sealUnder(secret, plaintext, crypto.getRandomValues(new Uint8Array(IV_BYTES)));
}

/**
 * The same, for what has to stay the same. One plaintext seals to one blob every
 * time, so re-offering an order hands the gateway the watch it already holds
 * rather than a second one that differs only in noise. The nonce is derived from
 * the content, so two different plaintexts never share one
 */
export async function sealStable(secret: string, plaintext: string): Promise<string> {
	const derived = await hmacHex(secret, `sealed-nonce|${plaintext}`);
	const nonce = new Uint8Array(IV_BYTES);
	for (let at = 0; at < IV_BYTES; at++) {
		nonce[at] = Number.parseInt(derived.slice(at * 2, at * 2 + 2), 16);
	}

	return await sealUnder(secret, plaintext, nonce);
}

async function sealUnder(
	secret: string,
	plaintext: string,
	iv: Uint8Array<ArrayBuffer>,
): Promise<string> {
	const body = padToClass(plaintext);
	const key = await keyFor(secret);
	const cipher = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv, additionalData: BOUND_TO_VERSION },
			key,
			body,
		),
	);
	const joined = new Uint8Array(iv.length + cipher.length);
	joined.set(iv);
	joined.set(cipher, iv.length);

	return `${VERSION}.${toBase64Url(joined)}`;
}

/**
 * Read a sealed blob back, null when it was sealed with another secret, edited
 * on the way, or is not one of ours. A secret too short to be a key throws,
 * because that is your bug rather than someone else's input
 */
export async function unseal(secret: string, sealed: string): Promise<string | null> {
	const key = await keyFor(secret);
	const padded = sealed.startsWith(`${VERSION}.`);
	if (!padded && !sealed.startsWith(`${UNPADDED_VERSION}.`)) {
		return null;
	}

	const joined = fromBase64Url(sealed.slice(VERSION.length + 1));
	if (joined === null || joined.length <= IV_BYTES) {
		return null;
	}

	try {
		const body = new Uint8Array(
			await crypto.subtle.decrypt(
				{
					name: "AES-GCM",
					iv: joined.slice(0, IV_BYTES),
					additionalData: padded ? BOUND_TO_VERSION : undefined,
				},
				key,
				joined.slice(IV_BYTES),
			),
		);
		const text = padded ? unpad(body) : body;
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

async function keyFor(secret: string) {
	refuseAWeakSecret(secret);

	const material = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		"HKDF",
		false,
		["deriveKey"],
	);

	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: INFO },
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
