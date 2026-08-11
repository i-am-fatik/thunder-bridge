import { expect, test } from "vitest";

import { signingKeyFromSeed, verifyHex } from "./ed25519.ts";

const SEED = new Uint8Array(32).fill(7);
const PAYLOAD = new TextEncoder().encode("1700000000.{}");

test("the same seed always yields the same key, so every instance in a cluster signs alike", async () => {
	const one = await signingKeyFromSeed(SEED);
	const other = await signingKeyFromSeed(SEED);

	expect(one.publicKeyHex).toBe(other.publicKeyHex);
	expect(one.publicKeyHex).toHaveLength(64);
	expect(await one.sign(PAYLOAD)).toBe(await other.sign(PAYLOAD));
});

test("a different seed is a different key", async () => {
	const mine = await signingKeyFromSeed(SEED);
	const theirs = await signingKeyFromSeed(new Uint8Array(32).fill(8));

	expect(mine.publicKeyHex).not.toBe(theirs.publicKeyHex);
	expect(await verifyHex(theirs.publicKeyHex, await mine.sign(PAYLOAD), PAYLOAD)).toBe(false);
});

test("a signature verifies against the public half and nothing else does", async () => {
	const key = await signingKeyFromSeed(SEED);
	const signature = await key.sign(PAYLOAD);

	expect(await verifyHex(key.publicKeyHex, signature, PAYLOAD)).toBe(true);
	expect(await verifyHex(key.publicKeyHex, signature, new TextEncoder().encode("1700000000.{ }"))).toBe(
		false,
	);
});

test("a flipped bit anywhere in the signature is refused", async () => {
	const key = await signingKeyFromSeed(SEED);
	const signature = await key.sign(PAYLOAD);
	const flipped = `${signature.slice(0, 2) === "00" ? "01" : "00"}${signature.slice(2)}`;

	expect(await verifyHex(key.publicKeyHex, flipped, PAYLOAD)).toBe(false);
});

test("a malformed key or signature is refused rather than thrown", async () => {
	const key = await signingKeyFromSeed(SEED);
	const signature = await key.sign(PAYLOAD);

	expect(await verifyHex("not-hex", signature, PAYLOAD)).toBe(false);
	expect(await verifyHex(key.publicKeyHex, "beef", PAYLOAD)).toBe(false);
	expect(await verifyHex("ab".repeat(32), signature, PAYLOAD)).toBe(false);
});

test("a seed that is not 32 bytes is refused", async () => {
	await expect(signingKeyFromSeed(new Uint8Array(31))).rejects.toThrow("32 bytes");
});
