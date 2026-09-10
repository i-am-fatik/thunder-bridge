import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

import { manifestFrom, pageFrom, recipesIn, slugsIn, uncoveredIn } from "./recipes.ts";

const { recipes, refused } = recipesIn(".");
const reference = readFileSync("docs/api.md", "utf8");
const anchored = new Set(
	[...reference.matchAll(/<a id="([^"]+)"><\/a>/g)].map((found) => found[1] as string),
);

test("every recipe still compiles against the surface it demonstrates", () => {
	expect(refused).toEqual([]);
});

test("the manifest the repository ships is what the recipes say", () => {
	expect(manifestFrom(recipes)).toBe(readFileSync("docs/recipes.json", "utf8"));
});

test("the page the repository ships is what the recipes say", () => {
	expect(pageFrom(recipes)).toBe(readFileSync("docs/recipes.md", "utf8"));
});

test("every link the page draws into the reference is an anchor the reference emits", () => {
	const page = readFileSync("docs/recipes.md", "utf8");
	const drawn = [...page.matchAll(/api\.md#([^"]+)"/g)].map((found) => found[1] as string);

	expect(drawn).not.toHaveLength(0);
	expect(drawn.filter((anchor) => !anchored.has(anchor))).toEqual([]);
});

test("the page anchors every recipe under its own slug, so the index can reach it", () => {
	const page = readFileSync("docs/recipes.md", "utf8");
	for (const recipe of recipes) {
		expect(page).toContain(`## <a id="${recipe.slug}"></a>${recipe.title}`);
		expect(page).toContain(`[${recipe.title}](#${recipe.slug})`);
	}
});

test("every directory under examples is a declared recipe, so none is half stated", () => {
	expect(recipes.map((recipe) => recipe.slug)).toEqual(slugsIn("."));
	for (const recipe of recipes) {
		expect(recipe.title, `${recipe.slug} states no title`).not.toBe("");
		expect(recipe.intent, `${recipe.slug} states no intent`).not.toBe("");
		expect(recipe.shows.length, `${recipe.slug} shows nothing`).toBeGreaterThan(0);
	}
});

test("every anchor a recipe points at is one the reference emits, so no link is dead", () => {
	const owed = recipes.flatMap((recipe) =>
		recipe.calls.filter((call) => !anchored.has(call.anchor)),
	);

	expect(owed).toEqual([]);
});

test("a call is recorded on the line that makes it, so the source can be hyperlinked", () => {
	for (const recipe of recipes) {
		const lines = recipe.source.split("\n");
		for (const call of recipe.calls) {
			const bare = call.name.split(".").at(-1) as string;
			expect(lines[call.line - 1], `${recipe.slug} puts ${call.name} on ${call.line}`).toContain(
				bare,
			);
		}
	}
});

test("a name a recipe reaches is not also counted as uncovered", () => {
	const uncovered = uncoveredIn(".", recipes);

	expect(uncovered).not.toContain("sats");
	expect(uncovered).not.toContain("ThunderBridge");
	expect(uncovered).toEqual([...uncovered].sort());
});

test("the tip jar reaches the front door and both answers to did it arrive", () => {
	const reached = new Set(
		recipes.find((recipe) => recipe.slug === "tip-jar")?.calls.map((call) => call.name),
	);

	for (const name of [
		"sats",
		"ThunderBridge",
		"ThunderBridge.requestPayment",
		"PaymentRequest.paid",
		"PaymentRequest.prove",
	]) {
		expect(reached, `the tip jar should reach ${name}`).toContain(name);
	}
});
