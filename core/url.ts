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

	const [a, b, c] = parts as [number, number, number, number];
	if (a === 0 || a === 10 || a === 127 || a >= 224) {
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
	if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) {
		return false;
	}
	if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) {
		return false;
	}
	if (a === 203 && b === 0 && c === 113) {
		return false;
	}

	return true;
}

function ipv6IsGlobal(literal: string): boolean {
	const groups = ipv6Groups(literal.toLowerCase());
	if (groups.length !== 8 || groups.some(Number.isNaN)) {
		return false;
	}

	const [first, second, third, fourth, fifth, sixth, high, low] = groups as [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	];
	const embedded = (one: number, other: number) =>
		ipv4IsGlobal(`${one >> 8}.${one & 0xff}.${other >> 8}.${other & 0xff}`);
	const zeroBefore = (count: number) => groups.slice(0, count).every((group) => group === 0);

	if (zeroBefore(5) && sixth === 0xffff) {
		return embedded(high, low);
	}
	if (zeroBefore(6) || (zeroBefore(4) && fifth === 0xffff && sixth === 0)) {
		return false;
	}
	if (first === 0x64 && second === 0xff9b) {
		return third === 0 && fourth === 0 && fifth === 0 && sixth === 0 && embedded(high, low);
	}
	if (first === 0x2002) {
		return embedded(second, third);
	}
	if (first === 0x2001 && second === 0) {
		return false;
	}
	if (first === 0x100 && second === 0 && third === 0 && fourth === 0) {
		return false;
	}
	if ((first & 0xfe00) === 0xfc00 || (first & 0xff00) === 0xff00) {
		return false;
	}
	if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) {
		return false;
	}

	return true;
}

function ipv6Groups(address: string): number[] {
	const halves = withDottedTailAsGroups(address).split("::");
	const [head = "", tail] = halves;
	const left = head.split(":").filter((group) => group !== "");
	const right = (tail ?? "").split(":").filter((group) => group !== "");
	const missing = 8 - left.length - right.length;
	if (halves.length > 2 || missing < 0) {
		return [Number.NaN];
	}
	const gap = tail === undefined ? [] : Array<string>(missing).fill("0");

	return [...left, ...gap, ...right].map((group) =>
		/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN,
	);
}

function withDottedTailAsGroups(address: string): string {
	const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);
	if (dotted === null) {
		return address;
	}

	const [a, b, c, d] = dotted[2]!.split(".").map(Number) as [number, number, number, number];
	if ([a, b, c, d].some((part) => part > 255)) {
		return `${dotted[1]}x`;
	}

	return `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
}

const AGENT_ADDRESS = /^agent:([0-9a-f]{64})$/;

/**
 * The caller an address names, or null when it names a host instead. A watch
 * says which way it answers by the address it carries, so nothing else has to
 */
export function agentAddressed(verifyUrl: string): string | null {
	return AGENT_ADDRESS.exec(verifyUrl)?.[1] ?? null;
}
