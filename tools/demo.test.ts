import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { bundleDemo } from "./demo.ts";

test("the demo bundles for a browser, whichever node module the client reaches for", () => {
	const into = mkdtempSync(join(tmpdir(), "demo-bundle-"));
	try {
		bundleDemo(".", join(into, "bundle.js"));

		expect(readFileSync(join(into, "bundle.js"), "utf8")).toContain("tipJar");
	} finally {
		rmSync(into, { recursive: true, force: true });
	}
}, 60_000);
