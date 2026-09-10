import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

import { DOORS, referenceOf, undocumentedIn } from "./api-reference.ts";

const { reference, missing } = referenceOf(".");

test("every door the package publishes is in the reference", () => {
	for (const door of DOORS) {
		expect(reference).toContain(`## \`${door.specifier}\``);
	}
});

test("the reference the repository ships is what the code says", () => {
	expect(reference).toBe(readFileSync("docs/api.md", "utf8"));
});

test("every export carries the TSDoc the reference is made of", () => {
	expect(missing).toEqual([]);
});

test("the client's own methods are listed, because that is where the surface lives now", () => {
	for (const member of [
		"requestPayment(asked: PaymentRequestInit)",
		"mint(charge: Charge",
		"settled(id: string",
	]) {
		expect(reference).toContain(member);
	}
});

test("an export with no doc comment is named rather than silently emitted empty", () => {
	const undocumented = undocumentedIn(
		new Map([
			[
				"thunder-bridge",
				[
					{
						name: "Charge",
						kind: "interface",
						summary: "",
						documentation: "",
						signature: "interface Charge",
						members: [],
					},
				],
			],
		]),
	);

	expect(undocumented).toEqual([{ door: "thunder-bridge", name: "Charge" }]);
});

test("every table row holds the columns its table has, whatever the signature contains", () => {
	for (const row of reference.split("\n").filter((line) => line.startsWith("| "))) {
		expect(row.replace(/\\\|/g, "").split("|").length).toBeGreaterThanOrEqual(4);
		expect(row.replace(/\\\|/g, "").split("|").length).toBeLessThanOrEqual(5);
	}
});

const sought = [...reference.matchAll(/\]\(#([^)]+)\)/g)].map((found) => found[1] as string);
const anchored = [...reference.matchAll(/<a id="([^"]+)"><\/a>/g)].map(
	(found) => found[1] as string,
);

test("every export the table links to has an anchor to land on, because a heading alone slugs to the bare name", () => {
	expect(sought).not.toHaveLength(0);
	expect(sought.filter((anchor) => !anchored.includes(anchor))).toEqual([]);
});

test("an anchor is unique and already lowercase, because github lowercases the id it renders", () => {
	expect(anchored).toEqual([...new Set(anchored)]);
	expect(anchored).toEqual(anchored.map((anchor) => anchor.toLowerCase()));
});

test("a name the prose backticks is a link when the door exports it, so nobody goes searching", () => {
	const plain: string[] = [];
	for (const section of reference.split("\n## `").slice(1)) {
		const names = [...section.matchAll(/^### <a id="[^"]+"><\/a>(\S+)$/gm)].map(
			(found) => found[1] as string,
		);
		const prose = section
			.replace(/```[\s\S]*?```/g, "")
			.replace(/^\|.*$/gm, "")
			.replace(/\[`[^`]+`\]\(#[^)]+\)/g, "");
		plain.push(...names.filter((name) => prose.includes(`\`${name}\``)));
	}

	expect(plain).toEqual([]);
});

test("an interface whose base is not published shows the base's fields rather than its name", () => {
	expect(reference).toContain("interface MintedPayment {");
	expect(reference).not.toContain("extends Reported");
	for (const inherited of ["\tid: string;", "\tsealed: string | null;"]) {
		expect(reference).toContain(inherited);
	}
});

test("an interface whose base is published keeps the extends, because the reader can follow it", () => {
	expect(reference).toContain("interface GatewaysOptions extends ThunderBridgeOptions");
});
