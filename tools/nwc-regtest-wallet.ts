import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import {
	conversationKeyFor,
	decryptNip44,
	encryptNip44,
	type NostrEvent,
	publicKeyFor,
	signEvent,
} from "../sdk/src/nostr";

const REQUEST_KIND = 23194;
const RESPONSE_KIND = 23195;
const WALLET_KEY = "a1".repeat(32);
const CLIENT_KEY = "b2".repeat(32);
const LND = ["lncli", "--lnddir=/home/lnd/.lnd", "-n", "regtest"];

export interface RegtestWallet {
	uri: string;
	asked: string[];
	close(): Promise<void>;
}

export interface WalletOptions {
	container?: string;
	answerInstead?: (
		method: string,
		params: Record<string, unknown>,
	) => Record<string, unknown> | undefined;
}

interface Asked {
	method: string;
	params: Record<string, unknown>;
}

interface Subscription {
	id: string;
	filters: Record<string, unknown>[];
}

export async function startRegtestWallet({
	container = "wrap-wrapper",
	answerInstead,
}: WalletOptions = {}): Promise<RegtestWallet> {
	const trustedBefore = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

	const walletPubkey = publicKeyFor(WALLET_KEY);
	const clientPubkey = publicKeyFor(CLIENT_KEY);
	const conversation = conversationKeyFor(WALLET_KEY, clientPubkey);
	const asked: string[] = [];

	const { key, cert } = selfSigned();
	const https = createServer({ key, cert });
	const relay = new WebSocketServer({ server: https });

	const requested = (request: NostrEvent) =>
		JSON.parse(decryptNip44(conversation, request.content)) as Asked;

	const signedAnswer = (request: NostrEvent, said: Asked) =>
		signEvent(WALLET_KEY, {
			kind: RESPONSE_KIND,
			tags: [
				["p", request.pubkey],
				["e", request.id],
			],
			content: encryptNip44(
				conversation,
				JSON.stringify(answerFor(container, said, answerInstead)),
			),
			created_at: Math.floor(Date.now() / 1000),
		});

	relay.on("connection", (socket) => {
		const subscriptions = new Map<string, Subscription>();

		socket.on("message", (raw) => {
			const frame = parsedFrame(String(raw));
			if (frame === null) {
				return;
			}

			if (frame[0] === "REQ" && typeof frame[1] === "string") {
				subscriptions.set(frame[1], {
					id: frame[1],
					filters: frame.slice(2) as Record<string, unknown>[],
				});
				socket.send(JSON.stringify(["EOSE", frame[1]]));
				return;
			}

			if (frame[0] === "CLOSE" && typeof frame[1] === "string") {
				subscriptions.delete(frame[1]);
				return;
			}

			if (frame[0] !== "EVENT") {
				return;
			}

			const request = frame[1] as NostrEvent;
			socket.send(JSON.stringify(["OK", request.id, true, ""]));
			if (request.kind !== REQUEST_KIND) {
				return;
			}

			const said = requested(request);
			asked.push(said.method);
			const response = signedAnswer(request, said);

			for (const subscription of subscriptions.values()) {
				if (matches(subscription.filters, response)) {
					socket.send(JSON.stringify(["EVENT", subscription.id, response]));
				}
			}
		});
	});

	await new Promise<void>((listening) => https.listen(0, "127.0.0.1", listening));
	const port = (https.address() as { port: number }).port;
	const wss = `wss://127.0.0.1:${port}`;

	return {
		uri: `nostr+walletconnect://${walletPubkey}?relay=${encodeURIComponent(wss)}&secret=${CLIENT_KEY}`,
		asked,
		close: async () => {
			await shutDown(relay, https);
			process.env.NODE_TLS_REJECT_UNAUTHORIZED = trustedBefore;
		},
	};
}

function answerFor(
	container: string,
	said: Asked,
	answerInstead: WalletOptions["answerInstead"],
): Record<string, unknown> {
	try {
		const staged = answerInstead?.(said.method, said.params);
		const result = staged ?? dispatch(container, said.method, said.params);

		return { result_type: said.method, result };
	} catch (refused: unknown) {
		return {
			result_type: said.method,
			error: { code: "INTERNAL", message: reasonFrom(refused) },
		};
	}
}

type Answer = (
	node: (...args: string[]) => Record<string, unknown>,
	params: Record<string, unknown>,
) => Record<string, unknown>;

const ANSWERS: Record<string, Answer> = {
	make_invoice: (node, params) => {
		const made = node("addinvoice", `--amt_msat=${params.amount}`, `--memo=${params.description}`);

		return { invoice: String(made.payment_request), payment_hash: String(made.r_hash) };
	},

	make_hold_invoice: (node, params) => {
		const delta = params.min_cltv_expiry_delta;
		const held = node(
			"addholdinvoice",
			`--amt_msat=${params.amount}`,
			`--expiry=${params.expiry}`,
			...(delta === undefined ? [] : [`--cltv_expiry_delta=${delta}`]),
			String(params.payment_hash),
		);

		return { invoice: String(held.payment_request), payment_hash: String(params.payment_hash) };
	},

	pay_invoice: (node, params) => {
		const sent = node("payinvoice", "--force", "--json", String(params.invoice));

		return { preimage: String(sent.payment_preimage), fees_paid: Number(sent.fee_msat ?? 0) };
	},

	lookup_invoice: (node, params) => {
		const found = node("lookupinvoice", String(params.payment_hash));
		const settled = found.state === "SETTLED";

		return {
			invoice: String(found.payment_request),
			payment_hash: String(found.r_hash),
			state: String(found.state).toLowerCase(),
			preimage: settled ? String(found.r_preimage) : "",
			amount: Number(found.value_msat ?? 0),
			settled_at: settled ? Number(found.settle_date ?? 0) : null,
		};
	},

	settle_hold_invoice: (node, params) => {
		node("settleinvoice", String(params.preimage));

		return {};
	},

	cancel_hold_invoice: (node, params) => {
		node("cancelinvoice", String(params.payment_hash));

		return {};
	},
};

function dispatch(
	container: string,
	method: string,
	params: Record<string, unknown>,
): Record<string, unknown> {
	const answer = ANSWERS[method];
	if (answer === undefined) {
		throw new Error(`this regtest wallet does not speak ${method}`);
	}

	return answer((...args: string[]) => lncli(container, ...args), params);
}

function lncli(container: string, ...args: string[]): Record<string, unknown> {
	const out = execFileSync("docker", ["exec", container, ...LND, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	return out.trim().length === 0 ? {} : (JSON.parse(out) as Record<string, unknown>);
}

function reasonFrom(refused: unknown): string {
	const stderr = (refused as { stderr?: unknown }).stderr;
	if (typeof stderr !== "string" || stderr.trim().length === 0) {
		return String(refused);
	}

	return stderr.trim().split("\n").at(-1) ?? stderr.trim();
}

function matches(filters: Record<string, unknown>[], event: NostrEvent): boolean {
	const tagged = (name: string) => event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1]);
	const carried: Record<string, unknown[]> = {
		kinds: [event.kind],
		authors: [event.pubkey],
		"#e": tagged("e"),
		"#p": tagged("p"),
	};

	return filters.some((filter) =>
		Object.entries(carried).every(([field, mine]) => {
			const asked = filter[field] as unknown[] | undefined;

			return asked === undefined || asked.some((one) => mine.includes(one));
		}),
	);
}

function parsedFrame(raw: string): unknown[] | null {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function selfSigned(): { key: Buffer; cert: Buffer } {
	const into = mkdtempSync(join(tmpdir(), "nwc-regtest-"));
	const keyPath = join(into, "key.pem");
	const certPath = join(into, "cert.pem");

	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			keyPath,
			"-out",
			certPath,
			"-days",
			"2",
			"-subj",
			"/CN=127.0.0.1",
			"-addext",
			"subjectAltName=IP:127.0.0.1,DNS:localhost",
		],
		{ stdio: "ignore" },
	);

	const pair = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
	rmSync(into, { recursive: true, force: true });

	return pair;
}

function shutDown(relay: WebSocketServer, https: Server): Promise<void> {
	return new Promise((closed) => {
		for (const client of relay.clients) {
			client.terminate();
		}
		relay.close(() => https.close(() => closed()));
	});
}
