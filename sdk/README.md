# thunder-bridge

[![npm](https://img.shields.io/npm/v/thunder-bridge)](https://www.npmjs.com/package/thunder-bridge)
[![ci](https://github.com/i-am-fatik/thunder-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/i-am-fatik/thunder-bridge/actions/workflows/ci.yml)

Take Bitcoin Lightning and bank payments in a JavaScript app, paid straight into
your own wallet or bank account. There is no Lightning node to run, and nobody holds
the money on the way.

You ask for a payment and show the payer a QR code. They pay you directly. A
Thunder Bridge gateway, a small server you can use or run yourself, watches for the
payment and tells you once it is paid. The SDK checks what the gateway reports
against what you already hold, so a gateway cannot fake a payment.

## Install

```bash
npm install thunder-bridge
```

## Quick start

This runs as written in a page with no backend of its own. The url is a public demo
gateway that answers anyone and forgets everything on restart.

```ts
import { sats, ThunderBridge } from "thunder-bridge";

const gateway = new ThunderBridge("https://public.thunder-bridge.agora.gripe");

const asked = await gateway.requestPayment({
  paidTo: ["iamfatik@blink.sv", "iamfatik@coinos.io"],
  amount: sats(21),
  signal: AbortSignal.timeout(600_000),
});

const target = document.querySelector("#qr");
if (target !== null) {
  target.innerHTML = asked.qr;
}

await asked.paid();

const preimage = await asked.prove();
```

`requestPayment` gets an invoice from the first address that can give one, checks it
against the recipient's own server, and draws the QR. `paid` is the gateway's report,
and it resolves only on a preimage that hashes to the payment hash. `prove` asks the
recipient's own server, a second source for when the gateway goes silent.

An amount is `sats(21)`, `msat(21_000)` or `fiat("4.99", "EUR")`. A bare number does
not compile, so `21` is never read as 21 millisatoshi.

## What it does

| You want to | Call |
|---|---|
| show a QR and wait until it is paid, with no backend of your own | `requestPayment` |
| sell from your server, paid to your Lightning address | `gateway.rails.lightning` |
| sell from your server, paid into your own wallet over Nostr Wallet Connect | `gateway.rails.nwc` |
| sell from your server, paid by bank transfer | `gateway.rails.bank` |
| hear about every payment on your server | `gateway.serve.webhook` |

A rail is one call per sale. By default the gateway then checks the payment through
an endpoint on your server, which you mount from `gateway.serve`.
[docs/recipes.md](../docs/recipes.md) has one runnable program per use case.

## Which wallets work

| Rail | Works with |
|---|---|
| `gateway.rails.nwc` | any wallet whose NWC connection grants `make_invoice` and `lookup_invoice` |
| `gateway.rails.bank` | any account whose statement you can read. `fioStatement` reads Fio, any other bank is a `Statement` you write |
| `gateway.rails.lightning`, `requestPayment` | a lightning address on a domain that releases the preimage over LUD-21, below |

| Lightning address on | Ends with |
|---|---|
| Blink | `@blink.sv` |
| Alby | `@getalby.com` |
| coinos | `@coinos.io`, `@coinos.pro` |
| Minibits | `@minibits.cash` |
| Speed | `@speed.app` |
| Cake, Breez, Blitz, the Spark-hosted brands | `@cake.cash`, `@breez.tips`, `@blitzwalletapp.com` |
| a BTCPay Server of your own | your domain, from v2.3.8 |

Wallet of Satoshi, Strike, Cash App, ZBD, Primal, Fountain, LNbits, ZEUS Pay and
ecash.love release no preimage, so a recipient there needs a wallet with NWC instead.
The measured list, last surveyed 2026-08-12, is
[docs/lud21-coverage.md](../docs/lud21-coverage.md).

## What the proof covers

A payment counts as paid only when the recipient's wallet, or your own server on the
bank rail, releases a preimage that hashes to the payment hash. The gateway cannot
make one up. The proof does not cover a recipient asking for more than they are owed,
or a wallet provider that also runs the gateway.
[docs/proving-a-payment.md](../docs/proving-a-payment.md#who-you-still-have-to-trust)
says who you still have to trust.

## Webhooks

Pass `webhookUrl` when you create a payment, or on any rail, and mount this route at
that URL first. The gateway checks that the URL answers before it accepts the payment.

```ts
import { ThunderBridge } from "thunder-bridge";

declare function fulfil(paymentId: string, preimage: string): Promise<void>;

const gateway = new ThunderBridge("https://public.thunder-bridge.agora.gripe");

export const POST = gateway.serve.webhook({
  onSettled: async (settlement) => {
    await fulfil(settlement.id, settlement.preimage);
  },
});
```

The route checks the gateway's signature and calls `onSettled` only for a delivery
whose preimage hashes to its payment hash. A delivery can arrive more than once, so
fulfil idempotently on `id`.
[Webhooks in full](../docs/proving-a-payment.md#webhooks-in-full) covers the
signature, replays, and frameworks that hand you a raw body.

## Errors

Every failure from the gateway is a `ProblemError` carrying an RFC 9457 `type`.
[docs/errors.md](../docs/errors.md) lists every type, the failures the client finds
itself, and a handler.

## Imports and runtimes

`thunder-bridge` is the whole client. The other four entry points hold what a
checkout page should not have to download.

| Import | What it is for |
|---|---|
| `thunder-bridge` | the gateway, the proofs, the errors and the amounts. Everything is reached through one instance |
| `thunder-bridge/qr` | a payload as an SVG or a data URL, for a page that draws a QR of its own |
| `thunder-bridge/price` | the exchange venues behind `fiat`, for pricing off your own book instead |
| `thunder-bridge/bank` | a bank statement reader, currently Fio |
| `thunder-bridge/nwc` | your own wallet over NIP-47, which carries the nostr crypto no browser wants |

Anything that opens a socket needs Node 22 or newer: `requestPayment`, `settled`,
`firstSettled`, `follow`, `attend` and every NWC call. `invoiceFrom`,
`serve.lightningVerify` and `rails.lightning` without `gatewayMints` resolve wallet
hostnames through `node:dns` and pin the connection to the checked address through
`node:https`, so they need Node and run on neither Cloudflare Workers nor Deno.
Everything else runs on any runtime with `fetch` and `crypto.subtle`, and a browser
bundler leaves those Node imports alone.

## More

- [docs/recipes.md](../docs/recipes.md) - one runnable program per use case
- [docs/api.md](../docs/api.md) - every export, generated from the code
- [docs/proving-a-payment.md](../docs/proving-a-payment.md) - how each rail is
  verified, what each one costs you, and who you still have to trust
- [docs/errors.md](../docs/errors.md) - every problem type and what to do with it
- [docs/lud21-coverage.md](../docs/lud21-coverage.md) - which address domains
  release a preimage, and how that was measured
- [`openapi.yaml`](openapi.yaml) - what your endpoints answer once mounted, shipped
  with this package
- [CHANGELOG.md](CHANGELOG.md) - what changed in each version, and how to move to 3.0
- [the gateway](../README.md) - running one yourself, and developing this repository
- [issues](https://github.com/i-am-fatik/thunder-bridge/issues) - bugs and questions

MIT.
