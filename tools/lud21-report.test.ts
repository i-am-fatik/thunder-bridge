import { expect, test } from "vitest";

import { type Survey, whatMoved } from "./lud21-report.ts";

function surveyed(verdicts: Record<string, string>, surveyedAt = "2026-08-12"): Survey {
	const domains = Object.fromEntries(
		Object.entries(verdicts).map(([domain, verdict]) => [
			domain,
			{
				verdict,
				denylisted: ["zeuspay.com", "zeusnuts.com", "ecash.love"].includes(domain),
				measured: [],
			},
		]),
	);
	return { surveyedAt, addresses: Object.keys(domains).length, domains };
}

test("a domain whose every sampled account was broken is unmeasured, not broken", () => {
	const moved = whatMoved(
		surveyed({ "coinos.pro": "unsettled" }),
		surveyed({ "coinos.pro": "usable" }, "2026-07-01"),
	);
	expect(moved.stoppedBeingUsable).toEqual([]);
	expect(moved.couldNotMeasure).toEqual(["coinos.pro"]);
});

test("a domain that now answers no verify at all is the alarm this exists for", () => {
	const moved = whatMoved(
		surveyed({ "was.good": "no-verify" }),
		surveyed({ "was.good": "usable" }, "2026-07-01"),
	);
	expect(moved.stoppedBeingUsable).toEqual(["was.good"]);
	expect(moved.couldNotMeasure).toEqual([]);
});

test("a domain that dropped its preimage is the same alarm", () => {
	const moved = whatMoved(
		surveyed({ "was.good": "verify-without-preimage" }),
		surveyed({ "was.good": "usable" }, "2026-07-01"),
	);
	expect(moved.stoppedBeingUsable).toEqual(["was.good"]);
});

test("a domain absent from this run is neither broken nor unmeasured", () => {
	const moved = whatMoved(
		surveyed({ "still.here": "usable" }),
		surveyed({ "still.here": "usable", "vanished.example": "usable" }, "2026-07-01"),
	);
	expect(moved.stoppedBeingUsable).toEqual([]);
	expect(moved.couldNotMeasure).toEqual([]);
	expect(moved.goneFromTheSample).toEqual(["vanished.example"]);
});

test("a denylisted domain answering like LUD-21 is refusing somebody for nothing", () => {
	const moved = whatMoved(surveyed({ "zeuspay.com": "usable" }), null);
	expect(moved.denylistNowWrong).toEqual(["zeuspay.com"]);
	expect(moved.denylistUnrefuted).toEqual(["zeusnuts.com", "ecash.love"]);
});

test("a denylisted domain still holding back its preimage keeps the entry honest", () => {
	const moved = whatMoved(surveyed({ "zeuspay.com": "verify-without-preimage" }), null);
	expect(moved.denylistStillRight).toEqual(["zeuspay.com"]);
	expect(moved.denylistNowWrong).toEqual([]);
	expect(moved.denylistUnrefuted).toEqual(["zeusnuts.com", "ecash.love"]);
});

test("every denylist entry no address turned up for stays unrefuted rather than confirmed", () => {
	const moved = whatMoved(surveyed({ "coinos.io": "usable" }), null);
	expect(moved.denylistStillRight).toEqual([]);
	expect(moved.denylistUnrefuted).toEqual(["zeuspay.com", "zeusnuts.com", "ecash.love"]);
});

test("a first survey claims nothing newly usable, having nothing to compare against", () => {
	const moved = whatMoved(surveyed({ "coinos.io": "usable" }), null);
	expect(moved.newlyUsable).toEqual([]);
	expect(moved.goneFromTheSample).toEqual([]);
});

test("a domain usable for the first time is named", () => {
	const moved = whatMoved(
		surveyed({ "fresh.example": "usable", "old.example": "usable" }),
		surveyed({ "old.example": "usable" }, "2026-07-01"),
	);
	expect(moved.newlyUsable).toEqual(["fresh.example"]);
});
