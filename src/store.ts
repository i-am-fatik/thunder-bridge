import { announce, type Gossip } from "./gossip.ts";
import { paymentId, type Claim, type Ledger } from "./ledger.ts";
import type { Delivery, Payment, PublicPayment, UnsavedPayment } from "./payment.ts";

export type Info = { origin: string; peers: number };

export type Settled = { payment: Payment; won: boolean };

export class Store {
	readonly gossip: Gossip;

	onChange: (payment: Payment) => void = () => {};

	private readonly ledger: Ledger;
	private readonly key: Uint8Array;
	private readonly maxPending: number;

	constructor(ledger: Ledger, key: Uint8Array, maxPending: number) {
		this.ledger = ledger;
		this.key = key;
		this.maxPending = maxPending;
		this.gossip = {
			self: this.ledger.origin,
			key: this.key,
			peers: new Map(),
			onAdd: (payment) => {
				if (this.ledger.settlement(payment.id)) return;
				if (this.full()) return;
				this.onChange(this.ledger.remember(payment));
			},
			onFacts: (facts) => {
				for (const settled of this.ledger.absorb(facts)) {
					this.onChange(withWebhooks(settled, null));
				}
			},
			watermarks: () => this.ledger.watermarks(),
			held: () => this.ledger.all(),
			since: (theirs) => this.ledger.since(theirs),
		};
	}

	info(): Info {
		return { origin: this.ledger.origin, peers: this.gossip.peers.size };
	}

	insert(unsaved: UnsavedPayment): Payment {
		const id = paymentId(this.key, unsaved.paymentHash);
		const settled = this.ledger.settlement(id);
		if (settled) return withWebhooks(settled, null);

		const payment = this.ledger.remember({ ...unsaved, id });
		announce(this.gossip, { add: payment });

		return payment;
	}

	get(id: string): Payment | null {
		const pending = this.ledger.read(id);
		const settled = this.ledger.settlement(id);

		return settled ? withWebhooks(settled, pending) : pending;
	}

	paid(id: string, preimage: string): Settled {
		const pending = this.ledger.read(id);
		const already = this.ledger.settlement(id);
		if (already) {
			this.ledger.forget(id);
			return { payment: withWebhooks(already, pending), won: false };
		}
		if (!pending) throw new Error(`payment ${id} is not on the worklist`);

		const { settled, facts } = this.ledger.settle(pending, preimage);
		announce(this.gossip, { facts, more: false });
		this.onChange(withWebhooks(settled, null));

		return { payment: withWebhooks(settled, pending), won: true };
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

function withWebhooks(settled: PublicPayment, pending: Payment | null): Payment {
	return { ...settled, webhooks: pending?.webhooks ?? [] };
}
