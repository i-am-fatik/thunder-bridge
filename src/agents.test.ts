import { expect, test } from "vitest";

import { type Agents, attend, attending } from "./agents.ts";

type Listener = () => void;

class FakeSocket {
	private readonly listeners = new Map<string, Listener[]>();

	on(event: string, listener: Listener): this {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
		return this;
	}

	fire(event: string): void {
		for (const listener of this.listeners.get(event) ?? []) {
			listener();
		}
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
