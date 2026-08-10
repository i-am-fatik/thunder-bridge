# Running one of these for somebody

Reference for whoever is holding the pager. Why it is shaped this way is
[design.md](design.md), what the variables mean is the
[README](../README.md#configuration). This file is only what to do.

## Deploy a new build

Railway is not wired to the repository. Merging to `main` deploys nothing: run
`railway up` from the repo root, and check `railway deployment list` says SUCCESS
before believing it. `/health` answering 200 is the healthcheck Railway itself
waits on, so a deploy that goes live has at least booted.

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

## Hold one key per client

`CLUSTER_KEY` is 32 bytes of hex. It is the swarm topic and the right to write a
fact, so two deployments sharing a key are one cluster and will replicate into
each other. A client gets their own key, always, and mixing them silently merges
two clients' payments.

Losing the key locks you out of that cluster and nobody can reissue it. Copy it
out of Railway the moment the instance is up.

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

## The instance is under abuse

There is no per-caller quota and no rate limit on creation. `MAX_PENDING` is one
global ceiling, so a single caller can starve every other one. Set
`GATEWAY_TOKEN`, which turns every route except `/health`, `/ready`,
`/openapi.yaml` and `/docs` into a bearer route. Without one, every write is
anonymous. A gateway meant to be reachable by strangers wants a rate limit in
front of it, which is not in this process.
