import { expect, test } from "vitest";

import { bytesToHex } from "./bytes.ts";
import { sha256, sha256Hex } from "./sha256.ts";

async function webCrypto(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

test("the hand written digest matches WebCrypto across every padding boundary", async () => {
	for (const length of [0, 1, 3, 54, 55, 56, 63, 64, 65, 119, 120, 1000]) {
		const bytes = new Uint8Array(length);
		for (let at = 0; at < length; at++) bytes[at] = (at * 31 + 7) & 0xff;
		expect(bytesToHex(sha256(bytes))).toBe(await webCrypto(bytes));
	}
});

test("the empty digest is the published constant", () => {
	expect(bytesToHex(sha256(new Uint8Array()))).toBe(
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	);
});

test("text is hashed as utf-8, not as code units", async () => {
	const text = 'příliš žluťoučký kůň ["text/plain","Paying charter@coinos.io"]';
	expect(sha256Hex(text)).toBe(await webCrypto(new TextEncoder().encode(text)));
});
