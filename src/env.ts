export function whole(name: string, fallback: number): number {
	const raw = process.env[name];
	const value = raw === undefined || raw === "" ? fallback : Number(raw);
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${name} must be a whole number, zero or more`);
	}

	return value;
}

export function positive(name: string, fallback: number): number {
	const value = whole(name, fallback);
	if (value === 0) throw new Error(`${name} must be greater than zero`);

	return value;
}

export function bearer(name: string): string | null {
	const raw = (process.env[name] ?? "").trim();

	return raw === "" ? null : raw;
}

export function hosts(name: string): Set<string> | null {
	const raw = (process.env[name] ?? "").trim();
	if (raw === "") return null;

	return new Set(raw.split(",").map((one) => one.trim().toLowerCase()));
}

export function secret(name: string): Uint8Array {
	const bytes = Buffer.from(process.env[name] ?? "", "hex");
	if (bytes.length !== 32) throw new Error(`${name} must be set to 32 bytes of hex`);

	return bytes;
}

export function secrets(name: string): Uint8Array[] {
	const raw = (process.env[name] ?? "").trim();
	if (raw === "") return [];

	return raw.split(",").map((one) => {
		const bytes = Buffer.from(one.trim(), "hex");
		if (bytes.length !== 32) throw new Error(`every ${name} entry must be 32 bytes of hex`);

		return bytes;
	});
}
