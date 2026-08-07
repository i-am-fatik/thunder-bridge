import { afterEach, describe, expect, it, vi } from "vitest";
import { bitstamp, coinbase, coinmate, kraken, medianOf, msatFor, type Ticker } from "../src/price";
import { jsonResponse, type Routes, stubFetch } from "./harness";

const COINBASE = "https://api.coinbase.com";
const KRAKEN = "https://api.kraken.com";
const BITSTAMP = "https://www.bitstamp.net";
const COINMATE = "https://coinmate.io";
const MSAT_PER_BTC = 100_000_000_000;

function venuesQuoting(overrides: Routes = {}): Routes {
  return {
    [`${COINBASE}/v2/prices/BTC-CZK/spot`]: () =>
      jsonResponse({ data: { amount: "1348838.152731", base: "BTC", currency: "CZK" } }),
    [`${COINBASE}/v2/prices/BTC-EUR/spot`]: () =>
      jsonResponse({ data: { amount: "55792.085", base: "BTC", currency: "EUR" } }),
    [`${KRAKEN}/0/public/Ticker?pair=XBTEUR`]: () =>
      jsonResponse({ error: [], result: { XXBTZEUR: { c: ["55782.00000", "0.00084550"] } } }),
    [`${KRAKEN}/0/public/Ticker?pair=XBTCZK`]: () =>
      jsonResponse({ error: ["EQuery:Unknown asset pair"] }),
    [`${BITSTAMP}/api/v2/ticker/btceur/`]: () => jsonResponse({ last: "55787.00" }),
    [`${BITSTAMP}/api/v2/ticker/btcczk/`]: () =>
      jsonResponse([
        { pair: "BTC/USD", last: "64420.41" },
        { pair: "BTC/EUR", last: "55787.00" },
      ]),
    [`${COINMATE}/api/ticker?currencyPair=BTC_CZK`]: () =>
      jsonResponse({ error: false, errorMessage: null, data: { last: 1_350_000 } }),
    [`${COINMATE}/api/ticker?currencyPair=BTC_EUR`]: () =>
      jsonResponse({ error: false, errorMessage: null, data: { last: 55_811.3 } }),
    ...overrides,
  };
}

function fixed(price: number): Ticker {
  return async () => price;
}

function refusing(reason: string): Ticker {
  return async () => {
    throw new Error(reason);
  };
}

describe("each venue", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a price as minor units of the currency asked for", async () => {
    stubFetch(venuesQuoting());

    expect(await coinbase()("CZK")).toBe(134_883_815);
    expect(await kraken()("EUR")).toBe(5_578_200);
    expect(await bitstamp()("EUR")).toBe(5_578_700);
    expect(await coinmate()("CZK")).toBe(135_000_000);
  });

  it("takes the currency in whatever case it was given", async () => {
    stubFetch(venuesQuoting());

    expect(await coinbase()("czk")).toBe(134_883_815);
    expect(await bitstamp()("EUR")).toBe(await bitstamp()("eur"));
  });

  it("refuses bitstamp's whole ticker list, which is how it answers an unknown pair", async () => {
    stubFetch(venuesQuoting());

    await expect(bitstamp()("CZK")).rejects.toThrow("no btcczk pair");
  });

  it("refuses kraken's error array, which arrives with a 200", async () => {
    stubFetch(venuesQuoting());

    await expect(kraken()("CZK")).rejects.toThrow("Unknown asset pair");
  });

  it("refuses coinmate's error flag", async () => {
    stubFetch(
      venuesQuoting({
        [`${COINMATE}/api/ticker?currencyPair=BTC_XYZ`]: () =>
          jsonResponse({
            error: true,
            errorMessage: "Currency pair BTC_XYZ not found.",
            data: null,
          }),
      }),
    );

    await expect(coinmate()("XYZ")).rejects.toThrow("not found");
  });

  it("refuses a coinbase answer quoting a currency nobody asked for", async () => {
    stubFetch(
      venuesQuoting({
        [`${COINBASE}/v2/prices/BTC-CZK/spot`]: () =>
          jsonResponse({ data: { amount: "64420.41", currency: "USD" } }),
      }),
    );

    await expect(coinbase()("CZK")).rejects.toThrow("quoted USD when asked for CZK");
  });

  it("refuses a venue that answers with a status", async () => {
    stubFetch(
      venuesQuoting({
        [`${COINBASE}/v2/prices/BTC-CZK/spot`]: () => jsonResponse({ error: "nope" }, 404),
      }),
    );

    await expect(coinbase()("CZK")).rejects.toThrow("coinbase answered 404");
  });

  it("refuses a price that is not a usable number", async () => {
    stubFetch(
      venuesQuoting({
        [`${BITSTAMP}/api/v2/ticker/btceur/`]: () => jsonResponse({ last: "0" }),
      }),
    );

    await expect(bitstamp()("EUR")).rejects.toThrow("bitstamp quoted 0");
  });
});

describe("medianOf", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("takes the middle of what the venues said", async () => {
    expect(await medianOf([fixed(100), fixed(102), fixed(101)])("CZK")).toBe(101);
  });

  it("averages the two middles on an even count", async () => {
    expect(await medianOf([fixed(100), fixed(101)])("CZK")).toBe(101);
  });

  it("skips a venue that does not quote the currency", async () => {
    const price = medianOf([fixed(100), refusing("no such pair"), fixed(102)]);

    expect(await price("CZK")).toBe(101);
  });

  it("says who refused when too few venues answered", async () => {
    const price = medianOf([fixed(100), refusing("kraken has no CZK")]);

    await expect(price("CZK")).rejects.toThrow("kraken has no CZK");
    await expect(price("CZK")).rejects.toThrow("1 of 2 venues quoted CZK");
  });

  it("refuses the lot when the venues disagree beyond the allowed spread", async () => {
    const price = medianOf([fixed(100), fixed(103), fixed(101)], { maxSpreadBps: 200 });

    await expect(price("CZK")).rejects.toThrow("disagree on CZK by 300 bps, more than the 200");
  });

  it("accepts one venue only when that is what was asked for", async () => {
    await expect(medianOf([fixed(100)])("CZK")).rejects.toThrow("1 of 1 venues");
    expect(await medianOf([fixed(100)], { minVenues: 1 })("CZK")).toBe(100);
  });

  it("holds the answer per currency rather than asking four venues per order", async () => {
    let asked = 0;
    const counting: Ticker = async () => {
      asked += 1;
      return 100;
    };
    const price = medianOf([counting, fixed(100)]);

    await price("CZK");
    await price("CZK");
    await price("EUR");

    expect(asked).toBe(2);
  });

  it("defaults to the four venues, and reaches every one of them", async () => {
    const calls = stubFetch(venuesQuoting());

    const eur = await medianOf()("EUR");

    expect(calls).toHaveLength(4);
    expect(eur).toBe(5_578_955);
  });

  it("still prices CZK on the two venues that quote it", async () => {
    stubFetch(venuesQuoting());

    expect(await medianOf()("CZK")).toBe(134_941_908);
  });
});

describe("msatFor", () => {
  it("turns a fiat price into millisatoshi at the quoted rate", () => {
    expect(msatFor(48_055, 134_883_815)).toBe(35_626_958);
  });

  it("rounds up, so the rounding belongs to the recipient", () => {
    expect(msatFor(1, 300_000_000_000)).toBe(1);
  });

  it("charges no margin unless one was asked for", () => {
    const plain = msatFor(100_000, 134_883_815);

    expect(msatFor(100_000, 134_883_815, {})).toBe(plain);
    expect(msatFor(100_000, 134_883_815, { spreadBps: 0 })).toBe(plain);
    expect(msatFor(100_000, 134_883_815, { spreadBps: undefined })).toBe(plain);
  });

  it("adds the basis points you asked for", () => {
    const plain = msatFor(100_000, 134_883_815);
    const withSpread = msatFor(100_000, 134_883_815, { spreadBps: 100 });

    expect(withSpread).toBeGreaterThan(plain);
    expect(withSpread).toBe(Math.ceil(plain * 1.01));
    expect(() => msatFor(100_000, 134_883_815, { spreadBps: 1.5 })).toThrow("basis points");
    expect(() => msatFor(100_000, 134_883_815, { spreadBps: -100 })).toThrow("basis points");
  });

  it("stays exact where a double would not, at a million crowns", () => {
    expect(msatFor(100_000_000, 134_883_815)).toBe(74_137_879_330);
  });

  it("refuses an amount or a price nobody could pay", () => {
    expect(() => msatFor(0, 134_883_815)).toThrow("above zero");
    expect(() => msatFor(1.5, 134_883_815)).toThrow("whole number");
    expect(() => msatFor(100, 0)).toThrow("not a usable price");
    expect(() => msatFor(100, Number.NaN)).toThrow("not a usable price");
  });

  it("refuses to invent more millisatoshi than exist", () => {
    expect(() => msatFor(Number.MAX_SAFE_INTEGER - 1, 1)).toThrow("more millisatoshi than exist");
  });
});

describe("ISO 4217 minor units", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a yen price with no decimals and a dinar with three", async () => {
    stubFetch({
      [`${COINBASE}/v2/prices/BTC-JPY/spot`]: () =>
        jsonResponse({ data: { amount: "8500000", currency: "JPY" } }),
      [`${COINBASE}/v2/prices/BTC-KWD/spot`]: () =>
        jsonResponse({ data: { amount: "17000.125", currency: "KWD" } }),
    });

    expect(await coinbase()("JPY")).toBe(8_500_000);
    expect(await coinbase()("KWD")).toBe(17_000_125);
  });

  it("refuses a currency whose minor unit it does not know", async () => {
    stubFetch({
      [`${COINBASE}/v2/prices/BTC-XAU/spot`]: () =>
        jsonResponse({ data: { amount: "20.5", currency: "XAU" } }),
    });

    await expect(coinbase()("XAU")).rejects.toThrow("ISO 4217 minor unit");
  });

  it("prices a yen order without dividing by a hundred it does not have", () => {
    expect(msatFor(8_500_000, 8_500_000)).toBe(MSAT_PER_BTC);
  });
});
