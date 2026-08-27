import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Bridged, ledgerAt, settleWhatIsOwed } from "./wrap-ledger.ts";

const HASH = "48717257acedf208f898cb430560b41ebae5b7ca4b48b3168356441c9caa0965";
const PREIMAGE = "d57d9fd68b0f4913ac30e8b212da59bdab172154ff1957ca9377523d07713868";

function bridged(over: Partial<Bridged> = {}): Bridged {
	return {
		recipient: "lnbcrt210u1recipient",
		wrap: "lnbcrt211575n1wrap",
		state: "held",
		preimage: null,
		note: "waiting for the wrap to be paid",
		...over,
	};
}

describe("the ledger a restart reads back", () => {
	let into = "";
	let path = "";

	beforeEach(() => {
		into = mkdtempSync(join(tmpdir(), "wrap-ledger-"));
		path = join(into, "ledger.json");
	});

	afterEach(() => {
		rmSync(into, { recursive: true, force: true });
	});

	it("starts empty when nothing was ever written", () => {
		expect(ledgerAt(path).get(HASH)).toBeUndefined();
		expect(ledgerAt(path).owed()).toEqual([]);
	});

	it("hands a written wrap back to the next process", () => {
		ledgerAt(path).set(HASH, bridged({ note: "held before the crash" }));

		expect(ledgerAt(path).get(HASH)?.note).toBe("held before the crash");
	});

	it("names a preimage that was learned but never settled, which is the loss window", () => {
		ledgerAt(path).set(HASH, bridged({ state: "forwarding", preimage: PREIMAGE }));

		expect(ledgerAt(path).owed()).toEqual([
			[HASH, expect.objectContaining({ preimage: PREIMAGE })],
		]);
	});

	it("owes nothing once the wrap is settled", () => {
		ledgerAt(path).set(HASH, bridged({ state: "settled", preimage: PREIMAGE }));

		expect(ledgerAt(path).owed()).toEqual([]);
	});

	it("owes nothing for a wrap that never learned a preimage", () => {
		ledgerAt(path).set(HASH, bridged({ state: "held" }));

		expect(ledgerAt(path).owed()).toEqual([]);
	});

	it("leaves no half-written file behind, because the write is a rename", () => {
		ledgerAt(path).set(HASH, bridged({ preimage: PREIMAGE, state: "forwarding" }));

		expect(existsSync(path)).toBe(true);
		expect(existsSync(`${path}.writing`)).toBe(false);
	});

	it("keeps the newest state for a hash it already carries", () => {
		const first = ledgerAt(path);
		first.set(HASH, bridged({ state: "held" }));
		first.set(HASH, bridged({ state: "settled", preimage: PREIMAGE }));

		expect(ledgerAt(path).get(HASH)?.state).toBe("settled");
		expect(ledgerAt(path).owed()).toEqual([]);
	});

	it("settles what a crash left owed and marks the ledger", async () => {
		const ledger = ledgerAt(path);
		ledger.set(HASH, bridged({ state: "forwarding", preimage: PREIMAGE }));

		const asked: string[] = [];
		const recovered = await settleWhatIsOwed(ledger, async (preimage) => {
			asked.push(preimage);
		});

		expect(asked).toEqual([PREIMAGE]);
		expect(recovered.settled).toEqual([HASH]);
		expect(ledgerAt(path).get(HASH)?.state).toBe("settled");
	});

	it("keeps owing when the wallet refuses the settle, so the next boot tries again", async () => {
		const ledger = ledgerAt(path);
		ledger.set(HASH, bridged({ state: "forwarding", preimage: PREIMAGE }));

		const recovered = await settleWhatIsOwed(ledger, () => {
			throw new Error("settle raced a cancel");
		});

		expect(recovered).toEqual({ settled: [], refused: [HASH], unprovable: [] });
		expect(ledgerAt(path).owed()).toHaveLength(1);
	});

	it("never settles a preimage that does not hash to the invoice it was stored under", async () => {
		const ledger = ledgerAt(path);
		ledger.set(HASH, bridged({ state: "forwarding", preimage: "ff".repeat(32) }));

		const recovered = await settleWhatIsOwed(ledger, () => {
			throw new Error("the wallet must never be asked");
		});

		expect(recovered.unprovable).toEqual([HASH]);
		expect(ledgerAt(path).get(HASH)?.state).toBe("forwarding");
	});
});
