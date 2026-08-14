import { readFileSync } from "node:fs";
import { VERIFY_WITHOUT_PREIMAGE } from "../core/lnurl.ts";

export type DomainRow = { verdict: string; denylisted: boolean; measured: { note: string }[] };
export type Survey = {
	surveyedAt: string;
	addresses: number;
	domains: Record<string, DomainRow>;
};

export type Moved = {
	newlyUsable: string[];
	stoppedBeingUsable: string[];
	couldNotMeasure: string[];
	goneFromTheSample: string[];
	denylistStillRight: string[];
	denylistNowWrong: string[];
	denylistUnrefuted: string[];
};

const BUCKETS = ["usable", "no-verify", "verify-without-preimage", "unsettled"] as const;
const CONCLUSIVE = ["no-verify", "verify-without-preimage"];

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

function denylisted(survey: Survey, verdict: string): string[] {
	return Object.entries(survey.domains)
		.filter(([, row]) => row.denylisted && row.verdict === verdict)
		.map(([domain]) => domain)
		.sort();
}

export function whatMoved(now: Survey, before: Survey | null): Moved {
	const wasUsable = before === null ? [] : namesIn(before, "usable");
	const isUsable = namesIn(now, "usable");
	const lost = wasUsable.filter((domain) => domain in now.domains && !isUsable.includes(domain));
	const denylistStillRight = denylisted(now, "verify-without-preimage");
	const denylistNowWrong = denylisted(now, "usable");

	return {
		newlyUsable: isUsable.filter((domain) => before !== null && !wasUsable.includes(domain)),
		stoppedBeingUsable: lost.filter((domain) =>
			CONCLUSIVE.includes(now.domains[domain]?.verdict ?? ""),
		),
		couldNotMeasure: lost.filter(
			(domain) => !CONCLUSIVE.includes(now.domains[domain]?.verdict ?? ""),
		),
		goneFromTheSample:
			before === null
				? []
				: Object.keys(before.domains)
						.filter((domain) => !(domain in now.domains))
						.sort(),
		denylistStillRight,
		denylistNowWrong,
		denylistUnrefuted: VERIFY_WITHOUT_PREIMAGE.filter(
			(domain) => !denylistStillRight.includes(domain) && !denylistNowWrong.includes(domain),
		),
	};
}

function list(domains: string[]): string {
	return domains.length === 0 ? "_none_" : domains.map((one) => `\`${one}\``).join(", ");
}

export function render(now: Survey, before: Survey | null, moved: Moved): string {
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
	lines.push("## Against the last survey");
	lines.push("");
	if (before === null) {
		lines.push("No earlier survey to compare against, so everything here is a first measurement.");
	} else {
		lines.push(`Last measured ${before.surveyedAt}.`);
		lines.push("");
		lines.push(`- newly usable: ${list(moved.newlyUsable)}`);
		lines.push(`- stopped being usable: ${list(moved.stoppedBeingUsable)}`);
		lines.push(
			`- was usable and this run could not tell, every address sampled was broken: ${list(moved.couldNotMeasure)}`,
		);
		lines.push(`- gone from the sample: ${list(moved.goneFromTheSample)}`);
	}
	lines.push("");
	lines.push("## The denylist");
	lines.push("");
	lines.push(`- refused and confirmed to release no preimage: ${list(moved.denylistStillRight)}`);
	lines.push(`- refused but answering like LUD-21 now: ${list(moved.denylistNowWrong)}`);
	lines.push(
		`- refused and unrefuted, no address on it turned up: ${list(moved.denylistUnrefuted)}`,
	);

	return lines.join("\n");
}

if (import.meta.main) {
	const now = read(process.argv[2]);
	if (now === null) {
		console.error(`${process.argv[2]} is not a survey`);
		process.exit(2);
	}
	const before = read(process.argv[3] ?? "");
	const moved = whatMoved(now, before);
	console.log(render(now, before, moved));

	if (moved.denylistNowWrong.length > 0 || moved.stoppedBeingUsable.length > 0) {
		console.error("");
		if (moved.denylistNowWrong.length > 0) {
			console.error(`the denylist now refuses ${moved.denylistNowWrong.join(", ")}`);
		}
		if (moved.stoppedBeingUsable.length > 0) {
			console.error(`the docs still promise ${moved.stoppedBeingUsable.join(", ")}`);
		}
		process.exit(1);
	}
}
