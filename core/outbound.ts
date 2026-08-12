import { publicAddress, publicHttps, sameOrigin } from "./url.ts";

const HTTP_TIMEOUT_MS = 15_000;
const LOOKUP_TIMEOUT_MS = 5_000;
const HOPS_FOLLOWED = 2;
const REDIRECTS = [301, 302, 303, 307, 308];
const KEEPS_THE_METHOD = [307, 308];
const CREDENTIALS = ["authorization", "cookie", "proxy-authorization"];

export const BODY_LIMIT_BYTES = 262_144;

export type Sent = {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	deadline?: AbortSignal;
};

export type Answer = {
	status: number;
	ok: boolean;
	body: string;
	truncated: boolean;
	headers: Headers;
};

export type Verified = { address: string; family: number };

export type Send = (
	url: string,
	sent: Sent,
	signal: AbortSignal,
	at: readonly Verified[],
) => Promise<Response>;

const throughFetch: Send = (url, sent, signal) =>
	fetch(url, {
		method: sent.method ?? "GET",
		headers: sent.headers ?? {},
		body: sent.body,
		redirect: "manual",
		signal,
	});

let send: Send = throughFetch;

export function sendThrough(transport: Send): void {
	send = transport;
}

export async function ask(url: string, sent: Sent = {}): Promise<Answer> {
	const capped = AbortSignal.timeout(HTTP_TIMEOUT_MS);
	const signal = sent.deadline ? AbortSignal.any([sent.deadline, capped]) : capped;

	let target = url;
	let carried = sent;
	for (let hop = 0; hop <= HOPS_FOLLOWED; hop += 1) {
		const at = await addressesToReach(target);
		const response = await send(target, carried, signal, at);
		if (!REDIRECTS.includes(response.status)) return await answerOf(response);

		const location = response.headers.get("location");
		if (location === null) {
			throw new Error(`${target} answered ${response.status} without saying where to`);
		}
		await response.body?.cancel();

		const next = new URL(location, target).toString();
		carried = KEEPS_THE_METHOD.includes(response.status) ? carried : withoutBody(carried);
		carried = sameOrigin(target, next) ? carried : withoutCredentials(carried);
		target = next;
	}

	throw new Error(`${url} redirected more than ${HOPS_FOLLOWED} times`);
}

export async function resolvesNothingPrivate(url: string): Promise<boolean> {
	const found = await resolved(url);

	return found.length > 0 && found.every((one) => publicAddress(one.address));
}

export async function addressesToReach(url: string): Promise<Verified[]> {
	if (!publicHttps(url)) throw new Error(`${url} is not a public https URL`);
	const found = await resolved(url);
	if (found.length === 0 || !found.every((one) => publicAddress(one.address))) {
		throw new Error(`${url} resolves to an address we do not reach`);
	}

	return found;
}

async function resolved(url: string): Promise<Verified[]> {
	const { lookup } = await import("node:dns/promises");
	const { setTimeout: sleep } = await import("node:timers/promises");
	const host = new URL(url).hostname.replace(/^\[|]$/g, "");
	const found = await Promise.race([
		lookup(host, { all: true, verbatim: true }).catch(() => []),
		sleep(LOOKUP_TIMEOUT_MS, null, { ref: false }),
	]);

	return found ?? [];
}

async function answerOf(response: Response): Promise<Answer> {
	const { status, ok, headers } = response;
	const reader = response.body?.getReader();
	if (!reader) return { status, ok, body: "", truncated: false, headers };

	const read: Uint8Array[] = [];
	let bytes = 0;
	while (bytes <= BODY_LIMIT_BYTES) {
		const { done, value } = await reader.read();
		if (done) return { status, ok, body: text(read), truncated: false, headers };
		read.push(value);
		bytes += value.length;
	}
	await reader.cancel();

	return { status, ok, body: text(read), truncated: true, headers };
}

function withoutBody(sent: Sent): Sent {
	const headers = { ...sent.headers };
	delete headers["content-type"];

	return { ...sent, method: "GET", headers, body: undefined };
}

function withoutCredentials(sent: Sent): Sent {
	const headers = { ...sent.headers };
	for (const named of CREDENTIALS) delete headers[named];

	return { ...sent, headers };
}

function text(chunks: Uint8Array[]): string {
	const decoder = new TextDecoder();
	let decoded = "";
	for (const chunk of chunks) decoded += decoder.decode(chunk, { stream: true });

	return decoded + decoder.decode();
}
