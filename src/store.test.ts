import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";

import type { UnsavedPayment } from "./payment.ts";
import { openStore } from "./testing.ts";

const HOOK = "https://example.com/hook";

const PAIRS = [
	["00", "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925"],
	["01", "72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793"],
	["02", "75877bb41d393b5fb8455ce60ecd8dda001d06316496b14dfa7f895656eeca4a"],
	["03", "648aa5c579fb30f38af744d97d6ec840c7a91277a499a0d780f3e7314eca090b"],
	["04", "9f4fb68f3e1dac82202f9aa581ce0bbf1f765df0e9ac3c8c57e20f685abab8ed"],
	["05", "f849d67325facf04177bc663b2dc544051831c589ef581d412f2eba44834e77c"],
] as const;

function preimage(nth: number): string {
	return PAIRS[nth]![0].repeat(32);
}

function payment(nth: number): UnsavedPayment {
	return {
		lnAddress: "charter@coinos.io",
		amountMsat: 21_000,
		status: "pending",
		paymentHash: PAIRS[nth]![1],
		bolt11: "lnbc210n1",
		preimage: null,
		expiresAt: 1_800_000_000,
		createdAt: 1_700_000_000,
		verifyUrl: "https://coinos.io/api/lnurl/verify/1",
		trigger: null,
		sealed: null,
		webhooks: [{ url: HOOK, secret: "hunter2" }],
	};
}

test("a payment round trips and only the unsettled ones come back as work", () => {
	const { store, stop } = openStore();
	try {
		const waiting = store.insert(payment(0));
		const settled = store.insert(payment(1));
		store.paid(settled.id, preimage(1));

		expect(store.get(waiting.id)?.verifyUrl).toBe("https://coinos.io/api/lnurl/verify/1");
		expect(store.get(settled.id)?.preimage).toBe(preimage(1));
		expect(store.duePolls(10, 30).map((one) => one.id)).toEqual([waiting.id]);
	} finally {
		stop();
	}
});

test("the same invoice inserted twice converges to one payment with merged webhooks", () => {
	const { store, stop } = openStore();
	try {
		const first = store.insert(payment(2));
		const again = store.insert({
			...payment(2),
			webhooks: [{ url: "https://elsewhere.example/hook", secret: null }],
		});

		expect(again.id).toBe(first.id);
		expect(again.webhooks).toHaveLength(2);
		expect(store.duePolls(10, 30).map((one) => one.id)).toEqual([first.id]);
	} finally {
		stop();
	}
});

test("a claimed payment is withheld until its lease runs out", () => {
	const { store, stop } = openStore();
	try {
		const one = store.insert(payment(3));

		expect(store.duePolls(10, 30).map((work) => work.id)).toEqual([one.id]);
		expect(store.duePolls(10, 30)).toEqual([]);
		expect(store.duePolls(10, 0).map((work) => work.id)).toEqual([]);
	} finally {
		stop();
	}
});

test("a lease taken for no time at all hands the same work straight back", () => {
	const { store, stop } = openStore();
	try {
		const one = store.insert(payment(4));

		expect(store.duePolls(10, 0).map((work) => work.id)).toEqual([one.id]);
		expect(store.duePolls(10, 0).map((work) => work.id)).toEqual([one.id]);
	} finally {
		stop();
	}
});

test("a payment parked with no due time is never handed out again", () => {
	const { store, stop } = openStore();
	try {
		const one = store.insert(payment(5));
		store.polled(one.id, null);

		expect(store.duePolls(10, 0)).toEqual([]);
		expect(store.get(one.id)?.id).toBe(one.id);
	} finally {
		stop();
	}
});

test("only as many payments are taken as the batch asks for", () => {
	const { store, stop } = openStore();
	try {
		for (let n = 0; n < 5; n += 1) store.insert(payment(n));

		expect(store.duePolls(2, 30)).toHaveLength(2);
		expect(store.duePolls(2, 30)).toHaveLength(2);
		expect(store.duePolls(2, 30)).toHaveLength(1);
	} finally {
		stop();
	}
});

test("a preimage that does not hash to the payment hash is refused", () => {
	const { store, stop } = openStore();
	try {
		const one = store.insert(payment(0));

		expect(() => store.paid(one.id, preimage(1))).toThrow("does not hash to it");
		expect(store.get(one.id)?.status).toBe("pending");
	} finally {
		stop();
	}
});

test("settling a payment owes its webhooks and takes it off the worklist", () => {
	const { store, stop } = openStore();
	try {
		const one = store.insert(payment(0));
		store.paid(one.id, preimage(0));

		expect(store.duePolls(10, 0)).toEqual([]);
		const owed = store.dueDeliveries(10, 0);
		expect(owed.map((hook) => hook.url)).toEqual([HOOK]);
		expect(owed[0]?.secret).toBe("hunter2");
		expect(JSON.parse(owed[0]?.body ?? "{}")).toMatchObject({ id: one.id, status: "paid" });
	} finally {
		stop();
	}
});

test("a webhook owed outlives the app that settled the payment", () => {
	const directory = mkdtempSync(join(tmpdir(), "tbd-restart-"));
	const ledger = join(directory, "ledger.db");
	const first = openStore({ ledger });
	const one = first.store.insert(payment(1));
	first.store.paid(one.id, preimage(1));
	first.stop();

	const second = openStore({ ledger });
	try {
		expect(second.store.dueDeliveries(10, 0).map((hook) => hook.id)).toEqual([one.id]);
	} finally {
		second.stop();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a delivered webhook is gone for good and a rejected one waits", () => {
	const { store, stop } = openStore();
	try {
		const kept = store.insert(payment(2));
		const dropped = store.insert(payment(3));
		store.paid(kept.id, preimage(2));
		store.paid(dropped.id, preimage(3));

		const owed = store.dueDeliveries(10, 0);
		const forKept = owed.find((hook) => hook.id === kept.id)!;
		const forDropped = owed.find((hook) => hook.id === dropped.id)!;
		store.delivered(forDropped);
		store.undelivered(forKept);

		expect(store.dueDeliveries(10, 0)).toEqual([]);
	} finally {
		stop();
	}
});

test("a webhook the merchant keeps rejecting is given up on and parked", () => {
	const { store, stop } = openStore({ deliveryBackoffSecs: 0 });
	try {
		const one = store.insert(payment(4));
		store.paid(one.id, preimage(4));

		for (let attempt = 0; attempt < 6; attempt += 1) {
			const owed = store.dueDeliveries(10, 0);
			expect(owed).toHaveLength(1);
			store.undelivered(owed[0]!);
		}

		expect(store.dueDeliveries(10, 0)).toEqual([]);
	} finally {
		stop();
	}
});

test("an idempotency key is held for one request at a time and released on the way out", () => {
	const { store, stop } = openStore();
	try {
		expect(store.claim("key_a", "fp_one", 60)).toEqual({ state: "mine" });
		expect(store.claim("key_a", "fp_one", 60)).toEqual({ state: "inflight" });
		expect(store.claim("key_a", "fp_two", 60)).toEqual({ state: "mismatch" });

		store.release("key_a");
		expect(store.claim("key_a", "fp_one", 60)).toEqual({ state: "mine" });

		const minted = store.insert(payment(0));
		store.fulfill("key_a", minted.id);
		expect(store.claim("key_a", "fp_one", 60)).toEqual({ state: "done", paymentId: minted.id });

		store.release("key_a");
		expect(store.claim("key_a", "fp_one", 60)).toEqual({ state: "done", paymentId: minted.id });
	} finally {
		stop();
	}
});

test("a key left claimed by a crashed request is retaken once its lease runs out", () => {
	const { store, stop } = openStore();
	try {
		expect(store.claim("key_b", "fp_one", 0)).toEqual({ state: "mine" });
		expect(store.claim("key_b", "fp_one", 60)).toEqual({ state: "mine" });
		expect(store.claim("key_b", "fp_one", 60)).toEqual({ state: "inflight" });
	} finally {
		stop();
	}
});

test("the store reports itself full once the worklist reaches its cap", () => {
	const { store, stop } = openStore({ maxPending: 2 });
	try {
		expect(store.full()).toBe(false);
		store.insert(payment(0));
		expect(store.full()).toBe(false);
		store.insert(payment(1));
		expect(store.full()).toBe(true);
	} finally {
		stop();
	}
});

test("a webhook only the other instance knew about is owed once the sweep notices", () => {
	const one = openStore();
	const two = openStore();
	const theirs = "https://elsewhere.example/hook";
	try {
		const mine = one.store.insert(payment(0));
		two.store.insert({ ...payment(0), webhooks: [{ url: theirs, secret: null }] });
		one.store.paid(mine.id, preimage(0));

		two.store.gossip.onFacts(one.store.gossip.since(two.store.gossip.watermarks()).facts);
		expect(two.store.get(mine.id)?.status).toBe("paid");
		expect(two.store.dueDeliveries(10, 30)).toEqual([]);

		two.store.sweep(3600);

		expect(two.store.dueDeliveries(10, 30).map((owed) => owed.url)).toEqual([theirs]);
	} finally {
		one.stop();
		two.stop();
	}
});

test("an accepted fact does not outlive the settlement that closed it", () => {
	const { store, stop } = openStore();
	try {
		const waiting = store.insert(payment(0));
		store.paid(waiting.id, preimage(0));
		expect(store.info().rows.accepted).toBe(1);

		store.sweep(0);

		expect(store.info().rows.accepted).toBe(0);
		expect(store.info().rows.paid).toBe(0);
	} finally {
		stop();
	}
});

test("the fact channel alone carries a payment to another instance", () => {
	const one = openStore();
	const two = openStore();
	try {
		const waiting = one.store.insert(payment(0));

		const { facts } = one.store.gossip.since(two.store.gossip.watermarks());
		two.store.gossip.onFacts(facts);

		expect(two.store.get(waiting.id)?.paymentHash).toBe(waiting.paymentHash);
		expect(two.store.info().pending).toBe(1);
	} finally {
		one.stop();
		two.stop();
	}
});

test("a payment past the cap is still recorded and still offered to a peer", () => {
	const one = openStore({ maxPending: 1 });
	const two = openStore({ maxPending: 1 });
	try {
		one.store.insert(payment(0));
		const past = one.store.insert(payment(1));
		expect(one.store.full()).toBe(true);

		const { facts } = one.store.gossip.since(two.store.gossip.watermarks());
		two.store.gossip.onFacts(facts);

		expect(two.store.get(past.id)?.paymentHash).toBe(past.paymentHash);
	} finally {
		one.stop();
		two.stop();
	}
});

test("an accepted fact nobody signed with the cluster key is refused", () => {
	const one = openStore();
	const two = openStore();
	try {
		one.store.insert(payment(0));
		const { facts } = one.store.gossip.since(two.store.gossip.watermarks());
		const forged = (facts.accepted ?? []).map((fact) => ({ ...fact, id: "0".repeat(64) }));

		expect(() => two.store.gossip.onFacts({ accepted: forged })).toThrow(/cluster key/);
		expect(two.store.info().pending).toBe(0);
	} finally {
		one.stop();
		two.stop();
	}
});

test("a pruned accepted fact is not resurrected by a peer that still holds it", () => {
	const one = openStore();
	const two = openStore();
	try {
		one.store.insert({ ...payment(0), expiresAt: 1_700_000_100 });
		const { facts } = one.store.gossip.since(two.store.gossip.watermarks());

		two.store.gossip.onFacts(facts);
		expect(two.store.info().pending).toBe(1);

		two.store.sweep(0);
		expect(two.store.info().pending).toBe(0);

		two.store.gossip.onFacts(facts);
		expect(two.store.info().pending).toBe(0);
	} finally {
		one.stop();
		two.stop();
	}
});

test("a peer that sends no accepted facts at all is understood", () => {
	const { store, stop } = openStore();
	try {
		expect(() => store.gossip.onFacts({ paid: [], outbox: [], delivered: [] })).not.toThrow();
	} finally {
		stop();
	}
});

test("a build that predates accepted facts still finds the worklist where it looks", () => {
	const directory = mkdtempSync(join(tmpdir(), "tbd-rollback-"));
	const ledger = join(directory, "ledger.db");
	const { store, stop } = openStore({ ledger });
	const waiting = store.insert(payment(0));
	stop();

	const older = new DatabaseSync(ledger);
	try {
		expect(schemaVersionOf(ledger)).toBe(1);
		const rows = older.prepare("SELECT payment FROM pending WHERE id = ?").all(waiting.id) as {
			payment: string;
		}[];
		expect(rows).toHaveLength(1);
		expect(JSON.parse(rows[0]!.payment)).toMatchObject({ paymentHash: waiting.paymentHash });
	} finally {
		older.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a ledger written before accepted facts existed keeps its worklist", () => {
	const directory = mkdtempSync(join(tmpdir(), "tbd-adopt-"));
	const ledger = join(directory, "ledger.db");
	const before = openStore({ ledger });
	const waiting = before.store.insert(payment(0));
	before.stop();

	const written = new DatabaseSync(ledger);
	written.exec("DELETE FROM accepted");
	written.exec("DELETE FROM schedule");
	written.exec("DELETE FROM progress WHERE source = 'accepted'");
	written.close();

	const { store, stop } = openStore({ ledger });
	try {
		expect(store.get(waiting.id)?.paymentHash).toBe(waiting.paymentHash);
		expect(store.info().pending).toBe(1);
	} finally {
		stop();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a ledger from before the schema was versioned keeps its payments and gets stamped", () => {
	const directory = mkdtempSync(join(tmpdir(), "tbd-unstamped-"));
	const ledger = join(directory, "ledger.db");
	const before = openStore({ ledger });
	const waiting = before.store.insert(payment(0));
	before.stop();

	const unstamped = new DatabaseSync(ledger);
	unstamped.exec("PRAGMA user_version = 0");
	unstamped.close();

	const { store, stop } = openStore({ ledger });
	try {
		expect(store.get(waiting.id)).not.toBeNull();
		expect(schemaVersionOf(ledger)).toBe(1);
	} finally {
		stop();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a ledger a newer build wrote is refused instead of opened", () => {
	const directory = mkdtempSync(join(tmpdir(), "tbd-newer-"));
	const ledger = join(directory, "ledger.db");
	const newer = new DatabaseSync(ledger);
	newer.exec("PRAGMA user_version = 99");
	newer.close();

	try {
		expect(() => openStore({ ledger })).toThrow(/schema 99/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a stamped ledger still rebuilds an index that went missing", () => {
	const directory = mkdtempSync(join(tmpdir(), "tbd-index-"));
	const ledger = join(directory, "ledger.db");
	openStore({ ledger }).stop();

	const damaged = new DatabaseSync(ledger);
	damaged.exec("DROP INDEX pending_by_due");
	damaged.close();
	expect(indexesOf(ledger)).not.toContain("pending_by_due");

	const { stop } = openStore({ ledger });
	try {
		expect(indexesOf(ledger)).toContain("pending_by_due");
	} finally {
		stop();
		rmSync(directory, { recursive: true, force: true });
	}
});

function indexesOf(path: string): string[] {
	const db = new DatabaseSync(path);
	const found = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
		name: string;
	}[];
	db.close();

	return found.map((one) => one.name);
}

function schemaVersionOf(path: string): number {
	const db = new DatabaseSync(path);
	const stamped = db.prepare("PRAGMA user_version").get() as { user_version: number };
	db.close();

	return stamped.user_version;
}

test("a ledger left over from before the request cache changed shape still boots", () => {
	const directory = mkdtempSync(join(tmpdir(), "tbd-stale-"));
	const ledger = join(directory, "ledger.db");
	const stale = new DatabaseSync(ledger);
	stale.exec(
		"CREATE TABLE requests (key TEXT PRIMARY KEY, paymentId TEXT NOT NULL, storedAt INTEGER NOT NULL)",
	);
	stale.prepare("INSERT INTO requests VALUES (?, ?, ?)").run("stale", "payment", 1_700_000_000);
	stale.close();

	const { store, stop } = openStore({ ledger });
	try {
		expect(store.claim("stale", "fingerprint", 60)).toEqual({ state: "mine" });
	} finally {
		stop();
		rmSync(directory, { recursive: true, force: true });
	}
});
