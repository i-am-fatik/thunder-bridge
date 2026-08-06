import { lookup } from "node:dns/promises";

import { publicAddress, publicHttps } from "./url.ts";

const HTTP_TIMEOUT_MS = 15_000;
const HOPS_FOLLOWED = 2;
const REDIRECTS = [301, 302, 303, 307, 308];
const KEEPS_THE_METHOD = [307, 308];

export const BODY_LIMIT_BYTES = 262_144;

export type Sent = {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	deadline?: AbortSignal;
};

export type Answer = { status: number; ok: boolean; body: string; truncated: boolean };

export async function ask(url: string, sent: Sent = {}): Promise<Answer> {
	const capped = AbortSignal.timeout(HTTP_TIMEOUT_MS);
	const signal = sent.deadline ? AbortSignal.any([sent.deadline, capped]) : capped;

	let target = url;
	let carried = sent;
	for (let hop = 0; hop <= HOPS_FOLLOWED; hop += 1) {
		await refuseUnlessPublic(target);
		const response = await fetch(target, {
			method: carried.method ?? "GET",
			headers: carried.headers ?? {},
			body: carried.body,
			redirect: "manual",
			signal,
		});
		if (!REDIRECTS.includes(response.status)) return await answerOf(response);

		target = new URL(response.headers.get("location") ?? "", target).toString();
		carried = KEEPS_THE_METHOD.includes(response.status) ? carried : withoutBody(carried);
	}

	throw new Error(`${url} redirected more than ${HOPS_FOLLOWED} times`);
}

export async function resolvesPublic(url: string): Promise<boolean> {
	const host = new URL(url).hostname.replace(/^\[|]$/g, "");
	const found = await lookup(host, { all: true, verbatim: true }).catch(() => []);

	return found.every((one) => publicAddress(one.address));
}

async function refuseUnlessPublic(url: string): Promise<void> {
	if (!publicHttps(url)) throw new Error(`${url} is not a public https URL`);
	if (!(await resolvesPublic(url))) throw new Error(`${url} resolves to an address we do not reach`);
}

async function answerOf(response: Response): Promise<Answer> {
	const reader = response.body?.getReader();
	if (!reader) return { status: response.status, ok: response.ok, body: "", truncated: false };

	const read: Uint8Array[] = [];
	let bytes = 0;
	while (bytes <= BODY_LIMIT_BYTES) {
		const { done, value } = await reader.read();
		if (done) return { status: response.status, ok: response.ok, body: text(read), truncated: false };
		read.push(value);
		bytes += value.length;
	}
	await reader.cancel();

	return { status: response.status, ok: response.ok, body: text(read), truncated: true };
}

function withoutBody(sent: Sent): Sent {
	const headers = { ...sent.headers };
	delete headers["content-type"];

	return { method: "GET", headers, deadline: sent.deadline };
}

function text(chunks: Uint8Array[]): string {
	const decoder = new TextDecoder();
	let decoded = "";
	for (const chunk of chunks) decoded += decoder.decode(chunk, { stream: true });

	return decoded + decoder.decode();
}
