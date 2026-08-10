const LOUDNESS = { debug: 10, info: 20, warn: 30, error: 40, silent: 50 };

type Level = keyof typeof LOUDNESS;

const quietestKept = chosen();

export function debug(message: string): void {
	if (LOUDNESS.debug >= quietestKept) console.log(message);
}

export function info(message: string): void {
	if (LOUDNESS.info >= quietestKept) console.log(message);
}

export function warn(message: string): void {
	if (LOUDNESS.warn >= quietestKept) console.warn(message);
}

export function error(message: string): void {
	if (LOUDNESS.error >= quietestKept) console.error(message);
}

function chosen(): number {
	const asked = (process.env["LOG_LEVEL"] ?? "info").toLowerCase();
	const found = LOUDNESS[asked as Level];
	if (found === undefined) {
		throw new Error(`LOG_LEVEL must be one of ${Object.keys(LOUDNESS).join(", ")}`);
	}

	return found;
}
