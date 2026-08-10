import { createHmac, timingSafeEqual } from "node:crypto";

import c from "compact-encoding";
import Protomux from "protomux";

import * as log from "./log.ts";
import type { Facts, Watermarks } from "./ledger.ts";
import type { Payment } from "./payment.ts";

const PROTOCOL = "thunder-cluster";

export type Note =
	| { have: Watermarks }
	| { facts: Facts; more: boolean }
	| { pending: Payment[] }
	| { add: Payment };

export type Gossip = {
	self: string;
	key: Uint8Array;
	peers: Map<string, (note: Note) => void>;
	onAdd: (payment: Payment) => void;
	onFacts: (facts: Facts) => void;
	onConverged: () => void;
	watermarks: () => Watermarks;
	held: () => Payment[];
	since: (theirs: Watermarks) => { facts: Facts; more: boolean };
};

type Introduction = { self: string; proof: string };

export function announce(gossip: Gossip, note: Note): void {
	for (const send of gossip.peers.values()) send(note);
}

export function resync(gossip: Gossip): void {
	announce(gossip, { have: gossip.watermarks() });
}

export function attach(gossip: Gossip, stream: unknown): void {
	let peer = "";
	const channel = Protomux.from(stream).createChannel({
		protocol: PROTOCOL,
		handshake: c.json,
		onopen: (them: Introduction) => {
			if (!introduces(gossip.key, them)) {
				log.warn("a peer without the cluster key tried to join");
				channel?.close();
				return;
			}
			peer = them.self;
			gossip.peers.set(peer, (outgoing) => note.send(outgoing));
			note.send({ have: gossip.watermarks() });
			note.send({ pending: gossip.held() });
		},
		onclose: () => {
			if (peer) gossip.peers.delete(peer);
		},
	});
	if (!channel) return;

	const note = channel.addMessage({
		encoding: c.json,
		onmessage: (incoming: Note) => {
			try {
				receive(gossip, incoming, note);
			} catch (error: unknown) {
				log.warn(`dropping a peer that sent an unusable note: ${String(error)}`);
				channel.close();
			}
		},
	});

	channel.open({ self: gossip.self, proof: proofOf(gossip.key, gossip.self) });
}

function receive(gossip: Gossip, note: Note, reply: { send(note: Note): void }): void {
	if ("have" in note) {
		reply.send(gossip.since(note.have));
	} else if ("facts" in note) {
		gossip.onFacts(note.facts);
		if (note.more) reply.send({ have: gossip.watermarks() });
		else gossip.onConverged();
	} else if ("pending" in note) {
		for (const payment of note.pending) gossip.onAdd(payment);
	} else {
		gossip.onAdd(note.add);
	}
}

function proofOf(key: Uint8Array, self: string): string {
	return createHmac("sha256", key).update("cluster-handshake").update(self).digest("hex");
}

function introduces(key: Uint8Array, them: Introduction): boolean {
	if (typeof them?.self !== "string" || typeof them.proof !== "string") return false;
	const want = Buffer.from(proofOf(key, them.self), "hex");
	const got = Buffer.from(them.proof, "hex");

	return want.length === got.length && timingSafeEqual(want, got);
}
