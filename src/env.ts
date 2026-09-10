export function whole(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw === "") {
		return undefined;
	}

	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${name} must be a whole number, zero or more`);
	}

	return value;
}

export function positive(name: string): number | undefined {
	const value = whole(name);
	if (value === 0) {
		throw new Error(`${name} must be greater than zero`);
	}

	return value;
}

export function secsToMs(secs: number | undefined): number | undefined {
	return secs === undefined ? undefined : secs * 1000;
}

export function daysToSecs(days: number | undefined): number | undefined {
	return days === undefined ? undefined : days * 86_400;
}

export function bearer(name: string): string | undefined {
	const raw = (process.env[name] ?? "").trim();

	return raw === "" ? undefined : raw;
}

export function allowed(name: string): Set<string> | undefined {
	const raw = (process.env[name] ?? "").trim();
	if (raw === "") {
		return undefined;
	}

	return new Set(raw.split(",").map((one) => one.trim().toLowerCase()));
}

export function secret(name: string): Uint8Array {
	const bytes = Buffer.from(process.env[name] ?? "", "hex");
	if (bytes.length !== 32) {
		throw new Error(`${name} must be set to 32 bytes of hex`);
	}

	return bytes;
}

export function secrets(name: string): Uint8Array[] {
	const raw = (process.env[name] ?? "").trim();
	if (raw === "") {
		return [];
	}

	return raw.split(",").map((one) => {
		const bytes = Buffer.from(one.trim(), "hex");
		if (bytes.length !== 32) {
			throw new Error(`every ${name} entry must be 32 bytes of hex`);
		}

		return bytes;
	});
}
