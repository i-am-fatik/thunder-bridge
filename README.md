# thunder-bridge-direct

Lightning payments with no node of your own, and no database server either:
paid invoices land in a peer-to-peer replicated ledger that any number of
instances write together, and the pending ones never touch it.

The payer pays the recipient's **own** invoice. Nothing is held, forwarded or
custodied here, so there is no channel to fund, no liquidity to balance and
nothing to steal. Delivery is proven by the LUD-21 preimage, which the
recipient's server only releases once the payment has actually been claimed.

One process per instance, plain Node. The HTTP and WebSocket surface, the
store and the gossip all live in it, so a payment read is a synchronous SQLite
call rather than a round trip. Nothing here needs a bundler or a build step:
Node runs the TypeScript as it is written.

**The store is one SQLite file**, `node:sqlite`, no database dependency. Four
tables carry the money path and the difference between them is whether the row
is work to do or a fact that happened.

`pending` is work. It is local, mutable, and expired rows are simply deleted.
An invoice nobody pays costs 639 bytes of local disk that goes away on its own.
Each row carries a `dueAt`, so the queue is a single `UPDATE ... RETURNING`
under a lease rather than a sleeping task per payment.

`paid`, `outbox` and `delivered` are facts. A fact is immutable, carries the
origin that minted it and that origin's own sequence number, and is stamped
with an HMAC under the cluster key. `paid` records a settlement, `outbox` a
webhook owed, `delivered` the tombstone that says it landed. Facts are a
grow-only set: merging two instances is `INSERT OR IGNORE`, so it does not
matter what order they arrive in or how many times.

A paid fact proves itself. Beyond the HMAC, the payment id must be the keyed
hash of the payment hash, and the preimage must hash to that same payment
hash — the LUD-21 proof. An instance refuses to record a settlement that fails
either test, whether it made it up itself or a peer sent it, so a fact that is
on one instance would be accepted by every other.

## What it does

```
POST /incoming-payments          walk the wallet list, hand back the first live invoice
GET  /incoming-payments/{id}     read one payment
GET  /ws/incoming-payments/{id}  stream that payment until it settles
POST /quotes                     ask which address would take an amount, mint nothing
GET  /health
```

The shape is `openapi.yaml` in this directory, and the resource model follows Open
Payments 1.3.3, pinned under `docs/standards/`. Property names are snake_case rather
than that standard's camelCase, and there is no authorization server, because an API
that holds no funds and opens no accounts has nothing to grant access to.

```bash
npm install
npm test        # opens real stores, including a two-instance cluster
npm run dev     # the app, watching for changes
```

```bash
curl -s localhost:3000/incoming-payments \
  -H 'content-type: application/json' \
  -H 'idempotency-key: 6f1c8a3e-retry-safe' \
  -d '{
    "ln_addresses": ["charter@coinos.io", "charter@getalby.com"],
    "incoming_amount": {"value": "21000", "asset_code": "BTC", "asset_scale": 11}
  }'
```

```json
{
  "id": "80cd25b6c4ea19f65e21a9b8b26a289ebafee75b81a48c8f95d8412f11169ade",
  "ln_address": "charter@coinos.io",
  "incoming_amount": { "value": "21000", "asset_code": "BTC", "asset_scale": 11 },
  "status": "pending",
  "payment_hash": "888bc4c4...",
  "bolt11": "lnbc210n1...",
  "preimage": null,
  "expires_at": "2026-08-30T14:03:42.000Z",
  "created_at": "2026-07-31T14:03:42.000Z",
  "verify_url": "https://coinos.io/api/lnurl/verify/33bb39d0-..."
}
```

The amount is a count of the smallest unit, as a string. `asset_scale` 11 means
millisatoshi, so `"21000"` is 21 satoshi. It is a string and not a JSON number
because JSON numbers are IEEE 754 doubles and money is not.

`Idempotency-Key` is optional and makes the POST safe to retry. The key is claimed
before any wallet is contacted, so a retry fired while the first request is still
resolving is refused with 409 rather than asking a wallet for a second invoice. A
repeat of a finished request replays its payment. Keys are held 24 hours, which is
shorter than a payment lives.

`POST /quotes` runs only the reachability half: it fetches each address's LNURL-pay
endpoint in order and reports the first that takes the amount, along with its range and
whoever was passed over. The callback is never called, so nothing is minted and nothing
is charged to the recipient's wallet. `fee` is always zero, because the payer pays the
recipient directly and the gateway is never in the money's path. A quote is a probe and
not a promise: whether a wallet returns a provable invoice cannot be known without asking
for one, and asking mints it.

`ln_addresses` is a priority list, not a set. Wallets are tried strictly in the
order given and the first one that mints a provable invoice wins, so the rest
are never contacted. A wallet counts as unavailable for any reason at all: the
node is offline, the callback errors, the amount sits outside its limits, the
domain times out, or it publishes no `verify` URL. `ln_address` in the response
says which one actually won. If every wallet fails, the refusal names each one
and why, in the shape below.

A watcher then polls the recipient's LUD-21 `verify` URL every few seconds. On
settlement the payment flips to `paid`, carries the `preimage`, gets pushed to
every WebSocket following it, and fires the webhook. If the invoice expires
first it flips to `expired` and the polling stops.

How often it polls is one rule rather than a table of bands. For the first five
minutes, the window a payer is actually in front of the invoice, it polls every
few seconds. After that it never lets what it knows go staler than a tenth of
the payment's own age: a payment an hour old is rechecked within six minutes,
one a week old within seventeen hours, and never less than daily. The scale
follows the wait, because how long someone has already waited is the only
evidence available about how long they will keep waiting.

That costs 164 polls over the 30 days a coinos invoice lives, against 461 for a
fixed band table giving worse freshness in the middle of that range. A late
payer is still caught without hammering someone's server for a month.

Outbound `verify` polls are paced per wallet host, so the rate at which any one
server is touched stays flat no matter how many payments are pending, and a
crowded provider cannot slow the polls aimed at a quiet one. Politeness is owed
to each server separately, not to their sum. Past `MAX_PENDING` pending
rows, `POST /incoming-payments` answers 503 rather than taking on another payment.

The BOLT11 decoder is hand-rolled bech32, 90 lines, no library. It is pinned to
the spec vector plus two real invoices whose payment hashes a Rust
`lightning-invoice` build produced, so both implementations agree byte for byte.

## Errors

Every failure is an RFC 9457 problem document, served as
`application/problem+json`. Branch on `type`, never on prose.

```json
{
  "type": "urn:problem-type:thunder-bridge-direct:no-wallet-available",
  "status": 502,
  "title": "No wallet could issue a provable invoice",
  "wallets": [
    { "address": "alice@coinos.io", "reason": "unreachable" },
    { "address": "alice@wos.com", "reason": "cannot-prove-delivery" }
  ]
}
```

Two problem types are minted. `invalid-request` (400) means the body or its
fields could not be read, and `detail` names the field. `no-wallet-available`
means the wallet list was walked and nothing served, with one entry per wallet
in the order they were tried:

| `reason` | What it means | Do |
|---|---|---|
| `address-unusable` | not a lightning address, or its domain is not a public https host | fix the address |
| `unreachable` | the server returned no usable payRequest or invoice, which also covers an unknown user | retry, or check the wallet |
| `amount-not-accepted` | the amount is outside that wallet's min and max | change the amount |
| `cannot-prove-delivery` | no LUD-21 `verify` URL, or a provider known never to release a preimage | use another provider |
| `invoice-refused` | it answered with an invoice we will not accept: wrong amount, unbound metadata, or undecodable | report it, use another wallet |

The status follows the worst wallet, so a retry is never advised in vain: 502 if
any wallet was merely unreachable, else 422 if any refused permanently, else
400. Everything else is a plain status with no minted type, because nothing
API-specific is left to say: 404 for an unknown payment or path, 503 when this
instance is at capacity, 500 when it broke.

Reasons are the whole contract. The upstream URL, its status code and our own
exception text stay in this service's log, because a payer's browser is the
wrong place to learn how someone else's wallet host is wired.

## Verifying before you pay

Nothing here has to be taken on faith. The published client in `sdk/` proves,
before the payer ever sees the invoice, that the invoice really is the one that
address issued, so the short version of this whole section is one constructor.

```ts
import { ThunderBridge } from "thunder-bridge";

const request = {
  lnAddresses: ["alice@coinos.io", "alice@getalby.com"],
  amountMsat: 21_000,
};
const payment = await new ThunderBridge(gateway).createPayment(request);
```

It throws on the first thing that does not line up, before it hands the payment
back, so an invoice that reaches the payer is one that already passed.
`proveOrigin(payment, request)` is exported for anyone who wants to run the
proof by hand. The whole request goes in, not just the payment, because both
the wallet list and the amount have to be the payer's own numbers. Comparing
the invoice against what this API says about it would be the gateway checking
itself. This service deliberately ships no verifier of its own: a proof you
fetch from the party being audited is not a proof.

Two fetches, both straight to the recipient's own server, never back to this
service:

1. `user@domain` rewrites to `https://domain/.well-known/lnurlp/user`. LUD-16
   makes that a pure string transform, so nothing is trusted yet.
2. The invoice's description hash must equal the sha256 of the `metadata` that
   endpoint serves. This is what pins the invoice to *that user* rather than
   merely to that domain.
3. The `verifyUrl` must share an origin with the `callback` the endpoint
   publishes. A proof url pointing anywhere else is refused.
4. The verify response echoes `pr`, and it must be the invoice byte for byte.
   The recipient's own server is now the one saying it issued this.

Ahead of all that, three checks needing no network: the chosen address is one
you listed, and the invoice decodes to the payment hash and the amount the API
claims for it.

The list is passed per request and never stored here, which is what keeps the
chain intact. A wallet list held by this service would be one more thing the
payer has to take its word for. Whoever publishes the list is the one vouching
for it. The gateway can pick a later wallet than the recipient would have
preferred, and nothing catches that, but it can only pick from the list, so the
money still lands somewhere the recipient named.

The same code runs in a browser and on a server. It touches `fetch` and `URL`,
and `crypto.subtle` only for webhook signatures, so no Node builtin is reached
for. Bundled from `sdk/`, the client and the verifier together are 8.0 KB
minified, 20 KB with the QR renderer folded in, measured 2026-08-02 with
esbuild. Measured 2026-08-01: coinos, Alby and Stacker News all answer both
endpoints with `access-control-allow-origin`, so a browser reaches them
directly with no proxy, and this API answers every origin the same way so the
page never needs a backend of its own in between. `resolve` enforces the same
description hash binding when it mints, so the service never hands out a
payment its own verifier would reject.

What is left over is short, and worth saying out loud. The recipient's server is
trusted, because it minted the invoice and, when custodial, holds the money.
TLS and DNS for their domain are trusted. And this proves an invoice belongs to
an address, never that an address belongs to a person, so vouching for the
address stays with whoever published it.

## Webhooks

The payment id is derived from the invoice's payment hash, keyed so it cannot
be guessed from the invoice alone. Posting the same invoice again therefore
returns the same payment instead of a duplicate, from any instance, and any
webhooks from the repeat registration are merged in.

Pass a `webhook` object with a `url` and an optional `secret` when creating a
payment. A payment that reaches `paid` is POSTed as the same JSON the API
returns. Every delivery carries `x-timestamp`, and when a secret is set,
`x-signature: sha256=<hmac>` over `<timestamp>.<body>` rather than the body
alone, so a captured delivery cannot be replayed at you later. The SDK's
`parseWebhookRequest` checks both and refuses anything more than five minutes
out of date. Six attempts on a widening backoff, then it gives up. The payment
itself is unaffected either way. An expired invoice fires nothing: anyone
holding the invoice can register a webhook against it, so a hook that fired
without a payment would make this service an outbound cannon aimed wherever
they chose.

The webhook is owed from a durable outbox, not fired inline. Settling a payment
writes the paid fact and one outbox row per webhook in a single SQLite
transaction, so there is no window where a payment is settled and its webhook is
not yet owed. Retries live on the row. Restart the app mid-delivery and the debt
is still there.

Delivery is at-least-once, so deduplicate on `id`. Two instances that read the
same preimage close enough together both record a settlement and both fire, and
an instance that dies still owing a webhook has it taken over by another (below).

`POST /incoming-payments` honours an `Idempotency-Key` header. The key is claimed
before any wallet is contacted, because the retry that matters is the one a client
fires when its own timeout expires while the first request is still resolving. A
repeat of a finished request replays its payment, a repeat that arrives mid-flight
answers 409, and a request that mints nothing hands the key back. The key is bound
to the request that claimed it, so reusing it for a different amount answers 409
rather than the earlier payment. It is per-instance: keys are not gossiped, so two
concurrent requests hitting two different instances are still two invoices.

## Multiple instances

Every instance writes, and a payment created anywhere is known everywhere.
There is no leader, no quorum and no lock: one surviving instance keeps taking
payments on its own. That is the whole reason this is gossip and not Raft — a
minority can never shrink its own quorum, because it cannot tell a dead peer
from a cut cable.

Instances find each other on a Hyperswarm topic derived from the cluster key and
open a `thunder-cluster` channel. The handshake proves the peer holds that key
before anything is exchanged, and every fact carries its own HMAC on top,
because facts are relayed: a fact that reaches you through a third instance
still has to prove itself.

Pending payments are a best-effort push. Facts gap-sync. Each side sends what it
has as one number per origin per table, the other replies with everything above
that mark, and it repeats until the batch comes back short. Because facts are
immutable and self-verifying, catching up is just replaying rows nobody can
forge, and a peer that was away for a week converges the same way as one that
missed a second. A resync runs every thirty seconds regardless, so a dropped
push heals without anyone noticing it was dropped.

The webhook outbox replicates too, and that closes the case where the instance
that settled a payment dies before delivering. Every instance that holds the
outbox row schedules it locally: the origin tries immediately, everyone else
waits `TAKEOVER_AFTER_SECS` plus a stagger from a hash of the row and their own
identity, so takeovers do not all fire at once. The `delivered` tombstone is
what calls them off. Guessing the order wrong costs a duplicate delivery, never
a lost webhook, which is the right way round for something the merchant already
has to deduplicate.

Nobody hands out leases and nobody splits the work. Every instance polls every
pending payment it holds. Splitting them by a hash of the payment id looks
cheaper and is not: what it saves is small enough to measure. A full pending set
costs one instance 0.31 `verify` polls a second against a per-host budget of
five, so a second instance doubling that spends twelve percent of the budget to
remove the question.

A payment settles once per instance that saw the preimage, and every one of
those records says the same thing, because a paid fact is the invoice, the
payment hash and the preimage that opens it. There is nothing to reconcile.
`won` tells the caller whether this instance was the one that wrote it, and that
is what decides who owes the webhook first.

Joining is one step: start another instance with the same `CLUSTER_KEY`. The key is
the topic, the handshake and the write gate at once, so there is no writer to
authorise and nobody to ask.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | listen port, Railway sets this for you |
| `POLL_INTERVAL_SECS` | `5` | how often a payment under five minutes old polls `verify` |
| `POLLS_PER_SEC` | `5` | ceiling on outbound `verify` polls per wallet host, and the batch each tick takes |
| `CLUSTER_KEY` | required | 32 bytes of hex, the swarm topic and the right to write a fact |
| `LEDGER` | `./data/ledger.db` | the SQLite file, everything lives here |
| `MAX_PENDING` | `5000` | pending rows before `POST /incoming-payments` answers 503 |
| `TAKEOVER_AFTER_SECS` | `600` | how long another instance waits before delivering a webhook it does not own |
| `WEBHOOK_BACKOFF_SECS` | `30` | step between delivery attempts, six attempts then it parks |
| `SWARM` | on | `0` turns off Hyperswarm DHT discovery |
| `REPLICATE_LISTEN` | none | also accept direct TCP replication on this port |
| `REPLICATE_PEERS` | none | comma-separated `host:port` peers to dial directly |

Every numeric variable is validated at boot and a nonsense value stops the
process rather than being coerced. `POLLS_PER_SEC=0` used to wedge the watcher
silently; now it refuses to start.

## Container

One image, one runtime, one process: `node:24-slim` running `src/index.ts`.

```bash
docker build --pull -t thunder-direct .
docker run -d -p 3000:3000 -v thunder-data:/data \
  -e CLUSTER_KEY=<32 bytes hex> thunder-direct
```

The build stage gates the image: `npm ci`, the whole test suite against real
stores, `tsc --noEmit`. Alpine is not an option, Hyperswarm's
native modules ship no musl prebuilds. Prebuilds for every
platform except linux are pruned before the final stage, which trims ~150 MB
of other systems' binaries.

## Railway

Live at
[thunder-bridge-direct-production.up.railway.app](https://thunder-bridge-direct-production.up.railway.app/health).

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/github?repo=https://github.com/i-am-fatik/thunder-bridge)

That opens Railway's deploy-from-GitHub flow on this repo. `railway.json` hands
it the Dockerfile, `/health` as the check and restart-always, so the only thing
left to fill in is `CLUSTER_KEY`, which is `openssl rand -hex 32`. Nothing boots
without it, deliberately: it is the swarm topic, the handshake and the write
gate at once.

`railway up` from a checkout does the same thing. Three things matter either
way:

- **No `VOLUME` instruction.** Railway's builder rejects it, and the build then
  fails two seconds in with an empty log and `Failed to build an image`. Mount
  points belong on the service, not in the Dockerfile.
- **Point the domain at the injected port.** Railway sets `PORT` and the server
  binds it, so `railway domain --port 8080`. `EXPOSE 3000` is not what the proxy
  routes to, and the mismatch shows up as a 502 while the container logs a
  healthy start.
- **Do not set `PORT`.** Railway injects it, the server reads it.

State survives through the other instances, not through the disk. A redeploy
starts on an empty file and gap-syncs every fact back from its peers, since a
fresh instance is just one whose watermarks are all zero. That makes a second
instance somewhere else the actual durability mechanism: until one exists, set a
volume at `/data` or accept that a lone redeploy forgets. Losing `CLUSTER_KEY`
locks you out of your own cluster, and there is nobody to ask for it back.

## What you give up

- **The recipient must implement LUD-21.** BTCPay Server v2.3.8+, Alby, coinos,
  Blink, stacker.news, Minibits and the Spark-hosted wallets do. Wallet of
  Satoshi, Strike, Cash App, ZBD and Primal do not, and their users are refused
  at creation rather than sold a payment nobody could prove. Measured coverage,
  and the ones that answer `verify` without ever giving a preimage, live in
  [docs/lud21-coverage.md](docs/lud21-coverage.md).
- **No fee.** Nothing flows through this service, so there is nothing to take a
  cut of.
- **No privacy layer.** The payer sees the recipient's real invoice and node.
- **No BOLT12.** Fetching an invoice from an offer needs a node.
- **The proof is the recipient's word, cryptographically.** The preimage proves
  their server released it. It protects the payer against this service, not
  against a recipient inflating their own totals.
- Every outbound URL must be public https. A webhook to a private address is
  refused along with everything else on the local network.
