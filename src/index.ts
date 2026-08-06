import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import type { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

import { WebSocketServer, type WebSocket } from "ws";

import { equalInConstantTime } from "../core/hmac.ts";
import { mint as mintTicket, read as readTicket, type Subject } from "../core/ticket.ts";
import { Cluster } from "./cluster.ts";
import { positive, secret, whole } from "./env.ts";
import { Ledger, paymentId } from "./ledger.ts";
import { quote, resolve, RESOLVE_TIMEOUT_MS } from "../core/lnurl.ts";
import type { Payment } from "./payment.ts";
import {
	ALREADY_WATCHED,
	BodyTooLarge,
	INVALID_REQUEST,
	KEY_REUSED,
	MalformedRequest,
	NoWalletAvailable,
	NO_WALLET_AVAILABLE,
	REQUEST_IN_FLIGHT,
	statusForWallets,
} from "./problem.ts";
import { Store } from "./store.ts";
import { tick, unixNow, WATCH_HORIZON_SECS, type Watcher } from "./watch.ts";
import {
	fingerprint,
	paymentToWire,
	quoteToWire,
	readCreateRequest,
	readQuoteRequest,
	readTicketRequest,
	readWatchRequest,
	type CreateRequest,
	type QuoteRequest,
	type TicketRequest,
	type WatchRequest,
} from "./wire.ts";

const OPEN = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, OPTIONS",
	"access-control-allow-headers": "content-type, authorization",
};
const PING_INTERVAL_MS = 30_000;
const TICK_INTERVAL_MS = 1_000;
const SWEEP_INTERVAL_MS = 60_000;
const EXPIRED_GRACE_SECS = 3600;
const CLAIM_LEASE_SECS = RESOLVE_TIMEOUT_MS / 1000 + 10;
const FOLLOWING = /^\/ws\/incoming-payments\/([\w-]+)$/;
const WATCHING = /^\/ws\/triggers\/([\w-]+)$/;
const TICKETED = /^\/ws\/tickets\/([\w.-]+)$/;
const REPLAY_LIMIT = 10;
const REPLAY_WINDOW = 500;
const SETTLED_WINDOW = 1_000;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 500;
const MAX_REQUEST_BYTES = 64 * 1024;
const BEARER = "Bearer ";
const TICKET_TTL_SECS = 60;
const UNGATED = new Set(["/health", "/ready", "/openapi.yaml", "/docs"]);
const STALLED = "the watch loop has stopped being scheduled, so this instance needs replacing";
const LEAVING = "this instance is shutting down and is not taking new work";
const SPEC = readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8");
const RENDERER = "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.64.0/dist/browser/standalone.js";
const RENDERER_HASH = "sha384-ei8P62VHbV+6AdLO3hN333PsTEYp6k9OAVhlYvpmer+zdPIf8jSbdgh9ojiLWX3T";
const RENDERER_ORIGIN = "https://cdn.jsdelivr.net";
const DOCS_POLICY = [
	"default-src 'none'",
	`script-src ${RENDERER_ORIGIN} 'unsafe-inline'`,
	"style-src 'unsafe-inline'",
	`font-src ${RENDERER_ORIGIN} data:`,
	"img-src 'self' data:",
	"connect-src 'self'",
	"frame-ancestors 'none'",
].join("; ");
const DOCS = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Thunder Bridge</title>
	</head>
	<body>
		<script id="api-reference" data-url="/openapi.yaml" data-configuration='{"withDefaultFonts":false}'></script>
		<script src="${RENDERER}" integrity="${RENDERER_HASH}" crossorigin="anonymous"></script>
		<main><a href="/openapi.yaml">this specification, unrendered</a></main>
	</body>
</html>
`;

type Follower = { id: string | null; trigger: string | null; answered: boolean };

export type Options = {
	port: number;
	eagerDelayMs: number;
	pollsPerSecond: number;
	tickStallMs: number;
	drainTimeoutMs: number;
	token: string | null;
	key: Uint8Array;
};

export type Service = {
	port: number;
	stop: () => Promise<void>;
};

type Vitals = { stalled: boolean; draining: boolean };

export async function start(options: Options, store: Store): Promise<Service> {
	const watcher: Watcher = {
		store,
		eagerDelayMs: options.eagerDelayMs,
		budget: { perSecond: options.pollsPerSecond, nextAt: new Map() },
	};

	let draining = false;
	let firedAt = Date.now();
	const vitals = (): Vitals => ({
		stalled: !draining && Date.now() - firedAt > options.tickStallMs,
		draining,
	});

	const followers = new Map<WebSocket, Follower>();
	const upgrades = new WebSocketServer({ noServer: true, maxPayload: MAX_REQUEST_BYTES });
	const server = createServer((incoming, outgoing) => {
		void respond(incoming, store, options.token, options.key, vitals()).then((answer) =>
			reply(answer, outgoing),
		);
	});

	server.on("upgrade", (incoming, socket, head) => {
		if (draining) {
			refuseUpgrade(socket, "503 Service Unavailable");
			return;
		}

		const path = pathOf(incoming);
		const ticketed = TICKETED.exec(path);
		if (ticketed) {
			void readTicket(options.key, ticketed[1]!, unixNow()).then((permits) => {
				if (socket.destroyed) return;
				if (permits === null) {
					refuseUpgrade(socket);
					return;
				}
				upgrades.handleUpgrade(incoming, socket, head, (accepted) => {
					if (permits.kind === "trigger") subscribe(accepted, permits.trigger, store, followers);
					else follow(accepted, permits.paymentId, store, followers);
				});
			});
			return;
		}

		if (options.token !== null && !bearerMatches(incoming, options.token)) {
			refuseUpgrade(socket);
			return;
		}

		const following = FOLLOWING.exec(path);
		if (following) {
			upgrades.handleUpgrade(incoming, socket, head, (accepted) => {
				follow(accepted, following[1]!, store, followers);
			});
			return;
		}

		const watching = WATCHING.exec(path);
		if (watching) {
			upgrades.handleUpgrade(incoming, socket, head, (accepted) => {
				watch(accepted, watching[1]!, store, followers);
			});
			return;
		}

		socket.destroy();
	});

	const publish = (payment: Payment) => {
		const frame = JSON.stringify(paymentToWire(payment));
		for (const [socket, follower] of followers) {
			const mine =
				follower.id === payment.id ||
				(follower.trigger !== null && follower.trigger === payment.trigger);
			if (mine) socket.send(frame);
		}
	};
	store.onChange = publish;

	await new Promise<void>((listening) => server.listen(options.port, "0.0.0.0", listening));

	const keepalive = setInterval(() => {
		for (const [socket, follower] of followers) {
			if (!follower.answered) {
				socket.terminate();
				continue;
			}
			follower.answered = false;
			socket.ping();
		}
	}, PING_INTERVAL_MS);

	const sweeper = setInterval(() => {
		for (const expired of store.sweep(EXPIRED_GRACE_SECS)) publish(expired);
	}, SWEEP_INTERVAL_MS);

	let ticking = false;
	let inFlight: Promise<void> = Promise.resolve();
	const ticker = setInterval(() => {
		firedAt = Date.now();
		if (ticking) return;
		ticking = true;
		inFlight = tick(watcher)
			.catch((error: unknown) => console.warn(`tick failed: ${String(error)}`))
			.finally(() => {
				ticking = false;
			});
	}, TICK_INTERVAL_MS);

	const { port } = server.address() as AddressInfo;
	console.log(`listening on :${port}, polling ${watcher.budget.perSecond} payments a second`);

	return {
		port,
		stop: async () => {
			if (draining) return;
			draining = true;
			clearInterval(keepalive);
			clearInterval(ticker);
			clearInterval(sweeper);
			await Promise.race([inFlight, sleep(options.drainTimeoutMs, undefined, { ref: false })]);
			for (const socket of followers.keys()) socket.close();
			upgrades.close();
			server.closeAllConnections();
			server.close();
		},
	};
}

function follow(
	socket: WebSocket,
	id: string,
	store: Store,
	followers: Map<WebSocket, Follower>,
): void {
	const payment = store.get(id);
	if (!payment) {
		socket.close();
		return;
	}

	const follower: Follower = { id, trigger: null, answered: true };
	followers.set(socket, follower);
	keepFresh(socket, follower, followers);
	socket.send(JSON.stringify(paymentToWire(payment)));
	if (payment.status !== "pending") socket.close();
}

function watch(
	socket: WebSocket,
	secret: string,
	store: Store,
	followers: Map<WebSocket, Follower>,
): void {
	subscribe(socket, hashed(secret), store, followers);
}

function subscribe(
	socket: WebSocket,
	trigger: string,
	store: Store,
	followers: Map<WebSocket, Follower>,
): void {
	const follower: Follower = { id: null, trigger, answered: true };
	followers.set(socket, follower);
	keepFresh(socket, follower, followers);

	for (const settled of store.replay(trigger, REPLAY_LIMIT, REPLAY_WINDOW)) {
		socket.send(JSON.stringify(paymentToWire(settled)));
	}
}

function hashed(secret: string): string {
	return createHash("sha256").update(secret).digest("hex");
}

function keepFresh(
	socket: WebSocket,
	follower: Follower,
	followers: Map<WebSocket, Follower>,
): void {
	socket.on("pong", () => {
		follower.answered = true;
	});
	socket.on("close", () => followers.delete(socket));
}

async function respond(
	incoming: IncomingMessage,
	store: Store,
	token: string | null,
	key: Uint8Array,
	vitals: Vitals,
): Promise<Response> {
	if (incoming.method === "OPTIONS") return new Response(null, { status: 204, headers: OPEN });

	const answer =
		refused(incoming, token) ??
		(await route(incoming, store, token, key, vitals).catch(oversized).catch(unhandled));
	for (const [header, value] of Object.entries(OPEN)) answer.headers.set(header, value);

	return answer;
}

function refused(incoming: IncomingMessage, token: string | null): Response | null {
	if (token === null || UNGATED.has(pathOf(incoming))) return null;

	return bearerMatches(incoming, token) ? null : unauthorized();
}

function bearerMatches(incoming: IncomingMessage, token: string): boolean {
	const offered = incoming.headers.authorization ?? "";
	const bearer = offered.startsWith(BEARER) ? offered.slice(BEARER.length) : "";

	return equalInConstantTime(bearer, token);
}

function refuseUpgrade(socket: Duplex, status = "401 Unauthorized"): void {
	socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
	socket.destroy();
}

function readiness(
	vitals: Vitals,
	store: Store,
	incoming: IncomingMessage,
	token: string | null,
): Response {
	if (vitals.draining) return unavailable(LEAVING);
	if (token === null || !bearerMatches(incoming, token)) return json({ status: "ready" });

	const { origin, peers, pending, maxPending } = store.info();

	return json({
		status: "ready",
		origin,
		peers,
		pending,
		max_pending: maxPending,
		watching: vitals.stalled ? "stalled" : "scheduled",
	});
}

async function reply(answer: Response, outgoing: ServerResponse): Promise<void> {
	outgoing.writeHead(answer.status, Object.fromEntries(answer.headers));
	outgoing.end(Buffer.from(await answer.arrayBuffer()));
}

async function route(
	incoming: IncomingMessage,
	store: Store,
	token: string | null,
	key: Uint8Array,
	vitals: Vitals,
): Promise<Response> {
	const path = pathOf(incoming);
	if (path === "/health") return vitals.stalled ? unavailable(STALLED) : new Response("OK");
	if (path === "/ready") return readiness(vitals, store, incoming, token);
	if (path === "/openapi.yaml") return served(SPEC, "application/yaml");
	if (path === "/docs") return rendered();

	const one = /^\/incoming-payments\/([\w-]+)$/.exec(path);
	if (one && incoming.method === "GET") {
		const payment = store.get(one[1]!);
		return payment ? json(paymentToWire(payment)) : notFound();
	}
	if (path === "/incoming-payments" && incoming.method === "GET") {
		return token === null ? notFound() : listed(incoming, store);
	}
	if (path === "/incoming-payments" && incoming.method === "POST") {
		return await create(await asRequest(incoming), store);
	}
	if (path === "/quotes" && incoming.method === "POST") {
		return await quoted(await asRequest(incoming));
	}
	if (path === "/watched-payments" && incoming.method === "POST") {
		return await watchOnly(await asRequest(incoming), store, key);
	}
	if (path === "/ws-tickets" && incoming.method === "POST") {
		return await ticketed(await asRequest(incoming), store, key);
	}

	return notFound();
}

async function create(request: Request, store: Store): Promise<Response> {
	let asked: CreateRequest;
	try {
		asked = readCreateRequest(await request.json());
	} catch (error: unknown) {
		return unreadable(error);
	}

	if (store.full()) {
		return unavailable("this instance is watching as many payments as it can");
	}

	const key = request.headers.get("idempotency-key");
	const claim = key ? store.claim(key, fingerprint(asked), CLAIM_LEASE_SECS) : null;
	if (claim?.state === "done") return replay(store, claim.paymentId);
	if (claim?.state === "inflight") {
		return conflict(REQUEST_IN_FLIGHT, "A request with this Idempotency-Key is still running");
	}
	if (claim?.state === "mismatch") {
		return conflict(KEY_REUSED, "This Idempotency-Key was used for a different request");
	}

	try {
		const payment = await mint(asked, store);
		if (key) store.fulfill(key, payment.id);

		return json(paymentToWire(payment), 201);
	} catch (error: unknown) {
		if (key) store.release(key);
		if (!(error instanceof NoWalletAvailable)) throw error;

		return problem(statusForWallets(error.wallets), {
			type: NO_WALLET_AVAILABLE,
			title: "No wallet could issue a provable invoice",
			wallets: error.wallets,
		});
	}
}

async function mint(asked: CreateRequest, store: Store): Promise<Payment> {
	const resolved = await resolve(asked.addresses, asked.amountMsat);

	return store.insert({
		lnAddress: resolved.address,
		amountMsat: asked.amountMsat,
		status: "pending",
		paymentHash: resolved.paymentHash,
		bolt11: resolved.bolt11,
		preimage: null,
		expiresAt: resolved.expiresAt,
		createdAt: unixNow(),
		verifyUrl: resolved.verifyUrl,
		trigger: asked.trigger,
		sealed: null,
		webhooks: asked.webhook ? [asked.webhook] : [],
	});
}

function replay(store: Store, paymentId: string): Response {
	const payment = store.get(paymentId);
	if (!payment) return gone("the payment this Idempotency-Key created has already been pruned");

	return json(paymentToWire(payment), 201);
}

async function ticketed(request: Request, store: Store, key: Uint8Array): Promise<Response> {
	let asked: TicketRequest;
	try {
		asked = readTicketRequest(await request.json());
	} catch (error: unknown) {
		return unreadable(error);
	}

	if (asked.kind === "payment" && !store.get(asked.paymentId)) return notFound();

	const subject: Subject =
		asked.kind === "trigger"
			? { kind: "trigger", trigger: hashed(asked.secret) }
			: { kind: "payment", paymentId: asked.paymentId };

	const minted = await mintTicket(key, subject, TICKET_TTL_SECS, unixNow());

	return json({ ticket: minted.ticket, expires_at: new Date(minted.expiresAt * 1000).toISOString() });
}

function isThisWatch(known: Payment, asked: WatchRequest): boolean {
	return (
		known.lnAddress === null &&
		known.amountMsat === null &&
		known.bolt11 === null &&
		known.verifyUrl === asked.verifyUrl &&
		known.expiresAt === asked.expiresAt &&
		known.trigger === asked.trigger &&
		known.sealed === asked.sealed
	);
}

function listed(incoming: IncomingMessage, store: Store): Response {
	const asked = new URL(incoming.url ?? "/", "http://app").searchParams.get("limit");
	const limit = asked === null ? DEFAULT_PAGE : Number(asked);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
		return invalidRequest(`limit must be a whole number from 1 to ${MAX_PAGE}`);
	}

	const found = store.list(limit, SETTLED_WINDOW);

	return json({
		payments: found.map(paymentToWire),
		settled_scanned: SETTLED_WINDOW,
	});
}

async function watchOnly(request: Request, store: Store, key: Uint8Array): Promise<Response> {
	let asked: WatchRequest;
	try {
		asked = readWatchRequest(await request.json());
	} catch (error: unknown) {
		return unreadable(error);
	}

	if (store.full()) {
		return unavailable("this instance is watching as many payments as it can");
	}
	const now = unixNow();
	if (asked.expiresAt <= now) {
		return invalidRequest("expires_at is already in the past, there is nothing left to watch");
	}
	if (asked.expiresAt > now + WATCH_HORIZON_SECS) {
		return invalidRequest(
			`expires_at is further off than the ${WATCH_HORIZON_SECS / 86_400} days this gateway will watch for`,
		);
	}

	const known = store.get(paymentId(key, asked.paymentHash));
	if (known && !isThisWatch(known, asked)) {
		return conflict(ALREADY_WATCHED, "This payment hash is already being watched here");
	}

	const watched = store.insert({
		lnAddress: null,
		amountMsat: null,
		status: "pending",
		paymentHash: asked.paymentHash,
		bolt11: null,
		preimage: null,
		expiresAt: asked.expiresAt,
		createdAt: now,
		verifyUrl: asked.verifyUrl,
		trigger: asked.trigger,
		sealed: asked.sealed,
		webhooks: [],
	});

	return json(paymentToWire(watched), 201);
}

async function quoted(request: Request): Promise<Response> {
	let asked: QuoteRequest;
	try {
		asked = readQuoteRequest(await request.json());
	} catch (error: unknown) {
		return unreadable(error);
	}

	try {
		const served = await quote(asked.addresses, asked.amountMsat);

		return json(quoteToWire(served.won, asked.amountMsat, served.refusals));
	} catch (error: unknown) {
		if (!(error instanceof NoWalletAvailable)) throw error;

		return problem(statusForWallets(error.wallets), {
			type: NO_WALLET_AVAILABLE,
			title: "No wallet would take this amount",
			wallets: error.wallets,
		});
	}
}

function pathOf(incoming: IncomingMessage): string {
	return new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "app"}`).pathname;
}

async function asRequest(incoming: IncomingMessage): Promise<Request> {
	if (Number(incoming.headers["content-length"] ?? 0) > MAX_REQUEST_BYTES) throw new BodyTooLarge();

	const headers = new Headers();
	for (const [name, value] of Object.entries(incoming.headers)) {
		if (typeof value === "string") headers.set(name, value);
	}
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of incoming) {
		bytes += (chunk as Buffer).length;
		if (bytes > MAX_REQUEST_BYTES) throw new BodyTooLarge();
		chunks.push(chunk as Buffer);
	}

	return new Request(`http://${incoming.headers.host ?? "app"}${incoming.url ?? "/"}`, {
		method: incoming.method,
		headers,
		body: Buffer.concat(chunks),
	});
}

function unreadable(error: unknown): Response {
	if (error instanceof SyntaxError) return invalidRequest("the request body is not JSON");
	if (error instanceof MalformedRequest) return invalidRequest(error.message);
	throw error;
}

function served(body: string, type: string): Response {
	return new Response(body, { headers: { "content-type": type } });
}

function rendered(): Response {
	return new Response(DOCS, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": DOCS_POLICY,
			"x-content-type-options": "nosniff",
		},
	});
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

function problem(status: number, body: Record<string, unknown>): Response {
	return Response.json(
		{ type: "about:blank", status, ...body },
		{ status, headers: { "content-type": "application/problem+json" } },
	);
}

function invalidRequest(detail: string): Response {
	return problem(400, { type: INVALID_REQUEST, title: "The request could not be read", detail });
}

function conflict(type: string, title: string): Response {
	return problem(409, { type, title });
}

function unauthorized(): Response {
	return problem(401, { title: "Unauthorized" });
}

function notFound(): Response {
	return problem(404, { title: "Not Found" });
}

function gone(detail: string): Response {
	return problem(410, { title: "Gone", detail });
}

function unavailable(detail: string): Response {
	return problem(503, { title: "Service Unavailable", detail });
}

function oversized(error: unknown): Response {
	if (!(error instanceof BodyTooLarge)) throw error;

	return problem(413, {
		type: INVALID_REQUEST,
		title: "The request body is larger than this gateway will read",
		detail: `the ceiling is ${MAX_REQUEST_BYTES} bytes, far above any request this API defines`,
	});
}

function unhandled(error: unknown): Response {
	console.error(`request failed: ${String(error)}`);
	return problem(500, { title: "Internal Server Error" });
}

if (import.meta.main) {
	const path = process.env["LEDGER"] ?? "./data/ledger.db";
	mkdirSync(dirname(path), { recursive: true });

	const clusterKey = secret("CLUSTER_KEY");
	const ledger = new Ledger(path, clusterKey, {
		takeoverAfterSecs: whole("TAKEOVER_AFTER_SECS", 600),
		deliveryBackoffSecs: whole("WEBHOOK_BACKOFF_SECS", 30),
	});
	const store = new Store(ledger, clusterKey, positive("MAX_PENDING", 5000));
	const cluster = new Cluster(store.gossip, {
		key: clusterKey,
		listenPort: whole("REPLICATE_LISTEN", 0),
		peers: (process.env["REPLICATE_PEERS"] ?? "").split(",").filter((peer) => peer.length > 0),
		swarm: process.env["SWARM"] !== "0",
	});
	console.log(`ledger ${path}, origin ${store.info().origin}`);

	const service = await start(
		{
			port: whole("PORT", 3000),
			eagerDelayMs: positive("POLL_INTERVAL_SECS", 5) * 1000,
			pollsPerSecond: positive("POLLS_PER_SEC", 5),
			tickStallMs: positive("TICK_STALL_SECS", 30) * 1000,
			drainTimeoutMs: positive("DRAIN_TIMEOUT_SECS", 10) * 1000,
			token: process.env["GATEWAY_TOKEN"] ?? null,
			key: clusterKey,
		},
		store,
	);

	let leaving = false;
	const leave = () => {
		if (leaving) process.exit(1);
		leaving = true;
		console.log("draining, and leaving once the tick in flight is done");
		void service.stop().then(() => {
			cluster.close();
			store.close();
			process.exit(0);
		});
	};
	process.on("SIGTERM", leave);
	process.on("SIGINT", leave);
}
