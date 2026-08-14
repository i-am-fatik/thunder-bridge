import { bytesToHex, hexToBytes, isHex } from "./bytes.ts";
import { sha256 } from "./sha256.ts";

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const CHECKSUM_WORDS = 6;
const TIMESTAMP_WORDS = 7;
const SIGNATURE_WORDS = 104;
const TAGGED_FIELD_LENGTH_WORDS = 2;
const PAYMENT_HASH_TAG = 1;
const PAYMENT_HASH_WORDS = 52;
const EXPIRY_TAG = 6;
const DESCRIPTION_HASH_TAG = 23;
const DESCRIPTION_HASH_WORDS = 52;
const DEFAULT_EXPIRY_SECS = 3600;

const MSAT_PER_BTC = 100_000_000_000;
const HRP_MULTIPLIER_MSAT: Record<string, number> = {
	m: MSAT_PER_BTC / 1_000,
	u: MSAT_PER_BTC / 1_000_000,
	n: MSAT_PER_BTC / 1_000_000_000,
	p: MSAT_PER_BTC / 1_000_000_000_000,
};

const HRP_AMOUNT = /^ln[a-z]+?(\d+)([munp]?)$/;

/** What a BOLT11 invoice says about itself, every field null when it does not carry one */
export interface Invoice {
	paymentHash: string | null;
	descriptionHash: string | null;
	amountMsat: number | null;
	expiresAt: number | null;
}

/**
 * Read a BOLT11 invoice without trusting anyone for its contents, an
 * undecodable string or a BOLT12 offer yields an invoice with every field null
 */
export function decodeInvoice(bolt11: string): Invoice {
	const parts = splitBech32(bolt11);
	if (parts === null) {
		return { paymentHash: null, descriptionHash: null, amountMsat: null, expiresAt: null };
	}

	const tagged = taggedFields(parts.words);

	return {
		paymentHash: hexTag(tagged, PAYMENT_HASH_TAG, PAYMENT_HASH_WORDS),
		descriptionHash: hexTag(tagged, DESCRIPTION_HASH_TAG, DESCRIPTION_HASH_WORDS),
		amountMsat: amountFromHrp(parts.hrp),
		expiresAt: expiryOf(parts.words, tagged),
	};
}

/** True when `preimage` is the secret behind `paymentHash` */
export function preimageMatchesHash(preimage: string, paymentHash: string): boolean {
	if (!isHex(preimage)) {
		return false;
	}

	return bytesToHex(sha256(hexToBytes(preimage))) === paymentHash.toLowerCase();
}

interface Bech32Parts {
	hrp: string;
	words: number[];
}

function splitBech32(bolt11: string): Bech32Parts | null {
	const lower = bolt11.toLowerCase();
	if (isBolt12Encoding(lower)) {
		return null;
	}

	const separator = lower.lastIndexOf("1");
	if (separator < 1) {
		return null;
	}

	const dataChars = lower.slice(separator + 1);
	if (dataChars.length < CHECKSUM_WORDS) {
		return null;
	}

	const words: number[] = [];
	for (const char of dataChars) {
		const value = BECH32_CHARSET.indexOf(char);
		if (value === -1) {
			return null;
		}
		words.push(value);
	}

	return { hrp: lower.slice(0, separator), words: words.slice(0, -CHECKSUM_WORDS) };
}

function isBolt12Encoding(lower: string): boolean {
	return lower.startsWith("lno") || lower.startsWith("lni") || lower.startsWith("lnr");
}

type TaggedFields = Map<number, number[]>;

function taggedFields(words: number[]): TaggedFields {
	const fields: TaggedFields = new Map();
	const signatureStart = words.length - SIGNATURE_WORDS;
	let cursor = TIMESTAMP_WORDS;

	while (cursor + 1 + TAGGED_FIELD_LENGTH_WORDS <= signatureStart) {
		const lengthWords = words[cursor + 1]! * 32 + words[cursor + 2]!;
		const dataStart = cursor + 1 + TAGGED_FIELD_LENGTH_WORDS;
		const dataEnd = dataStart + lengthWords;
		if (dataEnd > signatureStart) {
			return fields;
		}
		if (!fields.has(words[cursor]!)) {
			fields.set(words[cursor]!, words.slice(dataStart, dataEnd));
		}
		cursor = dataEnd;
	}

	return fields;
}

function hexTag(fields: TaggedFields, tag: number, expectedWords: number): string | null {
	const words = fields.get(tag);
	if (words === undefined || words.length !== expectedWords) {
		return null;
	}

	return bytesToHex(wordsToBytes(words));
}

function expiryOf(words: number[], fields: TaggedFields): number | null {
	if (words.length < TIMESTAMP_WORDS + SIGNATURE_WORDS) {
		return null;
	}

	const expiry = fields.get(EXPIRY_TAG);

	return (
		readNumber(words.slice(0, TIMESTAMP_WORDS)) +
		(expiry ? readNumber(expiry) : DEFAULT_EXPIRY_SECS)
	);
}

function amountFromHrp(hrp: string): number | null {
	const match = HRP_AMOUNT.exec(hrp);
	if (match === null) {
		return null;
	}

	const [, digits, multiplier] = match;

	return multiplier
		? Number(digits) * HRP_MULTIPLIER_MSAT[multiplier]!
		: Number(digits) * MSAT_PER_BTC;
}

function readNumber(words: number[]): number {
	return words.reduce((total, word) => total * 32 + word, 0);
}

function wordsToBytes(words: number[]): Uint8Array {
	const bytes: number[] = [];
	let accumulator = 0;
	let bits = 0;

	for (const word of words) {
		accumulator = (accumulator << 5) | word;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((accumulator >>> bits) & 0xff);
		}
	}

	return Uint8Array.from(bytes);
}
