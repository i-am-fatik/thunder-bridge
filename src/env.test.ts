import { afterEach, expect, test, vi } from "vitest";

import { bearer } from "./env.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

test("a token nobody set is no token", () => {
	vi.stubEnv("GATEWAY_TOKEN", undefined);
	expect(bearer("GATEWAY_TOKEN")).toBe(null);
});

test("a blank token is no token, so it cannot authorize the request that omits it", () => {
	vi.stubEnv("GATEWAY_TOKEN", "");
	expect(bearer("GATEWAY_TOKEN")).toBe(null);

	vi.stubEnv("GATEWAY_TOKEN", "   \n\t ");
	expect(bearer("GATEWAY_TOKEN")).toBe(null);
});

test("a token is taken without the whitespace a secrets file leaves on it", () => {
	vi.stubEnv("GATEWAY_TOKEN", " hunter2\n");
	expect(bearer("GATEWAY_TOKEN")).toBe("hunter2");
});
