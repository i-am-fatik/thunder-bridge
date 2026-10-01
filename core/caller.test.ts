import { expect, test } from "vitest";

import { bytesToHex } from "./bytes.ts";
import { callerKey, callerOf, type Hearing, signedAs } from "./caller.ts";
import { sha256Hex } from "./sha256.ts";
import { CLIENT_SIGNS, type Stamp, signedBy } from "./signature.ts";

const SECRET = "rail_9f2b7c41e8a05d63b7e4128a";
const OTHER_SECRET = "rail_0011223344556677889900aa";
const PATH = "/watched-payments";
const BODY = JSON.stringify({ payment_hash: "aa".repeat(32) });
const HOST = "gateway.example.net";

function hearing(host = HOST): Hearing {
	const spent = new Set<string>();

	return {
		host,
		fresh: (caller, nonce) => {
			const once = `${caller}.${nonce}`;
			const fresh = !spent.has(once);
			spent.add(once);
			return fresh;
		},
	};
}

async function spoke(secret = SECRET): Promise<Headers> {
	return new Headers(await signedAs(await callerKey(secret), "POST", PATH, BODY, HOST));
}

async function spokeWith(stamp: Stamp): Promise<Headers> {
	return new Headers(
		await signedBy(
			await callerKey(SECRET),
			CLIENT_SIGNS,
			{ method: "POST", url: `https://${HOST}${PATH}` },
			BODY,
			stamp,
		),
	);
}

async function spokeAs2x(): Promise<Headers[]> {
	const key = await callerKey(SECRET);
	const timestamp = String(Math.floor(Date.now() / 1000));
	const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
	const v2 = ["v2", HOST, timestamp, nonce, "POST", PATH, sha256Hex(BODY)].join("\n");
	const v1 = `${timestamp}.POST.${PATH}.${sha256Hex(BODY)}`;

	return [
		new Headers({
			"x-client-key": key.publicKeyHex,
			"x-timestamp": timestamp,
			"x-nonce": nonce,
			"x-signature": `ed25519=${await key.sign(new TextEncoder().encode(v2))}`,
		}),
		new Headers({
			"x-client-key": key.publicKeyHex,
			"x-timestamp": timestamp,
			"x-signature": `ed25519=${await key.sign(new TextEncoder().encode(v1))}`,
		}),
	];
}

test("a signed request names the key that signed it", async () => {
	const key = await callerKey(SECRET);
	const headers = new Headers(await signedAs(key, "POST", PATH, BODY, HOST));

	expect(await callerOf(headers, "POST", PATH, BODY, hearing())).toBe(key.publicKeyHex);
});

test("a signed request is an RFC 9421 signature and nothing else", async () => {
	const headers = await spoke();

	expect([...headers.keys()].sort()).toEqual(["content-digest", "signature", "signature-input"]);
	expect(headers.get("signature-input")).toMatch(
		/^thunder-bridge=\("@method" "@authority" "@path" "@query" "content-digest"\);created=\d+;nonce="[0-9a-f]{32}";keyid="[0-9a-f]{64}";alg="ed25519";tag="thunder-bridge-client"$/,
	);
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

	expect(await callerOf(headers, "POST", "/incoming-payments", BODY, hearing())).toBeNull();
	expect(await callerOf(headers, "POST", `${PATH}?page=2`, BODY, hearing())).toBeNull();
});

test("a captured request replayed with another method proves nothing", async () => {
	expect(await callerOf(await spoke(), "DELETE", PATH, BODY, hearing())).toBeNull();
});

test("an edited body proves nothing, and the edit that keeps the length is the one that matters", async () => {
	const headers = await spoke();
	const flipped = BODY.replace(/aa"}$/, 'ab"}');

	expect(flipped.length).toBe(BODY.length);
	expect(await callerOf(headers, "POST", PATH, flipped, hearing())).toBeNull();
	expect(await callerOf(headers, "POST", PATH, "", hearing())).toBeNull();
});

test("a genuine signature older than the tolerance is still refused", async () => {
	const now = Math.floor(Date.now() / 1000);

	expect(
		await callerOf(await spokeWith({ created: now - 301 }), "POST", PATH, BODY, hearing()),
	).toBeNull();
	expect(
		await callerOf(await spokeWith({ created: now - 299 }), "POST", PATH, BODY, hearing()),
	).not.toBeNull();
});

test("a key claimed without a signature that matches it proves nothing", async () => {
	const headers = await spoke();
	const other = (await callerKey(OTHER_SECRET)).publicKeyHex;
	headers.set(
		"signature-input",
		(headers.get("signature-input") ?? "").replace(/keyid="[0-9a-f]+"/, `keyid="${other}"`),
	);

	expect(await callerOf(headers, "POST", PATH, BODY, hearing())).toBeNull();
});

test("a caller who says nothing is nobody rather than an error", async () => {
	expect(await callerOf(new Headers(), "POST", PATH, BODY, hearing())).toBeNull();
});

test("each of the three fields is needed", async () => {
	for (const dropped of ["content-digest", "signature-input", "signature"]) {
		const headers = await spoke();
		headers.delete(dropped);

		expect(await callerOf(headers, "POST", PATH, BODY, hearing())).toBeNull();
	}
});

test("a key written in capitals is the same caller, because hex has no case", async () => {
	const key = await callerKey(SECRET);
	const shouting = { publicKeyHex: key.publicKeyHex.toUpperCase(), sign: key.sign };
	const headers = new Headers(await signedAs(shouting, "POST", PATH, BODY, HOST));

	expect(await callerOf(headers, "POST", PATH, BODY, hearing())).toBe(key.publicKeyHex);
});

test("rubbish where the signature belongs is refused rather than thrown", async () => {
	const headers = await spoke();
	headers.set("signature", "thunder-bridge=:bm90IGEgc2lnbmF0dXJl:");

	expect(await callerOf(headers, "POST", PATH, BODY, hearing())).toBeNull();
});

test("a captured request replayed at another gateway proves nothing", async () => {
	expect(
		await callerOf(await spoke(), "POST", PATH, BODY, hearing("elsewhere.example")),
	).toBeNull();
});

test("a captured request replayed a second time proves nothing, though its signature still holds", async () => {
	const headers = await spoke();
	const gateway = hearing();

	expect(await callerOf(headers, "POST", PATH, BODY, gateway)).not.toBeNull();
	expect(await callerOf(headers, "POST", PATH, BODY, gateway)).toBeNull();
});

test("a nonce is spent only by a request that proved itself", async () => {
	const headers = await spoke();
	const gateway = hearing();

	expect(await callerOf(headers, "POST", PATH, `${BODY} `, gateway)).toBeNull();
	expect(await callerOf(headers, "POST", PATH, BODY, gateway)).not.toBeNull();
});

test("a request signed the way 2.x clients sign it is nobody", async () => {
	for (const headers of await spokeAs2x()) {
		expect(await callerOf(headers, "POST", PATH, BODY, hearing())).toBeNull();
	}
});

test("a nonce that is not thirty two hex characters is refused, even signed as it is", async () => {
	const headers = await spokeWith({ nonce: `${"0".repeat(31)}g` });

	expect(await callerOf(headers, "POST", PATH, BODY, hearing())).toBeNull();
});

test("the host is the same host in capitals, because a host name has no case", async () => {
	expect(
		await callerOf(await spoke(), "POST", PATH, BODY, hearing(HOST.toUpperCase())),
	).not.toBeNull();
});
