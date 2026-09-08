# Proving a payment

Reference for a caller who has to decide whether money really arrived. The README
is the shorter road: what the package is, how to install it and what it exports.
This is the part that argues.

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

The two shapes that do not settle, and leave a payment `pending` while the money is
already in the account, are in
[the README](../sdk/README.md#what-each-one-costs-you) with the rest of the rail's
risks.

## Making the gateway poll nobody but you

By default a Lightning watch hands the gateway the wallet's own verify URL, so the
gateway polls `blink.sv` or `coinos.io` directly and its logs, its ledger and its
peers all carry that domain. If you would rather it never touched a third party and
never learned which provider your recipient uses, put your own endpoint in between.

```ts
import { ThunderBridge } from "thunder-bridge";
import { blindLightningRail, lightningVerifyEndpoint } from "thunder-bridge/server";

declare const gateway: ThunderBridge;

const RELAY_SECRET = process.env.RELAY_SECRET as string;

export const serveVerify = lightningVerifyEndpoint({
  secret: RELAY_SECRET,
  pollEverySecs: 5,
});

export const rail = blindLightningRail({
  gateway,
  lnAddresses: ["you@blink.sv"],
  amountMsat: (order) => order.amountMinor * 40,
  relayVerifyThrough: { endpoint: "https://shop.example/verify/lightning", secret: RELAY_SECRET },
});
```

Mount `serveVerify` at that endpoint. It is a plain Fetch handler, so whatever your
framework calls mounting is all it takes.

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

### A wallet with no LUD-21 address at all

`nwcRail` is the same arrangement with the far side swapped. Your wallet answers
over [NIP-47](https://github.com/nostr-protocol/nips/blob/master/47.md) instead of
over an address, so a recipient whose provider publishes no `verify` - or publishes
one with no preimage, which is worse - is watchable anyway.

```ts
import { ThunderBridge } from "thunder-bridge";
import { nwcConnection, nwcRail, nwcVerifyEndpoint } from "thunder-bridge/server";

declare const gateway: ThunderBridge;

const NWC_SECRET = process.env.NWC_SECRET as string;
const connection = nwcConnection(process.env.NWC_URI as string);

export const serveVerify = nwcVerifyEndpoint({ connection, secret: NWC_SECRET });

export const rail = nwcRail({
  gateway,
  connection,
  amountMsat: (order) => order.amountMinor * 40,
  verifyThrough: { endpoint: "https://shop.example/verify/nwc", secret: NWC_SECRET },
});
```

`make_invoice` mints it, `lookup_invoice` reads the preimage back, and the payment
hash is sealed into the query for the reason the wallet's URL is sealed above: it
is what stops a stranger driving your wallet through your own handler. Only the
hash travels, so the gateway never holds the connection, the relay or the wallet
key, and every answer is refused unless the wallet's own key signed it.

Take the connection string scoped. ZEUS, Alby Hub and Blink all issue one per app
with its own permissions and budget, and this needs `make_invoice` and
`lookup_invoice` and nothing else - never `pay_invoice`.

### How often the gateway asks

Your endpoint decides, not the gateway. `bankVerifyEndpoint` answers with
`Cache-Control: max-age=30`, and the gateway uses that as the interval for every
payment on your host. Set `pollEverySecs` to whatever your bank's own refresh makes
sensible: reading a statement that moves once an hour every five seconds only burns
your rate limit.

How long one answer may take is the other half of the pacing. The gateway abandons a
poll after 15 seconds, and `askTimeoutMs` is one deadline over the whole connection
rather than one per relay, so a connection listing four relays still answers inside
that window.

The gateway also asks the URL once, before it accepts the watch, and refuses with
`424` if it does not answer this shape. So deploy the endpoint first and register
second. That is what stops anyone pointing a gateway at a server that never asked to
be polled for thirty days.

## Paying through an operator who fronts the liquidity

A recipient with no inbound liquidity cannot be paid at all. An operator with a node
can stand in the middle without holding anything: it takes the recipient's own
invoice, mints a **hold invoice on the same payment hash** for the amount plus a fee,
and can settle its own only by revealing the preimage it learned from paying the
recipient. Claiming and delivering are one act, so there is no moment where it keeps
the money and walks away.

This SDK does not wrap. `proveWrapped` checks a wrap somebody else offers, and the
NIP-47 primitives an operator would build one from, `nwcHoldInvoice` and `nwcPay`,
are on `thunder-bridge/server` with nothing here driving them.

```ts
import { proveWrapped } from "thunder-bridge";
import { invoiceFrom } from "thunder-bridge/server";

declare function wrapThrough(bolt11: string): Promise<string>;

const real = await invoiceFrom(["you@blink.sv"], 21_000_000);
const wrapped = await wrapThrough(real.bolt11);

proveWrapped(wrapped, real.bolt11);
```

`proveWrapped` compares two invoices and asks nobody anything, so it runs in a
browser. It refuses a wrap on another hash, one that cannot cover what the recipient
asked, one charging over the allowance, and one that outlives the invoice it has to
forward to.

The allowance is the **client's ceiling**, not a fee the operator names per payment,
so it sits deliberately above any list price: `1%` by default with a floor of one
satoshi. An operator running this charges `0.75%`, which leaves room for a wrap a
shade over list to still go through. Set `proportion` under an operator's price and
you refuse that operator, which is the point of it being yours.
`wrapFeeCeiling(amountMsat, allowance)` is the same number if you want to show it.

There is no settlement check to add. Both invoices carry one payment hash, so the
preimage that settles the wrap is the one the recipient released, and
`proveSettlement` already reads it from the recipient's own server. The gateway needs
no change either: it watches that hash and polls the recipient's verify URL, and a
wrap is invisible to it.

What this does not cover: an operator that accepts the payment and stalls until the
HTLC times out. Your money comes back, and it was locked meanwhile.

## What is still trusted

The trust boundary is stated once, in
[the README](../sdk/README.md#who-you-still-have-to-trust): which of the three
parties is constrained by what, plus the colluding custodian, the first-hop-only
host guard, the cold read that is only as pinned as its creation, and why
`isProvablyPaid` is not evidence. It lives there rather than here because it is the
first thing a caller needs and the README is what npm hands them.

## Webhooks in full

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
half once with `webhookKey()` and keep it, as the handler in
[the README](../sdk/README.md#webhooks) does.

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
import { ThunderBridge, parseWebhook } from "thunder-bridge";

declare const gateway: ThunderBridge;

const app = express();
const signer = { publicKey: await gateway.webhookKey() };

app.post("/hooks/paid", express.raw({ type: "application/json" }), async (request, response) => {
  const payment = await parseWebhook(
    request.body,
    request.get("x-signature") ?? "",
    signer,
    request.get("x-timestamp") ?? "",
  );
  response.sendStatus(payment === null ? 401 : 200);
});
```
