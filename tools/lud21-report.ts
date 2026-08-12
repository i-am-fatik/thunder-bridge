import { readFileSync } from "node:fs";
import { VERIFY_WITHOUT_PREIMAGE } from "../core/lnurl.ts";

type DomainRow = { verdict: string; denylisted: boolean; measured: { note: string }[] };
type Survey = { surveyedAt: string; addresses: number; domains: Record<string, DomainRow> };

const BUCKETS = ["usable", "no-verify", "verify-without-preimage", "unsettled"] as const;

function read(path: string): Survey | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Survey;
	} catch {
		return null;
	}
}

function namesIn(survey: Survey, verdict: string): string[] {
	return Object.entries(survey.domains)
		.filter(([, row]) => row.verdict === verdict)
		.map(([domain]) => domain)
		.sort();
}

function list(domains: string[]): string {
	return domains.length === 0 ? "_none_" : domains.map((one) => `\`${one}\``).join(", ");
}

const now = read(process.argv[2]);
if (now === null) {
	console.error(`${process.argv[2]} is not a survey`);
	process.exit(2);
}
const before = read(process.argv[3] ?? "");

const lines: string[] = [];
lines.push(`# LUD-21 coverage, measured ${now.surveyedAt}`);
lines.push("");
lines.push(
	`${now.addresses} addresses across ${Object.keys(now.domains).length} domains, sampled two per domain and up to six where two settled nothing.`,
);
lines.push("");
lines.push("| verdict | domains |");
lines.push("|---|---|");
for (const bucket of BUCKETS) {
	lines.push(`| ${bucket} | ${namesIn(now, bucket).length} |`);
}
lines.push("");

const denylistNowWrong = Object.entries(now.domains)
	.filter(([, row]) => row.denylisted && row.verdict === "usable")
	.map(([domain]) => domain);

const denylistStillRight = Object.entries(now.domains)
	.filter(([, row]) => row.denylisted && row.verdict === "verify-without-preimage")
	.map(([domain]) => domain);

const wasUsable = before === null ? [] : namesIn(before, "usable");
const isUsable = namesIn(now, "usable");
const stoppedBeingUsable = wasUsable.filter(
	(domain) => domain in now.domains && !isUsable.includes(domain),
);
const newlyUsable = isUsable.filter((domain) => before !== null && !wasUsable.includes(domain));

lines.push("## Against the last survey");
lines.push("");
if (before === null) {
	lines.push("No earlier survey to compare against, so everything here is a first measurement.");
} else {
	lines.push(`Last measured ${before.surveyedAt}.`);
	lines.push("");
	lines.push(`- newly usable: ${list(newlyUsable)}`);
	lines.push(`- stopped being usable: ${list(stoppedBeingUsable)}`);
	lines.push(
		`- gone from the sample: ${list(Object.keys(before.domains).filter((domain) => !(domain in now.domains)).sort())}`,
	);
}
lines.push("");
lines.push("## The denylist");
lines.push("");
const untested = VERIFY_WITHOUT_PREIMAGE.filter(
	(domain) => !denylistStillRight.includes(domain) && !denylistNowWrong.includes(domain),
);

lines.push(`- refused and confirmed to release no preimage: ${list(denylistStillRight)}`);
lines.push(`- refused but answering like LUD-21 now: ${list(denylistNowWrong)}`);
lines.push(`- refused and unrefuted, no address on it turned up: ${list(untested)}`);

console.log(lines.join("\n"));

const costsSomebody = denylistNowWrong.length > 0;
const claimWentStale = stoppedBeingUsable.length > 0;
if (costsSomebody || claimWentStale) {
	console.error("");
	if (costsSomebody) console.error(`the denylist now refuses ${denylistNowWrong.join(", ")}`);
	if (claimWentStale) {
		console.error(`the docs still promise ${stoppedBeingUsable.join(", ")}`);
	}
	process.exit(1);
}
