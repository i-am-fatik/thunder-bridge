import { describe, expect, it } from "vitest";
import { encodeForQr, invoiceToDataUrl, invoiceToSvg, lnurlToDataUrl, lnurlToSvg } from "../src/qr";
import { bolt11 } from "./encode";

const INVOICE = bolt11({
  paymentHash: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  descriptionHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  amountMsat: 21_000_000,
});

const DATA_URL_PREFIX = "data:image/svg+xml,";

describe("encodeForQr", () => {
  it("prefixes the LIGHTNING URI scheme and uppercases the invoice for alphanumeric mode", () => {
    expect(encodeForQr(INVOICE)).toBe(`LIGHTNING:${INVOICE.toUpperCase()}`);
  });

  it("leaves a lightning address in the case it was given, where case carries meaning", () => {
    expect(encodeForQr("charter@blink.sv")).toBe("LIGHTNING:charter@blink.sv");
    expect(encodeForQr("Tip.Jar@Example.com")).toBe("LIGHTNING:Tip.Jar@Example.com");
  });

  it("still uppercases something that only looks like an address, at-sign and no dot", () => {
    expect(encodeForQr("lnbc1@")).toBe("LIGHTNING:LNBC1@");
  });
});

describe("invoiceToSvg", () => {
  it("returns an svg element sized to the default 256 pixels when no size is asked for", () => {
    const svg = invoiceToSvg(INVOICE);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="256" height="256"');
    expect(svg).toContain('viewBox="0 0 256 256"');
  });

  it("returns an svg element sized to the pixel size that was asked for", () => {
    const svg = invoiceToSvg(INVOICE, { size: 512 });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="512" height="512"');
    expect(svg).toContain('viewBox="0 0 512 512"');
  });

  it("paints the dark modules in a legitimate color rather than refusing it", () => {
    expect(invoiceToSvg(INVOICE, { color: "#ff9900" })).toContain('fill="#ff9900"');
    expect(invoiceToSvg(INVOICE, { color: "rebeccapurple" })).toContain('fill="rebeccapurple"');
  });

  it("throws rather than writing a color that would break out of the fill attribute", () => {
    expect(() => invoiceToSvg(INVOICE, { color: '#000" onload="alert(1)' })).toThrow(
      /Invalid color/,
    );
  });
});

describe("invoiceToDataUrl", () => {
  it("returns an svg data url that decodes back to exactly the svg invoiceToSvg renders", () => {
    const dataUrl = invoiceToDataUrl(INVOICE, { size: 320, color: "#111" });
    expect(dataUrl.startsWith(DATA_URL_PREFIX)).toBe(true);
    expect(decodeURIComponent(dataUrl.slice(DATA_URL_PREFIX.length))).toBe(
      invoiceToSvg(INVOICE, { size: 320, color: "#111" }),
    );
  });
});

describe("a trigger endpoint", () => {
  const TRIGGER = "https://agora.gripe/tip";

  it("renders the endpoint as an LNURL QR, so one printed code serves every payer", () => {
    const svg = lnurlToSvg(TRIGGER, { size: 192 });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="192" height="192"');
  });

  it("refuses a URL a wallet could not reach rather than drawing a dead code", () => {
    expect(() => lnurlToSvg("agora.gripe/tip")).toThrow(/not an http or https URL/);
  });

  it("hands back the same svg through the data url, for an img src", () => {
    const dataUrl = lnurlToDataUrl(TRIGGER, { size: 192 });
    expect(dataUrl.startsWith(DATA_URL_PREFIX)).toBe(true);
    expect(decodeURIComponent(dataUrl.slice(DATA_URL_PREFIX.length))).toBe(
      lnurlToSvg(TRIGGER, { size: 192 }),
    );
  });

  it("is a different code from the invoice one, because it carries a different string", () => {
    expect(lnurlToSvg(TRIGGER)).not.toBe(invoiceToSvg(TRIGGER.toUpperCase()));
  });
});

describe("a lightning address", () => {
  it("renders as a QR of its own, so a tip jar can show one without an invoice", () => {
    const svg = invoiceToSvg("charter@blink.sv", { size: 128 });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="128" height="128"');
  });
});

describe("the color guard", () => {
  it.each([
    'rgb(1)"><script>alert(1)</script><path fill="#000',
    'rgba(0)" onload="alert(1)',
    "#0000000",
  ])("refuses %s rather than writing it into the fill attribute", (color) => {
    expect(() => invoiceToSvg(INVOICE, { color })).toThrow("Invalid color");
  });

  it.each(["#fff", "#ffffff", "rgb(1, 2, 3)", "rgba(1 2 3 / 0.5)", "red"])(
    "accepts %s",
    (color) => {
      expect(invoiceToSvg(INVOICE, { color })).toContain(`fill="${color}"`);
    },
  );
});
