import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { type Call, type Recipe, recipesIn } from "./recipes.ts";

export interface Editable {
	key: string;
	kind: "url" | "address" | "number" | "decimal" | "currency";
	finds: RegExp;
}

export interface Runnable {
	slug: string;
	call: string;
	action: string;
	steps: [string, string | RegExp | null][];
	editable: Editable[];
}

const GATEWAY = /(?<=")https:\/\/[^"]+(?=";)/;

export const RUNNABLE: Runnable[] = [
	{
		slug: "tip-jar",
		call: "tipJar",
		action: "Mint a real invoice",
		steps: [
			["mint", "ThunderBridge.requestPayment"],
			["qr", "PaymentRequest.qr"],
			["wait", "PaymentRequest.paid"],
			["prove", "PaymentRequest.prove"],
		],
		editable: [
			{ key: "gateway", kind: "url", finds: GATEWAY },
			{ key: "paidTo", kind: "address", finds: /(?<=")[^"]+@[^"]+(?=")/ },
			{ key: "sats", kind: "number", finds: /(?<=\()\d+(?=\))/ },
		],
	},
	{
		slug: "fiat-checkout",
		call: "checkout",
		action: "Mint a real invoice",
		steps: [
			["mint", "ThunderBridge.requestPayment"],
			["qr", "PaymentRequest.qr"],
			["wait", "PaymentRequest.paid"],
			["prove", "PaymentRequest.prove"],
		],
		editable: [
			{ key: "gateway", kind: "url", finds: GATEWAY },
			{ key: "paidTo", kind: "address", finds: /(?<=")[^"]+@[^"]+(?=")/ },
			{ key: "price", kind: "decimal", finds: /(?<=\(")\d+(?:\.\d+)?(?=", ")/ },
			{ key: "currency", kind: "currency", finds: /(?<=")[A-Z]{3}(?=", \{)/ },
			{ key: "maxSpreadBps", kind: "number", finds: /(?<=maxSpreadBps: )\d+/ },
			{ key: "spreadBps", kind: "number", finds: /(?<=spreadBps: )\d+/ },
		],
	},
	{
		slug: "pay-me",
		call: "payMe",
		action: "Ask it the way a wallet would",
		steps: [
			["ask", /lnurlPay\(/],
			["callback", /least:/],
			["invoice", null],
		],
		editable: [
			{ key: "gateway", kind: "url", finds: GATEWAY },
			{ key: "paidTo", kind: "address", finds: /(?<=")[^"]+@[^"]+(?=")/ },
			{ key: "least", kind: "number", finds: /(?<=least: (?:<a[^>]*>)?sats(?:<\/a>)?\()\d+(?=\))/ },
			{
				key: "most",
				kind: "number",
				finds: /(?<=most: (?:<a[^>]*>)?sats(?:<\/a>)?\()[\d_]+(?=\))/,
			},
		],
	},
];

const WHAT: Record<string, string> = {
	mint: "mint the invoice and prove where it came from",
	qr: "draw the QR",
	wait: "wait for the money",
	prove: "ask the recipient's own server",
	ask: "read what the endpoint answers",
	callback: "ask its callback for the least",
	invoice: "get the invoice a wallet would pay",
};

function escaped(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function editable(key: string, kind: string, value: string): string {
	return (
		`<span class="edit" data-key="${key}" data-kind="${kind}" ` +
		`contenteditable="plaintext-only" spellcheck="false">${escaped(value)}</span>`
	);
}

function lineOf(recipe: Recipe, by: string | RegExp | null): number {
	if (by === null) {
		return 0;
	}
	if (by instanceof RegExp) {
		return recipe.source.split("\n").findIndex((line) => by.test(line)) + 1;
	}

	return recipe.calls.find((call) => call.name === by)?.line ?? 0;
}

export function sourceOf(
	recipe: Recipe,
	wanted: Editable[],
): { rows: string; defaults: Record<string, string> } {
	const online = new Map<number, Call[]>();
	for (const call of recipe.calls) {
		online.set(call.line, [...(online.get(call.line) ?? []), call]);
	}

	const defaults: Record<string, string> = {};
	const rows = recipe.source
		.replace(/\n$/, "")
		.split("\n")
		.map((line, index) => {
			let marked = escaped(line);
			for (const call of online.get(index + 1) ?? []) {
				const bare = (call.name.split(".").at(-1) as string).replace(/\$/g, "\\$");
				marked = marked.replace(
					new RegExp(`(?<![\\w$>])${bare}(?![\\w$])`),
					`<a href="../api.md#${call.anchor}" title="${call.name}">${bare}</a>`,
				);
			}
			for (const { key, kind, finds } of wanted) {
				const found = defaults[key] === undefined ? finds.exec(marked) : null;
				if (found !== null) {
					defaults[key] = found[0];
					marked =
						marked.slice(0, found.index) +
						editable(key, kind, defaults[key]) +
						marked.slice(found.index + found[0].length);
				}
			}

			return (
				`<div class="row" id="L${index + 1}"><span class="ln">${index + 1}</span>` +
				`<span class="src">${marked || "&nbsp;"}</span></div>`
			);
		})
		.join("\n");

	for (const { key } of wanted) {
		if (defaults[key] === undefined) {
			throw new Error(`${key} is no longer where ${recipe.slug} put it`);
		}
	}

	return { rows, defaults };
}

export function pageFor(
	recipe: Recipe,
	runnable: Runnable,
	others: Runnable[],
	alongside: Recipe | null,
): string {
	const { rows, defaults } = sourceOf(recipe, runnable.editable);
	const nav = others
		.map((one) =>
			one.slug === runnable.slug ? one.slug : `<a href="${one.slug}.html">${one.slug}</a>`,
		)
		.join(" &middot; ");
	const steps = runnable.steps
		.map(([key, by]) => {
			const line = lineOf(recipe, by);

			return (
				`<li data-step="${key}" data-line="${line}"><span class="dot"></span>` +
				`<span class="what">${WHAT[key]}</span>` +
				`<span class="at">${line === 0 ? "wallet side" : `line ${line}`}</span></li>`
			);
		})
		.join("\n");

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaped(recipe.title)} - running</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<div class="page">

  <header>
    <div class="label">thunder-bridge &middot; examples/${recipe.slug}/main.ts &middot; live</div>
    <h1>${escaped(recipe.title)}</h1>
    <p class="intent">${escaped(recipe.intent)}. The code below is the recipe verbatim, and the
    highlighted values are its own defaults, editable here and remembered by your browser.</p>
    <p class="intent">${nav}</p>
  </header>

  <div class="cols">

    <div class="card">
      <h2><span>examples/${recipe.slug}/main.ts</span></h2>
      <div class="code">
${rows}
      </div>
    </div>

    <div>
      <div class="card">
        <h2>Run it</h2>
        <div class="body">
          <div class="controls">
            <button id="run">${runnable.action}</button>
            <button id="reset" class="ghost">Back to the defaults</button>
          </div>
          <p class="warn">${runnable.slug === "pay-me" ? "The QR never changes, what it answers does. Scan it with a wallet, or press the button to see what a wallet gets." : "This mints a <b>real invoice</b> against the address in the code, on the gateway in the code. Nobody has to pay it, it expires on its own."}</p>

          <ul class="steps">
${steps}
          </ul>

          <div id="qrcard"><div id="qr"></div><div class="bolt" id="bolt"></div><div class="ident" id="ident"></div></div>
          <div class="verdict" id="verdict"></div>
        </div>
      </div>

${
	runnable.slug === "pay-me"
		? `      <div class="card" style="margin-top: 1.75rem">
        <h2><span>examples/watch-a-place/main.ts</span><em>following, recent settlements replay first and then it runs live</em></h2>
        <div class="code">
${alongside === null ? "" : sourceOf(alongside, []).rows}
        </div>
        <div class="wire" id="arrived"><span class="empty">Nothing yet. Pay one of these invoices and
        it lands here, because the endpoint carries a watch secret and this page follows it.</span></div>
      </div>
`
		: ""
}      <div class="card" style="margin-top: 1.75rem">
        <h2>What actually went over the wire</h2>
        <div class="wire" id="wire"><span class="empty">Nothing yet. Every request and socket frame
        the recipe makes will appear here as it happens.</span></div>
      </div>
    </div>

  </div>

  <footer>
    Generated from <code>docs/recipes.json</code> by <code>tools/demo.ts</code>. Every linked name was
    found by the compiler. The running code is the recipe itself, bundled against the built package.
  </footer>

</div>

<script type="application/json" id="recipe">${JSON.stringify({
		slug: recipe.slug,
		call: runnable.call,
		defaults,
	})}</script>
<script type="module" src="page.js"></script>
</body>
</html>
`;
}

export function demoIn(root: string): { at: string; body: string }[] {
	const { recipes } = recipesIn(root);
	const known = new Map(recipes.map((recipe) => [recipe.slug, recipe]));

	return RUNNABLE.map((runnable) => {
		const recipe = known.get(runnable.slug);
		if (recipe === undefined) {
			throw new Error(`${runnable.slug} is runnable but no such recipe exists`);
		}

		return {
			at: `docs/demo/${runnable.slug}.html`,
			body: pageFor(recipe, runnable, RUNNABLE, known.get("watch-a-place") ?? null),
		};
	});
}

if (process.argv[1]?.endsWith("demo.ts")) {
	const root = process.argv[2] === "--check" ? (process.argv[3] ?? ".") : (process.argv[2] ?? ".");
	const checking = process.argv.includes("--check");

	for (const { at, body } of demoIn(root)) {
		const into = resolve(root, at);
		if (!checking) {
			writeFileSync(into, body);
			console.log(`${at} written`);
		} else if (readFileSync(into, "utf8") !== body) {
			console.log(`${at} is not what the recipes say, run node tools/demo.ts`);
			process.exitCode = 1;
		} else {
			console.log(`${at} still matches the recipes`);
		}
	}

	if (!checking) {
		execFileSync(
			resolve(root, "node_modules/.bin/esbuild"),
			[
				resolve(root, "docs/demo/entry.ts"),
				"--bundle",
				"--format=esm",
				"--platform=browser",
				"--external:dns/promises",
				"--external:timers/promises",
				`--outfile=${resolve(root, "docs/demo/bundle.js")}`,
			],
			{ stdio: "inherit" },
		);
		console.log(`${relative(root, resolve(root, "docs/demo/bundle.js"))} written`);
	}
}
