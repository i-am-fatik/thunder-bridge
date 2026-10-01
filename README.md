# thunder-bridge

[![ci](https://github.com/i-am-fatik/thunder-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/i-am-fatik/thunder-bridge/actions/workflows/ci.yml)

A gateway that watches Lightning and bank payments without holding any of them. A
client hands it a payment hash and a verify URL, the LUD-21 endpoint that releases
the preimage once the invoice is paid. The gateway polls that URL until it returns a
preimage that hashes to the payment hash, then tells the client over a websocket or a
signed webhook. It runs no Lightning node and needs no database server. Instances
started with the same key replicate to each other, so any one of them can go away.

Most callers reach it through the JavaScript client in [sdk/](sdk), which checks
everything the gateway reports.

## Run it

```bash
npm install
npm test        # real stores, including a two-instance cluster
CLUSTER_KEY=$(openssl rand -hex 32) npm run dev
```

It needs Node 26.8.1 or newer, which runs the TypeScript as written. There is no
bundler and no build step, and the store is one SQLite file through `node:sqlite`.

```bash
docker build --pull -t thunder-bridge .
docker run -d -p 3000:3000 -v thunder-data:/data \
  -e CLUSTER_KEY=$(openssl rand -hex 32) thunder-bridge
```

The image is `node:26.8.1-slim` running `src/index.ts`, with the ledger at
`/data/ledger.db`. Its build stage runs `npm ci`, the test suite and `tsc --noEmit`.

## Call it

By default a gateway only watches invoices its clients minted themselves, through
`POST /watched-payments`. Minting is off because it is the one path that shows the
operator the address and the amount. Start the instance with `MINTING=1` to try it
with curl, and the gateway fetches the invoice itself:

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
  "kind": "minted",
  "ln_address": "charter@coinos.io",
  "incoming_amount": { "value": "21000", "asset_code": "BTC", "asset_scale": 11 },
  "status": "pending",
  "bolt11": "lnbc210n1...",
  "payment_hash": "888bc4c4...",
  "verify_url": "https://coinos.io/api/lnurl/verify/33bb39d0-...",
  "preimage": null,
  "expires_at": "2026-08-30T14:03:42.000Z",
  "created_at": "2026-07-31T14:03:42.000Z"
}
```

Amounts are strings in the smallest unit. `asset_scale` 11 is millisatoshi, so
`"21000"` is 21 satoshi. Addresses are tried in order, and `ln_address` says which
one minted. An optional `Idempotency-Key` makes the POST safe to retry.

## The surface

```
POST /incoming-payments          walk the address list, return the first live invoice
GET  /incoming-payments          list payments, newest first, on a gated instance only
GET  /incoming-payments/{id}     read one payment
POST /quotes                     ask which address would take an amount, mint nothing
POST /watched-payments           watch an invoice you obtained yourself
POST /ws-tickets                 exchange a secret for a short-lived socket ticket
GET  /health                     liveness, 503 once the watch loop stalls
GET  /ready                      should it be sent work, plus the vitals on a gated instance
GET  /webhook-key                the public key every webhook is signed with
GET  /openapi.yaml
GET  /docs                       the specification, rendered

WS   /ws/incoming-payments/{id}  stream one payment until it settles
WS   /ws/triggers/{trigger}      stream every payment carrying a trigger
WS   /ws/tickets/{ticket}        the same two streams, opened with a ticket
```

[`openapi.yaml`](openapi.yaml) is the contract: request and response shapes, status
codes, and every refusal reason. Every instance serves it and renders it at `/docs`,
without a bearer even on a gated instance.

- **Webhooks.** Pass a `webhook` object when creating a payment, and the settlement
  is POSTed to your URL. It is signed with the key at `/webhook-key` and retried from
  an outbox that survives a restart. Delivery is at-least-once, so deduplicate on
  `id`. The URL must answer a challenge before the payment is accepted, which the
  client's `serve.webhook` does.
- **Watching.** A `verify_url` handed to `POST /watched-payments` must answer in the
  LUD-21 shape, and then echo a challenge unless `VERIFY_CHALLENGE=0`, before
  anything is watched. The client's `serve.lightningVerify`, `serve.bankVerify` and
  `serve.nwcVerify` answer both. They ask the wallet or the bank themselves and set
  the polling pace with `Cache-Control: max-age`.
- **Errors.** Every failure is an RFC 9457 problem document, and
  [docs/errors.md](docs/errors.md) lists every `type`.
- **The model.** Resources follow Open Payments 1.3.3, pinned under
  [docs/standards/](docs/standards), in snake_case and with no authorization server.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CLUSTER_KEY` | required | 32 bytes of hex, the same on every instance of one cluster. A peer without it cannot join. It also derives the swarm topic, payment ids and the webhook signing key |
| `MINTING` | off | `1` turns on `POST /incoming-payments` and `POST /quotes`. Off, the gateway only watches invoices its clients minted |
| `CLIENT_KEYS` | none | comma-separated client public keys. Set, the instance serves only these and answers anyone else `caller-unknown`. Unset serves everybody |
| `PUBLIC_HOSTS` | none | comma-separated hosts, with a port where it is not the default, that a signed request may name as this gateway. Unset, the `Host` header is believed, which is safe behind a proxy that routes by host and unsafe where anybody can reach the instance directly |
| `KEEP_SEALED_DAYS` | `90` | days a client's sealed data is kept after the payment it was attached to is pruned |
| `PORT` | `3000` | listen port |
| `HOST` | `0.0.0.0` | interface to bind. `127.0.0.1` keeps the gateway off the network, for a reverse proxy on the same host |
| `SOCKET` | none | listen on this unix socket instead of TCP. `PORT` and `HOST` are ignored, and the file's permissions are the only access control |
| `LEDGER` | `./data/ledger.db` | the SQLite file that holds everything |
| `GATEWAY_TOKEN` | none | bearer required on every route except `/health`, `/ready`, `/openapi.yaml`, `/docs` and `/webhook-key`. A blank value counts as unset and leaves the gateway public |
| `POLL_INTERVAL_SECS` | `5` | poll interval for a payment under five minutes old. After that the gap is a tenth of the payment's age. Used only where the verify endpoint sets no `Cache-Control: max-age` |
| `WORK_PER_TICK` | `50` | the most polls, and the most webhook deliveries, one tick takes on. It caps throughput, not the pace toward one host |
| `VERIFY_CHALLENGE` | on | `0` stops challenging a caller's `verify_url`, so a wallet's own LUD-21 URL can be watched directly. Use it only where every caller is known. The challenge is what stops one caller using up the polls a wallet allows every client of this instance |
| `VERIFY_HOSTS` | none | comma-separated hostnames this instance may poll. Set, a watch naming another host is refused 403, and minting is off because a minted invoice is verified on the wallet's host. Webhooks are not restricted. Unset allows any public https verify URL |
| `TICK_STALL_SECS` | `30` | how long the watch loop may go unscheduled before `/health` turns 503 |
| `DRAIN_TIMEOUT_SECS` | `10` | how long a shutdown waits for the tick in flight before closing anyway |
| `POLLS_PER_SEC` | `5` | ceiling on `verify` polls per host per second, shared across the cluster. Used only where the endpoint names none with `RateLimit-Limit` |
| `MAX_REPLAY` | `100` | the most settlements per trigger a client may ask, through `replay`, to keep replayable past the hour the gateway otherwise keeps them. Every trigger may hold this many in the ledger |
| `MAX_SOCKETS` | `10000` | sockets this instance holds open at once, of every kind together. The next upgrade is refused 503 |
| `MAX_PENDING` | `5000` | payments one signing key may have waiting before a create or a watch answers 429. All unsigned callers share one such allowance. `0` takes nothing new while still polling and serving what it holds, which is how a release that changes a delivery is cut over |
| `TAKEOVER_AFTER_SECS` | `600` | how long another instance waits before delivering a webhook it does not own |
| `WEBHOOK_BACKOFF_SECS` | `30` | backoff step between delivery attempts, each wait one step longer than the last. Retries run until the payment expires, and for at least an hour |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent`. At `info` every paid payment and every delivered webhook is logged, so a shop's order flow lands in your logs |
| `SWARM` | on | `0` turns off Hyperswarm DHT discovery |
| `REPLICATE_LISTEN` | none | also accept direct TCP replication on this port |
| `REPLICATE_PEERS` | none | comma-separated `host:port` peers to dial directly, its own address included if that is simpler. Set, `/ready` answers 503 until the first catch-up with a connected peer, and for at most 30 seconds while none is connected |

Every numeric variable is validated at boot, and a malformed value stops the process
instead of being coerced. On `SIGTERM` or `SIGINT` the instance turns `/ready` down,
waits out the tick in flight and closes the ledger. A second signal exits at once.

Joining a cluster is starting another instance with the same `CLUSTER_KEY`. There is
no leader and no quorum. The instances take turns, so one of them polls each pending
payment per turn. An instance that goes quiet is covered one interval later.
[docs/operations.md](docs/operations.md#three-instances-behind-one-hostname) puts
three behind one hostname.

## Live

[public.thunder-bridge.agora.gripe](https://public.thunder-bridge.agora.gripe/health)
runs with `MINTING=1` and no `GATEWAY_TOKEN`, so it mints for anyone. Its ledger is an
`emptyDir` that a restart or a flood wipes. It is rate limited and nothing on it is
backed up, so point nothing you care about at it. The bank rail refuses it unless you
pass `allowPublicGateway`, because an operator who answers strangers learns every
watch you place. It holds no funds, so the most a stranger takes out of it is an
invoice of their own.

## Limits

- **A lightning address needs LUD-21.** Only a domain whose `verify` URL releases the
  preimage can be watched. [docs/lud21-coverage.md](docs/lud21-coverage.md) lists
  them, re-measured against live wallets on the first of each month, and says how a
  recipient elsewhere is paid over NWC.
- **No fee, and no privacy layer.** Nothing flows through this service, and the
  payer sees the recipient's real invoice and node.
- **No BOLT12.** Fetching an invoice from an offer needs a node.
- **The proof is the recipient's word, cryptographically.** It protects the payer
  against this service, not against a recipient inflating their own totals.
- **Nothing is watched for longer than thirty days.** `POST /watched-payments`
  refuses an `expires_at` past that rather than taking on a watch it will drop.
- **Every outbound URL must be public https.** The name is resolved once and the
  connection pinned to the addresses that passed, as
  [docs/design.md](docs/design.md#talking-to-a-stranger) explains.
- **A quota is fairness, not a defence.** `MAX_PENDING` counts per signing key, and
  a new key is free to make. `CLIENT_KEYS` is the defence where the clients are
  known. An instance open to strangers still wants a rate limiter in front of it.
- **Sign, or share with everyone unsigned.** A signature names the gateway it was
  made for, and its nonce is spent once across the cluster. A caller that signs
  nothing gets a payment any holder of the id can read. It shares one quota with
  every other unsigned caller and has an `Idempotency-Key` anybody can guess. A
  client older than 2.2.0 signs neither the gateway nor a nonce, so its signature
  can be replayed within five minutes of its timestamp.

## More

- [docs/operations.md](docs/operations.md) - deploying, rolling back, and what
  durability depends on
- [docs/design.md](docs/design.md) - why it is built this way
- [sdk/](sdk) - the JavaScript client
- [docs/recipes.md](docs/recipes.md) - one runnable program per use case, compiled
  against the published package
- [docs/errors.md](docs/errors.md) - every problem type and what to do with it
- [SECURITY.md](SECURITY.md) - reporting a vulnerability, and what is not promised

MIT.
