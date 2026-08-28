import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { preimageMatchesHash } from "../core/bolt11.ts";

export interface Bridged {
	recipient: string;
	wrap: string;
	state: "waiting" | "held" | "forwarding" | "settled" | "failed";
	preimage: string | null;
	note: string;
}

export interface Ledger {
	get(paymentHash: string): Bridged | undefined;
	set(paymentHash: string, bridged: Bridged): void;
	owed(): [string, Bridged][];
}

export type Settle = (preimage: string) => Promise<unknown>;

export interface Recovered {
	settled: string[];
	refused: string[];
	unprovable: string[];
}

export function ledgerAt(path: string): Ledger {
	const kept = new Map<string, Bridged>(
		existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as [string, Bridged][]) : [],
	);
	const flush = () => {
		const staging = `${path}.writing`;
		writeFileSync(staging, JSON.stringify([...kept], null, "\t"));
		renameSync(staging, path);
	};

	return {
		get: (paymentHash) => kept.get(paymentHash),
		set: (paymentHash, bridged) => {
			kept.set(paymentHash, bridged);
			flush();
		},
		owed: () => [...kept].filter(([, one]) => one.preimage !== null && one.state !== "settled"),
	};
}

export async function settleWhatIsOwed(ledger: Ledger, settle: Settle): Promise<Recovered> {
	const recovered: Recovered = { settled: [], refused: [], unprovable: [] };

	for (const [paymentHash, one] of ledger.owed()) {
		if (one.preimage === null || !preimageMatchesHash(one.preimage, paymentHash)) {
			recovered.unprovable.push(paymentHash);
			continue;
		}
		try {
			await settle(one.preimage);
			ledger.set(paymentHash, { ...one, state: "settled", note: "settled on recovery" });
			recovered.settled.push(paymentHash);
		} catch {
			recovered.refused.push(paymentHash);
		}
	}

	return recovered;
}
