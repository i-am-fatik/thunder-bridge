import { createHash } from "node:crypto";
import { expect, test } from "vitest";

import { type Agents, askAnAgent, attend, attending } from "./agents.ts";

type Heard = (said?: unknown) => void;

class FakeSocket {
	private readonly listeners = new Map<string, Heard[]>();
	readonly sent: string[] = [];

	on(event: string, listener: Heard): this {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
		return this;
	}

	off(event: string, listener: Heard): this {
		this.listeners.set(
			event,
			(this.listeners.get(event) ?? []).filter((held) => held !== listener),
		);
		return this;
	}

	send(frame: string): void {
		this.sent.push(frame);
	}

	fire(event: string, said?: unknown): void {
		for (const listener of [...(this.listeners.get(event) ?? [])]) {
			listener(said);
		}
	}

	asked(): { ask: string; payment_hash: string } {
		return JSON.parse(this.sent[this.sent.length - 1] ?? "{}") as {
			ask: string;
			payment_hash: string;
		};
	}
}

const CALLER = "a".repeat(64);
const OTHER_CALLER = "b".repeat(64);

function opened(): { agents: Agents; socket: FakeSocket } {
	const agents: Agents = new Map();
	const socket = new FakeSocket();
	attend(socket as never, CALLER, agents);

	return { agents, socket };
}

test("a caller with a socket open is there to answer", () => {
	const { agents } = opened();

	expect(attending(CALLER, agents)).toBe(true);
	expect(attending(OTHER_CALLER, agents)).toBe(false);
	expect(attending(null, agents)).toBe(false);
});

test("a caller answers from as many devices as it has open", () => {
	const { agents } = opened();
	attend(new FakeSocket() as never, CALLER, agents);

	expect(agents.get(CALLER)?.size).toBe(2);
});

test("a socket that closes stops answering, and the last one out takes the caller with it", () => {
	const { agents, socket } = opened();
	const second = new FakeSocket();
	attend(second as never, CALLER, agents);

	socket.fire("close");
	expect(attending(CALLER, agents)).toBe(true);

	second.fire("close");
	expect(attending(CALLER, agents)).toBe(false);
	expect(agents.has(CALLER)).toBe(false);
});

test("a socket that errors leaves as surely as one that closes", () => {
	const { agents, socket } = opened();

	socket.fire("error");

	expect(attending(CALLER, agents)).toBe(false);
});

test("one caller leaving says nothing about another", () => {
	const { agents, socket } = opened();
	attend(new FakeSocket() as never, OTHER_CALLER, agents);

	socket.fire("close");

	expect(attending(CALLER, agents)).toBe(false);
	expect(attending(OTHER_CALLER, agents)).toBe(true);
});

const PREIMAGE = "1".repeat(64);
const HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");

function answering(): { agents: Agents; socket: FakeSocket } {
	const agents: Agents = new Map();
	const socket = new FakeSocket();
	attend(socket as never, CALLER, agents);

	return { agents, socket };
}

test("a caller with nobody holding a socket answers nothing, rather than failing", async () => {
	expect(await askAnAgent(new Map(), CALLER, HASH)).toBeNull();
});

test("the ask names the payment, and the answer to it settles the payment", async () => {
	const { agents, socket } = answering();

	const answered = askAnAgent(agents, CALLER, HASH);
	expect(socket.asked().payment_hash).toBe(HASH);
	socket.fire(
		"message",
		JSON.stringify({ ask: socket.asked().ask, settled: true, preimage: PREIMAGE }),
	);

	expect(await answered).toEqual({ preimage: PREIMAGE, pace: null, ceiling: null });
});

test("an answer to somebody else's ask is not this one's answer", async () => {
	const { agents, socket } = answering();

	const answered = askAnAgent(agents, CALLER, HASH);
	socket.fire(
		"message",
		JSON.stringify({ ask: "someone-else", settled: true, preimage: PREIMAGE }),
	);
	socket.fire("message", JSON.stringify({ ask: socket.asked().ask, settled: false }));

	expect(await answered).toEqual({ preimage: null, pace: null, ceiling: null });
});

test("nothing landed yet is an answer too", async () => {
	const { agents, socket } = answering();

	const answered = askAnAgent(agents, CALLER, HASH);
	socket.fire("message", JSON.stringify({ ask: socket.asked().ask, settled: false }));

	expect((await answered)?.preimage).toBeNull();
});

test("a preimage that does not hash to the payment is refused, not believed", async () => {
	const { agents, socket } = answering();

	const answered = askAnAgent(agents, CALLER, HASH);
	socket.fire(
		"message",
		JSON.stringify({ ask: socket.asked().ask, settled: true, preimage: "2".repeat(64) }),
	);

	await expect(answered).rejects.toThrow("does not hash to");
});

test("rubbish on the socket is ignored rather than parsed into an answer", async () => {
	const { agents, socket } = answering();

	const answered = askAnAgent(agents, CALLER, HASH);
	socket.fire("message", "not json");
	socket.fire("message", JSON.stringify(["not an object"]));
	socket.fire("message", JSON.stringify({ ask: socket.asked().ask, settled: false }));

	expect((await answered)?.preimage).toBeNull();
});

test("the listener leaves with its answer, so one socket serves ask after ask", async () => {
	const { agents, socket } = answering();

	const first = askAnAgent(agents, CALLER, HASH);
	socket.fire("message", JSON.stringify({ ask: socket.asked().ask, settled: false }));
	await first;

	const second = askAnAgent(agents, CALLER, HASH);
	socket.fire(
		"message",
		JSON.stringify({ ask: socket.asked().ask, settled: true, preimage: PREIMAGE }),
	);

	expect((await second)?.preimage).toBe(PREIMAGE);
});
