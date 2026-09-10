import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: { "thunder-bridge": resolve(import.meta.dirname, "sdk/src/index.ts") },
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
