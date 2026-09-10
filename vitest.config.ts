import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

import { DOORS } from "./tools/api-reference.ts";

const doors = [...DOORS].sort((one, other) => other.specifier.length - one.specifier.length);

export default defineConfig({
	resolve: {
		alias: Object.fromEntries(
			doors.map((door) => [door.specifier, resolve(import.meta.dirname, door.entry)]),
		),
	},
	test: {
		include: [
			"core/**/*.test.ts",
			"src/**/*.test.ts",
			"tools/**/*.test.ts",
			"examples/*/*.test.ts",
		],
		testTimeout: 40_000,
		pool: "forks",
		fileParallelism: false,
	},
});
