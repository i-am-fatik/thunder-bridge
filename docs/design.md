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
server to run, back up or authorise. Four tables carry the money path.

## The store: work and facts

The difference between the four tables is whether a row is work to do or a fact
that happened.

`pending` is work. It is local, mutable, and expired rows are deleted, so an
invoice nobody pays leaves nothing behind. Each row carries a `dueAt`, so the
queue is a single `UPDATE ... RETURNING` under a lease rather than a sleeping
task per payment.

`paid`, `outbox` and `delivered` are facts. A fact is immutable, carries the
origin that minted it and that origin's own sequence number, and is stamped with
an HMAC under the cluster key. `paid` records a settlement, `outbox` a webhook
owed, `delivered` the tombstone saying it landed. Facts are a grow-only set, so
merging two instances is `INSERT OR IGNORE` and it does not matter what order
rows arrive in or how many times.

That split is what makes replication trivial. Work is nobody else's business and
facts cannot conflict, so there is nothing to reconcile and no merge policy to
get wrong.

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
the gap is a tenth of how long the payment has already waited, capped at a day.

The scale follows the wait because how long someone has already waited is the
only evidence available about how long they will keep waiting. Five minutes is the
window a payer is actually in front of the invoice. After that, a payment an hour
old is rechecked within six minutes, one a week old within seventeen hours, and
never less than daily.

Over the 30 days a coinos invoice lives that is roughly 160 polls, 60 of them in
the first five minutes. A late payer is still caught without hammering someone
else's server for a month.

Outbound polls are paced per wallet host, so the rate at which any one server is
touched stays flat no matter how many payments are pending, and a crowded
provider cannot slow the polls aimed at a quiet one. Politeness is owed to each
server separately, not to their sum.

The cost of the rule is one UX wart: after a day the gap is about 2.4 hours, so a
payer who settles on day two can wait that long to be noticed. Fine for an
unattended paywall, not for a shop. The way out is not a gateway change but a
"check now" button that reads the recipient's own source directly, or a shorter
`expiresAt` re-registered on a "still waiting" click.

## Many instances, no leader

Every instance writes, and a payment created anywhere is known everywhere. There
is no leader, no quorum and no lock, so one surviving instance keeps taking
payments on its own. That is the whole reason this is gossip and not Raft: a
minority can never shrink its own quorum, because it cannot tell a dead peer from
a cut cable.

Instances find each other on a Hyperswarm topic derived from the cluster key and
open a `thunder-cluster` channel. The handshake proves the peer holds that key
before anything is exchanged, and every fact carries its own HMAC on top.

Pending payments are a best-effort push. Facts gap-sync: each side sends what it
has as one number per origin per table, the other replies with everything above
that mark, and it repeats until the batch comes back short. Because facts are
immutable and self-verifying, catching up is just replaying rows nobody can
forge, so a peer away for a week converges the same way as one that missed a
second. A resync runs every thirty seconds regardless, so a dropped push heals
without anyone noticing it was dropped.

The cluster key is the topic, the handshake and the write gate at once. That is
why joining is one step and why there is no writer to authorise.

## Webhooks from an outbox

The webhook is owed from a durable outbox, not fired inline. Settling a payment
writes the paid fact and one outbox row per webhook in a single SQLite
transaction, so there is no window where a payment is settled and its webhook is
not yet owed. Retries live on the row, so restarting mid-delivery leaves the debt
intact.

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

## Why the work is not split

Nobody hands out leases and nobody splits the pending set. Every instance polls
every pending payment it holds.

Splitting by a hash of the payment id looks cheaper and is not. A full pending
set costs one instance 0.31 `verify` polls a second against a per-host budget of
five, so a second instance doubling that spends twelve percent of the budget to
remove the question entirely. What splitting saves is small enough to measure,
and what it costs is a coordination problem.

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

## What is still trusted

The recipient's server, because it minted the invoice and, when custodial, holds
the money. TLS and DNS for their domain. And the proof binds an invoice to an
address, never an address to a person, so vouching for the address stays with
whoever published it.

This service deliberately ships no verifier of its own. A proof you fetch from
the party being audited is not a proof, so the checks live in the client, in
[sdk/](../sdk), which runs them against the recipient's own server before the
payer sees a QR code.
