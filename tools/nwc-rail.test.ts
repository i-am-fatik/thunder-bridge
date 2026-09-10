import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Send } from "../core/outbound.ts";
import { decodeInvoice, msat, ThunderBridge } from "../sdk/dist/index.js";
import { nwcConnection, nwcRail, nwcVerifyEndpoint } from "../sdk/dist/nwc.js";
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
	let served: { send: Send; reached: () => number };

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
				key: CLUSTER_KEY,
				port: 0,
				mints: true,
				verifyChallenge: false,
				eagerDelayMs: 3000,
				send: served.send,
			},
			opened.store,
		);
	});

	afterAll(async () => {
		await gateway.stop();
		closeStore();
		await own.close();
	});

	it("mints on the real wallet and hands the gateway a verify url of ours", async () => {
		const rail = nwcRail(new ThunderBridge(`http://127.0.0.1:${gateway.at}`), {
			connection: nwcConnection(own.uri),
			amount: () => msat(OWN_AMOUNT_MSAT),
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
	send: Send;
	reached: () => number;
} {
	let reached = 0;
	const send: Send = async (url, sent) => {
		if (!url.startsWith(new URL(MOUNT).origin)) {
			throw new Error(`${url} is not the rail this test mounts`);
		}
		reached += 1;

		return answering(
			new Request(url, { method: sent.method, headers: sent.headers, body: sent.body }),
		);
	};

	return { send, reached: () => reached };
}
