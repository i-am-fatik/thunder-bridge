import { setTimeout as sleep } from "node:timers/promises";

import { checkSettled } from "../core/lnurl.ts";
import { ask } from "../core/outbound.ts";
import type { Delivery, Payment } from "./payment.ts";
import type { Store } from "./store.ts";

const EAGER_WINDOW_SECS = 300;
const STALENESS = 0.1;
const LEASE_SECS = 30;

export const WATCH_HORIZON_SECS = 259_200;

export type Budget = { perSecond: number; nextAt: Map<string, number> };

export type Watcher = {
	store: Store;
	eagerDelayMs: number;
	budget: Budget;
};

export async function tick(watcher: Watcher): Promise<void> {
	await Promise.all([pollDue(watcher), deliverDue(watcher)]);
}

async function pollDue(watcher: Watcher): Promise<void> {
	const due = watcher.store.duePolls(watcher.budget.perSecond, LEASE_SECS);
	await Promise.all(
		due.map((payment) =>
			poll(watcher, payment).catch((error: unknown) => {
				console.error(`poll for ${payment.id} stopped: ${String(error)}`);
			}),
		),
	);
}

async function poll(watcher: Watcher, payment: Payment): Promise<void> {
	await spend(watcher.budget, hostOf(payment.verifyUrl));

	const preimage = await checkSettled(payment.verifyUrl, payment.paymentHash).catch(
		(error: unknown) => {
			console.warn(`verify poll for ${payment.id} failed: ${String(error)}`);
			return null;
		},
	);
	if (!preimage) {
		watcher.store.polled(payment.id, nextDue(payment, watcher.eagerDelayMs));
		return;
	}

	const { payment: settled, won } = watcher.store.paid(payment.id, preimage);
	console.log(`payment ${settled.id} paid${won ? "" : ", settled elsewhere"}`);
}

async function deliverDue(watcher: Watcher): Promise<void> {
	const owed = watcher.store.dueDeliveries(watcher.budget.perSecond, LEASE_SECS);
	await Promise.all(
		owed.map((one) =>
			deliver(watcher, one).catch((error: unknown) => {
				console.error(`webhook for ${one.id} stopped: ${String(error)}`);
			}),
		),
	);
}

async function deliver(watcher: Watcher, owed: Delivery): Promise<void> {
	if (!(await notify(owed))) {
		watcher.store.undelivered(owed);
		return;
	}

	console.log(`webhook for ${owed.id} delivered`);
	watcher.store.delivered(owed);
}

async function notify(owed: Delivery): Promise<boolean> {
	const stamped = String(unixNow());
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"x-timestamp": stamped,
	};
	if (owed.secret) {
		headers["x-signature"] = `sha256=${await sign(owed.secret, `${stamped}.${owed.body}`)}`;
	}

	try {
		const answer = await ask(owed.url, { method: "POST", headers, body: owed.body });
		if (!answer.ok) console.warn(`webhook for ${owed.id} rejected with ${answer.status}`);
		return answer.ok;
	} catch (error: unknown) {
		console.warn(`webhook for ${owed.id} failed: ${String(error)}`);
		return false;
	}
}

export function nextDue(payment: Payment, eagerMs: number): number | null {
	const now = unixNow();
	const waited = now - payment.createdAt;
	if (now >= payment.expiresAt || waited >= WATCH_HORIZON_SECS) return null;

	return Math.min(now + Math.ceil(pollDelayMs(waited, eagerMs) / 1000), payment.expiresAt);
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

export function pollDelayMs(waitedSecs: number, eagerMs: number): number {
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
