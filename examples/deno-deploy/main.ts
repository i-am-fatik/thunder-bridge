import {
  type CreatePaymentParams,
  lnurlPayEndpoint,
  parseWebhookRequest,
  proveSettlement,
  ThunderBridge,
} from "thunder-bridge";

const GATEWAY_URL = Deno.env.get("GATEWAY_URL") ??
  "https://thunder-bridge-direct-production.up.railway.app";
const LN_ADDRESSES = (Deno.env.get("LN_ADDRESSES") ?? "")
  .split(",")
  .map((address) => address.trim())
  .filter(Boolean);
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? randomSecret();
const CALLBACK_SECRET = Deno.env.get("CALLBACK_SECRET") ?? randomSecret();
const WATCH_SECRET = Deno.env.get("WATCH_SECRET") ?? randomSecret();
const ADDRESS_NAME = Deno.env.get("ADDRESS_NAME") ?? "tips";
const PRICE_MSAT = Number(Deno.env.get("PRICE_MSAT") ?? 21_000);
const CONTENT = Deno.env.get("CONTENT") ?? "The sats landed. Here is the thing you paid for.";
const PUBLIC_URL = Deno.env.get("PUBLIC_URL");
const UNLOCKED_FOR_MS = 30 * 24 * 60 * 60 * 1000;
const ADDRESS_PATH = `/.well-known/lnurlp/${ADDRESS_NAME}`;

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unconfigured(): Promise<Response> {
  return Promise.resolve(
    Response.json({
      error: "set LN_ADDRESSES to a comma-separated list of lightning addresses that speak LUD-21",
    }, { status: 503 }),
  );
}

if (LN_ADDRESSES.length === 0) {
  console.log("LN_ADDRESSES is unset, every route answers 503 until it names a wallet");
}
if (!Deno.env.get("WATCH_SECRET")) {
  console.log(`WATCH_SECRET=${WATCH_SECRET} generated, set it to keep it across restarts`);
}

const askedFor: CreatePaymentParams = { lnAddresses: LN_ADDRESSES, amountMsat: PRICE_MSAT };
const gateway = new ThunderBridge(GATEWAY_URL);
const kv = await Deno.openKv();

const serveAddress = lnurlPayEndpoint({
  gateway,
  lnAddresses: LN_ADDRESSES,
  amountMsat: () => PRICE_MSAT,
  secret: CALLBACK_SECRET,
  watchSecret: WATCH_SECRET,
  baseUrl: PUBLIC_URL ? `${PUBLIC_URL}${ADDRESS_PATH}` : undefined,
});

async function sellOne(origin: string): Promise<Response> {
  const payment = await gateway.createPayment({
    ...askedFor,
    webhookUrl: `${origin}/hooks/paid`,
    webhookSecret: WEBHOOK_SECRET,
  }, { trigger: WATCH_SECRET });

  return Response.json({
    id: payment.id,
    bolt11: payment.bolt11,
    amount_msat: payment.amountMsat,
    content_url: `${origin}/content/${payment.id}`,
  });
}

async function unlockOnSettlement(request: Request): Promise<Response> {
  const payment = await parseWebhookRequest(request, WEBHOOK_SECRET);
  if (!payment) return new Response("bad signature", { status: 401 });

  const preimage = await proveSettlement(payment, askedFor);
  if (preimage === null) return new Response("the recipient released no preimage", { status: 202 });

  await kv.set(["unlocked", payment.id], preimage, { expireIn: UNLOCKED_FOR_MS });

  return new Response("ok");
}

async function serveContent(id: string): Promise<Response> {
  const unlocked = await kv.get<string>(["unlocked", id]);
  if (unlocked.value === null) return new Response("pay first", { status: 402 });

  return Response.json({ content: CONTENT, preimage: unlocked.value });
}

function route(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (LN_ADDRESSES.length === 0) return unconfigured();
  if (url.pathname === ADDRESS_PATH) return serveAddress(request);
  if (request.method === "POST" && url.pathname === "/invoice") {
    return sellOne(PUBLIC_URL ?? url.origin);
  }
  if (request.method === "POST" && url.pathname === "/hooks/paid") {
    return unlockOnSettlement(request);
  }
  if (request.method === "GET" && url.pathname.startsWith("/content/")) {
    return serveContent(url.pathname.slice("/content/".length));
  }

  return Promise.resolve(new Response("not found", { status: 404 }));
}

Deno.serve(async (request) => {
  try {
    return await route(request);
  } catch (failure) {
    return Response.json({ error: String(failure) }, { status: 502 });
  }
});
