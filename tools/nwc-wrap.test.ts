import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { preimageMatchesHash, proveWrapped } from "../sdk/dist/index.js";
import {
	askWallet,
	nwcConnection,
	nwcHoldInvoice,
	nwcInvoice,
	nwcPay,
	nwcSettlement,
	nwcVerifyEndpoint,
	nwcVerifyUrl,
} from "../sdk/dist/server.js";
import {
	type RegtestWallet,
	startRegtestWallet,
	type WalletOptions,
} from "./nwc-regtest-wallet.ts";
import {
	DUE_MSAT,
	ensureWrapCanFlow,
	LISTED_FEE_MSAT,
	nodesUp,
	payeeStatusOf,
	payInBackground,
	recipientInvoice,
	untilHeld,
	WRAP_EXPIRY,
	wrapOn,
	wrapper,
} from "./regtest-nodes.ts";
import { ledgerAt, settleWhatIsOwed } from "./wrap-ledger.ts";

const held = (paymentHash: string) => ({
	paymentHash,
	amountMsat: DUE_MSAT + LISTED_FEE_MSAT,
	description: "wrap over nwc",
	expirySecs: WRAP_EXPIRY,
});

async function withWallet<T>(
	options: WalletOptions,
	run: (wallet: RegtestWallet) => Promise<T>,
): Promise<T> {
	const wallet = await startRegtestWallet(options);
	try {
		return await run(wallet);
	} finally {
		await wallet.close();
	}
}

describe.skipIf(!nodesUp())("the operator's wallet, driven over NIP-47", () => {
	let wallet: RegtestWallet;

	beforeAll(async () => {
		wallet = await startRegtestWallet();
	});

	afterAll(async () => {
		await wallet.close();
	});

	it("reads a connection off the wallet's own uri", () => {
		const connection = nwcConnection(wallet.uri);

		expect(connection.walletPubkey).toHaveLength(64);
		expect(connection.relays).toEqual([expect.stringMatching(/^wss:\/\//)]);
	});

	it("mints a real hold invoice on the recipient's hash and proves the wrap", async () => {
		const connection = nwcConnection(wallet.uri);
		const recipient = recipientInvoice();

		const wrapped = await nwcHoldInvoice(connection, held(recipient.paymentHash));

		expect(wrapped.paymentHash).toBe(recipient.paymentHash);
		expect(() => proveWrapped(wrapped.bolt11, recipient.bolt11)).not.toThrow();
		expect(wallet.asked).toContain("make_hold_invoice");
	});

	it("answers lookup_invoice with no preimage while the wrap is unpaid", async () => {
		const connection = nwcConnection(wallet.uri);
		const recipient = recipientInvoice();
		await nwcHoldInvoice(connection, held(recipient.paymentHash));

		expect(await nwcSettlement(connection, recipient.paymentHash)).toBeNull();
	});

	it("surfaces the node's refusal when a hash is wrapped twice", async () => {
		const connection = nwcConnection(wallet.uri);
		const recipient = recipientInvoice();
		await nwcHoldInvoice(connection, held(recipient.paymentHash));

		await expect(nwcHoldInvoice(connection, held(recipient.paymentHash))).rejects.toThrow(
			/refused make_hold_invoice/,
		);
	});

	it("refuses a wallet that answers with a wrap on another hash", async () => {
		const recipient = recipientInvoice();
		const elsewhere = recipientInvoice();
		const onAnotherHash = wrapOn(elsewhere.paymentHash, DUE_MSAT + LISTED_FEE_MSAT);

		await withWallet(
			{ answerInstead: (method) => staged(method, onAnotherHash) },
			async (lying) => {
				await expect(
					nwcHoldInvoice(nwcConnection(lying.uri), held(recipient.paymentHash)),
				).rejects.toThrow(/rather than the/);
			},
		);
	});

	it("refuses a wallet that answers with an invoice for the wrong amount", async () => {
		const recipient = recipientInvoice();
		const shortOfTheFee = wrapOn(recipient.paymentHash, DUE_MSAT);

		await withWallet(
			{ answerInstead: (method) => staged(method, shortOfTheFee) },
			async (lying) => {
				await expect(
					nwcHoldInvoice(nwcConnection(lying.uri), held(recipient.paymentHash)),
				).rejects.toThrow(/not 21157500/);
			},
		);
	});

	it("mints a wrap with the final cltv delta the operator asked for", async () => {
		const connection = nwcConnection(wallet.uri);
		const recipient = recipientInvoice();

		const wrapped = await nwcHoldInvoice(connection, {
			...held(recipient.paymentHash),
			minCltvExpiryDelta: 200,
		});
		const decoded = wrapper("decodepayreq", wrapped.bolt11);

		expect(Number(decoded.cltv_expiry)).toBe(200);
	});

	it("cancels a wrap the operator decides not to forward", async () => {
		const connection = nwcConnection(wallet.uri);
		const recipient = recipientInvoice();
		await nwcHoldInvoice(connection, held(recipient.paymentHash));

		await askWallet(connection, "cancel_hold_invoice", { payment_hash: recipient.paymentHash });

		expect(wrapper("lookupinvoice", recipient.paymentHash).state).toBe("CANCELED");
	});
});

describe.skipIf(!nodesUp())("the whole wrap, every hop over NIP-47", () => {
	beforeAll(() => {
		ensureWrapCanFlow();
	});

	it("holds, forwards, settles and proves the preimage without touching lncli", async () => {
		await withWallet({}, async (wallet) => {
			const connection = nwcConnection(wallet.uri);
			const recipient = recipientInvoice();

			const wrapped = await nwcHoldInvoice(connection, held(recipient.paymentHash));
			expect(() => proveWrapped(wrapped.bolt11, recipient.bolt11)).not.toThrow();

			const paid = payInBackground(wrapped.bolt11);
			await untilHeld(recipient.paymentHash);

			const seen = await askWallet(connection, "lookup_invoice", {
				payment_hash: recipient.paymentHash,
			});
			expect(seen.state).toBe("accepted");

			const preimage = await nwcPay(connection, recipient.bolt11);
			expect(preimageMatchesHash(preimage, recipient.paymentHash)).toBe(true);

			await askWallet(connection, "settle_hold_invoice", { preimage });
			await paid;

			expect(await nwcSettlement(connection, recipient.paymentHash)).toBe(preimage);
			expect(payeeStatusOf(recipient.paymentHash)).toBe("paid");
			expect(wallet.asked).toEqual([
				"make_hold_invoice",
				"lookup_invoice",
				"pay_invoice",
				"settle_hold_invoice",
				"lookup_invoice",
			]);
		});
	}, 120_000);
});

function staged(method: string, invoice: string): Record<string, unknown> | undefined {
	return method === "make_hold_invoice" ? { invoice } : undefined;
}

describe.skipIf(!nodesUp())("the crash the ledger is there for", () => {
	beforeAll(() => {
		ensureWrapCanFlow();
	});

	it("settles a wrap the operator died on, from the ledger, through the wallet", async () => {
		const into = mkdtempSync(join(tmpdir(), "wrap-recovery-"));

		try {
			await withWallet({}, async (wallet) => {
				const connection = nwcConnection(wallet.uri);
				const recipient = recipientInvoice();
				const wrapped = await nwcHoldInvoice(connection, held(recipient.paymentHash));

				const paid = payInBackground(wrapped.bolt11);
				await untilHeld(recipient.paymentHash);

				const preimage = await nwcPay(connection, recipient.bolt11);
				const ledger = ledgerAt(join(into, "ledger.json"));
				ledger.set(recipient.paymentHash, {
					recipient: recipient.bolt11,
					wrap: wrapped.bolt11,
					state: "forwarding",
					preimage,
					note: "the process died before it settled",
				});

				expect(wrapper("lookupinvoice", recipient.paymentHash).state).toBe("ACCEPTED");

				const recovered = await settleWhatIsOwed(ledgerAt(join(into, "ledger.json")), (one) =>
					askWallet(connection, "settle_hold_invoice", { preimage: one }),
				);
				await paid;

				expect(recovered.settled).toEqual([recipient.paymentHash]);
				expect(wrapper("lookupinvoice", recipient.paymentHash).state).toBe("SETTLED");
				expect(payeeStatusOf(recipient.paymentHash)).toBe("paid");
			});
		} finally {
			rmSync(into, { recursive: true, force: true });
		}
	}, 120_000);
});

const OWN_AMOUNT_MSAT = 2_000_000;
const SEALING_SECRET = "nwc_regtest_endpoint_4c1f9ab27d60";
const MOUNT = "https://shop.example/verify/nwc";

describe.skipIf(!nodesUp())("the recipient's own wallet, answering LUD-21 over NIP-47", () => {
	let own: RegtestWallet;

	beforeAll(async () => {
		ensureWrapCanFlow();
		own = await startRegtestWallet();
	});

	afterAll(async () => {
		await own.close();
	});

	it("mints a plain invoice on the wallet and decodes it rather than trusting it", async () => {
		const connection = nwcConnection(own.uri);
		const minted = await nwcInvoice(connection, OWN_AMOUNT_MSAT, "a wallet minting for itself");

		expect(minted.paymentHash).toHaveLength(64);
		expect(minted.expiresAt).toBeGreaterThan(0);
		expect(String(wrapper("lookupinvoice", minted.paymentHash).state)).toBe("OPEN");
	});

	it("answers not settled while nobody has paid, then the real preimage once they have", async () => {
		const connection = nwcConnection(own.uri);
		const minted = await nwcInvoice(connection, OWN_AMOUNT_MSAT, "watched through a connection");
		const answering = nwcVerifyEndpoint({ connection, secret: SEALING_SECRET });
		const sealed = await nwcVerifyUrl(MOUNT, minted.paymentHash, SEALING_SECRET);

		const unpaid = await answering(new Request(sealed));
		expect(unpaid.status).toBe(200);
		expect(await unpaid.json()).toEqual({ settled: false, preimage: null });

		await payInBackground(minted.bolt11);

		const paid = await answering(new Request(sealed));
		const said = (await paid.json()) as { settled: boolean; preimage: string };
		expect(said.settled).toBe(true);
		expect(preimageMatchesHash(said.preimage, minted.paymentHash)).toBe(true);
	});

	it("refuses a hash somebody sealed with another secret", async () => {
		const connection = nwcConnection(own.uri);
		const minted = await nwcInvoice(connection, OWN_AMOUNT_MSAT, "sealed by a stranger");
		const answering = nwcVerifyEndpoint({ connection, secret: SEALING_SECRET });
		const elsewhere = await nwcVerifyUrl(
			MOUNT,
			minted.paymentHash,
			"nwc_regtest_a_stranger_seal_7f3e2",
		);

		expect((await answering(new Request(elsewhere))).status).toBe(403);
	});

	it("refuses a wallet that claims to have paid with a preimage of its own invention", async () => {
		const recipient = recipientInvoice();

		await withWallet(
			{
				answerInstead: (method) =>
					method === "pay_invoice" ? { preimage: "ab".repeat(32) } : undefined,
			},
			async (lying) => {
				await expect(nwcPay(nwcConnection(lying.uri), recipient.bolt11)).rejects.toThrow(
					/no preimage hashing to/,
				);
			},
		);
	});
});
