# Which wallets work with this gateway

The gateway can watch a payment only when the recipient's lightning address
publishes a LUD-21 `verify` URL **and** releases the preimage through it. Which
wallets do is measured rather than read off a changelog: docs are useless here,
only two pages on the whole web name any implementer.
[`tools/lud21-harvest.ts`](../tools/lud21-harvest.ts) harvests live lightning
addresses from nostr `lud16` fields, mints a throwaway invoice at each and reads
what `verify` answers. `.github/workflows/lud21.yml` runs it on the first of each
month, `tools/lud21-report.ts` prints the overview and fails the run on the only
two changes that cost anybody, a wallet promised below that stopped releasing a
preimage and a wallet refused below that now does, and
[`lud21-measured.json`](lud21-measured.json) is the snapshot the lists read from.

Measured 2026-08-12, 505 addresses across 96 domains, or by hand on 2026-08-01
where the sample held no address of that wallet. Read the lists as of those
dates: a wallet that shipped LUD-21 since is still refused here until the next
run says so.

Support belongs to the address domain, not to the app. The same wallet on another
domain can answer differently, so every row names what the address ends with.

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

Blink is the easiest to point somebody at: non-custodial accounts shipped
2026-06-24 on Spark, and the address stays `username@blink.sv` whether the
account holds its own keys or not. Cake, Breez and Blitz resolve to the same
Spark SSP node, one implementation under three brands, so they stand or fall
together. A BTCPay Server of your own answers too from v2.3.8 on, shipped
2026-04-23 as a per-store toggle that is on by default.

## Wallets that do not work

Their addresses carry no `verify` at all, so the gateway refuses them at creation
rather than leaving a payment pending until the watcher gives up:

Wallet of Satoshi, Strike, Cash App, ZBD, Primal, Fountain, Yakihonne, Noah,
Shockwallet, npub.cash, npubx.cash, sats.mobi, vipsats.app, vlt.ge, and every
LNbits wallet, bare on a live instance and with no `verify` anywhere in the
lnbits/lnurlp source.

ZEUS Pay (`zeuspay.com`, `zeusnuts.com`) and ecash.love answer `verify` without
a preimage. A `settled: true` with no preimage proves nothing, there is no hash
binding, so the gateway treats them exactly like a wallet with no `verify` and
refuses them from the denylist in [`core/lnurl.ts`](../core/lnurl.ts). That
denylist is the one part of this page that costs a real recipient, and every run
of the tool checks it is still right.

## Wallets not measured yet

Phoenix, Pouch, AQUA and Fedi: no live address of theirs turned up in any sample,
so they are unmeasured rather than refused.

## Your own wallet needs none of this

Every list above is about a recipient reached at an address somebody else hosts.
A recipient who owns the wallet does not need one: `nwcRail` mints over NIP-47
and `nwcVerifyEndpoint` answers the LUD-21 shape from `lookup_invoice`, so ZEUS
Pay, Wallet of Satoshi and every other name on the refused list is watchable
through a connection string instead of through its address. The preimage then
comes from the recipient's own node rather than from a hosted service, which is
a shorter chain of trust than anything measured here. It costs a client that
runs a server, which is why the survey and not this is what the gateway is built
around.

## How this was measured

Harvest real lightning addresses from nostr `lud16` fields across six relays,
group them by domain because support belongs to the domain rather than the
account, sample two addresses per domain and up to six where two settled
nothing, call each LNURL callback for a throwaway invoice, keep the ones carrying
`verify`, then GET every one of those URLs and check the real
`{status, settled, preimage, pr}` shape.

**A trap worth writing down.** A domain looks like it has no LUD-21 when the
sampled account is simply broken. `king21@getalby.com` answers `Recipient wallet
error`, `satoshiplanet@stacker.news` answers `could not generate invoice to
customer's attached wallet`. On two addresses Alby therefore read as unreachable,
and Alby is one of the largest providers in the harvest. Six addresses in, it
answers `verify` with a preimage field, exactly as in the first survey. Never
conclude a provider from a thin sample: a domain whose every sampled address was
broken is unmeasured, not refused.

The `verify` URL shapes seen, for whoever debugs a client against them:

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

- **`verify` appears only in the callback response**, never in the initial
  payRequest. Detecting support therefore costs one throwaway minted invoice per
  recipient. There is no cheap pre-flight.
- **Support belongs to the address domain, not the wallet app.** The same app on
  a different domain gives a different answer, so a wallet-name allowlist is the
  wrong shape.
- **BTCPay landed it 2026-04-11 (PR #7250) and shipped it in v2.3.8 on
  2026-04-23**, per-store toggle, default on. Any self-hosted BTCPay older than
  that answers no.

## Does the invoice bind to the metadata

`proveOrigin` needs the invoice's `h` tag to equal the sha256 of the `metadata`
the address serves, because that is what pins an invoice to one user rather
than to the whole domain. LUD-06 mandates it. Measured 2026-08-01 by minting a
throwaway invoice and hashing the metadata beside it:

- **Binds:** coinos, Alby, Stacker News, Cash App, Bitrefill, ZBD.
- **Does not bind:** primal.net serves an `h` that is not its metadata hash.

Every server that passes the `verify` gate above also binds, so refusing an
unbound invoice at `resolve` costs no usable recipient today. The one server
that fails already had no `verify` and was refused anyway. Recheck this if the
usable list ever grows.

`access-control-allow-origin` is present on both the `.well-known` endpoint and
the `verify` URL for coinos, Alby and Stacker News, so a browser can run the
whole proof itself with no proxy.

## Why a recipient without LUD-21 cannot simply be watched

Surveyed 2026-08-17, and the answer is closed rather than merely hard. After a
payment settles, the preimage exists in exactly three places: the recipient's node,
which generated it, the payer's wallet, which learned it from the route, and every
node that forwarded it. Nothing writes it anywhere public. A watcher who is none of
those three and is told by none of those three has no proof to obtain, and no
cleverness produces one.

So the question is never "how do I verify" but "which of the three will tell me".

| Payer is | How the preimage reaches you | Node needed |
|---|---|---|
| an L402 client or an agent | `Authorization: L402 <macaroon>:<preimage>` | none |
| a browser with WebLN | `sendPayment()` returns `{ preimage: string }` | none |
| a browser holding its own NWC | `pay_invoice` returns the preimage | none |
| somebody scanning a QR on a phone | **there is no path** | - |

The first three have the payer in a request-response loop with you, so they hand the
preimage over as the mechanism by which they get what they paid for, not as a
favour. The fourth walked away, and it is ordinary retail.

That last row leaves two options and no third: the recipient publishes LUD-21, or
somebody wraps on a node. Everything else was checked and does not work - LNURL
specs 01 through 23 carry no verification but LUD-21, LUD-09 and LUD-10 prove only
to the payer, NIP-57 zap receipts carry `preimage` as a MAY and only where the
provider speaks nostr at all, keysend lets the payer pick the preimage so no
receipt property exists, BOLT12 is signed by the recipient exactly as BOLT11 is,
and channel balances are private so nothing can be inferred by watching.

Wrapping needs a node that can hold an invoice on one payment hash while paying
another invoice on the same hash. Measured 2026-08-17: Alby Hub over NWC cannot,
because ldk-node keys its payment store by hash and answers
`DuplicatePayment: A payment with the given hash has already been initiated`. The
collision also shadows the hold invoice, so `lookup_invoice` returns the failed
outgoing attempt and `cancel_hold_invoice` answers `NOT_FOUND` on a payment that is
still held. LND can, measured 2026-08-27 on the regtest stack in `dev/`: one node held
an invoice on the hash it was also paying, the forward returned the preimage, and the
wrap settled. Its invoices and its payments are separate records, which is what Boltz
and Loop run this on. CLN needs a plugin, because stock `invoice` settles on receipt.

Two nodes fix the collision and break the economics: one accumulates while the
other drains, so the fronted amount stops returning and a rebalance treadmill
starts. One node with LND keeps the loop closed.

## How the code uses this

Presence of a preimage cannot be tested before someone pays, so the
useless-list is a denylist in [`core/lnurl.ts`](../core/lnurl.ts)
(`VERIFY_WITHOUT_PREIMAGE`), checked against the address domain and its
subdomains before any request goes out. A ZeusPay-class recipient is refused at
creation instead of staying pending until the watcher gives up and calling
`expired` a payment that may well have landed.

Extend the list here and in that const together. It does not catch a server
that answers `verify` from a domain other than the address it was reached at,
which is a shape nothing in this survey exhibits.
