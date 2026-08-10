# Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository: **Security → Report a
vulnerability**. It opens a channel only the maintainers can read, which a public issue
does not, and this is a payment gateway, so please do not open a public issue for
anything that lets someone take money, forge a settlement, or read somebody else's
order book.

There is no bounty. You get an answer, credit in the release notes if you want it, and
the fix shipped as fast as one person can ship it.

## What is in scope

The gateway in this repository and the `thunder-bridge` npm package. Concretely, the
things worth reporting are a way to make `paid` mean something it should not, to read a
payment without its id, to reach an address the outbound guard is supposed to refuse, or
to get a preimage out of an instance that never saw one.

Read [what is still trusted](sdk/README.md#what-is-still-trusted) first. Several
properties are deliberately not promised, and a report that one of them does not hold is
a documentation question rather than a vulnerability.

## What is not in scope

The live instance at `thunder-bridge-production.up.railway.app` is a demo. It runs with
no `GATEWAY_TOKEN`, keeps no durability promise, and has no rate limit in front of it, all
of which is written down in the README. That it can be flooded, filled, or wiped is the
arrangement rather than a finding. Please do not test availability against it: run your own
instance, which takes one command.

Anything about the BTCPay plugin belongs in its own repository, and its README says which
gateway it was written against.
