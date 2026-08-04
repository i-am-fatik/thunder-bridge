# thunder-bridge

A JavaScript client for a Thunder Bridge gateway. You give it a priority list of
Lightning addresses and an amount, it walks the list, asks each address's own
LNURL-pay endpoint for an invoice, and hands back the first one it could get.
The gateway mints nothing, holds nothing and forwards nothing. The payer pays
the recipient's own invoice.

None of that would be worth much if you had to take the gateway's word for it,
so this package does not. Before `createPayment` returns, the invoice is proven
against the recipient's own server: it is the invoice that address issued, it is
for the amount you asked for rather than the amount the gateway echoed back, and
the settlement proof url belongs to the recipient rather than to the gateway.
Two fetches, both straight at the recipient's domain, neither of them back to
the gateway. A gateway that substitutes an invoice is caught by the caller that
asked for it, before a payer ever sees a QR code.

Whether the money then arrived is a separate question with its own call.
`proveSettlement` asks the recipient's own server and returns the preimage that
server released. Everything else you can read about a payment is the gateway's
own account of it, and this package is deliberate about which of its functions
are proofs and which are only sanity checks.

It touches only `fetch`, `crypto.subtle`, `URL` and `WebSocket`, so it runs in
Node, Bun, Deno, Cloudflare Workers and the browser. The service it talks to lives in the same repository, one level up from this
package.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [API](#api)
  - [`new ThunderBridge(baseUrl, options?)`](#new-thunderbridgebaseurl-options)
  - [`gateway.listPayments(limit?)`](#gatewaylistpaymentslimit)
  - [`gateway.createPayment(params)`](#gatewaycreatepaymentparams)
  - [`gateway.createQuote(params)`](#gatewaycreatequoteparams)
  - [`gateway.followTrigger(secret, options)`](#gatewayfollowtriggersecret-options)
  - [`gateway.watchPayment(params)`](#gatewaywatchpaymentparams)
  - [`seal(secret, plaintext)` and `unseal(secret, sealed)`](#sealsecret-plaintext-and-unsealsecret-sealed)
  - [`lnurlPayEndpoint(config)`](#lnurlpayendpointconfig)
  - [`gateway.getPayment(id)`](#gatewaygetpaymentid)
  - [`gateway.waitForPayment(id, options?)`](#gatewaywaitforpaymentid-options)
  - [`proveOrigin(payment, request)`](#proveoriginpayment-request)
  - [`proveSettlement(payment, request)`](#provesettlementpayment-request)
  - [`isProvablyPaid(payment)`](#isprovablypaidpayment)
  - [`preimageMatchesHash(preimage, paymentHash)`](#preimagematcheshashpreimage-paymenthash)
  - [`decodeInvoice(bolt11)`](#decodeinvoicebolt11)
  - [`invoiceToSvg(destination, options?)`](#invoicetosvgdestination-options)
  - [`invoiceToDataUrl(destination, options?)`](#invoicetodataurldestination-options)
  - [`lnurlToSvg(endpoint, options?)` and `lnurlToDataUrl(endpoint, options?)`](#lnurltosvgendpoint-options-and-lnurltodataurlendpoint-options)
  - [`parseWebhookRequest(request, secret)`](#parsewebhookrequestrequest-secret)
  - [`parseWebhook(body, signature, secret)`](#parsewebhookbody-signature-secret)
  - [`verifyWebhookSignature(body, signature, secret)`](#verifywebhooksignaturebody-signature-secret)
  - [Error classes](#error-classes)
  - [Types](#types)
- [The verification chain](#the-verification-chain)
  - [Proving the money arrived](#proving-the-money-arrived)
  - [The host guard](#the-host-guard)
- [What is still trusted](#what-is-still-trusted)
- [Errors](#errors)
- [Webhooks](#webhooks)
- [QR codes](#qr-codes)
- [Requirements](#requirements)
- [Development](#development)
- [License](#license)

## Install

```bash
npm install thunder-bridge
```

## Quick start

A page can run the whole flow with no backend of its own. The gateway answers
every origin, and coinos, Alby and Stacker News serve their LNURL endpoints with
CORS open, so the verification fetches work from a browser too.

```ts
import { ThunderBridge, invoiceToSvg, type CreatePaymentParams } from "thunder-bridge";

const gateway = new ThunderBridge("https://thunder-bridge-direct-production.up.railway.app");

const request: CreatePaymentParams = {
  lnAddresses: ["alice@coinos.io", "alice@getalby.com"],
  amountMsat: 21_000,
};

const payment = await gateway.createPayment(request);

const target = document.querySelector("#qr");
if (target) target.innerHTML = invoiceToSvg(payment.bolt11);
```

By the time that resolves, the invoice has been checked against whichever
address won, so it is safe to put in front of a payer. Keep the `request`
object. Every proof in this package takes it, because what you asked for is the
one side of each comparison the gateway did not supply.

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

`waitForPayment` tells you what the gateway says, and rejects a `paid` frame
whose numbers do not hold together. `proveSettlement` goes to the recipient's
own server and comes back with the preimage that server released, or `null` if
it has released none. Only the second is evidence the money arrived.

## API

Everything below is exported from the package root. There are no subpaths.

### `new ThunderBridge(baseUrl, options?)`

```ts
const gateway = new ThunderBridge("https://gateway.example");
const unchecked = new ThunderBridge("https://gateway.example", { verify: false });
```

```ts
const mine = new ThunderBridge("https://gateway.example", { token: process.env.GATEWAY_TOKEN });
```

A trailing slash on `baseUrl` is stripped. `verify` defaults to `true`, and
setting it to `false` turns off both halves of the checking the client does for
you: the origin proof on
`createPayment`, and the `isProvablyPaid` consistency check on every `paid`
payment read back. Turn it off only when you are running the checks yourself.

`token` is sent as `Authorization: Bearer` and is what a gateway started with
`GATEWAY_TOKEN` requires on every call. That is a lock for a gateway you host
yourself, not a per-user login: it keeps strangers out of your instance. On a
shared gateway a token someone else issues you is a thing they can revoke, which
is the dependency this project exists to remove, so there is no account system
here and none is planned.

The token covers the WebSocket handshake too, and a socket without it is refused
with a 401 rather than upgraded. No browser can put a header on a socket, so
setting `token` also makes `waitForPayment` and `followTrigger` mint a
short-lived ticket per connection and open `/ws/tickets/...` with that. Nothing
to configure, and `tickets: true` stays there for the public gateway where you
want the same on purpose.

### `gateway.listPayments(limit?)`

```ts
const { payments, scanned } = await gateway.listPayments(50);
```

Lists what the gateway is watching, newest first. Only a gateway with a token
serves it, because a list on a shared one would hand every caller everyone
else's payments. A public gateway answers 404 and this throws `ProblemError`.

`scanned` is how many settled records were read to build the page. Settled
payments older than that window are not in the answer. Entries are
`TriggerEvent`, so `lnAddress` and `amountMsat` are `null` for anything
registered blind through `watchPayment`.

### `gateway.createPayment(params)`

```ts
const payment = await gateway.createPayment({
  lnAddresses: ["alice@coinos.io", "alice@getalby.com"],
  amountMsat: 21_000,
  webhookUrl: "https://myapp.example/hooks/paid",
  webhookSecret: process.env.WEBHOOK_SECRET,
});
```

| Field | Type | Meaning |
|---|---|---|
| `lnAddresses` | `string[]` | priority list, tried strictly in order, the first one that can issue a provable invoice wins |
| `amountMsat` | `number` | amount in millisatoshi |
| `webhookUrl` | `string?` | POSTed once the payment is paid, must be a public https URL |
| `webhookSecret` | `string?` | HMAC-SHA256 key for the `x-signature` header |

Resolves to a `Payment`, having run `proveOrigin(payment, params)` against it
first unless `verify` is off. The object you pass is the object the proof is run
against, so keep it if you intend to prove anything later. Throws
`NoWalletAvailableError` when no address on the list could serve one,
`GatewayCheatError` when the invoice returned is not the recipient's,
`UnverifiedRecipientError` when the recipient's server could not be reached to
find out, and `ProblemError` for everything else the gateway answered, including
a 2xx whose body is not a JSON object.

A second argument makes the call safe to retry:

```ts
const payment = await gateway.createPayment(params, { idempotencyKey: orderId });
```

The key is claimed before any wallet is contacted, so the retry a client fires
when its own timeout expires does not mint a second invoice. Repeating a finished
request replays its payment, repeating one that is still resolving throws
`IdempotencyConflictError` with `conflict: "request-in-flight"`, and sending the
same key for different addresses, a different amount or a different webhook
throws it with `conflict: "key-reused"`. Keys are held for 24 hours, which is
shorter than a payment lives, so a replay naming a payment the gateway has since
pruned throws a plain `ProblemError` with status 410 rather than minting again.
The replayed payment is verified exactly as a fresh one is.

### `gateway.createQuote(params)`

```ts
const quote = await gateway.createQuote({
  lnAddresses: ["alice@coinos.io", "alice@getalby.com"],
  amountMsat: 21_000,
});
```

Asks which address would serve an amount without minting anything. It fetches
each address's LNURL-pay endpoint in order and returns the first that answers and
accepts the amount, never calling the callback, so nothing is charged to the
recipient's wallet and no invoice exists afterwards.

Resolves to a `Quote`. `feeMsat` is always zero: the payer pays the recipient's
own invoice and the gateway is never in the money's path, so it has nothing to
charge for. `refusals` lists the addresses ahead of the winner and why each was
passed over. Throws `NoWalletAvailableError` when none would take the amount.

A quote is a probe, not a promise. Whether a wallet returns a *provable* invoice
cannot be known without asking it for one, and asking mints it, so the LUD-21 and
description-hash checks only run at create time. An address that quotes cleanly
can still be refused by `createPayment`.

`metadata` is the LUD-06 metadata string that wallet serves, verbatim. You need
it if you put your own LNURL-pay endpoint in front of the address, which is what
`lnurlPayEndpoint` does for you.

### `gateway.followTrigger(secret, options)`

```ts
const stop = gateway.followTrigger(process.env.WATCH_SECRET, {
  onPayment: (payment) => overlay.show(payment.amountMsat),
});
```

Follows every payment made to one trigger rather than one payment. On connect the
gateway replays the trigger's recent settlements, then streams each new one. It
reconnects on its own until you call the returned function, because a trigger has
no terminal state to stop at. A `paid` event whose preimage does not hash to its
payment hash goes to `onError` and is never handed to `onPayment`.

Events are `TriggerEvent`, not `Payment`. `lnAddress` and `amountMsat` are `null`
when the payment was registered with `watchPayment`, because the gateway was
never told them. What the watcher needs in that case arrives in `sealed`.

### `gateway.watchPayment(params)`

```ts
await gateway.watchPayment({
  paymentHash: resolved.paymentHash,
  verifyUrl: resolved.verifyUrl,
  expiresAt: resolved.expiresAt,
  trigger: process.env.WATCH_SECRET,
  sealed: await encrypt({ amountMsat }),
});
```

Hands over an invoice you obtained yourself. The gateway polls its `verify_url`
and checks preimages against `paymentHash` exactly as it does for one it minted,
but it is given no address and no amount.

That difference is the point. Creating a payment tells the gateway who is being
paid and how much, and a gateway that knows can refuse one recipient rather than
all of them. Told only a hash and a URL, the only refusal left to it is refusing
everyone, which is visible and is what makes leaving cheap.

Be exact about what is hidden and what is not. The verify URL still carries the
recipient's **domain**, so the gateway knows the provider, just not which account
there and not the amount. `sealed` is stored and handed back untouched, so
anything the watcher needs but the gateway should not know goes there.

### `seal(secret, plaintext)` and `unseal(secret, sealed)`

```ts
const sealed = await seal(process.env.SEALING_SECRET, JSON.stringify({ amountMsat }));
const back = await unseal(process.env.SEALING_SECRET, sealed);
```

AES-GCM through WebCrypto, so no dependency and it runs wherever the rest does.
`unseal` returns `null` for a blob sealed with another secret, edited on the way,
or simply not one of ours. It throws only when your own secret is unusable,
because that is your bug rather than someone else's input.

The secret needs **32 characters of randomness, not a passphrase**, and a shorter
one is refused rather than quietly making a weak key. Every watcher of one
trigger holds the same secret: there is no rotation and no per-watcher key.

Plaintext is capped at 3000 bytes, which is what fits the wire's 4096 once
encrypted and encoded, so an oversized payload fails here with a readable message
instead of as a 400 from the gateway.

Do not hand-roll this. A `sealed` value the gateway can read is a fact you told
it, and blind mode exists to not tell it.

Nothing is verified on your behalf here, because there is nothing to verify
against. You resolved the address, so running `proveOrigin` was yours to do.

A hash already watched throws `ProblemError` with status 409 and
`type === PAYMENT_ALREADY_WATCHED`. That is a disclosure control, not
bookkeeping: the payment id is an HMAC of the payment hash and that id is the
read capability, so handing back the stored record would turn a value every payer
holds into a key. Repeating your own registration byte for byte still succeeds,
so a retry after a timeout is fine. `lnurlPayEndpoint` under `blind: true`
already treats it as success, because either way the invoice is being watched.

Pass `tickets: true` and the client mints a short-lived ticket per connection and
puts that in the socket URL instead of the secret. A socket URL gets logged, by
the gateway, by proxies and by the browser, and a POST body does not, so this is
how you keep the secret out of logs. It costs one request before each connect. A
`token` turns it on by itself, because there the ticket is the only way in.

Leave it off for a microcontroller. One hardcoded `wss://` URL and a dumb
reconnect loop is the right shape for an ESP32, where a POST and a JSON parse
before every reconnect is more to go wrong rather than less, and against a
private gateway it can send the bearer as a header the way a browser cannot.
Turn it on for a browser overlay and for anything where the logs matter.

This is the piece a long-lived consumer needs: an OBS overlay, a microcontroller,
a game server. Note it needs a process that stays alive, so it is the one part of
this package that does not fit a serverless function. The serverless answer is
`parseWebhookRequest`.

### `lnurlPayEndpoint(config)`

```ts
export default {
  fetch: lnurlPayEndpoint({
    gateway: new ThunderBridge("https://gateway.example.net"),
    lnAddresses: ["alice@coinos.io", "alice@getalby.com"],
    amountMsat: () => 21_000,
    secret: process.env.CALLBACK_SECRET,
    watchSecret: process.env.WATCH_SECRET,
  }),
};
```

A whole LNURL-pay endpoint as one Fetch handler, so a static QR can point at your
own domain instead of at a gateway. It runs anywhere `Request` and `Response` do:
Deno Deploy, Cloudflare Workers, Hono, Next, Node. It holds no state, so there is
nothing to provision.

`amountMsat` is a plain function called once per payRequest, which is where a
fiat peg or a time-of-day rule goes. The price is published as
`minSendable === maxSendable`, so the payer's wallet has no amount to choose.

Both halves of the flow live on one path: a bare request is the payRequest, a
signed one is the callback. `secret` signs the callback URL, and without it
anyone could call your callback and have it mint invoices on wallets of their
choosing. `watchSecret` groups the payments so `followTrigger` can watch them,
and only its sha256 ever reaches the gateway.

**Why the recipient is pinned at payRequest.** LUD-06 makes the payer's wallet
check the invoice's description hash against the sha256 of the metadata it was
served. The invoice is minted by the recipient's own wallet, so that metadata has
to be the recipient's. If the address list were walked again at callback time and
a different address won, the hashes would differ and the wallet would refuse the
payment. So the winner is quoted at payRequest and pinned into the callback URL.

The cost of that is real and worth knowing: once pinned, a recipient that goes
down before the callback fails that payment, with no fallback behind it.

Pass `blind: true` and the endpoint resolves the address itself and registers the
result with `watchPayment` instead of asking the gateway to mint. The gateway
then never learns the address or the amount. It costs one more round trip and
gives up the gateway's CORS proxying, which a server does not need.

```ts
sealed: {
  secret: process.env.SEALING_SECRET,
  data: (minted) => ({ amountMsat: minted.amountMsat }),
},
```

`data` says what the watcher needs and `secret` encrypts it, so there is no way
to hand the gateway something it can read. If you want your own crypto instead,
skip this handler and call `gateway.watchPayment({ ..., sealed })` directly,
where `sealed` is still just a string.

For the same reason the description shown in the payer's wallet is always the
recipient's, never yours. Only the amount is yours to set.

### `gateway.getPayment(id)`

```ts
const payment = await gateway.getPayment(id);
if (payment === null) return;
```

Reads a payment back. `null` when the gateway has never heard of that id, rather
than a throw. A `paid` payment that fails `isProvablyPaid` throws
`GatewayCheatError` with code `preimage_mismatch`. That is a consistency check on
the gateway's own report and not a proof of payment. The origin proof is not
re-run here, since it was run when the payment was created, so a payment this
process did not create has been proven against nothing at all.

### `gateway.waitForPayment(id, options?)`

```ts
const settled = await gateway.waitForPayment(id, {
  signal: AbortSignal.timeout(600_000),
});
```

Opens a WebSocket and resolves with the payment the first time its status leaves
`pending`, so the result is always `paid` or `expired`. Same `isProvablyPaid`
check as `getPayment`, and the same limit: the frame that arrives is the
gateway's account of the payment, checked only against itself.

A dropped connection is not the end of the wait. The gateway sends the current
state on connect, so a settlement during an outage arrives as the first frame of
the next attempt and nothing is missed. What ends the wait by itself is the
payment: once a frame has arrived its `expires_at` is known, and reconnecting
stops there. Before any frame has arrived there is nothing to bound it, so a few
tries decide it, which is also what keeps a wrong id from becoming a loop. Waits
grow from 3 seconds and are jittered, and a gateway that answers the ticket mint
with a refusal is final rather than retried.

Rejects if the signal aborts, if a frame is not JSON, if a `paid` frame does not
hold together, if nothing ever answered, or if the payment passed its expiry
unreported. There is no default timeout, pass a signal if you want one.

It follows a payment this gateway minted. One registered blind through
`watchPayment` has no address, amount or invoice, so it does not fit the
`Payment` shape this reads, and `followTrigger` is what watches those.

### `proveOrigin(payment, request)`

```ts
import { proveOrigin } from "thunder-bridge";

await proveOrigin(payment, request);
```

The whole trust argument of this package, spelled out under
[The verification chain](#the-verification-chain). The second argument is the
same `CreatePaymentParams` you handed to `createPayment`, never the gateway's
echo of it, so on every comparison at least one side is a value the gateway did
not choose. Resolves when every check passed, throws `GatewayCheatError` on the
first one that failed and `UnverifiedRecipientError` when a check could not be
run at all. Call it directly when you built the payment some other way, for
example from a webhook body or from your own `fetch` against the gateway.

### `proveSettlement(payment, request)`

```ts
import { proveSettlement } from "thunder-bridge";

const preimage = await proveSettlement(payment, request);
if (preimage !== null) {
  fulfil(payment.id);
}
```

The only call here that is evidence the money arrived. It runs the full origin
proof first, because a `verifyUrl` the gateway made up would otherwise be
answering for itself, and then reads `settled` and `preimage` from that url,
which check 4 has just pinned to the recipient's own callback origin.

Returns the preimage when the recipient's server reports the invoice settled and
releases one. Returns `null` when the server answers without reporting a settled
invoice and a preimage, which is the ordinary answer for an invoice nobody has
paid yet, so it is safe to call on a timer. Throws
`GatewayCheatError("preimage_mismatch")` when the released preimage does not
hash to the payment hash, and anything `proveOrigin` throws, since it runs
`proveOrigin` first. Three fetches per call, all of them at the recipient's
domain, and nothing is cached between calls.

### `isProvablyPaid(payment)`

```ts
if (!isProvablyPaid(webhookPayment)) {
  report(`payment ${webhookPayment.id} does not even agree with itself`);
}
```

A sanity check, not a proof, and the name is older than the distinction. True
when the payment says `paid`, carries a preimage, its `bolt11` carries the
payment hash the record claims, and that preimage hashes to it. Synchronous, no
network, and every value it compares came out of the same gateway message. A
gateway willing to invent a preimage, hash it, and mint an invoice around that
hash passes.

It is worth running: it rejects a status flipped to `paid` without a preimage
that fits, a truncated preimage, and a record whose `bolt11` was swapped for
another. It is not worth acting on. Decide to ship goods on `proveSettlement`,
which asks the recipient rather than the gateway. This is what the client runs
for you on `getPayment` and `waitForPayment`, and it is the limit of what those
two can promise.

### `preimageMatchesHash(preimage, paymentHash)`

```ts
preimageMatchesHash(settled.preimage ?? "", settled.paymentHash);
```

True when `preimage` is the secret behind `paymentHash`. Non-hex or odd-length
input is false rather than a throw. Both arguments are compared
case-insensitively.

### `decodeInvoice(bolt11)`

```ts
const invoice = decodeInvoice(payment.bolt11);
```

Returns `{ paymentHash, descriptionHash, amountMsat }`, every field `string | null`
except `amountMsat` which is `number | null`. Hand-rolled bech32, no library, no
signature recovery. Anything it cannot read, including a BOLT12 offer, comes back
with all three fields null rather than throwing, so check for null before
comparing.

### `invoiceToSvg(destination, options?)`

```ts
const svg = invoiceToSvg(payment.bolt11, { size: 320, color: "#1a1a2e" });
const jar = invoiceToSvg("charter@blink.sv");
```

An SVG string, no canvas and no DOM required. `size` defaults to 256 and `color`
to `#000`. An invoice is encoded as `LIGHTNING:` plus the uppercased invoice,
which is what wallets expect and what lets the QR use alphanumeric mode. A
lightning address keeps the case it was given, because the part before the
at-sign is case sensitive and the at-sign is outside the alphanumeric set
anyway, so uppercasing one would only risk breaking it. A
`color` that is not a hex literal, an `rgb()` or `rgba()` value, or a bare colour
name throws, because it would otherwise be written straight into the markup.
Each alternative in that pattern is anchored at both ends, so a value that is a
legal colour followed by more markup, such as `rgba(0)" onload="alert(1)`, is
refused rather than allowed to close the `fill` attribute early.

### `invoiceToDataUrl(destination, options?)`

```ts
const src = invoiceToDataUrl(payment.bolt11);
```

The same SVG, percent-encoded as a `data:image/svg+xml,` URL for an `<img>` tag.

### `lnurlToSvg(endpoint, options?)` and `lnurlToDataUrl(endpoint, options?)`

```ts
const svg = lnurlToSvg("https://agora.gripe/tip", { size: 320 });
```

The QR for a trigger, meaning the URL you mounted `lnurlPayEndpoint` on. It
carries no invoice and nothing in it expires, so this is the code a tip jar
prints once and an overlay leaves on screen all stream. The endpoint is bech32
encoded as the `LNURL1` string LUD-01 defines and uppercased, which is the form
that spec asks a QR to carry and the one every LNURL wallet has read for years.
An input that is not an http or https URL throws rather than becoming a QR
nobody can pay.

`toLnurl(endpoint)` is the same encoding on its own, for a `lightning:` link or a
page that renders its own codes.

LUD-17 would let you write `lnurlp://agora.gripe/tip` instead, and its own text
calls bech32 a mistake, but wallet support for it is recent enough that the
bech32 form is still what scans everywhere. If your trigger sits at
`/.well-known/lnurlp/<name>` then it is also a lightning address, and
`invoiceToSvg("<name>@yourdomain")` gives a QR people can read and type.

### `parseWebhookRequest(request, secret)`

```ts
const payment = await parseWebhookRequest(request, secret);
```

Takes a Fetch API `Request`, reads the `x-signature` header, verifies it against
the raw body and parses. `null` on a missing signature, on a bad signature, and
on a correctly signed body that is not JSON, so `null` always means do not trust
this and never means this was fine but empty. Use it in Hono, Next, SvelteKit,
Cloudflare Workers, Deno and Bun.

### `parseWebhook(body, signature, secret)`

```ts
const payment = await parseWebhook(rawBody, signature, secret);
```

The same thing for frameworks that hand you a raw body and headers separately,
with the same three ways of returning `null`. `body` is a `string` or a
`Uint8Array`, and it must be the bytes as received. Parsed and re-serialised JSON
will not verify.

### `verifyWebhookSignature(body, signature, secret)`

```ts
if (!(await verifyWebhookSignature(rawBody, signature, secret))) return;
```

The signature check on its own, for when you want to parse the body yourself.
The `sha256=` prefix is optional and the comparison is constant time.

### Error classes

`GatewayCheatError` carries `code: GatewayCheatCode` and `paymentId`.
`UnverifiedRecipientError` carries `lnAddress` and `paymentId`. `ProblemError`
carries `type`, `title`, `status` and `detail`, and `status` is always the HTTP
status of the response: a problem document naming a different one does not
override it. `NoWalletAvailableError` extends `ProblemError` and adds
`wallets: WalletFailure[]`, always an array and empty when the gateway sent
something that is not one, so test for it before you test for `ProblemError`.
`IdempotencyConflictError` also extends `ProblemError` and adds
`conflict: IdempotencyConflict`, so test for it first too.

### Types

`Payment`, `PaymentStatus`, `CreatePaymentParams`, `Quote`, `CreateQuoteParams`,
`WalletFailure`, `WalletReason`, `GatewayCheatCode`, `IdempotencyConflict`,
`Invoice`, `QrOptions`, `ThunderBridgeOptions`, `CreateOptions`, `FollowOptions`,
`TriggerConfig`, `TriggerEvent`, `WatchPaymentParams`, `Minted` and `WaitOptions`
are all exported as types.

```ts
interface Payment {
  id: string;
  lnAddress: string;
  amountMsat: number;
  status: "pending" | "paid" | "expired";
  paymentHash: string;
  bolt11: string;
  preimage: string | null;
  expiresAt: number;
  createdAt: number;
  verifyUrl: string;
}
```

`lnAddress` is the one address out of your list that actually served the
invoice. `expiresAt` and `createdAt` are unix seconds. `preimage` is non-null
only once the status is `paid`.

```ts
interface Quote {
  lnAddress: string;
  amountMsat: number;
  feeMsat: number;
  minMsat: number;
  maxMsat: number;
  metadata: string;
  refusals: WalletFailure[];
}
```

`minMsat` and `maxMsat` are the range that wallet accepts, so a quote also tells
you what else you could have asked it for.

## The verification chain

`proveOrigin(payment, request)` runs five checks in order and stops at the first
failure. The first two need no network at all. The rest go to the recipient's own
domain, never back to the gateway, which is the point: a gateway cannot be the
witness to its own honesty. `request` is your own `CreatePaymentParams`, so
every comparison below has your value on one side of it.

**1. The chosen address is one you listed.** `payment.lnAddress` must appear in
`request.lnAddresses`, compared case-insensitively. Rules out the gateway paying
an address you never named, its own included. The entry that matched is then the
one the rest of the chain is run against: your `user@domain` becomes
`https://domain/.well-known/lnurlp/user` under LUD-16, with the domain lowercased
because host names are case-insensitive and the local part left exactly as you
wrote it. The gateway's spelling of the address is used to find the match and
never to build the url, so a gateway cannot aim the proof at a different account
on a provider that treats the local part as case-sensitive. Fails with
`address_not_requested`. No network.

**2. The invoice is for the amount you asked, and it is the invoice the record
describes.** Three local comparisons in order. `payment.amountMsat` must equal
`request.amountMsat`, so the gateway's own summary matches your order. The BOLT11
is then decoded in-package, and its payment hash must equal
`payment.paymentHash`. Its amount must equal `request.amountMsat`, your figure
again and not the gateway's. The hash check rules out a record that describes one
invoice while the `bolt11` field carries another, which would otherwise let a
later preimage check pass against a hash nobody paid. The amount checks rule out
being billed more than you asked for by a payment that is perfectly consistent
with itself, being shown a receipt for one figure and a QR code for another, and
an amountless invoice that a payer's wallet would let them fill in themselves.
Fails with `amount_mismatch` or `hash_mismatch`. No network.

**3. The invoice's description hash pins it to that user.** The well-known url
built in check 1 is fetched, and the sha256 of the `metadata` it serves must
equal the invoice's description hash under LUD-06. Rules out an invoice minted by
a different account on the same custodial domain, which is the substitution a
node id alone cannot see: on a shared custodian every account sits behind one
node. Fails with `description_hash_mismatch`, or with
`UnverifiedRecipientError` when the endpoint served no usable payRequest.

**4. The proof url belongs to the recipient.** `payment.verifyUrl` must share an
origin with the `callback` that same endpoint publishes. Rules out a settlement
proof pointed at the gateway or anywhere else it controls, which would let it
sign off on its own payments. Fails with `verify_url_foreign`.

**5. The recipient's own server says it issued this invoice.** A GET to
`verifyUrl` under LUD-21 echoes `pr`, and it must equal `payment.bolt11` byte for
byte, case aside. Rules out everything the earlier checks could still miss,
because the answer now comes from the recipient's server rather than from the
gateway. Fails with `invoice_not_issued`.

### Proving the money arrived

Those five checks are about an invoice, not about a payment. They prove that what
you are putting in front of a payer is the recipient's own invoice for the right
amount. They say nothing about whether anybody paid it, and the two answers to
that question are not the same answer.

`isProvablyPaid`, which the client runs for you on `getPayment` and
`waitForPayment`, asks whether the gateway's report contradicts itself: a `paid`
status, a preimage, and a `bolt11` whose payment hash that preimage opens. All
three values arrive from the gateway in one message, so the check is internal
consistency and nothing more. A gateway that generates a preimage, hashes it, and
builds an invoice around that hash passes it. It catches breakage and
carelessness, not an operator who means it.

`proveSettlement` asks the recipient. It re-runs the origin proof, which is what
ties `verifyUrl` to the recipient's own callback origin instead of to somewhere
the gateway picked, then reads that url. Under LUD-21 the recipient's server
releases the preimage once the invoice has actually been claimed, so a preimage
from there was released by the party that got paid, and it is checked against the
payment hash before you see it. `null` means the recipient's own server is not
claiming the money arrived, whatever the gateway says.

Use `isProvablyPaid` to throw out a record that is obviously wrong. Use
`proveSettlement` before you part with anything.

### The host guard

Every outbound url in the chain must be public https. The guard refuses loopback,
link-local, the RFC 1918 ranges, carrier-grade NAT, unique local addresses, and
IPv4-mapped IPv6 that unwraps into any of those IPv4 ranges. It also refuses a
host with no dot in it such as `nas`, the
trailing-dot form `localhost.`, and anything whose last label is `local`,
`internal`, `lan`, `arpa`, `test` or `invalid`. A lightning address pointing at
your own network is never fetched, and neither is a `verifyUrl` on a private host
that the recipient's own callback vouches for.

It vets the first hop only. See [What is still trusted](#what-is-still-trusted).

## What is still trusted

Short, and worth saying out loud rather than burying.

**The gateway chooses which of your addresses gets paid.** It is supposed to
take the first that works, and nothing here can tell a genuine failure of the
first from a preference for the third. What it cannot do is pick an address that
is not on the list, so the money still lands somewhere you named.

**The gateway can refuse you.** Availability is not provable. It can answer 503,
answer nothing, or serve one caller and not another. Every check in this package
is about an invoice you were given, none is about an invoice you were not.

**The gateway sees your request.** The address list, the amount, the webhook url
and the webhook secret all pass through it, because it has to make the calls.
Treat the secret as shared with the gateway, and treat the address list as
public. Nothing here is a privacy layer, and the payer sees the recipient's real
invoice and node either way.

**Everything the gateway says about a settlement, until you ask the recipient.**
The status, the preimage and the body a webhook delivers are the gateway's own
account. `isProvablyPaid` only asks whether that account holds together, and a
gateway that fabricates the whole record passes it. `proveSettlement` is the one
call that goes and asks somebody else. If a payment matters, ask.

**The host guard vets the first hop and no further.** Both fetches use the
runtime's default redirect handling, so a public https host that answers a
request with a 302 to a private address is followed there. The guard runs on the
url the package is about to request, not on where that request ends up. If a
request into your own network would matter, keep the egress control outside this
package: a proxy, a network policy, or a `fetch` of your own that refuses
redirects.

**A colluding custodian defeats all of it.** The proof is the recipient's
server's word, made cryptographic. If the recipient's wallet provider and the
gateway are the same party, or are cooperating, then the party holding the money
is also the party serving the metadata, publishing the callback and answering the
verify requests. Every check would pass, `proveSettlement` included, and nothing
here would help. This protects a payer against the gateway, not against the
recipient's own custodian.

**TLS and DNS for the recipient's domain.** The whole chain hangs off reaching
the real `domain`, so whoever can forge a certificate for it can forge the proof.

**An address is not a person.** This proves an invoice belongs to an address. It
never proves the address belongs to whoever you think. Vouching for the address
stays with whoever published it.

**A payment read cold is only as pinned as its creation.** `getPayment` and
`waitForPayment` check the preimage against the `paymentHash` in the same record.
It is `proveOrigin` at creation, against the request you wrote, that tied that
hash to an invoice the recipient issued. If you fetch a payment id you never
created and never proved, you are checking the gateway's numbers against each
other and nothing more. Run `proveOrigin` with the request that created it, or
`proveSettlement` if you also need to know it was paid, which means storing the
request alongside the payment id.

## Errors

Every failure from the gateway is an RFC 9457 problem document served as
`application/problem+json`. Branch on `type`, never on prose. One type maps to
its own class, the rest arrive as `ProblemError` with `type` intact.

| `type` | Status | Class | When |
|---|---|---|---|
| `urn:problem-type:thunder-bridge-direct:invalid-request` | 400 | `ProblemError` | the body or one of its fields could not be read, `detail` names the field |
| `urn:problem-type:thunder-bridge-direct:no-wallet-available` | 400, 422, 502 | `NoWalletAvailableError` | the list was walked and nothing served, `wallets` says why each one failed |
| `about:blank` | 404 | none | unknown payment, `getPayment` returns `null` instead of throwing |
| `about:blank` | 503 | `ProblemError` | the instance is watching as many payments as it can |
| `about:blank` | 500 | `ProblemError` | the gateway broke |

The `Status` column is what the transport carried, and it is what `error.status`
reports. A document that names a different status in its own body does not get to
override it.

The status on `no-wallet-available` follows the worst wallet, so a retry is never
advised in vain: 502 if any wallet was merely unreachable, else 422 if any
refused permanently, else 400.

Each entry in `wallets` is a `WalletFailure` with an `address` and a `reason`,
in the order the addresses were tried. The array is empty rather than absent when
the gateway sends a `wallets` field that is not a list.

| `reason` | What it means | Do |
|---|---|---|
| `address-unusable` | not a lightning address, or its domain is not a public https host | fix the address |
| `unreachable` | no usable payRequest or invoice came back, which also covers an unknown user | retry, or check the wallet |
| `amount-not-accepted` | the amount is outside that wallet's min and max | change the amount |
| `cannot-prove-delivery` | no LUD-21 `verify` url, or a provider known never to release a preimage | use another provider |
| `invoice-refused` | it answered with an invoice the gateway will not accept: wrong amount, unbound metadata, or undecodable | report it, use another wallet |

`GatewayCheatError` is different in kind. It does not report a request that
failed, it reports a gateway that demonstrably misbehaved, and `code` names the
check that caught it.

| `code` | The gateway did this |
|---|---|
| `address_not_requested` | returned an address that was not on the list you passed |
| `hash_mismatch` | the `bolt11` does not carry the `paymentHash` it reports |
| `amount_mismatch` | reported, or invoiced, an amount other than the `amountMsat` you asked for |
| `description_hash_mismatch` | the invoice is not bound to that user's LNURL metadata |
| `verify_url_foreign` | the `verifyUrl` is not on the recipient's callback origin |
| `invoice_not_issued` | the recipient's own server does not echo this invoice |
| `preimage_mismatch` | reported `paid` with a preimage that does not open the invoice, or the recipient released one that does not |

`UnverifiedRecipientError` is deliberately not in that table. It means a check
could not be run, because the recipient's server was down, timed out, answered
with something unreadable, or the browser was blocked by CORS. It is not an
accusation, and it is also not a clean bill of health. Decide what you want to
do with an unproven invoice, and decide it explicitly.

```ts
import {
  GatewayCheatError,
  NoWalletAvailableError,
  ProblemError,
  ThunderBridge,
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

Pass `webhookUrl` and optionally `webhookSecret` when you create a payment. Once
it reaches `paid` the gateway POSTs the same JSON the API returns, so the body is
a `Payment`. With a secret set it carries `x-signature: sha256=<hmac>` over the
raw body, HMAC-SHA256. Three attempts, five seconds apart, then it gives up. An
invoice that expires fires nothing.

Delivery is at-least-once, so deduplicate on `id`.

```ts
import { parseWebhookRequest, proveSettlement } from "thunder-bridge";

app.post("/hooks/paid", async (context) => {
  const payment = await parseWebhookRequest(context.req.raw, secret);
  if (payment === null) return context.text("bad signature", 401);

  const preimage = await proveSettlement(payment, requestFor(payment.id));
  if (preimage === null) return context.text("the recipient has not seen it", 402);

  await fulfil(payment.id);
  return context.text("ok");
});
```

The signature proves the body came from someone holding your secret. It does not
prove the payment happened, since the gateway holds that secret too. Neither does
`isProvablyPaid`: the gateway wrote every field in that body, so all the check
can say is that the body does not contradict itself. The proof is
`proveSettlement`, and it needs the request you originally sent, which is why
`requestFor` above is your own lookup from a payment id back to the
`CreatePaymentParams` you stored when you created it.

For a framework that hands you the raw body and headers separately, use
`parseWebhook`. The body must be the bytes as received, so mount a raw body
parser on that route and not a JSON one. The settlement proof belongs here too,
and is left out only to keep the raw body point visible.

```ts
import express from "express";
import { parseWebhook } from "thunder-bridge";

app.post("/hooks/paid", express.raw({ type: "application/json" }), async (request, response) => {
  const payment = await parseWebhook(request.body, request.get("x-signature") ?? "", secret);
  if (payment === null) {
    response.sendStatus(401);
    return;
  }
  response.sendStatus(200);
});
```

## QR codes

Every renderer returns a string, so they work on a server, in a worker and in a
browser with no canvas involved.

```ts
import { invoiceToSvg, lnurlToSvg } from "thunder-bridge";

const toPay = invoiceToSvg(payment.bolt11, { size: 320, color: "#1a1a2e" });
const tipJar = lnurlToSvg("https://agora.gripe/tip");
```

An invoice, a lightning address and your own trigger endpoint each have their own
encoding rules, spelled out under [`invoiceToSvg`](#invoicetosvgdestination-options)
and [`lnurlToSvg`](#lnurltosvgendpoint-options-and-lnurltodataurlendpoint-options).
A BOLT12 offer is not handled, because this gateway never returns one.

## Requirements

Node 22 or newer. `waitForPayment` and `followTrigger` use the global
`WebSocket`, which Node only exposes from 22 onwards, and there is no fallback
and no optional dependency to install. Everything else in the package works on
any runtime with `fetch` and `crypto.subtle`, so an older Node can still create
payments, quote them, verify them, poll `getPayment`, serve `lnurlPayEndpoint`
and handle webhooks.

On a serverless runtime, treat the two sockets as unavailable whatever the
platform supports: an invocation ends when it answers, and a payment can live for
weeks. `lnurlPayEndpoint` is built for that world and holds no state, and
`parseWebhookRequest` is how settlement reaches you there.

TypeScript is bundled. The package ships ESM and CJS builds with types for both.

## Development

`npm test` runs the vitest suite. `npm run typecheck` type-checks `src` against
`tsconfig.json` and then `src` and `test` together against `tsconfig.test.json`,
so a test file that stops compiling fails the same gate the library does.
`npm run build` emits ESM, CJS and the two declaration flavours with tsup.

## License

MIT
