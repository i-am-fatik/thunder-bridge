import { describe, expect, it, vi } from "vitest";
import { type Amount, fiat, amountNow, msat, sats } from "../src/amount";
import { AmountError } from "../src/errors";

const RATE_CZK = 134_883_815;
const AT_100K_USD = 10_000_000;

describe("sats", () => {
  it("is a thousand millisatoshi each", () => {
    expect(sats(21)).toBe(21_000);
    expect(sats(1)).toBe(1_000);
  });

  it("refuses a fraction of a satoshi, because Lightning cannot move one", () => {
    expect(() => sats(0.5)).toThrow("not-whole-satoshi");
    expect(() => sats(1.0001)).toThrow("not-whole-satoshi");
  });

  it("refuses nothing and less than nothing", () => {
    expect(() => sats(0)).toThrow("not-whole-satoshi");
    expect(() => sats(-1)).toThrow("not-whole-satoshi");
  });

  it("refuses more satoshi than a millisatoshi count can hold safely", () => {
    expect(() => sats(Number.MAX_SAFE_INTEGER)).toThrow("not-whole-satoshi");
  });
});

describe("msat", () => {
  it("passes an exact count straight through", () => {
    expect(msat(21_000)).toBe(21_000);
    expect(msat(1)).toBe(1);
  });

  it("refuses a fraction, a zero and an unsafe integer", () => {
    expect(() => msat(1.5)).toThrow("not-whole-millisatoshi");
    expect(() => msat(0)).toThrow("not-whole-millisatoshi");
    expect(() => msat(2 ** 53)).toThrow("not-whole-millisatoshi");
  });
});

describe("fiat", () => {
  it("asks the rate only when the price is needed, not when it is named", async () => {
    const rate = vi.fn(async () => RATE_CZK);
    const amount = fiat("480.55", "CZK", { rate });

    expect(rate).not.toHaveBeenCalled();

    await amountNow(amount);

    expect(rate).toHaveBeenCalledWith("CZK");
  });

  it("reads a decimal string exactly, digit by digit, never through a float", async () => {
    const rate = async () => AT_100K_USD;

    await expect(amountNow(fiat("1.00", "USD", { rate }))).resolves.toBe(1_000_000);
    await expect(amountNow(fiat("0.01", "USD", { rate }))).resolves.toBe(10_000);
  });

  it("rounds a number to the currency's own minor unit", async () => {
    const rate = async () => AT_100K_USD;

    await expect(amountNow(fiat(4.99, "USD", { rate }))).resolves.toBe(4_990_000);
  });

  it("refuses more decimals than the currency has", () => {
    expect(() => fiat("1.005", "USD")).toThrow("more decimals than USD");
    expect(() => fiat("1.5", "JPY")).toThrow("more decimals than JPY");
  });

  it("refuses a currency whose minor unit nobody here knows", () => {
    expect(() => fiat("1.00", "XYZ")).toThrow("ISO 4217");
  });

  it("refuses a price that rounds away to nothing", () => {
    expect(() => fiat(0, "USD")).toThrow("price this can charge");
    expect(() => fiat("0.00", "USD")).toThrow("price this can charge");
  });

  it("asks the rate again for every payment, because a fiat price moves", async () => {
    const quotes = [RATE_CZK, RATE_CZK * 2];
    const amount = fiat("100.00", "CZK", { rate: async () => quotes.shift() ?? 0 });

    const first = await amountNow(amount);
    const second = await amountNow(amount);

    expect(second).toBeLessThan(first);
  });

  it("adds the spread the shop asked for, in basis points", async () => {
    const rate = async () => AT_100K_USD;

    const plain = await amountNow(fiat("1.00", "USD", { rate }));
    const wider = await amountNow(fiat("1.00", "USD", { rate, spreadBps: 100 }));

    expect(wider).toBe(plain + plain / 100);
  });
});

describe("amountNow", () => {
  it("settles a price that is already known", async () => {
    await expect(amountNow(msat(21_000))).resolves.toBe(21_000);
  });

  it("refuses whatever a function hands back if it stopped being payable", async () => {
    const drifted = () => 0 as unknown as ReturnType<typeof msat>;

    await expect(amountNow(drifted)).rejects.toThrow(AmountError);
  });
});

describe("the brand", () => {
  it("refuses a bare number, which is the unit mix-up this exists to stop", () => {
    // @ts-expect-error a price has to come from sats, msat or fiat
    const wrong: Amount = 21;

    expect(wrong).toBe(21);
  });

  it("is recognisable across entry points, where instanceof cannot be", () => {
    const foreign = new Error("not-a-decimal: from another bundle's own copy");
    foreign.name = "AmountError";
    Object.assign(foreign, { code: "not-a-decimal" });

    expect(AmountError.is(foreign)).toBe(true);
    expect(foreign instanceof AmountError).toBe(false);
  });

  it("is not fooled by anything else that failed", () => {
    expect(AmountError.is(new Error("nope"))).toBe(false);
    expect(AmountError.is(new TypeError("nope"))).toBe(false);
    expect(AmountError.is("not-whole-satoshi")).toBe(false);
    expect(AmountError.is(null)).toBe(false);
  });

  it("carries a code rather than a message, so a caller can branch on the fault", () => {
    const faults = [
      [() => sats(0.5), "not-whole-satoshi"],
      [() => msat(0), "not-whole-millisatoshi"],
      [() => fiat("nope", "USD"), "not-a-decimal"],
      [() => fiat("1.005", "USD"), "too-precise"],
      [() => fiat("1.00", "XYZ"), "unknown-currency"],
    ] as const;

    for (const [asked, code] of faults) {
      expect(asked).toThrow(AmountError);
      expect(asked).toThrow(expect.objectContaining({ code }));
    }
  });
});
