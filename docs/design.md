# Why it is built this way

The decisions behind the gateway, the arithmetic that settled them, and the
options that were rejected. Nothing here is needed to call the API. The API is in
[`openapi.yaml`](../openapi.yaml), and how to run and configure the gateway is in
the [README](../README.md).

## One process, no dependencies

The HTTP surface, the WebSocket surface, the store and the gossip all live in one
Node process. A payment read is therefore a synchronous SQLite call rather than a
round trip. Node runs the TypeScript as written, so there is no bundler and no
build step to keep working.

The store is one SQLite file through `node:sqlite`, which means no database
server to run, back up or authorise. Four fact tables carry the money path, and one
local table carries the clock.

## The store: facts, and one clock

Every row is either a fact that happened or this instance's own clock, and only
the facts leave the machine.

A fact is immutable, carries the origin that minted it and that origin's own
sequence number, and is stamped with an HMAC under the cluster key. There are
four. `accepted` says this gateway took a payment on, and carries the invoice, the
verify URL, the trigger and the webhooks. `paid` records a settlement, `outbox` a
webhook owed, `delivered` the tombstone saying it landed. Facts are a grow-only
set, so merging two instances is `INSERT OR IGNORE` and it does not matter what
order rows arrive in or how many times.

Taking a payment on is a fact for the same reason settling it is: it happened, at
one instance, and no later event can make it not have happened. What is not a fact
is the watching. `schedule` holds one row per payment being watched, with the
moment it is next due, and that is local: a poll is an idempotent read of somebody
else's server, so losing the clock costs one extra read and nothing else.

The worklist is therefore not a table anybody replicates. It is a question asked
of the facts: accepted, minus settled, minus expired. That is what makes
replication trivial, and it is why nothing has to be reconciled and no merge
policy can be got wrong. Two instances that accept the same invoice write two
facts, and the reader unions their webhooks, because a union of grow-only sets
does not care who went first.

`pending` is still written, and nothing reads it. It is there so a rollback to the
release before this one finds the worklist where it expects it. The release after
this one drops it.

## The file says which build wrote it

The ledger carries `PRAGMA user_version`, and version one is the shape the first
release wrote. A file already on disk adopts that number without being asked,
because every statement creating the shape is `IF NOT EXISTS`, so a live ledger
and an empty one take the same path and end up stamped the same.

The shape is still applied on every boot rather than only when the stamp moves.
That is the self-heal: a dropped index is rebuilt on the next start, and it does
not announce itself any other way, because a query against a missing index
prepares perfectly well and simply scans the table.

What the stamp buys is the other direction. A file stamped higher than this build
knows means a newer release wrote it and was rolled back, and that is refused at
boot instead of queried. A process that will not start is a page; a process that
reads a schema it does not understand is a wrong answer about money.

Every later step is expand-only, new tables and nullable or defaulted columns,
because `paid`, `outbox` and `delivered` are facts and a rollback hands the same
volume back to a build that ignores the stamp entirely.

## A paid fact proves itself

Beyond the HMAC, two things must hold: the payment id must be the keyed hash of
the payment hash, and the preimage must hash to that same payment hash, which is
the LUD-21 proof. An instance refuses to record a settlement failing either test,
whether it made the fact up itself or a peer relayed it. So a fact that is on one
instance would be accepted by every other, and a fact arriving through a third
instance still has to prove itself.

Deriving the payment id from the payment hash, keyed so it cannot be guessed from
the invoice alone, also makes posting the same invoice twice return the same
payment instead of a duplicate, from any instance.

## The poll schedule

A watcher polls the recipient's LUD-21 `verify` URL. How often is one rule rather
than a table of bands: eager for the first `EAGER_WINDOW_SECS`, 300 seconds, then
the gap is a tenth of how long the payment has already waited.

The scale follows the wait because how long someone has already waited is the
only evidence available about how long they will keep waiting. Five minutes is the
window a payer is actually in front of the invoice. After that, a payment an hour
old is rechecked within six minutes, one a day old within 2.4 hours, one three
days old within 7.2 hours.

Thirty days is where it stops. `WATCH_HORIZON_SECS` is the whole promise this
gateway makes, and it makes the same one for every payment: 155 polls, 60 of them
in the first five minutes. `POST /watched-payments` refuses an `expires_at`
further off than that rather than accepting a watch it will not honour, which is
also what stops one POST parking a row nothing will ever poll or prune.

Outbound polls are paced per wallet host, so the rate at which any one server is
touched stays flat no matter how many payments are pending, and a crowded
provider cannot slow the polls aimed at a quiet one. Politeness is owed to each
server separately, not to their sum.

The rule costs one thing, admitted rather than hidden. After a day the gap is
about 2.4 hours, so a payer who settles on day two can wait that long to be
noticed, which is fine for an unattended paywall and not for a shop. The way out
is not a gateway change but a "check now" button that reads the recipient's own
source directly, or a shorter `expiresAt` re-registered on a "still waiting"
click.

An invoice that would outlive the horizon is refused at creation rather than
watched partway and abandoned, so there is no window where the gateway has
stopped looking at a payment it took on.

## Many instances, no leader

Every instance writes, and a payment created anywhere is known everywhere. There
is no leader, no quorum and no lock, so one surviving instance keeps taking
payments on its own. That is the whole reason this is gossip and not Raft: a
minority can never shrink its own quorum, because it cannot tell a dead peer from
a cut cable.

Instances find each other on a Hyperswarm topic derived from the cluster key and
open a `thunder-cluster` channel. The handshake proves the peer holds that key
before anything is exchanged, and every fact carries its own HMAC on top.

Everything replicates one way. Each side sends what it has as one number per origin
per table, the other replies with everything above that mark, and it repeats until
the batch comes back short. Because facts are immutable and self-verifying,
catching up is just replaying rows nobody can forge, so a peer away for a week
converges the same way as one that missed a second, and a redeploy onto an empty
disk is only an instance whose marks are all zero. A resync runs every thirty
seconds regardless, so nothing depends on a message having been delivered.

An accepted fact proves itself the way a paid fact does. The HMAC has to check
out, the payment id has to be the keyed hash of the payment hash, the fact and the
payment it carries have to agree about when it expires, and an invoice that decodes
has to decode to that same payment hash. A bank-rail watch carries no invoice, so
there it rests on the key and the id binding alone.

A short reply is also the only honest moment to say "I am in sync", because it
means the peer held nothing above any of our marks. That is what `/ready` reports
and it is why the report cannot be faked by counting messages.

The old best-effort pending push and the whole-worklist handshake are still on the
wire, and they are how an instance running the previous release still hears about a
payment. A payment heard that way becomes an accepted fact here, so it reaches
every other instance through the one mechanism. Both arms go away in the release
that drops `pending`.

The cluster key is the topic, the handshake and the write gate at once. That is
why joining is one step and why there is no writer to authorise.

## Webhooks from an outbox

The webhook is owed from a durable outbox, not fired inline. Settling a payment
writes the paid fact and one outbox row per webhook in a single SQLite
transaction, so there is no window where a payment is settled and its webhook is
not yet owed. Retries live on the row, so restarting mid-delivery leaves the debt
intact.

The settler can only owe the webhooks it knew about. Two instances that accepted
the same invoice with different webhooks, or an accepted fact that arrives after
the settlement, would otherwise leave one hook owed by nobody. So the sweep asks
once a minute whether any settled payment carries a webhook that no outbox row and
no delivered tombstone mentions, and owes it. It is done in the sweep rather than
while absorbing facts because a catch-up can split a paid fact and its outbox rows
across two batches, and a minute of slack is the difference between noticing a
missing hook and inventing one.

The outbox replicates too, which closes the case where the instance that settled
a payment dies before delivering. Every instance holding the row schedules it
locally: the origin tries immediately, everyone else waits
`TAKEOVER_AFTER_SECS` plus a stagger derived from a hash of the row and their own
identity, so takeovers do not all fire at once. The `delivered` tombstone calls
them off. Guessing the order wrong costs a duplicate delivery, never a lost
webhook, which is the right way round for something the recipient already has to
deduplicate on `id`.

An expired invoice fires nothing. Anyone holding an invoice can register a
webhook against it, so a hook that fired without a payment would make this
service an outbound cannon aimed wherever they chose.

## Why the work is not split, and why a copy waits

Nobody hands out leases and nobody splits the pending set. Every instance holds
every pending payment it hears about, and the one that took the payment on polls
it at once while everyone else stands by: a mirrored row is due after
`TAKEOVER_AFTER_SECS` plus a stagger from a hash of the payment and the instance,
which is the same shape the outbox already uses to take over a webhook.

That is what keeps politeness flat. In the ordinary case the settlement arrives as
a fact and the standby row is deleted before its turn ever comes, so a second
instance costs the recipient's server nothing. When the owner dies, the copy comes
due and polls, which is the whole point of holding it.

Splitting by a hash of the payment id looks cheaper and is not. Ownership needs
membership everyone agrees on, and without it the failure is not a duplicate poll
but a payment nobody polls at all. Standing by buys the same saving from the other
end and needs nobody to agree on anything.

The cost is admitted: a payment whose owner dies is noticed up to one takeover
window late rather than immediately. Against a three day horizon that is nothing,
and against a wallet host asked the same question by every instance at once it is
a bargain.

The queue is a schedule, not a line. Every row carries the moment it is next due,
and `claim` takes the most overdue first, so a payment created a second ago is not
behind a worklist a peer handed over.

A payment settles once per instance that saw the preimage, and every one of those
records says the same thing, because a paid fact is the invoice, the payment hash
and the preimage that opens it. `won` tells the caller whether this instance was
the one that wrote it, and that is what decides who owes the webhook first.

## Quotes mint nothing

`POST /quotes` runs only the reachability half. It fetches each address's
LNURL-pay endpoint in order and reports the first that takes the amount, with its
range and whoever was passed over. The callback is never called, so nothing is
minted and nothing is charged to the recipient's wallet.

`fee` is always zero, because the payer pays the recipient directly and the
gateway is never in the money's path.

A quote is a probe and not a promise. Whether a wallet returns a provable invoice
cannot be known without asking for one, and asking mints it.

## Idempotency claims the key first

An `Idempotency-Key` is claimed before any wallet is contacted, because the retry
that matters is the one a client fires when its own timeout expires while the
first request is still resolving. Claiming late would ask a wallet for a second
invoice.

So a repeat of a finished request replays its payment, a repeat arriving
mid-flight answers 409, and a request that mints nothing hands the key back. The
key is bound to the request that claimed it, so reusing it for a different amount
answers 409 rather than the earlier payment. Keys are held 24 hours, shorter than
a payment lives, and are not gossiped, so two concurrent requests hitting two
different instances are still two invoices.

## The BOLT11 decoder is hand-rolled

Bech32 in a few pages, no library. It is pinned to the spec vector plus two real
invoices whose payment hashes a Rust `lightning-invoice` build produced, so both
implementations agree byte for byte.

A decoder is the one place the gateway must not be taken on trust, since the
amount and the payment hash it reads out are what every later check compares
against.

## A token is the mode, not a role

`GATEWAY_TOKEN` does not model permissions. It answers one question: is this
instance yours. A gateway without one is public and serves anyone, a gateway with
one answers only its holder.

That is why `GET /incoming-payments` is gated on the mode rather than on a scope.
A list on a shared gateway would hand every caller everyone else's payments. On a
private gateway the correlation a list implies costs nothing, because you are the
only caller and there is nobody to be correlated against. A public instance answers
404 rather than 401, so it does not disclose that the endpoint exists elsewhere.

## Pinning the recipient at payRequest

`lnurlPayEndpoint` answers both halves of the LNURL flow on one path, and it picks
the winning address at payRequest rather than at callback time. LUD-06 makes the
payer's wallet check the invoice's description hash against the sha256 of the
metadata it was served, and only the recipient's own wallet mints the invoice, so
that metadata has to be the recipient's. If the list were walked again at callback
time and a different address won, the hashes would differ and the payer's wallet
would refuse the payment.

The cost is real and worth knowing: once pinned, a recipient that goes down
between the payRequest and the callback fails that payment, with no fallback
behind it. The priority list buys availability at create time, not for the length
of one payer's hesitation.

## Two rails, one order

A shop can offer the same thing for Lightning and for a Czech QR platba at once
and take whichever lands first. The design is a shared trigger, not a new
resource. Both legs carry one trigger secret, `followTrigger` streams every
payment carrying it, and the first to reach `paid` wins. No linkage table, no
polling loop of your own, no socket per customer.

Which order settled travels in `sealed`, an opaque blob the gateway stores and
hands back without being able to read it. So the socket tells the shop the
reference and the price while the gateway learns neither.

**Mint the Lightning leg late.** The bank leg is nearly free: the QR is derived
from a secret and a reference with no network at all, and registering the watch is
one POST. The Lightning leg costs a round trip to the recipient's wallet and
produces an invoice that expires in about an hour. So show the QR immediately and
mint the invoice when the payer picks Lightning, with the reference as the
idempotency key. The window in which both rails are payable shrinks from days to
the minutes a payer spends deciding.

**No cancel endpoint, and no order object.** Cancelling a watch would buy about
130 saved polls per order and would cost another fact type in the ledger, since
a cancellation has to replicate or one instance keeps polling what another
abandoned. That is a lot of machinery for a rounding error. Revisit it only if
open offers ever run into `MAX_PENDING`. An order object was tried on paper and
did not survive the writing: two prices, two addresses, an IBAN, a verify URL, an
expiry and a trigger is a twelve field parameter bag that mostly forwards to two
functions the caller can already call. What was actually missing was one sentence
of behaviour, which leg won, and that is `firstToSettle`.

**Double payment is detected, not prevented.** Nothing can revoke an invoice,
because the recipient's own wallet minted it and only that wallet could refuse
it. LUD-21 reports settlement, it does not revoke. So a payer who scans the QR on
Monday and pays the invoice on Tuesday really has paid twice. What the design
gives is the fastest possible detection with no extra work: the second `paid`
arrives on the trigger socket the shop is already listening to, with the amount
and the reference in `sealed`. That is a refund signal, not a bug, and it needs no
reconciliation job.

**Reading the bank does not stop when an order is won.** An earlier plan closed
the verify endpoint for a won order. That was wrong, and it was found while
building: a bank transfer landing two days later would go unnoticed, and that is
exactly the double payment the shop has to refund. The reads are cheap enough not
to matter anyway.

## Railway

Three things bite, and each fails in a way that does not name its own cause.

- **No `VOLUME` instruction in the Dockerfile.** Railway's builder rejects it and
  the build fails two seconds in with an empty log and `Failed to build an
  image`. Mount points belong on the service.
- **Point the domain at the injected port**, `railway domain --port 8080`.
  Railway sets `PORT` and the server binds it. `EXPOSE 3000` is not what the
  proxy routes to, and the mismatch shows up as a 502 while the container logs a
  healthy start.
- **Do not set `PORT`.** Railway injects it, the server reads it.

Alpine is not an option either, because Hyperswarm's native modules ship no musl
prebuilds. Prebuilds for every platform except linux are pruned before the final
stage, which trims around 150 MB of other systems' binaries.

State survives through the other instances, not through the disk. A redeploy
starts on an empty file and gap-syncs every fact back from its peers, since a
fresh instance is just one whose watermarks are all zero. That makes a second
instance somewhere else the actual durability mechanism. Until one exists, set a
volume at `/data` or accept that a lone redeploy forgets.

## Talking to a stranger

Every outbound request in this service goes to a server somebody else named. A
payer names the lightning address, and anyone holding an invoice may register a
webhook, so the URL is untrusted input that happens to be spelled like a URL.

One place owns that conversation. It refuses anything that is not public https,
resolves the name and refuses when any address it answers with is one we would
not reach, follows at most two redirects and re-runs both checks on every hop,
and reads a bounded number of bytes before parsing anything.

The redirect is the part that was actually exploitable. Left to itself `fetch`
follows up to twenty hops, so a URL that passes every check on hop one can land
on `http://169.254.169.254/` on hop two and hand back the cloud metadata service.
Following the chain by hand is the only way the guard sees the destination that
is finally reached.

Checking the resolved address rather than the name is one layer, and the
transport is the other: this gateway connects to the address the guard verified
instead of letting the name resolve a second time, so a record that flips
between the check and the connection is caught. The check also buys that a name
openly pointing inside is refused before a socket opens, and the https
requirement means an attacker also needs a certificate the internal service
will serve. Refusing when *any* address is private, rather than when all of
them are, costs availability in one case worth knowing: a wallet whose DNS
answers with a stray private record alongside good ones is refused entirely.

Credentials do not travel across an origin, and a redirect that does not say
where to is refused rather than retried, both because the next caller of this
helper will not think about either.

## What a caller may send

A request body is read up to 64 KiB and refused past it, twice over: once on
`content-length`, which costs nothing and refuses before a byte is read, and once
on the bytes actually arriving, because a chunked body declares no length. The
largest request this API defines is a watch carrying a full 4096-character
`sealed` blob, which is around 24 KB once escaped, so the ceiling is generous and
still nothing a public instance can be made to spend.

Every field that is kept has a length now, not only a type. An address, a webhook
secret and a sealed blob are all stored, and the secret is an HMAC key that
replicates to every peer, so "a string" was never a bound. The WebSocket surface
takes the same ceiling, since a socket upgrade never passes through the body path
at all and `ws` would otherwise accept 100 MB a frame.

## Leaving without dropping work

A redeploy is a signal, and the process answers it. `SIGTERM` and `SIGINT` turn
readiness down first, so a balancer stops sending work while the listener is
still up, then the timers stop, the tick in flight is waited out under
`DRAIN_TIMEOUT_SECS`, the sockets and the listener close, and the ledger closes
last. A second signal exits at once.

Liveness and readiness answer different questions and are kept apart, because the
platform does different things with them. `/health` is liveness: it turns 503 only
when the watch loop has stopped being scheduled at all, which a restart cures. A
slow tick is not that, and pacing a crowded wallet host can make a tick take
minutes without anything being wrong.

`/ready` is whether to send work. It turns 503 while draining, and it reports a
full worklist without refusing on it, because an instance at `MAX_PENDING` still
settles and still serves, and `POST /incoming-payments` is where a caller learns
it cannot take another. Reporting a count as not-ready would take the whole
deployment out of rotation for a condition no restart and no drain repairs.

The vitals behind that answer are added only for a caller holding the bearer. A
pending count is small, but it is still a fact about somebody's trade, and the
path is open to everyone.

## What is still trusted

The recipient's server, because it minted the invoice and, when custodial, holds
the money. TLS and DNS for their domain. And the proof binds an invoice to an
address, never an address to a person, so vouching for the address stays with
whoever published it.

This service deliberately ships no verifier of its own. A proof you fetch from
the party being audited is not a proof, so the checks live in the client, in
[sdk/](../sdk), which runs them against the recipient's own server before the
payer sees a QR code.
