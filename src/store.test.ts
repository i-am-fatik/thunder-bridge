import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";

import type { UnsavedPayment } from "./payment.ts";
import { openStore } from "./testing.ts";
import { unixNow } from "./watch.ts";

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
		replay: 0,
		sealed: null,
		caller: null,
		webhooks: [{ url: HOOK }],
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
			webhooks: [{ url: "https://elsewhere.example/hook" }],
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
		for (let n = 0; n < 5; n += 1) {
			store.insert(payment(n));
		}

		const handed = [...store.duePolls(2, 30), ...store.duePolls(2, 30), ...store.duePolls(2, 30)];

		expect(handed).toHaveLength(5);
		expect(new Set(handed.map((one) => one.id)).size).toBe(5);
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

test("a webhook the merchant keeps rejecting is retried for as long as the payment lasts", () => {
	const { store, stop } = openStore({ deliveryBackoffSecs: 600 });
	try {
		const one = store.insert(payment(4));
		store.paid(one.id, preimage(4));

		const owed = store.dueDeliveries(10, 0);
		expect(owed).toHaveLength(1);
		for (let attempt = 0; attempt < 10; attempt += 1) {
			expect(store.undelivered(owed[0]!)).toBe("scheduled");
		}

		expect(store.info().parked).toBe(0);
	} finally {
		stop();
	}
});

test("a delivery is abandoned once its payment has no time left to retry in", () => {
	const { store, stop } = openStore({ deliveryBackoffSecs: 7200 });
	try {
		const expiring = store.insert({ ...payment(5), expiresAt: unixNow() + 5 });
		store.paid(expiring.id, preimage(5));

		const owed = store.dueDeliveries(10, 0);
		expect(store.undelivered(owed[0]!)).toBe("abandoned");

		expect(store.dueDeliveries(10, 0)).toEqual([]);
		expect(store.info().parked).toBe(1);
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
		expect(store.full(null)).toBe(false);
		store.insert(payment(0));
		expect(store.full(null)).toBe(false);
		store.insert(payment(1));
		expect(store.full(null)).toBe(true);
	} finally {
		stop();
	}
});

test("a pruned origin does not start its sequence over and lose what it takes on next", () => {
	const one = openStore();
	const two = openStore();
	try {
		const first = one.store.insert(payment(0));
		one.store.paid(first.id, preimage(0));
		two.store.gossip.onFacts(one.store.gossip.since(two.store.gossip.watermarks()).facts);

		one.store.sweep(0, 7_776_000);
		expect(one.store.info().rows.accepted).toBe(0);

		const second = one.store.insert(payment(1));
		two.store.gossip.onFacts(one.store.gossip.since(two.store.gossip.watermarks()).facts);

		expect(two.store.get(second.id)?.paymentHash).toBe(second.paymentHash);
	} finally {
		one.stop();
		two.stop();
	}
});

test("a webhook only the other instance knew about is owed once the sweep notices", () => {
	const one = openStore();
	const two = openStore();
	const theirs = "https://elsewhere.example/hook";
	try {
		const mine = one.store.insert(payment(0));
		two.store.insert({ ...payment(0), webhooks: [{ url: theirs }] });
		one.store.paid(mine.id, preimage(0));

		two.store.gossip.onFacts(one.store.gossip.since(two.store.gossip.watermarks()).facts);
		expect(two.store.get(mine.id)?.status).toBe("paid");
		expect(two.store.dueDeliveries(10, 30)).toEqual([]);

		two.store.sweep(3600, 7_776_000);

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

		store.sweep(0, 7_776_000);

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
		expect(one.store.full(null)).toBe(true);

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

		two.store.sweep(0, 7_776_000);
		expect(two.store.info().pending).toBe(0);

		two.store.gossip.onFacts(facts);
		expect(two.store.info().pending).toBe(0);
	} finally {
		one.stop();
		two.stop();
	}
});

test("a peer that names no accepted facts is still heard on the ones it does name", () => {
	const one = openStore();
	const two = openStore();
	try {
		const waiting = one.store.insert(payment(0));
		one.store.paid(waiting.id, preimage(0));
		const { facts } = one.store.gossip.since(two.store.gossip.watermarks());

		two.store.gossip.onFacts({
			paid: facts.paid,
			outbox: facts.outbox,
			delivered: facts.delivered,
		});

		expect(two.store.get(waiting.id)?.status).toBe("paid");
		expect(two.store.info().rows.accepted).toBe(0);
	} finally {
		one.stop();
		two.stop();
	}
});

test("the worklist a rollback used to read is gone, and the stamp says so", () => {
	const directory = mkdtempSync(join(tmpdir(), "tbd-retired-"));
	const ledger = join(directory, "ledger.db");
	const { store, stop } = openStore({ ledger });
	store.insert(payment(0));
	stop();

	const opened = new DatabaseSync(ledger);
	try {
		expect(schemaVersionOf(ledger)).toBe(3);
		const tables = opened
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending'")
			.all();
		expect(tables).toHaveLength(0);
	} finally {
		opened.close();
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
	written.exec(
		"CREATE TABLE pending (id TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL, dueAt INTEGER, announced INTEGER NOT NULL DEFAULT 0, payment TEXT NOT NULL)",
	);
	written
		.prepare("INSERT INTO pending (id, expiresAt, dueAt, payment) VALUES (?, ?, ?, ?)")
		.run(waiting.id, waiting.expiresAt, null, JSON.stringify({ ...waiting, webhooks: [] }));
	written.exec("DELETE FROM accepted");
	written.exec("DELETE FROM schedule");
	written.exec("DELETE FROM progress WHERE source = 'accepted'");
	written.exec("PRAGMA user_version = 1");
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
		expect(schemaVersionOf(ledger)).toBe(3);
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
	damaged.exec("DROP INDEX schedule_by_due");
	damaged.close();
	expect(indexesOf(ledger)).not.toContain("schedule_by_due");

	const { stop } = openStore({ ledger });
	try {
		expect(indexesOf(ledger)).toContain("schedule_by_due");
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

test("a sealed blob outlives the payment it belonged to, and nothing readable does", () => {
	const one = openStore();
	try {
		const owner = "ab".repeat(32);
		const mine = one.store.insert({
			...payment(0),
			caller: owner,
			sealed: "v1.thisIsTheClientsOwnCiphertext",
		});
		one.store.paid(mine.id, preimage(0));

		one.store.sweep(0, 7_776_000);

		expect(one.store.get(mine.id)).toBeNull();
		const kept = one.store.kept(mine.id);
		expect(kept?.sealed).toBe("v1.thisIsTheClientsOwnCiphertext");
		expect(kept?.caller).toBe(owner);
		expect(kept?.status).toBe("paid");
		expect(JSON.stringify(kept)).not.toContain(payment(0).paymentHash);
		expect(JSON.stringify(kept)).not.toContain("coinos.io");
		expect(JSON.stringify(kept)).not.toContain(preimage(0));
	} finally {
		one.stop();
	}
});

test("the blob goes too once the window an instance published has closed", () => {
	const one = openStore();
	try {
		const mine = one.store.insert({ ...payment(1), sealed: "v1.keptForAWhile" });
		one.store.paid(mine.id, preimage(1));

		one.store.sweep(0, 0);

		expect(one.store.kept(mine.id)).toBeNull();
	} finally {
		one.stop();
	}
});

test("a payment that sealed nothing leaves nothing behind at all", () => {
	const one = openStore();
	try {
		const mine = one.store.insert(payment(2));
		one.store.paid(mine.id, preimage(2));

		one.store.sweep(0, 7_776_000);

		expect(one.store.get(mine.id)).toBeNull();
		expect(one.store.kept(mine.id)).toBeNull();
	} finally {
		one.stop();
	}
});

test("a record written before callers existed reads back as anonymous, not as nobody's", () => {
	const directory = mkdtempSync(join(tmpdir(), "tbd-before-callers-"));
	const ledger = join(directory, "ledger.db");
	const before = openStore({ ledger });
	const mine = before.store.insert(payment(0));
	before.stop();

	const written = new DatabaseSync(ledger);
	const held = written.prepare("SELECT payment FROM accepted WHERE id = ?").get(mine.id) as {
		payment: string;
	};
	const asItUsedToBe = JSON.parse(held.payment) as Record<string, unknown>;
	delete asItUsedToBe["caller"];
	written
		.prepare("UPDATE accepted SET payment = ? WHERE id = ?")
		.run(JSON.stringify(asItUsedToBe), mine.id);
	written.close();

	const after = openStore({ ledger });
	try {
		expect(after.store.get(mine.id)?.caller).toBeNull();
	} finally {
		after.stop();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a settlement its minter asked to keep outlives the hour, up to the number asked", () => {
	const { store, stop } = openStore();
	const trigger = "ab".repeat(32);
	try {
		const kept = [0, 1, 2].map((nth) => store.insert({ ...payment(nth), trigger, replay: 2 }));
		kept.forEach((one, nth) => store.paid(one.id, preimage(nth)));
		const loose = store.insert(payment(3));
		store.paid(loose.id, preimage(3));

		store.sweep(0, 7_776_000);

		expect(store.info().rows.paid).toBe(2);
		expect(store.replay(trigger, 10).map((settled) => settled.id)).toEqual([
			kept[1]!.id,
			kept[2]!.id,
		]);
		expect(store.get(kept[2]!.id)?.status).toBe("paid");
		expect(store.get(loose.id)).toBeNull();
	} finally {
		stop();
	}
});

test("replay hands back the newest of a trigger oldest first, and only as many as were asked for", () => {
	const { store, stop } = openStore();
	const trigger = "cd".repeat(32);
	try {
		const paid = [0, 1, 2].map((nth) => store.insert({ ...payment(nth), trigger, replay: 5 }));
		paid.forEach((one, nth) => store.paid(one.id, preimage(nth)));

		expect(store.replay(trigger, 2).map((settled) => settled.id)).toEqual([
			paid[1]!.id,
			paid[2]!.id,
		]);
		expect(store.replay("ef".repeat(32), 2)).toEqual([]);
	} finally {
		stop();
	}
});
