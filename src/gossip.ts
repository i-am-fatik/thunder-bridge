import { createHmac, timingSafeEqual } from "node:crypto";

import type SecretStream from "@hyperswarm/secret-stream";
import c from "compact-encoding";
import Protomux from "protomux";
import type { Facts, Watermarks } from "./ledger.ts";
import * as log from "./log.ts";

const PROTOCOL = "thunder-cluster";

export type Note = { have: Watermarks } | { facts: Facts; more: boolean; through?: Watermarks };

export type Gossip = {
	self: string;
	key: Uint8Array;
	peers: Map<string, (note: Note) => void>;
	onFacts: (facts: Facts, through?: Watermarks) => void;
	onConverged: () => void;
	watermarks: () => Watermarks;
	since: (theirs: Watermarks) => { facts: Facts; more: boolean; through: Watermarks };
};

type Introduction = { self: string; proof: string };

export function announce(gossip: Gossip, note: Note): void {
	for (const send of gossip.peers.values()) {
		send(note);
	}
}

export function resync(gossip: Gossip): void {
	announce(gossip, { have: gossip.watermarks() });
}

export function attach(gossip: Gossip, stream: SecretStream): void {
	let peer = "";
	const channel = Protomux.from(stream).createChannel({
		protocol: PROTOCOL,
		handshake: c.json,
		onopen: (them: Introduction) => {
			if (them?.self === gossip.self || !introduces([gossip.key], stream.handshakeHash, them)) {
				log.warn("a peer without the cluster key tried to join");
				stream.destroy();
				return;
			}
			peer = them.self;
			gossip.peers.set(peer, (outgoing) => note.send(outgoing));
			note.send({ have: gossip.watermarks() });
		},
		onclose: () => {
			if (peer) {
				gossip.peers.delete(peer);
			}
		},
	});
	if (!channel) {
		return;
	}

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

	void stream.opened.then((open) => {
		const session = stream.handshakeHash;
		if (open && session !== null) {
			channel.open({ self: gossip.self, proof: proofOf(gossip.key, session, gossip.self) });
		}
	});
}

function receive(gossip: Gossip, note: Note, reply: { send(note: Note): void }): void {
	if ("have" in note) {
		reply.send(gossip.since(note.have));
	} else if ("facts" in note) {
		const asked = reach(gossip.watermarks());
		gossip.onFacts(note.facts, note.through);
		if (!note.more) {
			gossip.onConverged();
		} else if (reach(gossip.watermarks()) > asked) {
			reply.send({ have: gossip.watermarks() });
		}
	}
}

function reach(marks: Watermarks): number {
	return Object.values(marks)
		.flatMap((byOrigin) => Object.values(byOrigin))
		.reduce((all, seq) => all + seq, 0);
}

function proofOf(key: Uint8Array, session: Uint8Array, self: string): string {
	return createHmac("sha256", key)
		.update("cluster-handshake")
		.update(session)
		.update(self)
		.digest("hex");
}

function introduces(keys: Uint8Array[], session: Uint8Array | null, them: Introduction): boolean {
	if (session === null || typeof them?.self !== "string" || typeof them.proof !== "string") {
		return false;
	}
	const got = Buffer.from(them.proof, "hex");

	return keys.some((key) => {
		const want = Buffer.from(proofOf(key, session, them.self), "hex");
		return want.length === got.length && timingSafeEqual(want, got);
	});
}
