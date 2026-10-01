import { type InnerList, parseDictionary, serializeDictionary } from "structured-headers";
import { expect, test } from "vitest";

import { signingKeyFromSeed, verifyHex } from "./ed25519.ts";
import {
	CLIENT_SIGNS,
	contentDigest,
	GATEWAY_SIGNS,
	type Message,
	signatureBase,
	signedBy,
	signerOf,
} from "./signature.ts";

const RFC_PUBLIC_KEY = Buffer.from(
	"JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs",
	"base64url",
).toString("hex");
const RFC_SIGNATURE_INPUT =
	'sig-b26=("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"';
const RFC_SIGNATURE =
	"wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==";
const RFC_BASE = [
	'"date": Tue, 20 Apr 2021 02:07:55 GMT',
	'"@method": POST',
	'"@path": /foo',
	'"@authority": example.com',
	'"content-type": application/json',
	'"content-length": 18',
	'"@signature-params": ("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
].join("\n");
const RFC_REQUEST: Message = {
	method: "POST",
	url: "https://example.com/foo?param=Value&Pet=dog",
	headers: new Headers({
		Host: "example.com",
		Date: "Tue, 20 Apr 2021 02:07:55 GMT",
		"Content-Type": "application/json",
		"Content-Length": "18",
	}),
};

const BODY = '{"hello": "world"}';
const GATEWAY = "gateway.example";
const PATH = "https://gateway.example/incoming-payments?first=1";

function rfcCovered(): InnerList {
	return parseDictionary(RFC_SIGNATURE_INPUT).get("sig-b26") as InnerList;
}

async function aKey() {
	return await signingKeyFromSeed(new Uint8Array(32).fill(7));
}

async function handSigned(
	key: Awaited<ReturnType<typeof aKey>>,
	parameters: [string, string | number][],
): Promise<Record<string, string>> {
	const covered: InnerList = [
		CLIENT_SIGNS.covers.map((name) => [name, new Map()]),
		new Map<string, string | number>(parameters),
	];
	const digest = contentDigest(BODY);
	const base =
		signatureBase(
			{ method: "POST", url: PATH, headers: new Headers({ "content-digest": digest }) },
			covered,
		) ?? "";
	const signature = Buffer.from(await key.sign(new TextEncoder().encode(base)), "hex");

	return {
		"content-digest": digest,
		"signature-input": serializeDictionary(new Map([["thunder-bridge", covered]])),
		signature: serializeDictionary(new Map([["thunder-bridge", [signature, new Map()]]])),
	};
}

async function asReceived(headers: Record<string, string>, url = PATH, authority?: string) {
	return { method: "POST", url, authority, headers: new Headers(headers) };
}

test("the RFC 9421 ed25519 example rebuilds its signature base byte for byte", () => {
	expect(signatureBase(RFC_REQUEST, rfcCovered())).toBe(RFC_BASE);
});

test("the RFC 9421 ed25519 example verifies under the RFC's published key", async () => {
	const base = signatureBase(RFC_REQUEST, rfcCovered()) ?? "";
	const signature = Buffer.from(RFC_SIGNATURE, "base64").toString("hex");

	expect(await verifyHex(RFC_PUBLIC_KEY, signature, new TextEncoder().encode(base))).toBe(true);
	expect(await verifyHex(RFC_PUBLIC_KEY, signature, new TextEncoder().encode(`${base} `))).toBe(
		false,
	);
});

test("empty content has the digest RFC 9530 prints for it", () => {
	expect(contentDigest("")).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
});

test("a component named twice, or one the message does not carry, makes no base", () => {
	const twice: InnerList = [
		[
			["@method", new Map()],
			["@method", new Map()],
		],
		new Map(),
	];
	const absent: InnerList = [[["x-missing", new Map()]], new Map()];

	expect(signatureBase(RFC_REQUEST, twice)).toBeNull();
	expect(signatureBase(RFC_REQUEST, absent)).toBeNull();
});

test("a signed request names its key, its time and its nonce", async () => {
	const key = await aKey();
	const headers = await signedBy(key, CLIENT_SIGNS, { method: "POST", url: PATH }, BODY, {
		nonce: "a".repeat(32),
	});

	const signer = await signerOf(await asReceived(headers), BODY, CLIENT_SIGNS);
	expect(signer).toMatchObject({ keyid: key.publicKeyHex, nonce: "a".repeat(32) });
	expect(headers["signature-input"]).toContain('tag="thunder-bridge-client"');
	expect(headers["signature-input"]).toContain('alg="ed25519"');
});

test("altered content, another authority, another path or a stale time is nobody", async () => {
	const key = await aKey();
	const headers = await signedBy(key, CLIENT_SIGNS, { method: "POST", url: PATH }, BODY);
	const stale = await signedBy(key, CLIENT_SIGNS, { method: "POST", url: PATH }, BODY, {
		created: Math.floor(Date.now() / 1000) - 301,
	});

	expect(await signerOf(await asReceived(headers), `${BODY} `, CLIENT_SIGNS)).toBeNull();
	expect(
		await signerOf(await asReceived(headers, PATH, "elsewhere.example"), BODY, CLIENT_SIGNS),
	).toBeNull();
	expect(
		await signerOf(
			await asReceived(headers, `https://${GATEWAY}/incoming-payments?first=2`),
			BODY,
			CLIENT_SIGNS,
		),
	).toBeNull();
	expect(await signerOf(await asReceived(stale), BODY, CLIENT_SIGNS)).toBeNull();
});

test("a digest that does not match the content is nobody, even signed", async () => {
	const key = await aKey();
	const headers = await signedBy(key, CLIENT_SIGNS, { method: "POST", url: PATH }, BODY);

	expect(
		await signerOf(
			await asReceived({ ...headers, "content-digest": contentDigest("something else") }),
			BODY,
			CLIENT_SIGNS,
		),
	).toBeNull();
});

test("a signature made by one signer is not read as the other's", async () => {
	const key = await aKey();
	const fromGateway = await signedBy(key, GATEWAY_SIGNS, { method: "POST", url: PATH }, BODY);

	const taggedAsGateway = await signedBy(
		key,
		{ ...CLIENT_SIGNS, tag: GATEWAY_SIGNS.tag },
		{ method: "POST", url: PATH },
		BODY,
	);

	expect(await signerOf(await asReceived(fromGateway), BODY, CLIENT_SIGNS)).toBeNull();
	expect(await signerOf(await asReceived(taggedAsGateway), BODY, CLIENT_SIGNS)).toBeNull();
	expect(await signerOf(await asReceived(fromGateway), BODY, GATEWAY_SIGNS)).not.toBeNull();
});

test("a signature covering less than the profile asks, or naming another algorithm, is nobody", async () => {
	const key = await aKey();
	const narrower = {
		...CLIENT_SIGNS,
		covers: ["@method", "@authority", "@path", "content-digest"],
	};
	const without = await signedBy(key, narrower, { method: "POST", url: PATH }, BODY);

	expect(await signerOf(await asReceived(without), BODY, CLIENT_SIGNS)).toBeNull();

	const otherAlgorithm = await handSigned(key, [
		["created", Math.floor(Date.now() / 1000)],
		["keyid", key.publicKeyHex],
		["alg", "rsa-pss-sha512"],
		["tag", CLIENT_SIGNS.tag],
	]);

	expect(await signerOf(await asReceived(otherAlgorithm), BODY, CLIENT_SIGNS)).toBeNull();
});

test("no signature, or a field that is not a structured dictionary, is nobody rather than an error", async () => {
	expect(await signerOf(await asReceived({}), BODY, CLIENT_SIGNS)).toBeNull();
	expect(
		await signerOf(
			await asReceived({ "signature-input": "((", signature: "nope", "content-digest": "x" }),
			BODY,
			CLIENT_SIGNS,
		),
	).toBeNull();
});

test("a creation time that is not a whole number is nobody rather than read as zero", async () => {
	const key = await aKey();
	for (const created of ["now", Math.floor(Date.now() / 1000) + 0.5]) {
		const headers = await handSigned(key, [
			["created", created],
			["keyid", key.publicKeyHex],
			["tag", CLIENT_SIGNS.tag],
		]);

		expect(await signerOf(await asReceived(headers), BODY, CLIENT_SIGNS)).toBeNull();
	}
});
