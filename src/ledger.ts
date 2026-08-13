import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { decodeInvoice } from "../core/bolt11.ts";
import * as log from "./log.ts";
import { paymentNamedBy } from "../core/caller.ts";

import {
	withoutSecrets,
	type Delivery,
	type Payment,
	type PublicPayment,
	type Webhook,
} from "./payment.ts";
import { deliveryToWire } from "./wire.ts";

export type Claim =
	| { state: "mine" }
	| { state: "inflight" }
	| { state: "mismatch" }
	| { state: "done"; paymentId: string };

/**
 * What is left of a payment once the gateway has forgotten it: the client's own
 * ciphertext, whose key it was, and how it ended
 */
export type Kept = {
	id: string;
	caller: string | null;
	sealed: string;
	status: "paid" | "expired";
	settledAt: number | null;
};

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS meta (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS accepted (
		origin TEXT NOT NULL,
		seq INTEGER NOT NULL,
		id TEXT NOT NULL,
		payment TEXT NOT NULL,
		acceptedAt INTEGER NOT NULL,
		expiresAt INTEGER NOT NULL,
		mac TEXT NOT NULL,
		PRIMARY KEY (origin, seq)
	);
	CREATE INDEX IF NOT EXISTS accepted_by_id ON accepted (id);
	CREATE INDEX IF NOT EXISTS accepted_by_expiry ON accepted (expiresAt);

	CREATE TABLE IF NOT EXISTS schedule (
		id TEXT PRIMARY KEY,
		expiresAt INTEGER NOT NULL,
		dueAt INTEGER,
		announced INTEGER NOT NULL DEFAULT 0
	);
	CREATE INDEX IF NOT EXISTS schedule_by_expiry ON schedule (expiresAt);
	CREATE INDEX IF NOT EXISTS schedule_by_due ON schedule (dueAt);

	CREATE TABLE IF NOT EXISTS paid (
		origin TEXT NOT NULL,
		seq INTEGER NOT NULL,
		id TEXT NOT NULL,
		payment TEXT NOT NULL,
		settledAt INTEGER NOT NULL,
		mac TEXT NOT NULL,
		PRIMARY KEY (origin, seq)
	);
	CREATE INDEX IF NOT EXISTS paid_by_id ON paid (id);
	CREATE INDEX IF NOT EXISTS paid_by_age ON paid (settledAt);

	CREATE TABLE IF NOT EXISTS outbox (
		origin TEXT NOT NULL,
		seq INTEGER NOT NULL,
		id TEXT NOT NULL,
		url TEXT NOT NULL,
		body TEXT NOT NULL,
		owedAt INTEGER NOT NULL,
		mac TEXT NOT NULL,
		dueAt INTEGER,
		attempts INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (origin, seq)
	);
	CREATE INDEX IF NOT EXISTS outbox_by_due ON outbox (dueAt);
	CREATE INDEX IF NOT EXISTS outbox_by_age ON outbox (owedAt);

	CREATE TABLE IF NOT EXISTS delivered (
		origin TEXT NOT NULL,
		seq INTEGER NOT NULL,
		id TEXT NOT NULL,
		url TEXT NOT NULL,
		deliveredAt INTEGER NOT NULL,
		mac TEXT NOT NULL,
		PRIMARY KEY (origin, seq)
	);
	CREATE INDEX IF NOT EXISTS delivered_by_hook ON delivered (id, url);
	CREATE INDEX IF NOT EXISTS delivered_by_age ON delivered (deliveredAt);

	CREATE TABLE IF NOT EXISTS progress (
		source TEXT NOT NULL,
		origin TEXT NOT NULL,
		seq INTEGER NOT NULL,
		PRIMARY KEY (source, origin)
	);

	CREATE TABLE IF NOT EXISTS requests (
		key TEXT PRIMARY KEY,
		fingerprint TEXT NOT NULL,
		paymentId TEXT,
		claimedAt INTEGER NOT NULL,
		leaseUntil INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS requests_by_age ON requests (claimedAt);

	CREATE TABLE IF NOT EXISTS kept (
		id TEXT PRIMARY KEY,
		caller TEXT,
		sealed TEXT NOT NULL,
		status TEXT NOT NULL,
		settledAt INTEGER,
		keptAt INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS kept_by_age ON kept (keptAt);
`;

const SCHEMA_VERSION = 3;

const RETRY_FLOOR_SECS = 3600;
const TAKEOVER_SPREAD = 8;
const REQUEST_TTL_SECS = 86_400;
const GAP_BATCH = 500;

export const SOURCES = ["accepted", "paid", "outbox", "delivered"] as const;

export type Source = (typeof SOURCES)[number];

export type AcceptedFact = {
	origin: string;
	seq: number;
	id: string;
	payment: string;
	acceptedAt: number;
	expiresAt: number;
	mac: string;
};

export type PaidFact = {
	origin: string;
	seq: number;
	id: string;
	payment: string;
	settledAt: number;
	mac: string;
};

export type OutboxFact = {
	origin: string;
	seq: number;
	id: string;
	url: string;
	body: string;
	owedAt: number;
	mac: string;
};

export type DeliveredFact = {
	origin: string;
	seq: number;
	id: string;
	url: string;
	deliveredAt: number;
	mac: string;
};

export type Facts = {
	accepted?: AcceptedFact[];
	paid?: PaidFact[];
	outbox?: OutboxFact[];
	delivered?: DeliveredFact[];
};

export type Taken = { payment: Payment; facts: Facts };

export type Watermarks = Record<Source, Record<string, number>>;

export type Tuning = { takeoverAfterSecs: number; deliveryBackoffSecs: number };

export type Retry = "scheduled" | "abandoned";

const COLUMNS: Record<Source, string> = {
	accepted: "origin, seq, id, payment, acceptedAt, expiresAt, mac",
	paid: "origin, seq, id, payment, settledAt, mac",
	outbox: "origin, seq, id, url, body, owedAt, mac",
	delivered: "origin, seq, id, url, deliveredAt, mac",
};

type Row = { payment: string };

type AcceptedRow = Row & { id: string };

type KeptRow = {
	id: string;
	caller: string | null;
	sealed: string;
	status: string;
	settledAt: number | null;
};

type Missing = { id: string; url: string; settledAt: number | null };

type Held = { fingerprint: string; paymentId: string | null; leaseUntil: number };

type Attempted = { attempts: number; owedAt: number };

type Statements = {
	read: StatementSync;
	all: StatementSync;
	count: StatementSync;
	countFor: StatementSync;
	paymentsByIds: StatementSync;
	listing: StatementSync;
	factCounts: Record<Source, StatementSync>;
	insertAccepted: StatementSync;
	insertSchedule: StatementSync;
	forget: StatementSync;
	claim: StatementSync;
	polled: StatementSync;
	justExpired: StatementSync;
	announce: StatementSync;
	prune: StatementSync;
	pruneAccepted: StatementSync;
	pruneSettled: StatementSync;
	unowed: StatementSync;
	settlement: StatementSync;
	recentlyPaid: StatementSync;
	insertPaid: StatementSync;
	insertOutbox: StatementSync;
	insertDelivered: StatementSync;
	dueDeliveries: StatementSync;
	attempted: StatementSync;
	undelivered: StatementSync;
	parkedDeliveries: StatementSync;
	deliveryDeadline: StatementSync;
	pruneOutbox: StatementSync;
	prunePaid: StatementSync;
	pruneDelivered: StatementSync;
	heldRequest: StatementSync;
	claimRequest: StatementSync;
	fulfillRequest: StatementSync;
	releaseRequest: StatementSync;
	pruneRequests: StatementSync;
	keepSealed: StatementSync;
	readKept: StatementSync;
	pruneKept: StatementSync;
	watermarks: StatementSync;
	watermark: StatementSync;
	advance: StatementSync;
	origins: Record<Source, StatementSync>;
	nextSeq: Record<Source, StatementSync>;
	since: Record<Source, StatementSync>;
};

export class Ledger {
	readonly origin: string;
	private readonly db: DatabaseSync;
	private readonly key: Uint8Array;
	private readonly tuning: Tuning;
	private readonly statements: Statements;

	constructor(path: string, key: Uint8Array, tuning: Tuning) {
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.migrate();
		this.key = key;
		this.tuning = tuning;

		this.db
			.prepare("INSERT INTO meta (key, value) VALUES ('origin', ?) ON CONFLICT(key) DO NOTHING")
			.run(randomBytes(16).toString("hex"));
		this.origin = (
			this.db.prepare("SELECT value FROM meta WHERE key = 'origin'").get() as { value: string }
		).value;
		this.resignUnderTheKeyWeHold();

		this.statements = {
			read: this.db.prepare("SELECT id, payment FROM accepted WHERE id = ? ORDER BY origin, seq"),
			all: this.db.prepare(
				"SELECT accepted.id AS id, accepted.payment AS payment FROM accepted JOIN schedule ON schedule.id = accepted.id ORDER BY accepted.id, accepted.origin, accepted.seq",
			),
			count: this.db.prepare("SELECT count(*) AS rows FROM schedule"),
			countFor: this.db.prepare(`
				SELECT count(DISTINCT accepted.id) AS rows
				FROM accepted
				JOIN schedule ON schedule.id = accepted.id
				WHERE json_extract(accepted.payment, '$.caller') IS ?
			`),
			paymentsByIds: this.db.prepare(
				"SELECT id, payment FROM accepted WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id, origin, seq",
			),
			listing: this.db.prepare(
				"SELECT accepted.id AS id FROM accepted JOIN schedule ON schedule.id = accepted.id GROUP BY accepted.id ORDER BY max(accepted.acceptedAt) DESC LIMIT ?",
			),
			factCounts: bySource((source) => this.db.prepare(`SELECT count(*) AS n FROM ${source}`)),
			insertAccepted: this.db.prepare(
				"INSERT INTO accepted (origin, seq, id, payment, acceptedAt, expiresAt, mac) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(origin, seq) DO NOTHING",
			),
			insertSchedule: this.db.prepare(
				"INSERT INTO schedule (id, expiresAt, dueAt) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
			),
			forget: this.db.prepare("DELETE FROM schedule WHERE id = ?"),
			claim: this.db.prepare(
				"UPDATE schedule SET dueAt = ? WHERE id IN (SELECT id FROM schedule WHERE dueAt <= ? ORDER BY dueAt LIMIT ?) RETURNING id",
			),
			polled: this.db.prepare("UPDATE schedule SET dueAt = ? WHERE id = ?"),
			justExpired: this.db.prepare("SELECT id FROM schedule WHERE expiresAt <= ? AND announced = 0"),
			announce: this.db.prepare("UPDATE schedule SET announced = 1 WHERE expiresAt <= ?"),
			prune: this.db.prepare("DELETE FROM schedule WHERE expiresAt <= ?"),
			pruneAccepted: this.db.prepare("DELETE FROM accepted WHERE expiresAt <= ?"),
			unowed: this.db.prepare(`
				SELECT DISTINCT accepted.id AS id,
					json_extract(hook.value, '$.url') AS url,
					paid.settledAt AS settledAt
				FROM accepted
				JOIN paid ON paid.id = accepted.id
				JOIN json_each(accepted.payment, '$.webhooks') AS hook
				WHERE NOT EXISTS (
					SELECT 1 FROM outbox
					WHERE outbox.id = accepted.id AND outbox.url = json_extract(hook.value, '$.url')
				) AND NOT EXISTS (
					SELECT 1 FROM delivered
					WHERE delivered.id = accepted.id AND delivered.url = json_extract(hook.value, '$.url')
				)
			`),
			pruneSettled: this.db.prepare(
				"DELETE FROM accepted WHERE id IN (SELECT id FROM paid WHERE settledAt <= ?)",
			),
			settlement: this.db.prepare("SELECT payment FROM paid WHERE id = ? LIMIT 1"),
			recentlyPaid: this.db.prepare(
				"SELECT payment FROM paid ORDER BY settledAt DESC, seq DESC LIMIT ?",
			),
			insertPaid: this.db.prepare(
				"INSERT INTO paid (origin, seq, id, payment, settledAt, mac) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(origin, seq) DO NOTHING",
			),
			insertOutbox: this.db.prepare(
				"INSERT INTO outbox (origin, seq, id, url, body, owedAt, mac, dueAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(origin, seq) DO NOTHING",
			),
			insertDelivered: this.db.prepare(
				"INSERT INTO delivered (origin, seq, id, url, deliveredAt, mac) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(origin, seq) DO NOTHING",
			),
			dueDeliveries: this.db.prepare(
				`UPDATE outbox SET dueAt = ? WHERE rowid IN (
					SELECT rowid FROM outbox WHERE dueAt <= ?
						AND NOT EXISTS (SELECT 1 FROM delivered WHERE delivered.id = outbox.id AND delivered.url = outbox.url)
					ORDER BY dueAt LIMIT ?
				) RETURNING origin, seq, id, url, body`,
			),
			attempted: this.db.prepare(
				"SELECT attempts, owedAt FROM outbox WHERE origin = ? AND seq = ?",
			),
			undelivered: this.db.prepare(
				"UPDATE outbox SET attempts = ?, dueAt = ? WHERE origin = ? AND seq = ?",
			),
			parkedDeliveries: this.db.prepare(
				`SELECT COUNT(*) AS n FROM outbox WHERE dueAt IS NULL
					AND NOT EXISTS (SELECT 1 FROM delivered WHERE delivered.id = outbox.id AND delivered.url = outbox.url)`,
			),
			deliveryDeadline: this.db.prepare(
				"SELECT MAX(expiresAt) AS deadline FROM accepted WHERE id = ?",
			),
			pruneOutbox: this.db.prepare(
				`DELETE FROM outbox WHERE owedAt <= ? AND (dueAt IS NULL
					OR EXISTS (SELECT 1 FROM delivered WHERE delivered.id = outbox.id AND delivered.url = outbox.url))`,
			),
			prunePaid: this.db.prepare("DELETE FROM paid WHERE settledAt <= ?"),
			pruneDelivered: this.db.prepare("DELETE FROM delivered WHERE deliveredAt <= ?"),
			heldRequest: this.db.prepare(
				"SELECT fingerprint, paymentId, leaseUntil FROM requests WHERE key = ?",
			),
			claimRequest: this.db.prepare(
				`INSERT INTO requests (key, fingerprint, paymentId, claimedAt, leaseUntil) VALUES (?, ?, NULL, ?, ?)
					ON CONFLICT(key) DO UPDATE SET claimedAt = excluded.claimedAt, leaseUntil = excluded.leaseUntil`,
			),
			fulfillRequest: this.db.prepare("UPDATE requests SET paymentId = ? WHERE key = ?"),
			releaseRequest: this.db.prepare(
				"DELETE FROM requests WHERE key = ? AND paymentId IS NULL",
			),
			pruneRequests: this.db.prepare("DELETE FROM requests WHERE claimedAt <= ?"),
			keepSealed: this.db.prepare(
				`INSERT INTO kept (id, caller, sealed, status, settledAt, keptAt)
					SELECT accepted.id,
						json_extract(accepted.payment, '$.caller'),
						json_extract(accepted.payment, '$.sealed'),
						CASE WHEN paid.id IS NULL THEN 'expired' ELSE 'paid' END,
						paid.settledAt,
						?
					FROM accepted
					LEFT JOIN paid ON paid.id = accepted.id
					WHERE json_extract(accepted.payment, '$.sealed') IS NOT NULL
						AND (accepted.expiresAt <= ? OR paid.settledAt <= ?)
					ON CONFLICT(id) DO NOTHING`,
			),
			readKept: this.db.prepare(
				"SELECT id, caller, sealed, status, settledAt FROM kept WHERE id = ? LIMIT 1",
			),
			pruneKept: this.db.prepare("DELETE FROM kept WHERE keptAt <= ?"),
			watermarks: this.db.prepare("SELECT source, origin, seq FROM progress"),
			watermark: this.db.prepare("SELECT seq FROM progress WHERE source = ? AND origin = ?"),
			advance: this.db.prepare(
				"INSERT INTO progress (source, origin, seq) VALUES (?, ?, ?) ON CONFLICT(source, origin) DO UPDATE SET seq = max(seq, excluded.seq)",
			),
			origins: bySource((source) => this.db.prepare(`SELECT DISTINCT origin FROM ${source}`)),
			nextSeq: bySource((source) =>
				this.db.prepare(`
					SELECT max(
						coalesce((SELECT max(seq) FROM ${source} WHERE origin = ?), 0),
						coalesce((SELECT seq FROM progress WHERE source = '${source}' AND origin = ?), 0)
					) + 1 AS seq
				`),
			),
			since: bySource((source) =>
				this.db.prepare(
					`SELECT ${COLUMNS[source]} FROM ${source} WHERE origin = ? AND seq > ? ORDER BY seq LIMIT ?`,
				),
			),
		};

		this.retireTheWorklistWrittenBeforeAccepted();
	}

	private retireTheWorklistWrittenBeforeAccepted(): void {
		const held = this.db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending'")
			.all();
		if (held.length === 0) return;

		const orphans = this.db
			.prepare("SELECT payment, dueAt FROM pending WHERE id NOT IN (SELECT id FROM accepted)")
			.all() as (Row & { dueAt: number | null })[];

		for (const row of orphans) this.keep(revive(row), row.dueAt ?? unixNow());

		this.db.exec("DROP TABLE pending");
	}

	read(id: string): Payment | null {
		return groupById(this.statements.read.all(id) as AcceptedRow[])[0] ?? null;
	}

	count(): number {
		return (this.statements.count.get() as { rows: number }).rows;
	}

	/**
	 * How many payments this caller has waiting here. A caller who signed nothing
	 * shares one bucket with every other anonymous caller, which is the only
	 * honest way to count someone who will not say who they are
	 */
	countFor(caller: string | null): number {
		return (this.statements.countFor.get(caller) as { rows: number }).rows;
	}

	kept(id: string): Kept | null {
		const row = this.statements.readKept.get(id) as KeptRow | undefined;
		if (row === undefined) return null;

		return {
			id: row.id,
			caller: row.caller,
			sealed: row.sealed,
			status: row.status === "paid" ? "paid" : "expired",
			settledAt: row.settledAt,
		};
	}

	private paymentsFor(ids: string[]): Payment[] {
		if (ids.length === 0) return [];

		return groupById(this.statements.paymentsByIds.all(JSON.stringify(ids)) as AcceptedRow[]);
	}

	accept(payment: Payment): Taken {
		return this.keep(payment, unixNow());
	}

	private keep(payment: Payment, dueAt: number): Taken {
		return this.transact(() => {
			const held = this.read(payment.id);
			const webhooks = held ? mergedWebhooks(held.webhooks, payment.webhooks) : payment.webhooks;
			const told = { ...payment, webhooks };
			const taken = { ...(held ?? payment), webhooks };
			const fresh =
				!held || webhooks.length > held.webhooks.length ? this.acceptedFact(told) : null;
			if (fresh) this.recordAccepted(fresh);

			this.scheduleWatch(taken.id, taken.expiresAt, dueAt);

			return { payment: withStatus(taken), facts: fresh ? { accepted: [fresh] } : {} };
		});
	}

	private acceptedFact(payment: Payment): AcceptedFact {
		const record = JSON.stringify(payment);
		const now = unixNow();
		const seq = this.nextSeq("accepted");

		return {
			origin: this.origin,
			seq,
			id: payment.id,
			payment: record,
			acceptedAt: now,
			expiresAt: payment.expiresAt,
			mac: this.sign("accepted", [this.origin, seq, payment.id, record, now, payment.expiresAt]),
		};
	}

	private scheduleWatch(id: string, expiresAt: number, dueAt: number): void {
		if (this.settlement(id)) return;
		this.statements.insertSchedule.run(id, expiresAt, dueAt);
	}

	private watchAfter(id: string): number {
		const rank =
			createHash("sha256").update(`${id}\x00${this.origin}`).digest().readUInt32BE(0) %
			TAKEOVER_SPREAD;
		const after = this.tuning.takeoverAfterSecs;

		return unixNow() + after + Math.max(1, Math.round(after / TAKEOVER_SPREAD)) * rank;
	}

	forget(id: string): void {
		this.statements.forget.run(id);
	}

	claim(limit: number, leaseSecs: number): Payment[] {
		const now = unixNow();
		const due = this.statements.claim.all(now + leaseSecs, now, limit) as { id: string }[];

		return this.paymentsFor(due.map((one) => one.id));
	}

	polled(id: string, dueAt: number | null): void {
		this.statements.polled.run(dueAt, id);
	}

	settlement(id: string): PublicPayment | null {
		const row = this.statements.settlement.get(id) as Row | undefined;
		return row ? (JSON.parse(row.payment) as PublicPayment) : null;
	}

	replay(trigger: string, limit: number, window: number): PublicPayment[] {
		const matched: PublicPayment[] = [];
		for (const settled of this.recentlySettled(window)) {
			if (settled.trigger !== trigger) continue;

			matched.push(settled);
			if (matched.length === limit) break;
		}

		return matched.reverse();
	}

	list(limit: number, window: number): PublicPayment[] {
		const listed = (this.statements.listing.all(limit) as { id: string }[]).map((one) => one.id);
		const waiting = this.paymentsFor(listed).map(withoutSecrets);
		const newestFirst = [...waiting, ...this.recentlySettled(window)].sort(
			(one, other) => other.createdAt - one.createdAt,
		);

		return newestFirst.slice(0, limit);
	}

	private recentlySettled(window: number): PublicPayment[] {
		const rows = this.statements.recentlyPaid.all(window) as Row[];
		return rows.map((row) => JSON.parse(row.payment) as PublicPayment);
	}

	settle(pending: Payment, preimage: string): { settled: PublicPayment; facts: Facts } {
		proves(preimage, pending.paymentHash);
		const settled: Payment = { ...pending, status: "paid", preimage };
		const record = JSON.stringify(withoutSecrets(settled));
		const now = unixNow();
		const body = JSON.stringify(deliveryToWire(settled, now));

		return this.transact(() => {
			const seq = this.nextSeq("paid");
			const paid = {
				origin: this.origin,
				seq,
				id: settled.id,
				payment: record,
				settledAt: now,
				mac: this.sign("paid", [this.origin, seq, settled.id, record, now]),
			};
			this.recordPaid(paid);

			const outbox = pending.webhooks.map((hook) => {
				const fact = this.owedFact(settled.id, hook, body, now);
				this.recordOutbox(fact, 0);
				return fact;
			});

			this.forget(settled.id);

			return {
				settled: withoutSecrets(settled),
				facts: { paid: [paid], outbox },
			};
		});
	}

	dueDeliveries(limit: number, leaseSecs: number): Delivery[] {
		const now = unixNow();
		return this.statements.dueDeliveries.all(now + leaseSecs, now, limit) as Delivery[];
	}

	delivered(owed: Delivery): Facts {
		const now = unixNow();
		return this.transact(() => {
			const seq = this.nextSeq("delivered");
			const fact = {
				origin: this.origin,
				seq,
				id: owed.id,
				url: owed.url,
				deliveredAt: now,
				mac: this.sign("delivered", [this.origin, seq, owed.id, owed.url, now]),
			};
			this.recordDelivered(fact);

			return { delivered: [fact] };
		});
	}

	undelivered(owed: Delivery): Retry {
		const tried = this.statements.attempted.get(owed.origin, owed.seq) as Attempted | undefined;
		if (!tried) return "abandoned";

		const attempts = tried.attempts + 1;
		const nextAt = unixNow() + this.tuning.deliveryBackoffSecs * attempts;
		const abandoned = nextAt > this.retryUntil(owed.id, tried.owedAt);
		this.statements.undelivered.run(attempts, abandoned ? null : nextAt, owed.origin, owed.seq);

		return abandoned ? "abandoned" : "scheduled";
	}

	parkedDeliveries(): number {
		return (this.statements.parkedDeliveries.get() as { n: number }).n;
	}

	private retryUntil(id: string, owedAt: number): number {
		const found = this.statements.deliveryDeadline.get(id) as { deadline: number | null };

		return Math.max(owedAt + RETRY_FLOOR_SECS, found.deadline ?? 0);
	}

	claimKey(key: string, fingerprint: string, leaseSecs: number): Claim {
		const now = unixNow();
		return this.transact<Claim>(() => {
			const held = this.statements.heldRequest.get(key) as Held | undefined;
			if (held) {
				if (held.fingerprint !== fingerprint) return { state: "mismatch" };
				if (held.paymentId) return { state: "done", paymentId: held.paymentId };
				if (held.leaseUntil > now) return { state: "inflight" };
			}
			this.statements.claimRequest.run(key, fingerprint, now, now + leaseSecs);

			return { state: "mine" };
		});
	}

	fulfillKey(key: string, paymentId: string): void {
		this.statements.fulfillRequest.run(paymentId, key);
	}

	releaseKey(key: string): void {
		this.statements.releaseRequest.run(key);
	}

	factCounts(): Record<Source, number> {
		return bySource((source) => (this.statements.factCounts[source].get() as { n: number }).n);
	}

	watermarks(): Watermarks {
		const marks = bySource<Record<string, number>>(() => ({}));
		for (const row of this.statements.watermarks.all() as {
			source: Source;
			origin: string;
			seq: number;
		}[]) {
			const known = marks[row.source];
			if (known) known[row.origin] = row.seq;
		}
		return marks;
	}

	since(theirs: Watermarks): { facts: Facts; more: boolean } {
		let more = false;
		const gap = <T>(source: Source): T[] => {
			const rows: T[] = [];
			for (const { origin } of this.statements.origins[source].all() as { origin: string }[]) {
				const batch = this.statements.since[source].all(
					origin,
					theirs[source]?.[origin] ?? 0,
					GAP_BATCH,
				) as T[];
				if (batch.length === GAP_BATCH) more = true;
				rows.push(...batch);
			}
			return rows;
		};

		return {
			facts: {
				accepted: gap<AcceptedFact>("accepted"),
				paid: gap<PaidFact>("paid"),
				outbox: gap<OutboxFact>("outbox"),
				delivered: gap<DeliveredFact>("delivered"),
			},
			more,
		};
	}

	absorb(facts: Facts): PublicPayment[] {
		return this.transact(() => {
			const settled: PublicPayment[] = [];

			for (const fact of inSeqOrder(facts.accepted ?? [])) {
				if (this.known("accepted", fact)) continue;
				this.provenAccepted(fact);
				this.recordAccepted(fact);
				this.scheduleWatch(fact.id, fact.expiresAt, this.watchAfter(fact.id));
			}

			for (const fact of inSeqOrder(facts.paid ?? [])) {
				if (this.known("paid", fact)) continue;
				const payment = this.provenPaid(fact);
				this.recordPaid(fact);
				this.forget(fact.id);
				settled.push(payment);
			}

			for (const fact of inSeqOrder(facts.outbox ?? [])) {
				if (this.known("outbox", fact)) continue;
				this.verify(
					"outbox",
					[fact.origin, fact.seq, fact.id, fact.url, fact.body, fact.owedAt],
					fact.mac,
				);
				this.recordOutbox(fact, this.takeoverAt(fact));
			}

			for (const fact of inSeqOrder(facts.delivered ?? [])) {
				if (this.known("delivered", fact)) continue;
				this.verify(
					"delivered",
					[fact.origin, fact.seq, fact.id, fact.url, fact.deliveredAt],
					fact.mac,
				);
				this.recordDelivered(fact);
			}

			return settled;
		});
	}

	/**
	 * A sealed blob outlives the payment it belonged to, for as long as the
	 * instance was told to keep it. Everything the gateway could read goes at the
	 * grace, and what stays is ciphertext, its owner and when it settled, so a
	 * client can read its own history back from any gateway that watched it
	 */
	sweep(graceSecs: number, keepSealedSecs: number): Payment[] {
		const now = unixNow();
		const expired = this.paymentsFor(
			(this.statements.justExpired.all(now) as { id: string }[]).map((one) => one.id),
		);
		this.statements.announce.run(now);
		this.statements.keepSealed.run(now, now - graceSecs, now - graceSecs);
		this.statements.pruneKept.run(now - keepSealedSecs);
		this.statements.prune.run(now - graceSecs);
		this.statements.pruneAccepted.run(now - graceSecs);
		this.statements.pruneSettled.run(now - graceSecs);
		this.statements.pruneOutbox.run(now - graceSecs);
		this.statements.prunePaid.run(now - graceSecs);
		this.statements.pruneDelivered.run(now - graceSecs);
		this.statements.pruneRequests.run(now - REQUEST_TTL_SECS);

		for (const missing of this.statements.unowed.all() as Missing[]) this.owe(missing);

		return expired;
	}

	private owe(missing: Missing): void {
		const settled = this.settlement(missing.id);
		if (!settled) return;

		const owedAt = unixNow();
		const body = JSON.stringify(deliveryToWire(settled, missing.settledAt ?? owedAt));
		this.recordOutbox(this.owedFact(missing.id, missing, body, owedAt), 0);
	}

	private owedFact(id: string, hook: Webhook, body: string, owedAt: number): OutboxFact {
		const seq = this.nextSeq("outbox");

		return {
			origin: this.origin,
			seq,
			id,
			url: hook.url,
			body,
			owedAt,
			mac: this.sign("outbox", [this.origin, seq, id, hook.url, body, owedAt]),
		};
	}

	close(): void {
		if (this.db.isOpen) this.db.close();
	}

	/**
	 * A rotation is a rotation. The ledger remembers which key signed it, by a
	 * fingerprint that proves the key without holding it, and a boot under a new key
	 * re-signs every fact in one transaction. Nothing keeps the old value working
	 * afterwards, which is the whole difference between rotating a key and merely
	 * adding one.
	 *
	 * The pass is bounded by what a ledger keeps, which is an hour past settlement
	 * plus the window for sealed blobs, so it is not a migration of history
	 */
	private resignUnderTheKeyWeHold(): void {
		const held = createHmac("sha256", this.key).update("ledger-key").digest("hex");
		const written = this.db.prepare("SELECT value FROM meta WHERE key = 'ledger-key'").get() as
			| { value: string }
			| undefined;
		if (written?.value === held) return;

		this.transact(() => {
			if (written !== undefined) this.resignEveryFact();
			this.db
				.prepare(
					"INSERT INTO meta (key, value) VALUES ('ledger-key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				)
				.run(held);
		});
	}

	private resignEveryFact(): void {
		let resigned = 0;
		for (const source of SOURCES) {
			const columns = COLUMNS[source].split(", ");
			const rows = this.db.prepare(`SELECT ${COLUMNS[source]} FROM ${source}`).all() as Record<
				string,
				string | number | null
			>[];

			for (const row of rows) {
				const fields = columns
					.filter((column) => column !== "mac")
					.map((column) => row[column] ?? null);
				this.db
					.prepare(`UPDATE ${source} SET mac = ? WHERE origin = ? AND seq = ?`)
					.run(macWith(this.key, source, fields), String(row["origin"]), Number(row["seq"]));
				resigned += 1;
			}
		}
		if (resigned > 0) log.info(`re-signed ${resigned} facts under the cluster key now held`);
	}

	private migrate(): void {
		const found = this.schemaVersion();
		if (found > SCHEMA_VERSION) {
			throw new Error(
				`this ledger is at schema ${found} and this build knows ${SCHEMA_VERSION}, so a newer build wrote it`,
			);
		}

		this.dropOutdatedRequestCache();
		this.db.exec(SCHEMA);
		if (found !== SCHEMA_VERSION) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	}

	private schemaVersion(): number {
		return (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
	}

	private dropOutdatedRequestCache(): void {
		const columns = this.db.prepare("PRAGMA table_info(requests)").all() as { name: string }[];
		if (columns.length > 0 && !columns.some((column) => column.name === "fingerprint")) {
			this.db.exec("DROP TABLE requests");
		}
	}

	private transact<T>(work: () => T): T {
		this.db.exec("BEGIN");
		try {
			const result = work();
			this.db.exec("COMMIT");
			return result;
		} catch (error: unknown) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private nextSeq(source: Source): number {
		const held = this.statements.nextSeq[source].get(this.origin, this.origin);

		return (held as { seq: number }).seq;
	}

	private recordAccepted(fact: AcceptedFact): void {
		this.statements.insertAccepted.run(
			fact.origin,
			fact.seq,
			fact.id,
			fact.payment,
			fact.acceptedAt,
			fact.expiresAt,
			fact.mac,
		);
		this.advance("accepted", fact);
	}

	private recordPaid(fact: PaidFact): void {
		this.statements.insertPaid.run(
			fact.origin,
			fact.seq,
			fact.id,
			fact.payment,
			fact.settledAt,
			fact.mac,
		);
		this.advance("paid", fact);
	}

	private recordOutbox(fact: OutboxFact, dueAt: number): void {
		this.statements.insertOutbox.run(
			fact.origin,
			fact.seq,
			fact.id,
			fact.url,
			fact.body,
			fact.owedAt,
			fact.mac,
			dueAt,
		);
		this.advance("outbox", fact);
	}

	private recordDelivered(fact: DeliveredFact): void {
		this.statements.insertDelivered.run(
			fact.origin,
			fact.seq,
			fact.id,
			fact.url,
			fact.deliveredAt,
			fact.mac,
		);
		this.advance("delivered", fact);
	}

	private advance(source: Source, fact: { origin: string; seq: number }): void {
		this.statements.advance.run(source, fact.origin, fact.seq);
	}

	private known(source: Source, fact: { origin: string; seq: number }): boolean {
		const row = this.statements.watermark.get(source, fact.origin) as { seq: number } | undefined;
		return fact.seq <= (row?.seq ?? 0);
	}

	private sign(source: Source, fields: (string | number | null)[]): string {
		return macWith(this.key, source, fields);
	}

	private verify(source: Source, fields: (string | number | null)[], mac: string): void {
		const got = Buffer.from(mac, "hex");
		const want = Buffer.from(macWith(this.key, source, fields), "hex");
		const holds = want.length === got.length && timingSafeEqual(want, got);
		if (!holds) throw new Error(`a ${source} fact arrived without the cluster key`);
	}

	/**
	 * A fact has to be named after what it settles. A payment its caller signed for
	 * is named after that caller, which any instance can check without holding
	 * anything of theirs, and one nobody signed for is named by a key this cluster
	 * holds
	 */
	private namesItsOwnHash(id: string, payment: { caller: string | null; paymentHash: string }): boolean {
		if (payment.caller !== null) return id === paymentNamedBy(payment.caller, payment.paymentHash);

		return id === paymentId(this.key, payment.paymentHash);
	}

	private provenAccepted(fact: AcceptedFact): void {
		this.verify(
			"accepted",
			[fact.origin, fact.seq, fact.id, fact.payment, fact.acceptedAt, fact.expiresAt],
			fact.mac,
		);

		const payment = JSON.parse(fact.payment) as Payment;
		if (payment.id !== fact.id || !this.namesItsOwnHash(fact.id, payment)) {
			throw new Error(`accepted fact ${fact.id} does not name the invoice it watches`);
		}
		if (payment.expiresAt !== fact.expiresAt) {
			throw new Error(`accepted fact ${fact.id} disagrees with itself about when it expires`);
		}
		const carried = payment.bolt11 === null ? null : decodeInvoice(payment.bolt11).paymentHash;
		if (carried !== null && carried !== payment.paymentHash) {
			throw new Error(`accepted fact ${fact.id} carries an invoice for another payment hash`);
		}
	}

	private provenPaid(fact: PaidFact): PublicPayment {
		this.verify("paid", [fact.origin, fact.seq, fact.id, fact.payment, fact.settledAt], fact.mac);

		const payment = JSON.parse(fact.payment) as PublicPayment;
		if (payment.id !== fact.id || !this.namesItsOwnHash(fact.id, payment)) {
			throw new Error(`paid fact ${fact.id} does not name the invoice it settles`);
		}
		proves(payment.preimage, payment.paymentHash);

		return payment;
	}

	private takeoverAt(fact: OutboxFact): number {
		const rank =
			createHash("sha256")
				.update(`${fact.id}\x00${fact.url}\x00${this.origin}`)
				.digest()
				.readUInt32BE(0) % TAKEOVER_SPREAD;
		const after = this.tuning.takeoverAfterSecs;

		return fact.owedAt + after + Math.max(1, Math.round(after / TAKEOVER_SPREAD)) * rank;
	}
}

export function paymentId(key: Uint8Array, paymentHash: string): string {
	return createHmac("sha256", key).update("payment-id").update(paymentHash).digest("hex");
}

function macWith(key: Uint8Array, source: Source, fields: (string | number | null)[]): string {
	const hmac = createHmac("sha256", key).update(source);
	for (const field of fields) hmac.update("\x00").update(field === null ? "\x01" : String(field));

	return hmac.digest("hex");
}

function bySource<T>(build: (source: Source) => T): Record<Source, T> {
	return Object.fromEntries(SOURCES.map((source) => [source, build(source)])) as Record<Source, T>;
}

function inSeqOrder<T extends { origin: string; seq: number }>(facts: T[]): T[] {
	return [...facts].sort((one, other) =>
		one.origin === other.origin ? one.seq - other.seq : one.origin < other.origin ? -1 : 1,
	);
}

function proves(preimage: string | null, paymentHash: string): void {
	const hashed = createHash("sha256")
		.update(Buffer.from(preimage ?? "", "hex"))
		.digest("hex");
	if (hashed !== paymentHash) {
		throw new Error(`the preimage for ${paymentHash} does not hash to it`);
	}
}

function groupById(rows: AcceptedRow[]): Payment[] {
	const held = new Map<string, Payment[]>();
	for (const row of rows) held.set(row.id, [...(held.get(row.id) ?? []), revive(row)]);

	return [...held.values()].map(oneFromEvery);
}

function oneFromEvery(accepted: Payment[]): Payment {
	return accepted.reduce((one, other) => ({
		...one,
		webhooks: mergedWebhooks(one.webhooks, other.webhooks),
	}));
}

function mergedWebhooks(known: Webhook[], added: Webhook[]): Webhook[] {
	const fresh = added.filter((hook) => !known.some((have) => have.url === hook.url));

	return [...known, ...fresh];
}

function revive(row: Row): Payment {
	return withStatus(JSON.parse(row.payment) as Payment);
}

function withStatus(payment: Payment): Payment {
	return { ...payment, status: unixNow() >= payment.expiresAt ? "expired" : "pending" };
}

function unixNow(): number {
	return Math.floor(Date.now() / 1000);
}
