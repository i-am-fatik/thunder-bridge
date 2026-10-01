# Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository: **Security → Report a
vulnerability**. Only the maintainers can read that channel. Do not open a public issue
for anything that lets someone take money, forge a settlement, or read somebody else's
order book.

There is no bounty. You get an answer, credit in the release notes if you want it, and
the fix shipped as fast as one person can ship it.

## What is in scope

The gateway in this repository and the `thunder-bridge` npm package. Report a way to:

- make `paid` mean something it should not
- read a payment without its id
- reach an address the outbound guard refuses
- get a preimage out of an instance that never saw one

[Who you still have to trust](docs/proving-a-payment.md#who-you-still-have-to-trust)
lists what is not promised. A report that one of those does not hold is a
documentation question, not a vulnerability.

## What is not in scope

`public.thunder-bridge.agora.gripe` runs with no `GATEWAY_TOKEN`, so it answers anyone,
and its ledger is ephemeral. That it can be flooded, filled or wiped is the arrangement,
not a finding, and so is its rate limit refusing you.

No live host is a test target, that one included. A finding about the code stands
without a demonstration against a live gateway. Run your own, which takes one command.

Anything about the BTCPay plugin belongs in its own repository, and its README says which
gateway it was written against.
