import { createHmac } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";

import SecretStream from "@hyperswarm/secret-stream";
import Hyperswarm from "hyperswarm";

import * as log from "./log.ts";
import { attach, resync, type Gossip } from "./gossip.ts";

const RESYNC_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 1000;

export type ClusterOptions = {
	key: Uint8Array;
	listenPort: number;
	peers: string[];
	swarm: boolean;
};

export class Cluster {
	private readonly gossip: Gossip;
	private readonly sockets = new Set<Socket>();
	private readonly timers = new Set<NodeJS.Timeout>();
	private readonly listener: Server | null;
	private readonly swarm: Hyperswarm | null;
	private closed = false;

	constructor(gossip: Gossip, options: ClusterOptions) {
		this.gossip = gossip;
		this.listener = options.listenPort > 0 ? this.listen(options.listenPort) : null;
		this.swarm = options.swarm ? this.join(options.key) : null;
		for (const peer of options.peers) this.dial(peer);
		this.timers.add(setInterval(() => resync(gossip), RESYNC_INTERVAL_MS).unref());
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const timer of this.timers) clearTimeout(timer);
		for (const socket of this.sockets) socket.destroy();
		this.listener?.close();
		void this.swarm?.destroy();
	}

	private listen(port: number): Server {
		return createServer((socket) => this.link(socket, false)).listen(port);
	}

	private join(key: Uint8Array): Hyperswarm {
		const topic = createHmac("sha256", key).update("cluster-topic").digest();
		const swarm = new Hyperswarm();
		swarm.on("connection", (connection) => attach(this.gossip, connection));
		swarm.join(topic, { server: true, client: true });
		log.debug(`swarming on ${topic.toString("hex")}`);

		return swarm;
	}

	private dial(peer: string): void {
		if (this.closed) return;
		const [host, port] = peer.split(":");
		const socket = connect({ host, port: Number(port) });
		socket.on("close", () => this.redial(peer));
		this.link(socket, true);
	}

	private redial(peer: string): void {
		const retry = setTimeout(() => {
			this.timers.delete(retry);
			this.dial(peer);
		}, RECONNECT_DELAY_MS).unref();
		this.timers.add(retry);
	}

	private link(socket: Socket, initiator: boolean): void {
		this.sockets.add(socket);
		socket.on("close", () => this.sockets.delete(socket));
		socket.on("error", () => socket.destroy());
		attach(this.gossip, new SecretStream(initiator, socket));
	}
}
