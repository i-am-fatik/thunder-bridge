import { setTimeout as sleep } from "node:timers/promises";

import { bytesToHex } from "../core/bytes.ts";
import type { SigningKey } from "../core/ed25519.ts";
import { equalInConstantTime } from "../core/hmac.ts";
import { checkSettled } from "../core/lnurl.ts";
import { ask } from "../core/outbound.ts";
import * as log from "./log.ts";
import type { Delivery, Payment, Webhook } from "./payment.ts";
import type { Store } from "./store.ts";

const EAGER_WINDOW_SECS = 300;
const STALENESS = 0.1;
const LEASE_SECS = 30;
const NONCE_BYTES = 32;

export const CHALLENGE = "webhook-challenge";

export const WATCH_HORIZON_SECS = 259_200;

export type Budget = {
	perSecond: number;
	perTick: number;
	nextAt: Map<string, number>;
	pace: Map<string, number>;
};

export type Watcher = {
	store: Store;
	eagerDelayMs: number;
	budget: Budget;
	webhookKey: SigningKey;
};

export async function tick(watcher: Watcher): Promise<void> {
	await Promise.all([pollDue(watcher), deliverDue(watcher)]);
}

async function pollDue(watcher: Watcher): Promise<void> {
	const due = watcher.store.duePolls(watcher.budget.perTick, LEASE_SECS);
	await Promise.all(
		due.map((payment) =>
			poll(watcher, payment).catch((error: unknown) => {
				log.error(`poll for ${payment.id} stopped: ${String(error)}`);
			}),
		),
	);
}

async function poll(watcher: Watcher, payment: Payment): Promise<void> {
	const host = hostOf(payment.verifyUrl);
	await spend(watcher.budget, host);

	const settlement = await checkSettled(payment.verifyUrl, payment.paymentHash).catch(
		(error: unknown) => {
			log.warn(`verify poll for ${payment.id} failed: ${String(error)}`);
			return null;
		},
	);
	if (settlement?.pace) watcher.budget.pace.set(host, settlement.pace);

	if (!settlement?.preimage) {
		watcher.store.polled(payment.id, nextDue(payment, watcher.eagerDelayMs, paceAsked(watcher, host)));
		return;
	}

	const { payment: settled, won } = watcher.store.paid(payment.id, settlement.preimage);
	log.info(`payment ${settled.id} paid${won ? "" : ", settled elsewhere"}`);
}

function paceAsked(watcher: Watcher, host: string): number | null {
	const asked = watcher.budget.pace.get(host);

	return asked === undefined ? null : asked * 1000;
}

async function deliverDue(watcher: Watcher): Promise<void> {
	const owed = watcher.store.dueDeliveries(watcher.budget.perTick, LEASE_SECS);
	await Promise.all(
		owed.map((one) =>
			deliver(watcher, one).catch((error: unknown) => {
				log.error(`webhook for ${one.id} stopped: ${String(error)}`);
			}),
		),
	);
}

async function deliver(watcher: Watcher, owed: Delivery): Promise<void> {
	if (!(await notify(owed, watcher.webhookKey))) {
		if (watcher.store.undelivered(owed) === "abandoned") {
			log.error(`webhook for ${owed.id} abandoned, its payment ran out of time to retry in`);
		}
		return;
	}

	log.info(`webhook for ${owed.id} delivered`);
	watcher.store.delivered(owed);
}

async function notify(owed: Delivery, gatewayKey: SigningKey): Promise<boolean> {
	try {
		const answer = await ask(owed.url, {
			method: "POST",
			headers: await signedHeaders(owed.body, owed.secret, gatewayKey),
			body: owed.body,
		});
		if (!answer.ok) log.warn(`webhook for ${owed.id} rejected with ${answer.status}`);
		return answer.ok;
	} catch (error: unknown) {
		log.warn(`webhook for ${owed.id} failed: ${String(error)}`);
		return false;
	}
}

export async function confirmWebhook(hook: Webhook, gatewayKey: SigningKey): Promise<boolean> {
	const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
	const body = JSON.stringify({ type: CHALLENGE, nonce });

	try {
		const answer = await ask(hook.url, {
			method: "POST",
			headers: await signedHeaders(body, hook.secret, gatewayKey),
			body,
		});
		if (!answer.ok) {
			log.warn(`webhook ${hook.url} answered the challenge with ${answer.status}`);
			return false;
		}

		return await proves(answer.body, nonce, hook.secret);
	} catch (error: unknown) {
		log.warn(`webhook ${hook.url} could not be challenged: ${String(error)}`);
		return false;
	}
}

async function proves(body: string, nonce: string, secret: string | null): Promise<boolean> {
	const answered = asJson(body);
	if (answered["nonce"] !== nonce) {
		log.warn("a webhook answered a challenge without the nonce it was given");
		return false;
	}
	if (!secret) return true;

	const expected = `sha256=${await sign(secret, nonce)}`;
	const signed = equalInConstantTime(String(answered["signature"] ?? ""), expected);
	if (!signed) log.warn("a webhook answered a challenge the registered secret does not sign");

	return signed;
}

function asJson(body: string): Record<string, unknown> {
	try {
		return JSON.parse(body) as Record<string, unknown>;
	} catch {
		return {};
	}
}

async function signedHeaders(
	body: string,
	secret: string | null,
	gatewayKey: SigningKey,
): Promise<Record<string, string>> {
	const stamped = String(unixNow());
	const signed = `${stamped}.${body}`;

	return {
		"content-type": "application/json",
		"x-timestamp": stamped,
		"x-signature": secret
			? `sha256=${await sign(secret, signed)}`
			: `ed25519=${await gatewayKey.sign(new TextEncoder().encode(signed))}`,
	};
}

export function nextDue(
	payment: Payment,
	eagerMs: number,
	askedMs: number | null = null,
): number | null {
	const now = unixNow();
	const waited = now - payment.createdAt;
	if (now >= payment.expiresAt || waited >= WATCH_HORIZON_SECS) return null;

	return Math.min(now + Math.ceil(pollDelayMs(waited, eagerMs, askedMs) / 1000), payment.expiresAt);
}

export async function spend(budget: Budget, host: string): Promise<void> {
	const now = Date.now();
	const slot = Math.max(now, budget.nextAt.get(host) ?? 0);
	budget.nextAt.set(host, slot + 1000 / budget.perSecond);
	await sleep(slot - now);
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

export function pollDelayMs(
	waitedSecs: number,
	eagerMs: number,
	askedMs: number | null = null,
): number {
	if (askedMs !== null) return askedMs;
	if (waitedSecs < EAGER_WINDOW_SECS) return eagerMs;
	return waitedSecs * STALENESS * 1000;
}

export async function sign(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function unixNow(): number {
	return Math.floor(Date.now() / 1000);
}
