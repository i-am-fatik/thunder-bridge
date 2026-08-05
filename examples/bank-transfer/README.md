# Selling for a bank transfer, proved the same way

The same paywall as [../deno-deploy](../deno-deploy), on the other rail. The payer scans a Czech QR
platba instead of a Lightning invoice, the money lands in a Fio account instead of a wallet, and
what unlocks the content is still a preimage rather than anyone's word.

Three routes, in `main.ts`:

```
POST /order            build the legs, register them, hand back a QR platba and maybe an invoice
GET  /verify/bank      what the gateway polls, backed by your own bank statement
GET  /content?legs=    402 until one leg was paid, the content after
```

Set `LN_ADDRESSES` and an order is payable either way, by transfer or by Lightning, and whichever
arrives first is the one that unlocks it. Leave them unset and it is a transfer-only shop. Both legs
carry the same `TRIGGER_SECRET`, so one `followTrigger` socket hears both, which is what
[../trigger-watcher](../trigger-watcher) already does with no changes.

One price, written the way a person writes one: `PRICE="480.55 CZK"`, an amount and an ISO 4217
code. The minor unit comes from that standard rather than from a hardcoded hundred, so a yen order
has no decimals and a dinar has three, and an amount with more decimals than its currency has is
refused instead of rounded. The invoice amount is derived at the rate four MiCA authorised venues
agree on, through `medianOf` and `msatFor`, with `SPREAD_BPS` in basis points as what you charge for
carrying the volatility. A typo in `PRICE_VENUES` stops the service at boot rather than quietly
pricing on fewer sources.

For CZK that leaves Coinbase and Coinmate answering, because Kraken and Bitstamp have no CZK pair,
so the price rests on two venues and the spread check is what guards it. For EUR all four answer.

Nothing is stored. No database, no KV, no session. The preimage is an HMAC over the reference, the
amount and the currency under `BANK_SECRET`, so `/verify/bank` derives it again every time it is
asked rather than remembering anything, and `/content/{id}` asks the gateway what it knows.

## Why the gateway is in this at all

A shop that can read its own statement could check for the money itself. What it would then also own
is the waiting: a bank transfer can take days, so somebody has to keep asking for days, and on Deno
Deploy nothing survives the response. The gateway is that somebody, and it is the same one already
watching the Lightning payments, so both rails settle through one path in your code.

It cannot produce a preimage for the hash it is given, only this service can, so the strongest thing
a hostile gateway can do is say nothing and let the order expire.

## Why it has to be your own gateway

On the Lightning side a blind watch hands the gateway a hash and a wallet's opaque URL, which tells
it nothing. Here the verify URL names the amount and the reference, so whoever runs the gateway can
read the order book off the watches, and that URL answers whether each order was paid. So this rail
wants an instance of your own, and `bankTransfer` refuses a gateway with no token, which is what
makes an instance yours. `GATEWAY_TOKEN` here is that token, and it is the same string the gateway
was started with.

There is an `allowPublicGateway` for the case where the order book is not worth hiding. This example
does not set it, because a shop's order book usually is.

## What the proof is worth

That the service holding `BANK_SECRET` saw a matching credit on the statement. That is the same
claim LUD-21 makes for a wallet, no stronger, and it is worth being exact: a bank statement read
over an API is an assertion by whoever holds the read token, and here that is you. What the hash
adds is that nobody else can make the assertion in your name.

So this is the rail to use when the recipient is the one being trusted anyway, which is every shop
selling its own goods, and not the rail for a payer who needs to distrust the recipient.

## Configure

| variable         | required | what it is                                                                |
| ---------------- | -------- | ------------------------------------------------------------------------- |
| `IBAN`           | yes      | the account the money goes to, as an IBAN                                 |
| `FIO_TOKEN`      | yes      | one or more read only "Sledování účtu" tokens, comma separated            |
| `GATEWAY_URL`    | yes      | your own gateway with its token in it, `https://<token>@tb.example.net`   |
| `BANK_SECRET`    | no       | generated at boot and printed, set it or a restart loses every open order |
| `LN_ADDRESSES`   | no       | a comma separated priority list, and the Lightning leg appears with it    |
| `PRICE_VENUES`   | no       | which venues price the bitcoin, all four by default                       |
| `SPREAD_BPS`     | no       | basis points added to the Lightning amount, none by default               |
| `TRIGGER_SECRET` | no       | put both legs on one trigger, so one watcher hears every settlement       |
| `PRICE`          | no       | an amount and an ISO 4217 code, `480.55 CZK` by default                   |
| `PUBLIC_URL`     | no       | when a proxy hides the public origin from the request                     |

`BANK_SECRET` is the only thing worth backing up. Lose it and every unpaid order becomes unprovable,
because the preimage its payment hash was derived from cannot be derived again.

Every value here is something a standard already defines, which is the point: an IBAN is ISO 13616,
a currency is ISO 4217, a lightning address is LUD-16, a gateway URL carries its own credential the
way RFC 3986 says userinfo works, and a spread is in basis points. Nothing here has a format this
project invented, so there is nothing to look up in this README that you cannot look up somewhere
better.

## The token, and the 30 second window

Generate the token in internetbanking under Nastavení and API, with the **Sledování účtu** right.
That one is read only: it exports data and cannot pay anyone, so this service can watch the account
and could not empty it if it were compromised. One token is one account, which is why there is no
account number to configure. It works five minutes after you authorise it and lives at most 180
days.

Fio's window is per token, so `FIO_TOKEN` takes a list and five tokens on one account is a read
every six seconds instead of every thirty. They are used in turn, always the one unused longest. One
read also answers every open order at once, because Fio returns the whole account for the period.

Fio wants at most one read per token every 30 seconds and answers `409` when you ask sooner. The
gateway polls `/verify/bank` every `POLL_INTERVAL_SECS`, five by default, so `fioStatement` holds
its last answer for 30 seconds and hands it back instead of asking the bank again. On Deno Deploy
that cache dies with the invocation, so raise `POLL_INTERVAL_SECS` on your gateway to 30 or more, or
run this on something that stays up.

## Run it

```bash
IBAN=CZ6508000000192000145399 FIO_TOKEN=... \
  GATEWAY_URL=https://$GATEWAY_TOKEN@tb.example.net deno task dev
curl -s -X POST localhost:8000/order | jq
```

The `spd` in the answer is what goes in the QR. `spdToSvg(spd)` renders it, `invoiceToSvg(bolt11)`
renders the other one, or paste either into any QR generator to see what an app reads.

## Whoever arrives first, and the one that does not

`/content` asks the gateway about each leg and unlocks on the first that is paid, which is the right
shape here because an invocation on Deno Deploy ends when it answers and a transfer can take days.

A process that stays up has `gateway.firstToSettle([bankId, lightningId])` instead: it waits on
every leg, keeps the first that is really paid, and stops waiting on the rest, which closes their
sockets. An expired leg is a loser rather than a winner, so a Lightning invoice timing out after an
hour does not end a transfer that is still coming.

What it cannot do is revoke the invoice. Nobody can, because the recipient's own wallet minted it,
so a payer who pays the losing leg afterwards really has paid twice. That shows up on the trigger
socket as a second settlement for an order already closed, with the reference in `sealed`, and it is
a refund rather than a bug.
