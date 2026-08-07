# Who actually implements LUD-21

This service can only serve a recipient whose LNURL server returns a `verify`
URL **and** releases the preimage through it. Everything below was measured, not
read: docs are useless here, only two pages on the whole web name any
implementer.

Surveyed 2026-08-01. Method: harvest ~100 real lightning addresses from nostr
`lud16` fields, call each LNURL callback, keep the ones carrying `verify`, then
GET every one of those URLs and check the real `{status, settled, preimage, pr}`
shape.

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
