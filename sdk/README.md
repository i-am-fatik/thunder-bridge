# thunder-bridge

A JavaScript client for a Thunder Bridge gateway. Give it a priority list of
lightning addresses and an amount, and it hands back an invoice minted by the
recipient's own wallet. The gateway mints nothing, holds nothing and forwards
nothing.

None of that would be worth much if you had to take the gateway's word for it, so
this package does not. Before `createPayment` returns, the invoice is proven
against the recipient's own server: it is the invoice that address issued, for the
amount you asked for rather than the amount the gateway echoed back, and its
settlement proof url belongs to the recipient. A gateway that substitutes an
invoice is caught before a payer sees a QR code.

Lightning is the rail it was built for, not the only one it can prove. A bank
transfer has no preimage, so `bankTransfer` derives one and hands the gateway its
hash, which puts money arriving in a bank account behind the same watch, the same
poll and the same proof. `Statement` is where a bank plugs in and `fioStatement`
is the first one.

It touches only `fetch`, `crypto.subtle`, `URL` and `WebSocket`, so it runs in
Node, Bun, Deno, Cloudflare Workers and the browser. The gateway it talks to is
one level up in [this repository](../README.md).

## Install

```bash
npm install thunder-bridge
```

## Quick start

A page can run the whole flow with no backend of its own. The gateway answers
every origin, and coinos, Alby and Stacker News serve their LNURL endpoints with
CORS open, so the proof fetches work from a browser too.

```ts
import { ThunderBridge, invoiceToSvg, type CreatePaymentParams } from "thunder-bridge";

const gateway = new ThunderBridge("https://thunder-bridge-production.up.railway.app");

const request: CreatePaymentParams = {
  lnAddresses: ["alice@coinos.io", "alice@getalby.com"],
  amountMsat: 21_000,
};

const payment = await gateway.createPayment(request);

const target = document.querySelector("#qr");
if (target) target.innerHTML = invoiceToSvg(payment.bolt11);
```

Keep the `request` object. Every proof takes it, because what you asked for is the
side of each comparison the gateway did not supply.

```ts
import { proveSettlement } from "thunder-bridge";

const settled = await gateway.waitForPayment(payment.id, {
  signal: AbortSignal.timeout(600_000),
});

if (settled.status === "paid") {
  const preimage = await proveSettlement(settled, request);
  if (preimage !== null) fulfil(payment.id);
}
```

`waitForPayment` tells you what the gateway says. `proveSettlement` goes to the
recipient's own server. Only the second is evidence the money arrived.

## What is exported

Everything comes from the package root, there are no subpaths. Signatures and the
caveats on each export are in the TSDoc on the export itself, so your editor has
them and this table does not repeat them.

**The gateway** - [`src/client.ts`](src/client.ts)

| Export | What it does |
|---|---|
| `new ThunderBridge(baseUrl, options?)` | a gateway handle. `{ secret }` is your rail secret and makes every call speak as you, `{ verify: false }` turns off the automatic proof, `{ token }` makes the instance yours |
| `new Gateways(baseUrls, options?)` | the same payment watched at several gateways, so any one of them is replaceable. `onRefused` says which of them would not take it |
| `gateway.nameFor(paymentHash)` | what this payment is called, worked out before any gateway has heard of it, and the same at all of them |
| `gateway.createPayment(params, options?)` | mint an invoice on the first address that can prove one, and prove it before returning |
| `gateway.createQuote(params)` | ask which address would take an amount without minting anything |
| `gateway.getPayment(id)` | read a payment back, `null` when the gateway never heard of it |
| `gateway.getWatched(id)` | the same for one the gateway only watches, which carries no address, amount or invoice |
| `gateway.listPayments(limit?)` | what this gateway is watching, newest first. Needs a token |
| `gateway.waitForPayment(id, options?)` | follow one payment over WebSocket until it is paid or expired |
| `gateway.waitForWatched(id, options?)` | the same for a watched one, answering the shape both rails share |
| `gateway.firstToSettle(ids, options?)` | wait on several legs, keep the first really paid, drop the losers |
| `gateway.watchPayment(params)` | hand over an invoice you obtained yourself, without the address or the amount |
| `gateway.followTrigger(secret, options)` | stream every payment carrying one trigger, reconnecting on its own |
| `gateway.isPrivate` | whether a token was given |

**Proving it** - [`src/verify.ts`](src/verify.ts)

| Export | What it does |
|---|---|
| `proveOrigin(payment, request)` | the five checks below, against the recipient's own server |
| `proveSettlement(payment, request)` | ask the recipient whether it settled, returns the preimage or `null` |
| `isProvablyPaid(payment)` | whether the gateway's own report is self-consistent. A sanity check, not a proof |
| `preimageMatchesHash(preimage, hash)` | one sha256 comparison |
| `decodeInvoice(bolt11)` | the invoice's own amount, payment hash and description hash |

**Serving your own endpoint** - [`src/trigger.ts`](src/trigger.ts), [`src/bank.ts`](src/bank.ts), [`src/fio.ts`](src/fio.ts)

| Export | What it does |
|---|---|
| `lnurlPayEndpoint(config)` | a whole LNURL-pay endpoint as one Fetch handler, so a static QR points at your domain. From `thunder-bridge/server` |
| `seal(secret, plaintext)`, `unseal` | the blob the gateway stores and cannot read |
| `toLnurl(url)` | bech32-encode an endpoint url |
| `bankTransfer(params)` | register a Czech QR platba as a watched payment. Refuses a gateway that serves strangers |
| `bankVerifyEndpoint(config)` | the other half, the LUD-21 shape backed by your own statement |
| `fioStatement(config)` | a `Statement` reading a Fio account, several tokens used strictly in turn |
| `lightningVerifyEndpoint(config)` | the same shape for Lightning, asking the wallet on the gateway's behalf. From `thunder-bridge/server` |
| `relayedVerifyUrl(mount, wallet, secret)` | the URL to hand the gateway instead of the wallet's, with the wallet's sealed inside |

What your service answers once those handlers are mounted is written out in
[`openapi.yaml`](openapi.yaml), shipped with this package.

`Statement` is a plain `(sinceUnix) => Promise<Credit[]>`, so another bank is
another function of that shape and persistence wraps it from outside rather than
living inside it. Nothing above it changes, and the package stays ignorant of
whatever runtime you keep state in.

**One shape for every payment method** - [`src/rail.ts`](src/rail.ts)

| Export | What it does |
|---|---|
| `bankRail(config)` | a `Rail` selling for a bank transfer, reading back through any `Statement` |
| `lightningRail(config)` | a `Rail` where the gateway mints the invoice, so it learns the address and the amount |
| `blindLightningRail(config)` | a `Rail` that resolves the address itself and tells the gateway only a hash. From `thunder-bridge/server` |

`Rail` is `(order: Order) => Promise<Leg>`. Everything that differs between rails
is bound once when the rail is built, so the only thing passed per sale is which
sale it is: a reference, an amount in minor units and a currency. A `Leg` reads
the same whichever rail made it, which is what lets `firstToSettle` take a mixed
list without being told what is in it.

The gateway is already indifferent to all of this. It holds a payment hash, polls
a verify URL and reports what came back, so a rail is an SDK-side arrangement of
calls the gateway already answers, not a plugin it has to load.

**Pricing a fiat order** - [`src/price.ts`](src/price.ts), [`src/currency.ts`](src/currency.ts)

| Export | What it does |
|---|---|
| `medianOf(tickers?, options?)` | ask several venues, take the middle, refuse the lot when they disagree too much |
| `coinbase`, `kraken`, `bitstamp`, `coinmate` | the four MiCA authorised venues, every one replaceable |
| `msatFor(amountMinor, priceMinorPerBtc, options?)` | exact BigInt arithmetic from fiat to millisatoshi |
| `minorUnitsOf(currency)`, `minorScaleOf` | what ISO 4217 says the currency's minor unit is |

**QR codes** - [`src/qr.ts`](src/qr.ts)

Every renderer returns a string, so they work on a server, in a worker and in a
browser with no canvas involved. `qrToSvg` takes any rail's `Leg.qr` and needs to
know nothing else, because a rail states its own payload. Below it sit the
format-named ones for calling directly: `invoiceToSvg` takes an invoice or a
lightning address, `lnurlToSvg` takes your own endpoint url, `spdToSvg` takes a
Short Payment Descriptor. Each has a `…ToDataUrl` twin for an `<img>` `src`. A
BOLT12 offer is not handled, because this gateway never returns one.

```ts
import { invoiceToSvg, lnurlToSvg } from "thunder-bridge";

const toPay = invoiceToSvg(payment.bolt11, { size: 320, color: "#1a1a2e" });
const tipJar = lnurlToSvg("https://agora.gripe/tip");
```

**Minting your own invoice** - [`src/rail.ts`](src/rail.ts): `invoiceFrom`, from
`thunder-bridge/server`. A gateway that does not mint is one that never sees an
address or an amount, so this is how a client gets a provable invoice itself and hands
the gateway only a hash, a url and an expiry. Server side, because it resolves
hostnames and refuses a private one.

**Webhooks** - [`src/webhook.ts`](src/webhook.ts): `parseSettlementRequest`,
`parseSettlement`, `isProvablySettled`, `parseWebhookRequest`, `parseWebhook`,
`parseWatchedWebhookRequest`, `parseWatchedWebhook`, `verifyWebhookSignature`,
`answerWebhookChallengeRequest`, `answerWebhookChallenge`. See
[Webhooks](#webhooks).

**Errors** - [`src/errors.ts`](src/errors.ts): `ProblemError`,
`NoWalletAvailableError`, `GatewayCheatError`, `UnverifiedRecipientError`,
`IdempotencyConflictError`, `isProblemType`. See [Errors](#errors).

## The proof

`proveOrigin(payment, request)` runs five checks in order and stops at the first
failure. The first two need no network. The rest go to the recipient's own domain,
never back to the gateway, which is the point: a gateway cannot witness its own
honesty.

| # | Check | Rules out | Fails with |
|---|---|---|---|
| 1 | the chosen address is one you listed, compared case-insensitively | the gateway paying an address you never named, its own included | `address_not_requested` |
| 2 | the invoice decodes to the amount you asked for and the payment hash the record reports | being billed more than you asked, or a record describing one invoice while carrying another | `amount_mismatch`, `hash_mismatch` |
| 3 | the invoice's description hash equals the sha256 of the `metadata` that address serves, under LUD-06 | an invoice minted by a different account on the same custodial domain | `description_hash_mismatch` |
| 4 | `verifyUrl` shares an origin with the `callback` that endpoint publishes | a settlement proof pointed anywhere the gateway controls | `verify_url_foreign` |
| 5 | a GET to `verifyUrl` echoes `pr`, and it equals `bolt11` byte for byte | everything the earlier checks could still miss, because the answer now comes from the recipient | `invoice_not_issued` |

Check 1 also builds the url the rest of the chain uses: your `user@domain` becomes
`https://domain/.well-known/lnurlp/user` under LUD-16, with the domain lowercased
and the local part left exactly as you wrote it. The gateway's spelling is used to
find the match and never to build the url, so it cannot aim the proof at a
different account on a provider that treats the local part as case-sensitive.

### Origin is not settlement

Those five checks are about an invoice. They prove that what you are putting in
front of a payer is the recipient's own invoice for the right amount. They say
nothing about whether anybody paid it, and the two answers to that are not the
same answer.

`isProvablyPaid` asks whether the gateway's report contradicts itself: a `paid`
status, a preimage, and a `bolt11` whose payment hash that preimage opens. All
three values arrive from the gateway in one message, so this is internal
consistency and nothing more. A gateway that generates a preimage, hashes it and
builds an invoice around that hash passes it. It catches breakage and
carelessness, not an operator who means it.

`proveSettlement` asks the recipient. It re-runs the origin proof, which is what
ties `verifyUrl` to the recipient's own callback origin, then reads that url.
`null` means the recipient's own server is not claiming the money arrived,
whatever the gateway says.

Use `isProvablyPaid` to throw out a record that is obviously wrong. Use
`proveSettlement` before you part with anything.

### The host guard

Every outbound url in the chain must be public https. The guard refuses loopback,
link-local, the RFC 1918 ranges, carrier-grade NAT, unique local addresses, and
IPv4-mapped IPv6 unwrapping into any of those. It also refuses a host with no dot
such as `nas`, the trailing-dot `localhost.`, and anything whose last label is
`local`, `internal`, `lan`, `arpa`, `test` or `invalid`.

It vets the first hop only. See below.

### Which transfer counts as paying

`bankVerifyEndpoint` calls a credit a settlement when the amount and the currency
match exactly and the reference appears anywhere in what the payer wrote,
case-insensitively. With `fioStatement` "what the payer wrote" is four Fio columns
joined: the variable symbol, the user identification, the message for the recipient
and the payer's own reference. So a bank that prefixes, appends, or moves the text
between those fields still settles.

Two shapes do not settle, and both leave the payment `pending` while the money is
already in the account:

- **A shortened reference.** The match asks whether the reference is inside what the
  bank forwarded, not the other way round, so a bank that truncates it never matches.
- **A payer whose bank forwards nothing but a numeric variable symbol.** The
  reference is alphanumeric and cannot travel in a numeric field, and the match does
  not read `X-VS` as an alternative.

Neither has been seen with Fio, which forwards the message untouched. Check it
against the banks your payers actually use before you promise them a rail.

## Making the gateway poll nobody but you

By default a Lightning watch hands the gateway the wallet's own verify URL, so the
gateway polls `blink.sv` or `coinos.io` directly and its logs, its ledger and its
peers all carry that domain. If you would rather it never touched a third party and
never learned which provider your recipient uses, put your own endpoint in between.

```ts
import { blindLightningRail, lightningVerifyEndpoint } from "thunder-bridge/server";

app.get("/verify/lightning", (context) =>
  lightningVerifyEndpoint({ secret: RELAY_SECRET, pollEverySecs: 5 })(context.req.raw),
);

const rail = blindLightningRail({
  gateway,
  lnAddresses: ["you@blink.sv"],
  amountMsat: (order) => order.amountMinor * 40,
  relayVerifyThrough: { endpoint: "https://shop.example/verify/lightning", secret: RELAY_SECRET },
});
```

The wallet's URL is sealed into the query with your secret, so what the gateway
stores and replicates is a blob it cannot read. It polls you, you ask the wallet,
and the preimage still comes from the recipient's own server and still has to hash
to the payment hash, so standing in the middle buys privacy and pacing without
making you something anyone has to trust. A wallet you cannot reach answers `502`
rather than "not settled", because those are different claims.

Both rails then run through endpoints of yours, on a pace you set, and the gateway
is only ever talking to servers that asked to be talked to. It costs you a service
that has to stay up: a browser-only integration cannot do this, and should keep
letting the gateway poll the wallet.

### How often the gateway asks

Your endpoint decides, not the gateway. `bankVerifyEndpoint` answers with
`Cache-Control: max-age=30`, and the gateway uses that as the interval for every
payment on your host. Set `pollEverySecs` to whatever your bank's own refresh makes
sensible: reading a statement that moves once an hour every five seconds only burns
your rate limit.

The gateway also asks the URL once, before it accepts the watch, and refuses with
`424` if it does not answer this shape. So deploy the endpoint first and register
second. That is what stops anyone pointing a gateway at a server that never asked to
be polled for thirty days.

## What is still trusted

- **The gateway chooses which of your addresses gets paid.** Nothing here can
  tell a genuine failure of the first from a preference for the third. What it
  cannot do is pick an address off your list.
- **The gateway can refuse you.** Availability is not provable. Every check here
  is about an invoice you were given, none about one you were not.
- **The gateway sees your request.** The address list, the amount and the webhook
  secret pass through it, because it has to make the calls. Treat the secret as
  shared with it and the address list as public.
- **Everything it says about a settlement, until you ask the recipient.**
  `isProvablyPaid` only asks whether that account holds together. If a payment
  matters, ask.
- **The host guard vets the first hop and no further.** Both fetches use the
  runtime's default redirect handling, so a public https host answering with a 302
  to a private address is followed there. Keep egress control outside this
  package if that matters.
- **A colluding custodian defeats all of it.** If the recipient's wallet provider
  and the gateway are the same party, then the party holding the money is also the
  one serving the metadata and answering the verify requests. Every check would
  pass. This protects a payer against the gateway, not against the recipient's own
  custodian.
- **TLS and DNS for the recipient's domain**, and an address is not a person. This
  proves an invoice belongs to an address, never that the address belongs to
  whoever you think.
- **A payment read cold is only as pinned as its creation.** `getPayment` checks
  the preimage against the `paymentHash` in the same record. It was `proveOrigin`
  at creation, against the request you wrote, that tied that hash to an invoice
  the recipient issued. So store the request alongside the payment id, or you are
  checking the gateway's numbers against each other and nothing more.

## Errors

Every failure from the gateway is an RFC 9457 problem document. Branch on `type`,
never on prose. `error.status` is what the transport carried, and a document
naming a different status in its own body does not override it.

| `type` | Status | Class |
|---|---|---|
| `…:invalid-request` | 400 | `ProblemError`, `detail` names the field |
| `…:no-wallet-available` | 400, 422, 502 | `NoWalletAvailableError`, `wallets` says why each failed |
| `about:blank` | 404 | none, `getPayment` returns `null` |
| `about:blank` | 503 | `ProblemError`, the instance is at capacity |
| `about:blank` | 500 | `ProblemError` |

The status on `no-wallet-available` follows the worst wallet, so a retry is never
advised in vain: 502 if any was merely unreachable, else 422 if any refused
permanently, else 400. Each entry in `wallets` is a `WalletFailure` in the order
the addresses were tried, and every reason is enumerated in
[`openapi.yaml`](../openapi.yaml).

`GatewayCheatError` is different in kind. It reports a gateway that demonstrably
misbehaved, and `code` names the check that caught it: the five in the table above
plus `preimage_mismatch`, a reported `paid` whose preimage does not open the
invoice.

`UnverifiedRecipientError` is deliberately neither. It means a check could not be
run, because the recipient's server was down, timed out, answered something
unreadable, or the browser was blocked by CORS. Not an accusation, and not a clean
bill of health either. Decide what you want to do with an unproven invoice, and
decide it explicitly.

```ts
import {
  GatewayCheatError,
  NoWalletAvailableError,
  ProblemError,
  UnverifiedRecipientError,
} from "thunder-bridge";

try {
  const payment = await gateway.createPayment({ lnAddresses: wallets, amountMsat: 21_000 });
  show(payment);
} catch (error) {
  if (error instanceof GatewayCheatError) {
    report(`the gateway cheated: ${error.code} on payment ${error.paymentId}`);
  } else if (error instanceof UnverifiedRecipientError) {
    report(`could not reach ${error.lnAddress} to check the invoice`);
  } else if (error instanceof NoWalletAvailableError) {
    for (const wallet of error.wallets) report(`${wallet.address}: ${wallet.reason}`);
  } else if (error instanceof ProblemError) {
    report(`${error.status} ${error.title}`);
  } else {
    throw error;
  }
}
```

## Webhooks

Pass `webhookUrl` when you create a payment, or on any rail. There is no webhook
secret: a gateway holds nothing of yours, and sending one is refused rather than
ignored. Every delivery is signed `ed25519=<signature>` with the key the gateway
publishes at `/webhook-key`, over `<x-timestamp>.<raw body>` rather than the body
alone, so a captured delivery cannot be replayed at you later.

The body is a `Settlement`: the id, the status, the payment hash, the preimage and
the time. Enough to act on and to check, and no more, so a retry is the same size
whatever you put in your own record. Read `sealed` back by id when you want it.
Retries widen until the payment itself runs out, never sooner than an hour. An
invoice that expires fires nothing.

Delivery is at-least-once, so deduplicate on `id`.

Your handler answers one challenge before any of that. The gateway POSTs
`{"type":"webhook-challenge","nonce":"..."}` to the URL while the create is still open
and refuses the payment with a 424 unless the nonce comes back, so the endpoint has to
be deployed before you register it. `answerWebhookChallengeRequest` verifies that
challenge and hands you the response to return, or `null` when the delivery was a real
settlement, and it leaves the body unread either way.

```ts
import {
  answerWebhookChallengeRequest,
  isProvablySettled,
  parseSettlementRequest,
} from "thunder-bridge";

const signs = { publicKey: await gateway.webhookKey() };

app.post("/hooks/paid", async (context) => {
  const challenge = await answerWebhookChallengeRequest(context.req.raw, signs);
  if (challenge) return challenge;

  const settled = await parseSettlementRequest(context.req.raw, signs);
  if (settled === null) return context.text("bad signature", 401);
  if (!isProvablySettled(settled)) return context.text("no preimage that hashes to it", 402);

  await fulfil(settled.id, settled.preimage);
  return context.text("ok");
});
```

`isProvablySettled` answers the only question that matters about a delivery: it says
paid and it carries a preimage that hashes to the payment hash the same body names.
Ask the recipient's own server with `proveSettlement` when the payment is one you
minted through the gateway and you want the proof to come from somewhere other than
the delivery.

### Every rail sends the same body

`bankRail` and `blindLightningRail` used to need a parser of their own, because their
webhook carried no address, no amount and no invoice while a minted one did. A
delivery is a `Settlement` on every rail now, so `parseSettlementRequest` is the only
one to reach for. `parseWatchedWebhookRequest` is still there for reading the shape a
socket frame and `getWatched` hand back, which is a payment rather than a delivery.

Give each rail its own path, as above, and neither endpoint has to guess which body
it was handed. Both events also carry `kind`, `"minted"` or `"watched"`, so a single
path serving a trigger that both rails settle on can branch on the field instead of
on which fields are missing.

### The gateway holds nothing of yours

There is nothing to hand it. A delivery is signed with the gateway's own key,
`x-signature: ed25519=<signature>` over `<x-timestamp>.<raw body>`. Fetch the public
half once and keep it.

```ts
const signs = { publicKey: await gateway.webhookKey() };

app.post("/hooks/paid", async (context) => {
  const challenge = await answerWebhookChallengeRequest(context.req.raw, signs);
  if (challenge) return challenge;

  const settled = await parseSettlementRequest(context.req.raw, signs);
  if (settled === null) return context.text("bad signature", 401);
  ...
});
```

Answering echoes the nonce and nothing else, because there is nothing to sign it with.
Holding the URL the gateway challenged is the whole proof.

The key is derived from the gateway's `CLUSTER_KEY`, so every instance in one cluster
signs alike and an operator rotating that key changes this one too. A signature that
stops verifying is therefore a reason to read `/webhook-key` again before it is a
reason to distrust the gateway. A `sha256=` signature is refused outright: that scheme
is gone.

`parseSettlementRequest` refuses anything more than five minutes out of date,
adjustable with `toleranceSecs`. The signature proves the delivery came from the
gateway. It does not prove the payment happened, because the gateway holds the key
that signs it either way. The proof is the preimage, checked by `isProvablySettled`
against the hash in the same body, or `proveSettlement` against the recipient's own
server when you want the answer from somewhere else entirely.

For a framework that hands you the raw body and headers separately, use
`parseWebhook`. The body must be the bytes as received, so mount a raw body parser
on that route and not a JSON one.

```ts
import express from "express";
import { parseWebhook } from "thunder-bridge";

app.post("/hooks/paid", express.raw({ type: "application/json" }), async (request, response) => {
  const payment = await parseWebhook(
    request.body,
    request.get("x-signature") ?? "",
    secret,
    request.get("x-timestamp") ?? "",
  );
  response.sendStatus(payment === null ? 401 : 200);
});
```

## Requirements

Node 22 or newer. `waitForPayment` and `followTrigger` use the global `WebSocket`,
which Node only exposes from 22 onwards, and there is no fallback and no optional
dependency to install. Everything else works on any runtime with `fetch` and
`crypto.subtle`, so an older Node can still create payments, quote them, verify
them, poll `getPayment`, serve `lnurlPayEndpoint` and handle webhooks.

## Development

```bash
npm install
npm test
npm run build
```

MIT.
