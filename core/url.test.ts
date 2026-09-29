import { expect, test } from "vitest";

import { agentAddressed, publicAddress, publicHttps, sameOrigin } from "./url.ts";

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

test("an address the resolver spells with a dotted tail is judged by the IPv4 inside it", () => {
	for (const address of [
		"::ffff:127.0.0.1",
		"::ffff:169.254.169.254",
		"::ffff:10.0.0.7",
		"::127.0.0.1",
		"64:ff9b::127.0.0.1",
		"::ffff:300.0.0.1",
		"::ffff:1.300.0.1",
	]) {
		expect(publicAddress(address)).toBe(false);
	}
	expect(publicAddress("::ffff:1.1.1.1")).toBe(true);
	expect(publicAddress("64:ff9b::1.1.1.1")).toBe(true);
});

test("an address in a range nobody reaches over the internet is not public, however it is spelled", () => {
	for (const address of [
		"64:ff9b::a9fe:a9fe",
		"64:ff9b:1::1",
		"64:ff9b:1::101:101",
		"2002:a9fe:a9fe::1",
		"2002:7f00:1::1",
		"2001:0:4136:e378::1",
		"::7f00:1",
		"::ffff:0:7f00:1",
		"fec0::1",
		"ff02::1",
		"100::1",
		"1::2::3",
		"1:2:3:4:5:6:7:8::9",
		"fe80::1%eth0",
		"2606:4700::11g1",
		"224.0.0.1",
		"239.255.255.250",
		"198.18.0.1",
		"198.19.255.1",
		"192.0.0.170",
		"192.0.2.1",
		"198.51.100.7",
		"203.0.113.1",
	]) {
		expect(publicAddress(address)).toBe(false);
	}
	for (const address of ["2002:0101:0101::1", "2606:4700::1111", "1.1.1.1", "8.8.4.4"]) {
		expect(publicAddress(address)).toBe(true);
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

test("an agent address names the caller that answers for it", () => {
	expect(agentAddressed(`agent:${"a".repeat(64)}`)).toBe("a".repeat(64));
});

test("anything that is not one agent key is no agent address", () => {
	expect(agentAddressed("https://coinos.io/verify")).toBeNull();
	expect(agentAddressed(`agent:${"a".repeat(63)}`)).toBeNull();
	expect(agentAddressed(`agent:${"A".repeat(64)}`)).toBeNull();
	expect(agentAddressed(`agent:${"a".repeat(64)} `)).toBeNull();
	expect(agentAddressed(`AGENT:${"a".repeat(64)}`)).toBeNull();
	expect(agentAddressed("agent:")).toBeNull();
});
