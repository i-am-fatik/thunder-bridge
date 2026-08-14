import type {
  CreatePaymentParams,
  CreateQuoteParams,
  Payment,
  PaymentKind,
  PaymentStatus,
  Quote,
  Settlement,
  TriggerEvent,
  WalletFailure,
  WalletReason,
  WatchPaymentParams,
} from "./types.js";

const ASSET_CODE = "BTC";
const ASSET_SCALE = 11;

const REASONS: ReadonlySet<string> = new Set<WalletReason>([
  "address-unusable",
  "unreachable",
  "amount-not-accepted",
  "cannot-prove-delivery",
  "invoice-refused",
]);

export function createRequestBody(params: CreatePaymentParams, trigger: string | null): string {
  return JSON.stringify({
    ln_addresses: params.lnAddresses,
    incoming_amount: toAmount(params.amountMsat),
    webhook: params.webhookUrl ? { url: params.webhookUrl } : undefined,
    trigger: trigger ?? undefined,
  });
}

export function quoteRequestBody(params: CreateQuoteParams): string {
  return JSON.stringify({
    ln_addresses: params.lnAddresses,
    amount: toAmount(params.amountMsat),
  });
}

export function quoteFromWire(body: unknown): Quote | null {
  const wire = asObject(body);
  if (wire === null) {
    return null;
  }

  const lnAddress = text(wire["ln_address"]);
  const amountMsat = msatFrom(wire["amount"], 1);
  const feeMsat = msatFrom(wire["fee"], 0);
  const minMsat = msatFrom(wire["min_amount"], 0);
  const maxMsat = msatFrom(wire["max_amount"], 0);
  const metadata = text(wire["metadata"]);
  const refusals = refusalsFrom(wire["refusals"]);

  if (lnAddress === null || amountMsat === null || feeMsat === null) {
    return null;
  }
  if (minMsat === null || maxMsat === null || metadata === null || refusals === null) {
    return null;
  }

  return { lnAddress, amountMsat, feeMsat, minMsat, maxMsat, metadata, refusals };
}

export function paymentFromWire(body: unknown): Payment | null {
  const wire = asObject(body);
  if (wire === null) {
    return null;
  }

  const id = text(wire["id"]);
  const lnAddress = text(wire["ln_address"]);
  const bolt11 = text(wire["bolt11"]);
  const paymentHash = text(wire["payment_hash"]);
  const verifyUrl = text(wire["verify_url"]);
  const amountMsat = msatFrom(wire["incoming_amount"], 1);
  const expiresAt = secondsFrom(wire["expires_at"]);
  const createdAt = secondsFrom(wire["created_at"]);
  const status = wire["status"];
  const preimage = wire["preimage"] ?? null;

  if (id === null || lnAddress === null || bolt11 === null) {
    return null;
  }
  if (paymentHash === null || verifyUrl === null) {
    return null;
  }
  if (amountMsat === null || expiresAt === null || createdAt === null) {
    return null;
  }
  if (!isStatus(status)) {
    return null;
  }
  if (preimage !== null && typeof preimage !== "string") {
    return null;
  }

  return {
    id,
    lnAddress,
    amountMsat,
    status,
    paymentHash,
    bolt11,
    preimage,
    expiresAt,
    createdAt,
    verifyUrl,
  };
}

export function watchRequestBody(params: WatchPaymentParams, trigger: string | null): string {
  const expiresAt = new Date(params.expiresAt * 1000);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new TypeError(`expiresAt must be a usable unix time in seconds, got ${params.expiresAt}`);
  }

  return JSON.stringify({
    payment_hash: params.paymentHash,
    verify_url: params.verifyUrl,
    expires_at: expiresAt.toISOString(),
    trigger: trigger ?? undefined,
    sealed: params.sealed,
    webhook: params.webhookUrl ? { url: params.webhookUrl } : undefined,
  });
}

/**
 * A delivery says the least it can and still be worth having: the name, how it
 * ended, and a preimage against the hash it has to match. No verify url, because
 * you named it, and no sealed record, because the size of a retry should not
 * depend on what you put in it
 */
export function settlementFromWire(body: unknown): Settlement | null {
  const wire = asObject(body);
  if (wire === null) {
    return null;
  }

  const id = text(wire["id"]);
  const paymentHash = text(wire["payment_hash"]);
  const settledAt = secondsFrom(wire["settled_at"]);
  const status = wire["status"];
  const preimage = wire["preimage"] ?? null;

  if (id === null || paymentHash === null || settledAt === null || !isStatus(status)) {
    return null;
  }
  if (preimage !== null && typeof preimage !== "string") {
    return null;
  }

  return { id, status, paymentHash, preimage, settledAt };
}

export function triggerEventFromWire(body: unknown): TriggerEvent | null {
  const wire = asObject(body);
  if (wire === null) {
    return null;
  }

  const id = text(wire["id"]);
  const paymentHash = text(wire["payment_hash"]);
  const verifyUrl = text(wire["verify_url"]);
  const expiresAt = secondsFrom(wire["expires_at"]);
  const createdAt = secondsFrom(wire["created_at"]);
  const status = wire["status"];
  const preimage = wire["preimage"] ?? null;
  const sealed = wire["sealed"] ?? null;

  if (id === null || paymentHash === null || verifyUrl === null) {
    return null;
  }
  if (expiresAt === null || createdAt === null || !isStatus(status)) {
    return null;
  }
  if (preimage !== null && typeof preimage !== "string") {
    return null;
  }
  if (sealed !== null && typeof sealed !== "string") {
    return null;
  }

  return {
    id,
    kind: kindOf(wire),
    paymentHash,
    verifyUrl,
    status,
    preimage,
    expiresAt,
    createdAt,
    sealed,
    lnAddress: text(wire["ln_address"]),
    amountMsat: wire["incoming_amount"] === undefined ? null : msatFrom(wire["incoming_amount"], 1),
  };
}

function kindOf(wire: Record<string, unknown>): PaymentKind {
  const said = wire["kind"];
  if (said === "minted" || said === "watched") {
    return said;
  }

  return text(wire["ln_address"]) === null ? "watched" : "minted";
}

function toAmount(msat: number): Record<string, unknown> {
  return { value: String(msat), asset_code: ASSET_CODE, asset_scale: ASSET_SCALE };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function msatFrom(value: unknown, least: number): number | null {
  const amount = asObject(value);
  if (amount === null) {
    return null;
  }
  if (amount["asset_code"] !== ASSET_CODE || amount["asset_scale"] !== ASSET_SCALE) {
    return null;
  }

  const digits = amount["value"];
  if (typeof digits !== "string" || !/^[0-9]+$/.test(digits)) {
    return null;
  }

  const msat = Number(digits);
  return Number.isSafeInteger(msat) && msat >= least ? msat : null;
}

function refusalsFrom(value: unknown): WalletFailure[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const refusals: WalletFailure[] = [];
  for (const entry of value) {
    const failure = asObject(entry);
    const address = failure === null ? null : text(failure["address"]);
    const reason = failure?.["reason"];
    if (address === null || typeof reason !== "string" || !REASONS.has(reason)) {
      return null;
    }

    refusals.push({ address, reason: reason as WalletReason });
  }
  return refusals;
}

function secondsFrom(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? null : Math.floor(milliseconds / 1000);
}

function isStatus(value: unknown): value is PaymentStatus {
  return value === "pending" || value === "paid" || value === "expired";
}
