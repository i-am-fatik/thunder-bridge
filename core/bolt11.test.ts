import { expect, test } from "vitest";

import { decodeInvoice, preimageMatchesHash } from "./bolt11.ts";

const SPEC_25M =
	"lnbc25m1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5vdhkven9v5sxyetpdeessp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs9q5sqqqqqqqqqqqqqqqpqsq67gye39hfg3zd8rgc80k32tvy9xk2xunwm5lzexnvpx6fd77en8qaq424dxgt56cag2dpt359k3ssyhetktkpqh24jqnjyw6uqd08sgptq44qu";

const COINOS_21_SAT =
	"lnbc210n1p4xme85sp5q5zjfrjy45rcppnw3lqayp252fzlkt209e54wwjetj6se46h5hzqpp53kacq29ahd776muhtqmke06g9ltf49cm30lvscedgz2mg8h06tnshp5vq6e2dhqtvmm375umz70kg84peq3dvjdpdetg7yjgr2arq9ydvnqxq9z0rgqcqpnrzjqfg9fl7sw2ghgfvfa7pqaypsfn69tn0tdttregjd5sds2vxhn9gq5r5ljvqqh5cqqyqqqqlgqqqqraqqjq9qxpqysgqlua97ktehmqwr2xs2m6pknhh5lnntnr4kylv3p0k5fmnyjjlvkn47g0z69eqvpmej785kqe6796e7klu2d6k4m5ldyj3l5sl9vup5kgpkzel4t";

const ALBY_21_SAT =
	"lnbc210n1p4xmkw7hp50kncf9zk35xg4lxewt4974ry6mudygsztsz8qn3ar8pn3mtpe50snp4qdkt5m0tdusqvzv7ufx9nypz0aq3nt5ktpv3645cq9y6azkv3hw86pp50ypa4s4ef3e5wv9t0pr40dxn44fa4gdfks056gu2vqdv7xhq3xcqsp5p93y2gp6zetyh8yk88adrvyy9xe28t4tdl0ne3rsnkwhqev2cxmq9qyysgqcqzp2xqyz5vqrzjqdc22wfv6lyplagj37n9dmndkrzdz8rh3lxkewvvk6arkjpefats2z7d8cqqy0sqqyqqqqlgqqqqqqgqfqrzjq26922n6s5n5undqrf78rjjhgpcczafws45tx8237y7pzx3fg8ww8apyqqqqqqqqv5qqqqqqqqqqqqqq2qrzjqw963anm4rl4cjrkfnwny5wrxkvd2keqx4rdpz50pmyaek0j0cmr0apyqqqqqqqqxgqqqqlgqqqq05qqzgyg3ah8qg06wy7ucx75cg5lgqgfgezr2m99u55p84j6tfu3mrluxy9elmudxrpjwwatzcdxjzc6g3fye2z6m58lrhhcu4w6aayj0r06gqh3c75w";

const ZERO_PREIMAGE = "0".repeat(64);
const ZERO_PREIMAGE_HASH = "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925";

test("the spec vector decodes to its documented hash, amount and expiry", () => {
	const invoice = decodeInvoice(SPEC_25M);
	expect(invoice.paymentHash).toBe(
		"0001020304050607080900010203040506070809000102030405060708090102",
	);
	expect(invoice.amountMsat).toBe(2_500_000_000);
	expect(invoice.expiresAt).toBe(1_496_314_658 + 3600);
});

test("a real coinos invoice matches the hash the rust decoder produced", () => {
	const invoice = decodeInvoice(COINOS_21_SAT);
	expect(invoice.paymentHash).toBe(
		"8dbb8028bdbb7ded6f9758376cbf482fd69a971b8bfec8632d4095b41eefd2e7",
	);
	expect(invoice.amountMsat).toBe(21_000);
});

test("the description hash is the sha256 coinos publishes as its metadata", async () => {
	const metadata =
		'[["text/plain","Paying charter@coinos.io"],["text/identifier","charter@coinos.io"]]';
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(metadata));
	const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

	expect(decodeInvoice(COINOS_21_SAT).descriptionHash).toBe(hex);
	expect(decodeInvoice(ALBY_21_SAT).descriptionHash).not.toBe(hex);
	expect(decodeInvoice(SPEC_25M).descriptionHash).toBeNull();
});

test("a real alby invoice matches the hash the rust decoder produced", () => {
	const invoice = decodeInvoice(ALBY_21_SAT);
	expect(invoice.paymentHash).toBe(
		"7903dac2b94c734730ab784757b4d3ad53daa1a9b41f4d238a601acf1ae089b0",
	);
	expect(invoice.amountMsat).toBe(21_000);
});

test("coinos hands out a thirty day expiry", () => {
	const invoice = decodeInvoice(COINOS_21_SAT).expiresAt;
	expect(invoice).toBe(1_785_586_932 + 2_592_000);
});

test("garbage decodes to an invoice that says nothing", () => {
	for (const garbage of ["lnbc1nonsense", "not-an-invoice", "", "lno1pgqpvggz"]) {
		expect(decodeInvoice(garbage)).toEqual({
			paymentHash: null,
			descriptionHash: null,
			amountMsat: null,
			expiresAt: null,
		});
	}
});

test("a string too short to hold a signature carries no expiry to mistake for a real one", () => {
	expect(decodeInvoice("lnbc210n1qqqqqq").expiresAt).toBeNull();
});

test("a preimage proves only the hash it hashes to", () => {
	expect(preimageMatchesHash(ZERO_PREIMAGE, ZERO_PREIMAGE_HASH)).toBe(true);
	expect(preimageMatchesHash(ZERO_PREIMAGE, ZERO_PREIMAGE_HASH.toUpperCase())).toBe(true);
	expect(preimageMatchesHash(ZERO_PREIMAGE.toUpperCase(), ZERO_PREIMAGE_HASH)).toBe(true);
	expect(preimageMatchesHash("01".repeat(32), ZERO_PREIMAGE_HASH)).toBe(false);
	expect(preimageMatchesHash("nothex", ZERO_PREIMAGE_HASH)).toBe(false);
	expect(preimageMatchesHash("", ZERO_PREIMAGE_HASH)).toBe(false);
});
