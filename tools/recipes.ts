import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

import { anchorOf, memberAnchorOf, surfaceOf } from "./api-reference.ts";

export interface Call {
	name: string;
	line: number;
	anchor: string;
}

export interface Stated {
	title: string;
	intent: string;
	rail: string;
	shows: string[];
}

export interface Recipe extends Stated {
	slug: string;
	source: string;
	calls: Call[];
}

const OURS = ["sdk/src", "core"];

export function anchorsIn(root: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const [door, items] of surfaceOf(root)) {
		for (const item of items) {
			if (!found.has(item.name)) {
				found.set(item.name, anchorOf(door, item));
			}
			for (const member of item.members) {
				const key = `${item.name}.${member.name}`;
				if (!found.has(key)) {
					found.set(key, memberAnchorOf(door, item, member));
				}
			}
		}
	}

	return found;
}

function programOf(root: string, entries: string[]): ts.Program {
	return ts.createProgram(entries, {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		strict: true,
		allowImportingTsExtensions: true,
		noEmit: true,
		skipLibCheck: true,
		lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
		baseUrl: root,
		paths: {
			"thunder-bridge": ["sdk/src/index.ts"],
			"thunder-bridge/*": ["sdk/src/entry/*.ts"],
		},
	});
}

function calledName(root: string, node: ts.Identifier, checker: ts.TypeChecker): string | null {
	const symbol = checker.getSymbolAtLocation(node);
	if (symbol === undefined) {
		return null;
	}
	const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
	const declaration = resolved.declarations?.[0];
	if (declaration === undefined) {
		return null;
	}
	const from = relative(root, declaration.getSourceFile().fileName);
	if (!OURS.some((area) => from.startsWith(`${area}/`))) {
		return null;
	}
	const owner = declaration.parent;
	const holding =
		ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner)
			? owner.name?.getText()
			: undefined;

	return holding === undefined ? resolved.getName() : `${holding}.${resolved.getName()}`;
}

function anchorFor(name: string, anchored: Map<string, string>): string | undefined {
	return anchored.get(name) ?? anchored.get(name.split(".")[0] as string);
}

export function callsIn(
	root: string,
	source: ts.SourceFile,
	checker: ts.TypeChecker,
	anchored: Map<string, string>,
): Call[] {
	const calls: Call[] = [];
	const already = new Set<string>();

	const walk = (node: ts.Node): void => {
		if (ts.isIdentifier(node)) {
			const name = calledName(root, node, checker);
			const anchor = name === null ? undefined : anchorFor(name, anchored);
			if (name !== null && anchor !== undefined) {
				const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
				if (!already.has(`${name}:${line}`)) {
					already.add(`${name}:${line}`);
					calls.push({ name, line, anchor });
				}
			}
		}
		ts.forEachChild(node, walk);
	};
	walk(source);

	return calls.sort((one, other) => one.line - other.line || one.name.localeCompare(other.name));
}

export function slugsIn(root: string): string[] {
	return readdirSync(resolve(root, "examples"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

export function recipesIn(root: string): { recipes: Recipe[]; refused: string[] } {
	const slugs = slugsIn(root);
	const entries = slugs.map((slug) => resolve(root, "examples", slug, "main.ts"));
	const program = programOf(root, entries);
	const checker = program.getTypeChecker();
	const anchored = anchorsIn(root);

	const recipes: Recipe[] = [];
	const refused: string[] = [];
	for (const [index, slug] of slugs.entries()) {
		const path = entries[index] as string;
		const source = program.getSourceFile(path);
		if (source === undefined) {
			throw new Error(`examples/${slug}/main.ts is not in the program`);
		}
		for (const complaint of program.getSemanticDiagnostics(source)) {
			refused.push(
				`examples/${slug}/main.ts: ${ts.flattenDiagnosticMessageText(complaint.messageText, " ")}`,
			);
		}
		const stated = JSON.parse(
			readFileSync(resolve(root, "examples", slug, "recipe.json"), "utf8"),
		) as Stated;
		recipes.push({
			slug,
			...stated,
			source: source.text,
			calls: callsIn(root, source, checker, anchored),
		});
	}

	return { recipes, refused };
}

export function manifestFrom(recipes: Recipe[]): string {
	return `${JSON.stringify({ reference: "api.md", recipes }, null, "\t")}\n`;
}

function escaped(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function linkedSource(recipe: Recipe): string {
	const online = new Map<number, Call[]>();
	for (const call of recipe.calls) {
		online.set(call.line, [...(online.get(call.line) ?? []), call]);
	}

	return recipe.source
		.replace(/\n$/, "")
		.split("\n")
		.map((line, index) => {
			let marked = escaped(line);
			for (const call of online.get(index + 1) ?? []) {
				const bare = (call.name.split(".").at(-1) as string).replace(/\$/g, "\\$");
				marked = marked.replace(
					new RegExp(`(?<![\\w$>])${bare}(?![\\w$])`),
					`<a href="api.md#${call.anchor}">${bare}</a>`,
				);
			}

			return marked;
		})
		.join("\n");
}

export function pageFrom(recipes: Recipe[]): string {
	const lines: string[] = [
		"# Every use case, as one program you can run",
		"",
		"Generated from `examples/` by [`tools/recipes.ts`](../tools/recipes.ts). Every name in a",
		"recipe below was found by the TypeScript compiler and links to its own entry in",
		"[the reference](api.md), so no link here is written or kept by hand. Run",
		"`node tools/recipes.ts` after changing a recipe, and CI refuses a diff.",
		"",
		"| Recipe | Rail | What it is for |",
		"|---|---|---|",
	];
	for (const recipe of recipes) {
		lines.push(`| [${recipe.title}](#${recipe.slug}) | \`${recipe.rail}\` | ${recipe.intent} |`);
	}
	lines.push("");

	for (const recipe of recipes) {
		lines.push(
			`## <a id="${recipe.slug}"></a>${recipe.title}`,
			"",
			`${recipe.intent}. It lives in \`examples/${recipe.slug}/main.ts\`, and what it claims is asserted in \`examples/${recipe.slug}/main.test.ts\`.`,
			"",
			`<pre><code>${linkedSource(recipe)}</code></pre>`,
			"",
		);
		for (const one of recipe.shows) {
			lines.push(`- ${one}`);
		}
		lines.push("");
	}

	return `${lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()}\n`;
}

export function uncoveredIn(root: string, recipes: Recipe[]): string[] {
	const exercised = new Set(recipes.flatMap((recipe) => recipe.calls.map((call) => call.anchor)));

	return [...anchorsIn(root).entries()]
		.filter(([, anchor]) => !exercised.has(anchor))
		.map(([name]) => name)
		.sort();
}

if (process.argv[1]?.endsWith("recipes.ts")) {
	const root = process.argv[2] === "--check" ? (process.argv[3] ?? ".") : (process.argv[2] ?? ".");
	const checking = process.argv.includes("--check");
	const { recipes, refused } = recipesIn(root);
	const wanted = [
		{ at: "docs/recipes.json", body: manifestFrom(recipes) },
		{ at: "docs/recipes.md", body: pageFrom(recipes) },
	];

	for (const complaint of refused) {
		console.log(complaint);
	}

	for (const { at, body } of wanted) {
		const into = resolve(root, at);
		if (!checking) {
			writeFileSync(into, body);
			console.log(`${at} written`);
		} else if (readFileSync(into, "utf8") !== body) {
			console.log(`${at} is not what the recipes say, run node tools/recipes.ts`);
			process.exitCode = 1;
		} else {
			console.log(`${at} still matches the recipes`);
		}
	}

	for (const recipe of recipes) {
		const distinct = [...new Set(recipe.calls.map((call) => call.name))].sort();
		console.log(`${recipe.slug} reaches ${distinct.join(", ")}`);
	}
	console.log(`${uncoveredIn(root, recipes).length} documented names no recipe reaches`);

	if (refused.length > 0) {
		process.exitCode = 1;
	}
}
