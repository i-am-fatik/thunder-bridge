# Which wallets work with this gateway

The gateway can watch a payment only when the recipient's lightning address
publishes a LUD-21 `verify` URL **and** releases the preimage through it. Support is
measured, because only two pages on the web name any implementer.
[`tools/lud21-harvest.ts`](../tools/lud21-harvest.ts) harvests live lightning
addresses from nostr `lud16` fields, mints a throwaway invoice at each and reads what
`verify` answers. `.github/workflows/lud21.yml` runs it on the first of each month.
`tools/lud21-report.ts` prints the overview and fails the run on the two changes
that cost a recipient: a domain listed as working that conclusively stopped
releasing a preimage, and a denylisted domain that now releases one.
[`lud21-measured.json`](lud21-measured.json) is the committed snapshot. Each run is
compared against it, and the SDK README's wallet list is checked against it.

Measured 2026-08-12, 505 addresses across 96 domains, or by hand on 2026-08-01
where the sample held no address of that wallet. The lists hold as of those dates.
A wallet that shipped LUD-21 since stays listed as not working until a run measures
it.

Support belongs to the address domain, not to the app. The same app on another
domain can answer differently, so every row names what the address ends with, and
a wallet-name allowlist is the wrong shape.

## Wallets that work

| Wallet | Address ends with |
|---|---|
| Blink | `@blink.sv` |
| Alby | `@getalby.com` |
| coinos | `@coinos.io`, `@coinos.pro` |
| Minibits | `@minibits.cash` |
| Cake Wallet | `@cake.cash` |
| Breez | `@breez.tips` |
| Blitz Wallet | `@blitzwalletapp.com` |
| Speed | `@speed.app` |

Blink is the easiest to point somebody at. Its non-custodial accounts shipped on
Spark on 2026-06-24, and the address stays `username@blink.sv` whether or not the
account holds its own keys. Cake, Breez and Blitz resolve to the same Spark SSP
node, one implementation under three brands, so they stand or fall together. A
BTCPay Server of your own answers from v2.3.8. Support merged on 2026-04-11 in
PR #7250 and shipped on 2026-04-23 as a per-store toggle, on by default. A
self-hosted BTCPay older than that answers no.

## Wallets that do not work

Their addresses carry no `verify` at all, so a payment to them is refused when it is
created instead of staying pending until the watcher gives up:

Wallet of Satoshi, Strike, Cash App, ZBD, Primal, Fountain, Yakihonne, Noah,
Shockwallet, npub.cash, npubx.cash, sats.mobi, vipsats.app, vlt.ge, and every
LNbits wallet, bare on a live instance and with no `verify` anywhere in the
lnbits/lnurlp source.

ZEUS Pay (`zeuspay.com`, `zeusnuts.com`) and ecash.love answer `verify` without a
preimage. A `settled: true` with no preimage proves nothing, because nothing binds
it to the payment hash. The gateway treats them like a wallet with no `verify` and
refuses them by the denylist in [How the code uses this](#how-the-code-uses-this).

## Wallets not measured yet

Phoenix, Pouch, AQUA and Fedi: no live address of theirs turned up in any sample,
so they are unmeasured rather than refused.

## Your own wallet needs none of this

Every list above is about a recipient reached at an address somebody else hosts. A
recipient who holds their own wallet needs none of it. `rails.nwc` mints over NIP-47
and `serve.nwcVerify` answers the LUD-21 shape from `lookup_invoice`. A recipient on
any refused domain can therefore be watched through an NWC connection to a wallet of
their own instead of through the address. The preimage then comes from the
recipient's own node rather than from a hosted service, a shorter chain of trust
than anything measured here. The cost is a server that holds the connection.

## How this was measured

Harvest real lightning addresses from nostr `lud16` fields across six relays and
group them by domain. Sample two addresses per domain, and up to six where two
settled nothing. Call each LNURL callback for a throwaway invoice and keep the ones
carrying `verify`. Then GET every one of those URLs and check the real
`{status, settled, preimage, pr}` shape.

**A broken account looks like a domain with no LUD-21.** `king21@getalby.com`
answers `Recipient wallet error`, and `satoshiplanet@stacker.news` answers `could
not generate invoice to customer's attached wallet`. On two addresses Alby read as
unreachable, although it is one of the largest providers in the harvest. Six
addresses in, it answers `verify` with a preimage field, as in the first survey. A
domain whose every sampled address was broken is unmeasured, not refused.

The `verify` URL shapes seen, for debugging a client against them:

| Wallet | verify URL shape |
|---|---|
| Alby | `/lnurlp/{user}/verify/{id}` |
| coinos | `/api/lnurl/verify/{uuid}` |
| Blink | `lnurl.blink.sv/verify/{hash}` |
| Minibits | `/.well-known/lnurlp/verify/{hash}` |
| Cake, Breez and the Spark-hosted brands | `/verify/{hash}` |
| Blitz Wallet | `/.well-known/lnurlverify/...` (also returns `expired`) |
| BTCPay Server >= v2.3.8 | `/lnurlp/verify/{hash}` |

libernet.app ships `"verify": null`. Check the value, never the key.

## What this costs the service

`verify` appears only in the callback response, never in the initial payRequest.
Detecting support therefore costs one throwaway invoice per recipient, and there is
no cheap pre-flight.

## Does the invoice bind to the metadata

`proveOrigin` needs the invoice's `h` tag to equal the sha256 of the `metadata` the
address serves, because that pins an invoice to one user rather than to the whole
domain. LUD-06 mandates it. Measured 2026-08-01 by minting a throwaway invoice and
hashing the metadata beside it:

- **Binds:** coinos, Alby, Stacker News, Cash App, Bitrefill, ZBD.
- **Does not bind:** primal.net serves an `h` that is not its metadata hash.

Of the wallets that work, coinos and Alby are on that list and bind. The others are
not recorded here, and `resolve` refuses an unbound invoice from any of them. The
one server that failed had no `verify` and was refused anyway. Recheck this as the
list of wallets that work grows.

`access-control-allow-origin` is present on both the `.well-known` endpoint and the
`verify` URL for coinos, Alby and Stacker News, so a browser can run the proof
itself with no proxy.

## Why a recipient without LUD-21 cannot be watched

Surveyed 2026-08-17: it cannot be done, not merely hard. After a payment settles,
the preimage exists in three places: the recipient's node, which generated it, the
payer's wallet, which learned it from the route, and every node that forwarded it.
Nothing writes it anywhere public. A watcher who is none of the three, and is told
by none of them, has no proof to obtain.

The question is which of the three will tell you:

| Payer is | How the preimage reaches you | Node needed |
|---|---|---|
| an L402 client or an agent | `Authorization: L402 <macaroon>:<preimage>` | none |
| a browser with WebLN | `sendPayment()` returns `{ preimage: string }` | none |
| a browser holding its own NWC | `pay_invoice` returns the preimage | none |
| somebody scanning a QR on a phone | **there is no path** | - |

In the first three the payer is in a request-response loop with you, and hands the
preimage over to get what it paid for. The fourth has walked away, and it is
ordinary retail.

That last row leaves two options. The recipient publishes LUD-21, or somebody wraps
the invoice on a node: the node issues its own hold invoice on the recipient's
payment hash, pays the recipient's invoice once the payer pays, and learns the
preimage on the way. Everything else was checked and does not work:

- LNURL specs LUD-01 through LUD-23 carry no verification except LUD-21.
- LUD-09 and LUD-10 prove only to the payer.
- NIP-57 zap receipts carry `preimage` as a MAY, and only where the provider speaks
  nostr at all.
- Keysend lets the payer pick the preimage, so no receipt property exists.
- BOLT12 is signed by the recipient, as BOLT11 is.
- Channel balances are private, so nothing can be inferred by watching.

Wrapping needs a node that can hold an invoice on one payment hash while paying
another invoice on the same hash. Measured 2026-08-17, Alby Hub over NWC cannot.
ldk-node keys its payment store by hash and answers `DuplicatePayment: A payment
with the given hash has already been initiated`. The collision also shadows the hold
invoice, so `lookup_invoice` returns the failed outgoing attempt and
`cancel_hold_invoice` answers `NOT_FOUND` on a payment that is still held. LND can,
measured 2026-08-27 on the regtest stack in `dev/`. One node held an invoice on the
hash it was also paying, the forward returned the preimage, and the wrap settled.
LND keeps invoices and payments as separate records, which is what Boltz and Loop
run this on. CLN needs a plugin, because stock `invoice` settles on receipt.

Two nodes fix the collision and break the economics. One accumulates while the
other drains, so the fronted amount stops returning and a rebalance treadmill
starts. One node with LND keeps the loop closed.

## How the code uses this

Whether a `verify` URL releases a preimage cannot be tested before someone pays.
The wallets that answer without one are therefore a denylist,
`VERIFY_WITHOUT_PREIMAGE` in [`core/lnurl.ts`](../core/lnurl.ts). It is checked
against the address domain and its subdomains before any request goes out. Such a recipient is refused when
the payment is created, instead of staying pending until the watcher gives up and
calls `expired` a payment that may have landed.

Extend this page and that const together. The denylist does not catch a server that
answers `verify` from a domain other than the address it was reached at, a shape
nothing in this survey shows.
