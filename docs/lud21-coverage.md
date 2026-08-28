# Who actually implements LUD-21

This service can only serve a recipient whose LNURL server returns a `verify`
URL **and** releases the preimage through it. Everything below was measured, not
read: docs are useless here, only two pages on the whole web name any
implementer.

Surveyed 2026-08-01. Method: harvest real lightning addresses from nostr `lud16`
fields, call each LNURL callback, keep the ones carrying `verify`, then GET every
one of those URLs and check the real `{status, settled, preimage, pr}` shape.

That method is now [`tools/lud21-harvest.ts`](../tools/lud21-harvest.ts) rather
than prose, and `.github/workflows/lud21.yml` runs it on the first of each month.
`tools/lud21-report.ts` prints the overview and fails the run on the only two
changes that cost anybody: a domain these lists promise that no longer releases a
preimage, and a domain the denylist refuses that now answers like LUD-21. The
machine-written snapshot is [`lud21-measured.json`](lud21-measured.json), and the
prose below is the reading of it.

**Read every list below as of its date, not as of today.** A wallet that shipped
LUD-21 last month is still refused here, and the refusal comes from this snapshot
rather than from anything measured. The denylist is the one part of it that costs a
real recipient.

## Re-surveyed 2026-08-12, by the tool rather than by hand

505 addresses across 96 domains: 31 usable, 44 answering no `verify` at all, 20 whose
every sampled account was broken, and one answering `verify` without a preimage. The
first run of the committed harvest, and it agrees with the hand-made ones. Every
domain the lists below promise measured usable again, every domain they clear of
`verify` answered the same way, and `zeuspay.com` still answers `pr,settled,status`
with no `preimage` key, so the denylist entry that refuses it is still right.
`zeusnuts.com` and `ecash.love` drew no address again and stay unrefuted.

Usable and not named below: `basspistol.org`, `chilitum.com`, `learntheropes.xyz`,
`nostr.fan`. Absent from the sample this time rather than changed: `enesis.md` and
`stacker.news`.

## Re-surveyed 2026-08-10

The harvest again, wider: 643 addresses across 97 domains from six relays, sampling
two addresses per domain because support belongs to the domain rather than the
account, then a deeper pass of up to six addresses on every domain the thin sample
could not settle.

**The denylist costs nobody, as far as this can tell.** `zeuspay.com` still answers
`verify` with no `preimage` key at all, so the entry that refuses it is still right.
`zeusnuts.com` and `ecash.love` appeared in no profile in this harvest, so they are
unrefuted rather than confirmed. Nothing turned up a wallet that shipped LUD-21 since
and is being refused from a stale list, which was the fear behind the gap.

**A trap worth writing down.** A domain looks like it has no LUD-21 when the sampled
account is simply broken. `king21@getalby.com` answers `Recipient wallet error`,
`satoshiplanet@stacker.news` answers `could not generate invoice to customer's
attached wallet`. On two addresses Alby therefore read as unreachable, and Alby is one
of the largest providers here at 90 of the 643. Six addresses in, it answers `verify`
with a preimage field, exactly as in the first survey. Never conclude a provider from a
thin sample.

### Still usable, measured again

`getalby.com`, `coinos.io` and `coinos.pro`, `blink.sv`, `minibits.cash`, `cake.cash`,
`breez.tips`, `blitzwalletapp.com`, `cluborange.org`, `radar.cash`,
`sats.zap.cooking`, and the BTCPay instances `pay.aerarium.money`,
`btcpay.fiattolightning.de`, `pay.bbw.sv`, `pay.sdbitcoiners.com`.

### Usable and new to this survey

`speed.app`, which the first survey could only list as untested for want of a live
address. Plus `arkzap.me`, `stacked.cash`, `sidecar.top`, `nostrplebs.com`,
`orangem.art`, and the self-hosted `bencousens.com`, `cyberguy.fyi`, `enesis.md`,
`mwaters.net`, `onyxcatpottery.com`, `rodbishop.nz`, `vitorpamplona.com`.

### Still no verify at all

Every name the first survey listed that appeared again answers the same way:
`walletofsatoshi.com`, `strike.me`, `cash.app`, `zbd.gg`, `primal.net`,
`fountain.fm`, `npub.cash`, `npubx.cash`, `wallet.yakihonne.com`, `sats.mobi`,
`rizful.com`, and every LNbits instance in the sample. New to the list and answering
the same: `linky.fit`, `sendsats.lol`, `satpicks.com`, `safebox.dev`,
`nostrcheck.me`, `nostrdvm.com`, `btcmap.org`, `orangepillapp.com`, `nextblock.city`,
`nostrcade.com`, `bitcointxoko.org`, `westernbtc.com`.

### Settled nothing either way

`stacker.news`, `pay.blink.sv`, `phoenixwallet.me`, `noahwallet.io`, `breez.fun`,
`zap.stream` and a dozen small self-hosted domains: every address sampled had a
broken wallet behind it, so these are unmeasured rather than refused. The first
survey called Stacker News usable and nothing here contradicts it.

## Usable: verify present, preimage released

| Provider | verify URL shape |
|---|---|
| BTCPay Server >= v2.3.8 | `/lnurlp/verify/{hash}` (live: pay.aerarium.money) |
| Alby (getalby.com) | `/lnurlp/{user}/verify/{id}` |
| coinos.io | `/api/lnurl/verify/{uuid}` |
| Blink (blink.sv) | `lnurl.blink.sv/verify/{hash}` |
| Stacker News | `/api/lnurlp/{user}/verify/{hash}` |
| Minibits | `/.well-known/lnurlp/verify/{hash}` |
| Cake Wallet (cake.cash) | `/verify/{hash}` |
| Breez (breez.tips) | `/verify/{hash}` |
| Blitz Wallet | `/.well-known/lnurlverify/...` (also returns `expired`) |
| Spark-SSP hosted (sats.zap.cooking, radar.cash, pay-spark.*) | `/verify/{hash}` |

Cake, Breez, Blitz, cluborange, zap.cooking and radar all resolve to the same
Spark SSP node. One implementation, many brands, so they stand or fall together.

## Useless: verify present, no preimage

A `settled: true` with no preimage proves nothing. There is no hash binding, so
this service treats it exactly like a server with no `verify` at all.

- ZEUS Pay (zeuspay.com, zeusnuts.com, Cashu `/verify/nut/` path)
- ecash.love

## No verify at all

Wallet of Satoshi, Strike, Cash App, ZBD, Primal, Fountain.fm, Wavlake,
Bitrefill, npub.cash, npubx.cash, Yakihonne, Shockwallet, Noah, vlt.ge,
sats.mobi, vipsats.app, LNbits (bare on a live instance, and no `verify`
anywhere in the lnbits/lnurlp source), plus every BTCPay older than v2.3.8
(hrf.org, rizful.com, derekross.me).

## Broken

- libernet.app ships `"verify": null`. Check the value, never the key.

## Untested, no live address found

Phoenix (phoenixwallet.me did not resolve), Speed, Pouch, Geyser, AQUA, Fedi.

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

## When none of this applies

Every list above is about a recipient reached at an address somebody else hosts.
A recipient who owns the wallet does not need one: `nwcRail` mints over NIP-47 and
`nwcVerifyEndpoint` answers the LUD-21 shape from `lookup_invoice`, so ZEUS Pay,
Wallet of Satoshi and every other name on the refused lists is watchable through a
connection string instead of through their address. The preimage then comes from
the recipient's own node rather than from a hosted service, which is a shorter
chain of trust than anything measured here. It costs a client that runs a server,
which is why the survey and not this is what the gateway is built around.

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
