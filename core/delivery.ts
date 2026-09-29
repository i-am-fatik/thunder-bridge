/**
 * What a gateway signs when it posts to a URL, and what the receiver checks. The
 * endpoint is inside it, so a delivery made for one receiver proves nothing at
 * another that trusts the same gateway. Only the origin and the path are bound,
 * because a query string and a fragment are what proxies rewrite
 */
export function deliverySigned(
	url: string,
	timestamp: string,
	body: string,
): Uint8Array<ArrayBuffer> {
	const endpoint = new URL(url);

	return new TextEncoder().encode(
		["v2", `${endpoint.origin}${endpoint.pathname}`, timestamp, body].join("\n"),
	);
}
