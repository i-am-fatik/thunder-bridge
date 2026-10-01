import { createHash } from "node:crypto";

import { paymentNamedBy } from "../core/caller.ts";
import { announce, type Gossip } from "./gossip.ts";
import {
	type AcceptedFact,
	type Claim,
	type Facts,
	type Kept,
	type Ledger,
	paymentId,
	type Retry,
	SOURCES,
	type Source,
	type Watermarks,
} from "./ledger.ts";
import type { Delivery, Payment, PublicPayment, UnsavedPayment } from "./payment.ts";
import { LEASE_SECS, pollDelayMs, unixNow } from "./watch.ts";

export type Info = {
	origin: string;
	peers: number;
	pending: number;
	maxPending: number;
	parked: number;
	convergedAt: number | null;
	origins: number;
	marks: Record<Source, number>;
	rows: Record<Source, number>;
};

export type Settled = { payment: Payment; won: boolean };

type Watched = Pick<Payment, "id" | "verifyUrl">;

export class Store {
	readonly gossip: Gossip;

	onChange: (payment: Payment) => void = () => {};

	onScheduled: () => void = () => {};

	onSpent: (once: string, until: number) => void = () => {};

	answersAlone: (verifyUrl: string) => boolean = () => false;

	private readonly ledger: Ledger;
	private readonly key: Uint8Array;
	private readonly maxPending: number;
	private readonly eagerDelayMs: number;
	private convergedAt: number | null = null;

	constructor(ledger: Ledger, key: Uint8Array, maxPending = 5000, eagerDelayMs = 5_000) {
		this.ledger = ledger;
		this.key = key;
		this.maxPending = maxPending;
		this.eagerDelayMs = eagerDelayMs;
		this.gossip = {
			self: this.ledger.origin,
			key: this.key,
			peers: new Map(),
			onFacts: (facts, through) => {
				for (const settled of this.ledger.absorb(facts, through, (fact) => this.standby(fact))) {
					this.onChange(asPayment(settled));
				}
				this.onScheduled();
			},
			onConverged: () => {
				this.convergedAt = Math.floor(Date.now() / 1000);
			},
			onPolled: (id, next) => {
				const held = this.ledger.read(id);
				if (held) {
					this.postponed(held, next);
					this.onScheduled();
				}
			},
			onMissed: (id, by) => {
				const held = this.ledger.read(id);
				if (held) {
					const others = [...this.gossip.peers.keys()].filter((peer) => peer !== by);
					const now = unixNow();
					this.ledger.broughtForward(id, this.turn(held, now, this.eagerDelayMs / 1000, others));
					this.onScheduled();
				}
			},
			onSpent: (once, until) => this.onSpent(once, until),
			watermarks: () => this.ledger.watermarks(),
			since: (theirs) => this.ledger.since(theirs),
		};
	}

	info(): Info {
		const marks = this.ledger.watermarks();
		const origins = new Set(SOURCES.flatMap((source) => Object.keys(marks[source])));

		return {
			origin: this.ledger.origin,
			peers: this.gossip.peers.size,
			pending: this.ledger.count(),
			maxPending: this.maxPending,
			parked: this.ledger.parkedDeliveries(),
			convergedAt: this.convergedAt,
			origins: origins.size,
			marks: sequenceTotals(marks),
			rows: this.ledger.factCounts(),
		};
	}

	insert(unsaved: UnsavedPayment): Payment {
		const id = this.names(unsaved);
		const settled = this.ledger.settlement(id);
		if (settled) {
			return asPayment(settled);
		}

		const taken = this.ledger.accept(
			{ ...unsaved, id },
			this.turn({ id, verifyUrl: unsaved.verifyUrl }, unixNow(), this.eagerDelayMs / 1000),
		);
		this.spread(taken.facts);
		this.onScheduled();

		return taken.payment;
	}

	/**
	 * A caller's payment is named after that caller, so the name survives a
	 * rotation of this instance's key and reads the same at every gateway watching
	 * it. Only a payment nobody signed for falls back to this instance's own key
	 */
	names(named: { caller: string | null; paymentHash: string }): string {
		return named.caller === null
			? paymentId(this.key, named.paymentHash)
			: paymentNamedBy(named.caller, named.paymentHash);
	}

	private spread(facts: Facts): void {
		if (facts.accepted) {
			announce(this.gossip, { facts, more: false });
		}
	}

	get(id: string): Payment | null {
		const watched = this.ledger.read(id);
		const settled = this.ledger.settlement(id);

		return settled ? asPayment(settled, watched) : watched;
	}

	paid(id: string, preimage: string): Settled {
		const watched = this.ledger.read(id);
		const already = this.ledger.settlement(id);
		if (already) {
			this.ledger.forget(id);
			return { payment: asPayment(already, watched), won: false };
		}
		if (!watched) {
			throw new Error(`payment ${id} is not on the worklist`);
		}

		const { settled, facts } = this.ledger.settle(watched, preimage);
		announce(this.gossip, { facts, more: false });
		this.onChange(asPayment(settled));
		this.onScheduled();

		return { payment: asPayment(settled, watched), won: true };
	}

	replay(trigger: string, limit: number): PublicPayment[] {
		return this.ledger.replay(trigger, limit);
	}

	list(limit: number, window: number): PublicPayment[] {
		return this.ledger.list(limit, window);
	}

	full(caller: string | null): boolean {
		return this.ledger.countFor(caller) >= this.maxPending;
	}

	duePolls(limit: number, leaseSecs: number): Payment[] {
		return this.ledger.duePolls(limit, leaseSecs);
	}

	polled(payment: Watched, next: number | null): void {
		this.postponed(payment, next);
		announce(this.gossip, { polled: { id: payment.id, next } });
	}

	missed(payment: Watched, next: number | null): void {
		this.postponed(payment, next);
		announce(this.gossip, { missed: { id: payment.id } });
	}

	postponed(payment: Watched, next: number | null): void {
		this.ledger.polled(
			payment.id,
			next === null ? null : this.turn(payment, next, next - unixNow()),
		);
	}

	spent(once: string, until: number): void {
		announce(this.gossip, { spent: { once, until } });
	}

	instances(): number {
		return 1 + this.gossip.peers.size;
	}

	caughtUp(): boolean {
		return this.convergedAt !== null;
	}

	private turn(
		payment: Watched,
		next: number,
		gapSecs: number,
		among: Iterable<string> = this.gossip.peers.keys(),
	): number {
		const wait = Math.min(Math.max(Math.ceil(gapSecs), 1), LEASE_SECS);
		const ahead = this.answersAlone(payment.verifyUrl)
			? 0
			: rankAmong(payment.id, this.gossip.self, among);

		return next + ahead * wait;
	}

	private standby(accepted: AcceptedFact): number {
		const now = unixNow();
		const waited = now - accepted.acceptedAt;
		const gapSecs = pollDelayMs(waited, this.eagerDelayMs) / 1000;
		const next = waited < gapSecs ? accepted.acceptedAt : now + Math.ceil(gapSecs);
		const { verifyUrl } = JSON.parse(accepted.payment) as Payment;

		return this.turn({ id: accepted.id, verifyUrl }, next, gapSecs);
	}

	nextDueAt(): number | null {
		return this.ledger.nextDueAt();
	}

	dueDeliveries(limit: number, leaseSecs: number): Delivery[] {
		return this.ledger.dueDeliveries(limit, leaseSecs);
	}

	delivered(owed: Delivery): void {
		announce(this.gossip, { facts: this.ledger.delivered(owed), more: false });
	}

	undelivered(owed: Delivery): Retry {
		return this.ledger.undelivered(owed);
	}

	claim(key: string, fingerprint: string, leaseSecs: number): Claim {
		return this.ledger.claimKey(key, fingerprint, leaseSecs);
	}

	fulfill(key: string, id: string): void {
		this.ledger.fulfillKey(key, id);
	}

	release(key: string): void {
		this.ledger.releaseKey(key);
	}

	sweep(graceSecs: number, keepSealedSecs: number): Payment[] {
		const expired = this.ledger.sweep(graceSecs, keepSealedSecs);
		this.onScheduled();

		return expired;
	}

	kept(id: string): Kept | null {
		return this.ledger.kept(id);
	}

	close(): void {
		this.ledger.close();
	}
}

export function rankAmong(id: string, self: string, peers: Iterable<string>): number {
	const mine = standing(id, self);
	let ahead = 0;
	for (const peer of peers) {
		if (standing(id, peer) > mine) {
			ahead += 1;
		}
	}

	return ahead;
}

function standing(id: string, origin: string): string {
	return createHash("sha256").update(`${id}\x00${origin}`).digest("hex");
}

function sequenceTotals(marks: Watermarks): Record<Source, number> {
	const summed = SOURCES.map((source) => [
		source,
		Object.values(marks[source]).reduce((all, seq) => all + seq, 0),
	]);

	return Object.fromEntries(summed) as Record<Source, number>;
}

function asPayment(settled: PublicPayment, watched: Payment | null = null): Payment {
	return { ...settled, webhooks: watched?.webhooks ?? [] };
}
