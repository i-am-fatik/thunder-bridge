# dev - a regtest stack for the wrap

Three Lightning nodes and a bitcoind on a private chain, wired so one node can hold
an invoice on a payment hash while paying another invoice on the same hash. That is
the thing a wrapping operator needs and the thing this stack proves.

Ports sit off Polar's band, so both can run at once.

## Run it

```bash
dev/wrap-proof.sh
```

Brings the stack up, mines, funds the wallets, opens `payer -> wrapper -> payee`,
then holds a wrap, forwards it, and settles it with the preimage the forward
revealed. Safe to run again: it reconnects peers and skips channels that exist.

The integration tests use the same stack and skip themselves when it is down.

```bash
npx vitest run tools/wrap-regtest.test.ts tools/nwc-wrap.test.ts
```

## The nodes

| Service | Image | Role | Host port |
|---|---|---|---|
| `chain` | bitcoind 30.0 | the private chain | 18453 |
| `payer` | LND 0.20.0-beta | pays the wrap | 10011 grpc, 8091 rest |
| `wrapper` | LND 0.20.0-beta | holds and forwards | 10012 grpc, 8092 rest |
| `payee` | Core Lightning 25.12 | the recipient | 9846 p2p |

`docker exec` is the only way in, so no certificate or macaroon leaves a container.
State lives under `dev/volumes`, which is git-ignored because it carries keys.

## What can be set

| Variable | Default | Meaning |
|---|---|---|
| `USERID` | `id -u` | owner of the bind-mounted node state |
| `GROUPID` | `id -g` | group of the bind-mounted node state |

## Links out

- [`../docs/lud21-coverage.md`](../docs/lud21-coverage.md) - why wrapping is needed at all
- [`../tools/nwc-regtest-wallet.ts`](../tools/nwc-regtest-wallet.ts) - the NIP-47 wallet the tests drive this stack through
