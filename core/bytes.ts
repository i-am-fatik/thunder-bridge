export function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");

	return hex;
}

export function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length >> 1);
	for (let at = 0; at < bytes.length; at++) {
		bytes[at] = parseInt(hex.slice(at * 2, at * 2 + 2), 16);
	}

	return bytes;
}

export function isHex(text: string): boolean {
	return /^[0-9a-f]+$/i.test(text) && text.length % 2 === 0;
}
