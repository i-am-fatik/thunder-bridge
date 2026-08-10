import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";

import { expect, test } from "vitest";

import { start, type Service } from "./index.ts";
import type { UnsavedPayment } from "./payment.ts";
import {
	ALREADY_WATCHED,
	INVALID_REQUEST,
	KEY_REUSED,
	NO_WALLET_AVAILABLE,
	REQUEST_IN_FLIGHT,
} from "./problem.ts";
import type { Store } from "./store.ts";
import { CLUSTER_KEY, openStore, until } from "./testing.ts";
import { fingerprint, readCreateRequest } from "./wire.ts";

const MSAT_21K = { value: "21000", asset_code: "BTC", asset_scale: 11 };
const PREIMAGE = "00".repeat(32);
const PAYMENT_HASH = "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925";

type App = { service: Service; store: Store; stop: () => void };

async function running(token: string | null = null, drainTimeoutMs = 10_000): Promise<App> {
	const opened = openStore();
	const service = await start(
		{
			port: 0,
			eagerDelayMs: 3000,
			pollsPerSecond: 5,
			tickStallMs: 30_000,
			drainTimeoutMs,
			token,
			key: CLUSTER_KEY,
		},
		opened.store,
	);

	return {
		service,
		store: opened.store,
		stop: () => {
			service.stop();
			opened.stop();
		},
	};
}

function pendingPayment(overrides: Partial<UnsavedPayment> = {}): UnsavedPayment {
	return {
		lnAddress: "charter@coinos.io",
		amountMsat: 21_000,
		status: "pending",
		paymentHash: PAYMENT_HASH,
		bolt11: "lnbc210n1",
		preimage: null,
		expiresAt: 1_900_000_000,
		createdAt: 1_700_000_000,
		verifyUrl: "https://coinos.io/api/lnurl/verify/1",
		trigger: null,
		sealed: null,
		webhooks: [{ url: "https://example.com/hook", secret: "hunter2" }],
		...overrides,
	};
}

async function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
	const raw = await new Promise<string>((resolve, reject) => {
		socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
	return JSON.parse(raw) as Record<string, unknown>;
}

test("a follower is sent the current state and then every update", async () => {
	const app = await running();
	const payment = app.store.insert(pendingPayment());

	const socket = new WebSocket(
		`ws://127.0.0.1:${app.service.port}/ws/incoming-payments/${payment.id}`,
	);
	await new Promise((ready) => socket.addEventListener("open", ready, { once: true }));

	const current = await nextMessage(socket);
	expect(current["status"]).toBe("pending");
	expect(JSON.stringify(current)).not.toContain("hunter2");

	const updated = nextMessage(socket);
	app.store.paid(payment.id, PREIMAGE);

	const update = await updated;
	expect(update["status"]).toBe("paid");
	expect(update["preimage"]).toBe(PREIMAGE);

	socket.close();
	app.stop();
});

test("a browser on any origin may preflight and then read a payment", async () => {
	const app = await running();
	const payment = app.store.insert(pendingPayment());
	const base = `http://127.0.0.1:${app.service.port}`;

	const preflight = await fetch(`${base}/incoming-payments`, {
		method: "OPTIONS",
		headers: {
			origin: "https://someone.example",
			"access-control-request-method": "POST",
			"access-control-request-headers": "content-type",
		},
	});
	expect(preflight.status).toBe(204);
	expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
	expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
	expect(preflight.headers.get("access-control-allow-headers")).toContain("content-type");

	const read = await fetch(`${base}/incoming-payments/${payment.id}`, {
		headers: { origin: "https://someone.example" },
	});
	expect(read.headers.get("access-control-allow-origin")).toBe("*");
	const body = (await read.json()) as Record<string, unknown>;
	expect(body["verify_url"]).toBe("https://coinos.io/api/lnurl/verify/1");
	expect(body["incoming_amount"]).toEqual({
		value: "21000",
		asset_code: "BTC",
		asset_scale: 11,
	});

	const missing = await fetch(`${base}/incoming-payments/nope`);
	expect(missing.status).toBe(404);
	expect(missing.headers.get("access-control-allow-origin")).toBe("*");

	app.stop();
});

const UNUSABLE = { ln_addresses: ["not-an-address"], incoming_amount: MSAT_21K };
const OTHER_AMOUNT = {
	ln_addresses: ["not-an-address"],
	incoming_amount: { value: "42000", asset_code: "BTC", asset_scale: 11 },
};

function keyedTo(body: Record<string, unknown>): string {
	return fingerprint(readCreateRequest(body));
}

test("an Idempotency-Key is claimed before the invoice is minted, not after", async () => {
	const app = await running();
	const first = app.store.insert(pendingPayment());

	app.store.claim("key_done", keyedTo(UNUSABLE), 60);
	app.store.fulfill("key_done", first.id);
	const replayed = await post(app, UNUSABLE, "key_done");
	expect(replayed.status).toBe(201);
	expect(((await replayed.json()) as Problem)["id"]).toBe(first.id);

	app.store.claim("key_running", keyedTo(UNUSABLE), 60);
	const raced = await post(app, UNUSABLE, "key_running");
	expect(raced.status).toBe(409);
	expect(((await raced.json()) as Problem)["type"]).toBe(REQUEST_IN_FLIGHT);

	app.store.claim("key_taken", keyedTo(OTHER_AMOUNT), 60);
	const swapped = await post(app, UNUSABLE, "key_taken");
	expect(swapped.status).toBe(409);
	expect(((await swapped.json()) as Problem)["type"]).toBe(KEY_REUSED);

	app.stop();
});

test("a create that mints nothing hands its key back so the retry is not stuck", async () => {
	const app = await running();

	const refused = await post(app, UNUSABLE, "key_free");
	expect(refused.status).toBe(400);

	const again = await post(app, UNUSABLE, "key_free");
	expect(again.status).toBe(400);
	expect(((await again.json()) as Problem)["type"]).toBe(NO_WALLET_AVAILABLE);

	app.stop();
});

const WELL_KNOWN = "https://coinos.io/.well-known/lnurlp/charter";
const WALLET_METADATA = '[["text/plain","Paying charter@coinos.io"]]';
const MSAT_0 = { value: "0", asset_code: "BTC", asset_scale: 11 };
const MSAT_1K = { value: "1000", asset_code: "BTC", asset_scale: 11 };
const MSAT_100M = { value: "100000000", asset_code: "BTC", asset_scale: 11 };

function walletServing(seen: string[]): () => void {
	const real = globalThis.fetch;
	globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
		const target = String(args[0]);
		if (target.includes("127.0.0.1")) return real(...args);

		seen.push(target);
		if (target !== WELL_KNOWN) return Promise.resolve(new Response("no route", { status: 404 }));

		return Promise.resolve(
			Response.json({
				tag: "payRequest",
				callback: "https://coinos.io/api/lnurl/pay/charter",
				metadata: WALLET_METADATA,
				minSendable: 1_000,
				maxSendable: 100_000_000,
			}),
		);
	}) as typeof fetch;

	return () => {
		globalThis.fetch = real;
	};
}

function postQuote(app: App, body: unknown): Promise<Response> {
	return fetch(`http://127.0.0.1:${app.service.port}/quotes`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

test("a quote answers the wallet's range with a zero fee, and asks for no invoice", async () => {
	const app = await running();
	const seen: string[] = [];
	const restore = walletServing(seen);

	try {
		const served = await postQuote(app, {
			ln_addresses: ["not-an-address", "charter@coinos.io"],
			amount: MSAT_21K,
		});

		expect(served.status).toBe(200);
		expect(await served.json()).toEqual({
			ln_address: "charter@coinos.io",
			amount: MSAT_21K,
			fee: MSAT_0,
			min_amount: MSAT_1K,
			max_amount: MSAT_100M,
			metadata: WALLET_METADATA,
			refusals: [{ address: "not-an-address", reason: "address-unusable" }],
		});
		expect(seen).toEqual([WELL_KNOWN]);
	} finally {
		restore();
		app.stop();
	}
});

test("a quote reads its own amount field, never the one a create request carries", async () => {
	const app = await running();

	const confused = await postQuote(app, {
		ln_addresses: ["charter@coinos.io"],
		incoming_amount: MSAT_21K,
	});

	expect(confused.status).toBe(400);
	expect(((await confused.json()) as Problem)["type"]).toBe(INVALID_REQUEST);

	app.stop();
});

test("a quote nobody serves refuses with the wallet reasons a create would give", async () => {
	const app = await running();

	const refused = await postQuote(app, { ln_addresses: ["not-an-address"], amount: MSAT_21K });

	expect(refused.status).toBe(400);
	const problem = (await refused.json()) as Problem;
	expect(problem["type"]).toBe(NO_WALLET_AVAILABLE);
	expect(problem["wallets"]).toEqual([{ address: "not-an-address", reason: "address-unusable" }]);

	app.stop();
});

const TOKEN = "only-my-app-holds-this";

function withToken(app: App, path: string, token = TOKEN): Promise<Response> {
	return fetch(`http://127.0.0.1:${app.service.port}${path}`, {
		headers: { authorization: `Bearer ${token}` },
	});
}

test("with no token set the gateway stays open to everyone, as a public one must", async () => {
	const app = await running();
	const payment = app.store.insert(pendingPayment());

	const read = await fetch(`http://127.0.0.1:${app.service.port}/incoming-payments/${payment.id}`);
	expect(read.status).toBe(200);

	app.stop();
});

test("with a token set every call needs it, and health stays open for the platform", async () => {
	const app = await running(TOKEN);
	const payment = app.store.insert(pendingPayment());
	const base = `http://127.0.0.1:${app.service.port}`;

	expect((await fetch(`${base}/incoming-payments/${payment.id}`)).status).toBe(401);
	expect((await fetch(`${base}/quotes`, { method: "POST", body: "{}" })).status).toBe(401);
	expect((await withToken(app, `/incoming-payments/${payment.id}`, "wrong")).status).toBe(401);
	expect((await withToken(app, `/incoming-payments/${payment.id}`)).status).toBe(200);
	expect((await fetch(`${base}/health`)).status).toBe(200);

	app.stop();
});

test("a browser may still preflight a private gateway, and is told to send the header", async () => {
	const app = await running(TOKEN);

	const preflight = await fetch(`http://127.0.0.1:${app.service.port}/incoming-payments`, {
		method: "OPTIONS",
		headers: { origin: "https://someone.example", "access-control-request-method": "POST" },
	});

	expect(preflight.status).toBe(204);
	expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");

	app.stop();
});

test("listing exists only on a private gateway, and a public one does not admit to having it", async () => {
	const open = await running();
	expect((await fetch(`http://127.0.0.1:${open.service.port}/incoming-payments`)).status).toBe(404);
	open.stop();

	const closed = await running(TOKEN);
	closed.store.insert(pendingPayment());
	const listed = await withToken(closed, "/incoming-payments");

	expect(listed.status).toBe(200);
	const body = (await listed.json()) as { payments: Problem[]; settled_scanned: number };
	expect(body.payments).toHaveLength(1);
	expect(body.settled_scanned).toBe(1_000);

	closed.stop();
});

test("a host header that is not a host refuses the upgrade instead of killing the process", async () => {
	const app = await running();
	const base = `http://127.0.0.1:${app.service.port}`;

	const killed = await new Promise<string>((resolve) => {
		const probe = connect(app.service.port, "127.0.0.1", () => {
			probe.write(
				"GET /ws/triggers/anything HTTP/1.1\r\nHost: ]\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
					"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
			);
		});
		probe.on("data", (answer: Buffer) => resolve(answer.toString()));
		probe.on("close", () => resolve(""));
		probe.on("error", () => resolve(""));
	});

	expect(killed).not.toBe("");
	expect((await fetch(`${base}/health`)).status).toBe(200);

	app.stop();
});

test("the list is newest first and says how far back it scanned rather than pretending it is all", async () => {
	const app = await running(TOKEN);
	const older = app.store.insert(pendingPayment({ createdAt: 1_700_000_000 }));
	const newer = app.store.insert(
		pendingPayment({ createdAt: 1_800_000_000, paymentHash: SECOND_HASH }),
	);
	app.store.paid(older.id, PREIMAGE);

	const body = (await (await withToken(app, "/incoming-payments?limit=10")).json()) as {
		payments: Problem[];
	};

	expect(body.payments.map((one) => one["id"])).toEqual([newer.id, older.id]);
	expect(body.payments[0]!["status"]).toBe("pending");
	expect(body.payments[1]!["status"]).toBe("paid");

	app.stop();
});

test("a limit outside what the list will serve is refused rather than silently clamped", async () => {
	const app = await running(TOKEN);

	expect((await withToken(app, "/incoming-payments?limit=0")).status).toBe(400);
	expect((await withToken(app, "/incoming-payments?limit=501")).status).toBe(400);
	expect((await withToken(app, "/incoming-payments?limit=nope")).status).toBe(400);
	expect((await withToken(app, "/incoming-payments?limit=1")).status).toBe(200);

	app.stop();
});

function postTicket(app: App, body: unknown, token?: string): Promise<Response> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (token) headers["authorization"] = `Bearer ${token}`;

	return fetch(`http://127.0.0.1:${app.service.port}/ws-tickets`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

async function ticketFor(app: App, body: unknown, token?: string): Promise<string> {
	const minted = (await (await postTicket(app, body, token)).json()) as Problem;
	return String(minted["ticket"]);
}

function signedByNobody(ticket: string): string {
	return `${ticket.slice(0, ticket.lastIndexOf("."))}.${"0".repeat(64)}`;
}

async function openedWith(app: App, ticket: string): Promise<WebSocket> {
	const socket = new WebSocket(`ws://127.0.0.1:${app.service.port}/ws/tickets/${ticket}`);
	await new Promise((settled) => {
		socket.addEventListener("open", settled, { once: true });
		socket.addEventListener("error", settled, { once: true });
		socket.addEventListener("close", settled, { once: true });
	});

	return socket;
}

test("a ticket opens the trigger it names, without that secret ever being in a URL", async () => {
	const app = await running();
	const trigger = triggerOf(SECRET);
	const payment = app.store.insert(pendingPayment({ trigger }));

	const ticket = await ticketFor(app, { trigger_secret: SECRET });
	expect(ticket).not.toContain(SECRET);

	const overlay = await openedWith(app, ticket);
	const seen = collecting(overlay);
	app.store.paid(payment.id, PREIMAGE);
	await settled();

	expect(seen).toHaveLength(1);
	expect(seen[0]!["status"]).toBe("paid");

	overlay.close();
	app.stop();
});

test("a ticket for one trigger does not open another, which is what binding it is for", async () => {
	const app = await running();
	const mine = app.store.insert(pendingPayment({ trigger: triggerOf(SECRET) }));

	const elsewhere = await ticketFor(app, { trigger_secret: ANOTHER_SECRET });
	const socket = await openedWith(app, elsewhere);
	const seen = collecting(socket);
	app.store.paid(mine.id, PREIMAGE);
	await settled();

	expect(seen).toEqual([]);

	socket.close();
	app.stop();
});

test("a ticket also stands in for a payment id, and replays that payment's state", async () => {
	const app = await running();
	const payment = app.store.insert(pendingPayment());

	const ticket = await ticketFor(app, { payment_id: payment.id });
	const socket = await openedWith(app, ticket);
	const seen = collecting(socket);
	await settled();

	expect(seen).toHaveLength(1);
	expect(seen[0]!["id"]).toBe(payment.id);

	socket.close();
	app.stop();
});

test("a forged or malformed ticket opens nothing", async () => {
	const app = await running();
	const real = await ticketFor(app, { trigger_secret: SECRET });

	for (const bad of [signedByNobody(real), real.split(".").slice(0, 5).join("."), "nonsense"]) {
		const socket = await openedWith(app, bad);
		expect(socket.readyState).not.toBe(WebSocket.OPEN);
		socket.close();
	}

	app.stop();
});

function handshake(app: App, path: string, token?: string): Promise<number> {
	const headers: Record<string, string> = {
		connection: "Upgrade",
		upgrade: "websocket",
		"sec-websocket-version": "13",
		"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
	};
	if (token) headers["authorization"] = `Bearer ${token}`;

	return new Promise((answered) => {
		const asked = httpRequest({ host: "127.0.0.1", port: app.service.port, path, headers });
		asked.on("upgrade", (accepted, socket) => {
			socket.destroy();
			answered(accepted.statusCode ?? 0);
		});
		asked.on("response", (answer) => {
			answer.resume();
			answered(answer.statusCode ?? 0);
		});
		asked.end();
	});
}

test("on a private gateway a socket needs the bearer, exactly as every call does", async () => {
	const app = await running(TOKEN);
	const payment = app.store.insert(pendingPayment());
	const following = `/ws/incoming-payments/${payment.id}`;

	expect(await handshake(app, following)).toBe(401);
	expect(await handshake(app, following, "wrong")).toBe(401);
	expect(await handshake(app, `/ws/triggers/${SECRET}`)).toBe(401);
	expect(await handshake(app, following, TOKEN)).toBe(101);

	app.stop();
});

test("a ticket opens a private gateway on its own, which is all a browser can do", async () => {
	const app = await running(TOKEN);
	const payment = app.store.insert(pendingPayment());
	const ticket = await ticketFor(app, { payment_id: payment.id }, TOKEN);

	expect(await handshake(app, `/ws/tickets/${ticket}`)).toBe(101);

	app.stop();
});

test("a refused handshake says 401 rather than dropping the socket without a word", async () => {
	const app = await running();
	const real = await ticketFor(app, { trigger_secret: SECRET });

	expect(await handshake(app, `/ws/tickets/${signedByNobody(real)}`)).toBe(401);

	app.stop();
});

test("a public gateway opens a socket for anyone holding the id, as it did before", async () => {
	const app = await running();
	const payment = app.store.insert(pendingPayment());

	expect(await handshake(app, `/ws/incoming-payments/${payment.id}`)).toBe(101);

	app.stop();
});

test("minting refuses a body that names both or neither, and an id it never issued", async () => {
	const app = await running();

	expect((await postTicket(app, {})).status).toBe(400);
	expect((await postTicket(app, { trigger_secret: SECRET, payment_id: "x" })).status).toBe(400);
	expect((await postTicket(app, { trigger_secret: "" })).status).toBe(400);
	expect((await postTicket(app, { payment_id: "never-issued" })).status).toBe(404);

	app.stop();
});

test("on a private gateway minting needs the bearer, on a public one it does not", async () => {
	const closed = await running(TOKEN);
	expect((await postTicket(closed, { trigger_secret: SECRET })).status).toBe(401);
	expect((await postTicket(closed, { trigger_secret: SECRET }, TOKEN)).status).toBe(200);
	closed.stop();

	const open = await running();
	expect((await postTicket(open, { trigger_secret: SECRET })).status).toBe(200);
	open.stop();
});

test("a ticket minted on one instance opens a socket on another sharing the cluster key", async () => {
	const minting = await running();
	const opening = await running();
	const trigger = triggerOf(SECRET);
	const payment = opening.store.insert(pendingPayment({ trigger }));

	const ticket = await ticketFor(minting, { trigger_secret: SECRET });
	const socket = await openedWith(opening, ticket);
	const seen = collecting(socket);
	opening.store.paid(payment.id, PREIMAGE);
	await settled();

	expect(socket.readyState).toBe(WebSocket.OPEN);
	expect(seen).toHaveLength(1);

	socket.close();
	minting.stop();
	opening.stop();
});

const WATCHED_HASH = "cc".repeat(32);
const WATCHABLE = {
	payment_hash: WATCHED_HASH,
	verify_url: "https://coinos.io/api/lnurl/verify/blind",
	expires_at: new Date(Date.now() + 3_600_000).toISOString(),
};

function postWatch(app: App, body: unknown): Promise<Response> {
	return fetch(`http://127.0.0.1:${app.service.port}/watched-payments`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

test("an invoice can be watched without telling the gateway who or how much", async () => {
	const app = await running();

	const watched = await postWatch(app, WATCHABLE);
	expect(watched.status).toBe(201);

	const body = (await watched.json()) as Problem;
	expect(body["payment_hash"]).toBe(WATCHED_HASH);
	expect(body["status"]).toBe("pending");
	expect(body).not.toHaveProperty("ln_address");
	expect(body).not.toHaveProperty("incoming_amount");
	expect(body).not.toHaveProperty("bolt11");

	app.stop();
});

test("what the gateway stores about a blind watch names no recipient and no amount", async () => {
	const app = await running();

	const created = (await (await postWatch(app, WATCHABLE)).json()) as Problem;
	const stored = app.store.get(String(created["id"]));

	expect(stored?.lnAddress).toBeNull();
	expect(stored?.amountMsat).toBeNull();
	expect(stored?.bolt11).toBeNull();
	expect(stored?.verifyUrl).toBe(WATCHABLE.verify_url);

	app.stop();
});

test("a watched payment can be owed a webhook, which is the bank rail's only way to be told", async () => {
	const app = await running();

	const created = (await (
		await postWatch(app, {
			...WATCHABLE,
			payment_hash: PAYMENT_HASH,
			webhook: { url: "https://shop.example/hooks/bank", secret: "s".repeat(32) },
		})
	).json()) as Problem;
	const stored = app.store.get(String(created["id"]));

	expect(stored?.webhooks).toEqual([
		{ url: "https://shop.example/hooks/bank", secret: "s".repeat(32) },
	]);

	app.store.paid(String(created["id"]), PREIMAGE);

	expect(app.store.dueDeliveries(10, 60).map((owed) => owed.url)).toContain(
		"https://shop.example/hooks/bank",
	);

	app.stop();
});

test("a watch asking for a webhook somewhere private is refused, like a create is", async () => {
	const app = await running();

	const refused = await postWatch(app, {
		...WATCHABLE,
		webhook: { url: "http://192.168.1.10/hooks", secret: null },
	});

	expect(refused.status).toBe(400);

	app.stop();
});

test("a sealed blob is handed back untouched, and the gateway keeps it out of nothing else", async () => {
	const app = await running();

	const created = (await (
		await postWatch(app, { ...WATCHABLE, sealed: "v1.opaque-to-the-gateway" })
	).json()) as Problem;

	expect(created["sealed"]).toBe("v1.opaque-to-the-gateway");
	expect(app.store.get(String(created["id"]))?.sealed).toBe("v1.opaque-to-the-gateway");

	app.stop();
});

test("a hash already watched here is a conflict, so the id cannot be fished out with it", async () => {
	const app = await running();
	const owned = (await (
		await postWatch(app, { ...WATCHABLE, sealed: "sealed-by-the-owner" })
	).json()) as Problem;

	const fishing = await postWatch(app, {
		...WATCHABLE,
		verify_url: "https://evil.example/verify",
		sealed: "not-mine",
	});

	expect(fishing.status).toBe(409);
	const problem = (await fishing.json()) as Problem;
	expect(problem["type"]).toBe(ALREADY_WATCHED);
	expect(JSON.stringify(problem)).not.toContain("sealed-by-the-owner");
	expect(JSON.stringify(problem)).not.toContain(String(owned["id"]));
	expect(JSON.stringify(problem)).not.toContain("coinos.io");

	app.stop();
});

test("the owner repeating its own registration still gets its payment back", async () => {
	const app = await running();
	const first = (await (await postWatch(app, { ...WATCHABLE, sealed: "mine" })).json()) as Problem;

	const again = await postWatch(app, { ...WATCHABLE, sealed: "mine" });

	expect(again.status).toBe(201);
	expect(((await again.json()) as Problem)["id"]).toBe(first["id"]);

	app.stop();
});

test("a payment the gateway minted itself can never be re-registered as a blind watch", async () => {
	const app = await running();
	const minted = app.store.insert(pendingPayment());

	const fishing = await postWatch(app, {
		payment_hash: minted.paymentHash,
		verify_url: minted.verifyUrl,
		expires_at: WATCHABLE.expires_at,
	});

	expect(fishing.status).toBe(409);
	const problem = (await fishing.json()) as Problem;
	expect(JSON.stringify(problem)).not.toContain("charter@coinos.io");
	expect(JSON.stringify(problem)).not.toContain(minted.id);

	app.stop();
});

test("a blind watch is refused when there is nothing left to watch or nothing to watch it by", async () => {
	const app = await running();

	const expired = await postWatch(app, {
		...WATCHABLE,
		expires_at: new Date(1_600_000_000 * 1000).toISOString(),
	});
	expect(expired.status).toBe(400);

	const local = await postWatch(app, { ...WATCHABLE, verify_url: "http://127.0.0.1/verify" });
	expect(local.status).toBe(400);
	expect(((await local.json()) as Problem)["type"]).toBe(INVALID_REQUEST);

	const unhashed = await postWatch(app, { ...WATCHABLE, payment_hash: "nope" });
	expect(unhashed.status).toBe(400);

	app.stop();
});

test("a watch reaching past the three days the gateway promises is refused, and stores nothing", async () => {
	const app = await running();

	const tooFar = await postWatch(app, {
		...WATCHABLE,
		expires_at: new Date(Date.now() + 4 * 86_400_000).toISOString(),
	});
	expect(tooFar.status).toBe(400);
	expect(String(((await tooFar.json()) as Problem)["detail"])).toContain("3 days");

	expect((await postWatch(app, WATCHABLE)).status).toBe(201);

	app.stop();
});

const SECRET = "the-overlay-holds-this";
const ANOTHER_SECRET = "someone-elses-trigger";
const SECOND_PREIMAGE = "01".repeat(32);
const SECOND_HASH = "72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793";

function triggerOf(secret: string): string {
	return createHash("sha256").update(secret).digest("hex");
}

async function watching(app: App, secret: string): Promise<WebSocket> {
	const socket = new WebSocket(`ws://127.0.0.1:${app.service.port}/ws/triggers/${secret}`);
	await new Promise((ready) => socket.addEventListener("open", ready, { once: true }));

	return socket;
}

function collecting(socket: WebSocket): Record<string, unknown>[] {
	const seen: Record<string, unknown>[] = [];
	socket.addEventListener("message", (event) => {
		seen.push(JSON.parse(String(event.data)) as Record<string, unknown>);
	});

	return seen;
}

async function settled(): Promise<void> {
	await new Promise((done) => setTimeout(done, 150));
}

test("every watcher of one trigger sees its payments, and watchers of another see none", async () => {
	const app = await running();
	const trigger = triggerOf(SECRET);
	const payment = app.store.insert(pendingPayment({ trigger }));

	const overlay = await watching(app, SECRET);
	const lamp = await watching(app, SECRET);
	const stranger = await watching(app, ANOTHER_SECRET);
	const seenByOverlay = collecting(overlay);
	const seenByLamp = collecting(lamp);
	const seenByStranger = collecting(stranger);

	app.store.paid(payment.id, PREIMAGE);
	await settled();

	expect(seenByOverlay).toHaveLength(1);
	expect(seenByLamp).toHaveLength(1);
	expect(seenByStranger).toEqual([]);
	expect(seenByOverlay[0]!["status"]).toBe("paid");
	expect(seenByOverlay[0]!["preimage"]).toBe(PREIMAGE);

	for (const socket of [overlay, lamp, stranger]) socket.close();
	app.stop();
});

test("a watcher that reconnects is replayed what settled while it was gone", async () => {
	const app = await running();
	const trigger = triggerOf(SECRET);
	const first = app.store.insert(pendingPayment({ trigger }));
	const second = app.store.insert(pendingPayment({ trigger, paymentHash: SECOND_HASH }));

	app.store.paid(first.id, PREIMAGE);
	app.store.paid(second.id, SECOND_PREIMAGE);

	const overlay = await watching(app, SECRET);
	const replayed = collecting(overlay);
	await settled();

	expect(replayed.map((frame) => frame["preimage"])).toEqual([PREIMAGE, SECOND_PREIMAGE]);

	overlay.close();
	app.stop();
});

test("a payment never discloses the trigger it belongs to", async () => {
	const app = await running();
	const payment = app.store.insert(pendingPayment({ trigger: triggerOf(SECRET) }));

	const read = await fetch(`http://127.0.0.1:${app.service.port}/incoming-payments/${payment.id}`);
	const body = await read.text();

	expect(body).not.toContain(triggerOf(SECRET));
	expect(JSON.parse(body) as Record<string, unknown>).not.toHaveProperty("trigger");

	app.stop();
});

test("a trigger that is not the hash of anything is refused before a wallet is contacted", async () => {
	const app = await running();

	const refused = await post(app, { ...UNUSABLE, trigger: "not-a-hash" });

	expect(refused.status).toBe(400);
	expect(((await refused.json()) as Problem)["type"]).toBe(INVALID_REQUEST);

	app.stop();
});

type Problem = Record<string, unknown>;

test("readiness says only that it is ready until a bearer proves the instance is yours", async () => {
	const shared = await running();
	const bare = await fetch(`http://127.0.0.1:${shared.service.port}/ready`);
	expect(bare.status).toBe(200);
	expect(await bare.json()).toEqual({ status: "ready" });
	shared.stop();

	const mine = await running("secret-token");
	const told = await fetch(`http://127.0.0.1:${mine.service.port}/ready`, {
		headers: { authorization: "Bearer secret-token" },
	});
	expect(await told.json()).toMatchObject({
		status: "ready",
		peers: 0,
		pending: 0,
		max_pending: 5000,
		watching: "scheduled",
		sync: {
			state: "alone",
			converged_at: null,
			origins: 0,
			rows: { accepted: 0, paid: 0, outbox: 0, delivered: 0 },
		},
	});
	mine.stop();
});

test("a draining instance turns readiness down and waits for the tick in flight", async () => {
	const real = globalThis.fetch;
	let asked = 0;
	globalThis.fetch = (() => {
		asked += 1;
		return new Promise((answer) => setTimeout(() => answer(Response.json({ settled: false })), 400));
	}) as typeof fetch;

	const app = await running(null, 3000);
	try {
		app.store.insert(pendingPayment());
		await until(() => asked > 0, "the watcher to reach the wallet");

		const stopping = app.service.stop();
		const draining = await real(`http://127.0.0.1:${app.service.port}/ready`);
		expect(draining.status).toBe(503);
		expect(((await draining.json()) as Problem)["title"]).toBe("Service Unavailable");
		await stopping;
	} finally {
		globalThis.fetch = real;
		app.stop();
	}
});

test("a body larger than this gateway reads is refused before anything parses it", async () => {
	const app = await running();
	const tooMuch = "x".repeat(70_000);

	const declared = await failing(app, `{"pad":"${tooMuch}"}`);
	expect(declared.status).toBe(413);
	expect(declared.contentType).toContain("application/problem+json");
	expect(declared.problem["type"]).toBe(INVALID_REQUEST);

	const streamed = await fetch(`http://127.0.0.1:${app.service.port}/incoming-payments`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(tooMuch));
				controller.close();
			},
		}),
		duplex: "half",
	} as RequestInit);
	expect(streamed.status).toBe(413);

	app.stop();
});

function post(app: App, body: unknown, key?: string): Promise<Response> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (key) headers["idempotency-key"] = key;

	return fetch(`http://127.0.0.1:${app.service.port}/incoming-payments`, {
		method: "POST",
		headers,
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

async function failing(
	app: App,
	body: unknown,
): Promise<{ status: number; contentType: string | null; problem: Problem }> {
	const response = await post(app, body);
	return {
		status: response.status,
		contentType: response.headers.get("content-type"),
		problem: (await response.json()) as Problem,
	};
}

test("every refusal is a problem document a client can branch on", async () => {
	const app = await running();

	const notJson = await failing(app, "{oh no");
	expect(notJson.status).toBe(400);
	expect(notJson.contentType).toContain("application/problem+json");
	expect(notJson.problem["type"]).toBe(INVALID_REQUEST);
	expect(notJson.problem["status"]).toBe(400);

	const noAmount = await failing(app, { ln_addresses: ["charter@coinos.io"] });
	expect(noAmount.status).toBe(400);
	expect(noAmount.problem["type"]).toBe(INVALID_REQUEST);
	expect(noAmount.problem["detail"]).toContain("incoming_amount");

	const badHook = await failing(app, {
		ln_addresses: ["charter@coinos.io"],
		incoming_amount: MSAT_21K,
		webhook: { url: "http://169.254.169.254/latest/meta-data" },
	});
	expect(badHook.status).toBe(400);
	expect(badHook.problem["detail"]).toContain("webhook.url");

	const unusable = await failing(app, {
		ln_addresses: ["not-an-address"],
		incoming_amount: MSAT_21K,
	});
	expect(unusable.status).toBe(400);
	expect(unusable.problem["type"]).toBe(NO_WALLET_AVAILABLE);
	expect(unusable.problem["wallets"]).toEqual([
		{ address: "not-an-address", reason: "address-unusable" },
	]);

	const unprovable = await failing(app, {
		ln_addresses: ["someone@zeuspay.com", "someone@ecash.love"],
		incoming_amount: MSAT_21K,
	});
	expect(unprovable.status).toBe(422);
	expect(unprovable.problem["wallets"]).toEqual([
		{ address: "someone@zeuspay.com", reason: "cannot-prove-delivery" },
		{ address: "someone@ecash.love", reason: "cannot-prove-delivery" },
	]);

	app.stop();
});

test("a refusal never carries a URL, an upstream status or an internal message", async () => {
	const app = await running();

	const leaky = await failing(app, {
		ln_addresses: ["nobody-here-at-all@coinos.io"],
		incoming_amount: MSAT_21K,
	});
	expect(leaky.status).toBe(502);
	expect(leaky.problem["wallets"]).toEqual([
		{ address: "nobody-here-at-all@coinos.io", reason: "unreachable" },
	]);

	const wire = JSON.stringify(leaky.problem);
	for (const internal of ["http", "well-known", "500", "404", "answered", "Error"]) {
		expect(wire).not.toContain(internal);
	}

	app.store.close();
	const gone = await fetch(`http://127.0.0.1:${app.service.port}/incoming-payments/anything`);
	expect(gone.status).toBe(500);
	expect(await gone.text()).not.toContain("database");

	app.stop();
});

test("an unknown payment closes the socket instead of hanging", async () => {
	const app = await running();
	const socket = new WebSocket(
		`ws://127.0.0.1:${app.service.port}/ws/incoming-payments/${crypto.randomUUID()}`,
	);

	await new Promise((closed) => socket.addEventListener("close", closed, { once: true }));

	app.stop();
});
