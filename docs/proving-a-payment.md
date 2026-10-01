# Proving a payment

What each proof and each rail guarantees, for a caller deciding whether money arrived.
Install and quickstart are in the [SDK README](../sdk/README.md).

The gateway is the thunder-bridge server that watches payments and reports when they
settle. A rail is one way to pay: Lightning, NWC or a bank transfer. A payment settles
when a preimage is released, the secret whose sha256 is the payment hash. A verify URL
answers whether one payment settled, with the `settled` and `preimage` fields LUD-21
defines. A verify endpoint is a verify URL you serve yourself.

## How each rail is verified

Every rail ends with a preimage that has to hash to the payment hash the gateway was
given. The rails differ in who obtains the invoice, who is asked for the preimage, and
which side checks it.

By default the gateway watches a payment. It is handed a payment hash, an expiry and
the URL of a verify endpoint of yours, and no address or amount. That is `verifyThrough`
on `rails.lightning`, `rails.nwc` and `serve.lnurlPay`, and the verify URL on
`rails.bank`. With `gatewayMints: true` on `rails.lightning` or `serve.lnurlPay` the
gateway mints instead: it resolves the address, obtains the invoice and polls the
wallet itself. Minting is for a client with no server of its own.

| `rails.lightning` with `verifyThrough` | invoice: you, with `invoiceFrom` on your server |
|---|---|
| the gateway is told | a hash, an expiry and your URL, with the wallet's verify URL sealed inside |
| the invoice is checked by | `invoiceFrom` as it resolves: the metadata has to name the address, the invoice has to carry the amount and the description hash of that metadata |
| the gateway probes first | a GET that must answer a boolean `settled`, then a signed POST of a nonce it must echo |
| the gateway polls | your `serve.lightningVerify` endpoint |
| `settled` comes from | your endpoint, which unseals the wallet's URL, asks the wallet and relays the answer |
| the pace is set by | you, `pollEverySecs`, 5 seconds by default |

| `rails.lightning` with `gatewayMints` | invoice: the gateway, at the recipient's LNURL callback |
|---|---|
| the gateway is told | the address list and the amount. It resolves the address and hands back the hash and the wallet's `verify` URL |
| the invoice is checked by | `mint` on your side, which runs `proveOrigin` against the recipient's own domain, see [The proof](#the-proof) |
| the gateway probes first | nothing, it resolved the address itself |
| the gateway polls | the wallet, directly |
| `settled` comes from | the wallet releasing its preimage |
| the pace is set by | the wallet's `Cache-Control: max-age`, or the gateway's own schedule when it sends none |

| `rails.nwc` | invoice: your own wallet, over NIP-47 `make_invoice` |
|---|---|
| the gateway is told | a hash, an expiry and your URL, with the hash sealed inside |
| the invoice is checked by | your rail, which refuses an invoice for another amount. The wallet is yours |
| the gateway probes first | the same GET and signed nonce |
| the gateway polls | your `serve.nwcVerify` endpoint |
| `settled` comes from | `lookup_invoice`, refused unless the wallet's own key signed the answer |
| the pace is set by | you, `pollEverySecs`, 5 seconds by default |

| `rails.bank` | invoice: none |
|---|---|
| the gateway is told | a hash, an expiry and your URL, whose query is one sealed blob naming neither the amount, the reference nor the account |
| the invoice is checked by | nobody, there is none |
| the gateway probes first | the same GET and signed nonce |
| the gateway polls | your `serve.bankVerify` endpoint |
| `settled` comes from | a `Statement` credit that pays the order, by the rule in [Which transfer counts as paying](#which-transfer-counts-as-paying) |
| the pace is set by | the statement: `fioStatement` asks for thirty seconds divided by its tokens, and `pollEverySecs` overrides it |

### Who probes the verify URL

The gateway probes the verify URL of a watched payment before it accepts the watch. A
GET must answer a boolean `settled`, or the watch fails with `424`
`verify-unconfirmed`. A signed POST then carries a nonce the URL must echo, or the
watch fails with `424` `verify-unconsented`. Deploy the endpoint before you register
it. The challenge stops a caller aiming the gateway at a server that never asked to be
polled for up to thirty days. It runs unless the operator set `VERIFY_CHALLENGE=0`.
While it runs, a bare wallet `verify` URL cannot be handed to `watch`, because a
wallet does not echo a nonce.

On a minted payment the gateway resolved the address itself, so it runs neither probe,
and `proveOrigin` on your side is the whole defence.

### What a preimage proves

The same thing on every rail: the server holding the secret says the money arrived,
and nobody else can forge that claim. On the bank rail the preimage is an HMAC under
your secret. That proves as much as a wallet's preimage, which the wallet minted too.
A preimage rules out a gateway inventing a settlement. It does not rule out a
recipient lying about one, so it protects a payer against the operator, not against
the person being paid.

### What each one costs you

**`rails.lightning` with `gatewayMints`**

- a gateway that mints. Minting is off unless its operator set `MINTING=1`, see
  [Configuration](../README.md#configuration). A gateway that does not mint refuses
  with `403` `verify-host-refused`
- the gateway holds the address and the amount, so your order book is readable from
  its logs
- it polls the wallet directly, which puts the recipient's provider in its logs and in
  front of its peers
- the wallet's `Cache-Control` sets the poll pace, so how fast a settlement is noticed
  is not yours to decide

**`rails.lightning` with `verifyThrough`**

- a service of your own that has to stay up, so a browser-only integration has to use
  `gatewayMints` instead
- one long-lived sealing secret. Sealing refuses a secret under 32 characters, so
  `openssl rand -hex 16` is the shortest that works
- your endpoint being down means the gateway cannot verify, and the payment stays
  `pending`
- a wallet your endpoint cannot reach answers `502`, so the gateway retries instead of
  concluding the invoice went unpaid. The body still reads `settled: false`, and the
  status separates "could not ask" from "asked, and no"

**`rails.nwc`**

- an NWC connection to your own wallet, and the nostr relays behind it
- **scope the connection to `make_invoice` and `lookup_invoice`, never
  `pay_invoice`.** It is a key that spends, and a leak with the wrong scope drains the
  wallet. ZEUS, Alby Hub and Blink each issue one connection per app, with its own
  permissions and budget
- no relay reachable means no verification

**`rails.bank`**

- a gateway of your own. `rails.bank` refuses a gateway that does not answer `401` to
  a caller with no token, unless you pass `allowPublicGateway: true`. The sealed verify
  URL names nothing, but the operator still learns every watch you place, and anyone
  holding the URL can ask whether that order was paid
- the secret is the entire proof. **Lose it and every past proof is gone**, because
  each preimage is derived from it

### Which transfer counts as paying

`serve.bankVerify` counts a credit as paying an order when the amount and the currency
match and the reference appears as a whole word in what the payer wrote,
case-insensitively. When the reference contains a digit, a credit that also names a
second reference of the same shape pays neither order, because one payment cannot pay
two. With `fioStatement`, what the payer wrote is four Fio columns joined: the variable
symbol, the user identification, the message for the recipient and the payer's own
reference. A bank that prefixes, appends or moves the text between those fields still
settles.

Two shapes do not settle, and leave a payment `pending` while the money is already in
the account. Test both against the banks your payers use before you promise anybody
this rail.

- a bank that truncates the reference, because the match looks for the reference
  inside what the bank forwarded and not the other way round
- a payer whose bank forwards only a numeric variable symbol, because an alphanumeric
  reference cannot travel in a numeric field, and the `X-VS` on the QR is not matched
  in its place

Neither has been seen with Fio, which forwards the message untouched.

## Your verify endpoint

On the default path the gateway polls your endpoint and never the wallet. It never
polls `blink.sv` or `coinos.io` itself, so its logs, its ledger and its peers never
learn which provider your recipient uses.

```ts
import { msat, ThunderBridge } from "thunder-bridge";

declare const gateway: ThunderBridge;

const RELAY_SECRET = process.env.RELAY_SECRET as string;

export const serveVerify = gateway.serve.lightningVerify({
  secret: RELAY_SECRET,
  pollEverySecs: 5,
});

export const rail = gateway.rails.lightning({
  paidTo: ["you@blink.sv"],
  amount: (order) => msat(order.amountMinor * 40),
  verifyThrough: { endpoint: "https://shop.example/verify/lightning", secret: RELAY_SECRET },
});
```

Mount the handler at `endpoint`. It is a plain Fetch handler. The rail seals the
wallet's verify URL into the query with your secret, so the gateway stores and
replicates a blob it cannot read. Your endpoint relays rather than decides: the
preimage still comes from the recipient's wallet and still has to hash to the payment
hash, so your endpoint is not a party anyone has to trust.

### NWC, for a wallet with no LUD-21 address

`rails.nwc` puts your own wallet behind the same arrangement. The wallet answers over
[NIP-47](https://github.com/nostr-protocol/nips/blob/master/47.md) instead of over an
address, so a recipient whose provider publishes no `verify`, or one that releases no
preimage, is watchable anyway.

```ts
import { msat, ThunderBridge } from "thunder-bridge";
import { nwcConnection } from "thunder-bridge/nwc";

declare const gateway: ThunderBridge;

const NWC_SECRET = process.env.NWC_SECRET as string;
const connection = nwcConnection(process.env.NWC_URI as string);

export const serveVerify = gateway.serve.nwcVerify({ connection, secret: NWC_SECRET });

export const rail = gateway.rails.nwc({
  connection,
  amount: (order) => msat(order.amountMinor * 40),
  verifyThrough: { endpoint: "https://shop.example/verify/nwc", secret: NWC_SECRET },
});
```

`make_invoice` mints the invoice and `lookup_invoice` reads the preimage back. The rail
seals the payment hash into the query, which stops a stranger driving your wallet
through your own handler. The gateway never holds the connection, the relays or the
wallet key.

### How often the gateway asks

Your endpoint sets the pace. Every verify endpoint answers with `Cache-Control:
max-age`, and the gateway uses that interval for every payment on your host.
`serve.bankVerify` sends how often its statement can have anything new. Fio lets one
token read once every thirty seconds, so `fioStatement` with three tokens of one
account asks for ten and uses the tokens in turn. A `Statement` that does not say gets
thirty. Pass `iban` to `fioStatement` and a token for another account is refused
instead of lending that account's credits to yours. Set `pollEverySecs` higher for a
statement that moves once an hour, because polling it every five seconds only burns
your rate limit.

```ts
import { ThunderBridge } from "thunder-bridge";
import { fioStatement } from "thunder-bridge/bank";

declare const gateway: ThunderBridge;

export const serveBankVerify = gateway.serve.bankVerify({
  secret: process.env.BANK_SECRET as string,
  iban: "CZ6508000000192000145399",
  statement: fioStatement({
    token: [process.env.FIO_TOKEN_1 as string, process.env.FIO_TOKEN_2 as string],
    iban: "CZ6508000000192000145399",
  }),
});
```

The gateway abandons a poll after 15 seconds. On an NWC connection `askTimeoutMs`, 10
seconds by default, is one deadline across every relay, so a connection listing four
relays still answers inside that window.

## The proof

A minted payment comes with a proof that its invoice is the recipient's own.
`proveOrigin(payment, asked)` runs five checks and stops at the first failure. `mint`
runs it with checks 6 and 7 as well. The first two need no network. The rest ask the
recipient's own domain and never the gateway, because a gateway cannot witness its own
honesty.

| # | Check | Rules out | Fails with |
|---|---|---|---|
| 1 | the chosen address is one you listed, compared case-insensitively | the gateway paying an address you never named, its own included | `address_not_requested` |
| 2 | the invoice decodes to the amount you asked for and the payment hash the record reports | being billed more than you asked, or a record describing one invoice while carrying another | `amount_mismatch`, `hash_mismatch` |
| 3 | that `metadata` names the address as its `text/identifier` or `text/email`, as LUD-16 requires, and the invoice's description hash equals its sha256, under LUD-06 | an invoice minted by a different account on the same custodial domain, even one that serves every account the same text | `description_hash_mismatch`, or `UnverifiedRecipientError` for metadata that names nobody |
| 4 | `verifyUrl` shares an origin with the `callback` that endpoint publishes | a settlement proof pointed anywhere the gateway controls | `verify_url_foreign` |
| 5 | a GET to `verifyUrl` echoes `pr`, and it equals `bolt11` ignoring case | everything the earlier checks could still miss, because the answer now comes from the recipient | `invoice_not_issued` |
| 6 | at mint, the invoice was issued no more than five minutes before you asked, and the recipient does not already report it settled | an old invoice, or one somebody already paid, handed out as yours | `invoice_stale`, `invoice_settled` |
| 7 | at mint, no other order this client is still waiting on was handed the same payment hash | one invoice sold twice, so that one payment settles two orders | `invoice_reused` |

Check 7 remembers hashes for as long as their invoices are payable and no longer, and
only inside one process. Store your orders under their payment hash and your own
storage refuses the same duplicate across restarts and across tills.

Check 1 also builds the URL the rest of the chain uses: your `user@domain` becomes
`https://domain/.well-known/lnurlp/user` under LUD-16, with the domain lowercased and
the local part left as you wrote it. The gateway's spelling is used to find the match
and never to build the URL, so it cannot aim the proof at a different account on a
provider that treats the local part as case-sensitive.

### Origin is not settlement

The five checks prove an invoice is the recipient's own invoice for the right amount.
They say nothing about whether anybody paid it, and the two calls that answer that are
not equivalent.

`agreesWithItself` asks whether a report contradicts itself: a `paid` status, a
preimage, and a `bolt11` whose payment hash that preimage opens. All three values
arrive from the gateway in one message, so this is internal consistency and nothing
more. A gateway that generates a preimage, hashes it and builds an invoice around that
hash passes it. It catches breakage and carelessness, not an operator who means it.

`proveSettlement` asks the recipient. It re-runs the origin proof, which ties
`verifyUrl` to the recipient's own callback origin, then reads that URL. `null` means
the recipient's own server is not claiming the money arrived, whatever the gateway
says.

Use `agreesWithItself` to throw out a record that is obviously wrong. Use
`proveSettlement`, or `prove` on a payment request, before you part with anything.

### The host guard

Every URL the proof fetches must be public https. The guard judges the host by its
name or IP literal and refuses loopback, link-local, private, carrier-grade NAT,
documentation, benchmarking and multicast ranges, unique local IPv6, and IPv6 that
embeds a refused IPv4 address. It also refuses a host with no dot, such as `nas`, and a
host whose last label is `localhost`, `local`, `internal`, `lan`, `arpa`, `test` or
`invalid`, with or without a trailing dot. It reads an answer up to 256 KiB and no
further. How redirects are followed is under
[Who you still have to trust](#who-you-still-have-to-trust).

## Which call checks what

A gateway can make up a preimage and hash pair that agrees with itself. It cannot make
up one that agrees with a payment hash you already hold. What you may act on without
asking anyone else depends on what a claim was checked against.

| You hear it through | What the claim is checked against |
| --- | --- |
| `payment`, `settled`, `firstSettled`, `paid()` on a `requestPayment`, and `Gateways.settled` | the `{ id, paymentHash }` you hold. Another payment, another hash, or a preimage that does not hash to yours throws `GatewayCheatError` |
| `serve.webhook`, `serve.readSettlement`, `serve.readPayment` | the gateway's key, the timestamp, the URL it was sent to, and the preimage against the hash in the same body. Find your order by that hash before you act, so a pair the gateway invented finds nothing |
| `payments`, `follow` | the report itself. An entry claiming paid whose preimage does not hash to its own hash is left out of `payments` and reaches `follow`'s `onError` rather than `onPayment` |
| `agreesWithItself` | the report itself, and nothing you hold, so a gateway that invents a preimage and names its hash passes it |
| `proveSettlement` | the recipient's own verify URL, after the origin proof, so the gateway is not asked at all |

## Paying through an operator who fronts the liquidity

A recipient with no inbound liquidity cannot be paid at all. An operator with a node
can stand in the middle without holding anything. It takes the recipient's own invoice
and mints a **hold invoice on the same payment hash** for the amount plus a fee. It can
settle its own invoice only by revealing the preimage it learned from paying the
recipient. Claiming and delivering are one act, so there is no moment where it keeps
the money and walks away.

This SDK does not wrap. `proveWrapped` checks a wrap somebody else offers. The NIP-47
primitives an operator would build one from, `nwcHoldInvoice` and `nwcPay`, are on
`thunder-bridge/nwc`, and nothing in the SDK drives them.

```ts
import { invoiceFrom, msat, proveWrapped } from "thunder-bridge";

declare function wrapThrough(bolt11: string): Promise<string>;

const real = await invoiceFrom(["you@blink.sv"], msat(21_000_000));
const wrapped = await wrapThrough(real.bolt11);

proveWrapped(wrapped, real.bolt11);
```

`proveWrapped` compares two invoices and asks nobody anything, so it runs in a browser.
It says whether a wrap is honest, not whether either invoice was paid. It throws
`WrapRefusedError` with one of these codes.

| Refused when | `code` |
|---|---|
| either invoice lacks a payment hash, an amount or an expiry | `undecodable` |
| the wrap is on another payment hash | `hash_mismatch` |
| the wrap cannot cover what the recipient asked | `amount_below_recipient` |
| the wrap charges more than the allowance | `fee_above_allowance` |
| the wrap does not expire before the recipient's invoice | `recipient_expires_first` |

The allowance is the client's ceiling, not a fee the operator names per payment: `1%`
of the recipient's amount by default, with a floor of one satoshi. Set `proportion`
under an operator's price and you refuse that operator.
`wrapFeeCeiling(amountMsat, allowance)` returns the same number for display.

No settlement check is needed. Both invoices carry one payment hash, so the preimage
that settles the wrap is the one the recipient released, and `proveSettlement` already
reads it from the recipient's own server. The gateway watches that hash like any other,
so a wrap is invisible to it.

What this does not cover: an operator that accepts the payment and stalls until the
HTLC times out. Your money comes back, and it was locked meanwhile.

## Who you still have to trust

The proof narrows the trust rather than removing it. Three parties are left, and they
are not equally constrained.

| | You trust it with | It cannot |
|---|---|---|
| the gateway, on every rail | whether it polls and reports at all | invent a settlement for a payment hash you hold |
| the gateway, with `gatewayMints` | which of your addresses gets paid. It also sees the list and the amount | pay an address not on your list, or bill you more than you asked |
| the recipient's wallet provider | that a preimage it releases means the money arrived | mint an invoice for a different account on the same domain and pass `proveOrigin` |
| the recipient | that the sum they asked for is the sum they are owed | nothing here checks this at all |

The gateway cannot invent a settlement because it never chooses the payment hash, so it
cannot hold the preimage before the recipient releases it. `proveOrigin` pins a minted
invoice to one account: the description hash commits to the metadata under LUD-06, and
the metadata has to name the address. `invoiceFrom` refuses on the same two checks, so
an invoice resolved on the `verifyThrough` path is pinned the same way. A recipient
inflating a total is outside what any of it proves.

Four limits remain.

- **A colluding custodian defeats all of it.** If the recipient's wallet provider and
  the gateway are the same party, then whoever holds the money also serves the metadata
  and answers the verify requests. Every check passes. This protects a payer against
  the operator, never against the recipient's own custodian.
- **The proof fetches vet the first URL only.** `proveOrigin` and `proveSettlement`
  check the URL by name, then let the runtime follow redirects. Every hop is fetched,
  and the proof fails only when the last one lands off the recipient's origin.
  `invoiceFrom` follows at most two redirects itself and checks each hop's name and
  resolved addresses. Keep egress control outside this package if that matters.
- **A payment read cold is only as pinned as its creation.** `payment` checks the
  report against the `paymentHash` you hand it, and only the check at creation tied
  that hash to the recipient. Store the hash you proved or derived alongside the
  payment id, never a hash a later read handed back. Otherwise a cold read checks the
  gateway's numbers against each other and nothing more.
- **Availability is not provable, and an address is not a person.** Every check here is
  about an invoice you were given, none about one you were refused. Proving an invoice
  belongs to an address never proves the address belongs to whoever you think it does.

## Webhooks in full

### What the route does

`serve.webhook` is the whole webhook route. Before the gateway accepts a payment on any
rail with a `webhookUrl`, it POSTs a signed `{"type":"webhook-challenge","nonce":"..."}`
there. It refuses the payment with `424` `webhook-unconfirmed` unless the nonce comes
back. The route answers with the nonce alone, unsigned. Deploy the route before you
register it.

Every delivery, the challenge included, is checked against the gateway's published key,
the timestamp and the URL it was sent to. The route calls `onSettled` only for a
delivery that says paid and carries a preimage hashing to the payment hash the same
body names. `onSettled` receives a `SelfConsistent<Settlement>`, so `preimage` is a
`string`. A delivery with no preimage, such as an expiry, gets `202` and no callback
unless you pass `onUnproven`. A delivery claiming paid whose preimage does not hash to
its own payment hash reads as nothing, like a bad signature, and gets `401`.

The route acts on each settlement once for twice `toleranceSecs`, ten minutes by
default, and answers a repeat `200` without calling you. Delivery is still
at-least-once. A retry after that window, or one reaching another instance of your
server, calls you again, so fulfil idempotently on `id`. Behind a proxy that hands the
request on under another host or scheme, pass the URL you registered as `url`.

### Every rail sends the same body

A delivery is a `Settlement` on every rail: `id`, `status`, `paymentHash`, `preimage`
and `settledAt`. `serve.readSettlement` reads it. `serve.readPayment` reads a delivery
whose body is a whole `Payment`, which is what an older gateway posts, and the route
hands that one to `onPayment`.

### How a delivery is signed

The gateway signs every delivery with its own key, so there is no webhook secret to
hand it, and one sent anyway is refused. The signature is
`x-signature-v2: ed25519=<signature>` over four lines joined by `\n`: `v2`, the origin
and path of the URL it was sent to, `<x-timestamp>` and the raw body. The URL is in it
so a delivery made for somebody else's endpoint proves nothing at yours. A gateway also
sends `x-signature` over `<x-timestamp>.<raw body>` for clients older than 2.2.0, and a
newer client does not accept it. A `sha256=` signature is refused.

The route fetches the public key from `/webhook-key` once and keeps it. `webhookKey()`
returns the same key, and `credential` on the route pins one you already read. The key
is derived from the gateway's `CLUSTER_KEY`, so every instance in one cluster signs
alike, and an operator rotating that key rotates this one too. A signature that stops
verifying is a reason to read `/webhook-key` again before it is a reason to distrust
the gateway.

Every reader refuses a timestamp more than five minutes from your clock, either way,
adjustable with `toleranceSecs`. The signature proves the delivery came from the
gateway, not that the payment happened, because the gateway holds the signing key
either way. The proof is the preimage. Find your order by the delivery's payment hash,
so a pair the gateway made up finds no order at all. `proveSettlement` asks the
recipient's own server instead, on a minted payment.

For a framework that hands you the raw body and headers separately, build the `Request`
yourself under the URL you registered. Answer the challenge with
`serve.answerWebhookChallenge` first, then read with `serve.readSettlement`. The body
must be the bytes as received, so mount a raw body parser on that route and not a JSON
one.

```ts
import express from "express";
import { ThunderBridge } from "thunder-bridge";

declare const gateway: ThunderBridge;

const app = express();

app.post("/hooks/paid", express.raw({ type: "application/json" }), async (request, response) => {
  const delivered = new Request("https://shop.example/hooks/paid", {
    method: "POST",
    headers: request.headers as Record<string, string>,
    body: request.body,
  });
  const challenge = await gateway.serve.answerWebhookChallenge(delivered);
  if (challenge !== null) {
    response.json(await challenge.json());
    return;
  }
  const settlement = await gateway.serve.readSettlement(delivered);
  response.sendStatus(settlement === null ? 401 : 200);
});
```
