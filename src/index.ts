import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import type { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

import { WebSocketServer, type WebSocket } from "ws";
import * as log from "./log.ts";

import { hexToBytes } from "../core/bytes.ts";
import { callerOf } from "../core/caller.ts";
import { signingKeyFromSeed, type SigningKey } from "../core/ed25519.ts";
import { equalInConstantTime, hmacHex } from "../core/hmac.ts";
import { mint as mintTicket, read as readTicket, type Subject } from "../core/ticket.ts";
import { Cluster } from "./cluster.ts";
import { allowed, bearer, positive, secret, whole } from "./env.ts";
import { Ledger } from "./ledger.ts";
import { pinnedToTheAddressWeVerified } from "./pinned.ts";
import { quote, resolve, RESOLVE_TIMEOUT_MS, speaksVerify } from "../core/lnurl.ts";
import { sendThrough } from "../core/outbound.ts";
import type { Payment } from "./payment.ts";
import {
	ALREADY_WATCHED,
	BodyTooLarge,
	INVALID_REQUEST,
	CALLER_UNKNOWN,
	KEY_REUSED,
	MalformedRequest,
	NoWalletAvailable,
	NO_WALLET_AVAILABLE,
	REQUEST_IN_FLIGHT,
	statusForWallets,
	TOO_MANY_PENDING,
	VERIFY_HOST_REFUSED,
	VERIFY_UNCONFIRMED,
	VERIFY_UNCONSENTED,
	WEBHOOK_UNCONFIRMED,
} from "./problem.ts";
import { Store } from "./store.ts";
import {
	confirmVerify,
	confirmWebhook,
	tick,
	unixNow,
	WATCH_HORIZON_SECS,
	type Watcher,
} from "./watch.ts";
import {
	fingerprint,
	keptToWire,
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
const MAX_INBOUND_BYTES = 64 * 1024;
const BEARER = "Bearer ";
const TICKET_TTL_SECS = 60;
const UNGATED = new Set(["/health", "/ready", "/openapi.yaml", "/docs", "/webhook-key"]);
const WEBHOOK_SIGNING_LABEL = "webhook-signing-v1";
const STALLED = "the watch loop has stopped being scheduled, so this instance needs replacing";
const LEAVING = "this instance is shutting down and is not taking new work";
const AT_CAPACITY = "this instance is watching as many payments as it can";
const SPEC = readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8");
const RENDERER = "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.64.0/dist/browser/standalone.js";
const RENDERER_HASH = "sha384-ei8P62VHbV+6AdLO3hN333PsTEYp6k9OAVhlYvpmer+zdPIf8jSbdgh9ojiLWX3T";
const RENDERER_ORIGIN = new URL(RENDERER).origin;
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
	workPerTick: number;
	verifyHosts: Set<string> | null;
	verifyChallenge: boolean;
	clientKeys: Set<string> | null;
	mints: boolean;
	tickStallMs: number;
	drainTimeoutMs: number;
	keepSealedSecs: number;
	token: string | null;
	key: Uint8Array;
};

export type Service = {
	port: number;
	stop: () => Promise<void>;
};

type Vitals = "serving" | "stalled" | "draining";

type Serving = {
	token: string | null;
	key: Uint8Array;
	keepSealedSecs: number;
	clientKeys: Set<string> | null;
	mints: boolean;
	webhookKey: SigningKey;
	verifyHosts: Set<string> | null;
	verifyChallenge: boolean;
};

export async function start(options: Options, store: Store): Promise<Service> {
	const token = options.token === "" ? null : options.token;
	const serving: Serving = {
		token,
		key: options.key,
		keepSealedSecs: options.keepSealedSecs,
		clientKeys: options.clientKeys,
		mints: options.mints,
		webhookKey: await webhookSigningKey(options.key),
		verifyHosts: options.verifyHosts,
		verifyChallenge: options.verifyChallenge,
	};
	const watcher: Watcher = {
		store,
		eagerDelayMs: options.eagerDelayMs,
		budget: {
			perSecond: options.pollsPerSecond,
			perTick: options.workPerTick,
			nextAt: new Map(),
			pace: new Map(),
			ceiling: new Map(),
		},
		webhookKey: serving.webhookKey,
	};

	let draining = false;
	let firedAt = Date.now();
	const vitals = (): Vitals =>
		draining ? "draining" : Date.now() - firedAt > options.tickStallMs ? "stalled" : "serving";

	const followers = new Map<WebSocket, Follower>();
	const upgrades = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_BYTES });
	const server = createServer((incoming, outgoing) => {
		void respond(incoming, store, serving, vitals()).then((answer) =>
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
			void readTicket(options.key, ticketed[1]!, unixNow())
				.then((permits) => {
					if (socket.destroyed) return;
					if (permits === null) {
						refuseUpgrade(socket);
						return;
					}
					upgrades.handleUpgrade(incoming, socket, head, (accepted) => {
						if (permits.kind === "trigger") subscribe(accepted, permits.trigger, store, followers);
						else follow(accepted, permits.paymentId, store, followers);
					});
				})
				.catch(() => refuseUpgrade(socket));
			return;
		}

		if (token !== null && !bearerMatches(incoming, token)) {
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
		for (const expired of store.sweep(EXPIRED_GRACE_SECS, options.keepSealedSecs)) publish(expired);
	}, SWEEP_INTERVAL_MS);

	let ticking = false;
	let inFlight: Promise<void> = Promise.resolve();
	const ticker = setInterval(() => {
		firedAt = Date.now();
		if (ticking) return;
		ticking = true;
		inFlight = tick(watcher)
			.catch((error: unknown) => log.warn(`tick failed: ${String(error)}`))
			.finally(() => {
				ticking = false;
			});
	}, TICK_INTERVAL_MS);

	const { port } = server.address() as AddressInfo;
	log.info(`listening on :${port}, polling ${watcher.budget.perSecond} payments a second`);

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
	serving: Serving,
	vitals: Vitals,
): Promise<Response> {
	if (incoming.method === "OPTIONS") return new Response(null, { status: 204, headers: OPEN });

	const answer =
		refused(incoming, serving.token) ??
		(await route(incoming, store, serving, vitals).catch(oversized).catch(unhandled));
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
	incoming: IncomingMessage,
	store: Store,
	token: string | null,
	vitals: Vitals,
): Response {
	if (vitals === "draining") return unavailable(LEAVING);

	const trusted = token !== null && bearerMatches(incoming, token);
	if (!trusted) return json({ status: "ready" });

	const info = store.info();

	return json({
		status: "ready",
		origin: info.origin,
		peers: info.peers,
		pending: info.pending,
		max_pending: info.maxPending,
		parked_deliveries: info.parked,
		watching: vitals === "stalled" ? "stalled" : "scheduled",
		sync: {
			state: info.convergedAt !== null ? "converged" : info.peers > 0 ? "catching-up" : "alone",
			converged_at: info.convergedAt,
			origins: info.origins,
			marks: info.marks,
			rows: info.rows,
		},
	});
}

async function reply(answer: Response, outgoing: ServerResponse): Promise<void> {
	outgoing.writeHead(answer.status, Object.fromEntries(answer.headers));
	outgoing.end(Buffer.from(await answer.arrayBuffer()));
}

async function route(
	incoming: IncomingMessage,
	store: Store,
	serving: Serving,
	vitals: Vitals,
): Promise<Response> {
	const path = pathOf(incoming);
	if (path === "/health") return vitals === "stalled" ? unavailable(STALLED) : new Response("OK");
	if (path === "/ready") return readiness(incoming, store, serving.token, vitals);
	if (path === "/openapi.yaml") return spec();
	if (path === "/docs") return rendered();
	if (path === "/webhook-key") return publishedWebhookKey(serving.webhookKey);

	const one = /^\/incoming-payments\/([\w-]+)$/.exec(path);
	if (one && incoming.method === "GET") {
		const caller = await callerFor(await asRequest(incoming));
		if (!accepted(caller, serving.clientKeys)) return unknownCaller();

		return handedTo(one[1]!, store, caller);
	}
	if (path === "/incoming-payments" && incoming.method === "GET") {
		return serving.token === null ? notFound() : listed(incoming, store);
	}
	if (path === "/incoming-payments" && incoming.method === "POST") {
		if (!mints(serving)) return mintsNothing(serving);
		const request = await asRequest(incoming);
		const caller = await callerFor(request);
		if (!accepted(caller, serving.clientKeys)) return unknownCaller();

		return await create(request, store, serving.webhookKey, caller);
	}
	if (path === "/quotes" && incoming.method === "POST") {
		if (!mints(serving)) return mintsNothing(serving);
		return await quoted(await asRequest(incoming));
	}
	if (path === "/watched-payments" && incoming.method === "POST") {
		const request = await asRequest(incoming);
		const caller = await callerFor(request);
		if (!accepted(caller, serving.clientKeys)) return unknownCaller();

		return await watchOnly(request, store, serving, caller);
	}
	if (path === "/ws-tickets" && incoming.method === "POST") {
		const request = await asRequest(incoming);
		const caller = await callerFor(request);
		if (!accepted(caller, serving.clientKeys)) return unknownCaller();

		return await ticketed(request, store, serving.key, caller);
	}

	return notFound();
}

/**
 * A payment is handed to the key that created it and to nobody else. A stranger
 * holding an id is answered 404 rather than 403, because a 403 would confirm the
 * payment exists, which is the question they were asking
 */
function handedTo(id: string, store: Store, caller: string | null): Response {
	const payment = store.get(id);
	if (payment) return belongsTo(payment, caller) ? json(paymentToWire(payment)) : notFound();

	const kept = store.kept(id);
	if (!kept || (kept.caller !== null && kept.caller !== caller)) return notFound();

	return json(keptToWire(kept));
}

/**
 * Whether this instance serves that caller at all. An instance keeping no list
 * serves everybody, which is what a gateway with one client is for
 */
function accepted(caller: string | null, clientKeys: Set<string> | null): boolean {
	return clientKeys === null || (caller !== null && clientKeys.has(caller));
}

function belongsTo(payment: Payment, caller: string | null): boolean {
	return payment.caller === null || payment.caller === caller;
}

async function callerFor(request: Request): Promise<string | null> {
	const asked = new URL(request.url);

	return await callerOf(
		request.headers,
		request.method,
		`${asked.pathname}${asked.search}`,
		await request.clone().text(),
	);
}

async function create(
	request: Request,
	store: Store,
	webhookKey: SigningKey,
	caller: string | null,
): Promise<Response> {
	let asked: CreateRequest;
	try {
		asked = readCreateRequest(await request.json());
	} catch (error: unknown) {
		return unreadable(error);
	}

	if (store.full(caller)) {
		return tooMany(caller, store.info().maxPending);
	}
	if (asked.webhook && !(await confirmWebhook(asked.webhook, webhookKey))) {
		return unconfirmedWebhook(asked.webhook.url);
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
		const payment = await mint(asked, store, caller);
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

async function mint(
	asked: CreateRequest,
	store: Store,
	caller: string | null,
): Promise<Payment> {
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
		caller,
		webhooks: asked.webhook ? [asked.webhook] : [],
	});
}

function replay(store: Store, paymentId: string): Response {
	const payment = store.get(paymentId);
	if (!payment) return gone("the payment this Idempotency-Key created has already been pruned");

	return json(paymentToWire(payment), 201);
}

async function ticketed(
	request: Request,
	store: Store,
	key: Uint8Array,
	caller: string | null,
): Promise<Response> {
	let asked: TicketRequest;
	try {
		asked = readTicketRequest(await request.json());
	} catch (error: unknown) {
		return unreadable(error);
	}

	if (asked.kind === "payment") {
		const payment = store.get(asked.paymentId);
		if (!payment || !belongsTo(payment, caller)) return notFound();
	}

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

async function watchOnly(
	request: Request,
	store: Store,
	serving: Serving,
	caller: string | null,
): Promise<Response> {
	const { webhookKey } = serving;
	let asked: WatchRequest;
	try {
		asked = readWatchRequest(await request.json());
	} catch (error: unknown) {
		return unreadable(error);
	}

	if (store.full(caller)) {
		return tooMany(caller, store.info().maxPending);
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

	const known = store.get(store.names({ caller, paymentHash: asked.paymentHash }));
	if (known && (!belongsTo(known, caller) || !isThisWatch(known, asked))) {
		return conflict(ALREADY_WATCHED, "This payment hash is already being watched here");
	}
	if (serving.verifyHosts && !serving.verifyHosts.has(hostOf(asked.verifyUrl))) {
		return refusedVerifyHost(asked.verifyUrl);
	}
	if (!(await speaksVerify(asked.verifyUrl))) {
		return unconfirmedVerify(asked.verifyUrl);
	}
	if (serving.verifyChallenge && !(await confirmVerify(asked.verifyUrl, webhookKey))) {
		return unconsentedVerify(asked.verifyUrl);
	}
	if (asked.webhook && !(await confirmWebhook(asked.webhook, webhookKey))) {
		return unconfirmedWebhook(asked.webhook.url);
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
		caller,
		webhooks: asked.webhook ? [asked.webhook] : [],
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
	return new URL(incoming.url ?? "/", "http://app").pathname;
}

async function asRequest(incoming: IncomingMessage): Promise<Request> {
	if (Number(incoming.headers["content-length"] ?? 0) > MAX_INBOUND_BYTES) throw new BodyTooLarge();

	const headers = new Headers();
	for (const [name, value] of Object.entries(incoming.headers)) {
		if (typeof value === "string") headers.set(name, value);
	}
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of incoming) {
		bytes += (chunk as Buffer).length;
		if (bytes > MAX_INBOUND_BYTES) throw new BodyTooLarge();
		chunks.push(chunk as Buffer);
	}

	const body = Buffer.concat(chunks);

	return new Request(`http://app${incoming.url ?? "/"}`, {
		method: incoming.method,
		headers,
		...(body.length === 0 ? {} : { body }),
	});
}

function unreadable(error: unknown): Response {
	if (error instanceof SyntaxError) return invalidRequest("the request body is not JSON");
	if (error instanceof MalformedRequest) return invalidRequest(error.message);
	throw error;
}

function spec(): Response {
	return new Response(SPEC, { headers: { "content-type": "application/yaml" } });
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

/**
 * A caller over its share is refused with the pace and the ceiling in the headers
 * the gateway itself reads off wallets, so a client learns the shape of the limit
 * from the refusal rather than from documentation
 */
function tooMany(caller: string | null, maxPending: number): Response {
	return new Response(
		JSON.stringify({
			type: TOO_MANY_PENDING,
			status: 429,
			title: "Too Many Requests",
			detail:
				caller === null
					? `${AT_CAPACITY}, and every caller who signs nothing shares one share of it`
					: AT_CAPACITY,
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/problem+json",
				"ratelimit-limit": `${maxPending}`,
				"ratelimit-remaining": "0",
			},
		},
	);
}

/** A caller this instance does not accept, on an instance that keeps a list of them */
function unknownCaller(): Response {
	return problem(403, {
		type: CALLER_UNKNOWN,
		title: "This gateway does not accept that key",
		detail: "this instance serves a list of client keys, and yours is not one of them",
	});
}

function unavailable(detail: string): Response {
	return problem(503, { title: "Service Unavailable", detail });
}

function oversized(error: unknown): Response {
	if (!(error instanceof BodyTooLarge)) throw error;

	return problem(413, {
		type: INVALID_REQUEST,
		title: "The request body is larger than this gateway will read",
		detail: `the ceiling is ${MAX_INBOUND_BYTES} bytes, far above any request this API defines`,
	});
}

async function webhookSigningKey(clusterKey: Uint8Array): Promise<SigningKey> {
	return await signingKeyFromSeed(hexToBytes(await hmacHex(clusterKey, WEBHOOK_SIGNING_LABEL)));
}

function publishedWebhookKey(key: SigningKey): Response {
	return json({ algorithm: "ed25519", public_key: key.publicKeyHex });
}

function hostOf(url: string): string {
	return new URL(url).hostname.toLowerCase();
}

/**
 * Minting is off unless an instance turns it on, because it is the one path where
 * the operator is handed the address and the amount in the clear and could log
 * them. A blind store protects nothing that was already read
 */
function mints(serving: Serving): boolean {
	return serving.mints && serving.verifyHosts === null;
}

function mintsNothing(serving: Serving): Response {
	return problem(403, {
		type: VERIFY_HOST_REFUSED,
		title: "This gateway only watches, it does not mint",
		detail: serving.verifyHosts
			? "VERIFY_HOSTS pins this instance to a list of verify endpoints, and minting an invoice would put it on a wallet's host instead. Resolve the address yourself and register the payment with POST /watched-payments."
			: "minting is off here, because it is the one path that hands the operator the address and the amount. Mint the invoice yourself and register it with POST /watched-payments, or ask the operator to set MINTING=1 and accept that they see both.",
	});
}

function refusedVerifyHost(url: string): Response {
	return problem(403, {
		type: VERIFY_HOST_REFUSED,
		title: "This gateway does not poll that host",
		detail: `${hostOf(url)} is not in the VERIFY_HOSTS this instance is pinned to, so it will not be polled. This gateway talks to a fixed set of endpoints and nothing else.`,
	});
}

function unconfirmedVerify(url: string): Response {
	return problem(424, {
		type: VERIFY_UNCONFIRMED,
		title: "The verify URL does not answer like a verify endpoint",
		detail: `${url} has to answer a JSON body carrying a boolean settled, the shape LUD-21 defines, before this gateway will poll it for days on your word`,
	});
}

function unconsentedVerify(url: string): Response {
	return problem(424, {
		type: VERIFY_UNCONSENTED,
		title: "The verify URL did not agree to be polled",
		detail: `${url} has to answer the challenge with the nonce it was given before this gateway will poll it, so a caller cannot aim it at a host that never asked for the traffic. Serve it with the client's own verify endpoint, or run the gateway with VERIFY_CHALLENGE=0 if every host its callers name is one you know`,
	});
}

function unconfirmedWebhook(url: string): Response {
	return problem(424, {
		type: WEBHOOK_UNCONFIRMED,
		title: "The webhook did not answer the challenge",
		detail: `${url} has to answer the challenge with the nonce it was given, signed with the secret registered alongside it, before this gateway will send anything to it`,
	});
}

function unhandled(error: unknown): Response {
	log.error(`request failed: ${String(error)}`);
	return problem(500, { title: "Internal Server Error" });
}

if (import.meta.main) {
	sendThrough(pinnedToTheAddressWeVerified);

	const path = process.env["LEDGER"] ?? "./data/ledger.db";
	mkdirSync(dirname(path), { recursive: true });

	const clusterKey = secret("CLUSTER_KEY");

	const ledger = new Ledger(
		path,
		clusterKey,
		{
			takeoverAfterSecs: whole("TAKEOVER_AFTER_SECS", 600),
			deliveryBackoffSecs: whole("WEBHOOK_BACKOFF_SECS", 30),
		},
	);
	const store = new Store(ledger, clusterKey, whole("MAX_PENDING", 5000));
	const cluster = new Cluster(store.gossip, {
		key: clusterKey,
		listenPort: whole("REPLICATE_LISTEN", 0),
		peers: (process.env["REPLICATE_PEERS"] ?? "").split(",").filter((peer) => peer.length > 0),
		swarm: process.env["SWARM"] !== "0",
	});
	log.info(`ledger ${path}, origin ${store.info().origin}`);

	const service = await start(
		{
			port: whole("PORT", 3000),
			eagerDelayMs: positive("POLL_INTERVAL_SECS", 5) * 1000,
			workPerTick: positive("WORK_PER_TICK", 50),
			verifyHosts: allowed("VERIFY_HOSTS"),
			verifyChallenge: process.env["VERIFY_CHALLENGE"] !== "0",
			clientKeys: allowed("CLIENT_KEYS"),
			mints: process.env["MINTING"] === "1",
			pollsPerSecond: positive("POLLS_PER_SEC", 5),
			tickStallMs: positive("TICK_STALL_SECS", 30) * 1000,
			drainTimeoutMs: positive("DRAIN_TIMEOUT_SECS", 10) * 1000,
			keepSealedSecs: positive("KEEP_SEALED_DAYS", 90) * 86_400,
			token: bearer("GATEWAY_TOKEN"),
			key: clusterKey,
		},
		store,
	);

	let leaving = false;
	const leave = () => {
		if (leaving) process.exit(1);
		leaving = true;
		log.info("draining, and leaving once the tick in flight is done");
		void service.stop().then(() => {
			cluster.close();
			store.close();
			process.exit(0);
		});
	};
	process.on("SIGTERM", leave);
	process.on("SIGINT", leave);
}
