import { bytesToHex } from "./bytes.ts";

export async function hmacHex(
	secret: string | Uint8Array,
	payload: string | Uint8Array,
): Promise<string> {
	const raw = typeof secret === "string" ? new TextEncoder().encode(secret) : secret;
	const key = await crypto.subtle.importKey(
		"raw",
		asBuffer(raw),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const message = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;

	return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, asBuffer(message))));
}

export function equalInConstantTime(one: string, other: string): boolean {
	if (one.length !== other.length) return false;

	let difference = 0;
	for (let at = 0; at < one.length; at++) difference |= one.charCodeAt(at) ^ other.charCodeAt(at);

	return difference === 0;
}

function asBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	return bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer
		? (bytes as Uint8Array<ArrayBuffer>)
		: new Uint8Array(bytes);
}
