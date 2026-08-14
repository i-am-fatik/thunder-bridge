import { expect, test } from "vitest";

import { callerKey, callerOf, signedAs } from "./caller.ts";
import { sha256Hex } from "./sha256.ts";

const SECRET = "rail_9f2b7c41e8a05d63b7e4128a";
const OTHER_SECRET = "rail_0011223344556677889900aa";
const PATH = "/watched-payments";
const BODY = JSON.stringify({ payment_hash: "aa".repeat(32) });

async function spoke(secret = SECRET): Promise<Headers> {
	return new Headers(await signedAs(await callerKey(secret), "POST", PATH, BODY));
}

async function spokeAt(timestamp: string): Promise<Headers> {
	const key = await callerKey(SECRET);
	const payload = new TextEncoder().encode(`${timestamp}.POST.${PATH}.${sha256Hex(BODY)}`);

	return new Headers({
		"x-client-key": key.publicKeyHex,
		"x-timestamp": timestamp,
		"x-signature": `ed25519=${await key.sign(payload)}`,
	});
}

test("a signed request names the key that signed it", async () => {
	const key = await callerKey(SECRET);
	const headers = new Headers(await signedAs(key, "POST", PATH, BODY));

	expect(await callerOf(headers, "POST", PATH, BODY)).toBe(key.publicKeyHex);
});

test("the same secret is the same caller every time, so nothing has to be registered", async () => {
	expect((await callerKey(SECRET)).publicKeyHex).toBe((await callerKey(SECRET)).publicKeyHex);
	expect((await callerKey(SECRET)).publicKeyHex).not.toBe(
		(await callerKey(OTHER_SECRET)).publicKeyHex,
	);
});

test("a secret keeps the identity it had, because moving it renames every client at once", async () => {
	expect((await callerKey(SECRET)).publicKeyHex).toBe(
		"a243ac4d9919fc255770e1aa679327ecff91d405691c29c70d54c49cf88b5a91",
	);
});

test("the secret itself never travels", async () => {
	const headers = await spoke();

	for (const [, value] of headers) {
		expect(value).not.toContain(SECRET);
	}
});

test("a captured request replayed at another route proves nothing", async () => {
	const headers = await spoke();

	expect(await callerOf(headers, "POST", "/incoming-payments", BODY)).toBeNull();
});

test("a captured request replayed with another method proves nothing", async () => {
	expect(await callerOf(await spoke(), "DELETE", PATH, BODY)).toBeNull();
});

test("an edited body proves nothing, and the edit that keeps the length is the one that matters", async () => {
	const headers = await spoke();
	const flipped = BODY.replace(/aa"}$/, 'ab"}');

	expect(flipped.length).toBe(BODY.length);
	expect(await callerOf(headers, "POST", PATH, flipped)).toBeNull();
	expect(await callerOf(headers, "POST", PATH, "")).toBeNull();
});

test("a genuine signature older than the tolerance is still refused", async () => {
	const now = Math.floor(Date.now() / 1000);

	expect(await callerOf(await spokeAt(String(now - 301)), "POST", PATH, BODY)).toBeNull();
	expect(await callerOf(await spokeAt(String(now - 299)), "POST", PATH, BODY)).not.toBeNull();
});

test("a timestamp that is not a number is refused rather than read as zero", async () => {
	expect(await callerOf(await spokeAt("now"), "POST", PATH, BODY)).toBeNull();
});

test("a key claimed without a signature that matches it proves nothing", async () => {
	const headers = await spoke();
	headers.set("x-client-key", (await callerKey(OTHER_SECRET)).publicKeyHex);

	expect(await callerOf(headers, "POST", PATH, BODY)).toBeNull();
});

test("a shared secret signature is not accepted where a key is expected", async () => {
	const headers = await spoke();
	headers.set("x-signature", "sha256=deadbeef");

	expect(await callerOf(headers, "POST", PATH, BODY)).toBeNull();
});

test("a caller who says nothing is nobody rather than an error", async () => {
	expect(await callerOf(new Headers(), "POST", PATH, BODY)).toBeNull();
});

test("each of the three headers is needed", async () => {
	for (const dropped of ["x-client-key", "x-signature", "x-timestamp"]) {
		const headers = await spoke();
		headers.delete(dropped);

		expect(await callerOf(headers, "POST", PATH, BODY)).toBeNull();
	}
});

test("a key in capitals is the same caller, because hex has no case", async () => {
	const headers = await spoke();
	const key = headers.get("x-client-key") ?? "";
	headers.set("x-client-key", key.toUpperCase());

	expect(await callerOf(headers, "POST", PATH, BODY)).toBe(key);
});

test("rubbish where the signature belongs is refused rather than thrown", async () => {
	const headers = await spoke();
	headers.set("x-signature", "ed25519=nothexatall");

	expect(await callerOf(headers, "POST", PATH, BODY)).toBeNull();
});
