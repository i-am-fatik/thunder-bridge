import { announce, type Gossip } from "./gossip.ts";
import {
	paymentId,
	SOURCES,
	type Claim,
	type Facts,
	type Ledger,
	type Source,
	type Watermarks,
} from "./ledger.ts";
import type { Delivery, Payment, PublicPayment, UnsavedPayment } from "./payment.ts";

export type Info = {
	origin: string;
	peers: number;
	pending: number;
	maxPending: number;
	convergedAt: number | null;
	origins: number;
	marks: Record<Source, number>;
	rows: Record<Source, number>;
};

export type Settled = { payment: Payment; won: boolean };

export class Store {
	readonly gossip: Gossip;

	onChange: (payment: Payment) => void = () => {};

	private readonly ledger: Ledger;
	private readonly key: Uint8Array;
	private readonly maxPending: number;
	private convergedAt: number | null = null;

	constructor(ledger: Ledger, key: Uint8Array, maxPending: number) {
		this.ledger = ledger;
		this.key = key;
		this.maxPending = maxPending;
		this.gossip = {
			self: this.ledger.origin,
			key: this.key,
			peers: new Map(),
			onFacts: (facts) => {
				for (const settled of this.ledger.absorb(facts)) {
					this.onChange(asPayment(settled));
				}
			},
			onConverged: () => {
				this.convergedAt = Math.floor(Date.now() / 1000);
			},
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
			convergedAt: this.convergedAt,
			origins: origins.size,
			marks: sequenceTotals(marks),
			rows: this.ledger.factCounts(),
		};
	}

	insert(unsaved: UnsavedPayment): Payment {
		const id = paymentId(this.key, unsaved.paymentHash);
		const settled = this.ledger.settlement(id);
		if (settled) return asPayment(settled);

		const taken = this.ledger.accept({ ...unsaved, id });
		this.spread(taken.facts);

		return taken.payment;
	}

	private spread(facts: Facts): void {
		if (facts.accepted) announce(this.gossip, { facts, more: false });
	}

	get(id: string): Payment | null {
		const pending = this.ledger.read(id);
		const settled = this.ledger.settlement(id);

		return settled ? asPayment(settled, pending) : pending;
	}

	paid(id: string, preimage: string): Settled {
		const pending = this.ledger.read(id);
		const already = this.ledger.settlement(id);
		if (already) {
			this.ledger.forget(id);
			return { payment: asPayment(already, pending), won: false };
		}
		if (!pending) throw new Error(`payment ${id} is not on the worklist`);

		const { settled, facts } = this.ledger.settle(pending, preimage);
		announce(this.gossip, { facts, more: false });
		this.onChange(asPayment(settled));

		return { payment: asPayment(settled, pending), won: true };
	}

	replay(trigger: string, limit: number, window: number): PublicPayment[] {
		return this.ledger.replay(trigger, limit, window);
	}

	list(limit: number, window: number): PublicPayment[] {
		return this.ledger.list(limit, window);
	}

	full(): boolean {
		return this.ledger.count() >= this.maxPending;
	}

	duePolls(limit: number, leaseSecs: number): Payment[] {
		return this.ledger.claim(limit, leaseSecs);
	}

	polled(id: string, dueAt: number | null): void {
		this.ledger.polled(id, dueAt);
	}

	dueDeliveries(limit: number, leaseSecs: number): Delivery[] {
		return this.ledger.dueDeliveries(limit, leaseSecs);
	}

	delivered(owed: Delivery): void {
		announce(this.gossip, { facts: this.ledger.delivered(owed), more: false });
	}

	undelivered(owed: Delivery): void {
		this.ledger.undelivered(owed);
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

	sweep(graceSecs: number): Payment[] {
		return this.ledger.sweep(graceSecs);
	}

	close(): void {
		this.ledger.close();
	}
}

function sequenceTotals(marks: Watermarks): Record<Source, number> {
	const summed = SOURCES.map((source) => [
		source,
		Object.values(marks[source]).reduce((all, seq) => all + seq, 0),
	]);

	return Object.fromEntries(summed) as Record<Source, number>;
}

function asPayment(settled: PublicPayment, pending: Payment | null = null): Payment {
	return { ...settled, webhooks: pending?.webhooks ?? [] };
}
