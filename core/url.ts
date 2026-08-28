const PRIVATE_SUFFIXES = ["localhost", "local", "internal", "lan", "arpa", "test", "invalid"];

export function publicHttps(raw: string): boolean {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}

	return url.protocol === "https:" && hostIsPublic(url.hostname.toLowerCase());
}

export function sameOrigin(one: string, other: string): boolean {
	try {
		return new URL(one).origin === new URL(other).origin;
	} catch {
		return false;
	}
}

export function publicAddress(literal: string): boolean {
	return literal.includes(":") ? ipv6IsGlobal(literal) : ipv4IsGlobal(literal);
}

function hostIsPublic(host: string): boolean {
	if (host.startsWith("[")) {
		return publicAddress(host.slice(1, -1));
	}

	const name = host.replace(/\.$/, "");
	if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) {
		return publicAddress(name);
	}

	const labels = name.split(".");
	if (labels.length < 2 || labels.some((label) => label === "")) {
		return false;
	}

	return !PRIVATE_SUFFIXES.includes(labels[labels.length - 1]!);
}

function ipv4IsGlobal(literal: string): boolean {
	const parts = literal.split(".").map(Number);
	if (
		parts.length !== 4 ||
		parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
	) {
		return false;
	}

	const [a, b] = parts as [number, number, number, number];
	if (a === 0 || a === 10 || a === 127 || a >= 240) {
		return false;
	}
	if (a === 100 && b >= 64 && b < 128) {
		return false;
	}
	if (a === 169 && b === 254) {
		return false;
	}
	if (a === 172 && b >= 16 && b < 32) {
		return false;
	}
	if (a === 192 && b === 168) {
		return false;
	}

	return true;
}

function ipv6IsGlobal(literal: string): boolean {
	const groups = ipv6Groups(literal.toLowerCase());
	if (groups.length !== 8 || groups.some(Number.isNaN)) {
		return false;
	}

	const leading = groups.slice(0, 5).every((group) => group === 0);
	if (leading && groups[5] === 0 && groups[6] === 0 && groups[7]! <= 1) {
		return false;
	}
	if (leading && groups[5] === 0xffff) {
		const [high, low] = [groups[6]!, groups[7]!];
		return ipv4IsGlobal(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
	}

	const first = groups[0]!;
	if ((first & 0xfe00) === 0xfc00) {
		return false;
	}
	if ((first & 0xffc0) === 0xfe80) {
		return false;
	}

	return true;
}

function ipv6Groups(address: string): number[] {
	const [head = "", tail] = address.split("::");
	const left = head.split(":").filter((group) => group !== "");
	const right = (tail ?? "").split(":").filter((group) => group !== "");
	const gap = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");

	return [...left, ...gap, ...right].map((group) => parseInt(group, 16));
}
