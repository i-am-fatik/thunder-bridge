import { setTimeout as sleep } from "node:timers/promises";

import { expect, test, vi } from "vitest";

import { signingKeyFromSeed, verifyHex } from "../core/ed25519.ts";
import type { Delivery, Payment } from "./payment.ts";
import type { Settled, Store } from "./store.ts";
import {
	CHALLENGE,
	confirmWebhook,
	nextDue,
	pollDelayMs,
	sign,
	spend,
	tick,
	unixNow,
	type Budget,
	type Watcher,
} from "./watch.ts";

vi.mock("node:dns/promises", () => ({ lookup: everyHostResolvesPublic }));

async function everyHostResolvesPublic(): Promise<{ address: string; family: number }[]> {
	return [{ address: "203.0.113.1", family: 4 }];
}

const GATEWAY_KEY = await signingKeyFromSeed(new Uint8Array(32).fill(3));

const PREIMAGE = "0".repeat(64);
const PAYMENT_HASH = "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925";
const VERIFY_URL = "https://coinos.io/api/lnurl/verify/1";
const HOOK_URL = "https://shop.example/hooks/lightning";
const NEVER_OVERLAPPED_MS = 2000;

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

function intercepting(answer: (call: Call) => Response | Promise<Response>): {
	calls: Call[];
	restore: () => void;
} {
	const real = globalThis.fetch;
	const calls: Call[] = [];
	globalThis.fetch = ((target: string | URL | Request, options?: RequestInit) => {
		const call = {
			url: String(target),
			method: options?.method ?? "GET",
			headers: (options?.headers as Record<string, string>) ?? {},
			body: String(options?.body ?? ""),
		};
		calls.push(call);
		return Promise.resolve(answer(call));
	}) as typeof fetch;

	return { calls, restore: () => void (globalThis.fetch = real) };
}

function counting(answer: (url: string) => Response): { peak: () => number; restore: () => void } {
	const real = globalThis.fetch;
	let live = 0;
	let peak = 0;
	let bothInFlight = () => {};
	const overlapped = new Promise<void>((resolve) => (bothInFlight = resolve));
	globalThis.fetch = (async (target: string | URL | Request) => {
		live += 1;
		peak = Math.max(peak, live);
		if (live >= 2) bothInFlight();
		await Promise.race([overlapped, sleep(NEVER_OVERLAPPED_MS)]);
		live -= 1;

		return answer(String(target));
	}) as unknown as typeof fetch;

	return { peak: () => peak, restore: () => void (globalThis.fetch = real) };
}

function paced(perSecond = 1000): Budget {
	return { perSecond, perTick: 100, nextAt: new Map(), pace: new Map(), ceiling: new Map() };
}

function payment(overrides: Partial<Payment> = {}): Payment {
	return {
		id: "aa".repeat(32),
		lnAddress: "charter@coinos.io",
		amountMsat: 21_000,
		status: "pending",
		paymentHash: PAYMENT_HASH,
		bolt11: "lnbc210n1",
		preimage: null,
		expiresAt: unixNow() + 3600,
		createdAt: unixNow(),
		verifyUrl: VERIFY_URL,
		trigger: null,
		sealed: null,
		caller: null,
		webhooks: [{ url: HOOK_URL, secret: "hunter2" }],
		...overrides,
	};
}

function queueing(work: Payment[], settle: (id: string, preimage: string) => Settled) {
	const due = [...work];
	const parked: { id: string; dueAt: number | null }[] = [];
	const handed: string[] = [];
	const store = {
		duePolls: (limit: number) => due.splice(0, limit),
		dueDeliveries: () => [],
		polled: (id: string, dueAt: number | null) => {
			parked.push({ id, dueAt });
		},
		paid: (id: string, preimage: string) => {
			handed.push(preimage);
			return settle(id, preimage);
		},
	} as unknown as Store;

	return { parked, handed, watcher: { store, eagerDelayMs: 5, budget: paced(), webhookKey: GATEWAY_KEY } satisfies Watcher };
}

function owing(work: Delivery[]) {
	const due = [...work];
	const done: string[] = [];
	const failed: string[] = [];
	const store = {
		duePolls: () => [],
		dueDeliveries: (limit: number) => due.splice(0, limit),
		delivered: (owed: Delivery) => {
			done.push(owed.url);
		},
		undelivered: (owed: Delivery) => {
			failed.push(owed.url);
		},
	} as unknown as Store;

	return {
		done,
		failed,
		watcher: { store, eagerDelayMs: 5, budget: paced(), webhookKey: GATEWAY_KEY } satisfies Watcher,
	};
}

function owed(overrides: Partial<Delivery> = {}): Delivery {
	return {
		origin: "0f".repeat(16),
		seq: 1,
		id: "aa".repeat(32),
		url: HOOK_URL,
		secret: "hunter2",
		body: '{"id":"aa","status":"paid","preimage":"00"}',
		...overrides,
	};
}

function verified(settled: boolean): Response {
	return Response.json(settled ? { settled: true, preimage: PREIMAGE } : { settled: false });
}

function settlesAs(won: boolean): (id: string, preimage: string) => Settled {
	return (_id, preimage) => ({ payment: payment({ status: "paid", preimage }), won });
}

test("an unsettled payment goes back on the queue with a later due time", async () => {
	const wire = intercepting(() => verified(false));
	const { parked, handed, watcher } = queueing([payment()], settlesAs(true));

	try {
		await tick(watcher);

		expect(wire.calls.map((call) => call.url)).toEqual([VERIFY_URL]);
		expect(handed).toEqual([]);
		expect(parked).toHaveLength(1);
		expect(parked[0]?.dueAt).toBeGreaterThan(unixNow());
	} finally {
		wire.restore();
	}
});

test("a settled payment is handed to the store with its preimage", async () => {
	const wire = intercepting((call) => (call.url === VERIFY_URL ? verified(true) : new Response("")));
	const { parked, handed, watcher } = queueing([payment()], settlesAs(false));

	try {
		await tick(watcher);

		expect(handed).toEqual([PREIMAGE]);
		expect(parked).toEqual([]);
	} finally {
		wire.restore();
	}
});

test("a payment at its expiry is asked once more and then parked for good", async () => {
	const wire = intercepting(() => verified(false));
	const expiring = payment({ createdAt: unixNow() - 3600, expiresAt: unixNow() });
	const { parked, watcher } = queueing([expiring], settlesAs(true));

	try {
		await tick(watcher);

		expect(wire.calls.map((call) => call.url)).toEqual([VERIFY_URL]);
		expect(parked).toEqual([{ id: expiring.id, dueAt: null }]);
	} finally {
		wire.restore();
	}
});

test("a webhook the merchant takes is struck off the outbox", async () => {
	const wire = intercepting(() => new Response("", { status: 200 }));
	const { done, failed, watcher } = owing([owed()]);

	try {
		await tick(watcher);

		expect(wire.calls.map((call) => call.url)).toEqual([HOOK_URL]);
		expect(done).toEqual([HOOK_URL]);
		expect(failed).toEqual([]);
	} finally {
		wire.restore();
	}
});

test("a webhook the merchant rejects goes back on the outbox", async () => {
	const wire = intercepting(() => new Response("", { status: 500 }));
	const quiet = console.warn;
	console.warn = () => {};
	const { done, failed, watcher } = owing([owed()]);

	try {
		await tick(watcher);

		expect(done).toEqual([]);
		expect(failed).toEqual([HOOK_URL]);
	} finally {
		console.warn = quiet;
		wire.restore();
	}
});

test("the webhook posts the stored body, signed with the merchant's secret where there is one", async () => {
	const wire = intercepting(() => new Response("", { status: 200 }));
	const { watcher } = owing([owed()]);

	try {
		await tick(watcher);

		const signed = wire.calls.find((call) => call.url === HOOK_URL);

		expect(signed?.method).toBe("POST");
		expect(signed?.body).toBe(owed().body);
		expect(signed?.headers["x-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);

		const stamp = signed?.headers["x-timestamp"] ?? "";
		expect(`sha256=${await sign("hunter2", `${stamp}.${owed().body}`)}`).toBe(
			signed?.headers["x-signature"] ?? "",
		);
	} finally {
		wire.restore();
	}
});

test("a webhook that handed over no secret is signed with the gateway's own key instead", async () => {
	const wire = intercepting(() => new Response("", { status: 200 }));
	const url = "https://other.example/hook";
	const { watcher } = owing([owed({ url, secret: null })]);

	try {
		await tick(watcher);

		const sent = wire.calls.find((call) => call.url === url);
		const signature = sent?.headers["x-signature"] ?? "";
		const stamp = sent?.headers["x-timestamp"] ?? "";

		expect(signature).toMatch(/^ed25519=[0-9a-f]{128}$/);
		expect(stamp).toMatch(/^\d{10}$/);

		const payload = new TextEncoder().encode(`${stamp}.${owed().body}`);
		expect(await verifyHex(GATEWAY_KEY.publicKeyHex, signature.slice("ed25519=".length), payload)).toBe(
			true,
		);
	} finally {
		wire.restore();
	}
});

test("the webhook carries a deadline, and one that runs out puts it back on the outbox", async () => {
	const deadlines: unknown[] = [];
	const real = globalThis.fetch;
	globalThis.fetch = ((_target: string | URL | Request, options?: RequestInit) => {
		deadlines.push(options?.signal);
		return Promise.reject(new DOMException("The operation was aborted", "TimeoutError"));
	}) as typeof fetch;
	const quiet = console.warn;
	console.warn = () => {};
	const { done, failed, watcher } = owing([owed()]);

	try {
		await tick(watcher);

		expect(deadlines[0]).toBeInstanceOf(AbortSignal);
		expect(done).toEqual([]);
		expect(failed).toEqual([HOOK_URL]);
	} finally {
		console.warn = quiet;
		globalThis.fetch = real;
	}
});

test("a settlement the store refuses leaves the rest of the batch alone", async () => {
	const wire = intercepting(() => verified(true));
	const quiet = console.error;
	console.error = () => {};
	const doomed = payment({ id: "doomed" });
	const survivor = payment({ id: "survivor" });
	const { handed, watcher } = queueing([doomed, survivor], (id, preimage) => {
		if (id === "doomed") throw new Error("payment doomed is not on the worklist");

		return { payment: payment({ status: "paid", preimage }), won: false };
	});

	try {
		await tick(watcher);

		expect(wire.calls.map((call) => call.url)).toEqual([VERIFY_URL, VERIFY_URL]);
		expect(handed).toEqual([PREIMAGE, PREIMAGE]);
	} finally {
		console.error = quiet;
		wire.restore();
	}
});

test("the polls in one batch go out together, so a slow wallet does not hold up the rest", async () => {
	const wire = counting(() => verified(false));
	const { parked, watcher } = queueing([payment({ id: "one" }), payment({ id: "two" })], settlesAs(true));

	try {
		await tick(watcher);

		expect(wire.peak()).toBe(2);
		expect(parked).toHaveLength(2);
	} finally {
		wire.restore();
	}
});

test("a poll and a webhook owed in the same tick go out together, not one after the other", async () => {
	const wire = counting((url) => (url === VERIFY_URL ? verified(false) : new Response("", { status: 200 })));
	const store = {
		duePolls: () => [payment()],
		dueDeliveries: () => [owed()],
		polled: () => {},
		delivered: () => {},
	} as unknown as Store;

	try {
		await tick({ store, eagerDelayMs: 5, budget: paced(), webhookKey: GATEWAY_KEY });

		expect(wire.peak()).toBe(2);
	} finally {
		wire.restore();
	}
});

test("the next poll never lands after the invoice has expired", () => {
	vi.useFakeTimers();
	try {
		const now = unixNow();

		expect(nextDue(payment({ createdAt: now, expiresAt: now + 3600 }), 5000)).toBe(now + 5);
		expect(nextDue(payment({ createdAt: now - 600, expiresAt: now + 3600 }), 5000)).toBe(now + 60);
		expect(nextDue(payment({ createdAt: now - 600, expiresAt: now + 10 }), 5000)).toBe(now + 10);
		expect(nextDue(payment({ createdAt: now, expiresAt: now }), 5000)).toBeNull();
		expect(nextDue(payment({ createdAt: now - 259_200, expiresAt: now + 3600 }), 5000)).toBeNull();
	} finally {
		vi.useRealTimers();
	}
});

test("the signature is an hmac a receiver can recompute", async () => {
	expect(await sign("key", "The quick brown fox jumps over the lazy dog")).toBe(
		"f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
	);
});

test("one busy wallet host does not slow the polls aimed at another", async () => {
	const budget = paced(5);
	await spend(budget, "coinos.io");

	const started = Date.now();
	await spend(budget, "getalby.com");
	expect(Date.now() - started).toBeLessThan(50);

	await spend(budget, "coinos.io");
	expect(Date.now() - started).toBeGreaterThanOrEqual(150);
});

test("an endpoint that asks for a pace is polled at it, and one that does not keeps the old rule", async () => {
	const wire = intercepting(() =>
		Response.json({ settled: false }, { headers: { "cache-control": "public, max-age=60" } }),
	);
	const { parked, watcher } = queueing([payment(), payment({ id: "bb".repeat(32) })], settlesAs(true));

	try {
		await tick(watcher);

		expect(watcher.budget.pace.get("coinos.io")).toBe(60);
		expect(parked[0]?.dueAt).toBe(unixNow() + 60);
		expect(parked[1]?.dueAt).toBe(unixNow() + 60);
	} finally {
		wire.restore();
	}
});

test("an endpoint that names its own ceiling is spaced by that, not by the operator's number", async () => {
	const wire = intercepting(() =>
		Response.json(
			{ settled: false },
			{ headers: { "cache-control": "max-age=5", "ratelimit-limit": "30;w=60" } },
		),
	);
	const { watcher } = queueing([payment()], settlesAs(true));

	try {
		await tick(watcher);
		expect(watcher.budget.ceiling.get("coinos.io")).toBe(0.5);

		const started = Date.now();
		await spend(watcher.budget, "coinos.io");
		await spend(watcher.budget, "coinos.io");

		expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
	} finally {
		wire.restore();
	}
});

test("a host that names no ceiling still falls back to the operator's number", async () => {
	const budget = paced(5);

	const started = Date.now();
	await spend(budget, "coinos.io");
	await spend(budget, "coinos.io");

	expect(Date.now() - started).toBeGreaterThanOrEqual(190);
	expect(Date.now() - started).toBeLessThan(500);
});

test("a pace nobody could have meant is clamped rather than obeyed", async () => {
	const wire = intercepting(() =>
		Response.json({ settled: false }, { headers: { "cache-control": "max-age=999999" } }),
	);
	const { watcher } = queueing([payment()], settlesAs(true));

	try {
		await tick(watcher);

		expect(watcher.budget.pace.get("coinos.io")).toBe(3600);
	} finally {
		wire.restore();
	}
});

test("a payment is never left staler than a tenth of its own age", () => {
	expect(pollDelayMs(0, 5000)).toBe(5000);
	expect(pollDelayMs(299, 5000)).toBe(5000);
	expect(pollDelayMs(300, 5000)).toBe(30_000);
	expect(pollDelayMs(3600, 5000)).toBe(360_000);
	expect(pollDelayMs(86_400, 5000)).toBe(8_640_000);
	expect(pollDelayMs(259_199, 5000)).toBe(25_919_900);
});

test("a delivery with no retries left is reported at error level, not as one more warning", async () => {
	const said: string[] = [];
	const loud = console.error;
	const quiet = console.warn;
	console.error = (line: string) => void said.push(line);
	console.warn = () => {};
	const abandoning = {
		duePolls: () => [],
		dueDeliveries: () => [owed()],
		delivered: () => {},
		undelivered: () => "abandoned",
	} as unknown as Store;
	const wire = intercepting(() => new Response("nope", { status: 500 }));

	try {
		await tick({
			store: abandoning,
			eagerDelayMs: 5,
			budget: paced(),
			webhookKey: GATEWAY_KEY,
		});

		expect(said.filter((line) => line.includes("abandoned"))).toHaveLength(1);
	} finally {
		wire.restore();
		console.error = loud;
		console.warn = quiet;
	}
});

async function echoing(call: Call, secret: string | null): Promise<Response> {
	const nonce = (JSON.parse(call.body) as { nonce: string }).nonce;
	if (!secret) return Response.json({ nonce });

	return Response.json({ nonce, signature: `sha256=${await sign(secret, nonce)}` });
}

test("a challenge is signed the way a delivery is, so a receiver can tell who is asking", async () => {
	const wire = intercepting((call) => echoing(call, "hunter2"));
	try {
		expect(await confirmWebhook({ url: HOOK_URL, secret: "hunter2" }, GATEWAY_KEY)).toBe(true);

		const sent = wire.calls[0]!;
		expect(sent.url).toBe(HOOK_URL);
		expect(sent.method).toBe("POST");

		const asked = JSON.parse(sent.body) as { type: string; nonce: string };
		expect(asked.type).toBe(CHALLENGE);
		expect(asked.nonce).toMatch(/^[0-9a-f]{64}$/);
		expect(sent.headers["x-signature"]).toBe(
			`sha256=${await sign("hunter2", `${sent.headers["x-timestamp"]}.${sent.body}`)}`,
		);
	} finally {
		wire.restore();
	}
});

test("a webhook that handed over no secret is challenged under the gateway's own key", async () => {
	const wire = intercepting((call) => echoing(call, null));
	try {
		expect(await confirmWebhook({ url: HOOK_URL, secret: null }, GATEWAY_KEY)).toBe(true);

		const sent = wire.calls[0]!;
		const signature = sent.headers["x-signature"] ?? "";
		expect(signature).toMatch(/^ed25519=[0-9a-f]{128}$/);

		const payload = new TextEncoder().encode(`${sent.headers["x-timestamp"]}.${sent.body}`);
		expect(
			await verifyHex(GATEWAY_KEY.publicKeyHex, signature.slice("ed25519=".length), payload),
		).toBe(true);
	} finally {
		wire.restore();
	}
});

test("a challenge answered wrongly leaves the webhook unconfirmed, whichever way it is wrong", async () => {
	const quiet = console.warn;
	console.warn = () => {};
	const refusing = intercepting(() => new Response("no thanks", { status: 500 }));
	const silent = () => Response.json({});
	const inventing = () => Response.json({ nonce: "f".repeat(64) });
	const unsigned = (call: Call) => echoing(call, null);

	try {
		expect(await confirmWebhook({ url: HOOK_URL, secret: null }, GATEWAY_KEY)).toBe(false);
		refusing.restore();

		for (const answering of [silent, inventing]) {
			const wire = intercepting(answering);
			expect(await confirmWebhook({ url: HOOK_URL, secret: null }, GATEWAY_KEY)).toBe(false);
			wire.restore();
		}

		const wire = intercepting(unsigned);
		expect(await confirmWebhook({ url: HOOK_URL, secret: "hunter2" }, GATEWAY_KEY)).toBe(false);
		wire.restore();
	} finally {
		console.warn = quiet;
	}
});
