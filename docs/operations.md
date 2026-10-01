# Running one of these for somebody

What to do when you run a gateway for a client. Why it is built this way is
[design.md](design.md). What each variable means is the
[README](../README.md#configuration).

## What to run

`ghcr.io/i-am-fatik/thunder-bridge-gateway:<version>`. The release workflow pushes it,
tagged `<version>` and `latest`, when a `v*` tag lands, and refuses a tag that does not
match the version in `package.json`. The npm package `thunder-bridge` is the client that
talks to it.

The image is built for `linux/amd64` and `linux/arm64`. The `check` stage is pinned to
`$BUILDPLATFORM`, so the test suite runs once, on the builder's own architecture, and
the prune step keeps the `linux-x64` and `linux-arm64` prebuilds every native
dependency ships. Only the two cheap steps of the final stage are emulated.

Pin a version and its digest, never `latest`. The gateway holds a client's payment
records, and a restart must not upgrade it by surprise.

## Deploy a new build

Nothing deploys on a merge. Point the deployment's manifest at the new image, pinned by
tag and digest. Wire the liveness probe to `/health` and the readiness probe to `/ready`,
as [Check health](#check-health) describes, so a rollout that finishes has at least
booted.

A shutdown drains. The instance turns `/ready` down, finishes the tick in flight within
`DRAIN_TIMEOUT_SECS`, and leaves. A webhook may go out twice across a drain that timed
out. That is the at-least-once contract, and the receiver deduplicates on `id`.

### When the release changes what a delivery looks like

A release that changes the shape of a webhook body is cut over, not deployed. A delivery
owed but not yet sent is stored as a rendered body, so it goes out in the old shape
after the new build runs. A client on the new version reads it as nothing and drops it,
the gateway sees a 2xx and retires it, and nobody hears about a payment that was made.
1.0 was such a release.

1. Stop taking new work. Set `MAX_PENDING=0` and redeploy the current build, or route
   traffic away. A create and a watch both answer 429 while it holds.
2. Wait until nothing is owed. `/ready` with the bearer reports `parked_deliveries`,
   and `sync.rows.outbox` against `sync.rows.delivered` shows whether anything is still
   owed.
3. Deploy, and put `MAX_PENDING` back.

Watches already registered keep being polled and settle in the new shape. They are fine
when their receivers run the new client, and the rest go quiet. A watch lives at most
thirty days, so either wait that out or tell those clients first.

## Roll back

Check the schema stamp first. A build refuses a ledger stamped higher than it knows,
with `this ledger is at schema N and this build knows M`, and the process exits.

| Stamp | What moved it |
|---|---|
| 2 | the `pending` table was dropped |
| 3 | the `kept` table arrived |

Rolling back across a stamp means restoring the volume, not redeploying the image. The
columns `heardAt` on `paid`, and `retryUntil` and `parkedAt` on `outbox`, are local and
nullable and leave the stamp alone.

Nothing else needs undoing. Facts are append-only and a worklist is a query over them,
so an older build reads what a newer one wrote as long as the stamp allows it.

## Keep the ledger across a redeploy

The gateway has no backup job and no external database. A fact lives in every instance
that heard it. A lone instance with no volume loses the ledger on every redeploy, so
run one of these:

- a volume at `/data`, where the image's `LEDGER` points
- a second instance with the same `CLUSTER_KEY` that can reach the first

Two instances with volumes survive both a redeploy and a lost disk.

To check that two instances agree, compare `sync.marks` and `sync.rows` across them.
Read from one instance they say nothing about its peers. A mark covers only a run of an
origin's facts with no gap in it, so a fact held above a gap is not counted.

## Three instances behind one hostname

The instances are interchangeable behind a plain round-robin balancer. A settlement
absorbed from a peer is published to the sockets held locally, so a websocket needs no
stickiness. A nonce or ticket spent on one instance is announced to the others, so a
replay sent to a different pod is refused too.

On Kubernetes that is:

- a StatefulSet of three with `podManagementPolicy: Parallel`
- a required anti-affinity on `kubernetes.io/hostname`
- a PodDisruptionBudget of `maxUnavailable: 1`
- a headless Service, which gives the pods stable names

Every pod gets the same peer list, its own name included. An instance that dials
itself drops that address.

```
CLUSTER_KEY=<one fixed secret for all three>
SWARM=0
REPLICATE_LISTEN=7000
REPLICATE_PEERS=gw-0.gw-peers:7000,gw-1.gw-peers:7000,gw-2.gw-peers:7000
```

An instance with `REPLICATE_PEERS` answers `/ready` with 503 until it has caught up with
a peer, or until 30 seconds pass without reaching one. A pod that boots empty is not
sent work before it holds the ledger. With three pods the peers are the backup and an
`emptyDir` is enough. Only losing all three at once loses the ledger.

## Where the verify endpoint runs

By default every rail verifies through an endpoint the client serves:
`serve.lightningVerify`, `serve.bankVerify` or `serve.nwcVerify`. The gateway polls it
and refuses anything that is not public https. Its query is sealed, so the gateway
learns neither who is paid nor how much.

Run it with the client's own application, on the client's own host. The bank endpoint
holds the client's bank read token and the NWC endpoint holds their wallet connection.
Hosting either yourself means holding that credential for them, which is a different
business than running a gateway.

An unreachable endpoint costs time, not money. A failed poll is logged and the payment
is scheduled again, so the settlement is noticed late as long as the endpoint is back
before the payment expires. A client whose app is down past an order's expiry sees it
expire unsettled with the money received. Tell them to re-register the payment.

## Hold one key per client

`CLUSTER_KEY` is 32 bytes of hex. It is the swarm topic and the right to write a fact,
so two deployments sharing a key are one cluster and replicate into each other. Give
every client their own key. A shared key merges two clients' payments.

Losing the key locks you out of that cluster, and nobody can reissue it. Copy it out of
the deployment's secret store as soon as the instance is up.

Where the keys are kept, who can read them, and what happens when their holder leaves
is not decided yet. Decide it before the second client.

## Rotate a cluster key

Set `CLUSTER_KEY` to the new value and restart every instance. The ledger stores a
fingerprint of the key that signed it. A boot under a different key re-signs every fact
the ledger holds, in one transaction, and the old value opens nothing afterwards. The
pass covers only what the ledger still holds: open payments, settlements up to an hour
old, and the settlements a trigger keeps for replay.

While a roll is half done the two halves are apart, because the swarm topic, the peer
handshake, the socket ticket and the facts all come from the live key. A ticket minted
by one half is refused by the other for its 60 second life, so the client mints another.

Clients see two effects:

- The webhook signing key is derived from `CLUSTER_KEY`, so it changes too. Tell
  clients that a signature that stops verifying means read `/webhook-key` again.
- A payment its caller signed for is named after that caller and replicates across a
  rotation untouched. A payment nobody signed for is named under the cluster key. After
  a rotation it stays readable where it is held, and a peer refuses it because its id
  no longer names its invoice. A browser holds no secret, so a browser-only client's
  payments are the unsigned ones.

## Check health

`/health` is liveness. It answers 503 when the watch loop has gone unscheduled for
longer than `TICK_STALL_SECS`, or when one tick has been in flight for 60 seconds past
that. A restart fixes both.

`/ready` is readiness. It answers 503 while the instance drains, and while an instance
with `REPLICATE_PEERS` catches up. A load balancer wants `/ready` and a restart policy
wants `/health`.

With the bearer, `/ready` also returns the vitals `openapi.yaml` describes, among them
`parked_deliveries` and `sync`. An instance without `GATEWAY_TOKEN` has no bearer, so it
returns none of them.

## Turn the logs down

At the default `info`, a line names every payment paid and every webhook delivered.
That is a client's order flow sitting in your log aggregator. Set `LOG_LEVEL=warn` to
keep the failures and drop the flow.

## Tune the polling pace

Three variables govern polling, and each answers a different problem.

| Variable | What it governs |
|---|---|
| `POLLS_PER_SEC` | the ceiling per host, so one wallet a thousand payments point at is never hit harder than that |
| `WORK_PER_TICK` | how many polls and deliveries a tick takes on. Raise it when an instance watching thousands sweeps them too slowly |
| `POLL_INTERVAL_SECS` | the pace for an endpoint that names none of its own |

An endpoint overrides both pace and ceiling for its own host, on any verify answer:

- `Cache-Control: max-age=N` sets the pace, clamped to between a second and an hour.
- `RateLimit-Limit: 12;w=60` sets the ceiling, in the header the IETF RateLimit draft
  defines.

Both apply to every payment on that host, never per payment. Name both when you expect
volume, because a pace is not a rate: a thousand open orders at `max-age=5` is two
hundred requests a second. In a cluster each instance takes the ceiling divided by the
instances it can see, so the cluster together keeps the rate one instance would.

## Limit who the gateway polls

By default the gateway polls only endpoints that agreed to be polled. `MINTING` is off,
so every payment arrives through `POST /watched-payments`. With `VERIFY_CHALLENGE` on, a
`verify_url` a caller names has to echo a challenge nonce before it is polled, and no
wallet does that. The challenge exists because the gateway polls a URL for up to thirty
days on a caller's word, and a big wallet rate limiting this instance's address would
hit every client here.

Three settings change that:

- `MINTING=1` lets the gateway mint, and then it polls the recipient's wallet at the
  verify URL the wallet's own callback named. That is the one path to a third party,
  and `POLLS_PER_SEC` is politeness toward it. A browser-only integration needs it,
  because it cannot serve a verify endpoint.
- `VERIFY_CHALLENGE=0` takes callers at their word, so any LUD-21 host can be named.
  Set it only where every caller is known.
- `VERIFY_HOSTS` lists the hostnames this instance may poll, and it polls nothing else.
  A watch naming another host answers 403, and minting is refused outright, because a
  minted invoice is always verified on a wallet's host. A client can read the list in
  the config instead of taking your word for it.

## Parked deliveries

`parked_deliveries` on `/ready` counts the webhooks this instance gave up on. Each one is
a payment that settled while its receiver heard nothing, and it wants a person.

Alert on the error line `webhook for <id> abandoned`, logged once per delivery. Every
earlier failed attempt logs only at warn. Do not alert on the count alone, because a
parked delivery drops out of it an hour after it parks.

A rejected delivery is retried `WEBHOOK_BACKOFF_SECS` further off each time, for as long
as the payment had left to run and never for less than an hour. What parks is a
receiver that was down longer than that.

There is no redelivery command. The client reconciles against
`GET /incoming-payments/{id}` or the trigger socket.

## Who can read a payment

`GET /incoming-payments/{id}` on a payment a caller signed for answers 404 to every other
caller. A payment nobody signed for is readable by whoever holds its id.

A socket on `/ws/incoming-payments/{id}` follows a payment by id with no signature,
because a browser holds no secret and watching your own payment from a page is what the
socket is for. A signed payment's id is the hash of the caller's public key and the
payment hash. Neither is secret, so anybody who knows both can follow it.

To close the plain socket, set `CLIENT_KEYS` or `GATEWAY_TOKEN`. Then a socket opens on a
ticket from `POST /ws-tickets`, which only the payment's owner can mint.

## Webhook signatures

A delivery is signed `ed25519=<signature>` with a key derived from `CLUSTER_KEY`.
Clients fetch the public half from `/webhook-key`, which answers without a bearer. Every
instance in one cluster publishes the same key, so a delivery from any of them verifies.
The full check is in [Webhooks in full](proving-a-payment.md#webhooks-in-full).

There is no shared secret to register. A webhook that names a `secret` is refused, so a
client migrating from an older version hears about it. You hold nothing of theirs.

The webhook endpoint answers a challenge before the payment is taken on. A client who
registers a webhook against a server that is not up yet gets a 424 and no payment, so
tell them to deploy the handler first and register second.

## The instance is under abuse

`MAX_PENDING` counts per signing key. A caller over it gets 429 with the ceiling in the
`RateLimit-Limit` header, and everybody else is unaffected. Every caller that signs
nothing shares one share. That is fairness, not a defence, because a new keypair is free.

These stop a stranger:

- `CLIENT_KEYS` names the client keys this instance serves and refuses everybody else
  with 403. With a list set, a socket opens only on a ticket, and only a listed key can
  get one.
- `GATEWAY_TOKEN` puts every route except `/health`, `/ready`, `/openapi.yaml`, `/docs`
  and `/webhook-key` behind the bearer.
- `MAX_SOCKETS` caps the sockets the instance holds at once, and refuses one past it
  with 503.

The gateway has no request rate limiter. An instance open to strangers needs one in
front of it.
