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

### When the release changes what a delivery looks like

That drain is not enough for a release that changes the shape of a webhook body, and
1.0 was one. A settlement owed but not yet delivered is stored as a rendered body, so
it goes out in the old shape after the new build is running, and a client on the new
version reads it as nothing at all and drops it. The gateway sees a 2xx and retires
it. Nobody is told about a payment that was made.

So a release that touches the delivery body is cut over rather than deployed:

1. Stop taking new work. Set `MAX_PENDING=0` and redeploy the current build, or point
   traffic away. A create and a watch both answer 429 while it holds.
2. Wait for the outbox to empty. `/ready` with the bearer reports `parked_deliveries`,
   and `sync.rows.outbox` against `sync.rows.delivered` says whether anything is still
   owed. Nothing owed means nothing can be dropped.
3. Then deploy, and put `MAX_PENDING` back.

Watches already registered are a slower version of the same question. They keep being
polled and they settle into the new shape, so they are fine as long as their receivers
moved to the new client. Ones whose receivers did not are the payments that go quiet.
Three days is the longest any watch lives, so a cutover with no overlap means waiting
that out, and a cutover without waiting means telling those clients first.

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

A rotation is a rotation. Set `CLUSTER_KEY` to the new value and restart: the ledger
remembers which key signed it, by a fingerprint that proves the key without holding
it, and a boot under a new one re-signs every fact it still holds in one transaction.
The old value opens nothing afterwards, which is the point. There is no list of
retired keys any more, because a key that still admits a peer and still writes facts
was never retired.

The pass is bounded by what a ledger keeps rather than by history: an hour past
settlement, plus the window `KEEP_SEALED_DAYS` sets for sealed blobs.

Roll every instance. While a roll is half done the two halves are apart, because the
swarm topic, the socket ticket and now the facts themselves all come from the live key
alone. A ticket minted by one half and presented to the other is refused for its 60
second life, which costs the client a re-mint.

One thing does not survive a rotation, and it is worth knowing which. A payment its
caller signed for is named after that caller, so it replicates across a rotation
untouched. A payment nobody signed for is named by this instance's key, so after a
rotation it stays readable here and a peer will refuse it, because it no longer names
its own invoice. Minted payments are the ones that arrive unsigned, which is one more
reason the minting endpoint is off unless an instance turns it on.

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

## How often anything gets polled

Three separate things, and they used to be one number. `POLLS_PER_SEC` is politeness:
a ceiling per host, so one wallet a thousand payments point at is never hit harder
than that. `WORK_PER_TICK` is throughput: how many polls and deliveries a tick takes
on at all, and it is the knob to raise when an instance is watching thousands and
sweeping them too slowly. `POLL_INTERVAL_SECS` is only the fallback pace for an
endpoint that does not name its own.

An endpoint names its own with `Cache-Control: max-age` on any verify answer, clamped
to between a second and an hour, and that pace then applies to every payment on that
host. So a client's own endpoint sets the rate it wants to be asked at, and a wallet
that says nothing keeps the widening interval. Nothing here is per payment: the pace,
like the ceiling, belongs to the host being asked.

The ceiling can be named the same way, with `RateLimit-Limit: 12;w=60` on any verify
answer, which is the header the IETF draft defines for exactly this. Cadence and
aggregate rate are different quantities and `max-age` can only express the first: a
thousand open orders at `max-age=5` is two hundred requests a second however polite the
interval looks. So an endpoint that expects volume should name both, and then
`POLLS_PER_SEC` governs nothing it asks about. On an instance pinned with
`VERIFY_HOSTS` where every endpoint speaks for itself, that variable governs nothing at
all and is only there for the hosts that stay silent.

## A gateway that talks to nobody but its clients

Worth knowing when someone asks whether this thing calls out to strangers. By default
it does, on one path only: a payment it minted is polled at the recipient's own wallet,
because that is where the LUD-21 endpoint lives. `POLLS_PER_SEC` exists for exactly
that, and it is politeness to a third party rather than protection of this process.

A client who does not want that has the other arrangement. They register through
`POST /watched-payments` only, resolving the address in their own service, and serve the
verify endpoint themselves: the SDK's `lightningVerifyEndpoint` asks the wallet on our
behalf and `bankVerifyEndpoint` already did the same for a bank. Then every host this
gateway polls belongs to that client, every one of them names its own pace, and the
per-host ceiling never binds.

On the watched path that arrangement is now the only one, and `VERIFY_CHALLENGE` is why.
A `verify_url` a caller named is challenged before anything is polled and has to echo the
nonce, which no wallet will do. The reason is not politeness. This gateway polls a URL
for three days on a caller's word, and one caller pointing it at a big wallet gets that
wallet's rate limit applied to this instance's address, which every other client here
shares. Moving the last hop to the caller's own endpoint moves that cost onto the caller.
An instance whose callers are all known can set `VERIFY_CHALLENGE=0` and go back to
taking their word for it.

Minting is untouched by that, because there the caller named no URL: the gateway found it
in the wallet's own callback. So a browser-only integration, which cannot serve anything
for days, still works exactly as before.

`VERIFY_HOSTS` turns the second arrangement from something the client chooses into
something the instance enforces. List the client's own hostnames and this gateway polls
nothing else: a watch naming another host answers 403, and minting is refused outright,
because an invoice this gateway mints is always verified on a wallet's host and failing
after the mint would burn a real invoice. Then "this instance talks to these endpoints
and no others" is a line in the config a client can read for themselves, rather than a
promise they have to take on trust.

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

## A client asking how a delivery is signed

`ed25519=<signature>` with a key derived from `CLUSTER_KEY`, and there is no other
answer any more. They fetch the public half from `/webhook-key`, which answers without
a bearer, and verify against it. Every instance in one cluster publishes the same key,
so a delivery from any of them checks out.

There is no shared secret to register, and sending one is refused rather than ignored,
so a client migrating from an older version hears about it instead of wondering why
nothing verifies. You hold nothing of theirs.

Rotating `CLUSTER_KEY` changes this key too, which makes a rotation something the
clients see. Tell them a signature that stops verifying is a reason to read
`/webhook-key` again before it is a reason to distrust you.

Their endpoint answers the challenge before the payment is taken on, so a client who
registers a webhook against a server that is not up yet gets a 424 and no payment.
Tell them to deploy the handler first and register second.

## The instance is under abuse

`MAX_PENDING` counts per signing key, so one caller filling its share leaves everybody
else's alone and a caller over it gets 429 with the ceiling in the headers. Every
caller that signs nothing shares one share between them, which is all you can fairly
do for somebody who will not say who they are.

That is fairness, not a defence. A keypair costs nothing to make, so the same stranger
comes back under a new one. Two things actually stop them, and both are lists rather
than counters. `CLIENT_KEYS` names the client keys this instance serves and refuses
everybody else with 403, which on an instance whose clients you know is the whole
answer. `GATEWAY_TOKEN` turns every route except `/health`, `/ready`, `/openapi.yaml`,
`/docs` and `/webhook-key` into a bearer route.

An instance genuinely open to strangers wants a limiter in front of it, which is not in
this process and will not be.
