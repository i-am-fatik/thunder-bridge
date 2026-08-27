import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const LND = ["lncli", "--lnddir=/home/lnd/.lnd", "-n", "regtest"];
const CLN = ["lightning-cli", "--lightning-dir=/home/clightning/.lightning", "--network=regtest"];

export const DUE_MSAT = 21_000_000;
export const LISTED_FEE_MSAT = 157_500;
export const RECIPIENT_EXPIRY = 3600;
export const WRAP_EXPIRY = 600;
const TOP_UP_SAT = 400_000;

export const wrapper = (...args: string[]) => ask("wrap-wrapper", ...LND, ...args);
export const payer = (...args: string[]) => ask("wrap-payer", ...LND, ...args);
export const payee = (...args: string[]) => ask("wrap-payee", ...CLN, ...args);

export function nodesUp(): boolean {
	return reachable(() => {
		wrapper("getinfo");
		payee("getinfo");
		payer("getinfo");
	});
}

export function ensureWrapCanFlow(): void {
	const wrapSat = Math.ceil((DUE_MSAT + LISTED_FEE_MSAT) / 1000);
	const dueSat = Math.ceil(DUE_MSAT / 1000);
	const wrapperPubkey = String(wrapper("getinfo").identity_pubkey);
	const payeePubkey = String(payee("getinfo").id);

	topUp(
		() => routeExists(payer, wrapperPubkey, wrapSat),
		() => wrapper("payinvoice", "--force", "--json", invoiceFromPayer()),
		`the payer cannot reach the wrapper with ${wrapSat} sat`,
	);

	topUp(
		() => routeExists(wrapper, payeePubkey, dueSat),
		() => payee("pay", invoiceFromWrapper()),
		`the wrapper cannot reach the payee with ${dueSat} sat`,
	);
}

export function recipientInvoice(amountMsat = DUE_MSAT, expiry = RECIPIENT_EXPIRY) {
	const answered = payee(
		"invoice",
		String(amountMsat),
		`regtest-${randomUUID()}`,
		"a recipient that publishes no verify url",
		String(expiry),
	);

	return { bolt11: String(answered.bolt11), paymentHash: String(answered.payment_hash) };
}

export function wrapOn(paymentHash: string, amountMsat: number, expiry = WRAP_EXPIRY): string {
	const answered = wrapper(
		"addholdinvoice",
		`--amt_msat=${amountMsat}`,
		`--expiry=${expiry}`,
		paymentHash,
	);

	return String(answered.payment_request);
}

export function payInBackground(bolt11: string): Promise<void> {
	const paying = spawn("docker", [
		"exec",
		"wrap-payer",
		...LND,
		"payinvoice",
		"--force",
		"--json",
		bolt11,
	]);

	return new Promise((done) => paying.on("close", () => done()));
}

export async function untilHeld(paymentHash: string): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		if (wrapper("lookupinvoice", paymentHash).state === "ACCEPTED") {
			return;
		}
		await new Promise((wake) => setTimeout(wake, 500));
	}

	throw new Error(`the wrap on ${paymentHash} was never held`);
}

export function payeeStatusOf(paymentHash: string): string | undefined {
	const found = (payee("listinvoices").invoices as Array<Record<string, unknown>>).find(
		(one) => one.payment_hash === paymentHash,
	);

	return found === undefined ? undefined : String(found.status);
}

function ask(container: string, ...args: string[]): Record<string, unknown> {
	const out = execFileSync("docker", ["exec", container, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	return out.trim().length === 0 ? {} : (JSON.parse(out) as Record<string, unknown>);
}

function topUp(canFlow: () => boolean, restore: () => void, complaint: string): void {
	if (canFlow()) {
		return;
	}
	restore();
	if (!canFlow()) {
		throw new Error(`${complaint}, even after a ${TOP_UP_SAT} sat top up`);
	}
}

function routeExists(
	from: (...args: string[]) => Record<string, unknown>,
	destination: string,
	amountSat: number,
): boolean {
	return reachable(() => {
		const routes = from("queryroutes", `--dest=${destination}`, `--amt=${amountSat}`).routes;
		if (!Array.isArray(routes) || routes.length === 0) {
			throw new Error("no route");
		}
	});
}

function invoiceFromPayer(): string {
	return String(payer("addinvoice", `--amt=${TOP_UP_SAT}`).payment_request);
}

function invoiceFromWrapper(): string {
	return String(wrapper("addinvoice", `--amt=${TOP_UP_SAT}`).payment_request);
}

function reachable(probe: () => unknown): boolean {
	try {
		probe();
		return true;
	} catch {
		return false;
	}
}
