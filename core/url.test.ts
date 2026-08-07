import { expect, test } from "vitest";

import { publicHttps, sameOrigin } from "./url.ts";

test("public https hosts are fetchable", () => {
	for (const url of [
		"https://coinos.io/api/lnurl/verify/1",
		"https://getalby.com/lnurlp/hello/verify/x",
		"https://1.1.1.1/cb",
		"https://[2606:4700::1111]/cb",
	]) {
		expect(publicHttps(url)).toBe(true);
	}
});

test("local and plaintext hosts are refused", () => {
	for (const url of [
		"http://coinos.io/cb",
		"https://localhost/cb",
		"https://api.localhost/cb",
		"https://printer.local/cb",
		"https://gateway.internal/cb",
		"https://nas.lan/cb",
		"https://bare-hostname/cb",
		"https://127.0.0.1/cb",
		"https://10.0.0.5/cb",
		"https://192.168.1.1/cb",
		"https://169.254.169.254/latest/meta-data",
		"https://100.88.88.200/cb",
		"https://[::1]/cb",
		"https://[fd00::1]/cb",
		"https://[fe80::1]/cb",
		"https://[::ffff:127.0.0.1]/cb",
	]) {
		expect(publicHttps(url)).toBe(false);
	}
});

test("a trailing dot does not smuggle a private host past the guard", () => {
	expect(publicHttps("https://printer.local./cb")).toBe(false);
	expect(publicHttps("https://coinos.io./cb")).toBe(true);
});

test("same origin compares scheme, host and port, not path", () => {
	expect(sameOrigin("https://coinos.io/a", "https://coinos.io/b")).toBe(true);
	expect(sameOrigin("https://coinos.io/a", "https://evil.io/a")).toBe(false);
	expect(sameOrigin("https://coinos.io/a", "not a url")).toBe(false);
});
