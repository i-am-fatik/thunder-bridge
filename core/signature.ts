import {
	type BareItem,
	type Dictionary,
	type InnerList,
	type Item,
	parseDictionary,
	serializeDictionary,
	serializeInnerList,
	serializeString,
} from "structured-headers";

import { bytesToHex, hexToBytes } from "./bytes.ts";
import { type SigningKey, verifyHex } from "./ed25519.ts";
import { sha256 } from "./sha256.ts";

export const TOLERANCE_SECS = 300;

const LABEL = "thunder-bridge";
const ALGORITHM = "ed25519";
const NONCE_BYTES = 16;
const SIGNATURE_BYTES = 64;
const PUBLIC_KEY = /^[0-9a-f]{64}$/i;

export interface Profile {
	readonly tag: string;
	readonly covers: readonly string[];
}

export const CLIENT_SIGNS: Profile = {
	tag: "thunder-bridge-client",
	covers: ["@method", "@authority", "@path", "@query", "content-digest"],
};

export const GATEWAY_SIGNS: Profile = {
	tag: "thunder-bridge-gateway",
	covers: ["@method", "@scheme", "@authority", "@path", "content-digest"],
};

export interface Message {
	method: string;
	url: string;
	authority?: string;
	headers: Headers;
}

export interface Signer {
	keyid: string;
	created: number;
	nonce: string | null;
}

export interface Stamp {
	readonly created?: number;
	readonly nonce?: string;
}

export function contentDigest(body: string): string {
	return serializeDictionary({
		"sha-256": [Uint8Array.from(sha256(new TextEncoder().encode(body))), new Map()],
	});
}

export function signatureBase(message: Message, covered: InnerList): string | null {
	const lines: string[] = [];
	const seen = new Set<string>();
	for (const [name, parameters] of covered[0]) {
		if (typeof name !== "string" || parameters.size > 0 || seen.has(name)) {
			return null;
		}
		seen.add(name);

		const value = componentValue(message, name);
		if (value === null) {
			return null;
		}
		lines.push(`${serializeString(name)}: ${value}`);
	}
	lines.push(`"@signature-params": ${serializeInnerList(covered)}`);

	return lines.join("\n");
}

export async function signedBy(
	key: SigningKey,
	profile: Profile,
	message: Omit<Message, "headers">,
	body: string,
	{ created = unixNow(), nonce = randomNonce() }: Stamp = {},
): Promise<Record<string, string>> {
	const digest = contentDigest(body);
	const covered: InnerList = [
		profile.covers.map((name): Item => [name, new Map()]),
		new Map<string, BareItem>([
			["created", created],
			["nonce", nonce],
			["keyid", key.publicKeyHex],
			["alg", ALGORITHM],
			["tag", profile.tag],
		]),
	];
	const base = signatureBase(
		{ ...message, headers: new Headers({ "content-digest": digest }) },
		covered,
	);
	if (base === null) {
		throw new Error(`${message.url} cannot be signed as ${profile.tag}`);
	}
	const signature = Uint8Array.from(hexToBytes(await key.sign(new TextEncoder().encode(base))));

	return {
		"content-digest": digest,
		"signature-input": serializeDictionary(new Map([[LABEL, covered]])),
		signature: serializeDictionary(new Map([[LABEL, [signature, new Map()]]])),
	};
}

export async function signerOf(
	message: Message,
	body: string,
	profile: Profile,
	toleranceSecs = TOLERANCE_SECS,
): Promise<Signer | null> {
	const found = chosen(message.headers, profile.tag);
	if (found === null) {
		return null;
	}

	const [components, parameters] = found.covered;
	const named = components.map(([name]) => name);
	if (!profile.covers.every((name) => named.includes(name))) {
		return null;
	}

	const keyid = parameters.get("keyid");
	const created = parameters.get("created");
	const nonce = parameters.get("nonce");
	const alg = parameters.get("alg");
	if (typeof keyid !== "string" || !PUBLIC_KEY.test(keyid)) {
		return null;
	}
	if (typeof created !== "number" || !Number.isInteger(created)) {
		return null;
	}
	if (Math.abs(unixNow() - created) > toleranceSecs) {
		return null;
	}
	if (
		(alg !== undefined && alg !== ALGORITHM) ||
		(nonce !== undefined && typeof nonce !== "string")
	) {
		return null;
	}
	if (!digestMatches(message.headers.get("content-digest"), body)) {
		return null;
	}

	const base = signatureBase(message, found.covered);
	if (base === null) {
		return null;
	}
	const signer = keyid.toLowerCase();
	const proven = await verifyHex(
		signer,
		bytesToHex(found.signature),
		new TextEncoder().encode(base),
	);

	return proven ? { keyid: signer, created, nonce: nonce ?? null } : null;
}

function componentValue(message: Message, name: string): string | null {
	let url: URL;
	try {
		url = new URL(message.url);
	} catch {
		return null;
	}

	switch (name) {
		case "@method":
			return message.method;
		case "@authority":
			return (message.authority ?? url.host).toLowerCase();
		case "@scheme":
			return url.protocol.slice(0, -1).toLowerCase();
		case "@path":
			return url.pathname === "" ? "/" : url.pathname;
		case "@query":
			return url.search === "" ? "?" : url.search;
		default:
			return name.startsWith("@") ? null : (message.headers.get(name)?.trim() ?? null);
	}
}

function chosen(
	headers: Headers,
	tag: string,
): { covered: InnerList; signature: Uint8Array } | null {
	const inputs = dictionaryOf(headers.get("signature-input"));
	const signatures = dictionaryOf(headers.get("signature"));
	if (inputs === null || signatures === null) {
		return null;
	}

	for (const [label, member] of inputs) {
		if (!isInnerList(member) || member[1].get("tag") !== tag) {
			continue;
		}
		const value = signatures.get(label);
		if (value === undefined || isInnerList(value) || !(value[0] instanceof ArrayBuffer)) {
			return null;
		}
		const signature = new Uint8Array(value[0]);

		return signature.length === SIGNATURE_BYTES ? { covered: member, signature } : null;
	}

	return null;
}

function digestMatches(field: string | null, body: string): boolean {
	const digest = dictionaryOf(field)?.get("sha-256");
	if (digest === undefined || isInnerList(digest) || !(digest[0] instanceof ArrayBuffer)) {
		return false;
	}

	const sent = new Uint8Array(digest[0]);
	const counted = sha256(new TextEncoder().encode(body));

	return sent.length === counted.length && sent.every((byte, at) => byte === counted[at]);
}

function dictionaryOf(field: string | null): Dictionary | null {
	if (field === null) {
		return null;
	}
	try {
		return parseDictionary(field);
	} catch {
		return null;
	}
}

function isInnerList(member: Item | InnerList): member is InnerList {
	return Array.isArray(member[0]);
}

function randomNonce(): string {
	return bytesToHex(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function unixNow(): number {
	return Math.floor(Date.now() / 1000);
}
