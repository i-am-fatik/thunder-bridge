# Changelog

All notable changes to the `thunder-bridge` npm package are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The package follows semver. This file starts at 0.8.0 and does not carry the
earlier 0.x history forward. Read the number as the next free one on the name, not
as the next step of the 0.7.x line: this is a different client for a different
service that happens to keep the name, and nothing in 0.7.x carries over. The old
changelog stays with the old gateway's repository.

Every version up to 0.7.0 was unpublished from npm on 2026-08-02, so nothing below
this one is installable, and none of those numbers can ever be reused. npm never
releases a version number once it has been published.

## 0.8.3

0.8.2 could not be loaded in a browser at all. Anything server-only now lives behind
`thunder-bridge/server`, so the main entry carries no Node built-in.

### Fixed

- The package pulled `node:dns/promises` and `node:timers/promises` into whatever
  imported it, so a bundler building for a browser failed to resolve them and the
  import took the page down with it. Only `resolvesNothingPrivate` ever wanted them,
  the SSRF guard on every outbound hop, and it now asks for them when it runs rather
  than when the module loads. The guard itself is unchanged: it still resolves the name
  and refuses a private address, and a missing built-in would throw rather than wave a
  hop through.
- The build no longer splits its output. A shared chunk put the server half back into
  the browser half's import graph, which defeated the split above.

### Changed

- `lnurlPayEndpoint` and `blindLightningRail` moved to `thunder-bridge/server`, with
  `Minted`, `TriggerConfig` and `BlindLightningRailConfig`. Both resolve a Lightning
  address themselves, which needs the name lookup a browser cannot do, so neither had
  any business on an entry a browser reads. Everything else stayed where it was,
  `bankRail` and `fioStatement` included, because they hold a secret rather than a
  resolver and never reached the lookup.

## 0.8.2

Every payment method now answers one type, and the retired problem-type namespace is
gone. Breaking for a client that talks to an instance still emitting it.

### Added

- `Rail`, one type every payment method satisfies: `(order: Order) => Promise<Leg>`.
  Everything that differs between rails is bound when the rail is built, so the only
  thing passed per sale is which sale it is. `bankRail`, `lightningRail` and
  `blindLightningRail` are the three that ship, and a `Leg` reads the same whichever
  one made it, so `firstToSettle` takes a mixed list without knowing what is in it.
- `qrToSvg` and `qrToDataUrl` render any rail's `Leg.qr`. A rail states its own QR
  payload, a BOLT11 invoice under the `LIGHTNING` scheme or a Short Payment Descriptor
  as it stands, so nothing has to ask which rail it is looking at. The three
  format-named pairs stay for anyone calling them directly.
- `lightningRail` sends no idempotency key unless asked. A key stable across re-offers
  is one the gateway can join against the bank leg's reference, so it is opt in.

### Removed

- `isProblemType` no longer accepts `urn:problem-type:thunder-bridge-direct:`. It
  reads the current namespace only, so a document carrying the retired spelling now
  arrives as a plain `ProblemError` instead of the class its type names. 0.8.1 read
  both to carry callers across the rename, and that transition is over: nothing this
  house runs emits the old spelling any more.

### Fixed

- `bankTransfer` asked the wrong side whether a gateway was private. `isPrivate` reports
  whether *you* configured a token, so a made-up token against a public instance read as
  private and the rail registered happily, handing that operator the amount and the
  reference off every verify URL. It now asks the gateway itself through the new
  `refusesStrangers()`, one unauthenticated read a private instance has to refuse, asked
  once per client and remembered. Anything but a refusal counts as open, so an
  unreachable gateway fails closed. `isPrivate` stays, it just no longer guards the rail.
- A trigger secret shorter than 16 characters is now refused wherever one is given.
  Following a trigger is an unauthenticated WebSocket the gateway does not rate limit,
  and the socket opening is itself the confirmation, so a short secret was brute
  forceable online. Every stream carries preimages, so guessing one is worth real money.
- The `trigger` doc comment claimed only its sha256 ever reaches the gateway. That is
  true of registering, and false of following: `followTrigger` puts the secret itself in
  the socket URL, because the gateway hashes what it is handed to find the stream. The
  ledger still stores only the hash, so a stolen database cannot subscribe, but the
  operator of a gateway you do not own learns the secret the first time you connect.
- `fioStatement` read `Credit.bookedAt` as unix milliseconds and got `0` for every
  credit. Fio books a day and a UTC offset, `2026-07-15+0200`, which is neither a
  number nor something `Date.parse` takes. Found against a real account, on a response
  the tests had never been shaped like. Settlement was never affected, because
  `bankVerifyEndpoint` matches on amount, currency and reference and never reads the
  booking day, so this corrupted a field a caller could read rather than a proof.


## 0.8.1

A second rail, and the project dropped `direct` from its name. Two identifiers moved
with the rename, everything else here is additive.

### Added

- `bankTransfer(params)` puts a bank transfer on the same footing as a Lightning
  payment. It derives a preimage from an HMAC over the reference, the amount and
  the currency, registers the watch, and returns the watched id with the Short
  Payment Descriptor a Czech QR platba carries. The gateway needed no change,
  because from where it stands this is a hash and a URL to poll.
- That gateway has to be one of your own. A blind Lightning watch hands over a
  hash and a wallet's opaque URL, while this hands over a URL naming the amount
  and the reference, so whoever runs the gateway could read your order book off
  the watches. `bankTransfer` therefore throws unless the gateway carries a token,
  and `allowPublicGateway` is the way to say the order book is not worth hiding.
- `gateway.isPrivate` says whether a token was given, which is what makes an
  instance yours, and what the refusal above reads.
- `bankTransfer` takes `trigger` and `sealed` and passes both to the watch, so a
  bank leg and a Lightning leg of the same order arrive on one `followTrigger`
  socket, with `sealed` saying which order each belongs to.
- `gateway.getWatched(id)` and `gateway.waitForWatched(id, options?)` read and
  follow a payment the gateway only watches. Such a payment carries no address,
  amount or invoice, because the gateway was told none of them, so `getPayment` and
  `waitForPayment` refuse it and say which method to use instead of answering
  nonsense.
- `gateway.firstToSettle(ids, options?)` waits on several payments, keeps the first
  that is really paid and stops waiting on the losers, which closes their sockets.
  That is how one order is offered on two rails. It is not a race: an expired leg is
  a loser, so a Lightning invoice timing out after an hour does not cancel the
  transfer still coming, and `null` means every leg ended unpaid.
- `bankVerifyEndpoint(config)` is the Fetch handler the gateway then polls. It
  answers the LUD-21 shape from your own bank statement, stores nothing, and
  refuses a query it did not sign, which is what stops it answering "did anyone
  send you this amount with this note" to whoever asks.
- `Statement` is the plugin seam, one function from a timestamp to the credits
  after it, so another bank is another function of that shape.
- `fioStatement(config)` is the first one, reading your own Fio account. A read
  only token is the whole configuration, because a Fio token belongs to one
  account and the "Sledování účtu" right cannot pay anyone. Fio allows one read
  per token every 30 seconds and the gateway polls faster, so the last answer is
  held for `minIntervalSecs` instead of earning a `409`.
- `token` also takes a list. Fio's window is per token, so five tokens on one
  account is a read every six seconds. They are used strictly in turn, always the
  one unused longest, no token is asked twice inside its own window, and a token
  listed twice counts once.
- One read answers every open order, because Fio returns the whole account for the
  period and the cache lives on the statement rather than on a payment. Five
  transfers cost one request.
- `spdToSvg(spd, options?)` and `spdToDataUrl(spd, options?)` render the transfer's
  QR, next to the ones for an invoice and a lightning address.
- `medianOf(tickers?, options?)` prices a bitcoin in the minor units of any
  currency, defaulting to four venues that hold a MiCA CASP authorisation,
  `coinbase()`, `kraken()`, `bitstamp()` and `coinmate()`. It takes the middle
  answer, skips a venue that does not quote the currency, refuses the lot when they
  disagree by more than `maxSpreadBps`, and holds an answer for a minute.
  `Ticker` is the seam, so your own source is a one line function.
- Every adapter proves it was given the pair it asked for. Bitstamp answers an
  unknown pair with a `200` and its whole ticker list starting at BTC/USD, which
  would have priced a bitcoin at 64,000 crowns, and Kraken puts its refusal in a
  `200` body.
- `msatFor(amountMinor, priceMinorPerBtc, options?)` turns a fiat price into what to
  ask for over Lightning, in BigInt so a large order stays exact, rounding up, with
  an optional `spreadBps` that defaults to none.
- `minorUnitsOf(currency)` and `minorScaleOf(currency)` read a currency's minor unit
  from ISO 4217 instead of assuming two digits, and throw for a code they do not
  know rather than guessing. That fixes the QR platba amount and the price reading
  for a yen, which has no decimals, and a dinar, which has three.
- `openapi.yaml` in this package now specifies both handlers you can mount, the
  LNURL-pay endpoint and the bank verify endpoint.

### Changed

- The problem type namespace is `urn:problem-type:thunder-bridge:` now that `direct`
  has left the project's name. A problem type is an identifier clients branch on, so
  `isProblemType` reads both spellings and the gateway emits only the new one, which
  means an updated client still types the errors of an instance that has not been
  redeployed.
- The sealing key's HKDF info string dropped `direct` with it, so a blob sealed by
  0.8.0 cannot be unsealed by 0.8.1. Nothing sealed exists yet, and this was the last
  moment that was true.

### Security

- What a bank preimage proves is what LUD-21 proves and no more: that the server
  holding the secret saw the money. It is the recipient's own word, made
  unforgeable by anyone else, and the gateway cannot produce it at all. Read the
  README before putting it in front of a payer who needs to distrust the
  recipient.


## 0.8.0

A total replacement of the 0.7.x package. Same name on npm, same author, nothing
else in common.

0.7.x talked to a custodial donation proxy. It asked a gateway to mint an
invoice, the donor paid the gateway, the gateway took custody and forwarded, and
most of the SDK existed to bound how much of that an operator could skim or
redirect. This one talks to a gateway that mints nothing and holds nothing. You post
a priority list of Lightning addresses and an amount, the gateway asks each
address's own LNURL-pay endpoint for a real invoice and returns the first one it
could get, and the payer pays the recipient's own invoice directly. There is no
gateway invoice and no custody window, so there is no skim to bound and no fee to
police.

Two questions are left, and each has one function. Is this invoice really the one
that address issued, for the amount you asked for: that is `proveOrigin`, and
`createPayment` runs it for you. Did the money actually arrive: that is
`proveSettlement`, which asks the recipient's own server. Both answer by talking
to the recipient, never by taking the gateway's word for anything.

Because the service is different, the objects are different. A donation had a
donor leg and a recipient leg, a forwarding mode, a fee, a backend strategy and a
retry history. A payment has one invoice, issued by the recipient, and a preimage
that either hashes to it or does not. The two do not map onto each other, so
there is no migration path and none is offered. If you still run the old gateway,
the 0.7.x client is no longer on npm; take it from the `archive/rust-gateway`
branch of `i-am-fatik/thunder-bridge` and vendor it.

The gateway's own wire follows the Open Payments 1.3.3 resource model, so it speaks
`incoming-payments`, snake_case properties, RFC 3339 timestamps, and an amount as
`{value, asset_code, asset_scale}` where the value is a string. None of that reaches
you. `Payment` and `CreatePaymentParams` stay camelCase with `amountMsat` as a number
and timestamps as unix seconds, because a TypeScript client spelling fields
`incoming_amount` would read wrong. The translation lives in one place and refuses an
amount in any other asset or scale rather than reading it as millisatoshi.

### Removed

- **The entire 0.7.x entry surface.** `ThunderBridge.createDonation`,
  `createDonationForInvoice`, `getDonation`, `waitForFulfillment`,
  `estimateFees`, and every donation type. Triggers, the flow where paying a
  hash fires a signal, are gone with `createTrigger` and its payment list; they
  have no counterpart here.
- **Proof of work.** The new gateway has no challenge endpoint and no puzzle for
  a client to solve, so `solvePow`, `verifyPow`, `getChallenge` and the retry
  dance around them are gone with the concept.
- **The `bolt12` subpath** and the optional `boltz-bolt12` peer dependency. The
  gateway speaks LNURL-pay to the recipient's own server, and an offer has no
  role in that path.
- **The `l402` subpath.** Paywalled HTTP was a use case for an invoice the SDK
  could mint on demand through a gateway. It is not one for an invoice that only
  the recipient's wallet can issue.
- **The `quote` subpath**, with the signed fee quotes, the fee ceiling, the
  gateway comparison and the P-256 quote verification. A gateway that never
  touches the money has no fee to quote and nothing to sign for.
- **The `edge` subpath and `createLnurlPayHandler`.** It existed to put the
  operator's own LNURL-pay endpoint in front of a custodial gateway so a printed
  QR could stay trustless. The recipient's own endpoint is now the only one in
  the path, so the wrapper has nothing to wrap.
- **The `lowlevel` subpath.** `verifyTrustless`, `classifyIdentity`,
  `resolveLnAddress`, `resolveInvoice`, `detectDestinationType`, the
  `isBolt11Invoice` / `isBolt12Offer` / `isLnAddress` detectors, the
  `bolt11PaymentHash` / `bolt11AmountMsat` / `bolt11Network` accessors,
  `encodeForQr`, and the `TrustlessStatus`, `IdentityOutcome`,
  `LnAddressResolution` and `ForwardingMode` types. Everything published is back
  on the package root, one export map entry.
- **The `thunder-bridge` CLI** (`verify`, `verify-donation`, `install-skill`) and
  the bundled Claude Code skill. Not shipped, no `bin`, no `skills` directory in
  the tarball.
- **The `allow` policy and its neighbours:** `autoVerify`,
  `allowUnverifiedRecipient`, `requireTrustless`, `maxDonorFeeSat`, `amountKind`
  and `recipientNodeId`. Each graded a risk (custody, fee overcharge, a shorted
  recipient, an unconfirmable identity) that this gateway is not in a position to
  take. What is left is one boolean, `verify`, on by default.
- **`@noble/secp256k1`.** 0.7.x recovered the payee node id from the invoice
  signature to catch a substituted recipient. LUD-06 plus LUD-21 pins the invoice
  to an individual account on the recipient's own server, which is a stronger
  claim than a node id (it separates two accounts on one shared custodial node)
  and needs no curve arithmetic, so the dependency went with the check.

A handful of names recur, and not one of them is the same function.
`invoiceToSvg`, `invoiceToDataUrl`, `parseWebhook`, `parseWebhookRequest`,
`verifyWebhookSignature`, `preimageMatchesHash`, `GatewayCheatError` and
`UnverifiedRecipientError` all take the new `Payment`, a new signature, or a new
set of codes. A 0.7.x call site does not compile against 0.8.0, which is the
intended outcome: a silent behavioural swap under a familiar name would be worse.

### Added

- **`ThunderBridge`, a client for the new API.** `new ThunderBridge(baseUrl, {
  verify? })`, then four methods. `createPayment({ lnAddresses, amountMsat,
  webhookUrl?, webhookSecret? })` posts the address list as a priority order, the
  gateway walks it and the rest is the fallback, and the result is a `Payment`
  carrying the recipient's `bolt11`, its `paymentHash`, the `verifyUrl` and the
  expiry. `getPayment(id)` returns `null` for an id the gateway never heard of
  instead of throwing, so a 404 is a value and not an exception.
  `waitForPayment(id, { signal?, tickets? })` follows the WebSocket the gateway
  pushes on, resolves the `Payment` once the status reaches `paid` or `expired`,
  and takes an `AbortSignal`, so `AbortSignal.timeout(ms)` is the whole timeout
  story. A dropped connection is not the end of it: the gateway sends the current
  state on connect, so a settlement during an outage arrives as the first frame of
  the next attempt, and reconnecting stops at the payment's own expiry, which the
  first frame already carried. Before any frame has arrived there is nothing to
  bound it, so a few tries decide it, which is what keeps a wrong id from becoming
  a loop. A 2xx answer whose body is not a JSON object raises `ProblemError`
  carrying the response status, not a bare `SyntaxError` from the parser.
- **`createQuote({ lnAddresses, amountMsat })`, the fourth method.** It asks which
  address would serve an amount and returns a `Quote` naming the winner, the
  wallet's `minMsat` and `maxMsat` range, and a `refusals` list saying why each
  address ahead of it was passed over. The callback is never called, so nothing is
  minted and the recipient's wallet is charged nothing. Do not read this as the
  0.7.x `quote` subpath returning under a new name: that one was a signed fee
  quote with a ceiling to hold a custodian to, and this one is a reachability
  probe whose `feeMsat` is always zero because there is no custodian left to
  overcharge. It is a probe and not a promise, since whether a wallet issues a
  provable invoice cannot be known without asking it for one and asking mints it,
  so an address that quotes cleanly can still be refused by `createPayment`.
- **`lnurlPayEndpoint(config)`, a whole LNURL-pay endpoint as one Fetch handler.**
  A static QR can point at your own domain rather than at a gateway, so swapping
  gateways never means reprinting anything. It holds no state and runs anywhere
  `Request` and `Response` do. `amountMsat` is a plain function called once per
  payRequest, published as `minSendable === maxSendable`, which is where a fiat
  peg or a time-of-day rule goes. The winner is quoted at payRequest and pinned
  into the signed callback URL, because LUD-06 binds the invoice to the metadata
  already served and a different address winning at callback time would make the
  payer's wallet refuse the invoice. Two consequences follow and neither is
  fixable: a pinned recipient that goes down has no fallback behind it, and the
  description the payer sees is always the recipient's, since only the
  recipient's wallet mints. Only the amount is yours.

  This is not the removed `edge` subpath returning under a new name. That one put
  an endpoint in front of a *custodial* gateway to make a printed QR trustless.
  This one wraps nothing of the sort: it exists to own the identity a QR points
  at, and to run pricing as code where no shared gateway ever could.
- **`followTrigger(secret, options)`, watching a place instead of a payment.**
  One static endpoint gets paid by many people, and an overlay, a
  microcontroller or a game server wants each payment as it lands. The gateway
  replays the recent settlements on connect and then streams the rest, and the
  client reconnects on its own because a trigger has no terminal state. Only the
  sha256 of the secret ever reaches the gateway. Keep it apart from the URL on
  the QR: anyone who can pay a trigger must not thereby be able to watch it.
- **`tickets: true` on `followTrigger` and on `waitForPayment`.** A socket URL is
  logged by the gateway, by proxies and by the browser, so a trigger secret in one
  ends up where it should not be. With this on, the client mints a short-lived
  single-subject ticket per connection and puts that in the URL while the secret
  travels in a POST body, which is not logged. That is the benefit exactly: not a
  stronger secret, a secret that stays out of logs. For a payment the id is still
  readable inside the ticket, so what it buys there is narrower: a URL out of a log
  stops opening anything after a minute. A fresh ticket is minted for every
  reconnect, and a mint that fails is reported and retried rather than ending the
  follow. Off by default, because for an ESP32 one hardcoded URL and a dumb
  reconnect loop beats a POST and a JSON parse before every connect.
- **`token`, and `listPayments()` behind it.** A gateway started with
  `GATEWAY_TOKEN` wants `Authorization: Bearer` on every call, and the client
  sends it when constructed with `{ token }`. This is a lock for a gateway you
  host, not a login: on a shared one a token someone else issues is a thing they
  can revoke, which is the dependency this project exists to remove. Only a
  gateway in that mode serves `listPayments()`, because a list on a shared one
  would hand every caller everyone else's payments, and there the correlation
  costs nothing since you are the only caller. The bearer covers the WebSocket
  handshake too, and no browser can put a header on a socket, so a configured
  token also sends every socket through a ticket. Nothing to switch on: the direct
  path would answer 401.
- **`watchPayment(params)`, handing over an invoice you obtained yourself.** The
  gateway polls the verify URL and checks preimages as it always did, but it is
  given only a hash, a URL and an expiry. Creating a payment tells it who is
  being paid and how much, and a gateway that knows can refuse one recipient
  rather than all of them. Told this little, the only refusal left to it is
  refusing everyone, which is visible and is what makes leaving cheap. What it
  still learns is the recipient's domain, out of the verify URL, so this narrows
  the target rather than erasing it. `sealed` is stored and returned untouched
  for whatever the watcher needs and the gateway should not have, encrypted by
  you. `lnurlPayEndpoint` does the whole thing for you under `blind: true`.

  `seal` and `unseal` are exported and the endpoint's `sealed: { secret, data }`
  uses them, so the plaintext version cannot be written. That shape exists
  because the documented "encrypt it yourself" failed the first time it was
  tried: the obvious callback returned a readable string and the amount landed
  in the gateway's database with nothing erroring. AES-GCM over WebCrypto, a
  secret under 32 characters is refused, and `unseal` answers null for a foreign
  or edited blob rather than throwing.

  A hash already watched answers 409 with `PAYMENT_ALREADY_WATCHED`, which is
  exported. The payment id is an HMAC of the payment hash and that id is the read
  capability, so returning the stored record would turn a value every payer holds
  into a key for it. An identical repeat still succeeds, and the blind endpoint
  treats the 409 as success since the invoice is watched either way.
- **`Idempotency-Key`, as a second argument to `createPayment`.**
  `createPayment(params, { idempotencyKey })` makes the POST safe to retry. The
  gateway claims the key before it contacts any wallet rather than after the
  invoice comes back, which is what closes the window a client's own timeout fires
  in. A repeat of a finished request replays its payment, a repeat that arrives
  mid-flight throws the new `IdempotencyConflictError` with
  `conflict: "request-in-flight"`, and the same key sent for a different request
  throws it with `conflict: "key-reused"`. A request that mints nothing hands its
  key back. Keys live 24 hours, shorter than a payment, so a replay naming a
  pruned payment is a `ProblemError` with status 410 and never a second mint.
- **`proveOrigin(payment, request)`, the origin proof.** The second argument is
  the same `CreatePaymentParams` object you passed to `createPayment`, not a list
  of addresses, so the amount the caller asked for is the reference for every
  amount comparison. Seven checks in order. The chosen address is one you
  actually listed. The reported `amountMsat` equals the `amountMsat` you asked
  for. The invoice decodes to the payment hash the report claims. The invoice's
  own amount equals the amount you asked for, which an invoice naming no amount
  fails. The sha256 of the `metadata` served at
  `https://domain/.well-known/lnurlp/user` equals the invoice's description hash,
  which is LUD-06 and pins the invoice to that user rather than merely to that
  domain. The payment's `verifyUrl` shares an origin with the `callback` that
  same endpoint publishes. A GET of the `verifyUrl`, which is LUD-21, echoes a
  `pr` equal to the invoice in hand, compared ignoring case because bech32 is
  case insensitive. The first four checks touch no network at all. The two
  fetches that remain go to the recipient's own server, and the well-known URL is
  built from the address as the caller wrote it, with only the domain lowercased
  because host names are case insensitive, so the gateway's spelling of the
  address cannot steer the proof at a different account on the same host.
  `createPayment` runs the whole thing for you unless you construct the client
  with `{ verify: false }`.
- **`proveSettlement(payment, request)`, the only proof that the money arrived.**
  It runs the full origin proof first, because a `verifyUrl` the gateway invented
  would otherwise be answering for itself, then reads `settled` and `preimage`
  from the recipient's own LUD-21 verify endpoint. It returns the preimage when
  the recipient says it settled, `null` when the recipient says it has not,
  throws `GatewayCheatError("preimage_mismatch")` when the released preimage does
  not hash to the payment hash, and throws `UnverifiedRecipientError` when the
  recipient could not be reached to ask. Nothing else in this package establishes
  that a payment was made; a `paid` status, a webhook and `isProvablyPaid` are
  all the gateway talking about itself.
- **`isProvablyPaid(payment)`, a self-consistency check and not a proof.** It
  asks whether the gateway's own report hangs together: the status is `paid`, the
  invoice carries the payment hash the report claims, and the preimage hashes to
  that hash. Every input comes from the gateway, so a gateway that invents a
  preimage, derives its hash and issues an invoice carrying that hash passes it.
  It catches a broken or careless gateway, not a lying one. `getPayment` and
  `waitForPayment` refuse a `paid` payment that fails it with
  `GatewayCheatError("preimage_mismatch")` unless the client was constructed with
  `{ verify: false }`, which is a floor under the reporting and not a proof of
  payment. Call `proveSettlement` when it matters.
  `preimageMatchesHash(preimage, paymentHash)` is the primitive underneath, and
  it is the honest name for what both of them do.
- **`GatewayCheatError`, and the distinction it is careful to keep.** A check
  that ran and failed throws `GatewayCheatError` with a machine code:
  `address_not_requested`, `hash_mismatch`, `amount_mismatch`,
  `description_hash_mismatch`, `verify_url_foreign`, `invoice_not_issued`,
  `preimage_mismatch`. A check that could not run, because the recipient's server
  was down, answered garbage or the browser was CORS-blocked, throws
  `UnverifiedRecipientError` with the address and the cause instead. That second
  error is explicitly not an accusation. Silence from a wallet provider is not
  evidence against the gateway, and the type system says so.
- **RFC 9457 error classes.** Every non-2xx answer arrives as
  `application/problem+json` and becomes a `ProblemError` carrying `type`,
  `title`, `status` and `detail`. `status` is always the HTTP status of the
  response: a problem document claiming a different one does not override it. The
  one minted problem type,
  `urn:problem-type:thunder-bridge:no-wallet-available`, becomes
  `NoWalletAvailableError`, a `ProblemError` subclass whose `wallets` array says
  what each address on your list did: `address-unusable`, `unreachable`,
  `amount-not-accepted`, `cannot-prove-delivery` or `invoice-refused`. That array
  is always an array, a malformed or missing `wallets` field yields `[]` and
  entries that are not objects with an `address` are dropped, so a caller can map
  over it without guarding. You get the per-wallet reasons, not just a failed
  request, which is enough to tell a typo apart from a provider outage apart from
  a provider that cannot prove delivery.
- **WebCrypto-only webhook verification.** `parseWebhookRequest(request,
  secret)`, `parseWebhook(body, signature, secret)` and
  `verifyWebhookSignature(body, signature, secret)` compute HMAC-SHA256 through
  `crypto.subtle` over the raw body, accept the `X-Signature` header with or
  without its `sha256=` prefix, and compare in constant time. The two parsing
  functions return `null` for a missing header, a bad signature, and also for a
  correctly signed body that does not read as a payment, so a malformed delivery
  is a `null` to handle and never a thrown `SyntaxError` or a `Payment` whose
  fields are quietly `undefined`. They authenticate the sender
  and nothing more: a verified `paid` webhook proves the gateway sent it, not
  that the recipient was paid, so run `proveSettlement` before you act on one.
  All three are async, which is the price of `crypto.subtle`, and the reward is
  that they run wherever `fetch` does: a browser, Cloudflare Workers, Deno, Bun,
  Node. The 0.x implementation reached for `node:crypto` and simply could not.
- **`decodeInvoice(bolt11)` and the `Invoice` type.** A dependency-free bech32
  reader returning `paymentHash`, `descriptionHash` and `amountMsat`, each `null`
  when the invoice does not carry it. Undecodable input, including a BOLT12
  offer, yields an invoice with every field null rather than an exception, so the
  verification path treats a malformed invoice as a failed check and never as a
  crash. It reads the fields, it does not validate the bech32 checksum or the
  invoice signature; no check in this package rests on either, the recipient's
  own echo of the invoice string does that work.
- **QR rendering.** `invoiceToSvg(destination, { size?, color? })` and
  `invoiceToDataUrl` for an `<img>` `src`, emitting the uppercase `LIGHTNING:`
  URI so the code stays in alphanumeric mode and scans small. A lightning
  address is taken too and keeps its case, so a tip jar can show a QR with no
  invoice behind it.
- **A QR for your own trigger.** `lnurlToSvg(endpoint)`, `lnurlToDataUrl` and
  `toLnurl` bech32-encode the URL `lnurlPayEndpoint` runs on as the `LNURL1`
  string LUD-01 defines, uppercase as that spec asks a QR to be. Nothing in it
  expires, so one printed code serves every payer, which is the whole point of a
  trigger. Verified against the worked example in LUD-01 itself.
- **Exported types:** `Payment`, `PaymentStatus`, `CreatePaymentParams`,
  `WalletFailure`, `WalletReason`, `GatewayCheatCode`, `Invoice`,
  `ThunderBridgeOptions`, `WaitOptions`, `QrOptions`.
- **One runtime dependency, `uqr`, for the QR matrix.** HMAC comes from
  `crypto.subtle`, and SHA-256, bech32 and the LNURL plumbing are in-package.
  That is a claim about the install and not about there being nothing to audit:
  dropping `@noble/secp256k1` moved the hashing into this repository, where
  `src/sha256.ts` is a hand-written SHA-256 that reviewers should read as
  carefully as they would a dependency.
- **Node 22 or newer**, ESM and CommonJS, with per-condition type resolution so
  a `require` consumer gets `.d.cts` and not ESM-flavoured types.
- **A type-checked test suite.** The repository carries `tsconfig.test.json`, and
  `npm run typecheck` now runs over `src` and `test` rather than `src` alone, so
  a test that no longer matches the public surface fails the check instead of
  passing silently. The published tarball still contains `dist` only.

### Changed

- The problem type namespace is `urn:problem-type:thunder-bridge:` now that `direct`
  has left the project's name. A problem type is an identifier clients branch on, so
  `isProblemType` reads both spellings and the gateway emits only the new one, which
  means an updated client still types the errors of an instance that has not been
  redeployed.
- The sealing key's HKDF info string dropped `direct` with it, so a blob sealed by
  0.8.0 cannot be unsealed by 0.8.1. Nothing sealed exists yet, and this was the last
  moment that was true.

### Security

- **Both verification fetches are bounded to public https hosts.** The guard
  refuses anything that is not `https:`, the IPv4 ranges `0/8`, `10/8`, `127/8`,
  `100.64/10`, `169.254/16`, `172.16/12`, `192.168/16` and `240/4`, the IPv6
  unspecified and loopback addresses, unique local `fc00::/7` and link local
  `fe80::/10`, IPv4-mapped IPv6 that lands in any refused IPv4 range, a
  single-label host, the trailing-dot form such as `localhost.`, and the
  `.localhost`, `.local`, `.internal`, `.lan`, `.arpa`, `.test` and `.invalid`
  suffixes. A hostile Lightning address therefore cannot aim the SDK at an
  obvious loopback or private-range target.
- **That guard is not absolute.** Both fetches use
  the default redirect handling, so only the first hop is vetted: a public host
  that answers `302` with a private address is followed. Name resolution is not
  inspected either, a public name whose A record points into private space
  passes. Run the SDK where an outbound request to your own network would not
  matter, or put an egress policy in front of it.
- **The QR `color` option is validated against an anchored allowlist** before it
  reaches the SVG: short or long hex with optional alpha, `rgb()` or `rgba()`, or
  a bare CSS colour name. Every branch of the pattern is anchored at both ends,
  so a value cannot carry extra markup out of the `fill` attribute; anything else
  throws.

### Migration

There is none, by construction. Donations and payments are not the same object
and the gateways are not the same service, so no shim could be honest about what
it was doing. Point new code at a Thunder Bridge gateway and write it
against `createPayment`, which proves the invoice's origin as it hands it back,
and `proveSettlement`, which is what you call before you treat a payment as
received. Old code has to vendor the 0.7.x client, which is only in git now.
