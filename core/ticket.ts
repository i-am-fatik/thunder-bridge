import { bytesToHex } from "./bytes.ts";
import { equalInConstantTime, hmacHex } from "./hmac.ts";

const VERSION = "2";
const NONCE_BYTES = 8;
const TRIGGER = "t";
const PAYMENT = "p";
const SHAPE = new RegExp(
	`^${VERSION}\\.([${TRIGGER}${PAYMENT}])\\.([0-9a-f]{64})\\.([0-9]+)\\.([0-9a-f]+)\\.([0-9]+)\\.([0-9a-f]{64})$`,
);

/** What a ticket permits, and the only thing it permits */
export type Subject =
	| { kind: "trigger"; trigger: string; replay: number }
	| { kind: "payment"; paymentId: string };

export type Ticket = { ticket: string; expiresAt: number; jti: string };

/**
 * Sign a short-lived permission to open one socket for one subject. Nothing is
 * stored, so any instance sharing the key can read a ticket another one minted
 */
export async function mint(
	key: Uint8Array,
	subject: Subject,
	ttlSecs: number,
	now: number,
): Promise<Ticket> {
	const expiresAt = now + ttlSecs;
	const jti = bytesToHex(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
	const named =
		subject.kind === "trigger"
			? { tag: TRIGGER, name: subject.trigger, replay: subject.replay }
			: { tag: PAYMENT, name: subject.paymentId, replay: 0 };
	const claim = [VERSION, named.tag, named.name, expiresAt, jti, named.replay].join(".");

	return { ticket: `${claim}.${await hmacHex(key, claim)}`, expiresAt, jti };
}

/** What this ticket permits, or null when it is forged, malformed or spent by time */
export async function read(
	key: Uint8Array,
	ticket: string,
	now: number,
): Promise<(Subject & { jti: string }) | null> {
	const shaped = SHAPE.exec(ticket);
	if (shaped === null) {
		return null;
	}

	const kind = shaped[1]!;
	const name = shaped[2]!;
	const expiresAt = Number(shaped[3]!);
	const jti = shaped[4]!;
	const replay = Number(shaped[5]!);
	const mac = shaped[6]!;
	if (expiresAt <= now) {
		return null;
	}

	const claim = ticket.slice(0, ticket.lastIndexOf("."));
	if (!equalInConstantTime(mac, await hmacHex(key, claim))) {
		return null;
	}

	return kind === TRIGGER
		? { kind: "trigger", trigger: name, replay, jti }
		: { kind: "payment", paymentId: name, jti };
}
