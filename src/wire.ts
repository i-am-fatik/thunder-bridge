import { createHash } from "node:crypto";

import { publicHttps } from "../core/url.ts";
import type { Quote } from "../core/lnurl.ts";
import type { Kept } from "./ledger.ts";
import type { PublicPayment, Status, Webhook } from "./payment.ts";
import { MalformedRequest, type WalletFailure } from "./problem.ts";

const ASSET_CODE = "BTC";
const ASSET_SCALE = 11;
const MAX_ADDRESSES = 16;
const MAX_PER_DOMAIN = 3;
const MAX_ADDRESS_CHARS = 320;
const MAX_SEALED_CHARS = 4096;

export type Amount = { value: string; asset_code: string; asset_scale: number };

export type IncomingPayment = {
	id: string;
	kind: "minted" | "watched";
	ln_address?: string;
	incoming_amount?: Amount;
	status: Status;
	bolt11?: string;
	payment_hash: string;
	verify_url: string;
	preimage: string | null;
	expires_at: string;
	created_at: string;
	sealed?: string;
};

export type Delivered = {
	id: string;
	status: Status;
	payment_hash: string;
	preimage: string | null;
	settled_at: string;
};

export type KeptRecord = {
	id: string;
	kind: "kept";
	status: "paid" | "expired";
	settled_at?: string;
	sealed: string;
};

export type WatchRequest = {
	paymentHash: string;
	verifyUrl: string;
	expiresAt: number;
	trigger: string | null;
	sealed: string | null;
	webhook: Webhook | null;
};

export type QuoteOffer = {
	ln_address: string;
	amount: Amount;
	fee: Amount;
	min_amount: Amount;
	max_amount: Amount;
	metadata: string;
	refusals: WalletFailure[];
};

export type CreateRequest = {
	addresses: string[];
	amountMsat: number;
	webhook: Webhook | null;
	trigger: string | null;
};

export type QuoteRequest = {
	addresses: string[];
	amountMsat: number;
};

export type TicketRequest =
	| { kind: "trigger"; secret: string }
	| { kind: "payment"; paymentId: string };

export function paymentToWire(payment: PublicPayment): IncomingPayment {
	return {
		id: payment.id,
		kind: payment.lnAddress === null ? "watched" : "minted",
		...(payment.lnAddress === null ? {} : { ln_address: payment.lnAddress }),
		...(payment.amountMsat === null ? {} : { incoming_amount: toAmount(payment.amountMsat) }),
		status: payment.status,
		...(payment.bolt11 === null ? {} : { bolt11: payment.bolt11 }),
		payment_hash: payment.paymentHash,
		verify_url: payment.verifyUrl,
		preimage: payment.preimage,
		expires_at: toTimestamp(payment.expiresAt),
		created_at: toTimestamp(payment.createdAt),
		...(payment.sealed === null ? {} : { sealed: payment.sealed }),
	};
}

/**
 * What a delivery says. Enough to act on and to check without asking anybody: the
 * name, how it ended, and the preimage against the hash it has to match. Not the
 * verify url the client already knows, and not the client's own sealed record,
 * which would make the size of a retry depend on what the client put in it
 */
export function deliveryToWire(payment: PublicPayment, settledAt: number): Delivered {
	return {
		id: payment.id,
		status: payment.status,
		payment_hash: payment.paymentHash,
		preimage: payment.preimage,
		settled_at: toTimestamp(settledAt),
	};
}

/**
 * What is left once the gateway has forgotten the payment: the client's own
 * ciphertext and how it ended. No hash, no url, no invoice, because it kept none
 */
export function keptToWire(kept: Kept): KeptRecord {
	return {
		id: kept.id,
		kind: "kept",
		status: kept.status,
		...(kept.settledAt === null ? {} : { settled_at: toTimestamp(kept.settledAt) }),
		sealed: kept.sealed,
	};
}

export function readWatchRequest(body: unknown): WatchRequest {
	const fields = asObject(body, "the request body must be a JSON object");
	const verifyUrl = fields["verify_url"];
	if (typeof verifyUrl !== "string" || !publicHttps(verifyUrl)) {
		throw new MalformedRequest("verify_url must be a public https URL");
	}

	return {
		paymentHash: readHash(fields["payment_hash"]),
		verifyUrl,
		expiresAt: readExpiry(fields["expires_at"]),
		trigger: readTrigger(fields["trigger"]),
		sealed: readSealed(fields["sealed"]),
		webhook: readWebhook(fields["webhook"]),
	};
}

export function quoteToWire(
	quote: Quote,
	amountMsat: number,
	refusals: WalletFailure[],
): QuoteOffer {
	return {
		ln_address: quote.address,
		amount: toAmount(amountMsat),
		fee: toAmount(0),
		min_amount: toAmount(quote.minMsat),
		max_amount: toAmount(quote.maxMsat),
		metadata: quote.metadata,
		refusals,
	};
}

export function readCreateRequest(body: unknown): CreateRequest {
	const fields = asObject(body, "the request body must be a JSON object");
	return {
		addresses: readAddresses(fields["ln_addresses"]),
		amountMsat: readAmount(fields["incoming_amount"], "incoming_amount"),
		webhook: readWebhook(fields["webhook"]),
		trigger: readTrigger(fields["trigger"]),
	};
}

export function readQuoteRequest(body: unknown): QuoteRequest {
	const fields = asObject(body, "the request body must be a JSON object");
	return {
		addresses: readAddresses(fields["ln_addresses"]),
		amountMsat: readAmount(fields["amount"], "amount"),
	};
}

export function readTicketRequest(body: unknown): TicketRequest {
	const fields = asObject(body, "the request body must be a JSON object");
	const secret = fields["trigger_secret"];
	const paymentId = fields["payment_id"];

	if ((secret === undefined) === (paymentId === undefined)) {
		throw new MalformedRequest("name exactly one of trigger_secret or payment_id");
	}
	if (secret !== undefined) {
		if (typeof secret !== "string" || secret.length === 0) {
			throw new MalformedRequest("trigger_secret must be a non-empty string");
		}
		return { kind: "trigger", secret };
	}
	if (typeof paymentId !== "string" || !/^[\w-]+$/.test(paymentId)) {
		throw new MalformedRequest("payment_id must be an id this gateway could have issued");
	}

	return { kind: "payment", paymentId };
}

export function fingerprint(asked: CreateRequest): string {
	return createHash("sha256")
		.update(JSON.stringify([asked.addresses, asked.amountMsat, asked.webhook, asked.trigger]))
		.digest("hex");
}

function toAmount(msat: number): Amount {
	return { value: String(msat), asset_code: ASSET_CODE, asset_scale: ASSET_SCALE };
}

function toTimestamp(unixSeconds: number): string {
	return new Date(unixSeconds * 1000).toISOString();
}

function asObject(value: unknown, complaint: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new MalformedRequest(complaint);
	}
	return value as Record<string, unknown>;
}

function readAddresses(value: unknown): string[] {
	const listed = Array.isArray(value) && value.every((one) => typeof one === "string");
	if (!listed || value.length === 0) {
		throw new MalformedRequest("ln_addresses must be a non-empty list of lightning addresses");
	}
	const addresses = value as string[];
	if (addresses.length > MAX_ADDRESSES) {
		throw new MalformedRequest(`ln_addresses takes at most ${MAX_ADDRESSES} addresses`);
	}
	if (addresses.some((one) => one.length > MAX_ADDRESS_CHARS)) {
		throw new MalformedRequest(`a lightning address is at most ${MAX_ADDRESS_CHARS} characters`);
	}
	const crowded = domainAskedTooOften(addresses);
	if (crowded !== null) {
		throw new MalformedRequest(
			`ln_addresses names ${crowded} more than ${MAX_PER_DOMAIN} times, and a priority list is meant to name different providers`,
		);
	}
	return addresses;
}

function domainAskedTooOften(addresses: string[]): string | null {
	const asked = new Map<string, number>();
	for (const address of addresses) {
		const at = address.lastIndexOf("@");
		if (at < 0) continue;
		const domain = address.slice(at + 1).toLowerCase();
		const seen = (asked.get(domain) ?? 0) + 1;
		if (seen > MAX_PER_DOMAIN) return domain;
		asked.set(domain, seen);
	}

	return null;
}

function readAmount(value: unknown, field: string): number {
	const amount = asObject(value, `${field} must be an amount object`);
	if (amount["asset_code"] !== ASSET_CODE || amount["asset_scale"] !== ASSET_SCALE) {
		throw new MalformedRequest(
			`${field} must be ${ASSET_CODE} at scale ${ASSET_SCALE}, the scale that counts millisatoshi`,
		);
	}

	const digits = amount["value"];
	if (typeof digits !== "string" || !/^[0-9]+$/.test(digits)) {
		throw new MalformedRequest(`${field}.value must be a decimal string`);
	}

	const msat = Number(digits);
	if (msat <= 0 || !Number.isSafeInteger(msat)) {
		throw new MalformedRequest(`${field}.value must be a positive count of millisatoshi`);
	}
	return msat;
}

function readHash(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
		throw new MalformedRequest("payment_hash must be 32 bytes of lowercase hex");
	}
	return value;
}

function readExpiry(value: unknown): number {
	if (typeof value !== "string") {
		throw new MalformedRequest("expires_at must be an RFC 3339 timestamp");
	}
	const milliseconds = Date.parse(value);
	if (Number.isNaN(milliseconds)) {
		throw new MalformedRequest("expires_at must be an RFC 3339 timestamp");
	}
	return Math.floor(milliseconds / 1000);
}

function readSealed(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || value.length > MAX_SEALED_CHARS) {
		throw new MalformedRequest(`sealed must be a string of at most ${MAX_SEALED_CHARS} characters`);
	}
	return value;
}

function readTrigger(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
		throw new MalformedRequest("trigger must be the hex sha256 of the secret you will watch with");
	}
	return value;
}

function readWebhook(value: unknown): Webhook | null {
	if (value === undefined || value === null) return null;

	const hook = asObject(value, "webhook must be an object");
	const url = hook["url"];
	if (typeof url !== "string" || !publicHttps(url)) {
		throw new MalformedRequest("webhook.url must be a public https URL");
	}

	if (hook["secret"] !== undefined) {
		throw new MalformedRequest(
			"webhook.secret is gone, a delivery is signed with the key this gateway publishes at /webhook-key",
		);
	}

	return { url };
}
