import { bytesToHex, hexToBytes, isHex } from "./bytes.ts";

const ALGORITHM = { name: "Ed25519" } as const;
const SEED_BYTES = 32;
const SIGNATURE_BYTES = 64;
const PUBLIC_KEY_BYTES = 32;
const PKCS8_HEADER = hexToBytes("302e020100300506032b657004220420");
const SIGN_BIT_CLEARED = 0x7f;
const SMALL_ORDER = [
	"00".repeat(32),
	`01${"00".repeat(31)}`,
	"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
	"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
	`ec${"ff".repeat(30)}7f`,
	`ed${"ff".repeat(30)}7f`,
	`ee${"ff".repeat(30)}7f`,
];

export type SigningKey = {
	publicKeyHex: string;
	sign: (payload: Uint8Array) => Promise<string>;
};

export async function signingKeyFromSeed(seed: Uint8Array): Promise<SigningKey> {
	if (seed.length !== SEED_BYTES) {
		throw new Error(`an ed25519 seed is ${SEED_BYTES} bytes`);
	}

	const wrapped = new Uint8Array(PKCS8_HEADER.length + SEED_BYTES);
	wrapped.set(PKCS8_HEADER);
	wrapped.set(seed, PKCS8_HEADER.length);

	const key = await crypto.subtle.importKey("pkcs8", asBuffer(wrapped), ALGORITHM, true, ["sign"]);
	const jwk = await crypto.subtle.exportKey("jwk", key);

	return {
		publicKeyHex: bytesToHex(fromBase64Url(jwk.x ?? "")),
		sign: async (payload) =>
			bytesToHex(new Uint8Array(await crypto.subtle.sign(ALGORITHM, key, asBuffer(payload)))),
	};
}

export async function verifyHex(
	publicKeyHex: string,
	signatureHex: string,
	payload: Uint8Array,
): Promise<boolean> {
	if (!isHex(publicKeyHex) || publicKeyHex.length !== PUBLIC_KEY_BYTES * 2) {
		return false;
	}
	if (hasSmallOrder(publicKeyHex)) {
		return false;
	}
	if (!isHex(signatureHex) || signatureHex.length !== SIGNATURE_BYTES * 2) {
		return false;
	}

	try {
		const key = await crypto.subtle.importKey(
			"raw",
			asBuffer(hexToBytes(publicKeyHex)),
			ALGORITHM,
			false,
			["verify"],
		);

		return await crypto.subtle.verify(
			ALGORITHM,
			key,
			asBuffer(hexToBytes(signatureHex)),
			asBuffer(payload),
		);
	} catch {
		return false;
	}
}

function hasSmallOrder(publicKeyHex: string): boolean {
	const point = hexToBytes(publicKeyHex);
	point[PUBLIC_KEY_BYTES - 1] = point[PUBLIC_KEY_BYTES - 1]! & SIGN_BIT_CLEARED;

	return SMALL_ORDER.includes(bytesToHex(point));
}

function fromBase64Url(text: string): Uint8Array {
	const padded = text.replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	const bytes = new Uint8Array(raw.length);
	for (let at = 0; at < raw.length; at++) {
		bytes[at] = raw.charCodeAt(at);
	}

	return bytes;
}

function asBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	return bytes.buffer instanceof ArrayBuffer
		? (bytes as Uint8Array<ArrayBuffer>)
		: new Uint8Array(bytes);
}
