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
