# Errors

Every failure from the gateway is an RFC 9457 problem document. Branch on `type`,
never on prose. `error.status` is the status the response carried, and a different
status in the body does not override it.

## Problem types

Every `type` below is prefixed `urn:problem-type:thunder-bridge:`. Each one is also a
static string on `ProblemError`, named in upper snake case, so no urn is copied by
hand. `ProblemError.is(error, ProblemError.PAYMENT_ALREADY_WATCHED)` branches on a
type that has no error class of its own.

| `type` | Status | What it is |
|---|---|---|
| `invalid-request` | 400, or 413 for a body over 64 KiB | `detail` names the field |
| `no-wallet-available` | 502, else 422, else 400, following the worst wallet | `NoWalletAvailableError`, `wallets` says why each failed |
| `request-in-flight` | 409 | a request with this `Idempotency-Key` is still running, as `IdempotencyConflictError` |
| `idempotency-key-reused` | 409 | that key was used for a different request, as `IdempotencyConflictError` |
| `payment-already-watched` | 409 | that payment hash is already watched here |
| `caller-unknown` | 403 | the instance keeps a list of callers and your key is not on it |
| `verify-host-refused` | 403 | the instance does not mint, because minting is off or `VERIFY_HOSTS` is set, or the verify URL's host is not in `VERIFY_HOSTS`. Where minting is refused, resolve the address yourself and use `watch`. A verify URL that is not public https is `invalid-request` instead |
| `verify-unconfirmed` | 424 | the URL did not answer the LUD-21 shape |
| `verify-unconsented` | 424 | the URL did not echo the challenge nonce |
| `webhook-unconfirmed` | 424 | the webhook URL did not answer its challenge |
| `too-many-pending` | 429, with `ratelimit-limit` and `ratelimit-remaining` set | the caller is over its share of the instance's `MAX_PENDING` |

Every other failure carries `about:blank` as its type:

| Status | When |
|---|---|
| 401 | the bearer token does not match |
| 404 | the id is unknown here, or belongs to another caller key, so the answer never confirms an id exists. `payment` returns `null` instead of throwing. `GET /incoming-payments` also answers 404 on an instance with no `GATEWAY_TOKEN` |
| 410 | an `Idempotency-Key` was replayed after its payment was pruned |
| 500 | the gateway failed unexpectedly |
| 503 | the gateway is already asking that host as often as it allows, with `retry-after: 5`. `/ready` also answers 503 while the instance drains or catches up with its peers, and `/health` while its watch loop is stalled |

## Failures the client finds itself

`GatewayCheatError` means the gateway demonstrably misbehaved, and `code` names the
check that caught it. `UnverifiedRecipientError` means a check could not run: the
recipient's server was down, timed out or answered something unreadable, or CORS
blocked the browser. It proves neither cheating nor honesty, so decide explicitly
what to do with an unproven invoice.

```ts
import {
  GatewayCheatError,
  msat,
  NoWalletAvailableError,
  ProblemError,
  ThunderBridge,
  UnverifiedRecipientError,
} from "thunder-bridge";

declare const gateway: ThunderBridge;
declare function report(line: string): void;

try {
  await gateway.mint({ paidTo: "iamfatik@blink.sv", amount: msat(21_000) });
} catch (error) {
  if (error instanceof GatewayCheatError) {
    report(`the gateway cheated: ${error.code} on payment ${error.paymentId}`);
  } else if (error instanceof UnverifiedRecipientError) {
    report(`could not reach ${error.lnAddress} to check the invoice`);
  } else if (error instanceof NoWalletAvailableError) {
    for (const wallet of error.wallets) {
      report(`${wallet.address}: ${wallet.reason}`);
    }
  } else if (error instanceof ProblemError) {
    report(`${error.status} ${error.title}`);
  } else {
    throw error;
  }
}
```

## Amounts

A fiat price is converted when the invoice is minted, at the median of four MiCA
authorised venues unless you pass your own rate. A decimal string is read digit by
digit, never through a float. Every refusal is an `AmountError` carrying a `code`.
Recognise one with `AmountError.is(error)`. Each entry point bundles its own copy of
the class, so `instanceof` holds only within one import, and `AmountError.is` holds
across all of them.
