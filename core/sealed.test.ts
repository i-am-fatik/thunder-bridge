import { expect, test } from "vitest";

import { seal, sealFor, unseal, unsealFor } from "./sealed.ts";

const SECRET = "a".repeat(32);
const OTHER_SECRET = "b".repeat(32);
const PLAIN = JSON.stringify({ amountMsat: 21_000, lnAddress: "iamfatik@blink.sv" });
const SEALED_BEFORE_PADDING =
	"v1.WDRS_M_tbcwi132WrGdvo63Zz3dQJXhyS1VnBe8ULlZFeimhurJdNQQgxxJn3bHZsCjca3A1Ij4i";

test("a sealed blob reads back only with the secret that sealed it", async () => {
	const sealed = await seal(SECRET, PLAIN);

	expect(await unseal(SECRET, sealed)).toBe(PLAIN);
	expect(await unseal(OTHER_SECRET, sealed)).toBeNull();
});

test("nothing readable survives into the blob, which is the whole point", async () => {
	const sealed = await seal(SECRET, PLAIN);

	expect(sealed).not.toContain("21000");
	expect(sealed).not.toContain("iamfatik");
	expect(sealed).not.toContain("amountMsat");
	expect(sealed.startsWith("v2.")).toBe(true);
});

test("sealing the same thing twice gives two different blobs", async () => {
	expect(await seal(SECRET, PLAIN)).not.toBe(await seal(SECRET, PLAIN));
});

test("an edited blob is refused rather than decrypted into rubbish", async () => {
	const sealed = await seal(SECRET, PLAIN);
	const [version, body] = sealed.split(".") as [string, string];

	const flipped = (at: number) => {
		const bytes = Buffer.from(body, "base64url");
		bytes[at] = bytes[at]! ^ 1;
		return `${version}.${bytes.toString("base64url")}`;
	};

	expect(await unseal(SECRET, flipped(0))).toBeNull();
	expect(await unseal(SECRET, flipped(Buffer.from(body, "base64url").length - 1))).toBeNull();
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

test("blobs in one size class seal to one length, so the length gives away only the class", async () => {
	const short = await seal(SECRET, "x");

	expect((await seal(SECRET, "x".repeat(256))).length).toBe(short.length);
	expect((await seal(SECRET, "x".repeat(257))).length).toBeGreaterThan(short.length);
});

test("a blob sealed before padding existed still opens to what it held", async () => {
	expect(await unseal(SECRET, SEALED_BEFORE_PADDING)).toBe("sealed before padding existed");
});

test("a blob relabelled as the other version is refused rather than read with its padding on", async () => {
	const sealed = await seal(SECRET, PLAIN);

	expect(await unseal(SECRET, `v1.${sealed.slice(3)}`)).toBeNull();
	expect(await unseal(SECRET, `v2.${SEALED_BEFORE_PADDING.slice(3)}`)).toBeNull();
});

test("utf-8 survives the round trip, so a message is not mangled", async () => {
	const text = "příliš žluťoučký kůň, 21 000 sat 🐴";

	expect(await unseal(SECRET, await seal(SECRET, text))).toBe(text);
});

const stable = (secret: string, plaintext: string) =>
	sealFor("bank-verify", secret, plaintext, { stable: true });

test("a stable seal gives one blob for one plaintext, however often it is asked for", async () => {
	expect(await stable(SECRET, PLAIN)).toBe(await stable(SECRET, PLAIN));
});

test("a stable blob reads back like any other, and only under its own secret", async () => {
	const sealed = await stable(SECRET, PLAIN);

	expect(await unsealFor("bank-verify", SECRET, sealed)).toBe(PLAIN);
	expect(await unsealFor("bank-verify", OTHER_SECRET, sealed)).toBeNull();
});

test("two plaintexts never share a stable nonce, which is what makes the reuse safe", async () => {
	const one = await stable(SECRET, PLAIN);
	const other = await stable(SECRET, `${PLAIN} `);
	const nonceOf = (sealed: string) =>
		Buffer.from(sealed.slice(3), "base64url").subarray(0, 12).toString("hex");

	expect(nonceOf(one)).not.toBe(nonceOf(other));
});

test("the same plaintext under two secrets seals to two blobs", async () => {
	expect(await stable(SECRET, PLAIN)).not.toBe(await stable(OTHER_SECRET, PLAIN));
});

test("a stable blob hides what it carries, exactly like a random one", async () => {
	const sealed = await stable(SECRET, PLAIN);

	expect(sealed).not.toContain("21000");
	expect(sealed).not.toContain("iamfatik");
	expect(sealed.startsWith("v3.")).toBe(true);
});

test("a blob sealed for one purpose opens for that purpose and for no other", async () => {
	const relayed = await sealFor("relay", SECRET, PLAIN);

	expect(await unsealFor("relay", SECRET, relayed)).toBe(PLAIN);
	expect(await unsealFor("bank-verify", SECRET, relayed)).toBeNull();
	expect(await unsealFor("nwc-verify", SECRET, relayed)).toBeNull();
	expect(await unseal(SECRET, relayed)).toBeNull();
});

test("a blob relabelled from a purpose to the version a watcher opens is refused", async () => {
	const relayed = await sealFor("relay", SECRET, PLAIN);

	expect(await unseal(SECRET, `v2.${relayed.slice(3)}`)).toBeNull();
	expect(await unsealFor("relay", SECRET, `v2.${relayed.slice(3)}`)).toBeNull();
});

test("a blob sealed before purposes existed opens as none of them, so a gateway cannot hand one endpoint another's", async () => {
	expect(await unsealFor("bank-verify", SECRET, await seal(SECRET, PLAIN))).toBeNull();
	expect(await unsealFor("relay", SECRET, SEALED_BEFORE_PADDING)).toBeNull();
});

const HASH = "ab".repeat(32);
const OTHER_HASH = "cd".repeat(32);

test("a blob sealed for a payment opens beside that payment and beside no other", async () => {
	const sealed = await seal(SECRET, PLAIN, HASH);

	expect(await unseal(SECRET, sealed, HASH)).toBe(PLAIN);
	expect(await unseal(SECRET, sealed, HASH.toUpperCase())).toBe(PLAIN);
	expect(await unseal(SECRET, sealed, OTHER_HASH)).toBeNull();
	expect(await unseal(SECRET, sealed)).toBeNull();
});

test("a blob sealed for no payment does not open as though it had been sealed for one", async () => {
	expect(await unseal(SECRET, await seal(SECRET, PLAIN), HASH)).toBeNull();
	expect(await unseal(SECRET, SEALED_BEFORE_PADDING, HASH)).toBeNull();
});
