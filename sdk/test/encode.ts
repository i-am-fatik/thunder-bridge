const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const SIGNATURE_WORDS = 104;
const MSAT_PER_NANO_UNIT = 100;

export interface InvoiceFields {
  paymentHash: string;
  amountMsat?: number;
  descriptionHash?: string;
  description?: string;
  expirySecs?: number;
  network?: string;
}

/**
 * Build a well-formed BOLT11 invoice for tests, the signature is filler because
 * nothing in this package recovers a payee from it
 */
export function bolt11(fields: InvoiceFields): string {
  const hrp = `ln${fields.network ?? "bc"}${amountUnits(fields.amountMsat)}`;
  const descriptionWords = fields.description
    ? bytesToWords(new TextEncoder().encode(fields.description))
    : [];
  const data = [
    ...Array<number>(7).fill(0),
    1,
    1,
    20,
    ...bytesToWords(hexToBytes(fields.paymentHash)),
    ...(fields.descriptionHash
      ? [23, 1, 20, ...bytesToWords(hexToBytes(fields.descriptionHash))]
      : []),
    ...(descriptionWords.length > 0
      ? [13, descriptionWords.length >> 5, descriptionWords.length & 31, ...descriptionWords]
      : []),
    ...expiryFields(fields.expirySecs),
    ...Array<number>(SIGNATURE_WORDS).fill(0),
  ];
  return `${hrp}1${toChars([...data, ...checksum(hrp, data)])}`;
}

function expiryFields(expirySecs: number | undefined): number[] {
  if (expirySecs === undefined) return [];
  const words: number[] = [];
  for (let left = expirySecs; left > 0; left = Math.floor(left / 32)) words.unshift(left % 32);
  return [6, words.length >> 5, words.length & 31, ...words];
}

function amountUnits(amountMsat: number | undefined): string {
  if (amountMsat === undefined) return "";
  if (amountMsat % MSAT_PER_NANO_UNIT !== 0) {
    throw new Error(`${amountMsat} msat is not a whole number of nano-units`);
  }
  return `${amountMsat / MSAT_PER_NANO_UNIT}n`;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToWords(bytes: Uint8Array): number[] {
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  return words;
}

function checksum(hrp: string, data: number[]): number[] {
  const expanded = [
    ...[...hrp].map((char) => char.charCodeAt(0) >> 5),
    0,
    ...[...hrp].map((char) => char.charCodeAt(0) & 31),
  ];
  let check = 1;
  for (const value of [...expanded, ...data, 0, 0, 0, 0, 0, 0]) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) check ^= GENERATOR[i];
  }
  const mod = check ^ 1;
  return Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
}

function toChars(words: number[]): string {
  return words.map((word) => CHARSET[word]).join("");
}
