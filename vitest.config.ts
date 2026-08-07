import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["core/**/*.test.ts", "src/**/*.test.ts"],
		testTimeout: 40_000,
		pool: "forks",
	},
});
