# Trigger watcher

One QR on the wall, and something that reacts every time someone pays it. This is the half that
cannot live on a serverless runtime: `followTrigger` holds a WebSocket open for as long as you want
to hear about payments, and Deploy ends an invocation the moment it answers. A laptop, a Raspberry
Pi or any always-on box is where this belongs.

A trigger is a place rather than a payment. Every payment created with the same `WATCH_SECRET`
belongs to it, so the endpoint in [../deno-deploy](../deno-deploy) mints them and this watches them,
with nothing wired between the two but that one string.

Minting only ever hands the gateway the sha256 of the secret. Watching is the exception: the secret
itself authorises the stream, so `followTrigger` puts it in the socket url and the gateway hashes it
there. `tickets: true` swaps it for a short-lived ticket per connection when a url out of an access
log is a worry. Either way the secret stays off anything a payer sees.

```bash
GATEWAY_URL=https://thunder-bridge-direct-production.up.railway.app \
WATCH_SECRET=<the same 32 characters the endpoint got> \
  deno task watch
```

```
watching https://thunder-bridge-direct-production.up.railway.app, ctrl-c to stop
21 sat to you@blink.sv, preimage 9f3c1ab5e70d2c84
```

Recent settlements are replayed when the socket opens, then new ones arrive live, and the stream
reconnects on its own until you stop it. Replace `ring` with whatever the payment should do: light
an LED, push a stream overlay, open a door.

A `paid` event whose preimage does not hash to its payment hash never reaches `onPayment`, it goes
to `onError` instead. Anything the gateway makes up is dropped before your code sees it.
