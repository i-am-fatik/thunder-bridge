# thunder-bridge

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/Nq9_0q)
[![Deploy the example on Deno](https://deno.com/deploy.svg)](https://console.deno.com/new?clone=https://github.com/i-am-fatik/thunder-bridge&path=examples/deno-deploy)

Lightning payments with no node and no database server. Post a priority list of
lightning addresses and an amount, and the gateway asks each address's own
LNURL-pay endpoint for a real invoice and hands back the first provable one. The
payer pays the recipient's own invoice, so nothing is held, forwarded or
custodied here and there is no fee to take.

Settlement is proved, not asserted. A payment reaches `paid` only when the
recipient's own LUD-21 endpoint releases a preimage that hashes to the invoice's
payment hash.

Why it is built this way is in [docs/design.md](docs/design.md).

## Run it

```bash
npm install
npm test        # real stores, including a two-instance cluster
CLUSTER_KEY=$(openssl rand -hex 32) npm run dev
```

No bundler and no build step. Node runs the TypeScript as written, and the store
is one SQLite file through `node:sqlite`.

## Call it

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

An amount is a count of the smallest unit as a string. `asset_scale` 11 is
millisatoshi, so `"21000"` is 21 satoshi. A string rather than a JSON number
because JSON numbers are IEEE 754 doubles and money is not.

`ln_addresses` is a priority list, not a set. Addresses are tried strictly in
order, the first that mints a provable invoice wins, and `ln_address` in the
answer says which one did. `Idempotency-Key` is optional and makes the POST safe
to retry.

## The surface

```
POST /incoming-payments          walk the address list, return the first live invoice
GET  /incoming-payments          list payments, newest first
GET  /incoming-payments/{id}     read one payment
POST /quotes                     ask which address would take an amount, mint nothing
POST /watched-payments           watch an invoice you obtained yourself
POST /ws-tickets                 exchange a secret for a short-lived socket ticket
GET  /health                     is this instance alive, the one thing a restart cures
GET  /ready                      should it be sent work, plus the vitals on a gated instance
GET  /openapi.yaml
GET  /docs                       the specification, rendered

WS   /ws/incoming-payments/{id}  stream one payment until it settles
WS   /ws/triggers/{trigger}      stream every payment carrying a trigger
WS   /ws/tickets/{ticket}        the same two streams, opened with a ticket
```

[`openapi.yaml`](openapi.yaml) is the contract: request and response shapes,
status codes, and every refusal reason. Every instance serves it and renders it
at `/docs`, both without a bearer even on a gated instance, because a
specification says what the API is and never what anyone's payments are.

Pass a `webhook` object when creating a payment and a settlement is POSTed to
your URL, signed and timestamped, retried from a durable outbox that survives a
restart. Delivery is at-least-once, so deduplicate on `id`. The shape and the
signature scheme are under `webhooks` in the spec.

The URL is challenged before the payment is taken on, and the create is refused
if it does not answer, so this gateway never sends an unsolicited request to an
address a caller merely named. Your endpoint has to be serving first, and the
client's `answerWebhookChallengeRequest` is the whole of that side.

A `verify_url` handed to `POST /watched-payments` is checked the same way, twice,
before anything is watched: it has to answer the LUD-21 shape, and then it has to
answer a challenge of its own. Speaking the protocol is what every real wallet
does and says nothing about wanting this gateway's traffic, so the last hop
belongs on your side. Serve
[`lightningVerifyEndpoint`](sdk) or `bankVerifyEndpoint`, which answer the
challenge for you and ask the wallet themselves, and a wallet then throttles the
abuser's own host rather than this instance's address, which its every other
client shares. A `verify_url` the gateway found itself while minting is never
challenged, because there the caller named nothing.

That endpoint also sets its own polling pace with `Cache-Control: max-age`, so a
bank that moves once a minute says so rather than being asked every few seconds on
a schedule this gateway picked.

Failures are RFC 9457 problem documents served as `application/problem+json`.
Branch on `type`, never on prose. Six types are minted, and the spec enumerates
what each refusal reason means and what to do about it.

The resource model follows Open Payments 1.3.3, pinned under
[docs/standards/](docs/standards). Property names are snake_case rather than that
standard's camelCase, and there is no authorization server.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CLUSTER_KEY` | required | 32 bytes of hex, the swarm topic and the right to write a fact |
| `MINTING` | off | `1` turns on `POST /incoming-payments` and `POST /quotes`. Off, the gateway only watches invoices a client minted itself, which is the only way the operator never sees an address or an amount |
| `CLIENT_KEYS` | none | comma-separated client public keys this instance serves, and it serves nobody else. Unset serves everybody |
| `KEEP_SEALED_DAYS` | `90` | how long a sealed blob outlives the payment it belonged to, after which it goes too |
| `PORT` | `3000` | listen port, Railway sets this for you |
| `LEDGER` | `./data/ledger.db` | the SQLite file, everything lives here |
| `GATEWAY_TOKEN` | none | bearer required on every route except `/health`, `/ready`, `/openapi.yaml`, `/docs` and `/webhook-key`. Blank counts as none, so a variable someone emptied leaves the gateway public rather than private and open to everyone |
| `POLL_INTERVAL_SECS` | `5` | how often a payment under five minutes old polls `verify`, used only where the endpoint names no pace of its own with `Cache-Control: max-age` |
| `WORK_PER_TICK` | `50` | polls and webhook deliveries a tick takes on, which is the throughput ceiling, not the politeness one |
| `VERIFY_CHALLENGE` | on | `0` stops challenging a `verify_url` a caller named, so any host that speaks LUD-21 can be pointed at. Only for an instance whose callers are all known, because it is what stops one caller spending a wallet's patience on an address every other client here shares |
| `VERIFY_HOSTS` | none | comma-separated hostnames this instance may poll. Set it and the gateway talks to nobody else: a watch naming another host is refused 403, and minting is refused outright because an invoice it mints is always verified on a wallet's host. Leave it unset and any public https verify URL is allowed |
| `TICK_STALL_SECS` | `30` | how long the watch loop may go unscheduled before `/health` turns 503 |
| `DRAIN_TIMEOUT_SECS` | `10` | how long a shutdown waits for the tick in flight before closing anyway |
| `POLLS_PER_SEC` | `5` | fallback ceiling on outbound `verify` polls per host, used only where the endpoint names none itself with `RateLimit-Limit`. It stops one wallet everybody uses being hit harder than this however many payments point at it |
| `MAX_PENDING` | `5000` | payments one signing key may have waiting before a create or a watch answers 429. Every unsigned caller shares one share of it. `0` takes nothing new while still polling and serving what it holds, which is how a release that changes a delivery is cut over |
| `TAKEOVER_AFTER_SECS` | `600` | how long another instance stands by before taking on work it does not own, a webhook to deliver or a payment to poll |
| `WEBHOOK_BACKOFF_SECS` | `30` | step between delivery attempts, each one that far further off than the last, retried for as long as the payment has left and never under an hour |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent`. At `info` a line names every payment paid and every webhook delivered, so a shop's order flow is in your logs until you turn it down |
| `SWARM` | on | `0` turns off Hyperswarm DHT discovery |
| `REPLICATE_LISTEN` | none | also accept direct TCP replication on this port |
| `REPLICATE_PEERS` | none | comma-separated `host:port` peers to dial directly |

Every numeric variable is validated at boot. A nonsense value stops the process
rather than being coerced.

On `SIGTERM` or `SIGINT` the instance turns `/ready` down, stops taking sockets,
waits out the tick in flight and closes the ledger, so nothing is dropped mid-poll
and no webhook debt is lost. A second signal exits at once.

Joining a cluster is one step: start another instance with the same
`CLUSTER_KEY`. There is no leader, no quorum and no writer to authorise.

## Container

```bash
docker build --pull -t thunder-bridge .
docker run -d -p 3000:3000 -v thunder-data:/data \
  -e CLUSTER_KEY=$(openssl rand -hex 32) thunder-bridge
```

One image, one process: `node:24.19-slim` running `src/index.ts`. The build stage
gates it with `npm ci`, the whole test suite, and `tsc --noEmit`.

## Railway

Live at
[thunder-bridge-production.up.railway.app](https://thunder-bridge-production.up.railway.app/health).
That instance is a demo. It runs with no `GATEWAY_TOKEN`, so it answers anyone, it
keeps no durability promise, and its ledger may be wiped whenever. Point nothing you
care about at it: run your own, and the client refuses a gateway that serves
strangers unless you say otherwise.

The template carries this repo, a volume at `/data`, and a `CLUSTER_KEY`
generated per deploy, so there is nothing to fill in. Copy that key somewhere
once it is up. Losing it locks you out of your own cluster and there is nobody to
ask for it back.

Three things bite either way, and [docs/design.md](docs/design.md#railway) says
why: no `VOLUME` instruction in the Dockerfile, point the domain at the injected
port with `railway domain --port 8080`, and never set `PORT` yourself.

## Limits

- **The recipient must implement LUD-21.** BTCPay v2.3.8+, Alby, coinos, Blink,
  stacker.news, Minibits and the Spark-hosted wallets do. Wallet of Satoshi,
  Strike, Cash App, ZBD and Primal do not, and their users are refused at
  creation. Measured coverage is in
  [docs/lud21-coverage.md](docs/lud21-coverage.md), re-measured against live
  wallets on the first of each month rather than read off anyone's changelog.
- **No fee, and no privacy layer.** Nothing flows through this service, and the
  payer sees the recipient's real invoice and node.
- **No BOLT12.** Fetching an invoice from an offer needs a node.
- **The proof is the recipient's word, cryptographically.** The preimage proves
  their server released it. It protects the payer against this service, not
  against a recipient inflating their own totals.
- **Nothing is watched for longer than three days.** Every payment gets that same
  promise, and `POST /watched-payments` refuses an `expires_at` past it rather
  than taking on a watch it will drop. A wallet's 30-day invoice stays payable
  after day three, it just is not being watched here.
- **Every outbound URL must be public https.** A webhook to a private address is
  refused along with everything else on the local network. The name is resolved once
  and the connection is pinned to exactly the addresses that check passed, so a name
  that answers publicly and then rebinds to `127.0.0.1` never gets connected to, and
  the certificate is still checked against the name rather than the address. A name
  nothing answers for is refused here rather than left to the connection.
- **A keypair is free to make, so a quota is fairness rather than a defence.**
  `MAX_PENDING` counts per signing key, so one caller filling its share leaves
  everybody else's alone and a caller over it gets `429`. Nothing stops the same
  stranger coming back under a new key, though. `CLIENT_KEYS` does, by serving a named
  list and nobody else, and that is the whole defence on an instance whose clients are
  known. An instance open to strangers still wants a limiter in front of it.
- **An unsigned caller is anonymous, and anonymous callers share one share.** Signing
  is what makes a payment yours to read, so a caller that signs nothing gets a payment
  any holder of the id can read, and its watches count against the one share every
  anonymous caller shares.
- **An `Idempotency-Key` is scoped to whoever presented it, and only for a signed
  caller.** A replay hands back the payment that key created, which is what makes a
  retry safe. On a signed call that is your key's own key. Unsigned, it is still a
  capability anybody can guess their way into, so use a random one or sign.

## More

- [docs/operations.md](docs/operations.md) - deploying, rolling back, and what
  durability actually depends on, for whoever runs one of these for somebody else.
- [sdk/](sdk) - the JavaScript client, which proves an invoice before the payer
  sees it.
- [examples/deno-deploy](examples/deno-deploy) - a paywall and a lightning
  address in one Fetch handler.
- [examples/bank-transfer](examples/bank-transfer) - the same shop on a Czech QR
  platba, settled by the same rule.
- [examples/trigger-watcher](examples/trigger-watcher) - one socket that hears
  every settlement.

MIT.
