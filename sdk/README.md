# thunder-bridge

A JavaScript client for a Thunder Bridge gateway. Give it a priority list of
lightning addresses and an amount, and it hands back an invoice minted by the
recipient's own wallet, proven against that recipient's own server before it
returns. The gateway mints nothing, holds nothing and forwards nothing.

LUD-21 is the shape of the proof rather than the whole of it. Whichever rail a
payment runs on, the gateway holds a payment hash, polls a `verify` URL and reports
what came back, and four different things can be the one answering.

## Whose wallets this works with

Check this before you build on it. The gateway can watch a payment only when the
recipient's lightning address publishes a LUD-21 `verify` URL **and** releases the
preimage through it. Support belongs to the address domain rather than to the app,
so the same wallet on another domain can answer differently.

| Works | Address ends with |
|---|---|
| Blink | `@blink.sv` |
| Alby | `@getalby.com` |
| coinos | `@coinos.io`, `@coinos.pro` |
| Minibits | `@minibits.cash` |
| Speed | `@speed.app` |
| Cake, Breez, Blitz, the Spark-hosted brands | `@cake.cash`, `@breez.tips`, `@blitzwalletapp.com` |
| a BTCPay Server of your own | your domain, from v2.3.8 |

| Refused | Why |
|---|---|
| Wallet of Satoshi, Strike, Cash App, ZBD, Primal, Fountain, every LNbits wallet | no `verify` at all |
| ZEUS Pay, ecash.love | `verify` without a preimage, refused deliberately, since `settled: true` with nothing to hash proves nothing |

A refusal happens at creation rather than leaving a payment pending until a
watcher gives up, so a recipient finds out before a payer sees a QR code.

If your recipient is on a refused name, `nwcRail` from `thunder-bridge/nwc` is the way round it: your own
wallet answers over NIP-47 instead of over an address, and the gateway watches the
hash exactly the same. [docs/lud21-coverage.md](../docs/lud21-coverage.md) is the
measured list rather than a reading of changelogs, last surveyed 2026-08-12. Read
every row as true of that date: a wallet that has shipped LUD-21 since still reads
as refused here until the next survey says otherwise.

## Install

```bash
npm install thunder-bridge
```

Node 22 or newer, for anything that opens a socket: `sell`, `settled`,
`firstSettled` and `follow` on the gateway side, and every NWC call on the wallet
side, since a nostr relay is a socket too. Node only exposes a global `WebSocket`
from 22 onwards and there is no fallback to install. The rest, which is every call
that is one or more `fetch` requests, runs on any runtime with `fetch` and
`crypto.subtle`.

One import is the whole thing. The other four are for what a checkout page has no
reason to download.

| Import | What it is for |
|---|---|
| `thunder-bridge` | the gateway, the proofs, the errors and the amounts. Everything is reached through one instance |
| `thunder-bridge/qr` | a payload as an SVG or a data URL, for a page that draws a QR of its own |
| `thunder-bridge/price` | the exchange venues behind `fiat`, for pricing off your own book instead |
| `thunder-bridge/bank` | a bank statement reader, currently Fio |
| `thunder-bridge/nwc` | your own wallet over NIP-47, which carries the nostr crypto no browser wants |

`invoiceFrom` resolves lightning addresses and refuses a private host, so it needs
`node:dns` and will not run on Cloudflare Workers. Nothing else on the main import
does.

## Quick start

A page can run the whole flow with no backend of its own. The url below is a shared
demo gateway that answers anyone and forgets everything on restart, so this snippet
runs as written. It is a base url rather than a page, so opening it in a browser
gives a `404` and [`/health`](https://public.thunder-bridge.agora.gripe/health) is
what tells you it is up.

```ts
import { sats, ThunderBridge } from "thunder-bridge";

const gateway = new ThunderBridge("https://public.thunder-bridge.agora.gripe");

const sale = await gateway.sell({
  to: ["iamfatik@blink.sv", "iamfatik@coinos.io"],
  amount: sats(21),
  signal: AbortSignal.timeout(600_000),
});

const target = document.querySelector("#qr");
if (target !== null) {
  target.innerHTML = sale.qr;
}

await sale.settled();

const preimage = await sale.prove();
```

Two names and one call. `sell` mints the invoice on the first address that can
prove one, checks that invoice against the recipient's own domain before returning,
and draws the QR.

Then there are two different questions and both are worth asking. `settled` tells
you what the gateway says, and it is the fast one. `prove` asks the recipient's own
server, and only that is evidence the money arrived.
[docs/proving-a-payment.md](../docs/proving-a-payment.md) is the whole argument for
why.

An amount is `sats(21)`, `msat(21_000)` or `fiat("4.99", "USD")`, never a bare
number whose unit you have to remember. A fiat price is converted when the invoice
is minted, off the median of four MiCA authorised venues unless you pass your own.

## How each payment method gets verified

Every rail ends the same way, with a preimage that has to hash to the payment hash
the gateway was given. What differs is who obtains the invoice, who is asked for the
preimage, and which side does the checking.

| `rails.lightning` | the gateway asks, at the recipient's LNURL callback |
|---|---|
| the gateway is told | the address list and the amount, and nothing else. It derives the hash and the `verify` URL by resolving the address, and hands both back |
| the invoice is checked by | you, `proveOrigin` runs five checks against the recipient's own domain |
| the gateway probes first | nothing, it resolved the address itself |
| the gateway polls | the wallet, directly |
| `settled` comes from | the wallet releasing its preimage |
| the pace is set by | the wallet, when it sends `Cache-Control: max-age`. When it sends none the gateway's own schedule decides |

| `rails.blindLightning` | you ask, with `invoiceFrom` on your server |
|---|---|
| the gateway is told | a hash, an expiry and your URL, with the wallet's sealed inside |
| the invoice is checked by | nobody needs to, you resolved the address yourself |
| the gateway probes first | `speaksVerify`: a GET on the URL, then a signed POST nonce it must echo |
| the gateway polls | your `serve.verify` endpoint, once `relayThrough` is set. Leave it off and the gateway polls the wallet directly, as on the minted rail |
| `settled` comes from | your endpoint, which unseals, asks the wallet and relays the answer |
| the pace is set by | you, `pollEverySecs` |

| `nwcRail` | your own wallet mints it, over NIP-47 `make_invoice` |
|---|---|
| the gateway is told | a hash and your URL, with the hash sealed inside |
| the invoice is checked by | nobody, it is your wallet |
| the gateway probes first | the same GET and signed nonce |
| the gateway polls | your `nwcVerifyEndpoint` |
| `settled` comes from | `lookup_invoice`, refused unless the wallet's own key signed it |
| the pace is set by | you, `pollEverySecs` |

| `rails.bank` | nobody, there is no invoice |
|---|---|
| the gateway is told | a hash and your URL, which names the amount and the reference |
| the invoice is checked by | nobody, there is no invoice to check |
| the gateway probes first | the same GET and signed nonce |
| the gateway polls | your `serve.bankVerify` endpoint |
| `settled` comes from | a `Statement` credit matching amount and currency exactly, with the reference anywhere in the payer's text |
| the pace is set by | you, `pollEverySecs` |

Two things are worth reading off those blocks rather than inferring.

**The checking side flips.** On the minted path the gateway resolved the address, so
it runs no verify probe and no verify challenge, and `proveOrigin` on your side is
the whole defence. A `webhookUrl` is challenged on both paths. On every watched path the gateway resolved nothing, so it probes the URL
and challenges it with a nonce before accepting the watch, refusing with `424` if
nothing answers. Deploy the endpoint before you register it. The challenge is on
unless the operator set `VERIFY_CHALLENGE=0`, which is also why a bare wallet
`verify` URL cannot be handed to `watch`: a wallet will not echo a nonce.

**What a preimage proves is the same on all four, and narrower than it looks:** that
the server holding the secret says the money arrived, made unforgeable by anyone
else. On the bank rail that secret is an HMAC you derive, which sounds weaker and is
not, because a wallet also minted the preimage it later releases. It rules out a
gateway inventing a settlement. It does not rule out a recipient lying about one, so
this protects a payer against the operator, not against the person being paid.

`proveWrapped` sits on a different axis. It compares two invoices on one payment
hash and asks nobody anything, so it says whether an operator's wrap is honest
without saying whether either invoice was paid.

### What each one costs you

**`rails.lightning`**

- the gateway holds the address and the amount, so your order book is readable
  from its own logs
- it polls the wallet directly, which puts the recipient's provider in its logs and
  in front of its peers
- the wallet's `Cache-Control` sets the poll pace, so how fast a settlement is
  noticed is not yours to decide

**`rails.blindLightning`**

- a service of your own that has to stay up, so a browser-only integration cannot
  use this rail at all
- one long-lived sealing secret, which `seal` refuses under 32 characters, so
  `openssl rand -hex 16` is the shortest thing that works
- your endpoint being down means the gateway cannot verify and the payment sits
  `pending`
- a wallet you cannot reach answers `502`, so the gateway retries instead of
  concluding the invoice went unpaid. The body still reads `settled: false`, and the
  status is what separates "could not ask" from "asked, and no"

**`nwcRail`**

- an NWC connection to your own wallet, and the nostr relays behind it
- **scope the connection to `make_invoice` and `lookup_invoice`, never
  `pay_invoice`.** It is a key that spends, and a leak with the wrong scope drains
  the wallet
- relays unreachable means no verification

**`rails.bank`**

- the gateway has to be one of your own: the verify URL names the amount and the
  reference, so whoever runs the gateway reads your order book from the watches
  alone
- the secret is the entire proof. **Lose it and every past proof is gone**, because
  each preimage is derived from it

**The bank rail has one silent failure worth testing before you promise anybody a
rail.** Two shapes leave a payment `pending` while the money is already in the
account: a bank that truncates the reference, since the match asks whether the
reference is inside what the bank forwarded rather than the other way round, and a
payer whose bank forwards nothing but a numeric variable symbol, since an
alphanumeric reference cannot travel in a numeric field and `X-VS` is not read as an
alternative. Neither has been seen with Fio, which forwards the message untouched.
Check it against the banks your payers actually use.

## Who you still have to trust

The proof narrows the trust rather than removing it. Three parties are left, and
they are not equally constrained.

| | You trust it with | It cannot |
|---|---|---|
| the gateway | which of your addresses gets paid, and whether it answers at all | pay an address not on your list, bill you more than you asked, or invent a settlement |
| the recipient's wallet provider | that a preimage it releases means the money arrived | mint an invoice for a different account on the same domain |
| the recipient | that the sum they asked for is the sum they are owed | nothing here checks this at all |

The gateway also sees your address list and your amount. It cannot invent a
settlement because the preimage comes from the recipient's own server, and the
provider cannot mint for another account because the description hash pins an
invoice to one user's metadata under LUD-06. A recipient inflating a total is
outside what any of it proves.

Four sharp edges, worth reading before you build:

- **A colluding custodian defeats all of it.** If the recipient's wallet provider
  and the gateway are the same party, then whoever holds the money also serves the
  metadata and answers the verify requests. Every check passes. This protects a
  payer against the operator, never against the recipient's own custodian.
- **The two proof fetches vet the first hop and no further.** `proveOrigin` and
  `proveSettlement` use the runtime's default redirect handling, so a public https
  host answering `302` to a private address is followed there. `invoiceFrom` is not
  like this: it resolves through the outbound guard, which sets `redirect: "manual"`
  and re-vets every hop. Keep egress control outside this package if that matters.
- **A payment read cold is only as pinned as its creation.** `payment` checks
  the preimage against the `paymentHash` in the same record, and it was
  `proveOrigin` at creation, against the request you wrote, that tied that hash to
  an invoice the recipient issued. Store the request alongside the payment id, or a
  cold read is checking the gateway's numbers against each other and nothing more.
- **Availability is not provable, and an address is not a person.** Every check
  here is about an invoice you were given, none about one you were refused, and
  proving an invoice belongs to an address never proves the address belongs to
  whoever you think it does.

`carriesProof` is the one to be careful with: it asks only whether a report holds
together, so a gateway that generates a preimage, hashes it and builds an invoice
around that hash passes it. If a payment matters, ask the recipient with
`prove` on the sale or with `proveSettlement`. The full argument, including the five
origin checks and their failure codes, is in
[docs/proving-a-payment.md](../docs/proving-a-payment.md).

## What you call

[docs/api.md](../docs/api.md) is the whole surface, generated from the TSDoc on
every export by [`tools/api-reference.ts`](../tools/api-reference.ts) and checked in
CI, so nothing there can be out of date and nothing here repeats it. Your editor
has the same text on the export itself.

The shape of it is worth stating once, because it is the thing that makes the rest
findable. One instance is the entry to everything:

```ts
import { sats, ThunderBridge } from "thunder-bridge";

const gateway = new ThunderBridge("https://public.thunder-bridge.agora.gripe", {
  secret: "a-long-lived-server-side-secret",
});

const sale = await gateway.sell({ to: "iamfatik@blink.sv", amount: sats(21) });
const read = await gateway.payment(sale.id);
const quoted = await gateway.quote({ to: "iamfatik@blink.sv", amount: sats(21) });

const lnurl = gateway.serve.lnurlPay({
  to: "iamfatik@blink.sv",
  amount: sats(21),
  secret: "a-long-lived-server-side-secret",
});
const rail = gateway.rails.lightning({ to: "iamfatik@blink.sv", amount: () => sats(21) });
```

- **the payments themselves** are `sell`, `mint`, `quote`, `watch`, `payment`,
  `payments`, `settled`, `firstSettled`, `firstSettled`, `follow`, `ticket`,
  `nameFor` and `webhookKey`, all on the instance
- **what you mount** is on `gateway.serve`: an LNURL-pay endpoint, the two ticket
  endpoints, the verify endpoints for Lightning and for a bank, the webhook route,
  and the readers under it
- **one call per sale** is on `gateway.rails`: `lightning`, `blindLightning`,
  `bank`, and `transfer` for a bank transfer on its own
- **the proofs** are free functions, deliberately, because a proof you cannot run
  without the thing being audited is not a proof: `proveOrigin`, `proveSettlement`,
  `proveWrapped`, `carriesProof`, `decodeInvoice`, `preimageMatchesHash`
- **the amounts** are `sats`, `msat` and `fiat`

What your service answers once those handlers are mounted is written out in
[`openapi.yaml`](openapi.yaml), shipped with this package.

## Errors

Every failure from the gateway is an RFC 9457 problem document. Branch on `type`,
never on prose. `error.status` is what the transport carried, and a document naming
a different status in its own body does not override it.

Every `type` below is prefixed `urn:problem-type:thunder-bridge:`. The four with no
error class of their own are static strings on `ProblemError`, and
`ProblemError.is(error, ProblemError.PAYMENT_ALREADY_WATCHED)` is how you branch on
one of those.

| `type` | Status | What it is |
|---|---|---|
| `invalid-request` | 400, or 413 for a body over the size ceiling | `detail` names the field |
| `no-wallet-available` | 502, else 422, else 400, following the worst wallet | `NoWalletAvailableError`, `wallets` says why each failed |
| `request-in-flight` | 409 | a request with this `Idempotency-Key` is still running, as `IdempotencyConflictError` |
| `idempotency-key-reused` | 409 | that key was used for a different request, as `IdempotencyConflictError` |
| `payment-already-watched` | 409 | that payment hash is already watched here |
| `caller-unknown` | 403 | the instance keeps a list of callers and your key is not on it |
| `verify-host-refused` | 403 | this instance will not mint, because minting is off or `VERIFY_HOSTS` pins it to a list. Resolve the address yourself and use `watch`. A verify URL that is not public https is `invalid-request` instead |
| `verify-unconfirmed` | 424 | the URL did not answer the LUD-21 shape |
| `verify-unconsented` | 424 | the URL did not echo the challenge nonce |
| `webhook-unconfirmed` | 424 | the webhook URL did not answer its challenge |
| `too-many-pending` | 429, with `ratelimit-limit` and `ratelimit-remaining` set | the caller is over its share of the instance's `MAX_PENDING` |

The rest carry `about:blank` as their type, which the gateway seeds into every
problem body: `401` when the bearer token does not match, `404` both for an id this
gateway never heard of and for one it knows that belongs to a different caller key,
so a `403` can never confirm an id exists, `410` when you replay an
`Idempotency-Key` whose payment has since been pruned, `500`, and `503` while the
instance is draining or its own health check reads stalled. On a `404` `payment`
returns `null` rather than throwing.

`GatewayCheatError` is different in kind. It reports a gateway that demonstrably
misbehaved, and `code` names the check that caught it. `UnverifiedRecipientError` is
neither an accusation nor a clean bill of health: it means a check could not be run
at all, because the recipient's server was down, timed out, answered something
unreadable, or the browser was blocked by CORS. Decide what you want to do with an
unproven invoice, and decide it explicitly.

```ts
import {
  GatewayCheatError,
  NoWalletAvailableError,
  ProblemError,
  ThunderBridge,
  UnverifiedRecipientError,
} from "thunder-bridge";

declare const gateway: ThunderBridge;
declare function report(line: string): void;

try {
  await gateway.mint({ to: "iamfatik@blink.sv", amount: 21_000 });
} catch (error) {
  if (error instanceof GatewayCheatError) {
    report(`the gateway cheated: ${error.code} on payment ${error.paymentId}`);
  } else if (error instanceof UnverifiedRecipientError) {
    report(`could not reach ${error.lnAddress} to check the invoice`);
  } else if (error instanceof NoWalletAvailableError) {
    for (const wallet of error.wallets) {
      report(`${wallet.address}: ${wallet.reason}`);
    }
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
alone, so a captured delivery cannot be replayed at you later. Delivery is
at-least-once, so deduplicate on `id`.

Your handler answers one challenge before any of that. The gateway POSTs
`{"type":"webhook-challenge","nonce":"..."}` to the URL while the create is still
open, and refuses the payment with a `424` unless the nonce comes back, so deploy
the endpoint before you register it.

```ts
import { ThunderBridge } from "thunder-bridge";

declare function fulfil(paymentId: string, preimage: string): Promise<void>;

const gateway = new ThunderBridge("https://public.thunder-bridge.agora.gripe");

export const POST = gateway.serve.webhook({
  onSettled: async (settlement) => {
    await fulfil(settlement.id, String(settlement.preimage));
  },
});
```

That route answers the challenge, reads the gateway's own published key, checks the
signature, and calls you only for a delivery that proves itself: it says paid and it
carries a preimage that hashes to the payment hash the same body names. A delivery
that proves nothing gets a `202` and no callback, because acting on an unproven
claim is the one thing this refuses to do. Pass `onUnproven` when an expiry is news
you want.

`gateway.serve.readSettlement` and `gateway.serve.readPayment` are the same checks
without the route, for a handler you would rather write yourself. Ask the
recipient's own server with `proveSettlement` when you want the proof to come from
somewhere other than the delivery.

## More

- [docs/lud21-coverage.md](../docs/lud21-coverage.md) - which address domains
  release a preimage, and how that was measured
- [docs/proving-a-payment.md](../docs/proving-a-payment.md) - the five origin checks
  and their failure codes, what settlement means, making the gateway poll nobody but
  you, the NWC rail, wrapped invoices, and webhooks in full
- [docs/api.md](../docs/api.md) - every export, generated from the code
- [the gateway](../README.md) - one level up in this repository

## Development

```bash
npm install
npm test
npm run build
```

MIT.
