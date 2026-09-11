import { setTimeout as sleep } from "node:timers/promises";

import { expect, test, vi } from "vitest";

import { signingKeyFromSeed, verifyHex } from "../core/ed25519.ts";
import type { Send } from "../core/outbound.ts";
import type { Agents } from "./agents.ts";
import type { Delivery, Payment } from "./payment.ts";
import type { Settled, Store } from "./store.ts";
import {
	type Budget,
	confirmWebhook,
	nextDue,
	pollDelayMs,
	spend,
	tick,
	unixNow,
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
	send: Send;
	calls: Call[];
} {
	const calls: Call[] = [];
	const send: Send = async (url, sent) => {
		const call = {
			url,
			method: sent.method ?? "GET",
			headers: sent.headers ?? {},
			body: sent.body ?? "",
		};
		calls.push(call);
		return answer(call);
	};

	return { send, calls };
}

function counting(answer: (url: string) => Response): { send: Send; peak: () => number } {
	let live = 0;
	let peak = 0;
	let bothInFlight = () => {};
	const overlapped = new Promise<void>((resolve) => (bothInFlight = resolve));
	const send: Send = async (url) => {
		live += 1;
		peak = Math.max(peak, live);
		if (live >= 2) {
			bothInFlight();
		}
		await Promise.race([overlapped, sleep(NEVER_OVERLAPPED_MS)]);
		live -= 1;

		return answer(url);
	};

	return { send, peak: () => peak };
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
		replay: 0,
		sealed: null,
		caller: null,
		webhooks: [{ url: HOOK_URL }],
		...overrides,
	};
}

function queueing(send: Send, work: Payment[], settle: (id: string, preimage: string) => Settled) {
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

	return {
		parked,
		handed,
		watcher: {
			store,
			eagerDelayMs: 5,
			budget: paced(),
			webhookKey: GATEWAY_KEY,
			agents: new Map(),
			send,
		} satisfies Watcher,
	};
}

function owing(send: Send, work: Delivery[]) {
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
		watcher: {
			store,
			eagerDelayMs: 5,
			budget: paced(),
			webhookKey: GATEWAY_KEY,
			agents: new Map(),
			send,
		} satisfies Watcher,
	};
}

function owed(overrides: Partial<Delivery> = {}): Delivery {
	return {
		origin: "0f".repeat(16),
		seq: 1,
		id: "aa".repeat(32),
		url: HOOK_URL,
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
	const { parked, handed, watcher } = queueing(wire.send, [payment()], settlesAs(true));

	await tick(watcher);

	expect(wire.calls.map((call) => call.url)).toEqual([VERIFY_URL]);
	expect(handed).toEqual([]);
	expect(parked).toHaveLength(1);
	expect(parked[0]?.dueAt).toBeGreaterThan(unixNow());
});

const CALLER = "ab".repeat(32);

class AnsweringSocket {
	private heard: ((said: unknown) => void) | null = null;

	constructor(private readonly answer: (ask: string) => unknown) {}

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
		const { ask } = JSON.parse(frame) as { ask: string };
		this.heard?.(JSON.stringify(this.answer(ask)));
	}
}

function attending(answer: (ask: string) => unknown): Agents {
	return new Map([[CALLER, new Set([new AnsweringSocket(answer) as never])]]);
}

test("a payment answered by an agent settles without a request leaving the gateway", async () => {
	const wire = intercepting(() => {
		throw new Error("an agent payment must not be fetched");
	});
	const { handed, watcher } = queueing(
		wire.send,
		[payment({ verifyUrl: `agent:${CALLER}` })],
		settlesAs(false),
	);
	watcher.agents = attending((ask) => ({ ask, settled: true, preimage: PREIMAGE }));

	await tick(watcher);

	expect(handed).toEqual([PREIMAGE]);
});

test("a payment whose agent is offline is left due rather than failed", async () => {
	const wire = intercepting(() => {
		throw new Error("an agent payment must not be fetched");
	});
	const { parked, handed, watcher } = queueing(
		wire.send,
		[payment({ verifyUrl: `agent:${CALLER}` })],
		settlesAs(false),
	);

	await tick(watcher);

	expect(handed).toEqual([]);
	expect(parked).toHaveLength(1);
});

test("a settled payment is handed to the store with its preimage", async () => {
	const wire = intercepting((call) =>
		call.url === VERIFY_URL ? verified(true) : new Response(""),
	);
	const { parked, handed, watcher } = queueing(wire.send, [payment()], settlesAs(false));

	await tick(watcher);

	expect(handed).toEqual([PREIMAGE]);
	expect(parked).toEqual([]);
});

test("a payment at its expiry is asked once more and then parked for good", async () => {
	const wire = intercepting(() => verified(false));
	const expiring = payment({ createdAt: unixNow() - 3600, expiresAt: unixNow() });
	const { parked, watcher } = queueing(wire.send, [expiring], settlesAs(true));

	await tick(watcher);

	expect(wire.calls.map((call) => call.url)).toEqual([VERIFY_URL]);
	expect(parked).toEqual([{ id: expiring.id, dueAt: null }]);
});

test("a webhook the merchant takes is struck off the outbox", async () => {
	const wire = intercepting(() => new Response("", { status: 200 }));
	const { done, failed, watcher } = owing(wire.send, [owed()]);

	await tick(watcher);

	expect(wire.calls.map((call) => call.url)).toEqual([HOOK_URL]);
	expect(done).toEqual([HOOK_URL]);
	expect(failed).toEqual([]);
});

test("a webhook the merchant rejects goes back on the outbox", async () => {
	const wire = intercepting(() => new Response("", { status: 500 }));
	const quiet = console.warn;
	console.warn = () => {};
	const { done, failed, watcher } = owing(wire.send, [owed()]);

	try {
		await tick(watcher);

		expect(done).toEqual([]);
		expect(failed).toEqual([HOOK_URL]);
	} finally {
		console.warn = quiet;
	}
});

test("a delivery is signed with the key the gateway publishes, and nothing of the receiver's", async () => {
	const wire = intercepting(() => new Response("", { status: 200 }));
	const url = "https://other.example/hook";
	const { watcher } = owing(wire.send, [owed({ url })]);

	await tick(watcher);

	const sent = wire.calls.find((call) => call.url === url);
	const signature = sent?.headers["x-signature"] ?? "";
	const stamp = sent?.headers["x-timestamp"] ?? "";

	expect(signature).toMatch(/^ed25519=[0-9a-f]{128}$/);
	expect(stamp).toMatch(/^\d{10}$/);

	const payload = new TextEncoder().encode(`${stamp}.${owed().body}`);
	expect(
		await verifyHex(GATEWAY_KEY.publicKeyHex, signature.slice("ed25519=".length), payload),
	).toBe(true);
});

test("the webhook carries a deadline, and one that runs out puts it back on the outbox", async () => {
	const deadlines: unknown[] = [];
	const wire = {
		send: (async (_url, _sent, signal) => {
			deadlines.push(signal);
			throw new DOMException("The operation was aborted", "TimeoutError");
		}) satisfies Send,
	};
	const quiet = console.warn;
	console.warn = () => {};
	const { done, failed, watcher } = owing(wire.send, [owed()]);

	try {
		await tick(watcher);

		expect(deadlines[0]).toBeInstanceOf(AbortSignal);
		expect(done).toEqual([]);
		expect(failed).toEqual([HOOK_URL]);
	} finally {
		console.warn = quiet;
	}
});

test("a settlement the store refuses leaves the rest of the batch alone", async () => {
	const wire = intercepting(() => verified(true));
	const quiet = console.error;
	console.error = () => {};
	const doomed = payment({ id: "doomed" });
	const survivor = payment({ id: "survivor" });
	const { handed, watcher } = queueing(wire.send, [doomed, survivor], (id, preimage) => {
		if (id === "doomed") {
			throw new Error("payment doomed is not on the worklist");
		}

		return { payment: payment({ status: "paid", preimage }), won: false };
	});

	try {
		await tick(watcher);

		expect(wire.calls.map((call) => call.url)).toEqual([VERIFY_URL, VERIFY_URL]);
		expect(handed).toEqual([PREIMAGE, PREIMAGE]);
	} finally {
		console.error = quiet;
	}
});

test("the polls in one batch go out together, so a slow wallet does not hold up the rest", async () => {
	const wire = counting(() => verified(false));
	const { parked, watcher } = queueing(
		wire.send,
		[payment({ id: "one" }), payment({ id: "two" })],
		settlesAs(true),
	);

	await tick(watcher);

	expect(wire.peak()).toBe(2);
	expect(parked).toHaveLength(2);
});

test("a poll and a webhook owed in the same tick go out together, not one after the other", async () => {
	const wire = counting((url) =>
		url === VERIFY_URL ? verified(false) : new Response("", { status: 200 }),
	);
	const store = {
		duePolls: () => [payment()],
		dueDeliveries: () => [owed()],
		polled: () => {},
		delivered: () => {},
	} as unknown as Store;

	await tick({
		store,
		eagerDelayMs: 5,
		budget: paced(),
		webhookKey: GATEWAY_KEY,
		send: wire.send,
		agents: new Map(),
	});

	expect(wire.peak()).toBe(2);
});

test("the next poll never lands after the invoice has expired", () => {
	vi.useFakeTimers();
	try {
		const now = unixNow();

		expect(nextDue(payment({ createdAt: now, expiresAt: now + 3600 }), 5000)).toBe(now + 5);
		expect(nextDue(payment({ createdAt: now - 600, expiresAt: now + 3600 }), 5000)).toBe(now + 60);
		expect(nextDue(payment({ createdAt: now - 600, expiresAt: now + 10 }), 5000)).toBe(now + 10);
		expect(nextDue(payment({ createdAt: now, expiresAt: now }), 5000)).toBeNull();
		expect(
			nextDue(payment({ createdAt: now - 2_592_000, expiresAt: now + 3600 }), 5000),
		).toBeNull();
	} finally {
		vi.useRealTimers();
	}
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
	const { parked, watcher } = queueing(
		wire.send,
		[payment(), payment({ id: "bb".repeat(32) })],
		settlesAs(true),
	);

	await tick(watcher);

	expect(watcher.budget.pace.get("coinos.io")).toBe(60);
	expect(parked[0]?.dueAt).toBe(unixNow() + 60);
	expect(parked[1]?.dueAt).toBe(unixNow() + 60);
});

test("an endpoint that names its own ceiling is spaced by that, not by the operator's number", async () => {
	const wire = intercepting(() =>
		Response.json(
			{ settled: false },
			{ headers: { "cache-control": "max-age=5", "ratelimit-limit": "30;w=60" } },
		),
	);
	const { watcher } = queueing(wire.send, [payment()], settlesAs(true));

	await tick(watcher);
	expect(watcher.budget.ceiling.get("coinos.io")).toBe(0.5);

	const started = Date.now();
	await spend(watcher.budget, "coinos.io");
	await spend(watcher.budget, "coinos.io");

	expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
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
	const { watcher } = queueing(wire.send, [payment()], settlesAs(true));

	await tick(watcher);

	expect(watcher.budget.pace.get("coinos.io")).toBe(3600);
});

test("a host asking to be polled without pause is given a second, which is the floor", async () => {
	for (const asked of ["max-age=0", "max-age=0, must-revalidate", "no-cache, max-age=0"]) {
		const wire = intercepting(() =>
			Response.json({ settled: false }, { headers: { "cache-control": asked } }),
		);
		const { watcher } = queueing(wire.send, [payment()], settlesAs(true));

		await tick(watcher);

		expect(watcher.budget.pace.get("coinos.io")).toBe(1);
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
			agents: new Map(),
			send: wire.send,
		});

		expect(said.filter((line) => line.includes("abandoned"))).toHaveLength(1);
	} finally {
		console.error = loud;
		console.warn = quiet;
	}
});

function echoing(call: Call): Response {
	return Response.json({ nonce: (JSON.parse(call.body) as { nonce: string }).nonce });
}

test("a challenge is signed with the gateway's own key, so a receiver can tell who is asking", async () => {
	const wire = intercepting((call) => echoing(call));
	expect(
		await confirmWebhook({ send: wire.send, webhookKey: GATEWAY_KEY }, { url: HOOK_URL }),
	).toBe(true);

	const sent = wire.calls[0]!;
	const signature = sent.headers["x-signature"] ?? "";
	expect(signature).toMatch(/^ed25519=[0-9a-f]{128}$/);

	const payload = new TextEncoder().encode(`${sent.headers["x-timestamp"]}.${sent.body}`);
	expect(
		await verifyHex(GATEWAY_KEY.publicKeyHex, signature.slice("ed25519=".length), payload),
	).toBe(true);
});

test("a challenge answered wrongly leaves the webhook unconfirmed, whichever way it is wrong", async () => {
	const quiet = console.warn;
	console.warn = () => {};
	const refusing = {
		...intercepting(() => new Response("no thanks", { status: 500 })),
		webhookKey: GATEWAY_KEY,
		agents: new Map(),
	};
	const silent = () => Response.json({});
	const inventing = () => Response.json({ nonce: "f".repeat(64) });

	try {
		expect(await confirmWebhook(refusing, { url: HOOK_URL })).toBe(false);

		for (const answering of [silent, inventing]) {
			const wire = intercepting(answering);
			expect(await confirmWebhook({ ...wire, webhookKey: GATEWAY_KEY }, { url: HOOK_URL })).toBe(
				false,
			);
		}
	} finally {
		console.warn = quiet;
	}
});
