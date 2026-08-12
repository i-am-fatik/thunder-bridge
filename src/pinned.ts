import { request, type RequestOptions } from "node:https";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import type { Send, Verified } from "../core/outbound.ts";

const HTTPS_PORT = 443;
const CARRIES_NO_BODY = [204, 205, 304];

export const pinnedToTheAddressWeVerified: Send = (url, sent, signal, at) => {
	const asked = new URL(url);
	const first = at[0];
	if (first === undefined) throw new Error(`${url} resolved to nothing worth connecting to`);

	return new Promise<Response>((settle, fail) => {
		if (signal.aborted) {
			fail(signal.reason);
			return;
		}

		const call = request(reaching(asked, sent, at, first), (answer: IncomingMessage) => {
			const status = answer.statusCode ?? 502;
			settle(
				new Response(
					CARRIES_NO_BODY.includes(status) ? null : (Readable.toWeb(answer) as ReadableStream),
					{ status, headers: headersOf(answer.headers) },
				),
			);
		});

		const give = () => call.destroy(new Error(`${url} took longer than allowed`));
		signal.addEventListener("abort", give, { once: true });
		call.on("close", () => signal.removeEventListener("abort", give));
		call.on("error", fail);

		if (sent.body !== undefined) call.write(sent.body);
		call.end();
	});
};

function reaching(
	asked: URL,
	sent: Parameters<Send>[1],
	at: readonly Verified[],
	first: Verified,
): RequestOptions {
	return {
		host: asked.hostname,
		servername: asked.hostname,
		port: asked.port === "" ? HTTPS_PORT : Number(asked.port),
		path: `${asked.pathname}${asked.search}`,
		method: sent.method ?? "GET",
		headers: { ...sent.headers, host: asked.host },
		agent: false,
		lookup: (_name, options, done) => {
			if (options.all === true) done(null, at.map((one) => ({ ...one })));
			else done(null, first.address, first.family);
		},
	};
}

function headersOf(raw: IncomingHttpHeaders): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(raw)) {
		if (Array.isArray(value)) for (const one of value) headers.append(name, one);
		else if (value !== undefined) headers.set(name, value);
	}

	return headers;
}
