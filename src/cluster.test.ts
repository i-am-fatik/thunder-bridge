import { createHmac } from "node:crypto";

import { expect, test } from "vitest";

import type { UnsavedPayment } from "./payment.ts";
import type { Store } from "./store.ts";

import { CLUSTER_KEY, freePort, openStore, until, type TestOptions } from "./testing.ts";

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
		sealed: null,
		caller: null,
		webhooks: [{ url: "https://example.com/hook", secret: "hunter2" }],
	};
}

function signedAsCluster(source: string, fields: (string | number | null)[]): string {
	const hmac = createHmac("sha256", CLUSTER_KEY).update(source);
	for (const field of fields) hmac.update("\x00").update(field === null ? "\x01" : String(field));

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

		expect(cluster.second.replay(trigger, 10, 500).map((settled) => settled.id)).toEqual([one.id]);
	} finally {
		cluster.stop();
	}
});

test("every instance takes on every pending payment, whoever created it", async () => {
	const cluster = await connected();
	try {
		const made: string[] = [];
		for (let n = 0; n < 20; n += 1) made.push(cluster.first.insert(spread(n)).id);

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

		expect(() =>
			cluster.first.gossip.onFacts({
				accepted: [{ ...fact, mac: signedAsCluster("accepted", Object.values(fact)) }],
			}),
		).toThrow("does not name the invoice it watches");

		expect(cluster.first.info().rows.accepted).toBe(0);
		expect(cluster.first.get(lying.id)).toBeNull();
	} finally {
		cluster.stop();
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
			() =>
				cluster.first.info().convergedAt !== null && cluster.second.info().convergedAt !== null,
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
		expect(cluster.first.full()).toBe(true);

		await until(
			() => made.every((one) => cluster.second.get(one) !== null),
			"the whole worklist to reach a peer that is already full",
		);
	} finally {
		cluster.stop();
	}
});

test("a mirrored payment stands by, so the instance that took it on polls it first", async () => {
	const cluster = await connected();
	try {
		const mine = cluster.first.insert(payment(0));
		await until(() => cluster.second.get(mine.id) !== null, "the payment to gossip across");

		expect(cluster.second.duePolls(10, 30)).toEqual([]);
		expect(cluster.first.duePolls(10, 30).map((one) => one.id)).toEqual([mine.id]);
	} finally {
		cluster.stop();
	}
});

test("a payment of my own is polled at once, however much a peer handed over", async () => {
	const cluster = await connected();
	try {
		const theirs: string[] = [];
		for (let n = 0; n < 20; n += 1) theirs.push(cluster.first.insert(spread(n)).id);
		await until(
			() => theirs.every((one) => cluster.second.get(one) !== null),
			"the worklist to gossip across",
		);

		const mine = cluster.second.insert(payment(0));

		expect(cluster.second.duePolls(5, 30).map((one) => one.id)).toEqual([mine.id]);
	} finally {
		cluster.stop();
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
			webhooks: [{ url: "https://a.example/hook", secret: null }],
		});
		const theirs = cluster.second.insert({
			...invoice,
			webhooks: [{ url: "https://b.example/hook", secret: null }],
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

test("an instance rolled onto a new key still takes the facts its unrolled peers signed", () => {
	const NEXT_KEY = Buffer.from("11".repeat(32), "hex");
	const nothingSeen = { accepted: {}, paid: {}, outbox: {}, delivered: {} };

	const before = openStore();
	const taken = before.store.insert(payment(0));
	const { facts } = before.store.gossip.since(nothingSeen);
	before.stop();

	const rolled = openStore({ key: NEXT_KEY, retiredKeys: [CLUSTER_KEY] });
	const alone = openStore({ key: NEXT_KEY });
	try {
		rolled.store.gossip.onFacts(facts);
		expect(rolled.store.get(taken.id)?.paymentHash).toBe(taken.paymentHash);

		expect(() => alone.store.gossip.onFacts(facts)).toThrow("without the cluster key");
		expect(alone.store.get(taken.id)).toBeNull();
	} finally {
		rolled.stop();
		alone.stop();
	}
});
