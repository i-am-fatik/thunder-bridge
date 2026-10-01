# Why it is built this way

The decisions behind the gateway and the client, the arithmetic that settled them,
and the options that were rejected. The API is [`openapi.yaml`](../openapi.yaml),
and running and configuring the gateway is the [README](../README.md).

## One process, no database server

The HTTP and WebSocket surfaces, the store and the gossip run in one Node process,
so a payment read is a synchronous SQLite call rather than a round trip. The store
is one SQLite file through `node:sqlite`, so there is no database server to run,
back up or authorise. Node runs the TypeScript as written, so there is no bundler
and no build step.

## The store: facts and local state

Every row is either a fact, which replicates, or local state, which never leaves
the instance.

A fact is immutable. It carries the origin that wrote it, that origin's own
sequence number, and an HMAC under the cluster key. Facts are a grow-only set, so
merging two instances is `INSERT OR IGNORE`, in any order and any number of times.

| Table | Kind | Holds |
|---|---|---|
| `accepted` | fact | a payment taken on: the invoice, the verify URL, the trigger and the webhooks |
| `paid` | fact | a settlement |
| `outbox` | fact | a webhook owed |
| `delivered` | fact | the tombstone saying a webhook landed |
| `schedule` | local | when each watched payment is next due |
| `progress` | local | how far this instance holds each origin's facts |
| `requests` | local | `Idempotency-Key` claims |
| `kept` | local | sealed blobs that outlive their payment |
| `meta` | local | this instance's origin, and the fingerprint of the key that signed the ledger |

Taking a payment on is a fact for the same reason settling it is: it happened at
one instance, and nothing later can undo it. Watching is not a fact. A poll is an
idempotent read of somebody else's server, so losing the schedule costs one extra
read and nothing else.

The worklist is not a table anybody replicates. It is a query over the facts:
accepted, minus settled, minus expired. So nothing has to be reconciled and no
merge policy can be got wrong. Two instances that accept the same payment write two
facts, and the reader unions their webhooks.

An hour after a payment settles or expires, the sweep deletes everything the
gateway could read about it. The gateway is a watcher, not a book: the socket and
the webhook have had their hour. Two things outlive it, and the client asks for
both. A payment created with `replay` keeps that many of its trigger's newest
settlements, up to the operator's `MAX_REPLAY`, so a page that opens the trigger's
socket a day later still sees them. A kept settlement is the same signed fact as
any other, so peers prune it by the same rule and agree. A payment carrying
`sealed` leaves behind its blob, its caller's key, how it ended and when, for
`KEEP_SEALED_DAYS`, so a client can read its own history back from any gateway that
watched it.

A blob nobody can open still answers questions by existing. How many payments a key
made, when, and roughly how large each record was are readable without decrypting
anything. The window keeps that bounded, and permanent storage would not.

## The file says which build wrote it

The ledger carries `PRAGMA user_version`, and a build refuses at boot a file stamped
higher than it knows. A newer release wrote that file and was rolled back. A process
that will not start is a page, and a process that reads a schema it does not
understand is a wrong answer about money.

A file stamped lower, or not at all, is brought forward in place. Every statement
creating the shape is `IF NOT EXISTS`, and the shape is applied on every boot, not
only when the stamp moves. That is the self-heal: a dropped index is rebuilt on the
next start. Nothing else would announce it, because a query against a missing index
prepares fine and scans the table.

Every step on the fact tables is expand-only, new tables and nullable or defaulted
columns, because a rollback hands the same volume back to an older build. A ledger
from before 0.3.0 still holding the `pending` worklist hands every payment only it
knew about to `accepted` on boot, then drops the table.

## A paid fact proves itself

An instance records a settlement only when it proves itself, whether this instance
made it or a peer relayed it. Beyond the HMAC, two things must hold. The payment id
must name the payment hash, and the preimage must hash to that payment hash, which
is the LUD-21 proof. So a fact on one instance would be accepted by every other,
and a fact arriving through a third instance still has to prove itself.

A payment a caller signed for is named
`sha256("<caller key>.payment-id.<payment hash>")`, which any instance can check
holding nothing of the caller's. A payment nobody signed for is named by an HMAC of
the payment hash under the cluster key.
Naming by the caller keeps the name stable across a rotation of the cluster key and
the same at every gateway watching it. One caller registering the same watch twice
gets the same payment back from any instance. Two signing callers watching one
invoice get two records, so a payer who knows the hash cannot add a webhook to
somebody else's watch.

## The poll schedule

A watcher polls the payment's LUD-21 `verify` URL at the pace that endpoint names
with `Cache-Control: max-age`, and where it names none, by one rule rather than a
table of bands. The rule polls every `POLL_INTERVAL_SECS` for the first five
minutes, then waits a tenth of how long the payment has already waited.

The gap follows the wait because how long someone has already waited is the only
evidence of how long they will keep waiting. Five minutes is the window a payer is
in front of the invoice. After that, a payment an hour old is rechecked within six
minutes, one a day old within 2.4 hours, one three days old within 7.2 hours.

The watch stops at thirty days, `WATCH_HORIZON_SECS`, the same promise for every
payment: 155 polls at the default interval, 60 of them in the first five minutes.
`POST /watched-payments` refuses an `expires_at` further off than that rather than
accept a watch it will not honour, which also stops one POST parking a row nothing
will ever poll or prune.

Outbound polls are paced per host, so the rate at which any one server is touched
stays flat however many payments are pending, and a crowded provider cannot slow
the polls aimed at a quiet one.

The rule costs one thing. After a day the gap is about 2.4 hours, so a payer who
settles on day two can wait that long to be noticed. That suits an unattended
paywall and not a shop. The fix is not a gateway change: a verify endpoint of the
client's own names a shorter `max-age`, or a "check now" button reads the
recipient's own server directly.

## Many instances, no leader

Every instance writes, and a payment created anywhere is known everywhere. There is
no leader, no quorum and no lock, so one surviving instance keeps taking payments
alone. That is why this is gossip and not Raft: a minority can never shrink its own
quorum, because it cannot tell a dead peer from a cut cable.

Instances find each other on a Hyperswarm topic derived from the cluster key, or
dial the `REPLICATE_PEERS` list directly, and open a `thunder-cluster` channel.
Before anything is exchanged, the handshake proves the peer holds the cluster key.
The proof is keyed over the Noise handshake hash of the link it travels on, so a
proof overheard on one link opens no other. A peer that fails it has its link torn
down. The cluster key is the topic, the handshake and the write gate at once, so
joining is one step and there is no writer to authorise.

The channel carries five notes.

| Note | Carries |
|---|---|
| `have` | the sender's watermark per origin and table |
| `facts` | a batch of facts, whether more remain, and how far the batch covered |
| `polled` | a payment's next turn, after a poll that got an answer |
| `missed` | a payment whose poll got no answer |
| `spent` | a request nonce or socket ticket used once, and until when, so a replay at another instance is refused |

Catching up runs one way. One side sends `have`, and the other replies with every
fact above those marks, in batches of 500 per origin, until a reply says nothing
more remains. A watermark covers only a run with no hole in it. A fact pushed live
ahead of a hole is kept without moving the mark, so the hole is asked for again. A
reply says how far it covered, so a fact every peer has already pruned is not
waited for. Because facts are immutable and self-verifying, a peer away for a week
converges the same way as one that missed a second. A resync runs every thirty
seconds regardless, so nothing depends on one message arriving.

An accepted fact proves itself the way a paid fact does. The HMAC has to check out,
the id has to name the payment hash, the fact and its payment have to agree on the
expiry, and an invoice that decodes has to decode to that same payment hash. A
watched payment carries no invoice, so there it rests on the key and the id alone.

A reply with nothing more to send is the only honest moment to say "I am in sync",
because the peer held nothing above any of our marks. An instance started with
`REPLICATE_PEERS` answers `/ready` 503 until that first reply, or until 30 seconds
pass without reaching a peer, so a pod that boots empty is not sent work before it
holds the ledger.

## Webhooks from an outbox

A webhook is owed from a durable outbox, not fired inline. Settling a payment writes
the paid fact and one outbox row per webhook in one SQLite transaction, so there is
no window where a payment is settled and its webhook not yet owed. Retries live on
the row, so a restart mid-delivery leaves the debt intact.

The settler can owe only the webhooks it knew about. Two instances that accepted
the same payment with different webhooks, or an accepted fact that arrives after
the settlement, would leave a hook owed by nobody. So the sweep asks once a minute
whether a settled payment carries a webhook that no outbox row and no tombstone
mentions, and owes it. This runs in the sweep rather than while absorbing facts,
because a catch-up can split a paid fact and its outbox rows across two batches.
The minute of slack is the difference between noticing a missing hook and inventing
one.

The outbox replicates too, which covers the settling instance dying before it
delivers. Every instance holding the row schedules it locally. The origin tries at
once, and every other instance waits `TAKEOVER_AFTER_SECS` plus a stagger derived
from a hash of the row and its own identity, so takeovers do not fire together. The
`delivered` tombstone calls them off. Guessing the order wrong costs a duplicate
delivery, never a lost webhook, which is the right way round for something the
receiver deduplicates on `id` anyway.

An expired invoice fires nothing. Anyone can register a webhook against any payment
hash, so a hook that fired without a payment would make this service an outbound
cannon aimed wherever they chose.

## One poll per turn, whoever holds the payment

An order decides who polls a payment, not an owner. Nobody hands out leases and
nobody splits the pending set: every instance holds every pending payment it hears
about, and any of them could poll it. Each instance ranks itself and the peers it
can see by a hash of the payment and their identity. It waits one poll interval, at
most the 30 second lease, for each instance ranked ahead of it. The first in line
polls on time.

A poll that gets an answer is sent to the peers as the payment's next turn, and they
adopt it as if they had polled themselves. So the second in line never reaches its
turn while the first keeps answering, and the schedules agree again on every
answer. A pace the host asked for travels inside the turn.

A poll that gets no answer is sent as a miss, and the peers pass the turn on at
once. They rank themselves again without the one that missed, and the next in line
polls now. A dead or frozen instance sends nothing, and then the order alone does
the work: no turn arrives, and the next in line polls one interval later. Nobody
has to agree on who is alive. A wallet refusing one node, a broken route from one
node and a stalled node each cost at most one interval, and none of them costs a
poll.

A payment answered by an agent is the one case where only some instances can ask.
The agent's socket lands on whichever instance the balancer picked, so that
instance puts itself first for the agent's payments whatever the hash says. An
instance with no socket for that agent never counts a turn as a poll. It stands
aside and adopts the holder's next turn.

Splitting by a hash looks as if it needs membership everyone agrees on, and a split
with a wrong view is how a payment ends up polled by nobody. This order needs no
agreement, because nobody gives anything up. A wrong view costs a second poll when
two instances both think they are first, or one interval of delay when an instance
still counts a peer that is gone. The true first in line always counts itself, so a
live one always polls.

The same hash, rendezvous hashing, spreads first places evenly. Three instances
each lead about a third of the payments, and when one leaves only its third moves.
A host's pace is divided the same way: each instance takes its share of
`POLLS_PER_SEC` and of any ceiling the host named, so a cluster touches a wallet no
harder than one gateway would.

A copy that arrives inside the payment's first interval joins that first turn. A
copy that arrives later, from a peer catching up after a restart, waits one
interval from now. `duePolls` takes the most overdue first, so a catch-up of a
thousand old payments does not bury the one made a second ago.

Every instance that reads the preimage before it hears of another's settlement
writes its own paid fact, and they all say the same thing, because a paid fact is
the payment hash and the preimage that opens it. The writer owes its webhooks at
once, and `won` tells the caller whether that was this instance.

## Quotes mint nothing

`POST /quotes` runs only the reachability half of minting. It fetches each
address's LNURL-pay endpoint in order and reports the first that takes the amount,
with its range and whoever was passed over. The callback is never called, so
nothing is minted. Like minting, it answers only on an instance with `MINTING=1`.

A quote is a probe and not a promise. Whether a wallet returns a provable invoice
cannot be known without asking for one, and asking mints it.

`fee` is always zero, because the payer pays the recipient directly and the gateway
is never in the money's path.

## Idempotency claims the key first

On `POST /incoming-payments` an `Idempotency-Key` is claimed before any wallet is
contacted, because the retry that matters is the one a client fires when its own
timeout expires while the first request is still resolving. Claiming late would ask
a wallet for a second invoice.

A repeat of a finished request replays its payment, a repeat arriving mid-flight
answers 409, and a request that mints nothing hands the key back. The key is bound
to the request that claimed it, so reusing it for a different request answers 409
rather than the earlier payment. Keys are held 24 hours, and a repeat after its
payment was pruned answers 410. Keys are not gossiped, so two concurrent requests
at two instances are still two invoices.

A key belongs to the caller who signed the request, so the same key from two
callers is two keys. An order reference used as one hands nobody else's payment
back and lets nobody squat it. Keys from unsigned callers share one space, as their
payments do. The key is claimed before the quota is counted, so a retry of a
request that took the caller's last slot gets its payment rather than 429. The
quota is counted again just before the payment is stored, because two requests can
pass the first count while their wallets are still answering.

## The BOLT11 decoder is hand-rolled

The gateway decodes BOLT11 with its own Bech32 code and no library, because the
amount and the payment hash it reads out are what every later check compares
against. It is pinned to the spec vector plus two real invoices whose payment
hashes a Rust `lightning-invoice` build produced, so both implementations agree
byte for byte.

## A token is the mode, not a role

`GATEWAY_TOKEN` does not model permissions. It answers one question, whether this
instance is yours: a gateway without one serves anyone, and a gateway with one
answers only its holder.

That is why `GET /incoming-payments` is gated on the mode rather than on a scope. A
list on a shared gateway would hand every caller everyone else's payments. On a
private gateway you are the only caller, so the correlation a list implies costs
nothing. A public instance answers 404 rather than 401, so it does not disclose
that the endpoint exists elsewhere.

## Pinning the recipient at payRequest

`serve.lnurlPay` answers both halves of the LNURL flow on one path, and it picks
the winning address at payRequest rather than at callback time. LUD-06 makes the
payer's wallet check the invoice's description hash against the sha256 of the
metadata it was served, and only the recipient's own wallet mints the invoice, so
that metadata has to be the recipient's. If the callback walked the list again and
a different address won, the hashes would differ and the payer's wallet would
refuse the payment.

The cost: once pinned, a recipient that goes down between the payRequest and the
callback fails that payment, with no fallback behind it. The priority list buys
availability at payRequest, not for the length of one payer's hesitation.

## Which board this is, at the call site

The SDK serves the socket ticket exchange as two handlers, `serve.watchTicket` and
`serve.publicWatchTicket`, rather than one taking a `public` flag. A public ticket
endpoint makes a trigger's whole stream readable by strangers, preimages included,
and a paywall gates content on those preimages. So the two differ as a tip jar
differs from a giveaway. A flag would state that difference as a bare `true`, and
two names state it.

Three other shapes were rejected. A route inside `serve.lnurlPay` would make one
handler answer three differently authorised questions, and would deny a board to
anyone who does not want an LNURL endpoint. A server-side rebroadcast that strips
the payload is the right answer once a paywall and a public board share a trigger,
and the wrong one before, because it puts a socket and a fan-out in the SDK for a
problem nobody has yet. Leaving the exchange to each operator's app asks every
operator to write a constant-time comparison and to keep a gateway token off a
public wire.

The deployment switch moves to the operator's own app, as a ternary choosing one of
the two, so the SDK carries no mode of its own.

## Two rails, one order

A shop that offers one order for Lightning and for a Czech QR platba at once takes
whichever lands first, through a shared trigger rather than a new resource. Both
legs carry one trigger secret, `follow` streams every payment carrying it, and the
first to reach `paid` wins. There is no linkage table, no polling loop of your own
and no socket per customer.

Which order settled travels in `sealed`, an opaque blob the gateway stores and
hands back without being able to read it. So the socket tells the shop the
reference and the price while the gateway learns neither.

**Mint the Lightning leg late.** The bank leg is nearly free: the QR is derived
from a secret and a reference with no network at all, and registering the watch is
one POST. The Lightning leg costs a round trip to the recipient's wallet and
produces an invoice payable until the wallet's own expiry. So show the QR at once
and mint the invoice when the payer picks Lightning. With `gatewayMints`, pass the
reference as the idempotency key. The window in which both rails are payable
shrinks from days to the minutes a payer spends deciding.

**No cancel endpoint, and no order object.** Cancelling a watch would save the
polls of the leg that lost, and would cost another fact type in the ledger, since a
cancellation has to replicate or one instance keeps polling what another abandoned.
It would also stop the reads that catch a double payment, below. Revisit it only if
open offers ever run into `MAX_PENDING`. An order object was rejected on paper: two
prices, two addresses, an IBAN, a verify URL, an expiry and a trigger make a twelve
field parameter bag that mostly forwards to two functions the caller can already
call. What was missing was one sentence of behaviour, which leg won, and that is
`firstSettled`.

**Double payment is detected, not prevented.** Nothing can revoke an invoice,
because the recipient's own wallet minted it and only that wallet could refuse it.
LUD-21 reports settlement, it does not revoke. So a payer who scans the QR on Monday
and pays the invoice on Tuesday has paid twice. The second `paid` arrives on the
trigger socket the shop already listens to, with the amount and the reference in
`sealed`. That is a refund signal, not a bug, and it needs no reconciliation job.

**Reading the bank does not stop when an order is won.** A bank transfer landing
two days later is the double payment the shop has to refund, so the bank leg stays
watched after the Lightning leg wins. The reads are cheap enough not to matter.

## One version for the gateway and the client

The gateway and the client release under one version number. CI reads four lines,
the `version` in both `package.json` files and in both `openapi.yaml` files, and
fails when they differ. A gateway at 1.0.0 beside a client at 1.1.0 made every reader
ask which number the release was. So a release moves both sides or neither, which
costs a gateway build for a change only the client made, and buys a number that
means the same thing wherever it is read.

## The container

The image is Debian slim rather than Alpine, because Hyperswarm's native modules
ship no musl prebuilds. Prebuilds for every platform except linux are pruned before
the final stage.

The Dockerfile carries no `VOLUME` instruction, because some builders reject it and
a mount point belongs to whatever runs the container. The server binds `PORT` when
a platform injects one, so route to that port rather than to the `EXPOSE`d 3000.

State survives through the other instances, not through the disk. A redeploy starts
on an empty file, an instance whose marks are all zero, and catches every fact back
up from its peers. That makes a second instance somewhere else the durability
mechanism. Until one exists, mount a
volume at `/data` or accept that a lone redeploy forgets.

## Talking to a stranger

Every outbound request goes through one function, `ask` in `core/outbound.ts`,
because every URL this service fetches was named by somebody else. A caller names
the verify URL and the webhook, and on the minting path the lightning address, so
each one is untrusted input that happens to be spelled like a URL.

`ask` refuses anything that is not public https. It resolves the name and refuses
when any address in the answer is one we would not reach. It follows at most two
redirects and re-runs both checks on every hop, and it reads at most 256 KiB before
parsing anything.

The redirect was the exploitable part. Left to itself `fetch` follows up to twenty
hops, so a URL that passes every check on hop one can land on
`http://169.254.169.254/` on hop two and hand back the cloud metadata service.
Following the chain by hand is the only way the guard sees the destination finally
reached.

Checking the resolved address rather than the name is one layer, and the transport
is the other. The gateway connects to the address the guard verified instead of
letting the name resolve a second time, so a record that flips between the check
and the connection is caught. A name openly pointing inside is refused before a
socket opens, and the https requirement means an attacker also needs a certificate
the internal service will serve. Refusing when *any* address is private, rather
than when all of them are, costs availability in one case: a wallet whose DNS
answers with a stray private record alongside good ones is refused entirely.

Credentials do not travel across an origin, and a redirect that does not say where
to is refused rather than retried, because the next caller of this helper will not
think about either.

Consent is given by an origin, so everything sent on the strength of it stays on
that origin. A verify poll, a verify or webhook challenge and a webhook delivery
follow a redirect only to another path of the same origin, and a redirect off it
fails the request. Otherwise a host that answered the challenge could hand every
later poll to one that never did. Every request a registration makes before
anything is watched takes its turn at the host the way polls do. A registration
whose turn is more than five seconds off is answered 503 with `retry-after: 5`, so
a loop of registrations cannot outrun the pace every honest poll keeps.

## What a caller may send

A request body is read up to 64 KiB and refused past it with 413, twice: once on
`content-length`, which refuses before a byte is read, and once on the bytes
arriving, because a chunked body declares no length. The largest request this API
defines is a watch carrying a full 4096-character `sealed` blob, which is around
24 KB once escaped. So the ceiling is generous and still nothing a public instance
can be made to spend.

Every stored field replicates to every peer, so a type alone is not a bound. An
address is capped at 320 characters and a `sealed` blob at 4096, and a URL is
bounded by the body ceiling. The WebSocket surface takes the same 64 KiB ceiling,
since an upgrade never passes through the body path and `ws` would otherwise
accept 100 MB a frame.

## Leaving without dropping work

A redeploy is a signal, and the process answers it by draining. `SIGTERM` and
`SIGINT` turn readiness down first, so a balancer stops sending work while the
listener is still up. Then the timers stop, the tick in flight is waited out under
`DRAIN_TIMEOUT_SECS`, the sockets and the listener close, and the ledger closes
last. A second signal exits at once.

Liveness and readiness answer different questions and are kept apart, because the
platform does different things with them. `/health` is liveness, and turns 503
only for what a restart cures: no tick has started within `TICK_STALL_SECS` of
falling due, or one tick has run longer than `TICK_STALL_SECS` plus a minute.
Pacing never holds a tick that long, because a poll whose host is busy for more
than five seconds goes back on the schedule instead of waiting.

`/ready` is whether to send work. It turns 503 while draining and while catching up
with peers, and never on a count. `MAX_PENDING` is a quota per caller, answered 429
where a payment is created or watched, and an instance holding many payments still
settles and serves. Reporting a count as not-ready would take the whole deployment
out of rotation for a condition no restart and no drain repairs.

The vitals behind that answer go only to a caller holding the bearer. A pending
count is small, but it is still a fact about somebody's trade, and the path is open
to everyone.

## What is still trusted

The gateway ships no verifier of its own, because a proof fetched from the party
being audited is not a proof. The checks live in the client, in [sdk/](../sdk),
which runs them against the recipient's own server before the payer sees a QR code.

The recipient's server stays trusted, because it minted the invoice and, when
custodial, holds the money, and so do TLS and DNS for its domain. The proof binds
an invoice to an address, never an address to a person, so vouching for the address
stays with whoever published it.

The gateway is trusted to speak, and for nothing it says. A client running every
check cannot be made to mark a payment paid that nobody paid, to show an invoice
the recipient did not issue for this order, or to take one invoice for two orders.
Every settlement is checked against a hash the client held before the report
arrived, and every blob opens only beside its own payment. A gateway can still stay
silent or answer late, and on the minting path it reads the address and the amount.
No check catches a message that was never sent, so the answer to silence is a
second source. `prove()` on a payment request asks the recipient's own server, a
bank transfer is read off the client's own verify endpoint and statement, and
`Gateways` watches one payment at gateways run by different operators and takes
whichever speaks.
