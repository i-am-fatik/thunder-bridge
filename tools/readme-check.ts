import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Drift = { check: string; detail: string };

const TICKED = /`([A-Za-z_][A-Za-z0-9_.]*)`/g;
const PROBLEM_TYPE = /urn:problem-type:thunder-bridge:([a-z-]+)/g;
const TABLE_TYPE = /^\| `([a-z-]+)` \| \d/gm;
const HEADING = /^#{1,4} (.+)$/gm;
const LINK = /\[[^\]]*\]\(([^)]+)\)/g;
const FENCE = /```[a-z]*\n[\s\S]*?```/g;
const WALLET_ROW = /^\| ([A-Za-z][^|]*?) \| (`@[^|]+`) \|$/gm;

function everyMatch(text: string, pattern: RegExp, group = 1): string[] {
	return [...text.matchAll(pattern)].map((hit) => hit[group] as string);
}

function anchorOf(heading: string): string {
	return heading
		.toLowerCase()
		.replace(/[^a-z0-9 -]/g, "")
		.replace(/ /g, "-");
}

function sourceOf(root: string): string {
	const dirs = ["sdk/src", "core", "src"];
	const files = dirs.flatMap((dir) =>
		readdirSync(resolve(root, dir))
			.filter((name) => name.endsWith(".ts"))
			.map((name) => resolve(root, dir, name)),
	);

	return files.map((file) => readFileSync(file, "utf8")).join("\n");
}

function sectionOf(readme: string, heading: string): string {
	const opens = readme.indexOf(`## ${heading}\n`);
	if (opens === -1) {
		return "";
	}
	const rest = readme.slice(opens + heading.length);
	const closes = rest.indexOf("\n## ");

	return closes === -1 ? rest : rest.slice(0, closes);
}

export function typesBothWays(readme: string, gateway: string): Drift[] {
	const declared = new Set(everyMatch(gateway, PROBLEM_TYPE));
	const documented = new Set(everyMatch(sectionOf(readme, "Errors"), TABLE_TYPE));

	return [
		...[...declared]
			.filter((type) => !documented.has(type))
			.map((type) => ({
				check: "a problem type the gateway sends and the readme does not name",
				detail: type,
			})),
		...[...documented]
			.filter((type) => !declared.has(type))
			.map((type) => ({
				check: "a problem type the readme names and the gateway does not send",
				detail: type,
			})),
	];
}

export function identifiersResolve(readme: string, source: string): Drift[] {
	const prose = readme.replace(FENCE, "");

	return [...new Set(everyMatch(prose, TICKED))]
		.filter((name) => !name.includes("."))
		.filter((name) => !new RegExp(`\\b${name}\\b`).test(source))
		.map((name) => ({
			check: "an identifier the readme backticks and the source does not define",
			detail: name,
		}));
}

export function walletsWereMeasured(readme: string, survey: string): Drift[] {
	const measured = JSON.parse(survey) as { surveyedAt: string; domains: Record<string, unknown> };
	const domains = Object.keys(measured.domains);
	const stated = readme.match(/last surveyed (\d{4}-\d{2}-\d{2})/);

	const drift: Drift[] = [];
	if (stated?.[1] !== measured.surveyedAt) {
		drift.push({
			check: "the readme states a survey date the measurement does not carry",
			detail: `readme says ${stated?.[1] ?? "nothing"}, measured.json says ${measured.surveyedAt}`,
		});
	}

	for (const addresses of sectionOf(readme, "Whose wallets this works with").matchAll(WALLET_ROW)) {
		for (const ends of everyMatch(addresses[2] as string, /@([a-z0-9.-]+)/g)) {
			if (!domains.includes(ends)) {
				drift.push({
					check: "a wallet the readme promises and the survey never measured",
					detail: `${(addresses[1] as string).trim()} at ${ends}`,
				});
			}
		}
	}

	return drift;
}

export function rendersOnNpm(readme: string): Drift[] {
	const drift: Drift[] = [];
	const dashes = readme.match(/[—–]/g);
	if (dashes) {
		drift.push({
			check: "an em or en dash, which the house style forbids",
			detail: `${dashes.length} of them`,
		});
	}
	if (/^> \[!/m.test(readme)) {
		drift.push({
			check: "a github alert, which npm renders as literal text",
			detail: "use bold instead",
		});
	}

	return drift;
}

export function linksResolve(readme: string, readmePath: string): Drift[] {
	const drift: Drift[] = [];

	for (const target of everyMatch(readme, LINK)) {
		if (target.startsWith("http") || target.startsWith("mailto")) {
			continue;
		}

		const [path, anchor] = target.split("#");
		const file = path ? resolve(dirname(readmePath), path) : readmePath;
		if (!existsSync(file)) {
			drift.push({ check: "a link to a file that is not there", detail: target });
			continue;
		}
		if (anchor && !everyMatch(readFileSync(file, "utf8"), HEADING).map(anchorOf).includes(anchor)) {
			drift.push({ check: "a link to a heading that is not there", detail: target });
		}
	}

	return drift;
}

export function fencesIn(readme: string): string[] {
	return [...readme.matchAll(/\n```ts\n([\s\S]*?)\n```\n/g)].map((hit) => hit[1] as string);
}

export function driftIn(root: string): Drift[] {
	const readmePath = resolve(root, "sdk/README.md");
	const readme = readFileSync(readmePath, "utf8");

	return [
		...typesBothWays(readme, readFileSync(resolve(root, "src/problem.ts"), "utf8")),
		...identifiersResolve(readme, sourceOf(root)),
		...walletsWereMeasured(readme, readFileSync(resolve(root, "docs/lud21-measured.json"), "utf8")),
		...rendersOnNpm(readme),
		...linksResolve(readme, readmePath),
	];
}

if (process.argv[1]?.endsWith("readme-check.ts")) {
	const root = process.argv[2] ?? ".";
	const into = process.argv[3] === "--fences" ? process.argv[4] : null;

	if (into !== undefined && into !== null) {
		const fences = fencesIn(readFileSync(resolve(root, "sdk/README.md"), "utf8"));
		mkdirSync(resolve(into, "src"), { recursive: true });
		fences.forEach((fence, index) => {
			writeFileSync(resolve(into, "src", `fence${index}.ts`), `${fence}\n`);
		});
		console.log(`${fences.length} fences written to ${into}/src`);
	}

	const drift = driftIn(root);
	for (const { check, detail } of drift) {
		console.log(`${check}: ${detail}`);
	}
	console.log(drift.length === 0 ? "the readme still matches the code" : `${drift.length} drifted`);
	process.exitCode = drift.length === 0 ? 0 : 1;
}
