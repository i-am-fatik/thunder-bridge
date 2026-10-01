import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { vi } from "vitest";

import { Cluster } from "./cluster.ts";
import { Ledger } from "./ledger.ts";
import { Store } from "./store.ts";

export const CLUSTER_KEY = Buffer.from("09".repeat(32), "hex");

const WAIT_TIMEOUT_MS = 20_000;
const WAIT_POLL_MS = 25;
const BELOW_EPHEMERAL_PORTS = { from: 20_000, to: 32_000 };

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
	const store = new Store(ledger, key, { maxPending });
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

export function refusals(absorbing: () => void): string[] {
	const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		absorbing();

		return warned.mock.calls
			.map(([message]) => String(message))
			.filter((message) => message.startsWith("refusing a fact"));
	} finally {
		warned.mockRestore();
	}
}

export async function freePort(): Promise<number> {
	for (;;) {
		const port =
			BELOW_EPHEMERAL_PORTS.from +
			Math.floor(Math.random() * (BELOW_EPHEMERAL_PORTS.to - BELOW_EPHEMERAL_PORTS.from));
		if ((await bindable(port, "127.0.0.1")) && (await bindable(port, "::"))) {
			return port;
		}
	}
}

function bindable(port: number, host: string): Promise<boolean> {
	return new Promise((answer) => {
		const probe = createServer();
		probe.once("error", () => answer(false));
		probe.listen(port, host, () => probe.close(() => answer(true)));
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
