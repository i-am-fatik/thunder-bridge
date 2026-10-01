import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { duplexPair } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import SecretStream from "@hyperswarm/secret-stream";
import c from "compact-encoding";
import Protomux from "protomux";
import { afterEach, expect, test, vi } from "vitest";
import { callerKey, paymentNamedBy } from "../core/caller.ts";
import { signingKeyFromSeed } from "../core/ed25519.ts";
import type { Send } from "../core/outbound.ts";

import { attach } from "./gossip.ts";
import type { UnsavedPayment } from "./payment.ts";
import { rankAmong, type Store } from "./store.ts";

import {
	CLUSTER_KEY,
	freePort,
	type Opened,
	openStore,
	refusals,
	type TestOptions,
	until,
} from "./testing.ts";
import { tick, unixNow, type Watcher } from "./watch.ts";

vi.mock("node:dns/promises", () => ({ Resolver: everyHostResolvesPublic }));

function everyHostResolvesPublic() {
	return { resolve4: async () => ["93.184.216.34"], resolve6: async () => [], cancel: () => {} };
}

afterEach(() => {
	vi.useRealTimers();
});

function at(unix: number): void {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(unix * 1000);
}

const TAKEOVER_TIMEOUT_MS = 25_000;

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
		expiresAt: 1_900_000_000,
		createdAt: 1_700_000_000,
		verifyUrl: "https://coinos.io/api/lnurl/verify/1",
		trigger: null,
		replay: 0,
		sealed: null,
		caller: null,
		webhooks: [{ url: "https://example.com/hook" }],
	};
}

function signedAsCluster(source: string, fields: (string | number | null)[]): string {
	const hmac = createHmac("sha256", CLUSTER_KEY).update(source);
	for (const field of fields) {
		hmac.update("\x00").update(field === null ? "\x01" : String(field));
	}

	return hmac.digest("hex");
}

function spread(nth: number): UnsavedPayment {
	return { ...payment(0), paymentHash: nth.toString(16).padStart(64, "0") };
}

type Cluster = {
	first: Store;
	second: Store;
	loseFirst: () => void;
	stop: () => void;
};

type Introduction = { self: string; proof: string };

function session(): [SecretStream, SecretStream] {
	const [left, right] = duplexPair();

	return [new SecretStream(true, left), new SecretStream(false, right)];
}

function overhear(stream: SecretStream): Promise<Introduction> {
	const mux = Protomux.from(stream);

	return new Promise((heard) => {
		mux.pair({ protocol: "thunder-cluster" }, () => {
			mux
				.createChannel<Introduction>({
					protocol: "thunder-cluster",
					handshake: c.json,
					onopen: heard,
				})
				?.open({ self: "an-eavesdropper", proof: "00" });
		});
	});
}

async function connected(options: TestOptions = {}): Promise<Cluster> {
	const port = await freePort();
	const one = openStore({ ...options, listenPort: port });
	const two = openStore({ ...options, peers: [`127.0.0.1:${port}`] });

	await until(() => one.store.info().peers === 1, "the two instances to find each other");

	return {
		first: one.store,
		second: two.store,
		loseFirst: one.stop,
		stop: () => {
			one.stop();
			two.stop();
		},
	};
}

test("a pending payment gossips across without ever reaching the ledger", async () => {
	const cluster = await connected();
	try {
		const mine = cluster.first.insert(payment(2));
		await until(() => cluster.second.get(mine.id) !== null, "the pending payment to gossip across");

		const theirs = cluster.second.get(mine.id);
		expect(theirs?.status).toBe("pending");
		expect(theirs?.bolt11).toBe("lnbc210n1");
	} finally {
		cluster.stop();
	}
});

test("only a paid payment reaches the ledger, and it wins exactly once", async () => {
	const cluster = await connected();
	try {
		const one = cluster.first.insert(payment(3));
		await until(() => cluster.second.get(one.id) !== null, "the pending payment to gossip across");

		const winner = cluster.first.paid(one.id, preimage(3));
		expect(winner.won).toBe(true);
		expect(winner.payment.status).toBe("paid");

		await until(() => cluster.second.get(one.id)?.status === "paid", "the paid fact to replicate");
		const loser = cluster.second.paid(one.id, preimage(3));
		expect(loser.won).toBe(false);
		expect(loser.payment.preimage).toBe(preimage(3));
	} finally {
		cluster.stop();
	}
});

test("a trigger survives replication, so any instance can serve its stream", async () => {
	const cluster = await connected();
	const trigger = "a".repeat(64);
	try {
		const one = cluster.first.insert({ ...payment(4), trigger });
		await until(() => cluster.second.get(one.id) !== null, "the pending payment to gossip across");
		expect(cluster.second.get(one.id)?.trigger).toBe(trigger);

		cluster.first.paid(one.id, preimage(4));
		await until(() => cluster.second.get(one.id)?.status === "paid", "the paid fact to replicate");

		expect(cluster.second.replay(trigger, 10).map((settled) => settled.id)).toEqual([one.id]);
	} finally {
		cluster.stop();
	}
});

test("every instance takes on every pending payment, whoever created it", async () => {
	const cluster = await connected();
	try {
		const made: string[] = [];
		for (let n = 0; n < 20; n += 1) {
			made.push(cluster.first.insert(spread(n)).id);
		}

		const seen = (store: Store) => made.filter((one) => store.get(one) !== null).length;
		await until(() => seen(cluster.second) === 20, "the pending set to gossip across");

		expect(seen(cluster.first)).toBe(20);
		expect(seen(cluster.second)).toBe(20);
	} finally {
		cluster.stop();
	}
});

test("an accepted fact whose id does not name its own invoice is refused, key or no key", async () => {
	const cluster = await connected();
	try {
		const lying = { ...payment(1), id: "0".repeat(64) };
		const fact = {
			origin: "a-peer-that-holds-the-key",
			seq: 1,
			id: lying.id,
			payment: JSON.stringify(lying),
			acceptedAt: 1_700_000_000,
			expiresAt: lying.expiresAt,
		};

		expect(
			refusals(() =>
				cluster.first.gossip.onFacts({
					accepted: [{ ...fact, mac: signedAsCluster("accepted", Object.values(fact)) }],
				}),
			),
		).toContainEqual(expect.stringContaining("does not name the invoice it watches"));

		expect(cluster.first.info().rows.accepted).toBe(0);
		expect(cluster.first.get(lying.id)).toBeNull();
	} finally {
		cluster.stop();
	}
});

test("a handshake overheard on one link does not open another, because it names its session", async () => {
	const one = openStore();
	const two = openStore();
	try {
		const [toOne, eavesdropping] = session();
		attach(one.store.gossip, toOne);
		const overheard = await overhear(eavesdropping);
		expect(overheard.self).toBe(one.store.info().origin);

		const [toTwo, replaying] = session();
		attach(two.store.gossip, toTwo);
		Protomux.from(replaying)
			.createChannel({ protocol: "thunder-cluster", handshake: c.json })
			?.open(overheard);

		await until(
			() => toTwo.destroyed || two.store.info().peers > 0,
			"the replayed handshake to be judged",
		);
		expect(two.store.info().peers).toBe(0);
	} finally {
		one.stop();
		two.stop();
	}
});

test("a peer that sends a note nobody can read has its link torn down, so it is dialled again", async () => {
	const one = openStore();
	const two = openStore();
	try {
		const [toOne, toTwo] = session();
		attach(one.store.gossip, toOne);
		attach(two.store.gossip, toTwo);
		await until(() => two.store.info().peers === 1, "the two to shake hands");

		const unreadable = { facts: { accepted: [{ seq: "one" }] }, more: false };
		two.store.gossip.peers.get(one.store.info().origin)?.(unreadable as never);

		await until(() => toOne.destroyed, "the link to be torn down");
		expect(one.store.info().peers).toBe(0);
	} finally {
		one.stop();
		two.stop();
	}
});

test("a link that closes after its replacement opened leaves the replacement talking", async () => {
	const one = openStore();
	const two = openStore();
	try {
		const [oldToOne, oldToTwo] = session();
		attach(one.store.gossip, oldToOne);
		attach(two.store.gossip, oldToTwo);
		await until(
			() => one.store.info().peers === 1 && two.store.info().peers === 1,
			"the first link to shake hands",
		);
		const replaced = one.store.gossip.peers.get(two.store.info().origin);

		const [newToOne, newToTwo] = session();
		attach(one.store.gossip, newToOne);
		attach(two.store.gossip, newToTwo);
		await until(
			() => one.store.gossip.peers.get(two.store.info().origin) !== replaced,
			"the second link to shake hands",
		);

		oldToOne.destroy();
		oldToTwo.destroy();
		await until(() => oldToOne.destroyed && oldToTwo.destroyed, "the first link to close");
		await sleep(50);

		expect([one.store.info().peers, two.store.info().peers]).toEqual([1, 1]);
		const mine = one.store.insert(payment(1));
		await until(() => two.store.get(mine.id) !== null, "the payment to cross the new link");
	} finally {
		one.stop();
		two.stop();
	}
});

test("both instances say they are in sync and agree on what they hold", async () => {
	const cluster = await connected();
	try {
		cluster.first.insert(payment(0));

		await until(
			() => cluster.first.info().marks.accepted === cluster.second.info().marks.accepted,
			"the accepted marks to match",
		);
		await until(
			() => cluster.first.info().convergedAt !== null && cluster.second.info().convergedAt !== null,
			"both instances to hear a reply that came back short",
		);

		expect(cluster.second.info().origins).toBe(cluster.first.info().origins);
	} finally {
		cluster.stop();
	}
});

test("two instances at their cap still both hold every payment", async () => {
	const cluster = await connected({ maxPending: 2 });
	try {
		const made = [0, 1, 2].map((n) => cluster.first.insert(spread(n)).id);
		expect(cluster.first.full(null)).toBe(true);

		await until(
			() => made.every((one) => cluster.second.get(one) !== null),
			"the whole worklist to reach a peer that is already full",
		);
	} finally {
		cluster.stop();
	}
});

function fresh(nth: number): UnsavedPayment {
	return { ...payment(nth), createdAt: unixNow(), expiresAt: unixNow() + 3600 };
}

function inLine(store: Store, id: string): number {
	return rankAmong(id, store.gossip.self, store.gossip.peers.keys());
}

test("of two instances only the first in line finds a new payment due, the other one poll interval later", async () => {
	const cluster = await connected();
	try {
		const now = unixNow();
		at(now);
		const made = cluster.first.insert(fresh(0));
		await until(() => cluster.second.get(made.id) !== null, "the payment to gossip across");
		const [ahead, behind] =
			inLine(cluster.first, made.id) === 0
				? [cluster.first, cluster.second]
				: [cluster.second, cluster.first];

		expect(ahead.duePolls(10, 30).map((one) => one.id)).toEqual([made.id]);
		expect(behind.duePolls(10, 30)).toEqual([]);

		at(now + 5);
		expect(behind.duePolls(10, 30).map((one) => one.id)).toEqual([made.id]);
	} finally {
		cluster.stop();
	}
});

test("a worklist a late peer catches up on waits its turn, so it cannot bury a payment made a second ago", async () => {
	const port = await freePort();
	const first = openStore({ listenPort: port });
	const now = unixNow();
	at(now);
	const theirs: string[] = [];
	for (let n = 0; n < 20; n += 1) {
		theirs.push(first.store.insert({ ...spread(n), createdAt: now, expiresAt: now + 86_400 }).id);
	}

	at(now + 3600);
	const late = openStore({ peers: [`127.0.0.1:${port}`] });
	try {
		await until(
			() => theirs.every((one) => late.store.get(one) !== null),
			"the worklist to reach the late peer",
		);

		expect(late.store.duePolls(50, 30)).toEqual([]);
	} finally {
		late.stop();
		first.stop();
	}
});

test("the instance that settled the payment is the one that owes its webhook", async () => {
	const cluster = await connected();
	try {
		const one = cluster.first.insert(payment(4));
		await until(() => cluster.second.get(one.id) !== null, "the pending payment to gossip across");

		const winner = cluster.first.paid(one.id, preimage(4));
		expect(winner.won).toBe(true);

		await until(() => cluster.second.get(one.id)?.status === "paid", "the paid fact to replicate");
		cluster.second.paid(one.id, preimage(4));

		expect(cluster.first.dueDeliveries(10, 0).map((hook) => hook.id)).toEqual([one.id]);
		expect(cluster.second.dueDeliveries(10, 0)).toEqual([]);
	} finally {
		cluster.stop();
	}
});

test(
	"a webhook outlives the instance that owed it and another one takes it over",
	async () => {
		const cluster = await connected({ takeoverAfterSecs: 0 });
		try {
			const one = cluster.first.insert(payment(5));
			await until(
				() => cluster.second.get(one.id) !== null,
				"the pending payment to gossip across",
			);
			cluster.first.paid(one.id, preimage(5));
			await until(
				() => cluster.second.dueDeliveries(10, 0).length === 1,
				"the outbox fact to reach the survivor",
			);

			cluster.loseFirst();

			expect(cluster.second.dueDeliveries(10, 30).map((hook) => hook.id)).toEqual([one.id]);
		} finally {
			cluster.stop();
		}
	},
	TAKEOVER_TIMEOUT_MS,
);

test(
	"a webhook already delivered is never handed to another instance",
	async () => {
		const cluster = await connected({ takeoverAfterSecs: 0 });
		try {
			const one = cluster.first.insert(payment(0));
			await until(
				() => cluster.second.get(one.id) !== null,
				"the pending payment to gossip across",
			);
			cluster.first.paid(one.id, preimage(0));
			await until(
				() => cluster.second.dueDeliveries(10, 0).length === 1,
				"the outbox fact to replicate",
			);

			const owed = cluster.first.dueDeliveries(10, 0);
			cluster.first.delivered(owed[0]!);

			await until(
				() => cluster.second.dueDeliveries(10, 0).length === 0,
				"the delivered fact to call the takeover off",
			);
		} finally {
			cluster.stop();
		}
	},
	TAKEOVER_TIMEOUT_MS,
);

test("the same invoice inserted on both instances converges to one payment", async () => {
	const cluster = await connected();
	try {
		const invoice = payment(1);
		const mine = cluster.first.insert({
			...invoice,
			webhooks: [{ url: "https://a.example/hook" }],
		});
		const theirs = cluster.second.insert({
			...invoice,
			webhooks: [{ url: "https://b.example/hook" }],
		});

		expect(theirs.id).toBe(mine.id);
		const mergedOn = (store: Store) => (store.get(mine.id)?.webhooks.length ?? 0) === 2;
		await until(
			() => mergedOn(cluster.first) && mergedOn(cluster.second),
			"the webhooks to merge on both instances",
		);
	} finally {
		cluster.stop();
	}
});

test("a payment minted with nobody listening reaches the instance that joins later", async () => {
	const port = await freePort();
	const alone = openStore({ listenPort: port });

	const mine = alone.store.insert(payment(2));
	expect(alone.store.info().peers).toBe(0);

	const late = openStore({ peers: [`127.0.0.1:${port}`] });
	try {
		await until(
			() => late.store.get(mine.id) !== null,
			"the pending payment to catch up on connect",
		);

		const caught = late.store.get(mine.id);
		expect(caught?.status).toBe("pending");
		expect(caught?.paymentHash).toBe(mine.paymentHash);
	} finally {
		alone.stop();
		late.stop();
	}
});

test("an instance on a new key refuses the facts the old key signed, which is what rotating means", () => {
	const NEXT_KEY = Buffer.from("11".repeat(32), "hex");
	const nothingSeen = { accepted: {}, paid: {}, outbox: {}, delivered: {} };

	const before = openStore();
	const taken = before.store.insert(payment(0));
	const { facts } = before.store.gossip.since(nothingSeen);
	before.stop();

	const rolled = openStore({ key: NEXT_KEY });
	try {
		expect(refusals(() => rolled.store.gossip.onFacts(facts))).toContainEqual(
			expect.stringContaining("without the cluster key"),
		);
		expect(rolled.store.get(taken.id)).toBeNull();
	} finally {
		rolled.stop();
	}
});

test("a ledger rolled onto a new key keeps every payment, because the facts are re-signed", () => {
	const directory = mkdtempSync(join(tmpdir(), "tbd-rolled-"));
	const ledgerPath = join(directory, "ledger.db");
	const NEXT_KEY = Buffer.from("22".repeat(32), "hex");

	const before = openStore({ ledgerPath });
	const taken = before.store.insert(payment(1));
	before.store.paid(taken.id, preimage(1));
	before.stop();

	const after = openStore({ ledgerPath, key: NEXT_KEY });
	try {
		expect(after.store.get(taken.id)?.status).toBe("paid");

		const settled = after.store.list(10, 1000);
		expect(settled.map((one) => one.id)).toEqual([taken.id]);
	} finally {
		after.stop();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a caller's payment replicates across a rotation, and the old key opens nothing", async () => {
	const directory = mkdtempSync(join(tmpdir(), "tbd-resigned-"));
	const ledgerPath = join(directory, "ledger.db");
	const NEXT_KEY = Buffer.from("33".repeat(32), "hex");
	const nothingSeen = { accepted: {}, paid: {}, outbox: {}, delivered: {} };
	const owner = (await callerKey("rail_rolled_8c2f5a1d")).publicKeyHex;

	const before = openStore({ ledgerPath });
	const taken = before.store.insert({ ...payment(2), caller: owner });
	before.stop();

	const rolled = openStore({ ledgerPath, key: NEXT_KEY });
	const { facts } = rolled.store.gossip.since(nothingSeen);
	rolled.stop();

	const peer = openStore({ key: NEXT_KEY });
	const stale = openStore();
	try {
		peer.store.gossip.onFacts(facts);
		expect(peer.store.get(taken.id)?.paymentHash).toBe(taken.paymentHash);

		expect(refusals(() => stale.store.gossip.onFacts(facts))).toContainEqual(
			expect.stringContaining("without the cluster key"),
		);
		expect(stale.store.get(taken.id)).toBeNull();
	} finally {
		peer.stop();
		stale.stop();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a ledger no key ever stamped is re-signed on its first boot, so rotating while upgrading loses nothing", async () => {
	const directory = mkdtempSync(join(tmpdir(), "tbd-unstamped-"));
	const ledgerPath = join(directory, "ledger.db");
	const NEXT_KEY = Buffer.from("55".repeat(32), "hex");
	const nothingSeen = { accepted: {}, paid: {}, outbox: {}, delivered: {} };
	const owner = (await callerKey("rail_unstamped_2d9e6b4f")).publicKeyHex;

	const before = openStore({ ledgerPath });
	const taken = before.store.insert({ ...payment(4), caller: owner });
	before.stop();
	const unstamped = new DatabaseSync(ledgerPath);
	unstamped.exec("DELETE FROM meta WHERE key = 'ledger-key'");
	unstamped.close();

	const rolled = openStore({ ledgerPath, key: NEXT_KEY });
	const { facts } = rolled.store.gossip.since(nothingSeen);
	rolled.stop();

	const peer = openStore({ key: NEXT_KEY });
	try {
		expect(refusals(() => peer.store.gossip.onFacts(facts))).toEqual([]);
		expect(peer.store.get(taken.id)?.paymentHash).toBe(taken.paymentHash);
	} finally {
		peer.stop();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a payment nobody signed for stops replicating after a rotation, because the key named it", () => {
	const directory = mkdtempSync(join(tmpdir(), "tbd-anonymous-"));
	const ledgerPath = join(directory, "ledger.db");
	const NEXT_KEY = Buffer.from("44".repeat(32), "hex");
	const nothingSeen = { accepted: {}, paid: {}, outbox: {}, delivered: {} };

	const before = openStore({ ledgerPath });
	const taken = before.store.insert(payment(3));
	before.stop();

	const rolled = openStore({ ledgerPath, key: NEXT_KEY });
	const { facts } = rolled.store.gossip.since(nothingSeen);
	const peer = openStore({ key: NEXT_KEY });
	try {
		expect(rolled.store.get(taken.id)?.paymentHash).toBe(taken.paymentHash);
		expect(refusals(() => peer.store.gossip.onFacts(facts))).toContainEqual(
			expect.stringContaining("does not name the invoice"),
		);
		expect(peer.store.get(taken.id)).toBeNull();
	} finally {
		rolled.stop();
		peer.stop();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a payment named after its caller replicates, and the peer checks the name itself", async () => {
	const cluster = await connected();
	try {
		const owner = (await callerKey("rail_cluster_4b8f2e1a9c7d3056")).publicKeyHex;
		const mine = cluster.first.insert({ ...payment(5), caller: owner });

		expect(mine.id).toBe(paymentNamedBy(owner, payment(5).paymentHash));
		await until(
			() => cluster.second.get(mine.id) !== null,
			"the caller's payment to gossip across",
		);

		const settled = cluster.first.paid(mine.id, preimage(5));
		expect(settled.won).toBe(true);
		await until(() => cluster.second.get(mine.id)?.status === "paid", "the paid fact to replicate");
	} finally {
		cluster.stop();
	}
});

test("a fact named after one caller but claiming another is refused, key or no key", async () => {
	const cluster = await connected();
	try {
		const owner = (await callerKey("rail_cluster_4b8f2e1a9c7d3056")).publicKeyHex;
		const misnamed = {
			...spread(101),
			caller: owner,
			id: paymentNamedBy("00".repeat(32), spread(101).paymentHash),
		};
		const fact = {
			origin: "a-peer-that-holds-the-key",
			seq: 1,
			id: misnamed.id,
			payment: JSON.stringify(misnamed),
			acceptedAt: 1_700_000_000,
			expiresAt: misnamed.expiresAt,
		};

		expect(
			refusals(() =>
				cluster.first.gossip.onFacts({
					accepted: [{ ...fact, mac: signedAsCluster("accepted", Object.values(fact)) }],
				}),
			),
		).toContainEqual(expect.stringContaining("does not name the invoice it watches"));

		expect(cluster.first.get(misnamed.id)).toBeNull();
	} finally {
		cluster.stop();
	}
});

test("every kind of fact survives a rotation, because re-signing reads the same fields the signing did", async () => {
	const directory = mkdtempSync(join(tmpdir(), "tbd-allkinds-"));
	const ledgerPath = join(directory, "ledger.db");
	const NEXT_KEY = Buffer.from("55".repeat(32), "hex");
	const nothingSeen = { accepted: {}, paid: {}, outbox: {}, delivered: {} };
	const owner = (await callerKey("rail_allkinds_1f7b")).publicKeyHex;

	const before = openStore({ ledgerPath });
	const mine = before.store.insert({
		...payment(4),
		caller: owner,
		webhooks: [{ url: "https://shop.example/hooks/one" }],
	});
	before.store.paid(mine.id, preimage(4));
	const owed = before.store.dueDeliveries(10, 0);
	expect(owed).toHaveLength(1);
	before.store.delivered(owed[0]!);
	expect(before.store.info().rows).toMatchObject({ accepted: 1, paid: 1, outbox: 1, delivered: 1 });
	before.stop();

	const rolled = openStore({ ledgerPath, key: NEXT_KEY });
	const { facts } = rolled.store.gossip.since(nothingSeen);
	rolled.stop();

	const peer = openStore({ key: NEXT_KEY });
	try {
		peer.store.gossip.onFacts(facts);

		expect(peer.store.info().rows).toMatchObject({
			accepted: 1,
			paid: 1,
			outbox: 1,
			delivered: 1,
		});
	} finally {
		peer.stop();
		rmSync(directory, { recursive: true, force: true });
	}
});

const WEBHOOK_KEY = await signingKeyFromSeed(new Uint8Array(32).fill(7));

type Trio = { opened: Opened[]; stores: Store[]; stop: () => void };

async function trio(): Promise<Trio> {
	const ports = [await freePort(), await freePort(), await freePort()];
	const opened = [
		openStore({ listenPort: ports[0] }),
		openStore({ listenPort: ports[1], peers: [`127.0.0.1:${ports[0]}`] }),
		openStore({ listenPort: ports[2], peers: [`127.0.0.1:${ports[0]}`, `127.0.0.1:${ports[1]}`] }),
	];
	await until(
		() => opened.every((one) => one.store.info().peers === 2),
		"three instances to find each other",
	);
	const stopped = new Set<Opened>();

	return {
		opened,
		stores: opened.map((one) => one.store),
		stop: () => {
			for (const one of opened) {
				if (!stopped.has(one)) {
					stopped.add(one);
					one.stop();
				}
			}
		},
	};
}

function watching(store: Store, send: Send): Watcher {
	return {
		store,
		eagerDelayMs: 5_000,
		budget: {
			perSecond: 1000,
			perTick: 100,
			nextAt: new Map(),
			pace: new Map(),
			ceiling: new Map(),
			sharedBy: () => store.instances(),
		},
		webhookKey: WEBHOOK_KEY,
		agents: new Map(),
		send,
	};
}

function wallet(asked: Store[], who: Store, settled: () => boolean): Send {
	return async () => {
		asked.push(who);
		return Response.json(settled() ? { settled: true, preimage: preimage(0) } : { settled: false });
	};
}

function byTurn(stores: Store[], id: string): Store[] {
	return stores.toSorted((one, other) => inLine(one, id) - inLine(other, id));
}

async function heldByAll(stores: Store[], id: string): Promise<void> {
	await until(
		() => stores.every((one) => one.get(id) !== null),
		"every instance to hold the payment",
	);
}

test("three instances ask the wallet once per turn, and all three move on to the answer's next turn", async () => {
	const cluster = await trio();
	try {
		const now = unixNow();
		at(now);
		const made = cluster.stores[0]!.insert(fresh(0));
		await heldByAll(cluster.stores, made.id);
		const asked: Store[] = [];

		await Promise.all(
			cluster.stores.map((one) =>
				tick(
					watching(
						one,
						wallet(asked, one, () => false),
					),
				),
			),
		);

		expect(asked).toEqual([byTurn(cluster.stores, made.id)[0]]);
		await until(
			() =>
				byTurn(cluster.stores, made.id)
					.map((one) => one.nextDueAt())
					.join() === [now + 5, now + 10, now + 15].join(),
			"the other two to move on to the same next turn",
		);
	} finally {
		cluster.stop();
	}
});

test("when the first in line is gone, the second polls one poll interval later and the third still waits", async () => {
	const cluster = await trio();
	try {
		const now = unixNow();
		at(now);
		const made = cluster.stores[0]!.insert(fresh(0));
		await heldByAll(cluster.stores, made.id);
		const [first, second, third] = byTurn(cluster.stores, made.id) as [Store, Store, Store];
		cluster.opened.find((one) => one.store === first)!.stop();
		await until(
			() => second.info().peers === 1 && third.info().peers === 1,
			"the survivors to notice",
		);
		const asked: Store[] = [];

		at(now + 5);
		await Promise.all(
			[second, third].map((one) =>
				tick(
					watching(
						one,
						wallet(asked, one, () => false),
					),
				),
			),
		);

		expect(asked).toEqual([second]);
	} finally {
		cluster.stop();
	}
});

test("a first in line that cannot reach the wallet hands its turn on at once, and the second settles it", async () => {
	const cluster = await trio();
	try {
		const now = unixNow();
		at(now);
		const made = cluster.stores[0]!.insert(fresh(0));
		await heldByAll(cluster.stores, made.id);
		const [first, second, third] = byTurn(cluster.stores, made.id) as [Store, Store, Store];
		const asked: Store[] = [];
		const cutOff: Send = async (url) => {
			throw new Error(`${url} is unreachable from here`);
		};

		await tick(watching(first, cutOff));
		await until(() => second.nextDueAt() === now, "the miss to hand the turn to the second");
		await Promise.all(
			[second, third].map((one) =>
				tick(
					watching(
						one,
						wallet(asked, one, () => true),
					),
				),
			),
		);

		expect(asked).toEqual([second]);
		await until(
			() => cluster.stores.every((one) => one.get(made.id)?.status === "paid"),
			"the settlement to reach every instance",
		);
	} finally {
		cluster.stop();
	}
});

const AGENT = "ab".repeat(32);

class AnsweringAgent {
	asked = 0;
	private heard: ((said: unknown) => void) | null = null;

	on(event: string, listener: (said: unknown) => void): this {
		if (event === "message") {
			this.heard = listener;
		}
		return this;
	}

	off(): this {
		this.heard = null;
		return this;
	}

	send(frame: string): void {
		this.asked += 1;
		const { ask } = JSON.parse(frame) as { ask: string };
		this.heard?.(JSON.stringify({ ask, settled: false }));
	}
}

test("the instance holding the agent's socket asks on time wherever the hash puts it, and the others stand aside", async () => {
	const cluster = await trio();
	try {
		const now = unixNow();
		at(now);
		const watched = { ...fresh(0), verifyUrl: `agent:${AGENT}` };
		const id = cluster.stores[0]!.names({ caller: null, paymentHash: watched.paymentHash });
		const holder = byTurn(cluster.stores, id)[2]!;
		holder.answersAlone = (verifyUrl) => verifyUrl === watched.verifyUrl;
		const agent = new AnsweringAgent();
		const nothingFetched: Send = async (url) => {
			throw new Error(`${url} must not be fetched for an agent payment`);
		};

		cluster.stores[0]!.insert(watched);
		await heldByAll(cluster.stores, id);
		await Promise.all(
			cluster.stores.map((one) => {
				const watcher = watching(one, nothingFetched);
				if (one === holder) {
					watcher.agents = new Map([[AGENT, new Set([agent as never])]]);
				}
				return tick(watcher);
			}),
		);

		expect(agent.asked).toBe(1);
		expect(holder.nextDueAt()).toBe(now + 5);
	} finally {
		cluster.stop();
	}
});

test("an instance that finds its own address among its peers drops it quietly and never dials it again", async () => {
	const port = await freePort();
	const relay = await freePort();
	let dialled = 0;
	const hop = createServer((incoming) => {
		dialled += 1;
		const onward = connect({ host: "127.0.0.1", port });
		incoming.pipe(onward).pipe(incoming);
		incoming.on("error", () => onward.destroy());
		onward.on("error", () => incoming.destroy());
	}).listen(relay);
	const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
	const alone = openStore({ listenPort: port, peers: [`127.0.0.1:${relay}`] });
	try {
		await until(() => dialled === 1, "the instance to dial its own address");
		await new Promise((waited) => setTimeout(waited, 2500));

		expect(dialled).toBe(1);
		expect(warned).not.toHaveBeenCalled();
		expect(alone.store.info().peers).toBe(0);
	} finally {
		warned.mockRestore();
		alone.stop();
		hop.close();
	}
});
