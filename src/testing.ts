import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Cluster } from "./cluster.ts";
import { Ledger } from "./ledger.ts";
import { Store } from "./store.ts";

export const CLUSTER_KEY = Buffer.from("09".repeat(32), "hex");

const WAIT_TIMEOUT_MS = 20_000;
const WAIT_POLL_MS = 25;

export type Opened = {
	store: Store;
	stop: () => void;
};

export type TestOptions = {
	ledgerPath?: string;
	listenPort?: number;
	peers?: string[];
	maxPending?: number;
	takeoverAfterSecs?: number;
	deliveryBackoffSecs?: number;
	key?: Uint8Array;
};

export function openStore({
	ledgerPath,
	key = CLUSTER_KEY,
	listenPort,
	peers,
	maxPending,
	takeoverAfterSecs,
	deliveryBackoffSecs,
}: TestOptions = {}): Opened {
	const path = ledgerPath ?? join(mkdtempSync(join(tmpdir(), "tbd-")), "ledger.db");
	const ledger = new Ledger(path, key, { takeoverAfterSecs, deliveryBackoffSecs });
	const store = new Store(ledger, key, maxPending);
	const cluster = new Cluster(store.gossip, { key, listenPort, peers, swarm: false });

	return {
		store,
		stop: () => {
			cluster.close();
			store.close();
			if (ledgerPath === undefined) {
				rmSync(dirname(path), { recursive: true, force: true });
			}
		},
	};
}

export function freePort(): Promise<number> {
	return new Promise((found) => {
		const probe = createServer();
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as AddressInfo;
			probe.close(() => found(port));
		});
	});
}

export async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await sleep(WAIT_POLL_MS);
	}
}
