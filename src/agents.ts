import type { WebSocket } from "ws";

import { preimageMatchesHash } from "../core/bolt11.ts";
import { bytesToHex } from "../core/bytes.ts";
import type { Settlement } from "../core/lnurl.ts";

const ANSWER_MS = 10_000;

/** Every socket a caller is holding open right now, by the key it speaks as */
export type Agents = Map<string, Set<WebSocket>>;

const unanswered = new WeakSet<WebSocket>();

/**
 * Hold one caller's socket for as long as it lives. A caller answers from as
 * many devices as it has open, so the sockets are a set and the last one to
 * leave takes the entry with it
 */
export function attend(socket: WebSocket, caller: string, agents: Agents): void {
	const held = agents.get(caller) ?? new Set<WebSocket>();
	held.add(socket);
	agents.set(caller, held);

	const leave = (): void => {
		held.delete(socket);
		if (held.size === 0) {
			agents.delete(caller);
		}
	};

	socket.on("close", leave);
	socket.on("error", leave);
	socket.on("pong", () => unanswered.delete(socket));
}

export function keepAlive(agents: Agents): void {
	for (const held of agents.values()) {
		for (const socket of held) {
			if (unanswered.has(socket)) {
				socket.terminate();
				continue;
			}
			unanswered.add(socket);
			socket.ping();
		}
	}
}

/**
 * Put one payment to whichever of a caller's sockets answers first, as the poll
 * would have put it to a URL. Null when nobody is holding one open, which leaves
 * the payment due rather than failed
 */
export async function askAnAgent(
	agents: Agents,
	caller: string,
	paymentHash: string,
): Promise<Settlement | null> {
	const held = [...(agents.get(caller) ?? [])];
	if (held.length === 0) {
		return null;
	}

	const ask = bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
	const answered = new Promise<Answer[]>((resolve) => {
		const heard: Answer[] = [];
		const listening = held.map((socket) => {
			const hear = (raw: unknown): void => {
				const answer = answerTo(ask, raw);
				if (answer === null) {
					return;
				}

				socket.off("message", hear);
				heard.push(answer);
				if (heard.length === held.length || proves(answer, paymentHash)) {
					done();
				}
			};

			return { socket, hear };
		});
		const done = (): void => {
			clearTimeout(timer);
			for (const { socket, hear } of listening) {
				socket.off("message", hear);
			}
			resolve(heard);
		};
		const timer = setTimeout(done, ANSWER_MS);

		for (const { socket, hear } of listening) {
			socket.on("message", hear);
		}
	});

	for (const socket of held) {
		socket.send(JSON.stringify({ ask, payment_hash: paymentHash }));
	}
	const answers = await answered;
	const proven = answers.find((answer) => proves(answer, paymentHash));
	if (proven) {
		return { preimage: proven.preimage, pace: null, ceiling: null };
	}
	if (answers.some((answer) => answer.preimage !== null)) {
		throw new Error(`the agent answered a preimage that does not hash to ${paymentHash}`);
	}

	return answers.length === 0 ? null : { preimage: null, pace: null, ceiling: null };
}

function proves(answer: Answer, paymentHash: string): boolean {
	return answer.preimage !== null && preimageMatchesHash(answer.preimage, paymentHash);
}

type Answer = { preimage: string | null };

function answerTo(ask: string, raw: unknown): Answer | null {
	let said: unknown;
	try {
		said = JSON.parse(String(raw));
	} catch {
		return null;
	}

	if (typeof said !== "object" || said === null) {
		return null;
	}

	const fields = said as Record<string, unknown>;
	if (fields["ask"] !== ask) {
		return null;
	}

	return {
		preimage:
			fields["settled"] === true && typeof fields["preimage"] === "string"
				? fields["preimage"]
				: null,
	};
}
