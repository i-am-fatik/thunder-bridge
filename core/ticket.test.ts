import { expect, test } from "vitest";

import { mint, read, type Subject } from "./ticket.ts";

const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);
const NOW = 1_900_000_000;
const TTL = 60;

const WATCHING: Subject = { kind: "trigger", trigger: "a".repeat(64) };
const READING: Subject = { kind: "payment", paymentId: "b".repeat(64) };

test("a ticket reads back as the subject it was minted for", async () => {
	const watching = await mint(KEY, WATCHING, TTL, NOW);
	const reading = await mint(KEY, READING, TTL, NOW);

	expect(await read(KEY, watching.ticket, NOW)).toMatchObject(WATCHING);
	expect(await read(KEY, reading.ticket, NOW)).toMatchObject(READING);
	expect(watching.expiresAt).toBe(NOW + TTL);
});

test("a ticket for one trigger never opens another", async () => {
	const mine = await mint(KEY, WATCHING, TTL, NOW);
	const theirs = await mint(KEY, { kind: "trigger", trigger: "c".repeat(64) }, TTL, NOW);

	const read1 = await read(KEY, mine.ticket, NOW);
	const read2 = await read(KEY, theirs.ticket, NOW);

	expect(read1).toMatchObject({ trigger: "a".repeat(64) });
	expect(read2).toMatchObject({ trigger: "c".repeat(64) });
	expect(read1).not.toEqual(read2);
});

test("a trigger ticket is not a payment ticket even for the same hex", async () => {
	const watching = await mint(KEY, { kind: "trigger", trigger: "a".repeat(64) }, TTL, NOW);

	expect(await read(KEY, watching.ticket, NOW)).toMatchObject({ kind: "trigger" });
	expect(await read(KEY, watching.ticket.replace(/^1\.t\./, "1.p."), NOW)).toBeNull();
});

test("a ticket is spent by time, on the second it expires", async () => {
	const { ticket, expiresAt } = await mint(KEY, WATCHING, TTL, NOW);

	expect(await read(KEY, ticket, expiresAt - 1)).not.toBeNull();
	expect(await read(KEY, ticket, expiresAt)).toBeNull();
	expect(await read(KEY, ticket, expiresAt + 1)).toBeNull();
});

test("another deployment's key does not read this one's tickets", async () => {
	const { ticket } = await mint(KEY, WATCHING, TTL, NOW);

	expect(await read(OTHER_KEY, ticket, NOW)).toBeNull();
});

test("every field is covered by the signature, so none can be edited", async () => {
	const { ticket } = await mint(KEY, WATCHING, TTL, NOW);
	const [version, kind, name, expiry, jti, mac] = ticket.split(".") as string[];

	const edits = [
		["2", kind, name, expiry, jti, mac],
		[version, "p", name, expiry, jti, mac],
		[version, kind, "d".repeat(64), expiry, jti, mac],
		[version, kind, name, String(Number(expiry) + 86_400), jti, mac],
		[version, kind, name, expiry, "00", mac],
		[version, kind, name, expiry, jti, "0".repeat(64)],
	];

	for (const edited of edits) {
		expect(await read(KEY, edited.join("."), NOW)).toBeNull();
	}
});

test("garbage is refused rather than throwing, whatever shape it arrives in", async () => {
	for (const nonsense of ["", ".", "1.t", "not.a.ticket.at.all.really", "1.t.zz.1.1.1", "....."]) {
		expect(await read(KEY, nonsense, NOW)).toBeNull();
	}
});

test("two tickets for the same subject differ, so one cannot be guessed from another", async () => {
	const one = await mint(KEY, WATCHING, TTL, NOW);
	const other = await mint(KEY, WATCHING, TTL, NOW);

	expect(one.ticket).not.toBe(other.ticket);
	expect(one.jti).not.toBe(other.jti);
});
