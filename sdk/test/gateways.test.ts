import { describe, expect, it, vi } from "vitest";
import { callerKey, paymentNamedBy } from "../../core/caller.js";
import { Gateways } from "../src/gateways";
import { jsonResponse, problemResponse, stubFetch, type Routes } from "./harness";

const ONE = "https://one.example.net";
const TWO = "https://two.example.net";
const THREE = "https://three.example.net";
const SECRET = "rail_many_3f8a1c7d0b249e56";
const HASH = "ab".repeat(32);
const EXPIRES_AT = 1_900_000_600;

vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "203.0.113.1", family: 4 }],
}));

function watchable() {
  return {
    paymentHash: HASH,
    verifyUrl: "https://shop.example/verify/one",
    expiresAt: EXPIRES_AT,
  };
}

async function named(): Promise<string> {
  return paymentNamedBy((await callerKey(SECRET)).publicKeyHex, HASH);
}

async function watching(status = "pending"): Promise<Record<string, unknown>> {
  return {
    id: await named(),
    status,
    payment_hash: HASH,
    verify_url: "https://shop.example/verify/one",
    preimage: null,
    expires_at: new Date(EXPIRES_AT * 1000).toISOString(),
    created_at: new Date(1_900_000_000 * 1000).toISOString(),
  };
}

async function allWatching(): Promise<Routes> {
  const body = await watching();

  return Object.fromEntries(
    [ONE, TWO, THREE].map((base) => [`${base}/watched-payments`, () => jsonResponse(body, 201)]),
  );
}

describe("Gateways", () => {
  it("hands the same invoice to every gateway and gets one name back", async () => {
    const calls = stubFetch(await allWatching());

    const watched = await new Gateways([ONE, TWO, THREE], { secret: SECRET }).watchPayment(
      watchable(),
    );

    expect(watched.id).toBe(await named());
    expect(calls.map((call) => call.url).sort()).toEqual([
      `${ONE}/watched-payments`,
      `${THREE}/watched-payments`,
      `${TWO}/watched-payments`,
    ]);
  });

  it("stays watched when one gateway refuses, and says which one", async () => {
    const refusals: string[] = [];
    const routes = await allWatching();
    routes[`${TWO}/watched-payments`] = () => problemResponse({ title: "nope", status: 503 }, 503);

    stubFetch(routes);
    const watched = await new Gateways([ONE, TWO, THREE], {
      secret: SECRET,
      onRefused: (baseUrl) => refusals.push(baseUrl),
    }).watchPayment(watchable());

    expect(watched.id).toBe(await named());
    expect(refusals).toEqual([TWO]);
  });

  it("throws only when none of them took it", async () => {
    const routes = Object.fromEntries(
      [ONE, TWO].map((base) => [
        `${base}/watched-payments`,
        () => problemResponse({ title: "nope", status: 503 }, 503),
      ]),
    );
    stubFetch(routes);

    const rejection = await new Gateways([ONE, TWO], { secret: SECRET })
      .watchPayment(watchable())
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
  });

  it("takes the settlement from whichever gateway speaks first", async () => {
    stubFetch({});
    const gateways = new Gateways([ONE, TWO, THREE], { secret: SECRET });
    const paid = { ...(await watching("paid")), preimage: "cd".repeat(32) };

    vi.spyOn(gateways.each[0]!, "waitForWatched").mockImplementation(
      () => new Promise(() => {}) as Promise<never>,
    );
    vi.spyOn(gateways.each[1]!, "waitForWatched").mockResolvedValue({
      ...(paid as unknown as Awaited<ReturnType<typeof gateways.waitForWatched>>),
      status: "paid",
    });
    vi.spyOn(gateways.each[2]!, "waitForWatched").mockRejectedValue(new Error("unreachable"));

    const settled = await gateways.waitForWatched(await named());
    expect(settled.status).toBe("paid");
  });

  it("hands back the first ending when none of them saw a payment", async () => {
    stubFetch({});
    const gateways = new Gateways([ONE, TWO], { secret: SECRET });

    for (const gateway of gateways.each) {
      vi.spyOn(gateway, "waitForWatched").mockResolvedValue({
        ...(((await watching("expired")) as unknown) as Awaited<
          ReturnType<typeof gateways.waitForWatched>
        >),
        status: "expired",
      });
    }

    expect((await gateways.waitForWatched(await named())).status).toBe("expired");
  });

  it("throws when every gateway failed rather than reporting nothing happened", async () => {
    stubFetch({});
    const gateways = new Gateways([ONE, TWO], { secret: SECRET });

    for (const gateway of gateways.each) {
      vi.spyOn(gateway, "waitForWatched").mockRejectedValue(new Error("unreachable"));
    }

    await expect(gateways.waitForWatched(await named())).rejects.toThrow("unreachable");
  });

  it("refuses to be built with no gateway at all", () => {
    expect(() => new Gateways([])).toThrow("at least one gateway");
  });

  it("knows the payment's name without asking any of them", async () => {
    stubFetch({});

    expect(await new Gateways([ONE, TWO], { secret: SECRET }).nameFor(HASH)).toBe(await named());
  });
});
