import {
  bankTransfer,
  bankVerifyEndpoint,
  bitstamp,
  coinbase,
  coinmate,
  type Credit,
  fioStatement,
  kraken,
  medianOf,
  minorScaleOf,
  minorUnitsOf,
  msatFor,
  preimageMatchesHash,
  type Statement,
  ThunderBridge,
  type Ticker,
  type TriggerEvent,
} from "thunder-bridge";

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const UNCONFIGURED = "https://unconfigured.invalid";
const GATEWAY = new URL(Deno.env.get("GATEWAY_URL") ?? UNCONFIGURED);
const IBAN = Deno.env.get("IBAN") ?? "";
const FIO_TOKENS = (Deno.env.get("FIO_TOKEN") ?? "")
  .split(",")
  .map((token) => token.trim())
  .filter(Boolean);
const BANK_SECRET = Deno.env.get("BANK_SECRET") ?? randomSecret();
const TRIGGER_SECRET = Deno.env.get("TRIGGER_SECRET");
const LN_ADDRESSES = (Deno.env.get("LN_ADDRESSES") ?? "")
  .split(",")
  .map((address) => address.trim())
  .filter(Boolean);
const PRICE = Deno.env.get("PRICE") ?? "480.55 CZK";
const SPREAD_BPS = Number(Deno.env.get("SPREAD_BPS") ?? 0);
const VENUES = (Deno.env.get("PRICE_VENUES") ?? "coinbase,kraken,bitstamp,coinmate")
  .split(",")
  .map((venue) => venue.trim().toLowerCase())
  .filter(Boolean);
const PUBLIC_URL = Deno.env.get("PUBLIC_URL");
const CONTENT = "The money landed. Here is the thing you paid for.";
const PAY_WITHIN_DAYS = 3;
const VERIFY_PATH = "/verify/bank";
const FIO_WINDOW_MS = 30_000;
const REMEMBERED = ["fio", "statement"];

const TICKERS: Record<string, () => Ticker> = { coinbase, kraken, bitstamp, coinmate };
const OFFERS_LIGHTNING = LN_ADDRESSES.length > 0;
const FIO_PACE_MS = FIO_WINDOW_MS / FIO_TOKENS.length;
const [CURRENCY, AMOUNT_MINOR] = readPrice(PRICE);

const priceOf = medianOf(VENUES.map((venue) => {
  const open = TICKERS[venue];
  if (!open) {
    throw new Error(`no price venue called ${venue}, pick from ${Object.keys(TICKERS).join(", ")}`);
  }

  return open();
}));

if (!IBAN || FIO_TOKENS.length === 0 || !GATEWAY.username) {
  console.log("IBAN, FIO_TOKEN and a GATEWAY_URL carrying its token are unset, every route is 503");
}
if (!Deno.env.get("BANK_SECRET")) {
  console.log(`BANK_SECRET=${BANK_SECRET} generated, set it or every open order loses its proof`);
}
if (!OFFERS_LIGHTNING) {
  console.log("LN_ADDRESSES is unset, so an order is payable by transfer only");
}

const gateway = new ThunderBridge(GATEWAY.origin, { token: decodeURIComponent(GATEWAY.username) });
const kv = await Deno.openKv();

interface Remembered {
  at: number;
  credits: Credit[];
  turns: Record<number, number>;
}

const acrossInvocations: Statement = async (sinceUnix) => {
  const stored = await kv.get<Remembered>(REMEMBERED);
  const last = stored.value ?? { at: 0, credits: [], turns: {} };
  const now = Date.now();
  if (now - last.at < FIO_PACE_MS) return last.credits;

  const turn = longestUnusedToken(last.turns);
  if (now - (last.turns[turn] ?? 0) < FIO_WINDOW_MS) return last.credits;

  const turns = { ...last.turns, [turn]: now };
  const claimed = await kv.atomic().check(stored).set(REMEMBERED, { ...last, turns }).commit();
  if (!claimed.ok) return last.credits;

  const credits = await fioStatement({ token: FIO_TOKENS[turn]!, minIntervalSecs: 0 })(sinceUnix);
  await kv.atomic()
    .check({ key: REMEMBERED, versionstamp: claimed.versionstamp })
    .set(REMEMBERED, { at: now, credits, turns })
    .commit();

  return credits;
};

function longestUnusedToken(turns: Record<number, number>): number {
  let longest = 0;
  for (let token = 1; token < FIO_TOKENS.length; token += 1) {
    if ((turns[token] ?? 0) < (turns[longest] ?? 0)) longest = token;
  }

  return longest;
}

const proveOnStatement = bankVerifyEndpoint({
  secret: BANK_SECRET,
  statement: acrossInvocations,
});

async function sellOne(origin: string): Promise<Response> {
  const reference = `ORDER-${randomSecret().slice(0, 8).toUpperCase()}`;
  const expiresAt = Math.floor(Date.now() / 1000) + PAY_WITHIN_DAYS * 24 * 60 * 60;

  const transfer = await bankTransfer({
    gateway,
    secret: BANK_SECRET,
    reference,
    amountMinor: AMOUNT_MINOR,
    currency: CURRENCY,
    iban: IBAN,
    verifyUrl: `${origin}${VERIFY_PATH}`,
    expiresAt,
    trigger: TRIGGER_SECRET,
  });

  const amountMsat = OFFERS_LIGHTNING
    ? msatFor(AMOUNT_MINOR, await priceOf(CURRENCY), { spreadBps: SPREAD_BPS })
    : 0;
  const invoice = OFFERS_LIGHTNING
    ? await gateway.createPayment(
      { lnAddresses: LN_ADDRESSES, amountMsat },
      { idempotencyKey: reference, trigger: TRIGGER_SECRET },
    )
    : null;

  const legs = invoice ? [transfer.id, invoice.id] : [transfer.id];

  return Response.json({
    reference,
    transfer: {
      id: transfer.id,
      amount_minor: AMOUNT_MINOR,
      currency: CURRENCY,
      spd: transfer.spd,
    },
    lightning: invoice && { id: invoice.id, amount_msat: amountMsat, bolt11: invoice.bolt11 },
    content_url: `${origin}/content?legs=${legs.join(",")}`,
  });
}

async function serveContent(legs: string[]): Promise<Response> {
  const paid = await paidLeg(legs);
  if (paid === null) return new Response("pay first, either way", { status: 402 });
  if (paid.preimage === null || !preimageMatchesHash(paid.preimage, paid.paymentHash)) {
    return new Response("that preimage settles nothing", { status: 502 });
  }

  return Response.json({ content: CONTENT, paid_leg: paid.id, preimage: paid.preimage });
}

async function paidLeg(legs: string[]): Promise<TriggerEvent | null> {
  for (const id of legs) {
    const watched = await gateway.getWatched(id);
    if (watched?.status === "paid") return watched;
  }

  return null;
}

function readPrice(priced: string): [string, number] {
  const [amount, currency] = priced.trim().split(/\s+/);
  if (!amount || !currency) throw new Error(`PRICE is "<amount> <ISO 4217 code>", got ${priced}`);

  const minor = Math.round(Number(amount) * minorScaleOf(currency));
  const decimals = (amount.split(".")[1] ?? "").length;
  if (!Number.isFinite(minor) || decimals > minorUnitsOf(currency)) {
    throw new Error(`${priced} is not a payable amount of ${currency.toUpperCase()}`);
  }

  return [currency.toUpperCase(), minor];
}

function unconfigured(): Response {
  return Response.json({
    error: "set IBAN, FIO_TOKEN and GATEWAY_URL as https://<token>@your-gateway",
  }, { status: 503 });
}

function route(request: Request): Response | Promise<Response> {
  const url = new URL(request.url);

  if (!IBAN || FIO_TOKENS.length === 0 || !GATEWAY.username) return unconfigured();
  if (url.pathname === VERIFY_PATH) return proveOnStatement(request);
  if (request.method === "POST" && url.pathname === "/order") {
    return sellOne(PUBLIC_URL ?? url.origin);
  }
  if (request.method === "GET" && url.pathname === "/content") {
    return serveContent((url.searchParams.get("legs") ?? "").split(",").filter(Boolean));
  }

  return new Response("not found", { status: 404 });
}

Deno.serve(async (request) => {
  try {
    return await route(request);
  } catch (failure) {
    return Response.json({ error: String(failure) }, { status: 502 });
  }
});
