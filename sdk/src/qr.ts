import { encode } from "uqr";

import { toLnurl } from "../../core/lnurl.js";

export interface QrOptions {
  /** SVG width and height in pixels, defaults to 256 */
  size?: number;
  /** Dark module color, defaults to `#000` */
  color?: string;
}

const SAFE_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$|^rgba?\([\d.,%/\s]+\)$|^[a-z]+$/i;

/**
 * Encode what a wallet is meant to scan, under the `LIGHTNING` URI scheme. An
 * invoice goes uppercase so the QR uses alphanumeric mode, a lightning address
 * keeps its case, because its local part is case sensitive and the at-sign
 * forces byte mode whatever we do
 */
export function encodeForQr(destination: string): string {
  const scanned = isLnAddress(destination) ? destination : destination.toUpperCase();

  return `LIGHTNING:${scanned}`;
}

/** Render a BOLT11 invoice or a lightning address as an SVG QR code */
export function invoiceToSvg(destination: string, options?: QrOptions): string {
  return svgOf(encodeForQr(destination), options);
}

/** SVG data URL for an `<img>` `src` */
export function invoiceToDataUrl(destination: string, options?: QrOptions): string {
  return asDataUrl(invoiceToSvg(destination, options));
}

/**
 * Render your own LNURL-pay endpoint, the URL `lnurlPayEndpoint` is mounted on,
 * as the QR a payer scans. Nothing is minted and nothing expires, so this is the
 * code a tip jar prints once and an overlay shows all stream
 */
export function lnurlToSvg(endpoint: string, options?: QrOptions): string {
  return svgOf(toLnurl(endpoint), options);
}

/** SVG data URL of the endpoint's QR, for an `<img>` `src` */
export function lnurlToDataUrl(endpoint: string, options?: QrOptions): string {
  return asDataUrl(lnurlToSvg(endpoint, options));
}



function svgOf(scanned: string, options?: QrOptions): string {
  const size = options?.size ?? 256;
  const color = options?.color ?? "#000";
  if (!SAFE_COLOR.test(color)) throw new Error(`Invalid color: ${color}`);

  return renderSvg(scanned, size, color);
}

function asDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function isLnAddress(destination: string): boolean {
  const at = destination.indexOf("@");

  return at > 0 && destination.slice(at + 1).includes(".");
}

function renderSvg(content: string, size: number, color: string): string {
  const { data } = encode(content);
  const modules = data.length;
  const cellSize = size / modules;

  let path = "";
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      if (data[y][x]) {
        path += `M${x * cellSize},${y * cellSize}h${cellSize}v${cellSize}h-${cellSize}z`;
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`,
    `<rect width="100%" height="100%" fill="white"/>`,
    `<path d="${path}" fill="${color}"/>`,
    `</svg>`,
  ].join("");
}
