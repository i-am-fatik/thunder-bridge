import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

export interface Door {
	specifier: string;
	entry: string;
}

export interface Undocumented {
	door: string;
	name: string;
}

export const DOORS: Door[] = [
	{ specifier: "thunder-bridge", entry: "sdk/src/index.ts" },
	{ specifier: "thunder-bridge/qr", entry: "sdk/src/entry/qr.ts" },
	{ specifier: "thunder-bridge/price", entry: "sdk/src/entry/price.ts" },
	{ specifier: "thunder-bridge/bank", entry: "sdk/src/entry/bank.ts" },
	{ specifier: "thunder-bridge/nwc", entry: "sdk/src/entry/nwc.ts" },
];

const KINDS: [ts.SymbolFlags, string][] = [
	[ts.SymbolFlags.Class, "class"],
	[ts.SymbolFlags.Function, "function"],
	[ts.SymbolFlags.Interface, "interface"],
	[ts.SymbolFlags.TypeAlias, "type"],
	[ts.SymbolFlags.Variable, "const"],
];

export interface Item {
	name: string;
	kind: string;
	summary: string;
	documentation: string;
	signature: string;
	members: Item[];
}

function programOf(root: string): ts.Program {
	const entries = DOORS.map((door) => resolve(root, door.entry));

	return ts.createProgram(entries, {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		strict: true,
		allowImportingTsExtensions: true,
		noEmit: true,
		skipLibCheck: true,
		lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
	});
}

function kindOf(symbol: ts.Symbol): string {
	const resolved = symbol.flags & ts.SymbolFlags.Alias ? symbol : symbol;
	for (const [flag, name] of KINDS) {
		if (resolved.flags & flag) {
			return name;
		}
	}

	return "export";
}

function documentationOf(symbol: ts.Symbol, checker: ts.TypeChecker): string {
	return ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
}

function summaryOf(documentation: string): string {
	const stop = documentation.search(/\.(\s|$)|\n\n/);
	const first = stop === -1 ? documentation : documentation.slice(0, stop);

	return first.replace(/\s+/g, " ").trim();
}

function inheritsUnexported(declaration: ts.Declaration, exported: Set<string>): boolean {
	if (!ts.isInterfaceDeclaration(declaration)) {
		return false;
	}

	return (declaration.heritageClauses ?? []).some((clause) =>
		clause.types.some((base) => !exported.has(base.expression.getText())),
	);
}

function flattened(declaration: ts.InterfaceDeclaration, checker: ts.TypeChecker): string {
	const type = checker.getTypeAtLocation(declaration);
	const fields = checker.getPropertiesOfType(type).map((property) => {
		const optional = property.flags & ts.SymbolFlags.Optional ? "?" : "";
		const held = checker.getTypeOfSymbolAtLocation(property, declaration);

		return `\t${property.getName()}${optional}: ${checker.typeToString(held)};`;
	});

	return [`interface ${declaration.name.getText()} {`, ...fields, "}"].join("\n");
}

function endOfSignature(declaration: ts.Declaration): number {
	if (ts.isClassDeclaration(declaration)) {
		return declaration.members.pos;
	}
	const body = (declaration as { body?: ts.Node }).body;

	return body === undefined ? declaration.getEnd() : body.getStart();
}

function signatureOf(
	declaration: ts.Declaration,
	checker: ts.TypeChecker,
	exported: Set<string>,
): string {
	if (ts.isInterfaceDeclaration(declaration) && inheritsUnexported(declaration, exported)) {
		return flattened(declaration, checker);
	}
	const source = declaration.getSourceFile().text;
	const declared = source.slice(declaration.getStart(), endOfSignature(declaration)).trim();

	return declared
		.replace(/^export\s+/, "")
		.replace(/^declare\s+/, "")
		.replace(/\s*\{$/, "")
		.trim();
}

function membersOf(symbol: ts.Symbol, checker: ts.TypeChecker, exported: Set<string>): Item[] {
	const declaration = symbol.declarations?.[0];
	if (declaration === undefined || !ts.isClassDeclaration(declaration)) {
		return [];
	}

	const items: Item[] = [];
	for (const member of declaration.members) {
		if (
			!ts.isMethodDeclaration(member) &&
			!ts.isGetAccessor(member) &&
			!ts.isPropertyDeclaration(member)
		) {
			continue;
		}
		const modifiers = ts.getCombinedModifierFlags(member);
		if (modifiers & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) {
			continue;
		}
		const name = member.name?.getText();
		if (name === undefined || name.startsWith("#")) {
			continue;
		}
		const own = checker.getSymbolAtLocation(member.name);
		const documentation = own === undefined ? "" : documentationOf(own, checker);
		items.push({
			name,
			kind: ts.isGetAccessor(member)
				? "getter"
				: ts.isPropertyDeclaration(member)
					? "property"
					: "method",
			summary: summaryOf(documentation),
			documentation,
			signature: signatureOf(member, checker, exported),
			members: [],
		});
	}

	return items;
}

export function itemsOf(root: string, door: Door, program: ts.Program): Item[] {
	const checker = program.getTypeChecker();
	const entry = program.getSourceFile(resolve(root, door.entry));
	if (entry === undefined) {
		throw new Error(`${door.entry} is not in the program`);
	}
	const moduleSymbol = checker.getSymbolAtLocation(entry);
	if (moduleSymbol === undefined) {
		throw new Error(`${door.entry} exports nothing`);
	}

	const surface = checker.getExportsOfModule(moduleSymbol);
	const named = new Set(surface.map((one) => one.getName()));

	const items: Item[] = [];
	for (const exported of surface) {
		const symbol =
			exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
		const declaration = symbol.declarations?.[0];
		if (declaration === undefined) {
			continue;
		}
		const documentation = documentationOf(symbol, checker);
		items.push({
			name: exported.getName(),
			kind: kindOf(symbol),
			summary: summaryOf(documentation),
			documentation,
			signature: signatureOf(declaration, checker, named),
			members: membersOf(symbol, checker, named),
		});
	}

	return items.sort((one, other) => one.name.localeCompare(other.name));
}

export function undocumentedIn(doors: Map<string, Item[]>): Undocumented[] {
	const missing: Undocumented[] = [];
	for (const [door, items] of doors) {
		for (const item of items) {
			if (item.documentation === "") {
				missing.push({ door, name: item.name });
			}
			for (const member of item.members) {
				if (member.documentation === "" && member.kind === "method") {
					missing.push({ door, name: `${item.name}.${member.name}` });
				}
			}
		}
	}

	return missing;
}

function celled(text: string): string {
	return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function anchorOf(door: string, name: string): string {
	return `${door.replace(/[^a-z]+/g, "-")}-${name.toLowerCase()}`;
}

export function referenceFrom(doors: Map<string, Item[]>): string {
	const lines: string[] = [
		"# The whole surface",
		"",
		"Generated from the TSDoc on each export by [`tools/api-reference.ts`](../tools/api-reference.ts).",
		"Nothing here is written by hand, so nothing here can be out of date. Run",
		"`node tools/api-reference.ts` after changing an export, and CI refuses a diff.",
		"",
	];

	for (const [door, items] of doors) {
		lines.push(`## \`${door}\``, "");
		lines.push("| Export | Kind | What it is |", "|---|---|---|");
		for (const item of items) {
			lines.push(
				`| [\`${item.name}\`](#${anchorOf(door, item.name)}) | ${item.kind} | ${celled(item.summary)} |`,
			);
		}
		lines.push("");

		for (const item of items) {
			lines.push(`### ${item.name}`, "", "```ts", item.signature, "```", "");
			if (item.documentation !== "") {
				lines.push(item.documentation, "");
			}
			if (item.members.length > 0) {
				lines.push("| Member | What it does |", "|---|---|");
				for (const member of item.members) {
					lines.push(`| \`${celled(member.signature)}\` | ${celled(member.summary)} |`);
				}
				lines.push("");
			}
		}
	}

	return `${lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()}\n`;
}

/** What every door exports, as the compiler sees it, keyed by import specifier */
export function surfaceOf(root: string): Map<string, Item[]> {
	const program = programOf(root);
	const doors = new Map<string, Item[]>();
	for (const door of DOORS) {
		doors.set(door.specifier, itemsOf(root, door, program));
	}

	return doors;
}

export function referenceOf(root: string): { reference: string; missing: Undocumented[] } {
	const doors = surfaceOf(root);

	return { reference: referenceFrom(doors), missing: undocumentedIn(doors) };
}

if (process.argv[1]?.endsWith("api-reference.ts")) {
	const root = process.argv[2] === "--check" ? (process.argv[3] ?? ".") : (process.argv[2] ?? ".");
	const checking = process.argv.includes("--check");
	const into = resolve(root, "docs/api.md");
	const { reference, missing } = referenceOf(root);

	for (const { door, name } of missing) {
		console.log(`${door} exports ${name} with no TSDoc, and the reference is the TSDoc`);
	}

	if (!checking) {
		writeFileSync(into, reference);
		console.log(`${relative(root, into)} written`);
	} else if (readFileSync(into, "utf8") !== reference) {
		console.log(
			`${relative(root, into)} is not what the code says, run node tools/api-reference.ts`,
		);
		process.exitCode = 1;
	} else {
		console.log("the reference still matches the code");
	}

	if (missing.length > 0) {
		process.exitCode = 1;
	}
}
