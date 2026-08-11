import { decodeInvoice, preimageMatchesHash } from "./bolt11.ts";
import { ask, BODY_LIMIT_BYTES } from "./outbound.ts";
import { sha256Hex } from "./sha256.ts";
import { publicHttps } from "./url.ts";
import { NoWalletAvailable, WalletRefused, type WalletFailure } from "./refusal.ts";

const VERIFY_WITHOUT_PREIMAGE = ["zeuspay.com", "zeusnuts.com", "ecash.love"];
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const CHECKSUM_SLOTS = [0, 1, 2, 3, 4, 5];
const LNURL_HRP = "lnurl";

export const RESOLVE_TIMEOUT_MS = 30_000;

export type Resolved = {
	address: string;
	bolt11: string;
	verifyUrl: string;
	paymentHash: string;
	expiresAt: number;
};

type Issued = {
	paymentHash: string;
	descriptionHash: string | null;
	amountMsat: number | null;
	expiresAt: number;
};

export type Quote = {
	address: string;
	minMsat: number;
	maxMsat: number;
	metadata: string;
};

export type Served<T> = { won: T; refusals: WalletFailure[] };

type PayRequest = {
	tag: string;
	callback: string;
	metadata: string;
	minSendable: number;
	maxSendable: number;
};

type Probed = { address: string; pay: PayRequest };

type CallbackInvoice = { pr: string; verify?: string | null };

type Verification = { settled: boolean; preimage?: string | null };

export type Settlement = { preimage: string | null; pace: number | null };

const MIN_PACE_SECS = 1;
const MAX_PACE_SECS = 3600;

export async function resolve(addresses: string[], amountMsat: number): Promise<Resolved> {
	const served = await firstThatServes(addresses, (address, deadline) =>
		resolveAddress(address, amountMsat, deadline),
	);

	return served.won;
}

export async function quote(addresses: string[], amountMsat: number): Promise<Served<Quote>> {
	const served = await firstThatServes(addresses, (address, deadline) =>
		probe(address, amountMsat, deadline),
	);
	const { address, pay } = served.won;

	return {
		won: {
			address,
			minMsat: pay.minSendable,
			maxMsat: pay.maxSendable,
			metadata: pay.metadata,
		},
		refusals: served.refusals,
	};
}

async function firstThatServes<T>(
	addresses: string[],
	attempt: (address: string, deadline: AbortSignal) => Promise<T>,
): Promise<Served<T>> {
	const deadline = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
	const refusals: WalletFailure[] = [];

	for (const address of addresses) {
		if (deadline.aborted) break;
		try {
			return { won: await attempt(address, deadline), refusals };
		} catch (refusal: unknown) {
			if (!(refusal instanceof WalletRefused)) throw refusal;
			console.warn(`wallet ${address} refused, ${refusal.reason}: ${refusal.message}`);
			refusals.push({ address, reason: refusal.reason });
		}
	}
	throw new NoWalletAvailable(refusals);
}

async function probe(
	address: string,
	amountMsat: number,
	deadline: AbortSignal,
): Promise<Probed> {
	const [user, domain] = splitAddress(address);
	if (cannotReleaseAPreimage(domain)) {
		throw new WalletRefused("cannot-prove-delivery", `${address} never releases a preimage`);
	}

	const pay = await answered<PayRequest>(
		`https://${domain}/.well-known/lnurlp/${user}`,
		deadline,
	);
	if (pay.tag !== "payRequest" || !pay.callback) {
		throw new WalletRefused("unreachable", `${address} answered with no payRequest`);
	}
	if (amountMsat < pay.minSendable || amountMsat > pay.maxSendable) {
		throw new WalletRefused(
			"amount-not-accepted",
			`${address} takes [${pay.minSendable}, ${pay.maxSendable}] msat, not ${amountMsat}`,
		);
	}

	return { address, pay };
}

async function resolveAddress(
	address: string,
	amountMsat: number,
	deadline: AbortSignal,
): Promise<Resolved> {
	const { pay } = await probe(address, amountMsat, deadline);

	const invoice = await answered<CallbackInvoice>(withAmount(pay.callback, amountMsat), deadline);
	if (!invoice.pr) throw new WalletRefused("unreachable", `${address} returned no invoice`);
	if (!invoice.verify || !publicHttps(invoice.verify)) {
		throw new WalletRefused(
			"cannot-prove-delivery",
			`${address} publishes no usable LUD-21 verify URL`,
		);
	}

	const issued = decodeIssued(address, invoice.pr);
	if (issued.amountMsat !== amountMsat) {
		throw new WalletRefused(
			"invoice-refused",
			`${address} issued an invoice for ${issued.amountMsat} msat, not ${amountMsat}`,
		);
	}
	if (issued.descriptionHash !== sha256Hex(pay.metadata)) {
		throw new WalletRefused(
			"invoice-refused",
			`${address} does not bind its invoice to the metadata it serves`,
		);
	}

	return {
		address,
		bolt11: invoice.pr,
		verifyUrl: invoice.verify,
		paymentHash: issued.paymentHash,
		expiresAt: issued.expiresAt,
	};
}

async function answered<T>(url: string, deadline: AbortSignal): Promise<T> {
	try {
		return await fetchJson<T>(url, deadline);
	} catch (cause: unknown) {
		throw new WalletRefused("unreachable", String(cause));
	}
}

function decodeIssued(address: string, bolt11: string): Issued {
	const { paymentHash, descriptionHash, amountMsat, expiresAt } = decodeInvoice(bolt11);
	if (paymentHash === null || expiresAt === null) {
		throw new WalletRefused("invoice-refused", `${address} issued an invoice we cannot decode`);
	}

	return { paymentHash, descriptionHash, amountMsat, expiresAt };
}

export async function checkSettled(verifyUrl: string, paymentHash: string): Promise<Settlement> {
	const answer = await answeredJson<Verification>(verifyUrl);
	const pace = paceAskedFor(answer.headers);
	if (!answer.said.settled || !answer.said.preimage) return { preimage: null, pace };
	if (!preimageMatchesHash(answer.said.preimage, paymentHash)) {
		throw new Error(`verify returned a preimage that does not hash to ${paymentHash}`);
	}

	return { preimage: answer.said.preimage, pace };
}

export async function speaksVerify(url: string): Promise<boolean> {
	try {
		return typeof (await answeredJson<Verification>(url)).said.settled === "boolean";
	} catch {
		return false;
	}
}

function paceAskedFor(headers: Headers): number | null {
	const asked = /max-age\s*=\s*(\d+)/i.exec(headers.get("cache-control") ?? "");
	if (!asked) return null;

	return Math.min(Math.max(Number(asked[1]), MIN_PACE_SECS), MAX_PACE_SECS);
}

export function cannotReleaseAPreimage(host: string): boolean {
	const lowered = host.toLowerCase();
	return VERIFY_WITHOUT_PREIMAGE.some(
		(known) => lowered === known || lowered.endsWith(`.${known}`),
	);
}

/**
 * Bech32-encode a pay endpoint as the `LNURL1` string LUD-01 defines, uppercase
 * because that is the form it asks a QR to carry. An onion endpoint is http
 * rather than https, which LUD-17 spells out, so both are taken here
 */
export function toLnurl(endpoint: string): string {
	const scheme = parsedScheme(endpoint);
	if (scheme !== "https:" && scheme !== "http:") {
		throw new Error(`${endpoint} is not an http or https URL`);
	}

	const words = toWords(new TextEncoder().encode(endpoint));
	const data = [...words, ...checksumWords(LNURL_HRP, words)];

	return `${LNURL_HRP}1${data.map((word) => BECH32_CHARSET[word]).join("")}`.toUpperCase();
}

function parsedScheme(endpoint: string): string | null {
	try {
		return new URL(endpoint).protocol;
	} catch {
		return null;
	}
}

function toWords(bytes: Uint8Array): number[] {
	const words: number[] = [];
	let accumulator = 0;
	let bits = 0;

	for (const byte of bytes) {
		accumulator = (accumulator << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			words.push((accumulator >> bits) & 31);
		}
	}
	if (bits > 0) words.push((accumulator << (5 - bits)) & 31);

	return words;
}

function checksumWords(hrp: string, words: number[]): number[] {
	const expanded = [...hrp].map((char) => char.charCodeAt(0));
	const values = [
		...expanded.map((code) => code >> 5),
		0,
		...expanded.map((code) => code & 31),
		...words,
		...CHECKSUM_SLOTS.map(() => 0),
	];
	const polymod = bech32Polymod(values) ^ 1;

	return CHECKSUM_SLOTS.map((slot) => (polymod >> (5 * (5 - slot))) & 31);
}

function bech32Polymod(values: number[]): number {
	let checksum = 1;

	for (const value of values) {
		const top = checksum >> 25;
		checksum = ((checksum & 0x1ffffff) << 5) ^ value;
		for (let bit = 0; bit < 5; bit++) {
			if ((top >> bit) & 1) checksum ^= BECH32_GENERATOR[bit]!;
		}
	}

	return checksum;
}

function withAmount(callback: string, amountMsat: number): string {
	const separator = callback.includes("?") ? "&" : "?";
	return `${callback}${separator}amount=${amountMsat}`;
}

function splitAddress(address: string): [string, string] {
	const [user, domain, ...rest] = address.split("@");
	if (!user || !domain || rest.length > 0 || !publicHttps(`https://${domain}/`)) {
		throw new WalletRefused("address-unusable", `${address} is not a usable lightning address`);
	}
	return [user, domain];
}

async function fetchJson<T>(url: string, deadline?: AbortSignal): Promise<T> {
	return (await answeredJson<T>(url, deadline)).said;
}

async function answeredJson<T>(
	url: string,
	deadline?: AbortSignal,
): Promise<{ said: T; headers: Headers }> {
	const answer = await ask(url, { headers: { accept: "application/json" }, deadline });
	if (!answer.ok) throw new Error(`${url} answered ${answer.status}`);
	if (answer.truncated) {
		throw new Error(`${url} answered with more than the ${BODY_LIMIT_BYTES} bytes we read`);
	}

	return { said: JSON.parse(answer.body) as T, headers: answer.headers };
}
