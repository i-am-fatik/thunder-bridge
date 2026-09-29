import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";

import { decodeInvoice } from "../core/bolt11.ts";
import { paymentNamedBy } from "../core/caller.ts";
import * as log from "./log.ts";

import {
	type Delivery,
	type Payment,
	type PublicPayment,
	type Webhook,
	withoutSecrets,
} from "./payment.ts";
import { openLedgerFile } from "./schema.ts";
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

const RETRY_FLOOR_SECS = 3600;
const UNOWED_SLACK_SECS = 60;
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

export type Tuning = { takeoverAfterSecs?: number; deliveryBackoffSecs?: number };

export type Retry = "scheduled" | "abandoned";

type Fields = Record<string, string | number | null>;

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

type Attempted = { attempts: number; owedAt: number; retryUntil: number | null };

export class Ledger {
	readonly origin: string;
	private readonly db: DatabaseSync;
	private readonly key: Uint8Array;
	private readonly takeoverAfterSecs: number;
	private readonly deliveryBackoffSecs: number;
	private readonly prepared = new Map<string, StatementSync>();

	constructor(
		path: string,
		key: Uint8Array,
		{ takeoverAfterSecs = 600, deliveryBackoffSecs = 30 }: Tuning = {},
	) {
		this.db = openLedgerFile(path);
		this.key = key;
		this.takeoverAfterSecs = takeoverAfterSecs;
		this.deliveryBackoffSecs = deliveryBackoffSecs;

		this.db
			.prepare("INSERT INTO meta (key, value) VALUES ('origin', ?) ON CONFLICT(key) DO NOTHING")
			.run(randomBytes(16).toString("hex"));
		this.origin = (
			this.db.prepare("SELECT value FROM meta WHERE key = 'origin'").get() as { value: string }
		).value;
		this.resignUnderTheKeyWeHold();
		this.retireTheWorklistWrittenBeforeAccepted();
	}

	private retireTheWorklistWrittenBeforeAccepted(): void {
		const held = this.db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending'")
			.all();
		if (held.length === 0) {
			return;
		}

		const orphans = this.db
			.prepare("SELECT payment, dueAt FROM pending WHERE id NOT IN (SELECT id FROM accepted)")
			.all() as (Row & { dueAt: number | null })[];

		for (const row of orphans) {
			this.accept(revive(row), row.dueAt ?? unixNow());
		}

		this.db.exec("DROP TABLE pending");
	}

	read(id: string): Payment | null {
		return (
			groupById(
				this.sql("SELECT id, payment FROM accepted WHERE id = ? ORDER BY origin, seq").all(
					id,
				) as AcceptedRow[],
			)[0] ?? null
		);
	}

	count(): number {
		return (this.sql("SELECT count(*) AS rows FROM schedule").get() as { rows: number }).rows;
	}

	/**
	 * How many payments this caller has waiting here. A caller who signed nothing
	 * shares one bucket with every other anonymous caller, which is the only
	 * honest way to count someone who will not say who they are
	 */
	countFor(caller: string | null): number {
		return (
			this.sql(`
			SELECT count(DISTINCT accepted.id) AS rows
			FROM accepted
			JOIN schedule ON schedule.id = accepted.id
			WHERE json_extract(accepted.payment, '$.caller') IS ?
		`).get(caller) as { rows: number }
		).rows;
	}

	kept(id: string): Kept | null {
		const row = this.sql(
			"SELECT id, caller, sealed, status, settledAt FROM kept WHERE id = ? LIMIT 1",
		).get(id) as KeptRow | undefined;
		if (row === undefined) {
			return null;
		}

		return {
			id: row.id,
			caller: row.caller,
			sealed: row.sealed,
			status: row.status === "paid" ? "paid" : "expired",
			settledAt: row.settledAt,
		};
	}

	private paymentsFor(ids: string[]): Payment[] {
		if (ids.length === 0) {
			return [];
		}

		return groupById(
			this.sql(
				"SELECT id, payment FROM accepted WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id, origin, seq",
			).all(JSON.stringify(ids)) as AcceptedRow[],
		);
	}

	accept(payment: Payment, dueAt = unixNow()): Taken {
		return this.transact(() => {
			const held = this.read(payment.id);
			const webhooks = held ? mergedWebhooks(held.webhooks, payment.webhooks) : payment.webhooks;
			const told = { ...payment, webhooks };
			const taken = { ...(held ?? payment), webhooks };
			const fresh =
				!held || webhooks.length > held.webhooks.length ? this.acceptedFact(told) : null;
			if (fresh) {
				this.recordAccepted(fresh);
			}

			this.scheduleWatch(taken.id, taken.expiresAt, dueAt);

			return { payment: withStatus(taken), facts: fresh ? { accepted: [fresh] } : {} };
		});
	}

	private acceptedFact(payment: Payment): AcceptedFact {
		const record = JSON.stringify(payment);
		const now = unixNow();
		const seq = this.nextSeq("accepted");

		const fact = {
			origin: this.origin,
			seq,
			id: payment.id,
			payment: record,
			acceptedAt: now,
			expiresAt: payment.expiresAt,
		};

		return { ...fact, mac: this.sign("accepted", fact) };
	}

	private scheduleWatch(id: string, expiresAt: number, dueAt: number): void {
		if (this.settlement(id)) {
			return;
		}
		this.sql(
			"INSERT INTO schedule (id, expiresAt, dueAt) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
		).run(id, expiresAt, dueAt);
	}

	private watchAfter(id: string): number {
		const rank =
			createHash("sha256").update(`${id}\x00${this.origin}`).digest().readUInt32BE(0) %
			TAKEOVER_SPREAD;
		const after = this.takeoverAfterSecs;

		return unixNow() + after + Math.max(1, Math.round(after / TAKEOVER_SPREAD)) * rank;
	}

	forget(id: string): void {
		this.sql("DELETE FROM schedule WHERE id = ?").run(id);
	}

	duePolls(limit: number, leaseSecs: number): Payment[] {
		const now = unixNow();
		const due = this.sql(
			"UPDATE schedule SET dueAt = ? WHERE id IN (SELECT id FROM schedule WHERE dueAt <= ? ORDER BY dueAt LIMIT ?) RETURNING id",
		).all(now + leaseSecs, now, limit) as { id: string }[];

		return this.paymentsFor(due.map((one) => one.id));
	}

	polled(id: string, dueAt: number | null): void {
		this.sql("UPDATE schedule SET dueAt = ? WHERE id = ?").run(dueAt, id);
	}

	nextDueAt(): number | null {
		return (
			this.sql(`SELECT min(dueAt) AS dueAt FROM (
				SELECT min(dueAt) AS dueAt FROM schedule WHERE dueAt IS NOT NULL
				UNION ALL
				SELECT min(dueAt) AS dueAt FROM outbox WHERE dueAt IS NOT NULL
			)`).get() as { dueAt: number | null }
		).dueAt;
	}

	settlement(id: string): PublicPayment | null {
		const row = this.sql("SELECT payment FROM paid WHERE id = ? LIMIT 1").get(id) as
			| Row
			| undefined;
		return row ? asStored<PublicPayment>(row.payment) : null;
	}

	replay(trigger: string, limit: number): PublicPayment[] {
		const rows = this.sql(
			"SELECT payment FROM paid WHERE json_extract(payment, '$.trigger') = ? ORDER BY settledAt DESC, seq DESC LIMIT ?",
		).all(trigger, limit) as Row[];
		return rows.map((row) => asStored<PublicPayment>(row.payment)).reverse();
	}

	list(limit: number, window: number): PublicPayment[] {
		const listed = (
			this.sql(
				"SELECT accepted.id AS id FROM accepted JOIN schedule ON schedule.id = accepted.id GROUP BY accepted.id ORDER BY max(accepted.acceptedAt) DESC LIMIT ?",
			).all(limit) as { id: string }[]
		).map((one) => one.id);
		const waiting = this.paymentsFor(listed).map(withoutSecrets);
		const newestFirst = [...waiting, ...this.recentlySettled(window)].sort(
			(one, other) => other.createdAt - one.createdAt,
		);

		return newestFirst.slice(0, limit);
	}

	private recentlySettled(window: number): PublicPayment[] {
		const rows = this.sql("SELECT payment FROM paid ORDER BY settledAt DESC, seq DESC LIMIT ?").all(
			window,
		) as Row[];
		return rows.map((row) => asStored<PublicPayment>(row.payment));
	}

	settle(watched: Payment, preimage: string): { settled: PublicPayment; facts: Facts } {
		proves(preimage, watched.paymentHash);
		const settled: Payment = { ...watched, status: "paid", preimage };
		const record = JSON.stringify(withoutSecrets(settled));
		const now = unixNow();
		const body = JSON.stringify(deliveryToWire(settled, now));

		return this.transact(() => {
			const seq = this.nextSeq("paid");
			const unsigned = {
				origin: this.origin,
				seq,
				id: settled.id,
				payment: record,
				settledAt: now,
			};
			const paid = { ...unsigned, mac: this.sign("paid", unsigned) };
			this.recordPaid(paid);

			const outbox = watched.webhooks.map((hook) => {
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
		return this.sql(`UPDATE outbox SET dueAt = ? WHERE rowid IN (
				SELECT rowid FROM outbox WHERE dueAt <= ?
					AND NOT EXISTS (SELECT 1 FROM delivered WHERE delivered.id = outbox.id AND delivered.url = outbox.url)
				ORDER BY dueAt LIMIT ?
			) RETURNING origin, seq, id, url, body`).all(now + leaseSecs, now, limit) as Delivery[];
	}

	delivered(owed: Delivery): Facts {
		const now = unixNow();
		return this.transact(() => {
			const seq = this.nextSeq("delivered");
			const unsigned = { origin: this.origin, seq, id: owed.id, url: owed.url, deliveredAt: now };
			const fact = { ...unsigned, mac: this.sign("delivered", unsigned) };
			this.recordDelivered(fact);

			return { delivered: [fact] };
		});
	}

	undelivered(owed: Delivery): Retry {
		const tried = this.sql(
			"SELECT attempts, owedAt, retryUntil FROM outbox WHERE origin = ? AND seq = ?",
		).get(owed.origin, owed.seq) as Attempted | undefined;
		if (!tried) {
			return "abandoned";
		}

		const now = unixNow();
		const attempts = tried.attempts + 1;
		const nextAt = now + this.deliveryBackoffSecs * attempts;
		const abandoned = nextAt > (tried.retryUntil ?? this.retryUntil(owed.id, tried.owedAt));
		this.sql(
			"UPDATE outbox SET attempts = ?, dueAt = ?, parkedAt = ? WHERE origin = ? AND seq = ?",
		).run(attempts, abandoned ? null : nextAt, abandoned ? now : null, owed.origin, owed.seq);

		return abandoned ? "abandoned" : "scheduled";
	}

	parkedDeliveries(): number {
		return (
			this.sql(`SELECT COUNT(*) AS n FROM outbox WHERE dueAt IS NULL
				AND NOT EXISTS (SELECT 1 FROM delivered WHERE delivered.id = outbox.id AND delivered.url = outbox.url)`).get() as {
				n: number;
			}
		).n;
	}

	private retryUntil(id: string, owedAt: number): number {
		const found = this.sql("SELECT MAX(expiresAt) AS deadline FROM accepted WHERE id = ?").get(
			id,
		) as { deadline: number | null };

		return Math.max(owedAt + RETRY_FLOOR_SECS, found.deadline ?? 0);
	}

	claimKey(key: string, fingerprint: string, leaseSecs: number): Claim {
		const now = unixNow();
		return this.transact<Claim>(() => {
			const held = this.sql(
				"SELECT fingerprint, paymentId, leaseUntil FROM requests WHERE key = ?",
			).get(key) as Held | undefined;
			if (held) {
				if (held.fingerprint !== fingerprint) {
					return { state: "mismatch" };
				}
				if (held.paymentId) {
					return { state: "done", paymentId: held.paymentId };
				}
				if (held.leaseUntil > now) {
					return { state: "inflight" };
				}
			}
			this.sql(`INSERT INTO requests (key, fingerprint, paymentId, claimedAt, leaseUntil) VALUES (?, ?, NULL, ?, ?)
				ON CONFLICT(key) DO UPDATE SET claimedAt = excluded.claimedAt, leaseUntil = excluded.leaseUntil`).run(
				key,
				fingerprint,
				now,
				now + leaseSecs,
			);

			return { state: "mine" };
		});
	}

	fulfillKey(key: string, paymentId: string): void {
		this.sql("UPDATE requests SET paymentId = ? WHERE key = ?").run(paymentId, key);
	}

	releaseKey(key: string): void {
		this.sql("DELETE FROM requests WHERE key = ? AND paymentId IS NULL").run(key);
	}

	factCounts(): Record<Source, number> {
		return bySource(
			(source) => (this.sql(`SELECT count(*) AS n FROM ${source}`).get() as { n: number }).n,
		);
	}

	watermarks(): Watermarks {
		const marks = bySource<Record<string, number>>(() => ({}));
		for (const row of this.sql("SELECT source, origin, seq FROM progress").all() as {
			source: Source;
			origin: string;
			seq: number;
		}[]) {
			const known = marks[row.source];
			if (known) {
				known[row.origin] = row.seq;
			}
		}
		return marks;
	}

	since(theirs: Watermarks): { facts: Facts; more: boolean; through: Watermarks } {
		let more = false;
		const mine = this.watermarks();
		const through = bySource<Record<string, number>>(() => ({}));
		const gap = <T extends { seq: number }>(source: Source): T[] => {
			const rows: T[] = [];
			for (const [origin, held] of Object.entries(mine[source])) {
				const seen = theirs[source]?.[origin] ?? 0;
				if (held <= seen) {
					continue;
				}
				const batch = this.sql(
					`SELECT ${COLUMNS[source]} FROM ${source} WHERE origin = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`,
				).all(origin, seen, held, GAP_BATCH) as T[];
				const cut = batch.length === GAP_BATCH;
				more ||= cut;
				through[source][origin] = cut ? (batch.at(-1)?.seq ?? seen) : held;
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
			through,
		};
	}

	absorb(facts: Facts, through?: Watermarks): PublicPayment[] {
		return this.transact(() => {
			const settled: PublicPayment[] = [];

			for (const fact of inSeqOrder(facts.accepted ?? [])) {
				if (this.known("accepted", fact) || refuses(() => this.provenAccepted(fact))) {
					continue;
				}
				this.recordAccepted(fact);
				this.scheduleWatch(fact.id, fact.expiresAt, this.watchAfter(fact.id));
			}

			for (const fact of inSeqOrder(facts.paid ?? [])) {
				if (this.known("paid", fact) || refuses(() => this.provenPaid(fact))) {
					continue;
				}
				this.recordPaid(fact);
				this.forget(fact.id);
				settled.push(asStored<PublicPayment>(fact.payment));
			}

			for (const fact of inSeqOrder(facts.outbox ?? [])) {
				if (this.known("outbox", fact) || refuses(() => this.verify("outbox", fact))) {
					continue;
				}
				this.recordOutbox(fact, this.takeoverAt(fact));
			}

			for (const fact of inSeqOrder(facts.delivered ?? [])) {
				if (this.known("delivered", fact) || refuses(() => this.verify("delivered", fact))) {
					continue;
				}
				this.recordDelivered(fact);
			}

			if (through) {
				this.cover(through);
			}

			return settled;
		});
	}

	private cover(through: Watermarks): void {
		for (const source of SOURCES) {
			for (const [origin, seq] of Object.entries(through[source] ?? {})) {
				if (origin !== this.origin && Number.isSafeInteger(seq)) {
					this.sql(
						"INSERT INTO progress (source, origin, seq) VALUES (?, ?, ?) ON CONFLICT(source, origin) DO UPDATE SET seq = max(seq, excluded.seq)",
					).run(source, origin, seq);
					this.advance(source, origin);
				}
			}
		}
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
			(
				this.sql("SELECT id FROM schedule WHERE expiresAt <= ? AND announced = 0").all(now) as {
					id: string;
				}[]
			).map((one) => one.id),
		);
		this.sql("UPDATE schedule SET announced = 1 WHERE expiresAt <= ?").run(now);
		this.sql(`INSERT INTO kept (id, caller, sealed, status, settledAt, keptAt)
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
				ON CONFLICT(id) DO NOTHING`).run(now, now - graceSecs, now - graceSecs);
		this.sql("DELETE FROM kept WHERE keptAt <= ?").run(now - keepSealedSecs);
		this.sql("DELETE FROM schedule WHERE expiresAt <= ?").run(now - graceSecs);
		this.sql("DELETE FROM accepted WHERE expiresAt <= ?").run(now - graceSecs);
		this.sql("DELETE FROM accepted WHERE id IN (SELECT id FROM paid WHERE settledAt <= ?)").run(
			now - graceSecs,
		);
		this.sql(`DELETE FROM outbox WHERE (dueAt IS NULL AND coalesce(parkedAt, owedAt) <= ?)
				OR (owedAt <= ? AND EXISTS (SELECT 1 FROM delivered WHERE delivered.id = outbox.id AND delivered.url = outbox.url))`).run(
			now - graceSecs,
			now - graceSecs,
		);
		this.sql(`DELETE FROM paid WHERE settledAt <= ? AND id IN (
				SELECT id FROM (
					SELECT id,
						COALESCE(json_extract(payment, '$.replay'), 0) AS keep,
						ROW_NUMBER() OVER (
							PARTITION BY json_extract(payment, '$.trigger')
							ORDER BY settledAt DESC, seq DESC
						) AS nth
					FROM paid
				) WHERE nth > keep
			)`).run(now - graceSecs);
		this.sql("DELETE FROM delivered WHERE deliveredAt <= ?").run(now - graceSecs);
		this.sql("DELETE FROM requests WHERE claimedAt <= ?").run(now - REQUEST_TTL_SECS);

		for (const missing of this.sql(`
			SELECT DISTINCT accepted.id AS id,
				json_extract(hook.value, '$.url') AS url,
				paid.settledAt AS settledAt
			FROM accepted
			JOIN paid ON paid.id = accepted.id
			JOIN json_each(accepted.payment, '$.webhooks') AS hook
			WHERE coalesce(paid.heardAt, paid.settledAt) <= ? AND NOT EXISTS (
				SELECT 1 FROM outbox
				WHERE outbox.id = accepted.id AND outbox.url = json_extract(hook.value, '$.url')
			) AND NOT EXISTS (
				SELECT 1 FROM delivered
				WHERE delivered.id = accepted.id AND delivered.url = json_extract(hook.value, '$.url')
			)
		`).all(now - UNOWED_SLACK_SECS) as Missing[]) {
			this.owe(missing);
		}

		return expired;
	}

	private owe(missing: Missing): void {
		const settled = this.settlement(missing.id);
		if (!settled) {
			return;
		}

		const owedAt = unixNow();
		const body = JSON.stringify(deliveryToWire(settled, missing.settledAt ?? owedAt));
		this.recordOutbox(this.owedFact(missing.id, missing, body, owedAt), 0);
	}

	private owedFact(id: string, hook: Webhook, body: string, owedAt: number): OutboxFact {
		const seq = this.nextSeq("outbox");

		const fact = { origin: this.origin, seq, id, url: hook.url, body, owedAt };

		return { ...fact, mac: this.sign("outbox", fact) };
	}

	close(): void {
		if (this.db.isOpen) {
			this.db.close();
		}
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
		if (written?.value === held) {
			return;
		}

		this.transact(() => {
			this.resignEveryFact();
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
			const rows = this.db.prepare(`SELECT ${COLUMNS[source]} FROM ${source}`).all() as Fields[];

			for (const row of rows) {
				this.db
					.prepare(`UPDATE ${source} SET mac = ? WHERE origin = ? AND seq = ?`)
					.run(this.sign(source, row), String(row["origin"]), Number(row["seq"]));
				resigned += 1;
			}
		}
		if (resigned > 0) {
			log.info(`re-signed ${resigned} facts under the cluster key now held`);
		}
	}

	private sql(text: string): StatementSync {
		let prepared = this.prepared.get(text);
		if (prepared === undefined) {
			prepared = this.db.prepare(text);
			this.prepared.set(text, prepared);
		}

		return prepared;
	}

	private transact<T>(work: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
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
		const held = this.sql(`
				SELECT max(
					coalesce((SELECT max(seq) FROM ${source} WHERE origin = ?), 0),
					coalesce((SELECT seq FROM progress WHERE source = '${source}' AND origin = ?), 0)
				) + 1 AS seq
			`).get(this.origin, this.origin);

		return (held as { seq: number }).seq;
	}

	private recordAccepted(fact: AcceptedFact): void {
		this.sql(
			"INSERT INTO accepted (origin, seq, id, payment, acceptedAt, expiresAt, mac) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(origin, seq) DO NOTHING",
		).run(fact.origin, fact.seq, fact.id, fact.payment, fact.acceptedAt, fact.expiresAt, fact.mac);
		this.advance("accepted", fact.origin);
	}

	private recordPaid(fact: PaidFact): void {
		this.sql(
			"INSERT INTO paid (origin, seq, id, payment, settledAt, mac, heardAt) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(origin, seq) DO NOTHING",
		).run(fact.origin, fact.seq, fact.id, fact.payment, fact.settledAt, fact.mac, unixNow());
		this.advance("paid", fact.origin);
	}

	private recordOutbox(fact: OutboxFact, dueAt: number): void {
		this.sql(
			"INSERT INTO outbox (origin, seq, id, url, body, owedAt, mac, dueAt, retryUntil) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(origin, seq) DO NOTHING",
		).run(
			fact.origin,
			fact.seq,
			fact.id,
			fact.url,
			fact.body,
			fact.owedAt,
			fact.mac,
			dueAt,
			this.retryUntil(fact.id, fact.owedAt),
		);
		this.advance("outbox", fact.origin);
	}

	private recordDelivered(fact: DeliveredFact): void {
		this.sql(
			"INSERT INTO delivered (origin, seq, id, url, deliveredAt, mac) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(origin, seq) DO NOTHING",
		).run(fact.origin, fact.seq, fact.id, fact.url, fact.deliveredAt, fact.mac);
		this.advance("delivered", fact.origin);
	}

	private advance(source: Source, origin: string): void {
		let mark = this.markOf(source, origin);
		while (
			this.sql(`SELECT 1 AS held FROM ${source} WHERE origin = ? AND seq = ?`).get(
				origin,
				mark + 1,
			) !== undefined
		) {
			mark += 1;
		}
		this.sql(
			"INSERT INTO progress (source, origin, seq) VALUES (?, ?, ?) ON CONFLICT(source, origin) DO UPDATE SET seq = max(seq, excluded.seq)",
		).run(source, origin, mark);
	}

	private known(source: Source, fact: { origin: string; seq: number }): boolean {
		return (
			fact.seq <= this.markOf(source, fact.origin) ||
			this.sql(`SELECT 1 AS held FROM ${source} WHERE origin = ? AND seq = ?`).get(
				fact.origin,
				fact.seq,
			) !== undefined
		);
	}

	private markOf(source: Source, origin: string): number {
		const row = this.sql("SELECT seq FROM progress WHERE source = ? AND origin = ?").get(
			source,
			origin,
		) as { seq: number } | undefined;
		return row?.seq ?? 0;
	}

	private sign(source: Source, fact: Fields): string {
		return macWith(this.key, source, signedFields(source, fact));
	}

	private verify(source: Source, fact: Fields & { mac: string }): void {
		const got = Buffer.from(fact.mac, "hex");
		const want = Buffer.from(this.sign(source, fact), "hex");
		const holds = want.length === got.length && timingSafeEqual(want, got);
		if (!holds) {
			throw new Error(`a ${source} fact arrived without the cluster key`);
		}
	}

	/**
	 * A fact has to be named after what it settles. A payment its caller signed for
	 * is named after that caller, which any instance can check without holding
	 * anything of theirs, and one nobody signed for is named by a key this cluster
	 * holds
	 */
	private namesItsOwnHash(
		id: string,
		payment: { caller: string | null; paymentHash: string },
	): boolean {
		if (payment.caller !== null) {
			return id === paymentNamedBy(payment.caller, payment.paymentHash);
		}

		return id === paymentId(this.key, payment.paymentHash);
	}

	private provenAccepted(fact: AcceptedFact): void {
		this.verify("accepted", fact);

		const payment = asStored<Payment>(fact.payment);
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

	private provenPaid(fact: PaidFact): void {
		this.verify("paid", fact);

		const payment = asStored<PublicPayment>(fact.payment);
		if (payment.id !== fact.id || !this.namesItsOwnHash(fact.id, payment)) {
			throw new Error(`paid fact ${fact.id} does not name the invoice it settles`);
		}
		proves(payment.preimage, payment.paymentHash);
	}

	private takeoverAt(fact: OutboxFact): number {
		const rank =
			createHash("sha256")
				.update(`${fact.id}\x00${fact.url}\x00${this.origin}`)
				.digest()
				.readUInt32BE(0) % TAKEOVER_SPREAD;
		const after = this.takeoverAfterSecs;

		return fact.owedAt + after + Math.max(1, Math.round(after / TAKEOVER_SPREAD)) * rank;
	}
}

export function paymentId(key: Uint8Array, paymentHash: string): string {
	return createHmac("sha256", key).update("payment-id").update(paymentHash).digest("hex");
}

/**
 * A payment as the ledger holds it. A record written before a field existed simply
 * has no key for it, and `JSON.parse` hands that back as `undefined` however the
 * type reads, so every field added since is normalised here rather than at each of
 * the places that reads one
 */
function asStored<T extends PublicPayment>(record: string): T {
	const payment = JSON.parse(record) as T;

	return { ...payment, caller: payment.caller ?? null, replay: payment.replay ?? 0 };
}

function signedFields(source: Source, fact: Fields): (string | number | null)[] {
	return COLUMNS[source]
		.split(", ")
		.filter((column) => column !== "mac")
		.map((column) => fact[column] ?? null);
}

function macWith(key: Uint8Array, source: Source, fields: (string | number | null)[]): string {
	const hmac = createHmac("sha256", key).update(source);
	for (const field of fields) {
		hmac.update("\x00").update(field === null ? "\x01" : String(field));
	}

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

function refuses(prove: () => void): boolean {
	try {
		prove();
		return false;
	} catch (refusal: unknown) {
		log.warn(`refusing a fact from a peer: ${String(refusal)}`);
		return true;
	}
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
	for (const row of rows) {
		held.set(row.id, [...(held.get(row.id) ?? []), revive(row)]);
	}

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
	return withStatus(asStored<Payment>(row.payment));
}

function withStatus(payment: Payment): Payment {
	return { ...payment, status: unixNow() >= payment.expiresAt ? "expired" : "pending" };
}

function unixNow(): number {
	return Math.floor(Date.now() / 1000);
}
