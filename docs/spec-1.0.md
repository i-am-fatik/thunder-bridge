# The payment flow, respecified

What the gateway must do, what the SDK must do, and what the gateway must not be
able to abuse. Written as answers to one question at a time, each answer carrying
the cost it was chosen with.

## 1. The gateway is a blind store and a seeing watcher

The gateway keeps in plaintext only what it cannot do its work without:

- `verify_url`, because it polls it
- `expires_at`, because it schedules and stops on it
- `payment_hash`, because it proves the preimage itself before it says paid
- the webhook url, because it delivers there

Everything else the SDK hands over encrypted, as one opaque blob the gateway
stores and hands back untouched: the lightning address, the amount, the invoice,
and whatever the client wants to carry with the payment.

Those first three were never sent to a watching gateway in the first place, so the
blob is not there to hide them. It is there because of section 7: the gateway is the
client's own store for a window, and a client that keeps its records at three
gateways can read them back from whichever one is still answering.

The key is not a new thing to keep. The SDK already holds a long lived server
side rail secret, and the blob key is derived from it.

What the operator sees, therefore: that a payment exists, when it settled, and
where a webhook goes. Not to whom, and not how much. The revenue curve stops
being visible to the operator, which was the whole reason for the change.

What it costs: the gateway can no longer render a payment, so a dashboard, a
support answer and any per payment diagnostics have to come from the SDK side.
`sync.marks` and `sync.rows` still work, because they are counts.

## 2. The SDK mints, and the gateway's own minting is a degraded mode

Encryption at rest does not protect what the gateway must read at request time.
A gateway that mints is handed the address and the amount in the clear and can
log them, whatever it does with them afterwards. So minting moves to the SDK,
which already fetches the recipient's `.well-known/lnurlp` for `proveOrigin` and
already imports the minting half of `core/lnurl.ts`.

The gateway keeps a minting endpoint for clients who have nowhere to run, and it
is off unless the instance turns it on. On that path the concession is stated and
not softened: the operator sees the address and the amount, may log them, and the
blind store protects nothing that was already read. A client who wants the
operator blind mints its own invoices.

Minting in the SDK runs without the gateway's address pinning, because that is
gateway only and Deno has no `options.lookup`. It matters far less here: the SDK
fetches an address its own operator chose, not a URL a stranger named.

Half of this was already built, which reading the code before writing any found out.
`blindLightningRail` has always resolved the address itself through `core/lnurl` and
handed the gateway only a hash, a url and an expiry. So nothing moved: what changed is
that the gateway's own minting is off unless an instance says otherwise, and the one
client still using it, the Deno example, says in its README that an instance has to
allow it.

## 3. The client names the payment

`payment_id` is `sha256(caller public key ‖ "payment-id" ‖ payment hash)`.

Writing it changed it. The plan said to derive the id from the client's rail secret,
and deriving it from the client's public key instead is strictly better for one
reason: the gateway can work it out too. So the id is never sent, it is computed on
both sides, and the check that a fact is named after what it settles survives instead
of being deleted. Nothing here is secret and nothing needs to be, because a payment is
handed only to the key that created it.

This answer was reversed once, and the reversal is the reason to trust it. Naming by
the client was refused first, because a gateway with one instance wide bearer cannot
tell which caller is speaking and an id a caller picks is an id another caller can
squat. Section 6 removes that objection: the first writer binds the id to a public
key and anybody else presenting it is refused.

What decided it in the end was where the naming authority belongs. The client's rail
secret is already the thing that can never be lost, because the preimage is derived
from it and losing it loses every proof. The operator's cluster key is the opposite,
it is meant to be rotatable, and today that rotation renames history, which is why
`namesItsOwnHash` has to keep admitting retired keys. Naming from a secret that is
already permanent adds no fragility. Naming from a key that rotates buys that
complication for good.

`namesItsOwnHash` therefore stays, in a better form: a fact carrying a caller must be
named after that caller, and only a payment nobody signed for falls back to a key this
cluster holds. Which is also the honest answer to a hole in the plan: on the minting
path the client cannot name the payment, because the gateway learns the payment hash
from the wallet and the client never sees it first. Anonymous callers and minted
payments keep the old naming, and it is the caller that decides which, not the route.

The rest of `paymentId` and the id half of `CLUSTER_KEYS_RETIRED` do go.
There is no data migration and no window that reads both forms either, because the
release is one coordinated cutover and a gateway can be drained first. Nothing is
minted, the watches in flight settle or expire within three days, and the new build
starts on a ledger that holds no old ids at all. A drain is cheaper than
compatibility code, and it leaves none behind.

One honest cost. Several gateways now hold records under one name, so they have to
agree about it, and it is the SDK that checks they do: `watchPayment` refuses a
`GatewayCheatError` of its own, `id_not_mine`, when the answer is named after somebody
else. The gateway is not the place that reconciles.

And one property that reads like a regression and is not. Two different callers may
now watch the same invoice, because their names for it differ. They each poll the
verify url they named, on their own quota, and neither can touch the other's record.
What that closes is the leak the old global name left open: knowing a payment hash is
enough to know its id, so a payer could re-register somebody else's watch and have
`mergedWebhooks` quietly add their own webhook to it.

## 4. The gateway holds no secret of the client's, so the shared one goes

Both signing paths already exist: `WebhookCredential` is `string | { publicKey }`
and the gateway publishes its ed25519 public key at `/webhook-key`. The choice was
therefore not what to build but what to delete, and the shared secret is deleted.

It buys one thing worth having. The gateway stops holding a piece of the client's
property that it never needed, and that secret stops riding along in the outbox
fact to every instance in the cluster, so a copy of a ledger stops being a copy of
somebody's secrets.

What it costs is paid once. Every existing integration breaks and has to move to
the public key, and there are three of them, all ours. The receiver has to fetch
and pin the key, which is a new way to fail, and rotating the cluster key rotates
the signing key with it, which the runbook already says out loud.

It does not reduce what the operator can do. The signing key is derived from the
cluster key either way, so a gateway can always sign a delivery that looks
genuine. What is refused here is the gateway holding the client's half.

## 5. A client watches at several gateways at once, and that is what makes an operator replaceable

The client takes a list of gateways rather than one. It registers the watch at all
of them, the first delivery to arrive wins, and the shared `payment_id` from
section 3 is what makes the others recognisable as the same payment.

This works for watching and not for minting. Two gateways asked to mint would each
fetch a different invoice from the wallet and only one of them would ever be paid.
Watching is different because the SDK owns the invoice and owns the proof, so the
gateways are only notifiers and any of them can be the one that speaks.

Disagreement needs no protocol. When one says settled and another does not, the SDK
asks the recipient's own endpoint, which is what it already does before it believes
any settlement, so the answer never comes from counting gateways.

What it costs: the client's verify endpoint is polled by every gateway watching,
so the traffic multiplies by the number of them. The pace is already the client's
to set, through `Cache-Control: max-age` and `RateLimit-Limit` on its own verify
responses, and the spec keeps that as the only throttle that matters.

## 6. A caller proves who it is by signing, and the gateway keeps no account

Today `GATEWAY_TOKEN` is one bearer for a whole instance, so it says a caller is
allowed in and never which caller is speaking. That gap killed two things this
month: an `Idempotency-Key` that cannot be scoped to anybody, and an id the client
chooses that anybody else could squat.

So the SDK signs each request with a key derived from its rail secret, and the
gateway records the public key that created a payment and requires that same key
afterwards. No registration, no account, no secret of the client's held anywhere,
which keeps the gateway the un-productised thing decision 1 says it is. It is also
the shape this codebase already uses twice, in the webhook challenge and the verify
challenge: consent proved by a signature rather than by an entry in a table.

What it unlocks is worth the field: a read that only the owner can make, a rate
limit that counts per caller instead of per instance, and an idempotency key that
means something because it is scoped to whoever presented it.

What it costs: every request carries a signature, so no browser talks to a gateway
directly, because the rail secret is server side and must stay there. The socket
handshake needs the same proof, which the ticket path already exists for.

## 7. The gateway is a store for a window, and it stores only ciphertext

The gateway already forgets. `sweep` deletes the schedule, the accepted, the
settled, the outbox, the paid and the delivered rows one hour past expiry or
settlement, on `EXPIRED_GRACE_SECS = 3600`. So the plaintext a gateway sees today it
sees live and not historically, unless the operator logs it, and that stays true.

What changes is that the encrypted blob outlives the plaintext, for a window the
instance sets rather than for an hour. Ninety days covers a chargeback argument and
an accounting quarter, and then it goes on its own. Because the id is derived from
the client's own secret, the client can read its own history back from any gateway
that watched the payment, which is what makes an operator swappable in practice
rather than in principle.

What it costs, and the spec says it rather than implying safety: an opaque blob still
answers questions by its existence. How many payments a key made, when, and roughly
how large the record is, are all readable without decrypting anything. A window keeps
that bounded. Permanent storage would not.

## 8. Quotas are counted per key, and an instance may demand a list of them

The gateway has no limit at all today. `MAX_PENDING` is 5000 for a whole instance and
`429` does not appear in the code, so one caller can take every slot. With section 6
there is finally something to count against, so `MAX_PENDING` becomes per public key
and a caller over its share is refused with `429` and the `RateLimit-*` headers the
gateway already reads from wallets.

An instance may also require a list of accepted client keys. On a self hosted
instance that list is the whole defence, because the clients are known by name and
nobody else has any business being there.

The spec states the limit of this rather than dressing it up. A keypair costs nothing
to make, so per key quotas are fairness between honest clients and not a defence
against an attacker. On an instance open to strangers the defence has to sit in front
of the gateway, and the runbook says so instead of implying the quota covers it.

## 9. Rotating the cluster key re-signs the log, and the old key becomes worthless

A peer introducing itself under a retired key is admitted today, at `gossip.ts:40`,
because `introduces` is handed `[key, ...retired]`. The topic is derived from the live
key alone, so a retired key cannot find the swarm on the DHT, but a direct dial to a
replication port still gets in and still writes facts. Which is why retiring a leaked
key was never a rotation.

Section 3 took the naming job away from the cluster key, and section 7 bounded what a
ledger holds, so the whole reason retired keys existed is gone. Rotation now re-signs
the retained log in one transaction at startup under the new key, and the old value is
worth nothing afterwards. `CLUSTER_KEYS_RETIRED` goes with it.

One thing does not survive, and implementing it is how that turned up. A payment its
caller signed for is named after that caller, so a rotation carries it across
untouched. A payment nobody signed for is named by this instance's key, so after a
rotation it stays readable where it lives and a peer refuses it, because it no longer
names its own invoice. Re-signing a MAC cannot fix a name. Minted payments are the
unsigned ones, which is another reason minting is off by default.

What it costs: a rotation becomes an operation with a data pass, so it has to be
transactional and it has to be tested interrupted halfway. While a roll is in
progress the cluster is partitioned until every instance carries the new value, which
is already true on the DHT today and becomes true for directly paired peers too.

And one consequence that only appears once section 4 is also true. With the shared
secret gone, every receiver verifies deliveries by the gateway's published key, and
that key is derived from the cluster key, so a rotation invalidates it for everybody
at once. Rotation stops being an operator's private business and becomes an event the
clients see, which means the runbook has to say to re-fetch, and the SDK has to treat
a signature failure as a reason to refresh the key rather than as a cheating gateway.

## 10. A delivery carries what it takes to act, and nothing of the client's

The webhook body is the id, the status, the settled time and the preimage. The
gateway could not carry the address or the amount anyway, and it does not carry the
blob either.

The preimage is what makes the delivery worth having, because it is the proof, so a
client can act and check without asking anybody. A body of constant size also means
the cost of a retry does not depend on what the client put in its own record, and
with several gateways watching, the first delivery to arrive is enough and the rest
are dropped by id.

A captured delivery can be replayed, which the signature's timestamp window already
covers. The preimage travelling in the body is not a new exposure: the recipient's
own verify endpoint hands it to anybody holding the url, by design, because that is
what LUD-21 is.

## The flow, end to end

1. The client's SDK derives the invoice from its rail secret, or fetches one from the
   recipient's wallet itself, and derives `payment_id` from the same secret and the
   payment hash.
2. It encrypts its own record under a blob key derived from that secret, and signs the
   registration under a separate signing key derived from the same secret.
3. It registers the watch at every gateway it was configured with: `payment_id`, the
   payment hash, the verify url, the expiry, the webhook url, and the blob.
4. Each gateway checks the signature, checks the key is one it accepts, checks the
   caller is inside its quota, and challenges the verify url and the webhook url to
   prove they consent to the traffic.
5. Each gateway polls the verify url at the pace that url asks for, until it settles
   or expires.
6. On settlement each gateway proves the preimage against the payment hash before it
   believes it, then delivers the id, the status, the settled time and the preimage,
   signed with its ed25519 key.
7. The SDK takes the first delivery, verifies the signature against the gateway's
   published key, proves the preimage against the payment hash it holds, and proves
   the settlement against the recipient's own endpoint before it tells the
   application anything.
8. One hour past settlement every gateway forgets the plaintext. The blob stays for
   the window the instance sets, readable only by the key that wrote it.

## What the gateway must not be able to do

- Learn the address or the amount, on any path except its own degraded minting mode.
- Read anything the client put in its own record.
- Say a payment settled without a preimage that hashes to the payment hash.
- Make the SDK believe a settlement, because the SDK proves it against the recipient
  and not against the gateway.
- Hold a secret of the client's, of any kind.
- Hand a payment to anybody but the key that created it.
- Name the client's payments, so that nothing of the client's depends on a key the
  operator rotates.
- Keep any of it longer than the window it published.

## The parts that were specified rather than chosen

Three things had one sensible answer, so they were written down instead of being put
to a vote.

**The blob.** AES-256-GCM through `crypto.subtle`, which the client already depends
on, with a one byte version prefix and a fresh twelve byte nonce per write. The key is
HKDF from the rail secret under its own label, so it is not the preimage key and never
the signing key. The gateway cannot detect a corrupted blob and is not asked to, the
SDK finds out on decrypt, which is the only place that could ever have known.

**A read.** Only the key that created a payment may read it. Anybody else is answered
404 rather than 403, because a 403 confirms the payment exists and that is exactly the
question a stranger was asking.

**The signature.** Over the method, the path, the body hash and a timestamp, the same
shape the webhook signature already has, so one verifier reads both and neither
invents a scheme of its own.

## Shipping it

One release, one cutover, version 1.0 on both sides. The SDK ceiling has to be lifted
for it, which is a decision that belongs to nobody else.

What that buys: one migration, one documentation rewrite, and not a single line of
dual support code, because the drain in section 3 removes the only thing that would
have needed it.

What it costs, stated plainly so nobody is surprised by it later: a long branch on
which nothing can be deployed, and in this project that means weeks without the thing
that has proved every release so far, a real payment with real money. The mitigation
is not a smaller release, it is proving each piece against the live gateway from the
branch before the cutover, the way both rails were proved.

The order to build it in, because the dependencies are real: request signing and the
key that identifies a caller, then client named ids on top of it, then the blob and
the retention window, then the deletion of the shared webhook secret and the new
delivery body, then quotas and the allowlist, then rotation re-signing the log, then
the client taking a list of gateways, and last the mint path turned off by default.
