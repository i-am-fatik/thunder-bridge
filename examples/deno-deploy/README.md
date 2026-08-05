# Paywall on Deno Deploy

Sell one thing for sats from a Fetch handler. No Lightning node, no database
server, and nothing running between requests: the payer pays an invoice your own
wallet issued, the gateway posts a webhook when it settles, and Deno KV holds what
has been unlocked.

Four routes, in `main.ts`:

```
POST /invoice                  mint an invoice, hand back the id and where the content will be
POST /hooks/paid               the gateway's webhook, verified and proven before anything unlocks
GET  /content/{id}             402 until that payment settled, the content after
GET  /.well-known/lnurlp/tips  a lightning address on your own domain, one static QR
```

The address route is `lnurlPayEndpoint`, both halves of LNURL-pay on one path. It
holds no state, so `tips@your-app.deno.dev` is payable from any wallet with nothing
provisioned behind it.

Every payment here, minted through `/invoice` or through the address, carries the
same `WATCH_SECRET` and therefore belongs to one trigger.
[../trigger-watcher](../trigger-watcher) is the long-lived process that hears about
each one.

Settlement arrives as a webhook rather than over a socket because Deploy ends an
invocation when it answers, and a payment can live for weeks. The webhook is not
taken at its word: `parseWebhookRequest` checks the HMAC and the timestamp, then
`proveSettlement` goes to the recipient's own server for the preimage, and the
content stays locked unless that server released one. Why those are two separate
calls is in [../../sdk/README.md](../../sdk/README.md#origin-is-not-settlement).

## Configure

| Variable | Default | Meaning |
|---|---|---|
| `LN_ADDRESSES` | required | comma-separated priority list, first one that can issue a provable invoice wins |
| `WEBHOOK_SECRET` | generated at boot | 32 characters of randomness, signs the webhook |
| `CALLBACK_SECRET` | generated at boot | signs the address callback, without it anyone could make this endpoint mint |
| `WATCH_SECRET` | generated at boot | groups every payment into one trigger, minting sends only its sha256 |
| `ADDRESS_NAME` | `tips` | the local part, so the address is `tips@your-app.deno.dev` |
| `PRICE_MSAT` | `21000` | what one unlock costs, in millisatoshi |
| `GATEWAY_URL` | the public gateway | your own instance goes here |
| `CONTENT` | a placeholder line | what a payer gets |
| `PUBLIC_URL` | the request's own origin | set it when a proxy knows the public name and the app does not |

`LN_ADDRESSES` is the only one you have to set. The three secrets are generated at
boot when missing and the generated `WATCH_SECRET` is printed once, so a fresh
deploy runs before you have decided anything. Set them the moment it matters: a
restart mints new ones, which invalidates every webhook and callback in flight and
orphans the trigger.

Every address on the list has to speak LUD-21, otherwise nothing can prove the
payment arrived and the gateway refuses it at creation. Who implements it is in
[../../docs/lud21-coverage.md](../../docs/lud21-coverage.md).

```bash
cat > .env <<EOF
LN_ADDRESSES=you@blink.sv,you@coinos.io
WEBHOOK_SECRET=$(openssl rand -hex 16)
CALLBACK_SECRET=$(openssl rand -hex 16)
WATCH_SECRET=$(openssl rand -hex 16)
PRICE_MSAT=21000
EOF
```

## Run it

```bash
deno task dev
```

On localhost `/invoice` refuses outright, and that is the gateway rather than this
example: the webhook url it would be handed is `http://localhost:8000/...`, and
every outbound URL has to be public https. Point a tunnel at port 8000 and pass its
name as `PUBLIC_URL`, or just deploy it.

## Deploy it

[![Deploy on Deno](https://deno.com/button)](https://console.deno.com/new?clone=https://github.com/i-am-fatik/thunder-bridge&path=examples/deno-deploy)

The button clones this directory into a repo of your own and deploys it. Nothing
runs usefully until you add `LN_ADDRESSES` in the dashboard, and the app says so on
every route until you do. From a checkout instead:

```bash
deno install -gArf jsr:@deno/deployctl
deployctl deploy --prod --env-file
```

KV needs no provisioning on Deploy. Locally it is a file, and `--unstable-kv` is
already in the task.

## Try it

```bash
curl -s -X POST https://<your-app>.deno.dev/invoice
```

```json
{
  "id": "80cd25b6c4ea...",
  "bolt11": "lnbc210n1...",
  "amount_msat": 21000,
  "content_url": "https://<your-app>.deno.dev/content/80cd25b6c4ea..."
}
```

Pay the `bolt11` from any wallet, then read the content url. Before the payment it
answers 402, after it answers the content and the preimage that proves the money
moved.

The address needs no call of your own. Put `tips@<your-app>.deno.dev` in a wallet,
or read the payRequest the way a wallet does:

```bash
curl -s https://<your-app>.deno.dev/.well-known/lnurlp/tips
```

Then start [../trigger-watcher](../trigger-watcher) with the same `WATCH_SECRET`
and every payment to either route prints there as it settles.

## Before you sell anything real

- Deliveries are at-least-once, so a settled payment can arrive twice. Writing the
  same key twice is harmless here, anything with a side effect is not.
- One payment unlocks one id and the id is in the url, so treat it as the bearer
  token it is. Thirty days later the KV entry expires.
- `PRICE_MSAT` is read once at boot. A fiat peg is a function call at mint time
  instead, which is the shape `lnurlPayEndpoint` takes for `amountMsat`.
