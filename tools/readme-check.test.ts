import { expect, test } from "vitest";

import {
	driftIn,
	identifiersResolve,
	linksResolve,
	rendersOnNpm,
	typesBothWays,
	walletsWereMeasured,
} from "./readme-check.ts";

const GATEWAY = `
export const INVALID_REQUEST = "urn:problem-type:thunder-bridge:invalid-request";
export const TOO_MANY_PENDING = "urn:problem-type:thunder-bridge:too-many-pending";
`;

const SURVEY = JSON.stringify({
	surveyedAt: "2026-08-12",
	domains: { "blink.sv": {}, "coinos.io": {} },
});

function errorsSection(rows: string): string {
	return `## Errors\n\n| \`type\` | Status | What it is |\n|---|---|---|\n${rows}\n\n## Webhooks\n`;
}

function walletSection(rows: string): string {
	return `## Whose wallets this works with\n\n| Works | Address ends with |\n|---|---|\n${rows}\n\nlast surveyed 2026-08-12\n\n## Install\n`;
}

test("a type the gateway sends and the readme never names is drift", () => {
	const readme = errorsSection("| `invalid-request` | 400 | detail |");

	expect(typesBothWays(readme, GATEWAY)).toEqual([
		{
			check: "a problem type the gateway sends and the readme does not name",
			detail: "too-many-pending",
		},
	]);
});

test("a type the readme names and the gateway never sends is drift", () => {
	const readme = errorsSection(
		"| `invalid-request` | 400 | detail |\n| `too-many-pending` | 429 | over its share |\n| `invented-type` | 418 | nothing sends this |",
	);

	expect(typesBothWays(readme, GATEWAY)).toEqual([
		{
			check: "a problem type the readme names and the gateway does not send",
			detail: "invented-type",
		},
	]);
});

test("the table header is not read as a problem type", () => {
	const readme = errorsSection(
		"| `invalid-request` | 400 | detail |\n| `too-many-pending` | 429 | over its share |",
	);

	expect(typesBothWays(readme, GATEWAY)).toEqual([]);
});

test("a rail named in one table does not count as a problem type", () => {
	const readme = `${errorsSection("| \`invalid-request\` | 400 | detail |\n| \`too-many-pending\` | 429 | over its share |")}
| \`thunder-bridge\` | fetch | everything |`;

	expect(typesBothWays(readme, GATEWAY)).toEqual([]);
});

test("a backticked identifier the source never defines is drift", () => {
	const source = "export function invoiceFrom(): void {}";

	expect(identifiersResolve("call `invoiceFrom` and then `mintTheThing`", source)).toEqual([
		{
			check: "an identifier the readme backticks and the source does not define",
			detail: "mintTheThing",
		},
	]);
});

test("an identifier inside a fence is not held to that rule", () => {
	const readme = "```ts\nconst x = neverExported();\n```\n";

	expect(identifiersResolve(readme, "nothing")).toEqual([]);
});

test("a wallet the survey never measured is drift", () => {
	const readme = walletSection("| Blink | `@blink.sv` |\n| Wishful | `@wishful.example` |");

	expect(walletsWereMeasured(readme, SURVEY)).toEqual([
		{
			check: "a wallet the readme promises and the survey never measured",
			detail: "Wishful at wishful.example",
		},
	]);
});

test("a survey date the measurement does not carry is drift", () => {
	const readme = walletSection("| Blink | `@blink.sv` |").replace("2026-08-12", "2026-09-01");

	expect(walletsWereMeasured(readme, SURVEY)).toEqual([
		{
			check: "the readme states a survey date the measurement does not carry",
			detail: "readme says 2026-09-01, measured.json says 2026-08-12",
		},
	]);
});

test("an em dash and a github alert both fail, because npm renders neither the way github does", () => {
	expect(rendersOnNpm("a dash — here\n\n> [!WARNING]\n> careful\n")).toEqual([
		{ check: "an em or en dash, which the house style forbids", detail: "1 of them" },
		{ check: "a github alert, which npm renders as literal text", detail: "use bold instead" },
	]);
});

test("a link to a heading that moved is drift", () => {
	const drift = linksResolve("[gone](./README.md#no-such-heading)", "sdk/README.md");

	expect(drift).toEqual([
		{ check: "a link to a heading that is not there", detail: "./README.md#no-such-heading" },
	]);
});

test("the readme this repository ships has not drifted", () => {
	expect(driftIn(".")).toEqual([]);
});
