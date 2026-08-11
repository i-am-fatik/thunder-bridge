# Running one of these for somebody

Reference for whoever is holding the pager. Why it is shaped this way is
[design.md](design.md), what the variables mean is the
[README](../README.md#configuration). This file is only what to do.

## What to run

`ghcr.io/i-am-fatik/thunder-bridge-gateway:<version>`, pushed by the release workflow
when a `v*` tag lands, and refused if that tag does not match the version in
`package.json`. The name says gateway because `thunder-bridge` on npm is the client
that talks to it, and because that container name is already taken by another
repository.

It is built for `linux/amd64` and `linux/arm64`, so Graviton and Apple Silicon run it
native. The suite still runs once, on the builder's own architecture: the `check` stage
is pinned to `$BUILDPLATFORM` and every native dependency here ships both `linux-x64`
and `linux-arm64` prebuilds, which the prune step keeps. Only the two cheap steps in the
final layer are emulated. Pin the version rather than `latest`: this gateway is one process
holding a client's payment records, and a surprise upgrade on restart is not a thing
you want to debug at two in the morning.

## Deploy a new build

Railway is not wired to the repository. Merging to `main` deploys nothing: run
`railway up` from the repo root, and check `railway deployment list` says SUCCESS
before believing it. `/health` answering 200 is the healthcheck Railway itself
waits on, so a deploy that goes live has at least booted.

Railway builds from the `Dockerfile` rather than pulling that image, so the two are
the same recipe and not the same artifact. A client running the image is pinned. This
deployment is not.

A shutdown drains: the instance stops accepting, finishes the tick in flight, and
leaves. `DRAIN_TIMEOUT_SECS` bounds the wait. A webhook may go out twice across a
drain that timed out, which is the documented at-least-once contract, and the
receiver deduplicates on `id`.

## Roll back

Check the schema stamp first. `src/ledger.ts` refuses to open a ledger a newer
build wrote, with `this ledger is at schema N and this build knows M`, and the
process exits rather than starting on a file it does not understand. Every build
to date stamps 1, so rolling back between them is safe. The release that drops the
`pending` table stamps 2, and after that runs once against a volume, no earlier
build will boot on it again. Rolling back past that point means restoring the
volume, not redeploying the image.

Nothing else needs undoing. Facts are append-only and a worklist is a query over
them, so an older build reads what a newer one wrote as long as the stamp allows
it.

## Durability is the peers, so a lone instance needs a volume

There is no backup job and no external database. A fact lives in every instance
that heard it, and that is the whole durability story. One instance with no volume
therefore loses the ledger on every redeploy. Run either a volume at `/data` with
`LEDGER` pointing into it, or a second instance that has the same `CLUSTER_KEY`
and can reach the first. Two instances with volumes is the arrangement that
survives both a redeploy and a disk.

`sync.marks` plus `sync.rows` compared across two instances is strong evidence
they agree. Read from one instance it proves nothing: a mark is a maximum and says
nothing about holes below it.

## Where the bank rail's verify endpoint runs

The bank rail needs a public https endpoint serving `bankVerifyEndpoint`, because the
gateway polls it and refuses anything private. That endpoint, not the gateway, is what
holds the client's bank read token, so where it runs is a question about who holds that
token rather than about hosting.

Run it with the client's own application, on the client's own host. It is one route in
whatever already serves them, it keeps the bank token on their side, and the gateway
stays a thing that polls a URL and knows an amount only from a query string. Standing it
up in our own infrastructure would mean holding a client's bank credential for them,
which is a different business than running a gateway.

An unreachable endpoint costs nothing but time. A poll that fails is logged and the
payment is scheduled again, so an endpoint down for an afternoon means the settlement is
noticed late rather than lost, as long as it is back inside the three day watch horizon.
The money is in the account either way, which is the whole point of reading a bank
statement rather than trusting a callback.

What that does mean is that a client who takes their app down for a week and had an
unpaid order open will see it expire unsettled with the money received. Say so in the
integration, and re-register rather than arguing with it.

## Hold one key per client

`CLUSTER_KEY` is 32 bytes of hex. It is the swarm topic and the right to write a
fact, so two deployments sharing a key are one cluster and will replicate into
each other. A client gets their own key, always, and mixing them silently merges
two clients' payments.

Losing the key locks you out of that cluster and nobody can reissue it. Copy it
out of Railway the moment the instance is up.

## Rotate a cluster key

Set `CLUSTER_KEYS_RETIRED` to the old key on every instance first, then move
`CLUSTER_KEY` to the new one, instance by instance. A retired key still verifies a
peer's facts and a peer's handshake, so a rolled instance keeps absorbing what an
unrolled one signs, and the ledger it already holds stays readable throughout: the
fact MAC is only ever checked on arrival from a peer, never on a local read.

Two costs, both bounded. The swarm topic comes from `CLUSTER_KEY` alone, so while
the roll is half done the two halves cannot find each other over the DHT and
converge only once everyone carries the new key. And a socket ticket is signed with
`CLUSTER_KEY` alone too, so a ticket minted by one half and presented to the other
is refused for its 60 second life, which costs the client a re-mint.

Payments keep the id they were minted under, because an id is a keyed hash of the
payment hash. After a rotation the same invoice registered again gets a different
id, and both remain readable. Drop the retired key once every instance carries the
new one and nothing is left to verify from before.

Where those keys are kept, who can read them, and what happens when the person
holding them leaves is not decided yet, and this file will not pretend otherwise.
Decide it before the second client.

## Is it actually healthy

`/health` is liveness: it answers 503 when the watch loop has gone unscheduled for
longer than `TICK_STALL_SECS`. `/ready` is readiness. They answer different
questions on purpose, so a load balancer wants `/ready` and a restart policy wants
`/health`.

A tick that hangs forever would not show on either, because what is measured is
the loop being scheduled rather than how long a tick takes. The one unbounded wait
it used to have, a name lookup, is bounded now.

## Turn the logs down

`LOG_LEVEL` defaults to `info`, and at `info` a line names every payment paid and
every webhook delivered. That is a client's order flow sitting in your log
aggregator. `warn` keeps the failures and drops the flow.

## A settlement nobody was told about

`parked_deliveries` on `/ready` counts webhooks this instance gave up on, and every one
of them is a payment that settled while its receiver heard nothing. Above zero it wants
a person. The gateway also says so once per delivery at error level, `webhook for <id>
abandoned`, which is the line worth alerting on because every earlier attempt is only a
warning.

Giving up takes a while on purpose. A rejected delivery is retried `WEBHOOK_BACKOFF_SECS`
further off each time, for as long as the payment itself had left to run and never for
less than an hour, so a receiver down for an afternoon still gets told. What parks is a
receiver that was down longer than the payment lasted.

There is no redelivery command. The payment is readable by id and on the trigger socket,
so the answer is for the client to reconcile against `GET /incoming-payments/{id}`, which
is what a client should be able to do anyway.

## A client who would rather not hand you a webhook secret

They register the webhook with no `secret`, and the gateway signs the delivery
`ed25519=<signature>` with a key derived from `CLUSTER_KEY` instead. They fetch the
public half from `/webhook-key`, which answers without a bearer, and verify against
it. Every instance in one cluster publishes the same key, so a delivery from any of
them checks out.

Prefer it, and say so when someone asks. A secret they give you is kept in the
ledger and replicated to every peer, because any instance may be the one that
delivers, so it is one more thing of theirs you are holding. Rotating `CLUSTER_KEY`
changes this key too, so a receiver caching it has to fetch it again.

Either way their endpoint answers the challenge before the payment is taken on, so a
client who registers a webhook against a server that is not up yet gets a 424 and no
payment. Tell them to deploy the handler first and register second.

## The instance is under abuse

There is no per-caller quota and no rate limit on creation. `MAX_PENDING` is one
global ceiling, so a single caller can starve every other one. Set
`GATEWAY_TOKEN`, which turns every route except `/health`, `/ready`,
`/openapi.yaml` and `/docs` into a bearer route. Without one, every write is
anonymous. A gateway meant to be reachable by strangers wants a rate limit in
front of it, which is not in this process.
