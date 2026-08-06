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

Failures are RFC 9457 problem documents served as `application/problem+json`.
Branch on `type`, never on prose. Five types are minted, and the spec enumerates
what each refusal reason means and what to do about it.

The resource model follows Open Payments 1.3.3, pinned under
[docs/standards/](docs/standards). Property names are snake_case rather than that
standard's camelCase, and there is no authorization server.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CLUSTER_KEY` | required | 32 bytes of hex, the swarm topic and the right to write a fact |
| `PORT` | `3000` | listen port, Railway sets this for you |
| `LEDGER` | `./data/ledger.db` | the SQLite file, everything lives here |
| `GATEWAY_TOKEN` | none | bearer required on every route except `/health`, `/ready`, `/openapi.yaml` and `/docs` |
| `POLL_INTERVAL_SECS` | `5` | how often a payment under five minutes old polls `verify` |
| `TICK_STALL_SECS` | `30` | how long the watch loop may go unscheduled before `/health` turns 503 |
| `DRAIN_TIMEOUT_SECS` | `10` | how long a shutdown waits for the tick in flight before closing anyway |
| `POLLS_PER_SEC` | `5` | ceiling on outbound `verify` polls per wallet host, and the batch each tick takes |
| `MAX_PENDING` | `5000` | payments the cluster watches before a create or a watch answers 503, never a limit on what an instance knows |
| `TAKEOVER_AFTER_SECS` | `600` | how long another instance stands by before taking on work it does not own, a webhook to deliver or a payment to poll |
| `WEBHOOK_BACKOFF_SECS` | `30` | step between delivery attempts, six attempts then it parks |
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

One image, one process: `node:24-slim` running `src/index.ts`. The build stage
gates it with `npm ci`, the whole test suite, and `tsc --noEmit`.

## Railway

Live at
[thunder-bridge-production.up.railway.app](https://thunder-bridge-production.up.railway.app/health).
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
  [docs/lud21-coverage.md](docs/lud21-coverage.md).
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
  refused along with everything else on the local network.

## More

- [sdk/](sdk) - the JavaScript client, which proves an invoice before the payer
  sees it.
- [examples/deno-deploy](examples/deno-deploy) - a paywall and a lightning
  address in one Fetch handler.
- [examples/bank-transfer](examples/bank-transfer) - the same shop on a Czech QR
  platba, settled by the same rule.
- [examples/trigger-watcher](examples/trigger-watcher) - one socket that hears
  every settlement.

MIT.
