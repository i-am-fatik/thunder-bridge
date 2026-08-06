import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { decodeInvoice } from "../core/bolt11.ts";

import {
	withoutSecrets,
	type Delivery,
	type Payment,
	type PublicPayment,
	type Webhook,
} from "./payment.ts";
import { paymentToWire } from "./wire.ts";

export type Claim =
	| { state: "mine" }
	| { state: "inflight" }
	| { state: "mismatch" }
	| { state: "done"; paymentId: string };

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS meta (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS pending (
		id TEXT PRIMARY KEY,
		expiresAt INTEGER NOT NULL,
		dueAt INTEGER,
		announced INTEGER NOT NULL DEFAULT 0,
		payment TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS pending_by_expiry ON pending (expiresAt);
	CREATE INDEX IF NOT EXISTS pending_by_due ON pending (dueAt);

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
		secret TEXT,
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
`;

const SCHEMA_VERSION = 1;

const DELIVERY_ATTEMPTS = 6;
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
	secret: string | null;
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

const COLUMNS: Record<Source, string> = {
	accepted: "origin, seq, id, payment, acceptedAt, expiresAt, mac",
	paid: "origin, seq, id, payment, settledAt, mac",
	outbox: "origin, seq, id, url, secret, body, owedAt, mac",
	delivered: "origin, seq, id, url, deliveredAt, mac",
};

type Row = { payment: string };

type Held = { fingerprint: string; paymentId: string | null; leaseUntil: number };

type Statements = {
	read: StatementSync;
	all: StatementSync;
	count: StatementSync;
	paymentsByIds: StatementSync;
	listing: StatementSync;
	rows: Record<Source, StatementSync>;
	insertAccepted: StatementSync;
	schedule: StatementSync;
	remember: StatementSync;
	forget: StatementSync;
	forgetForRollback: StatementSync;
	claim: StatementSync;
	polled: StatementSync;
	justExpired: StatementSync;
	announce: StatementSync;
	prune: StatementSync;
	pruneForRollback: StatementSync;
	pruneAccepted: StatementSync;
	pruneSettled: StatementSync;
	settlement: StatementSync;
	recentlyPaid: StatementSync;
	insertPaid: StatementSync;
	insertOutbox: StatementSync;
	insertDelivered: StatementSync;
	dueDeliveries: StatementSync;
	undelivered: StatementSync;
	pruneOutbox: StatementSync;
	prunePaid: StatementSync;
	pruneDelivered: StatementSync;
	heldRequest: StatementSync;
	claimRequest: StatementSync;
	fulfillRequest: StatementSync;
	releaseRequest: StatementSync;
	pruneRequests: StatementSync;
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

		this.statements = {
			read: this.db.prepare("SELECT payment FROM accepted WHERE id = ? ORDER BY origin, seq"),
			all: this.db.prepare(
				"SELECT accepted.id AS id, accepted.payment AS payment FROM accepted JOIN schedule ON schedule.id = accepted.id ORDER BY accepted.id, accepted.origin, accepted.seq",
			),
			count: this.db.prepare("SELECT count(*) AS rows FROM schedule"),
			paymentsByIds: this.db.prepare(
				"SELECT id, payment FROM accepted WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id, origin, seq",
			),
			listing: this.db.prepare(
				"SELECT payment FROM accepted WHERE id IN (SELECT id FROM schedule) GROUP BY id ORDER BY acceptedAt DESC LIMIT ?",
			),
			rows: bySource((source) => this.db.prepare(`SELECT count(*) AS rows FROM ${source}`)),
			insertAccepted: this.db.prepare(
				"INSERT INTO accepted (origin, seq, id, payment, acceptedAt, expiresAt, mac) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(origin, seq) DO NOTHING",
			),
			schedule: this.db.prepare(
				"INSERT INTO schedule (id, expiresAt, dueAt) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
			),
			remember: this.db.prepare(
				"INSERT INTO pending (id, expiresAt, dueAt, payment) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payment = excluded.payment",
			),
			forget: this.db.prepare("DELETE FROM schedule WHERE id = ?"),
			forgetForRollback: this.db.prepare("DELETE FROM pending WHERE id = ?"),
			claim: this.db.prepare(
				"UPDATE schedule SET dueAt = ? WHERE id IN (SELECT id FROM schedule WHERE dueAt <= ? ORDER BY dueAt LIMIT ?) RETURNING id",
			),
			polled: this.db.prepare("UPDATE schedule SET dueAt = ? WHERE id = ?"),
			justExpired: this.db.prepare("SELECT id FROM schedule WHERE expiresAt <= ? AND announced = 0"),
			announce: this.db.prepare("UPDATE schedule SET announced = 1 WHERE expiresAt <= ?"),
			prune: this.db.prepare("DELETE FROM schedule WHERE expiresAt <= ?"),
			pruneForRollback: this.db.prepare("DELETE FROM pending WHERE expiresAt <= ?"),
			pruneAccepted: this.db.prepare("DELETE FROM accepted WHERE expiresAt <= ?"),
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
				"INSERT INTO outbox (origin, seq, id, url, secret, body, owedAt, mac, dueAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(origin, seq) DO NOTHING",
			),
			insertDelivered: this.db.prepare(
				"INSERT INTO delivered (origin, seq, id, url, deliveredAt, mac) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(origin, seq) DO NOTHING",
			),
			dueDeliveries: this.db.prepare(
				`UPDATE outbox SET dueAt = ? WHERE rowid IN (
					SELECT rowid FROM outbox WHERE dueAt <= ?
						AND NOT EXISTS (SELECT 1 FROM delivered WHERE delivered.id = outbox.id AND delivered.url = outbox.url)
					ORDER BY dueAt LIMIT ?
				) RETURNING origin, seq, id, url, secret, body`,
			),
			undelivered: this.db.prepare(
				"UPDATE outbox SET attempts = attempts + 1, dueAt = CASE WHEN attempts + 1 >= ? THEN NULL ELSE ? + ? * (attempts + 1) END WHERE origin = ? AND seq = ?",
			),
			pruneOutbox: this.db.prepare("DELETE FROM outbox WHERE owedAt <= ?"),
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
			watermarks: this.db.prepare("SELECT source, origin, seq FROM progress"),
			watermark: this.db.prepare("SELECT seq FROM progress WHERE source = ? AND origin = ?"),
			advance: this.db.prepare(
				"INSERT INTO progress (source, origin, seq) VALUES (?, ?, ?) ON CONFLICT(source, origin) DO UPDATE SET seq = max(seq, excluded.seq)",
			),
			origins: bySource((source) => this.db.prepare(`SELECT DISTINCT origin FROM ${source}`)),
			nextSeq: bySource((source) =>
				this.db.prepare(`SELECT coalesce(max(seq), 0) + 1 AS seq FROM ${source} WHERE origin = ?`),
			),
			since: bySource((source) =>
				this.db.prepare(
					`SELECT ${COLUMNS[source]} FROM ${source} WHERE origin = ? AND seq > ? ORDER BY seq LIMIT ?`,
				),
			),
		};

		this.adoptWorklistWrittenBeforeAccepted();
	}

	private adoptWorklistWrittenBeforeAccepted(): void {
		const orphans = this.db
			.prepare("SELECT payment, dueAt FROM pending WHERE id NOT IN (SELECT id FROM accepted)")
			.all() as (Row & { dueAt: number | null })[];

		for (const row of orphans) this.keep(revive(row), row.dueAt ?? unixNow());
	}

	read(id: string): Payment | null {
		const rows = (this.statements.read.all(id) as Row[]).map(revive);

		return rows.length === 0 ? null : withStatus(oneFromEvery(rows));
	}

	all(): Payment[] {
		return groupById(this.statements.all.all() as (Row & { id: string })[]);
	}

	rows(): Record<Source, number> {
		return bySource(
			(source) => (this.statements.rows[source].get() as { rows: number }).rows,
		);
	}

	private paymentsFor(ids: string[]): Payment[] {
		if (ids.length === 0) return [];

		return groupById(this.statements.paymentsByIds.all(JSON.stringify(ids)) as (Row & {
			id: string;
		})[]);
	}

	count(): number {
		return (this.statements.count.get() as { rows: number }).rows;
	}

	accept(payment: Payment): Taken {
		return this.keep(payment, unixNow());
	}

	mirror(payment: Payment): Taken {
		return this.keep(payment, this.watchAfter(payment.id));
	}

	private keep(payment: Payment, dueAt: number): Taken {
		return this.transact(() => {
			const held = this.read(payment.id);
			const webhooks = held ? mergedWebhooks(held.webhooks, payment.webhooks) : payment.webhooks;
			const fresh =
				!held || webhooks.length > held.webhooks.length
					? this.acceptedFact({ ...payment, webhooks })
					: null;
			if (fresh) this.recordAccepted(fresh);

			this.scheduleWatch(payment.id, payment.expiresAt, dueAt);
			this.statements.remember.run(payment.id, payment.expiresAt, dueAt, JSON.stringify(payment));

			return {
				payment: withStatus({ ...(held ?? payment), webhooks }),
				facts: fresh ? { accepted: [fresh] } : {},
			};
		});
	}

	private acceptedFact(payment: Payment): AcceptedFact {
		const record = JSON.stringify(payment);
		const now = unixNow();

		return this.mine("accepted", (seq) => ({
			origin: this.origin,
			seq,
			id: payment.id,
			payment: record,
			acceptedAt: now,
			expiresAt: payment.expiresAt,
			mac: this.sign("accepted", [
				this.origin,
				seq,
				payment.id,
				record,
				now,
				payment.expiresAt,
			]),
		}));
	}

	private scheduleWatch(id: string, expiresAt: number, dueAt: number): void {
		if (this.settlement(id)) return;
		this.statements.schedule.run(id, expiresAt, dueAt);
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
		this.statements.forgetForRollback.run(id);
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
		const waiting = (this.statements.listing.all(limit) as Row[])
			.map(revive)
			.map(withStatus)
			.map(withoutSecrets);
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
		const body = JSON.stringify(paymentToWire(settled));
		const now = unixNow();

		return this.transact(() => {
			const paid = this.mine("paid", (seq) => ({
				origin: this.origin,
				seq,
				id: settled.id,
				payment: record,
				settledAt: now,
				mac: this.sign("paid", [this.origin, seq, settled.id, record, now]),
			}));
			this.recordPaid(paid);

			const outbox = pending.webhooks.map((hook) => {
				const fact = this.mine("outbox", (seq) => ({
					origin: this.origin,
					seq,
					id: settled.id,
					url: hook.url,
					secret: hook.secret,
					body,
					owedAt: now,
					mac: this.sign("outbox", [
						this.origin,
						seq,
						settled.id,
						hook.url,
						hook.secret,
						body,
						now,
					]),
				}));
				this.recordOutbox(fact, 0);
				return fact;
			});

			this.forget(settled.id);

			return {
				settled: withoutSecrets(settled),
				facts: { paid: [paid], outbox, delivered: [] },
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
			const fact = this.mine("delivered", (seq) => ({
				origin: this.origin,
				seq,
				id: owed.id,
				url: owed.url,
				deliveredAt: now,
				mac: this.sign("delivered", [this.origin, seq, owed.id, owed.url, now]),
			}));
			this.recordDelivered(fact);

			return { paid: [], outbox: [], delivered: [fact] };
		});
	}

	undelivered(owed: Delivery): void {
		this.statements.undelivered.run(
			DELIVERY_ATTEMPTS,
			unixNow(),
			this.tuning.deliveryBackoffSecs,
			owed.origin,
			owed.seq,
		);
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
					[fact.origin, fact.seq, fact.id, fact.url, fact.secret, fact.body, fact.owedAt],
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

	sweep(graceSecs: number): Payment[] {
		const now = unixNow();
		const expired = this.paymentsFor(
			(this.statements.justExpired.all(now) as { id: string }[]).map((one) => one.id),
		);
		this.statements.announce.run(now);
		this.statements.prune.run(now - graceSecs);
		this.statements.pruneForRollback.run(now - graceSecs);
		this.statements.pruneAccepted.run(now - graceSecs);
		this.statements.pruneSettled.run(now - graceSecs);
		this.statements.pruneOutbox.run(now - graceSecs);
		this.statements.prunePaid.run(now - graceSecs);
		this.statements.pruneDelivered.run(now - graceSecs);
		this.statements.pruneRequests.run(now - REQUEST_TTL_SECS);

		return expired;
	}

	close(): void {
		if (this.db.isOpen) this.db.close();
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

	private mine<T>(source: Source, build: (seq: number) => T): T {
		const { seq } = this.statements.nextSeq[source].get(this.origin) as { seq: number };
		return build(seq);
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
			fact.secret,
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
		const hmac = createHmac("sha256", this.key).update(source);
		for (const field of fields) hmac.update("\x00").update(field === null ? "\x01" : String(field));
		return hmac.digest("hex");
	}

	private verify(source: Source, fields: (string | number | null)[], mac: string): void {
		const want = Buffer.from(this.sign(source, fields), "hex");
		const got = Buffer.from(mac, "hex");
		if (want.length !== got.length || !timingSafeEqual(want, got)) {
			throw new Error(`a ${source} fact arrived without the cluster key`);
		}
	}

	private provenAccepted(fact: AcceptedFact): Payment {
		this.verify(
			"accepted",
			[fact.origin, fact.seq, fact.id, fact.payment, fact.acceptedAt, fact.expiresAt],
			fact.mac,
		);

		const payment = JSON.parse(fact.payment) as Payment;
		if (payment.id !== fact.id || fact.id !== paymentId(this.key, payment.paymentHash)) {
			throw new Error(`accepted fact ${fact.id} does not name the invoice it watches`);
		}
		if (payment.expiresAt !== fact.expiresAt) {
			throw new Error(`accepted fact ${fact.id} disagrees with itself about when it expires`);
		}
		const carried = payment.bolt11 === null ? null : decodeInvoice(payment.bolt11).paymentHash;
		if (carried !== null && carried !== payment.paymentHash) {
			throw new Error(`accepted fact ${fact.id} carries an invoice for another payment hash`);
		}

		return payment;
	}

	private provenPaid(fact: PaidFact): PublicPayment {
		this.verify("paid", [fact.origin, fact.seq, fact.id, fact.payment, fact.settledAt], fact.mac);

		const payment = JSON.parse(fact.payment) as PublicPayment;
		if (payment.id !== fact.id || fact.id !== paymentId(this.key, payment.paymentHash)) {
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

function groupById(rows: (Row & { id: string })[]): Payment[] {
	const held = new Map<string, Payment[]>();
	for (const row of rows) held.set(row.id, [...(held.get(row.id) ?? []), revive(row)]);

	return [...held.values()].map((accepted) => withStatus(oneFromEvery(accepted)));
}

function oneFromEvery(accepted: Payment[]): Payment {
	return accepted.reduce((one, other) => ({
		...one,
		webhooks: mergedWebhooks(one.webhooks, other.webhooks),
	}));
}

function mergedWebhooks(known: Webhook[], added: Webhook[]): Webhook[] {
	const fresh = added.filter(
		(hook) => !known.some((have) => have.url === hook.url && have.secret === hook.secret),
	);

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
