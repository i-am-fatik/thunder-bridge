import { afterEach, expect, test, vi } from "vitest";

import { bearer, positive, whole } from "./env.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

test("a token nobody set is no token", () => {
	vi.stubEnv("GATEWAY_TOKEN", undefined);
	expect(bearer("GATEWAY_TOKEN")).toBeUndefined();
});

test("a blank token is no token, so it cannot authorize the request that omits it", () => {
	vi.stubEnv("GATEWAY_TOKEN", "");
	expect(bearer("GATEWAY_TOKEN")).toBeUndefined();

	vi.stubEnv("GATEWAY_TOKEN", "   \n\t ");
	expect(bearer("GATEWAY_TOKEN")).toBeUndefined();
});

test("a token is taken without the whitespace a secrets file leaves on it", () => {
	vi.stubEnv("GATEWAY_TOKEN", " hunter2\n");
	expect(bearer("GATEWAY_TOKEN")).toBe("hunter2");
});

test("a number nobody set is no number, so the default in the signature that reads it stands", () => {
	vi.stubEnv("PORT", undefined);
	expect(whole("PORT")).toBeUndefined();

	vi.stubEnv("PORT", "");
	expect(whole("PORT")).toBeUndefined();
});

test("a number that is not one stops the process rather than falling back quietly", () => {
	vi.stubEnv("PORT", "eight");
	expect(() => whole("PORT")).toThrow(/whole number/);

	vi.stubEnv("PORT", "-1");
	expect(() => whole("PORT")).toThrow(/whole number/);
});

test("zero is a whole number but not a positive one", () => {
	vi.stubEnv("WORK_PER_TICK", "0");
	expect(whole("WORK_PER_TICK")).toBe(0);
	expect(() => positive("WORK_PER_TICK")).toThrow(/greater than zero/);
});
