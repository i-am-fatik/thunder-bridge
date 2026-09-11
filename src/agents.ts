import type { WebSocket } from "ws";

import { preimageMatchesHash } from "../core/bolt11.ts";
import { bytesToHex } from "../core/bytes.ts";
import type { Settlement } from "../core/lnurl.ts";

const ANSWER_MS = 10_000;

/** Every socket a caller is holding open right now, by the key it speaks as */
export type Agents = Map<string, Set<WebSocket>>;

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
	const [socket] = agents.get(caller) ?? [];
	if (socket === undefined) {
		return null;
	}

	const ask = bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
	const answered = new Promise<Answer | null>((resolve) => {
		const hear = (raw: unknown): void => {
			const answer = answerTo(ask, raw);
			if (answer === null) {
				return;
			}

			socket.off("message", hear);
			clearTimeout(timer);
			resolve(answer);
		};
		const timer = setTimeout(() => {
			socket.off("message", hear);
			resolve(null);
		}, ANSWER_MS);

		socket.on("message", hear);
	});

	socket.send(JSON.stringify({ ask, payment_hash: paymentHash }));
	const answer = await answered;
	if (answer === null) {
		return null;
	}
	if (answer.preimage !== null && !preimageMatchesHash(answer.preimage, paymentHash)) {
		throw new Error(`the agent answered a preimage that does not hash to ${paymentHash}`);
	}

	return { preimage: answer.preimage, pace: null, ceiling: null };
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
