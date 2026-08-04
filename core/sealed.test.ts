import { expect, test } from "vitest";

import { seal, unseal } from "./sealed.ts";

const SECRET = "a".repeat(32);
const OTHER_SECRET = "b".repeat(32);
const PLAIN = JSON.stringify({ amountMsat: 21_000, lnAddress: "charter@blink.sv" });

test("a sealed blob reads back only with the secret that sealed it", async () => {
	const sealed = await seal(SECRET, PLAIN);

	expect(await unseal(SECRET, sealed)).toBe(PLAIN);
	expect(await unseal(OTHER_SECRET, sealed)).toBeNull();
});

test("nothing readable survives into the blob, which is the whole point", async () => {
	const sealed = await seal(SECRET, PLAIN);

	expect(sealed).not.toContain("21000");
	expect(sealed).not.toContain("charter");
	expect(sealed).not.toContain("amountMsat");
	expect(sealed.startsWith("v1.")).toBe(true);
});

test("sealing the same thing twice gives two different blobs", async () => {
	expect(await seal(SECRET, PLAIN)).not.toBe(await seal(SECRET, PLAIN));
});

test("an edited blob is refused rather than decrypted into rubbish", async () => {
	const sealed = await seal(SECRET, PLAIN);
	const [version, body] = sealed.split(".") as [string, string];

	const flipped = (at: number) => {
		const bytes = [...body];
		bytes[at] = bytes[at] === "A" ? "B" : "A";
		return `${version}.${bytes.join("")}`;
	};

	expect(await unseal(SECRET, flipped(0))).toBeNull();
	expect(await unseal(SECRET, flipped(body.length - 1))).toBeNull();
	expect(await unseal(SECRET, `${version}.${body.slice(0, -4)}`)).toBeNull();
});

test("a blob that is not one of ours is null, never a throw", async () => {
	for (const foreign of ["", "v1.", "v2.abcd", "not-sealed", "v1.not base64!", "v1.AAAA", "."]) {
		expect(await unseal(SECRET, foreign)).toBeNull();
	}
});

test("a secret too short to be a key fails loudly instead of sealing weakly", async () => {
	await expect(seal("hunter2", PLAIN)).rejects.toThrow(/32 characters/);
	await expect(unseal("hunter2", "v1.AAAA")).rejects.toThrow(/32 characters/);
});

test("a plaintext the gateway would refuse is refused here, where the error is readable", async () => {
	await expect(seal(SECRET, "x".repeat(3001))).rejects.toThrow(/at most 3000 bytes/);
	expect(typeof (await seal(SECRET, "x".repeat(3000)))).toBe("string");
});

test("a sealed blob fits the 4096 the wire allows, even at full size", async () => {
	expect((await seal(SECRET, "x".repeat(3000))).length).toBeLessThanOrEqual(4096);
});

test("utf-8 survives the round trip, so a message is not mangled", async () => {
	const text = "příliš žluťoučký kůň, 21 000 sat 🐴";

	expect(await unseal(SECRET, await seal(SECRET, text))).toBe(text);
});
