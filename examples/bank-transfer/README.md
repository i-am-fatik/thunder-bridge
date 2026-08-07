# Selling for a bank transfer

The same paywall as [../deno-deploy](../deno-deploy), on the other rail. The payer
scans a Czech QR platba instead of a Lightning invoice, the money lands in a Fio
account instead of a wallet, and what unlocks the content is still a preimage
rather than anyone's word.

Three routes, in `main.ts`:

```
POST /order            build the legs, register them, hand back a QR platba and maybe an invoice
GET  /verify/bank      what the gateway polls, backed by your own bank statement
GET  /content?legs=    402 until one leg was paid, the content after
```

Set `LN_ADDRESSES` and an order is payable either way, and whichever arrives first
unlocks it. Leave them unset and it is a transfer-only shop. Both legs carry the
same `TRIGGER_SECRET`, so one `followTrigger` socket hears both, which is what
[../trigger-watcher](../trigger-watcher) already does with no changes.

Nothing is stored about an order. The preimage is an HMAC over the reference, the
amount and the currency under `BANK_SECRET`, so `/verify/bank` derives it again on
every call rather than remembering anything.

Why the gateway is involved at all, why this rail wants an instance of your own,
and what the proof is worth are in
[../../docs/design.md](../../docs/design.md#two-rails-one-order).

## Configure

| Variable | Required | What it is |
|---|---|---|
| `IBAN` | yes | the account the money goes to |
| `FIO_TOKEN` | yes | one or more read only "Sledování účtu" tokens, comma separated |
| `GATEWAY_URL` | yes | your own gateway with its token in it, `https://<token>@tb.example.net` |
| `BANK_SECRET` | no | generated at boot and printed, set it or a restart loses every open order |
| `LN_ADDRESSES` | no | a comma separated priority list, and the Lightning leg appears with it |
| `PRICE` | no | an amount and an ISO 4217 code, `480.55 CZK` by default |
| `PRICE_VENUES` | no | which venues price the bitcoin, all four by default |
| `SPREAD_BPS` | no | basis points added to the Lightning amount, none by default |
| `TRIGGER_SECRET` | no | put both legs on one trigger, so one watcher hears every settlement |
| `PUBLIC_URL` | no | when a proxy hides the public origin from the request |

`BANK_SECRET` is the only thing worth backing up. Lose it and every unpaid order
becomes unprovable, because the preimage its payment hash was derived from cannot
be derived again.

Every value here is something a standard already defines: an IBAN is ISO 13616, a
currency is ISO 4217, a lightning address is LUD-16, a gateway URL carries its
credential the way RFC 3986 says userinfo works, and a spread is in basis points.
Nothing has a format this project invented.

One price, written the way a person writes one. The minor unit comes from ISO 4217
rather than a hardcoded hundred, so a yen order has no decimals and a dinar has
three, and an amount with more decimals than its currency has is refused instead of
rounded. A typo in `PRICE_VENUES` stops the service at boot rather than quietly
pricing on fewer sources. For CZK only Coinbase and Coinmate answer, because
Kraken and Bitstamp have no CZK pair, so the price rests on two venues and the
spread check is what guards it. For EUR all four answer.

## The Fio token

Generate it in internetbanking under Nastavení and API, with the **Sledování
účtu** right. That one is read only: it exports data and cannot pay anyone, so a
leaked one costs you a stranger reading your statement. One token is one account,
which is why there is no account number to configure. It works five minutes after
you authorise it and lives at most 180 days.

Fio wants at most one read per token every 30 seconds and answers `409` when you
ask sooner, so `FIO_TOKEN` takes a list and five tokens on one account is a read
every six seconds instead of every thirty. They are used strictly in turn, always
the one unused longest. One read also answers every open order at once, because
Fio returns the whole account for the period.

That turn and the last answer live in Deno KV, claimed with an atomic
compare-and-set, so two invocations cannot take the same token and earn a `409`.
`Statement` is a plain function, which is what lets that persistence sit around
`fioStatement` rather than inside the SDK.

## Run it

```bash
IBAN=CZ6508000000192000145399 FIO_TOKEN=... \
  GATEWAY_URL=https://$GATEWAY_TOKEN@tb.example.net deno task dev
curl -s -X POST localhost:8000/order | jq
```

Every leg in the answer has the same shape whichever rail made it, so `qrToSvg(leg.qr)`
renders any of them and `leg.rail` says which one the payer is looking at. `leg.scan`
is the payload itself, a Short Payment Descriptor or a BOLT11 invoice.

`/content` asks the gateway about each leg and unlocks on the first that is paid,
which is the right shape here because an invocation ends when it answers and a
transfer can take days. A process that stays up has
`gateway.firstToSettle([bankId, lightningId])` instead. An expired leg is a loser
rather than a winner, so a Lightning invoice timing out after an hour does not end
a transfer that is still coming.

Nobody can revoke the invoice, so a payer who pays the losing leg afterwards
really has paid twice. That arrives on the trigger socket as a second settlement
for an order already closed, with the reference in `sealed`, and it is a refund
rather than a bug.
