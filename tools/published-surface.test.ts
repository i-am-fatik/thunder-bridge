import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

import { DOORS, surfaceOf } from "./api-reference.ts";

const BACKTICKED = /`([A-Za-z_$][\w$]*)`/g;
const PROSE = ["sdk/README.md", "docs/api.md"];
const CARED_ABOUT =
	/Error$|Fault$|Code$|^Msat$|^Amount$|^prove|^carries|^sats$|^msat$|^fiat$|^sell$|^settled$|^paid$|Payment$|^Sale$/;

const doors = surfaceOf(".");
const exported = new Set<string>();
const members = new Set<string>();
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
for (const items of doors.values()) {
	for (const item of items) {
		exported.add(item.name);
		for (const member of item.members) {
			members.add(member.name);
		}
		for (const found of item.signature.matchAll(IDENTIFIER)) {
			members.add(found[0]);
		}
	}
}

async function importableFrom(specifier: string): Promise<string[]> {
	const built = specifier === "thunder-bridge" ? "index" : specifier.replace("thunder-bridge/", "");
	const module = (await import(`../sdk/dist/${built}.js`)) as Record<string, unknown>;

	return Object.keys(module).filter((name) => name !== "default");
}

test("every door the reference lists is importable from the built package", async () => {
	for (const door of DOORS) {
		expect(await importableFrom(door.specifier)).not.toHaveLength(0);
	}
});

test("a name the documentation backticks is exported by a door or is a member of one", () => {
	const promised = new Set<string>();
	for (const path of PROSE) {
		const prose = readFileSync(path, "utf8").replace(/```[a-z]*\n[\s\S]*?```/g, "");
		for (const found of prose.matchAll(BACKTICKED)) {
			promised.add(found[1] as string);
		}
	}

	const owed = [...promised].filter(
		(name) => CARED_ABOUT.test(name) && !exported.has(name) && !members.has(name),
	);

	expect(owed).toEqual([]);
});

test("the error classes a caller catches are exported, and so is every fault union", () => {
	for (const name of [
		"AmountError",
		"AmountFault",
		"GatewayCheatError",
		"GatewayCheatCode",
		"IdempotencyConflictError",
		"NoWalletAvailableError",
		"ProblemError",
		"UnverifiedRecipientError",
		"WrapRefusedError",
		"WrapRefusalCode",
	]) {
		expect(exported, `${name} is part of the failure contract`).toContain(name);
	}
});

test("a type an exported function returns can be named by a consumer", () => {
	for (const name of ["Msat", "Amount", "Payment", "MintedPayment", "WatchedPayment", "Sale"]) {
		expect(exported, `${name} appears in a published signature`).toContain(name);
	}
});

test("an error class is importable at runtime, not merely declared", async () => {
	const main = await importableFrom("thunder-bridge");
	for (const name of ["AmountError", "ProblemError", "GatewayCheatError"]) {
		expect(main).toContain(name);
	}
});

test("AmountError is recognisable across entry points, where instanceof is not", async () => {
	const { AmountError, sats } = (await import("../sdk/dist/index.js")) as {
		AmountError: { is: (failure: unknown) => boolean };
		sats: (whole: number) => number;
	};
	const { minorUnitsOf } = (await import("../sdk/dist/price.js")) as {
		minorUnitsOf: (currency: string) => number;
	};

	const near = (() => {
		try {
			sats(0);
		} catch (refused: unknown) {
			return refused;
		}
	})();
	const far = (() => {
		try {
			minorUnitsOf("XYZ");
		} catch (refused: unknown) {
			return refused;
		}
	})();

	expect(near).toBeInstanceOf(Error);
	expect(far).toBeInstanceOf(Error);
	expect(AmountError.is(near)).toBe(true);
	expect(AmountError.is(far)).toBe(true);
	expect((near as { code: string }).code).toBe("not-whole-satoshi");
	expect((far as { code: string }).code).toBe("unknown-currency");
});

test("every problem type the readme tabulates is a static on ProblemError, so none is retyped", async () => {
	const { ProblemError } = await import("../sdk/dist/index.js");
	const statics = ProblemError as unknown as Record<string, unknown>;
	const readme = readFileSync("sdk/README.md", "utf8");
	const tabulated = [...readme.matchAll(/^\| `([a-z-]+)` \| \d/gm)].map((row) => row[1] as string);
	const carried = Object.getOwnPropertyNames(statics)
		.map((name) => statics[name])
		.filter((value): value is string => typeof value === "string");

	expect(tabulated).not.toHaveLength(0);
	for (const type of tabulated) {
		expect(carried, `${type} has no constant, so a caller would copy the urn`).toContain(
			`urn:problem-type:thunder-bridge:${type}`,
		);
	}
});
