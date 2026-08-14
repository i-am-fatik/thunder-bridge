import { writeFileSync } from "node:fs";
import { cannotReleaseAPreimage } from "../core/lnurl.ts";
import { ask } from "../core/outbound.ts";

const RELAYS = [
	"wss://relay.damus.io",
	"wss://nos.lol",
	"wss://relay.primal.net",
	"wss://relay.nostr.band",
	"wss://nostr.wine",
	"wss://relay.snort.social",
];

const PROFILES_PER_RELAY = 500;
const RELAY_TIMEOUT_MS = 20_000;
const THIN_SAMPLE = 2;
const DEEP_SAMPLE = 6;
const AMOUNT_FLOOR_MSAT = 1000;
const DOMAINS_AT_ONCE = 12;

export type Verdict =
	| "usable"
	| "verify-without-preimage"
	| "no-verify"
	| "unreachable"
	| "amount-refused";

export type Measured = { address: string; verdict: Verdict; note: string };

export type DomainRow = {
	verdict: Verdict | "unsettled";
	denylisted: boolean;
	measured: Measured[];
};

export type Survey = {
	surveyedAt: string;
	addresses: number;
	domains: Record<string, DomainRow>;
};

type PayRequest = {
	tag?: string;
	callback?: string;
	minSendable?: number;
	maxSendable?: number;
};

type CallbackInvoice = { pr?: string; verify?: string | null };

export function lud16Of(content: string): string | null {
	try {
		const profile = JSON.parse(content) as { lud16?: unknown };
		const address = typeof profile.lud16 === "string" ? profile.lud16.trim().toLowerCase() : "";
		return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : null;
	} catch {
		return null;
	}
}

function fromOneRelay(url: string): Promise<string[]> {
	return new Promise((settle) => {
		const found = new Set<string>();
		let socket: WebSocket;
		const done = () => {
			try {
				socket.close();
			} catch {}
			settle([...found]);
		};
		const timer = setTimeout(done, RELAY_TIMEOUT_MS);

		try {
			socket = new WebSocket(url);
		} catch {
			clearTimeout(timer);
			settle([]);
			return;
		}

		socket.addEventListener("open", () => {
			socket.send(JSON.stringify(["REQ", "lud16", { kinds: [0], limit: PROFILES_PER_RELAY }]));
		});
		socket.addEventListener("message", (event) => {
			try {
				const frame = JSON.parse(String(event.data)) as unknown[];
				if (frame[0] === "EOSE") {
					clearTimeout(timer);
					done();
					return;
				}
				if (frame[0] !== "EVENT") {
					return;
				}
				const address = lud16Of((frame[2] as { content?: string }).content ?? "");
				if (address) {
					found.add(address);
				}
			} catch {}
		});
		socket.addEventListener("error", () => {
			clearTimeout(timer);
			done();
		});
		socket.addEventListener("close", () => {
			clearTimeout(timer);
			settle([...found]);
		});
	});
}

export async function addressesFromNostr(): Promise<string[]> {
	const perRelay = await Promise.all(RELAYS.map((relay) => fromOneRelay(relay)));
	return [...new Set(perRelay.flat())];
}

export function byDomain(addresses: string[]): Map<string, string[]> {
	const grouped = new Map<string, string[]>();
	for (const address of addresses) {
		const domain = address.slice(address.indexOf("@") + 1);
		grouped.set(domain, [...(grouped.get(domain) ?? []), address]);
	}
	return grouped;
}

async function jsonFrom<T>(url: string): Promise<T | null> {
	try {
		const answer = await ask(url);
		if (!answer.ok) {
			return null;
		}
		return JSON.parse(answer.body) as T;
	} catch {
		return null;
	}
}

export async function measure(address: string): Promise<Measured> {
	const at = address.indexOf("@");
	const [user, domain] = [address.slice(0, at), address.slice(at + 1)];

	const pay = await jsonFrom<PayRequest>(`https://${domain}/.well-known/lnurlp/${user}`);
	if (pay === null || pay.tag !== "payRequest" || !pay.callback) {
		return { address, verdict: "unreachable", note: "no payRequest" };
	}

	const floor = pay.minSendable ?? AMOUNT_FLOOR_MSAT;
	const ceiling = pay.maxSendable ?? AMOUNT_FLOOR_MSAT;
	const amount = Math.max(AMOUNT_FLOOR_MSAT, floor);
	if (amount > ceiling) {
		return { address, verdict: "amount-refused", note: `takes [${floor}, ${ceiling}] msat` };
	}

	const separator = pay.callback.includes("?") ? "&" : "?";
	const invoice = await jsonFrom<CallbackInvoice>(`${pay.callback}${separator}amount=${amount}`);
	if (invoice === null || !invoice.pr) {
		return { address, verdict: "unreachable", note: "callback issued no invoice" };
	}
	if (!invoice.verify) {
		return { address, verdict: "no-verify", note: "invoice carries no verify URL" };
	}

	const verification = await jsonFrom<Record<string, unknown>>(invoice.verify);
	if (verification === null) {
		return { address, verdict: "unreachable", note: "verify URL answered nothing readable" };
	}
	if (!("preimage" in verification)) {
		return {
			address,
			verdict: "verify-without-preimage",
			note: `verify answered ${Object.keys(verification).sort().join(",")}`,
		};
	}
	if (typeof verification["settled"] !== "boolean") {
		return { address, verdict: "verify-without-preimage", note: "verify names no boolean settled" };
	}

	return { address, verdict: "usable", note: "verify answers settled and preimage" };
}

export function verdictOf(measured: Measured[]): Verdict | "unsettled" {
	if (measured.some((one) => one.verdict === "usable")) {
		return "usable";
	}
	if (measured.some((one) => one.verdict === "verify-without-preimage")) {
		return "verify-without-preimage";
	}
	if (measured.every((one) => one.verdict === "no-verify")) {
		return "no-verify";
	}
	return "unsettled";
}

async function inBatches<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
	const done: R[] = [];
	for (let start = 0; start < items.length; start += DOMAINS_AT_ONCE) {
		done.push(...(await Promise.all(items.slice(start, start + DOMAINS_AT_ONCE).map(run))));
	}
	return done;
}

export async function surveyDomain(domain: string, addresses: string[]): Promise<DomainRow> {
	const thin = await Promise.all(addresses.slice(0, THIN_SAMPLE).map(measure));
	const settled = verdictOf(thin);
	if (settled !== "unsettled" || addresses.length <= THIN_SAMPLE) {
		return { verdict: settled, denylisted: cannotReleaseAPreimage(domain), measured: thin };
	}

	const deeper = await Promise.all(addresses.slice(THIN_SAMPLE, DEEP_SAMPLE).map(measure));
	const measured = [...thin, ...deeper];
	return { verdict: verdictOf(measured), denylisted: cannotReleaseAPreimage(domain), measured };
}

export async function survey(surveyedAt: string): Promise<Survey> {
	const addresses = await addressesFromNostr();
	const grouped = [...byDomain(addresses)].sort();
	console.warn(`${addresses.length} addresses across ${grouped.length} domains`);

	const rows = await inBatches(grouped, async ([domain, sample]) => {
		const row = await surveyDomain(domain, sample);
		console.warn(`${domain} ${row.verdict}`);
		return [domain, row] as const;
	});

	return { surveyedAt, addresses: addresses.length, domains: Object.fromEntries(rows) };
}

if (import.meta.main) {
	const measuredAt = process.argv[2] ?? "unstamped";
	const out = process.argv[3] ?? "docs/lud21-measured.json";
	const done = await survey(measuredAt);
	writeFileSync(out, `${JSON.stringify(done, null, "\t")}\n`);
	console.warn(`wrote ${out}`);
}
