import {
  answerWebhookChallengeRequest,
  isProvablySettled,
  parseSettlementRequest,
  ThunderBridge,
} from "thunder-bridge";
import {
  invoiceFrom,
  lightningVerifyEndpoint,
  lnurlPayEndpoint,
  relayedVerifyUrl,
} from "thunder-bridge/server";

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const GATEWAY_URL =
  Deno.env.get("GATEWAY_URL") ?? "https://thunder-bridge-production.up.railway.app";
const LN_ADDRESSES = (Deno.env.get("LN_ADDRESSES") ?? "")
  .split(",")
  .map((address) => address.trim())
  .filter(Boolean);
const CALLBACK_SECRET = Deno.env.get("CALLBACK_SECRET") ?? randomSecret();
const WATCH_SECRET = Deno.env.get("WATCH_SECRET") ?? randomSecret();
const ADDRESS_NAME = Deno.env.get("ADDRESS_NAME") ?? "tips";
const PRICE_MSAT = Number(Deno.env.get("PRICE_MSAT") ?? 21_000);
const CONTENT = Deno.env.get("CONTENT") ?? "The sats landed. Here is the thing you paid for.";
const PUBLIC_URL = Deno.env.get("PUBLIC_URL");
const UNLOCKED_FOR_MS = 30 * 24 * 60 * 60 * 1000;
const PAY_WITHIN_SECS = 3600;
const ADDRESS_PATH = `/.well-known/lnurlp/${ADDRESS_NAME}`;
const VERIFY_PATH = "/verify";

if (LN_ADDRESSES.length === 0) {
  console.log("LN_ADDRESSES is unset, every route answers 503 until it names a wallet");
}
if (!Deno.env.get("CALLBACK_SECRET")) {
  console.log(`CALLBACK_SECRET=${CALLBACK_SECRET} generated, set it to keep this shop's identity`);
}
if (!Deno.env.get("WATCH_SECRET")) {
  console.log(`WATCH_SECRET=${WATCH_SECRET} generated, set it to keep it across restarts`);
}
if (!PUBLIC_URL) {
  console.log("PUBLIC_URL is unset, so the gateway can reach neither /verify nor a webhook");
}

const WEBHOOK_URL = PUBLIC_URL ? `${PUBLIC_URL}/hooks/paid` : undefined;
const gateway = new ThunderBridge(GATEWAY_URL, { secret: CALLBACK_SECRET });
const signs = { publicKey: await gateway.webhookKey() };
const kv = await Deno.openKv();

const serveAddress = lnurlPayEndpoint({
  gateway,
  lnAddresses: LN_ADDRESSES,
  amountMsat: () => PRICE_MSAT,
  secret: CALLBACK_SECRET,
  watchSecret: WATCH_SECRET,
  baseUrl: PUBLIC_URL ? `${PUBLIC_URL}${ADDRESS_PATH}` : undefined,
  blind: true,
});

const serveVerify = lightningVerifyEndpoint({ secret: CALLBACK_SECRET });

async function sellOne(origin: string): Promise<Response> {
  const invoice = await invoiceFrom(LN_ADDRESSES, PRICE_MSAT);
  const watched = await gateway.watchPayment({
    paymentHash: invoice.paymentHash,
    verifyUrl: await relayedVerifyUrl(
      `${origin}${VERIFY_PATH}`,
      { url: invoice.verifyUrl, hash: invoice.paymentHash },
      CALLBACK_SECRET,
    ),
    expiresAt: Math.min(invoice.expiresAt, Math.floor(Date.now() / 1000) + PAY_WITHIN_SECS),
    trigger: WATCH_SECRET,
    webhookUrl: WEBHOOK_URL,
  });

  return Response.json({
    id: watched.id,
    bolt11: invoice.bolt11,
    amount_msat: PRICE_MSAT,
    content_url: `${origin}/content/${watched.id}`,
  });
}

async function unlockOnSettlement(request: Request): Promise<Response> {
  const challenge = await answerWebhookChallengeRequest(request, signs);
  if (challenge) {
    return challenge;
  }

  const settled = await parseSettlementRequest(request, signs);
  if (!settled) {
    return new Response("bad signature", { status: 401 });
  }

  const preimage = isProvablySettled(settled) ? settled.preimage : null;
  if (preimage === null) {
    return new Response("the recipient released no preimage", { status: 202 });
  }

  await kv.set(["unlocked", settled.id], preimage, { expireIn: UNLOCKED_FOR_MS });

  return new Response("ok");
}

async function serveContent(id: string): Promise<Response> {
  const unlocked = await kv.get<string>(["unlocked", id]);
  if (unlocked.value === null) {
    return new Response("pay first", { status: 402 });
  }

  return Response.json({ content: CONTENT, preimage: unlocked.value });
}

function unconfigured(): Response {
  return Response.json(
    {
      error: "set LN_ADDRESSES to a comma-separated list of lightning addresses that speak LUD-21",
    },
    { status: 503 },
  );
}

function route(request: Request): Response | Promise<Response> {
  const url = new URL(request.url);

  if (LN_ADDRESSES.length === 0) {
    return unconfigured();
  }
  if (url.pathname === ADDRESS_PATH) {
    return serveAddress(request);
  }
  if (url.pathname === VERIFY_PATH) {
    return serveVerify(request);
  }
  if (request.method === "POST" && url.pathname === "/invoice") {
    return sellOne(PUBLIC_URL ?? url.origin);
  }
  if (request.method === "POST" && url.pathname === "/hooks/paid") {
    return unlockOnSettlement(request);
  }
  if (request.method === "GET" && url.pathname.startsWith("/content/")) {
    return serveContent(url.pathname.slice("/content/".length));
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
