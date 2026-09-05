import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { decodeInvoice, ThunderBridge } from "../sdk/dist/index.js";
import { nwcConnection, nwcRail, nwcVerifyEndpoint } from "../sdk/dist/server.js";
import { type Service, start } from "../src/index.ts";
import { CLUSTER_KEY, openStore } from "../src/testing.ts";
import { type RegtestWallet, startRegtestWallet } from "./nwc-regtest-wallet.ts";
import { ensureWrapCanFlow, nodesUp, wrapper } from "./regtest-nodes.ts";

vi.mock("node:dns/promises", () => ({
	lookup: async () => [{ address: "203.0.113.1", family: 4 }],
}));

const OWN_AMOUNT_MSAT = 2_000_000;
const SEALING_SECRET = "nwc_regtest_rail_endpoint_5d2b09fc";
const MOUNT = "https://shop.example/verify/nwc";

describe.skipIf(!nodesUp())("a rail that mints on the shop's own wallet", () => {
	let own: RegtestWallet;
	let gateway: Service;
	let closeStore: () => void;
	let served: { reached: () => number };

	beforeAll(async () => {
		ensureWrapCanFlow();
		own = await startRegtestWallet();
		served = servedInProcess(
			nwcVerifyEndpoint({ connection: nwcConnection(own.uri), secret: SEALING_SECRET }),
		);

		const opened = openStore();
		closeStore = opened.stop;
		gateway = await start(
			{
				port: 0,
				eagerDelayMs: 3000,
				pollsPerSecond: 5,
				workPerTick: 50,
				verifyHosts: null,
				verifyChallenge: false,
				clientKeys: null,
				mints: true,
				tickStallMs: 30_000,
				drainTimeoutMs: 10_000,
				keepSealedSecs: 90 * 86_400,
				maxReplay: 100,
				token: null,
				key: CLUSTER_KEY,
			},
			opened.store,
		);
	});

	afterAll(async () => {
		await gateway.stop();
		closeStore();
		vi.unstubAllGlobals();
		await own.close();
	});

	it("mints on the real wallet and hands the gateway a verify url of ours", async () => {
		const rail = nwcRail({
			gateway: new ThunderBridge(`http://127.0.0.1:${gateway.port}`),
			connection: nwcConnection(own.uri),
			amountMsat: () => OWN_AMOUNT_MSAT,
			verifyThrough: { endpoint: MOUNT, secret: SEALING_SECRET },
		});

		const leg = await rail({
			reference: `rail-${randomUUID()}`,
			amountMinor: 100,
			currency: "CZK",
		});
		const minted = decodeInvoice(leg.scan);

		expect(leg.rail).toBe("lightning");
		expect(minted.amountMsat).toBe(OWN_AMOUNT_MSAT);
		expect(String(wrapper("lookupinvoice", String(minted.paymentHash)).state)).toBe("OPEN");
		expect(own.asked).toContain("make_invoice");
		expect(served.reached()).toBeGreaterThan(0);
	});
});

function servedInProcess(answering: (request: Request) => Promise<Response>): {
	reached: () => number;
} {
	const straightThrough = globalThis.fetch;
	let reached = 0;

	vi.stubGlobal("fetch", async (asked: string | URL | Request, options?: RequestInit) => {
		const request = asked instanceof Request ? asked : new Request(asked, options);
		if (!request.url.startsWith(new URL(MOUNT).origin)) {
			return straightThrough(asked, options);
		}
		reached += 1;

		return answering(request);
	});

	return { reached: () => reached };
}
