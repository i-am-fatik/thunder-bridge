import { expect, test } from "vitest";

import { cannotReleaseAPreimage, quote, resolve, toLnurl } from "./lnurl.ts";
import { NoWalletAvailable, statusForWallets } from "../src/problem.ts";

test("a server that answers verify without a preimage is known", () => {
	expect(cannotReleaseAPreimage("zeuspay.com")).toBe(true);
	expect(cannotReleaseAPreimage("ZeusPay.com")).toBe(true);
	expect(cannotReleaseAPreimage("pay.zeusnuts.com")).toBe(true);
	expect(cannotReleaseAPreimage("ecash.love")).toBe(true);
	expect(cannotReleaseAPreimage("coinos.io")).toBe(false);
	expect(cannotReleaseAPreimage("notzeuspay.com")).toBe(false);
});

async function refusedBy(addresses: string[], amountMsat = 21_000): Promise<NoWalletAvailable> {
	try {
		await resolve(addresses, amountMsat);
	} catch (no: unknown) {
		if (no instanceof NoWalletAvailable) return no;
		throw no;
	}
	throw new Error(`${addresses.join(", ")} resolved when it should have refused`);
}

test("one of those is refused at resolve rather than left to expire", async () => {
	const refusal = await refusedBy(["someone@zeuspay.com"]);
	expect(refusal.wallets).toEqual([
		{ address: "someone@zeuspay.com", reason: "cannot-prove-delivery" },
	]);
});

test("each wallet carries why it was skipped, and the worst one sets the status", async () => {
	const refusal = await refusedBy(["not-an-address", "someone@ecash.love"]);
	expect(refusal.wallets).toEqual([
		{ address: "not-an-address", reason: "address-unusable" },
		{ address: "someone@ecash.love", reason: "cannot-prove-delivery" },
	]);

	expect(statusForWallets(refusal.wallets)).toBe(422);
	expect(statusForWallets([{ address: "a@b.com", reason: "address-unusable" }])).toBe(400);
	expect(
		statusForWallets([
			{ address: "a@b.com", reason: "unreachable" },
			{ address: "c@d.com", reason: "cannot-prove-delivery" },
		]),
	).toBe(502);
});

test("a private host in an address is refused before anything is fetched", async () => {
	const refusal = await refusedBy(["someone@localhost", "someone@169.254.169.254"]);
	expect(refusal.wallets.map((wallet) => wallet.reason)).toEqual([
		"address-unusable",
		"address-unusable",
	]);
});

const WELL_KNOWN = "https://coinos.io/.well-known/lnurlp/charter";
const CALLBACK = "https://coinos.io/api/lnurl/3c14fd5d-8e25-4bd2-86d6-2dc0965e1ac5";
const PROOF_URL = "https://coinos.io/api/lnurl/verify/33bb39d0-e170-4207-a24f-047a1663ac62";
const METADATA =
	'[["text/plain","Paying charter@coinos.io"],["text/identifier","charter@coinos.io"]]';
const ISSUED_INVOICE =
	"lnbc210n1p4xuft9sp5yltzwvshnfujcwt6gvrwtxttgyp90766g6q33z4zt60k9eeqw3mspp5zyxunh4dd0mpptmq23dpqyfzu6p0gl4zzzekdczrmwjnj0jfqu7qhp5vq6e2dhqtvmm375umz70kg84peq3dvjdpdetg7yjgr2arq9ydvnqxq9z0rgqcqpnrzjqt9dfmzv3vxu93crtgvf37teerr3dx7l7a8qrttv57h2t8v9ck0gkrvumyqqh5cqqyqqqqqqqqqq3wcqjq9qxpqysgqjlcdljhwzcprcx0wz9gxdsjjjszd0fqvmxv8zxwa2u75vpqk8r8s434yl4s4qu3kzkwkhvwrkq5a9khusallkugppjpghwlsd4kffuqpakddlx";

function answering(routes: Record<string, unknown>, seen: string[] = []): () => void {
	const real = globalThis.fetch;
	globalThis.fetch = ((target: string | URL | Request) => {
		seen.push(String(target));
		const body = routes[String(target)];
		return Promise.resolve(
			body ? Response.json(body) : new Response("no route", { status: 404 }),
		);
	}) as typeof fetch;
	return () => {
		globalThis.fetch = real;
	};
}

function servedBy(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		[WELL_KNOWN]: {
			tag: "payRequest",
			callback: CALLBACK,
			metadata: METADATA,
			minSendable: 1_000,
			maxSendable: 100_000_000,
		},
		[PROOF_URL]: { status: "OK", settled: false, preimage: null, pr: ISSUED_INVOICE },
		...overrides,
	};
}

test("the wallets are tried in order and the first one that answers wins", async () => {
	const restore = answering({
		...servedBy(),
		[`${CALLBACK}?amount=21000`]: {
			pr: ISSUED_INVOICE,
			verify: PROOF_URL,
		},
	});
	try {
		const resolved = await resolve(
			["offline@coinos.io", "charter@coinos.io", "never@coinos.io"],
			21_000,
		);
		expect(resolved.address).toBe("charter@coinos.io");
		expect(resolved.verifyUrl).toBe(PROOF_URL);
	} finally {
		restore();
	}
});

test("a wallet that answers nothing is unreachable, not the payer's mistake", async () => {
	const restore = answering({});
	try {
		const refusal = await refusedBy(["charter@coinos.io"]);
		expect(refusal.wallets).toEqual([{ address: "charter@coinos.io", reason: "unreachable" }]);
		expect(statusForWallets(refusal.wallets)).toBe(502);
	} finally {
		restore();
	}
});

test("an amount the wallet will not take is its own reason", async () => {
	const restore = answering(
		servedBy({
			[WELL_KNOWN]: {
				tag: "payRequest",
				callback: CALLBACK,
				metadata: METADATA,
				minSendable: 1_000,
				maxSendable: 5_000,
			},
		}),
	);
	try {
		const refusal = await refusedBy(["charter@coinos.io"]);
		expect(refusal.wallets).toEqual([
			{ address: "charter@coinos.io", reason: "amount-not-accepted" },
		]);
		expect(statusForWallets(refusal.wallets)).toBe(400);
	} finally {
		restore();
	}
});

test("a quote reports the wallet's range and never asks it for an invoice", async () => {
	const seen: string[] = [];
	const restore = answering({ ...servedBy(), [`${CALLBACK}?amount=21000`]: { pr: ISSUED_INVOICE } }, seen);
	try {
		const served = await quote(["charter@coinos.io"], 21_000);

		expect(served.won).toEqual({
			address: "charter@coinos.io",
			minMsat: 1_000,
			maxMsat: 100_000_000,
			metadata: METADATA,
		});
		expect(served.refusals).toEqual([]);
		expect(seen).toEqual([WELL_KNOWN]);
	} finally {
		restore();
	}
});

test("a quote passes over the same wallets a create would, and hands back why", async () => {
	const restore = answering(servedBy());
	try {
		const served = await quote(["someone@zeuspay.com", "charter@coinos.io"], 21_000);

		expect(served.won.address).toBe("charter@coinos.io");
		expect(served.refusals).toEqual([
			{ address: "someone@zeuspay.com", reason: "cannot-prove-delivery" },
		]);
	} finally {
		restore();
	}
});

test("a quote for an amount nobody takes refuses exactly as a create does", async () => {
	const restore = answering(
		servedBy({
			[WELL_KNOWN]: {
				tag: "payRequest",
				callback: CALLBACK,
				metadata: METADATA,
				minSendable: 1_000,
				maxSendable: 5_000,
			},
		}),
	);
	try {
		await quote(["charter@coinos.io"], 21_000);
		throw new Error("the quote was served when it should have refused");
	} catch (no: unknown) {
		if (!(no instanceof NoWalletAvailable)) throw no;
		expect(no.wallets).toEqual([{ address: "charter@coinos.io", reason: "amount-not-accepted" }]);
	} finally {
		restore();
	}
});

test("an invoice that does not match the metadata is refused, not minted", async () => {
	const restore = answering({
		...servedBy({
			[WELL_KNOWN]: {
				tag: "payRequest",
				callback: CALLBACK,
				metadata: '[["text/identifier","mallory@coinos.io"]]',
				minSendable: 1_000,
				maxSendable: 100_000_000,
			},
		}),
		[`${CALLBACK}?amount=21000`]: { pr: ISSUED_INVOICE, verify: PROOF_URL },
	});
	try {
		const refusal = await refusedBy(["charter@coinos.io"]);
		expect(refusal.wallets).toEqual([{ address: "charter@coinos.io", reason: "invoice-refused" }]);
		expect(statusForWallets(refusal.wallets)).toBe(422);
	} finally {
		restore();
	}
});

test("an endpoint bech32-encodes to the LNURL string LUD-01 spells out", () => {
	const url = "https://service.com/api?q=3fc3645b439ce8e7f2553a69e5267081d96dcd340693afabe04be7b0ccd178df";

	expect(toLnurl(url)).toBe(
		"LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS",
	);
});

test("a trigger endpoint of ours encodes and stays one case, as a QR needs", () => {
	const encoded = toLnurl("https://agora.gripe/tip");

	expect(encoded.startsWith("LNURL1")).toBe(true);
	expect(encoded).toBe(encoded.toUpperCase());
});

test("something that is not an http url is refused rather than encoded into a dead QR", () => {
	expect(() => toLnurl("agora.gripe/tip")).toThrow(/not an http or https URL/);
	expect(() => toLnurl("lnurlp://agora.gripe/tip")).toThrow(/not an http or https URL/);
});
