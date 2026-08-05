const VERSION = "v1";
const IV_BYTES = 12;
const MIN_SECRET_CHARS = 32;
const MAX_PLAIN_BYTES = 3000;
const INFO = new TextEncoder().encode("thunder-bridge/sealed");

/**
 * Encrypt what the watcher needs and the gateway must not have. The gateway
 * stores the result and hands it back untouched, so anything readable you put
 * in `sealed` is something you told it, which is what blind mode exists to avoid
 */
export async function seal(secret: string, plaintext: string): Promise<string> {
	const body = new TextEncoder().encode(plaintext);
	if (body.length > MAX_PLAIN_BYTES) {
		throw new Error(`sealed takes at most ${MAX_PLAIN_BYTES} bytes, this was ${body.length}`);
	}

	const key = await keyFor(secret);
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, body));
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
	if (!sealed.startsWith(`${VERSION}.`)) return null;

	const joined = fromBase64Url(sealed.slice(VERSION.length + 1));
	if (joined === null || joined.length <= IV_BYTES) return null;

	try {
		const body = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: joined.slice(0, IV_BYTES) },
			key,
			joined.slice(IV_BYTES),
		);
		return new TextDecoder().decode(body);
	} catch {
		return null;
	}
}

async function keyFor(secret: string): Promise<CryptoKey> {
	if (secret.length < MIN_SECRET_CHARS) {
		throw new Error(`the sealing secret needs ${MIN_SECRET_CHARS} characters of randomness`);
	}

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
	for (const byte of bytes) binary += String.fromCharCode(byte);

	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
	if (text.length === 0 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;

	try {
		const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
		const bytes = new Uint8Array(binary.length);
		for (let at = 0; at < bytes.length; at++) bytes[at] = binary.charCodeAt(at);

		return bytes;
	} catch {
		return null;
	}
}
