# The whole surface

Generated from the TSDoc on each export by [`tools/api-reference.ts`](../tools/api-reference.ts).
Nothing here is written by hand, so nothing here can be out of date. Run
`node tools/api-reference.ts` after changing an export, and CI refuses a diff.

## `thunder-bridge`

| Export | Kind | What it is |
|---|---|---|
| [`Amount`](#thunder-bridge-amount) | type | What a payment is worth |
| [`AmountError`](#thunder-bridge-amounterror) | class | Thrown when a price cannot be held exactly |
| [`AmountFault`](#thunder-bridge-amountfault) | type | Why an amount was refused |
| [`answerVerifyChallenge`](#thunder-bridge-answerverifychallenge) | function | Answer the challenge the gateway sends a verify URL before it will poll it, which is how a caller shows the endpoint agreed to the traffic rather than merely being named |
| [`BankRailConfig`](#thunder-bridge-bankrailconfig) | interface | A bank rail: the account the money lands in, and where its arrival is read back from |
| [`BankVerifyConfig`](#thunder-bridge-bankverifyconfig) | interface | The endpoint the gateway polls for a bank transfer, answering off your own statement |
| [`BlindLightningRailConfig`](#thunder-bridge-blindlightningrailconfig) | interface | The same rail with the invoice resolved here, so the gateway is told neither address nor amount |
| [`carriesProof`](#thunder-bridge-carriesproof) | function | Whether a report proves what it claims: it says paid, and it carries a preimage that hashes to the payment hash it itself names |
| [`Charge`](#thunder-bridge-charge) | interface | Who is paid and how much |
| [`CreateOptions`](#thunder-bridge-createoptions) | interface | What a mint carries beyond the charge: a retry key, and which trigger it joins |
| [`decodeInvoice`](#thunder-bridge-decodeinvoice) | function | Read a BOLT11 invoice without trusting anyone for its contents, an undecodable string or a BOLT12 offer yields an invoice with every field null |
| [`fiat`](#thunder-bridge-fiat) | function | A price named in fiat, converted when the invoice is minted rather than now |
| [`FiatOptions`](#thunder-bridge-fiatoptions) | interface | How a fiat price is turned into millisatoshi at the moment of minting |
| [`FollowOptions`](#thunder-bridge-followoptions) | interface | What to do with a trigger's settlements, and how hard to try to keep hearing them |
| [`GatewayCheatCode`](#thunder-bridge-gatewaycheatcode) | type | The way a gateway was caught out, every code is a check that held against the recipient's own server and failed against what the gateway returned |
| [`GatewayCheatError`](#thunder-bridge-gatewaycheaterror) | class | Thrown when the gateway demonstrably misbehaved, the invoice it returned is not the one the address you asked for issued, or a settlement it reported carries a preimage that does not hash to the payment hash |
| [`Gateways`](#thunder-bridge-gateways) | class | The same payment watched at several gateways at once, which is what makes any one of them replaceable |
| [`GatewaysOptions`](#thunder-bridge-gatewaysoptions) | interface | The client's own options, plus what to do about a gateway that will not take the watch |
| [`Handler`](#thunder-bridge-handler) | type | A Fetch handler, which is what every runtime this targets mounts |
| [`Handover`](#thunder-bridge-handover) | interface | An invoice you obtained yourself, handed over to be watched |
| [`IdempotencyConflict`](#thunder-bridge-idempotencyconflict) | type | Why an `Idempotency-Key` was refused, `request-in-flight` is the benign one and `key-reused` means the same key was sent for a different request |
| [`IdempotencyConflictError`](#thunder-bridge-idempotencyconflicterror) | class | Thrown when an `Idempotency-Key` is held by another request |
| [`Invoice`](#thunder-bridge-invoice) | interface | What a BOLT11 invoice says about itself, every field null when it does not carry one |
| [`invoiceFrom`](#thunder-bridge-invoicefrom) | function | A provable invoice from the first address on the list that will issue one, which is what a client mints for itself rather than asking a gateway to |
| [`Leg`](#thunder-bridge-leg) | interface | One way to pay one order, already registered with the gateway |
| [`LightningRailConfig`](#thunder-bridge-lightningrailconfig) | interface | A Lightning rail the gateway mints for, bound once and then given one order at a time |
| [`LightningVerifyConfig`](#thunder-bridge-lightningverifyconfig) | interface | The verify endpoint that asks the wallet for the gateway, and how often it may be asked |
| [`Minted`](#thunder-bridge-minted) | interface | What a blind mint produced, which is what the sealed payload is built from |
| [`MintedPayment`](#thunder-bridge-mintedpayment) | interface | A payment the gateway minted |
| [`msat`](#thunder-bridge-msat) | function | An exact number of millisatoshi, for a price already in the smallest unit |
| [`Msat`](#thunder-bridge-msat) | type | A whole number of millisatoshi that came from `sats`, `msat` or `fiat`, and could not have come from anywhere else |
| [`NoWalletAvailableError`](#thunder-bridge-nowalletavailableerror) | class | Thrown when no wallet on your list could issue a provable invoice, `wallets` says why each refused |
| [`Order`](#thunder-bridge-order) | interface | What a shop knows about a sale before any rail exists |
| [`Payment`](#thunder-bridge-payment) | type | A payment as the gateway reports it, of either sort |
| [`PaymentRequest`](#thunder-bridge-paymentrequest) | interface | One payment asked for: the invoice to show, the QR to draw it with, and one way to find out it was paid |
| [`PaymentRequestInit`](#thunder-bridge-paymentrequestinit) | interface | What to ask for: who is paid, how much, and how the QR should look |
| [`PaymentRequestOptions`](#thunder-bridge-paymentrequestoptions) | interface | What `requestPayment` takes beyond the charge itself |
| [`PaymentStatus`](#thunder-bridge-paymentstatus) | type | Where a payment stands, `paid` is the only status that carries a preimage |
| [`preimageMatchesHash`](#thunder-bridge-preimagematcheshash) | function | True when `preimage` is the secret behind `paymentHash` |
| [`Priced`](#thunder-bridge-priced) | interface | A charge with its price settled, which is what a proof compares the gateway's answer against |
| [`ProblemError`](#thunder-bridge-problemerror) | class | An RFC 9457 problem document the gateway answered with |
| [`Provable`](#thunder-bridge-provable) | interface | The least a report has to carry for its own proof to be checkable |
| [`Proven`](#thunder-bridge-proven) | type | A report `carriesProof` has already accepted, so the preimage is there and the status is settled |
| [`proveOrigin`](#thunder-bridge-proveorigin) | function | Prove the invoice really is the one the recipient issued for what you asked, before the payer ever sees it, both fetches go straight to the recipient's own server and none of them goes back to the gateway |
| [`proveSettlement`](#thunder-bridge-provesettlement) | function | Prove the money arrived by asking the recipient's own server, not the gateway, returns the preimage when the recipient says it settled and null when it says it has not, and runs the full origin proof first because a verify url the gateway made up would otherwise answer for itself |
| [`proveWrapped`](#thunder-bridge-provewrapped) | function | Prove a wrapping operator's invoice is the recipient's own payment in disguise, so paying it can only settle by the operator paying the recipient |
| [`Quote`](#thunder-bridge-quote) | interface | Which address would serve an amount, and what the ones ahead of it refused |
| [`Rail`](#thunder-bridge-rail) | type | A payment method |
| [`RailConfig`](#thunder-bridge-railconfig) | interface | What every rail takes, whatever it moves |
| [`Rails`](#thunder-bridge-rails) | class | One call per sale, whatever the rail moves |
| [`Range`](#thunder-bridge-range) | interface | What a payer may choose to send, when the endpoint lets them choose at all |
| [`Relayed`](#thunder-bridge-relayed) | interface | The wallet's own LUD-21 URL and the hash its preimage has to match |
| [`relayedVerifyUrl`](#thunder-bridge-relayedverifyurl) | function | The URL to hand the gateway instead of the wallet's own, with the wallet's sealed inside it |
| [`Resolved`](#thunder-bridge-resolved) | type | An invoice a lightning address issued, with everything needed to watch and to prove it |
| [`sats`](#thunder-bridge-sats) | function | A whole number of satoshi, so `sats(21)` is 21000 millisatoshi |
| [`seal`](#thunder-bridge-seal) | function | Encrypt what the watcher needs and the gateway must not have |
| [`Serve`](#thunder-bridge-serve) | class | Everything one gateway lets you mount, in one place so a caller never has to know which handler needs the gateway and which does not |
| [`Settlement`](#thunder-bridge-settlement) | interface | What a delivery carries |
| [`SocketTicket`](#thunder-bridge-socketticket) | interface | A one minute pass onto one trigger's stream |
| [`ThunderBridge`](#thunder-bridge-thunderbridge) | class | Talks to a Thunder Bridge gateway and trusts it for nothing it can check itself |
| [`ThunderBridgeOptions`](#thunder-bridge-thunderbridgeoptions) | interface | How this instance talks to one gateway, and how much of what it says to check |
| [`TicketOptions`](#thunder-bridge-ticketoptions) | interface | What a socket ticket opens beyond the trigger it names |
| [`TriggerConfig`](#thunder-bridge-triggerconfig) | interface | An LNURL-pay endpoint of your own: whose wallets it stands for, and what it charges |
| [`unseal`](#thunder-bridge-unseal) | function | Read a sealed blob back, null when it was sealed with another secret, edited on the way, or is not one of ours |
| [`UnverifiedRecipientError`](#thunder-bridge-unverifiedrecipienterror) | class | Thrown when the recipient's own server could not be reached to check the invoice against, a CORS-blocked browser or a provider that is down, this is not proof the gateway cheated and it is not proof it did not |
| [`WaitOptions`](#thunder-bridge-waitoptions) | interface | How long to wait on a payment, and what the socket URL is allowed to carry |
| [`WalletFailure`](#thunder-bridge-walletfailure) | interface | One wallet on the list that could not be used, and the reason it could not |
| [`WalletReason`](#thunder-bridge-walletreason) | type | Why one wallet in the list could not be used |
| [`WatchedPayment`](#thunder-bridge-watchedpayment) | interface | A payment the gateway was handed rather than asked to mint |
| [`WatchTicketConfig`](#thunder-bridge-watchticketconfig) | interface | A trigger's live stream is opened with a ticket rather than with the watch secret, so something has to hold the secret and trade it for tickets |
| [`WebhookCredential`](#thunder-bridge-webhookcredential) | type | What checks a delivery: the hex the gateway publishes at `/webhook-key` |
| [`WebhookHandlers`](#thunder-bridge-webhookhandlers) | interface | What to do with what the gateway delivers, and what to believe it with |
| [`WebhookOptions`](#thunder-bridge-webhookoptions) | type | How far the gateway's clock may drift from yours before a webhook is refused |
| [`WrapAllowance`](#thunder-bridge-wrapallowance) | interface | What a wrapping operator may charge over the recipient's own amount |
| [`wrapFeeCeiling`](#thunder-bridge-wrapfeeceiling) | function | The most an operator may add over the recipient's own amount, in millisatoshi |
| [`WrapRefusalCode`](#thunder-bridge-wraprefusalcode) | type | The way a wrapping operator was caught out |
| [`WrapRefusedError`](#thunder-bridge-wraprefusederror) | class | Thrown when a wrapped invoice does not bind to the recipient's |

### Amount

```ts
type Amount = Msat | (() => Msat | Promise<Msat>);
```

What a payment is worth. A `Msat` is a price known now, and a function is one
worked out when the invoice is minted, which is what a fiat price has to be.

Build one with `sats`, `msat` or `fiat`

### AmountError

```ts
class AmountError extends Error
```

Thrown when a price cannot be held exactly. Every constructor of an amount
throws this rather than returning something approximate, because a payment
library that rounds silently moves the wrong money

| Member | What it does |
|---|---|
| `static is(failure: unknown): failure is AmountError` | Whether a failure is one of these, without asking whether it is this exact class |
| `readonly code: AmountFault;` |  |

### AmountFault

```ts
type AmountFault =
  | "not-whole-satoshi"
  | "not-whole-millisatoshi"
  | "not-a-decimal"
  | "too-precise"
  | "unknown-currency";
```

Why an amount was refused. A code rather than a message, because a caller can
only recover from a failure it can name and a message is free to be reworded

### answerVerifyChallenge

```ts
async function answerVerifyChallenge(request: Request): Promise<Response | null>
```

Answer the challenge the gateway sends a verify URL before it will poll it,
which is how a caller shows the endpoint agreed to the traffic rather than
merely being named. Returns null for anything that is not a challenge, so a
verify endpoint hands the request on to its own reading of a payment.

The nonce is echoed to whoever asked, which grants them nothing, so there is
no signature to check here and no secret to hold

### BankRailConfig

```ts
interface BankRailConfig extends RailConfig {
  /** Long lived and server side. Every preimage is derived from it, so losing it loses every proof */
  secret: string;

  /** The account the money goes to, as an IBAN */
  iban: string;

  /** Where `serve.bankVerify` is mounted, a public https URL with no query of its own */
  verifyUrl: string;

  /** When this leg stops being payable, in unix seconds */
  expiresAt: (order: Order) => number;

  /** Sealed before the gateway sees it, the way the blind Lightning rail does */
  sealed?: (order: Order) => string | Promise<string>;

  /** The Czech variable symbol, taken off the reference's digits by default */
  variableSymbol?: (order: Order) => string | undefined;

  /**
   * Register on a gateway you do not own anyway. The verify URL names the amount
   * and the reference, so its operator could read your order book off the watches
   */
  allowPublicGateway?: boolean;
}
```

A bank rail: the account the money lands in, and where its arrival is read back from

### BankVerifyConfig

```ts
interface BankVerifyConfig {
  /** The same secret `bankTransfer` was given */
  secret: string;

  /** The account to read */
  statement: Statement;

  /** How far back a credit still counts, seven days by default */
  lookBackSecs?: number;

  /**
   * How often you want the gateway to ask, in seconds. It goes out as
   * `Cache-Control: max-age`, so the pace is yours to set rather than the
   * gateway's, and a bank that updates once a minute should say so instead of
   * being polled every few seconds. Thirty by default, clamped to an hour
   */
  pollEverySecs?: number;
}
```

The endpoint the gateway polls for a bank transfer, answering off your own statement

### BlindLightningRailConfig

```ts
interface BlindLightningRailConfig extends LightningRailConfig {
  /**
   * What the watcher needs and the gateway must not read, sealed with `seal`
   * before it goes anywhere near the gateway
   */
  sealed?: (order: Order) => string | Promise<string>;

  /**
   * Where your own `serve.verify` endpoint is mounted, and its secret. Without
   * it the gateway is handed the wallet's own URL, which a gateway enforcing its
   * verify challenge will refuse to poll
   */
  relayThrough?: { endpoint: string; secret: string };
}
```

The same rail with the invoice resolved here, so the gateway is told neither address nor amount

### carriesProof

```ts
function carriesProof<T extends Provable>(report: T): report is Proven<T>
```

Whether a report proves what it claims: it says paid, and it carries a preimage
that hashes to the payment hash it itself names. Where an invoice comes with it,
the invoice's own hash has to agree too.

A payment, a settlement delivered to a webhook and a frame off a trigger all
answer this, because all three carry those fields and no other question about
one matters.

It asks nobody anything, so it costs no round trip and is not a proof of
arrival. Only `proveSettlement` asks the recipient

### Charge

```ts
interface Charge {
  paidTo: string | string[];
  amount: Amount;

  /** Where the gateway posts the settlement, signed with the key it publishes */
  webhookUrl?: string;
}
```

Who is paid and how much. `to` is a priority list when it is an array: the
gateway takes the first address that can issue a provable invoice for the
amount and the rest are the fallback

### CreateOptions

```ts
interface CreateOptions {
  /**
   * Makes the POST safe to retry. A repeat of a finished request replays its
   * payment instead of asking a wallet for a second invoice, a repeat that
   * arrives while the first is still resolving throws
   * `IdempotencyConflictError`, and the key is held for 24 hours
   */
  idempotencyKey?: string;

  /**
   * Groups this payment with every other one carrying the same secret, so
   * `follow` can watch the place rather than the payment. Registering
   * sends only its sha256, which is also all the gateway stores, so a stolen
   * ledger cannot subscribe. Following sends the secret itself, because the
   * gateway hashes what it is given to find the stream, so the operator of a
   * gateway you do not own learns it the first time you connect. Keep it apart
   * from any URL a payer sees
   */
  trigger?: string;

  /**
   * How many of the trigger's settlements the gateway keeps replayable past the
   * hour it would otherwise forget them in, up to the ceiling its operator set.
   * Needs `trigger`, defaults to none
   */
  replay?: number;
}
```

What a mint carries beyond the charge: a retry key, and which trigger it joins

### decodeInvoice

```ts
function decodeInvoice(bolt11: string): Invoice
```

Read a BOLT11 invoice without trusting anyone for its contents, an
undecodable string or a BOLT12 offer yields an invoice with every field null

### fiat

```ts
function fiat(
  major: number | string,
  currency: string,
  options?: FiatOptions,
): () => Promise<Msat>
```

A price named in fiat, converted when the invoice is minted rather than now.

Name it as a string and it is read digit by digit, exactly. Name it as a
number and it is rounded to the currency's ISO 4217 minor unit, because
binary floating point cannot hold 4.99 and a payment library that pretends
otherwise moves the wrong amount.

Every conversion asks the rate afresh, so two calls a second apart can
differ. That is the honest behaviour for a fiat price, and the reason an
amount is a function rather than a number

### FiatOptions

```ts
interface FiatOptions {
  /**
   * Where the rate comes from, the median of the four MiCA authorised venues by
   * default. Pass your own to price off one venue, off your own book, or off a
   * number you already hold
   */
  rate?: Ticker;

  /**
   * What you add over the rate, in basis points, none by default. A Lightning
   * invoice lives an hour and a bank transfer takes days, so a shop pricing in
   * fiat carries that volatility whether or not it charges for it
   */
  spreadBps?: number;
}
```

How a fiat price is turned into millisatoshi at the moment of minting

### FollowOptions

```ts
interface FollowOptions {
  /** Called for the recent settlements replayed on connect, then for each new one */
  onPayment: (settled: Payment) => void;

  /**
   * How many settlements to ask for on connect, defaults to the gateway's ten.
   * It hands back what it still holds, which is the last hour unless the
   * payments were minted with `replay`
   */
  replay?: number;

  /** Called when a connection drops or a frame is refused, the follow keeps going */
  onError?: (error: unknown) => void;

  /** Reconnect after a drop, defaults to true */
  reconnect?: boolean;

  /**
   * The first wait after a drop, doubling up to 30 seconds and jittered so a
   * fleet does not come back in lockstep, defaults to 3000. A connection that
   * opens puts it back to the first wait
   */
  reconnectDelayMs?: number;

  /**
   * Mint a short-lived ticket and put that in the socket URL instead of the
   * secret, one per connection. Keeps the secret out of access logs, at the cost
   * of a POST before each connect. Implied by `token`. Leave it off for a
   * microcontroller, where one hardcoded URL and a dumb reconnect loop is the
   * whole point
   */
  tickets?: boolean;
}
```

What to do with a trigger's settlements, and how hard to try to keep hearing them

### GatewayCheatCode

```ts
type GatewayCheatCode =
  | "address_not_requested"
  | "hash_mismatch"
  | "amount_mismatch"
  | "description_hash_mismatch"
  | "verify_url_foreign"
  | "invoice_not_issued"
  | "preimage_mismatch"
  | "id_not_mine";
```

The way a gateway was caught out, every code is a check that held against the
recipient's own server and failed against what the gateway returned

### GatewayCheatError

```ts
class GatewayCheatError extends Error
```

Thrown when the gateway demonstrably misbehaved, the invoice it returned is
not the one the address you asked for issued, or a settlement it reported
carries a preimage that does not hash to the payment hash

| Member | What it does |
|---|---|
| `readonly code: GatewayCheatCode;` |  |
| `readonly paymentId: string;` |  |

### Gateways

```ts
class Gateways
```

The same payment watched at several gateways at once, which is what makes any
one of them replaceable. They all answer with the same name for it, because a
payment is named after the caller and not after any gateway, so the first
delivery to arrive is the answer and the rest are the same news twice.

For watching only. Two gateways asked to mint would fetch two different invoices
from the wallet and only one of them could ever be paid

| Member | What it does |
|---|---|
| `readonly each: readonly ThunderBridge[];` |  |
| `async nameFor(paymentHash: string): Promise<string \| null>` | What this payment is called, which every gateway here will agree on |
| `async watch(handover: Handover): Promise<Payment>` | Hand the same invoice to every gateway |
| `async settled(id: string, options?: WaitOptions): Promise<Payment>` | Wait for whichever gateway speaks first |

### GatewaysOptions

```ts
interface GatewaysOptions extends ThunderBridgeOptions {
  /**
   * Called for each gateway that would not take the watch, with the url and what
   * it said. Registering at three and having one refuse still leaves you watched,
   * so this is how you find out you are less covered than you asked to be, rather
   * than finding out when the one that took it goes away
   */
  onRefused?: (baseUrl: string, refusal: unknown) => void;
}
```

The client's own options, plus what to do about a gateway that will not take the watch

### Handler

```ts
type Handler = (request: Request) => Promise<Response>;
```

A Fetch handler, which is what every runtime this targets mounts

### Handover

```ts
interface Handover {
  paymentHash: string;
  verifyUrl: string;
  expiresAt: number;

  /** Groups this payment with every other one carrying the same secret */
  trigger?: string;

  /**
   * How many of this trigger's settlements the gateway keeps replayable past the
   * hour it would otherwise forget them in, up to the ceiling its operator set.
   * Needs `trigger`, defaults to none
   */
  replay?: number;

  /** Sealed with `seal`, so the gateway stores what it cannot read */
  sealed?: string;

  webhookUrl?: string;
}
```

An invoice you obtained yourself, handed over to be watched. The gateway is
given no address and no amount, so it cannot refuse one recipient rather than
all of them

### IdempotencyConflict

```ts
type IdempotencyConflict = "request-in-flight" | "key-reused";
```

Why an `Idempotency-Key` was refused, `request-in-flight` is the benign one and
`key-reused` means the same key was sent for a different request

### IdempotencyConflictError

```ts
class IdempotencyConflictError extends ProblemError
```

Thrown when an `Idempotency-Key` is held by another request. On
`request-in-flight` the first attempt is still resolving, so wait and read the
payment back rather than retrying. `key-reused` is a bug in the caller: the key
is bound to the addresses, amount and webhook that claimed it

| Member | What it does |
|---|---|
| `readonly conflict: IdempotencyConflict;` |  |

### Invoice

```ts
interface Invoice {
	paymentHash: string | null;
	descriptionHash: string | null;
	amountMsat: number | null;
	expiresAt: number | null;
}
```

What a BOLT11 invoice says about itself, every field null when it does not carry one

### invoiceFrom

```ts
async function invoiceFrom(paidTo: string | string[], amount: Amount): Promise<Resolved>
```

A provable invoice from the first address on the list that will issue one, which
is what a client mints for itself rather than asking a gateway to. Everything the
gateway needs to watch it comes back with everything you need to prove it came
from the address you asked for, so you can hand over the first and keep the second.

Server side: it resolves hostnames and refuses a private one, which no browser can
do. Throws `NoWalletAvailableError` when no address on the list would serve

### Leg

```ts
interface Leg {
  /** The watched payment's id, which is what `firstSettled`, `payment` and `settled` take */
  id: string;

  /** Which rail made it, so a shop can label a leg without knowing how it was built */
  rail: string;

  /** What the payer reads, a BOLT11 invoice or a Short Payment Descriptor */
  scan: string;

  /** The same thing as a QR has to encode it, which is not always `scan` itself */
  qr: string;

  expiresAt: number;
}
```

One way to pay one order, already registered with the gateway

### LightningRailConfig

```ts
interface LightningRailConfig extends RailConfig {
  /** Priority list, the first address that can prove an invoice wins */
  paidTo: string | string[];

  /**
   * What to charge for one order, the order's own price converted at `rate` by
   * default. Give it a function and the price is whatever you say
   */
  amount?: (order: Order) => Amount;

  /** Where the default conversion gets its rate, the median of four venues by default */
  rate?: Ticker;

  /** Makes the mint safe to retry, the order's reference by default */
  idempotencyKey?: (order: Order) => string | undefined;
}
```

A Lightning rail the gateway mints for, bound once and then given one order at a time

### LightningVerifyConfig

```ts
interface LightningVerifyConfig {
  /** The secret the sealed wallet URL was made with, and nothing else uses it */
  secret: string;

  /**
   * How often you want the gateway to ask, in seconds. It goes out as
   * `Cache-Control: max-age`, so the pace is yours rather than the operator's.
   * Five by default, which is what a Lightning checkout wants
   */
  pollEverySecs?: number;
}
```

The verify endpoint that asks the wallet for the gateway, and how often it may be asked

### Minted

```ts
interface Minted {
  lnAddress: string;
  amountMsat: number;
  bolt11: string;
  paymentHash: string;
  verifyUrl: string;
  expiresAt: number;
}
```

What a blind mint produced, which is what the sealed payload is built from

### MintedPayment

```ts
interface MintedPayment {
	kind: "minted";
	lnAddress: string;
	amountMsat: number;
	bolt11: string;
	id: string;
	status: PaymentStatus;
	paymentHash: string;
	verifyUrl: string;
	preimage: string | null;
	expiresAt: number;
	createdAt: number;
	sealed: string | null;
}
```

A payment the gateway minted. It resolved the address itself, so it knows who
is paid, how much, and which invoice says so, and none of the three can be
null here

### msat

```ts
function msat(exact: number): Msat
```

An exact number of millisatoshi, for a price already in the smallest unit

### Msat

```ts
type Msat = number & { readonly [brand]: "Msat" };
```

A whole number of millisatoshi that came from `sats`, `msat` or `fiat`, and
could not have come from anywhere else.

The brand is why: a bare number is not one of these, so `21` cannot be passed
where a price is wanted and quietly mean twenty-one thousandths of a satoshi.
It costs nothing at runtime, where the value is an ordinary number

### NoWalletAvailableError

```ts
class NoWalletAvailableError extends ProblemError
```

Thrown when no wallet on your list could issue a provable invoice, `wallets` says why each refused

| Member | What it does |
|---|---|
| `readonly wallets: WalletFailure[];` |  |

### Order

```ts
interface Order {
  /** The bank matches it on the statement, and Lightning keys idempotency on it */
  reference: string;

  /** The price in the smallest unit of `currency`, so 48055 is 480.55 CZK */
  amountMinor: number;

  /** ISO 4217. The bank rail moves this, Lightning converts it at `rate` */
  currency: string;
}
```

What a shop knows about a sale before any rail exists

### Payment

```ts
type Payment = MintedPayment | WatchedPayment;
```

A payment as the gateway reports it, of either sort. Check `kind` and the
three fields a watched payment does not carry stop being null, so nothing here
needs an assertion to read

### PaymentRequest

```ts
interface PaymentRequest {
  /** What the gateway calls this payment, which is what `payment` and `settled` take */
  readonly id: string;

  readonly bolt11: string;
  readonly paymentHash: string;
  readonly lnAddress: string;
  readonly amountMsat: number;

  /** When the invoice stops being payable, in unix seconds */
  readonly expiresAt: number;

  /** The invoice as an SVG QR, ready to put in an element's `innerHTML` */
  readonly qr: string;

  /** The payment as the gateway first reported it, for anything the fields above leave out */
  readonly payment: MintedPayment;

  /**
   * Resolves once the money has arrived, and rejects when the invoice expires
   * unpaid or the wait is aborted. It follows a WebSocket and reconnects through
   * a drop, so this is one await rather than a poll.
   *
   * `gateway.settled(id)` is the wider question and ends on an expiry too. This
   * one is about the payment that was asked for, and one that expired was never paid
   */
  paid(options?: WaitOptions): Promise<MintedPayment>;

  /**
   * The same wait as a callback, for a page that has something else to do.
   * Returns a function that stops waiting
   */
  onPaid(arrived: (payment: MintedPayment) => void, failed?: (reason: unknown) => void): () => void;

  /**
   * Ask the recipient's own server whether it settled, and get the preimage it
   * released or null. This is the only answer that comes from somewhere other
   * than the gateway, so it is the one to ask when a payment matters
   */
  prove(): Promise<string | null>;
}
```

One payment asked for: the invoice to show, the QR to draw it with, and one
way to find out it was paid. Everything on it is already proved against the
recipient's own server, so nothing here is the gateway's word

### PaymentRequestInit

```ts
interface PaymentRequestInit extends Charge, PaymentRequestOptions {}
```

What to ask for: who is paid, how much, and how the QR should look. Every
field beyond `paidTo` and `amount` has a default, so the shortest request
names two

### PaymentRequestOptions

```ts
interface PaymentRequestOptions extends WaitOptions {
  /** Makes the mint safe to retry, so a reloaded checkout replays one invoice */
  idempotencyKey?: string;

  /** Groups this request with every other one carrying the same secret, for `follow` */
  trigger?: string;

  /** How many of that trigger's settlements the gateway keeps replayable past the hour */
  replay?: number;

  /** Size and colour of `qr`, 256 pixels and black by default */
  qr?: QrOptions;
}
```

What `requestPayment` takes beyond the charge itself

### PaymentStatus

```ts
type PaymentStatus = "pending" | "paid" | "expired";
```

Where a payment stands, `paid` is the only status that carries a preimage

### preimageMatchesHash

```ts
function preimageMatchesHash(preimage: string, paymentHash: string): boolean
```

True when `preimage` is the secret behind `paymentHash`

### Priced

```ts
interface Priced {
  paidTo: string[];
  amountMsat: number;
}
```

A charge with its price settled, which is what a proof compares the gateway's
answer against. Asking a fiat price twice gives two numbers, so the proof is
handed the one that was actually asked for

### ProblemError

```ts
class ProblemError extends Error
```

An RFC 9457 problem document the gateway answered with

| Member | What it does |
|---|---|
| `static readonly NO_WALLET_AVAILABLE = "urn:problem-type:thunder-bridge:no-wallet-available";` |  |
| `static readonly REQUEST_IN_FLIGHT = "urn:problem-type:thunder-bridge:request-in-flight";` |  |
| `static readonly IDEMPOTENCY_KEY_REUSED = "urn:problem-type:thunder-bridge:idempotency-key-reused";` |  |
| `static readonly PAYMENT_ALREADY_WATCHED = "urn:problem-type:thunder-bridge:payment-already-watched";` |  |
| `static readonly INVALID_REQUEST = "urn:problem-type:thunder-bridge:invalid-request";` |  |
| `static readonly CALLER_UNKNOWN = "urn:problem-type:thunder-bridge:caller-unknown";` |  |
| `static readonly VERIFY_HOST_REFUSED = "urn:problem-type:thunder-bridge:verify-host-refused";` |  |
| `static readonly VERIFY_UNCONFIRMED = "urn:problem-type:thunder-bridge:verify-unconfirmed";` |  |
| `static readonly VERIFY_UNCONSENTED = "urn:problem-type:thunder-bridge:verify-unconsented";` |  |
| `static readonly WEBHOOK_UNCONFIRMED = "urn:problem-type:thunder-bridge:webhook-unconfirmed";` |  |
| `static readonly TOO_MANY_PENDING = "urn:problem-type:thunder-bridge:too-many-pending";` |  |
| `static is(problem: { type?: string }, type: string): boolean` | Whether a problem carries this type |
| `readonly type: string;` |  |
| `readonly title: string;` |  |
| `readonly status: number;` |  |
| `readonly detail: string \| null;` |  |

### Provable

```ts
interface Provable {
  status: PaymentStatus;
  preimage: string | null;
  paymentHash: string;
  bolt11?: string | null;
}
```

The least a report has to carry for its own proof to be checkable

### Proven

```ts
type Proven<T extends Provable> = T & { status: "paid"; preimage: string };
```

A report `carriesProof` has already accepted, so the preimage is there and the
status is settled. Nothing downstream of the check needs a null guard

### proveOrigin

```ts
async function proveOrigin(payment: MintedPayment, asked: Priced): Promise<void>
```

Prove the invoice really is the one the recipient issued for what you asked,
before the payer ever sees it, both fetches go straight to the recipient's own
server and none of them goes back to the gateway

Throws `GatewayCheatError` when a check fails and `UnverifiedRecipientError`
when the recipient could not be reached to run one

### proveSettlement

```ts
async function proveSettlement(
  payment: MintedPayment,
  asked: Priced,
): Promise<string | null>
```

Prove the money arrived by asking the recipient's own server, not the gateway,
returns the preimage when the recipient says it settled and null when it says
it has not, and runs the full origin proof first because a verify url the
gateway made up would otherwise answer for itself

### proveWrapped

```ts
function proveWrapped(wrapped: string, recipient: string, allowance?: WrapAllowance): void
```

Prove a wrapping operator's invoice is the recipient's own payment in
disguise, so paying it can only settle by the operator paying the recipient.

It compares two invoices and asks nobody anything, so it runs in a browser and
costs no round trip. Prove the recipient's own invoice with `proveOrigin`
first, because this says nothing about where that one came from.

There is no settlement check here and there does not need to be. Both invoices
carry one payment hash, so the preimage that settles the wrap is the preimage
the recipient released, and `proveSettlement` already reads it from the
recipient's own server.

Throws `WrapRefusedError` naming which binding failed

### Quote

```ts
interface Quote {
  lnAddress: string;
  amountMsat: number;
  feeMsat: number;
  minMsat: number;
  maxMsat: number;
  metadata: string;
  refusals: WalletFailure[];
}
```

Which address would serve an amount, and what the ones ahead of it refused.
`feeMsat` is always zero, the payer pays the recipient's own invoice and the
gateway is never in the money's path

### Rail

```ts
type Rail = (order: Order) => Promise<Leg>;
```

A payment method. Everything that differs between rails is bound once when the
rail is built, so the only thing passed per sale is which sale it is

### RailConfig

```ts
interface RailConfig {
  /** Groups every payment from this rail so `follow` can watch the shop */
  trigger?: string;

  /** How many of that trigger's settlements the gateway keeps replayable past the hour */
  replay?: number;

  /** Where the gateway posts once the money lands, a public https URL */
  webhookUrl?: string;

  /** What `Leg.rail` says, so two rails of one kind can be told apart */
  name?: string;
}
```

What every rail takes, whatever it moves

### Rails

```ts
class Rails
```

One call per sale, whatever the rail moves. Each of these was a free function
taking the gateway as a config field, and reaching them through the gateway is
what deleted that field

| Member | What it does |
|---|---|
| `lightning(config: LightningRailConfig): Rail` | Lightning, with the gateway minting against a priority list of addresses |
| `blindLightning(config: BlindLightningRailConfig): Rail` | Lightning, with the invoice resolved here so the gateway is told neither the address nor the amount |
| `bank(config: BankRailConfig): Rail` | A bank transfer, proved the way a Lightning payment is |
| `transfer(params: BankTransferParams): Promise<BankTransfer>` | One bank transfer without building a rail first, for a shop that asks for them one at a time rather than beside another payment method |

### Range

```ts
interface Range {
  least: Amount;
  most: Amount;
}
```

What a payer may choose to send, when the endpoint lets them choose at all.
Both ends are asked once per payRequest, so a fiat range moves with the rate

### Relayed

```ts
interface Relayed {
  url: string;
  hash: string;
}
```

The wallet's own LUD-21 URL and the hash its preimage has to match

### relayedVerifyUrl

```ts
async function relayedVerifyUrl(
  endpoint: string,
  wallet: Relayed,
  secret: string,
): Promise<string>
```

The URL to hand the gateway instead of the wallet's own, with the wallet's
sealed inside it. Point it at wherever `lightningVerifyEndpoint` is mounted

### Resolved

```ts
type Resolved = {
	address: string;
	bolt11: string;
	verifyUrl: string;
	paymentHash: string;
	expiresAt: number;
};
```

An invoice a lightning address issued, with everything needed to watch and to prove it

### sats

```ts
function sats(whole: number): Msat
```

A whole number of satoshi, so `sats(21)` is 21000 millisatoshi

### seal

```ts
async function seal(secret: string, plaintext: string): Promise<string>
```

Encrypt what the watcher needs and the gateway must not have. The gateway
stores the result and hands it back untouched, so anything readable you put
in `sealed` is something you told it, which is what blind mode exists to avoid

### Serve

```ts
class Serve
```

Everything one gateway lets you mount, in one place so a caller never has to
know which handler needs the gateway and which does not. Most of these took it
as a config field before, and reaching them through the gateway deleted it.

`verify` and `bankVerify` need nothing from the gateway and are here anyway,
because a reader looking for a handler should find every handler in one list

| Member | What it does |
|---|---|
| `lnurlPay(config: TriggerConfig): Handler` | An LNURL-pay endpoint of your own, standing in front of a priority list of addresses, so a printed QR points at your domain and never expires |
| `watchTicket(config: WatchTicketConfig): Handler` | Trades the watch secret for a one minute socket ticket, refusing anyone without it |
| `publicWatchTicket(config: WatchTicketConfig): Handler` | Mints a socket ticket for anybody who asks, which makes the trigger's whole stream public, preimages included |
| `verify(config: LightningVerifyConfig): Handler` | A verify endpoint of your own that asks the recipient's wallet for you, so the gateway polls you and never the wallet |
| `bankVerify(config: BankVerifyConfig): Handler` | The verify endpoint a bank rail is polled at, answering off your own statement |
| `webhook(handlers: WebhookHandlers): Handler` | The whole webhook route: it answers the gateway's challenge, checks the signature against the key the gateway publishes, refuses a settlement that proves nothing, and calls you for the one that does |
| `async readSettlement(request: Request, options?: WebhookOptions): Promise<Settlement \| null>` | Verify a delivery and read the settlement out of it, null when it is not believable |
| `async readPayment(request: Request, options?: WebhookOptions): Promise<Payment \| null>` | Verify a delivery and read the payment out of it, null when it is not believable |
| `async answerWebhookChallenge( request: Request, options?: WebhookOptions, ): Promise<Response \| null>` | Answer the challenge the gateway sends before it will post to a webhook of yours |

### Settlement

```ts
interface Settlement {
  id: string;
  status: PaymentStatus;
  paymentHash: string;
  preimage: string | null;
  settledAt: number;
}
```

What a delivery carries. Everything needed to act on a settlement and to check
it, and nothing else, so a retry is the same size every time

### SocketTicket

```ts
interface SocketTicket {
  ticket: string;
  expiresAt: number;
}
```

A one minute pass onto one trigger's stream. It opens that trigger and nothing
else, which is what makes it the thing to hand a browser when the trigger
secret is not. `expiresAt` is unix seconds, like every other time here

### ThunderBridge

```ts
class ThunderBridge
```

Talks to a Thunder Bridge gateway and trusts it for nothing it can check itself

| Member | What it does |
|---|---|
| `readonly serve: Serve;` | Everything this gateway lets you mount, from an LNURL endpoint to a webhook route |
| `readonly rails: Rails;` | One call per sale, whatever the rail moves |
| `get hasToken(): boolean` | Whether a token was given to this instance, which is your side of the arrangement and says nothing about the gateway's |
| `async refusesStrangers(): Promise<boolean>` | Whether the gateway turns away a caller carrying no token, asked by making one unauthenticated read it would have to refuse |
| `async requestPayment(asked: PaymentRequestInit): Promise<PaymentRequest>` | Ask to be paid for one thing |
| `async mint(charge: Charge, options?: CreateOptions): Promise<MintedPayment>` | Ask the gateway for an invoice payable to the first address on your list that can issue a provable one, throws `NoWalletAvailableError` when none can and `GatewayCheatError` when what comes back is not what you asked for |
| `async quote(charge: Charge): Promise<Quote>` | Ask which address would serve an amount without minting anything, throws `NoWalletAvailableError` when none would |
| `async webhookKey(): Promise<string>` | The key this gateway signs webhooks with when you registered none of your own |
| `async payment(id: string): Promise<Payment \| null>` | Read a payment back, null when the gateway has never heard of it |
| `async payments(limit?: number): Promise<{ payments: Payment[]; scanned: number }>` | List what this gateway is watching, newest first |
| `async settled(id: string, options?: WaitOptions): Promise<Payment>` | Follow a payment over WebSocket until it is paid or expired, reconnecting through a drop |
| `async firstSettled(ids: string[], options?: WaitOptions): Promise<Payment \| null>` | Wait on several payments and keep the first one that is really paid, then stop waiting on the losers, which closes their sockets |
| `async watch(handover: Handover): Promise<Payment>` | Hand over an invoice you obtained yourself so the gateway watches it without being told the address or the amount |
| `async nameFor(paymentHash: string): Promise<string \| null>` | What this payment is called, which you can work out before any gateway has heard of it |
| `follow(secret: string, options: FollowOptions): () => void` | Follow every payment made to one trigger, replayed from the recent ones on connect and then live, reconnecting on its own until the returned function is called |
| `async ticket(trigger: string, options?: TicketOptions): Promise<SocketTicket>` | A one minute pass onto one trigger's stream, for something that must hold neither the token nor the trigger secret |

### ThunderBridgeOptions

```ts
interface ThunderBridgeOptions {
  /**
   * Prove every payment against the recipient's own server before handing it
   * back, and refuse a reported settlement whose preimage does not hash to the
   * payment hash, defaults to true
   */
  verify?: boolean;

  /**
   * Sent as `Authorization: Bearer`, which a gateway started with
   * `GATEWAY_TOKEN` requires on every call, the socket handshake included. No
   * browser WebSocket can carry a header, so setting this also puts every socket
   * through a ticket
   */
  token?: string;

  /**
   * The same long lived server side secret your rail derives its preimages from.
   * Given here, every call carries a signature the gateway reads as your identity,
   * so a payment you create is handed back to you and to nobody else. Withheld,
   * you are anonymous and any holder of an id can read what it names
   */
  secret?: string;
}
```

How this instance talks to one gateway, and how much of what it says to check

### TicketOptions

```ts
interface TicketOptions {
  /**
   * How many of this trigger's settlements the socket replays on connect, up to
   * the ceiling the gateway's operator set
   */
  replay?: number;
}
```

What a socket ticket opens beyond the trigger it names

### TriggerConfig

```ts
interface TriggerConfig {
  /** Priority list, quoted at payRequest and then pinned for the callback */
  paidTo: string | string[];

  /**
   * What this trigger costs right now, asked once per payRequest. `fiat` makes it
   * a live rate, and any function of your own makes it a time of day rule.
   *
   * Give it a `{ least, most }` range instead and the payer chooses inside it,
   * which is what a tip jar is. One amount pins the price and the wallet offers
   * no field to type in
   */
  amount: Amount | Range;

  /**
   * Signs the callback URL. Without it anyone could call the callback and make
   * this endpoint mint invoices on wallets of their choosing
   */
  secret: string;

  /** Groups every payment here so `follow` can watch the place, keep it off the QR */
  watchSecret?: string;

  /**
   * How many settlements of this place the gateway keeps replayable past the hour
   * it would otherwise forget them in, up to the ceiling its operator set. What a
   * page that opens later still gets to see. Needs `watchSecret`
   */
  replay?: number;

  /** Override when a proxy hides the public URL from the request, no trailing slash */
  baseUrl?: string;

  /**
   * Resolve the address here and hand the gateway only a hash and a URL to poll,
   * instead of asking it to mint. It then cannot tell who is being paid beyond
   * the domain in the verify URL, nor how much at all, so the only refusal left
   * to it is refusing everyone. Costs one more round trip and gives up the
   * gateway's CORS proxying, which a server does not need anyway.
   *
   * A gateway that enforces its verify challenge will not poll a wallet's own
   * LUD-21 URL, so pass `relayThrough` as well and the poll comes to you
   */
  blind?: boolean;

  /**
   * Where your own `serve.verify` endpoint is mounted, and the secret it was
   * given. The wallet's URL is sealed inside the one the gateway is handed, so
   * the gateway polls you and learns neither the wallet nor its provider
   */
  relayThrough?: { endpoint: string; secret: string };

  /**
   * What the watcher needs and the gateway must not have. `data` returns it and
   * `secret` encrypts it, so there is no way to hand the gateway something it
   * can read. Needs 32 characters of randomness, not a passphrase, and every
   * watcher of this trigger holds the same one
   */
  sealed?: { secret: string; data: (minted: Minted) => unknown };
}
```

An LNURL-pay endpoint of your own: whose wallets it stands for, and what it charges

### unseal

```ts
async function unseal(secret: string, sealed: string): Promise<string | null>
```

Read a sealed blob back, null when it was sealed with another secret, edited
on the way, or is not one of ours. A secret too short to be a key throws,
because that is your bug rather than someone else's input

### UnverifiedRecipientError

```ts
class UnverifiedRecipientError extends Error
```

Thrown when the recipient's own server could not be reached to check the
invoice against, a CORS-blocked browser or a provider that is down, this is
not proof the gateway cheated and it is not proof it did not

| Member | What it does |
|---|---|
| `readonly lnAddress: string;` |  |
| `readonly paymentId: string;` |  |

### WaitOptions

```ts
interface WaitOptions {
  /** Give up when this aborts, `AbortSignal.timeout(ms)` covers the usual case */
  signal?: AbortSignal;

  /**
   * Mint a short-lived ticket and put that in the socket URL instead of the
   * payment id. Implied by `token`. The id stays readable inside the ticket,
   * what changes is that a URL out of a log stops opening anything after a
   * minute
   */
  tickets?: boolean;
}
```

How long to wait on a payment, and what the socket URL is allowed to carry

### WalletFailure

```ts
interface WalletFailure {
  address: string;
  reason: WalletReason;
}
```

One wallet on the list that could not be used, and the reason it could not

### WalletReason

```ts
type WalletReason =
  | "address-unusable"
  | "unreachable"
  | "amount-not-accepted"
  | "cannot-prove-delivery"
  | "invoice-refused";
```

Why one wallet in the list could not be used

### WatchedPayment

```ts
interface WatchedPayment {
	kind: "watched";
	lnAddress: null;
	amountMsat: null;
	bolt11: null;
	id: string;
	status: PaymentStatus;
	paymentHash: string;
	verifyUrl: string;
	preimage: string | null;
	expiresAt: number;
	createdAt: number;
	sealed: string | null;
}
```

A payment the gateway was handed rather than asked to mint. It was told a hash,
a URL and an expiry and nothing else, which is the point of `watch`, so the
address, the amount and the invoice are all absent rather than merely unknown

### WatchTicketConfig

```ts
interface WatchTicketConfig {
  /** The trigger to open, the same secret `serve.lnurlPay` groups its payments under */
  watchSecret: string;

  /**
   * How many of this trigger's settlements the socket replays on connect, so a
   * page opened late still shows what it missed, up to the gateway's ceiling
   */
  replay?: number;
}
```

A trigger's live stream is opened with a ticket rather than with the watch
secret, so something has to hold the secret and trade it for tickets. That is
what these two endpoints are, and they are the only place the gateway's token
has to be

### WebhookCredential

```ts
type WebhookCredential = { publicKey: string };
```

What checks a delivery: the hex the gateway publishes at `/webhook-key`. There
is no shared secret to register, so a gateway holds nothing of yours. Rotating
its cluster key rotates this too, so a signature that stops verifying is a
reason to read the key again before it is a reason to distrust the gateway

### WebhookHandlers

```ts
interface WebhookHandlers {
  /**
   * A settlement that proves itself: it says paid and its preimage hashes to the
   * payment hash it names. This is the only callback a shop needs
   */
  onSettled?: (settlement: Proven<Settlement>) => void | Promise<void>;

  /**
   * A delivery that carries no proof, so an expiry or a paid claim with no
   * preimage behind it. Left unset, the handler answers `202` and does nothing,
   * because acting on an unproven claim is the one thing this refuses to do
   */
  onUnproven?: (settlement: Settlement) => void | Promise<void>;

  /** A whole payment rather than a settlement, which is what an older gateway posts */
  onPayment?: (payment: Payment) => void | Promise<void>;

  /**
   * The key that checks the signature, fetched from the gateway once and kept
   * when you do not pass one. Pass it to pin the key you already read
   */
  credential?: WebhookCredential;

  /** How far the gateway's clock may drift from yours, five minutes by default */
  toleranceSecs?: number;
}
```

What to do with what the gateway delivers, and what to believe it with

### WebhookOptions

```ts
type WebhookOptions = { toleranceSecs?: number };
```

How far the gateway's clock may drift from yours before a webhook is refused

### WrapAllowance

```ts
interface WrapAllowance {
  /** As a fraction of the recipient's amount, `0.01` by default */
  proportion?: number;

  /** The floor in millisatoshi whatever the fraction works out to, `1000` by default */
  baseMsat?: number;
}
```

What a wrapping operator may charge over the recipient's own amount. This is a
ceiling the client sets rather than a price the operator names, so it sits
above what any operator lists and refuses only the ones reaching past it

### wrapFeeCeiling

```ts
function wrapFeeCeiling(amountMsat: number, allowance?: WrapAllowance): Msat
```

The most an operator may add over the recipient's own amount, in millisatoshi.
The proportion is what routing and the liquidity behind it costs, and the base
is the floor it never drops below, because a fraction of a small payment
rounds to nothing the operator can work for

### WrapRefusalCode

```ts
type WrapRefusalCode =
  | "undecodable"
  | "hash_mismatch"
  | "amount_below_recipient"
  | "fee_above_allowance"
  | "recipient_expires_first";
```

The way a wrapping operator was caught out. Every code is the wrapped invoice
failing to bind to the recipient's own, which is the only thing that makes
paying the wrap the same act as paying the recipient

### WrapRefusedError

```ts
class WrapRefusedError extends Error
```

Thrown when a wrapped invoice does not bind to the recipient's. Paying it
would be paying the operator on its word rather than on the shared payment
hash, which is the whole of what makes wrapping safe

| Member | What it does |
|---|---|
| `readonly code: WrapRefusalCode;` |  |

## `thunder-bridge/qr`

| Export | Kind | What it is |
|---|---|---|
| [`invoiceToDataUrl`](#thunder-bridge-qr-invoicetodataurl) | function | SVG data URL for an `<img>` `src` |
| [`invoiceToSvg`](#thunder-bridge-qr-invoicetosvg) | function | Render a BOLT11 invoice or a lightning address as an SVG QR code |
| [`lnurlEndpointToDataUrl`](#thunder-bridge-qr-lnurlendpointtodataurl) | function | SVG data URL of the endpoint's QR, for an `<img>` `src` |
| [`lnurlEndpointToSvg`](#thunder-bridge-qr-lnurlendpointtosvg) | function | Render your own LNURL-pay endpoint, the URL `serve.lnurlPay` is mounted on, as the QR a payer scans |
| [`QrOptions`](#thunder-bridge-qr-qroptions) | interface | How the QR is drawn, which is the only thing about it worth configuring |
| [`qrToDataUrl`](#thunder-bridge-qr-qrtodataurl) | function | SVG data URL of a leg's QR, for an `<img>` `src` |
| [`qrToSvg`](#thunder-bridge-qr-qrtosvg) | function | Render any rail's `Leg.qr` as an SVG QR code |
| [`spdToDataUrl`](#thunder-bridge-qr-spdtodataurl) | function | SVG data URL of the bank transfer's QR, for an `<img>` `src` |
| [`spdToSvg`](#thunder-bridge-qr-spdtosvg) | function | Render the `spd` from `bankTransfer` as the QR a Czech banking app scans |
| [`toLnurl`](#thunder-bridge-qr-tolnurl) | function | Bech32-encode a pay endpoint as the `LNURL1` string LUD-01 defines, uppercase because that is the form it asks a QR to carry |

### invoiceToDataUrl

```ts
function invoiceToDataUrl(destination: string, options?: QrOptions): string
```

SVG data URL for an `<img>` `src`

### invoiceToSvg

```ts
function invoiceToSvg(destination: string, options?: QrOptions): string
```

Render a BOLT11 invoice or a lightning address as an SVG QR code

### lnurlEndpointToDataUrl

```ts
function lnurlEndpointToDataUrl(endpoint: string, options?: QrOptions): string
```

SVG data URL of the endpoint's QR, for an `<img>` `src`

### lnurlEndpointToSvg

```ts
function lnurlEndpointToSvg(endpoint: string, options?: QrOptions): string
```

Render your own LNURL-pay endpoint, the URL `serve.lnurlPay` is mounted on, as
the QR a payer scans. It takes the endpoint URL and does the bech32 itself, so
do not hand it the output of `toLnurl` - that is what this calls for you.

Nothing is minted and nothing expires, so this is the code a tip jar prints
once and an overlay shows all stream

### QrOptions

```ts
interface QrOptions {
  /** SVG width and height in pixels, defaults to 256 */
  size?: number;
  /** Dark module color, defaults to `#000` */
  color?: string;
}
```

How the QR is drawn, which is the only thing about it worth configuring

### qrToDataUrl

```ts
function qrToDataUrl(payload: string, options?: QrOptions): string
```

SVG data URL of a leg's QR, for an `<img>` `src`

### qrToSvg

```ts
function qrToSvg(payload: string, options?: QrOptions): string
```

Render any rail's `Leg.qr` as an SVG QR code. Each rail states its own payload,
a BOLT11 invoice under the `LIGHTNING` scheme or a Short Payment Descriptor as
it stands, so this draws a leg without being told which rail made it

### spdToDataUrl

```ts
function spdToDataUrl(spd: string, options?: QrOptions): string
```

SVG data URL of the bank transfer's QR, for an `<img>` `src`

### spdToSvg

```ts
function spdToSvg(spd: string, options?: QrOptions): string
```

Render the `spd` from `bankTransfer` as the QR a Czech banking app scans. The
payload is a Short Payment Descriptor, so it carries the account, the amount
and the reference the payer must leave on the transfer

### toLnurl

```ts
function toLnurl(endpoint: string): string
```

Bech32-encode a pay endpoint as the `LNURL1` string LUD-01 defines, uppercase
because that is the form it asks a QR to carry. An onion endpoint is http
rather than https, which LUD-17 spells out, so both are taken here

## `thunder-bridge/price`

| Export | Kind | What it is |
|---|---|---|
| [`AmountError`](#thunder-bridge-price-amounterror) | class | Thrown when a price cannot be held exactly |
| [`AmountFault`](#thunder-bridge-price-amountfault) | type | Why an amount was refused |
| [`bitstamp`](#thunder-bridge-price-bitstamp) | function | Bitstamp, CASP authorised by the CSSF in Luxembourg |
| [`coinbase`](#thunder-bridge-price-coinbase) | function | Coinbase, CASP authorised in Luxembourg |
| [`coinmate`](#thunder-bridge-price-coinmate) | function | Coinmate, on the ESMA CASP register, Czech and the one with a real BTC/CZK book |
| [`kraken`](#thunder-bridge-price-kraken) | function | Kraken, CASP authorised by the Central Bank of Ireland |
| [`medianOf`](#thunder-bridge-price-medianof) | function | Ask several venues and take the middle answer, refusing the lot when they disagree too much |
| [`MedianOptions`](#thunder-bridge-price-medianoptions) | interface | How many venues have to agree, how far apart they may be, and how long an answer is held |
| [`minorScaleOf`](#thunder-bridge-price-minorscaleof) | function | The scale that minor unit implies, so 100 for a crown, 1 for a yen, 1000 for a dinar |
| [`minorUnitsOf`](#thunder-bridge-price-minorunitsof) | function | How many digits ISO 4217 gives the currency's minor unit, so 2 for a crown and a euro, 0 for a yen and 3 for a dinar |
| [`msatFor`](#thunder-bridge-price-msatfor) | function | What to ask for over Lightning for a price named in fiat, in millisatoshi |
| [`Ticker`](#thunder-bridge-price-ticker) | type | How many minor units of `currency` one bitcoin costs at one venue, so 134883815 is 1,348,838.15 CZK |

### AmountError

```ts
class AmountError extends Error
```

Thrown when a price cannot be held exactly. Every constructor of an amount
throws this rather than returning something approximate, because a payment
library that rounds silently moves the wrong money

| Member | What it does |
|---|---|
| `static is(failure: unknown): failure is AmountError` | Whether a failure is one of these, without asking whether it is this exact class |
| `readonly code: AmountFault;` |  |

### AmountFault

```ts
type AmountFault =
  | "not-whole-satoshi"
  | "not-whole-millisatoshi"
  | "not-a-decimal"
  | "too-precise"
  | "unknown-currency";
```

Why an amount was refused. A code rather than a message, because a caller can
only recover from a failure it can name and a message is free to be reworded

### bitstamp

```ts
function bitstamp(baseUrl = "https://www.bitstamp.net"): Ticker
```

Bitstamp, CASP authorised by the CSSF in Luxembourg. Quotes EUR and USD, no CZK.

An unknown pair is answered with a `200` and the whole ticker list, whose first
entry is BTC/USD, so asking it for CZK and reading the number would quote a
bitcoin at 64,000 crowns. Anything but a single object is therefore refused

### coinbase

```ts
function coinbase(baseUrl = "https://api.coinbase.com"): Ticker
```

Coinbase, CASP authorised in Luxembourg. Quotes CZK, EUR and most fiat

### coinmate

```ts
function coinmate(baseUrl = "https://coinmate.io"): Ticker
```

Coinmate, on the ESMA CASP register, Czech and the one with a real BTC/CZK book

### kraken

```ts
function kraken(baseUrl = "https://api.kraken.com"): Ticker
```

Kraken, CASP authorised by the Central Bank of Ireland. Quotes EUR and USD, no CZK

### medianOf

```ts
function medianOf(
  tickers: Ticker[] = [coinbase(), kraken(), bitstamp(), coinmate()],
  options: MedianOptions = {},
): Ticker
```

Ask several venues and take the middle answer, refusing the lot when they
disagree too much.

The default is the four MiCA authorised venues below, and every one of them is
replaceable: pass your own list, or one venue, or a function that reads a price
you already have. A venue that does not quote the currency is skipped rather
than fatal, which for CZK leaves Coinbase and Coinmate.

The middle is taken rather than the mean so one stuck venue moves the answer by
nothing instead of by half its error, and the spread check is what catches the
stuck venue that stays inside the pack.

### MedianOptions

```ts
interface MedianOptions {
  /**
   * How many venues have to answer before a price is usable. Two is the floor
   * worth having, because one venue is a number nobody checked
   */
  minVenues?: number;

  /**
   * Refuse the lot when the cheapest and dearest answers are further apart than
   * this many basis points. Venues normally sit inside 50, so a wider spread means
   * one of them is broken or stale rather than that the market moved
   */
  maxSpreadBps?: number;

  /** Hold the last answer this long per currency, so an order page is not four requests */
  holdForSecs?: number;
}
```

How many venues have to agree, how far apart they may be, and how long an answer is held

### minorScaleOf

```ts
function minorScaleOf(currency: string): number
```

The scale that minor unit implies, so 100 for a crown, 1 for a yen, 1000 for a dinar

### minorUnitsOf

```ts
function minorUnitsOf(currency: string): number
```

How many digits ISO 4217 gives the currency's minor unit, so 2 for a crown and a
euro, 0 for a yen and 3 for a dinar.

There is no sane default here, which is why an unlisted code throws rather than
being treated as two. Assuming two turns 1000 yen into 10 and a dinar into a
tenth of itself, and a payment library that guesses at this is a payment library
that moves the wrong amount.

### msatFor

```ts
function msatFor(
  amountMinor: number,
  priceMinorPerBtc: number,
  options: { spreadBps?: number } = {},
): number
```

What to ask for over Lightning for a price named in fiat, in millisatoshi.

`priceMinorPerBtc` is what a `Ticker` returns. The arithmetic is exact, in
BigInt, because a million crown order times a hundred billion millisatoshi
leaves what a double can count, and it rounds up, because the extra
millisatoshi is worth nothing and belongs to the recipient rather than to a
rounding rule.

`spreadBps` is yours to set, in basis points, and defaults to none. A Lightning
invoice lives an hour and a bank transfer takes days, so a shop pricing in fiat is
carrying that volatility whether or not it charges for it

### Ticker

```ts
type Ticker = (currency: string) => Promise<number>;
```

How many minor units of `currency` one bitcoin costs at one venue, so 134883815
is 1,348,838.15 CZK. Throws when that venue does not quote that currency, which
is a normal answer rather than a fault: Kraken and Bitstamp have no CZK pair

This is the plugin seam for prices. Another venue is another function of this
shape

## `thunder-bridge/bank`

| Export | Kind | What it is |
|---|---|---|
| [`BankTransfer`](#thunder-bridge-bank-banktransfer) | interface | A transfer the gateway is now watching, and the descriptor the payer scans |
| [`BankTransferParams`](#thunder-bridge-bank-banktransferparams) | interface | One transfer to ask for: what is owed, where it lands, and where its arrival is read back from |
| [`BankVerifyConfig`](#thunder-bridge-bank-bankverifyconfig) | interface | The endpoint the gateway polls for a bank transfer, answering off your own statement |
| [`Credit`](#thunder-bridge-bank-credit) | interface | One incoming payment as the bank booked it, in the smallest unit of its currency |
| [`FioConfig`](#thunder-bridge-bank-fioconfig) | interface | A Fio account to read credits from, as its own API describes one |
| [`fioStatement`](#thunder-bridge-bank-fiostatement) | function | Read one Fio account as a `Statement`, so a bank transfer proves itself the way a Lightning payment does |
| [`Statement`](#thunder-bridge-bank-statement) | type | Recent credits on one account, oldest or newest first, it makes no difference |

### BankTransfer

```ts
interface BankTransfer {
  /** The watched payment's id at the gateway, which is how you read this order back */
  id: string;

  /** What the gateway was given, and what the preimage has to hash to */
  paymentHash: string;

  /** The same URL you mounted, carrying what to look for and a signature over it */
  verifyUrl: string;

  /** The payer scans this, it is a Short Payment Descriptor, the Czech QR platba format */
  spd: string;
}
```

A transfer the gateway is now watching, and the descriptor the payer scans

### BankTransferParams

```ts
interface BankTransferParams {
  /** Long lived and server side. The preimage is derived from it, so losing it loses every proof */
  secret: string;

  /** What the payer must leave on the transfer, an order id or a nonce. It is matched, not stored */
  reference: string;

  /** The price in the smallest unit, so 48055 is 480.55 CZK */
  amountMinor: number;

  /** The account the money goes to, as an IBAN */
  iban: string;

  /** Where `bankVerifyEndpoint` is mounted, a public https URL with no query of its own */
  verifyUrl: string;

  /** When the offer dies, in unix seconds. Money in a bank moves on banking days, so give it days */
  expiresAt: number;

  /** Defaults to CZK */
  currency?: string;

  /** Up to ten digits, for accounting systems that still want one */
  variableSymbol?: string;

  /**
   * Groups this transfer with everything else paid to the same secret, so one
   * `followTrigger` socket hears about it. Give the Lightning leg of the same
   * order the same secret and both rails arrive on one stream
   */
  trigger?: string;

  /** How many settlements of that trigger the gateway keeps replayable past the hour, needs `trigger` */
  replay?: number;

  /**
   * Handed back untouched on that stream, so a watcher learns which order settled
   * without asking anyone. `seal` it and the gateway cannot read it either
   */
  sealed?: string;

  /**
   * Where the gateway posts once the money lands, a public https URL. Without one
   * a transfer is only ever learned by following the trigger or asking
   */
  webhookUrl?: string;

  /**
   * Register on a gateway you do not own anyway. The verify URL names the amount
   * and the reference, so its operator ends up reading your order book, and the
   * URL itself answers whether that order was paid. Say true only when the order
   * book is not worth hiding
   */
  allowPublicGateway?: boolean;
}
```

One transfer to ask for: what is owed, where it lands, and where its arrival is read back from

### BankVerifyConfig

```ts
interface BankVerifyConfig {
  /** The same secret `bankTransfer` was given */
  secret: string;

  /** The account to read */
  statement: Statement;

  /** How far back a credit still counts, seven days by default */
  lookBackSecs?: number;

  /**
   * How often you want the gateway to ask, in seconds. It goes out as
   * `Cache-Control: max-age`, so the pace is yours to set rather than the
   * gateway's, and a bank that updates once a minute should say so instead of
   * being polled every few seconds. Thirty by default, clamped to an hour
   */
  pollEverySecs?: number;
}
```

The endpoint the gateway polls for a bank transfer, answering off your own statement

### Credit

```ts
interface Credit {
  amountMinor: number;
  currency: string;
  /** Whatever the payer wrote, wherever this bank puts it. Matching is a substring, so noise around it is fine */
  reference: string;

  /**
   * Unix seconds. A bank that books a day rather than an instant, as Fio does,
   * gives the day's midnight in its own zone, so rendering this in UTC can show
   * the day before. Nothing here matches on it, it is yours to read
   */
  bookedAt: number;
}
```

One incoming payment as the bank booked it, in the smallest unit of its currency

### FioConfig

```ts
interface FioConfig {
  /**
   * A token with "Sledování účtu" rights, which is read only and cannot move
   * money. One token is one account, which is why this takes no account number.
   *
   * Give it several and they are used in turn. Fio's window is per token rather
   * than per account, so five tokens on one account is a read every six seconds,
   * and generating another token for the same account is what Fio's own
   * documentation suggests when one is not enough
   */
  token: string | string[];

  /**
   * Fio's window for one token, 30 seconds. No token is ever asked twice inside
   * it, and the gap between reads is this divided by however many tokens were
   * given, so the answers stay evenly spaced rather than arriving in bursts.
   * Inside that gap the last answer is handed back. Only helps a process that
   * stays up
   */
  minIntervalSecs?: number;

  /** Override to point at a mock */
  baseUrl?: string;
}
```

A Fio account to read credits from, as its own API describes one

### fioStatement

```ts
function fioStatement(config: FioConfig): Statement
```

Read one Fio account as a `Statement`, so a bank transfer proves itself the
way a Lightning payment does.

The token is the read only kind, generated in internetbanking under Nastavení
and API, and it is the whole configuration: a token belongs to one account, so
there is no account number to get wrong. It cannot pay anyone, and the worst a
leaked one costs you is that someone else can read the statement.

Every field on a Fio transaction is optional and arrives as `null` when it is
absent, the amount carries its direction in its sign rather than in a flag,
and the date is a day and a UTC offset, `2026-07-15+0200`. This reads all
three the way the bank answers them and treats a missing field as absent
rather than guessing.

### Statement

```ts
type Statement = (sinceUnix: number) => Promise<Credit[]>;
```

Recent credits on one account, oldest or newest first, it makes no difference.
This is the whole plugin seam: a bank is a function of this shape, and
`fioStatement` is one implementation of it

## `thunder-bridge/nwc`

| Export | Kind | What it is |
|---|---|---|
| [`askWallet`](#thunder-bridge-nwc-askwallet) | function | One NIP-47 call, for a method this SDK does not wrap |
| [`nwcConnection`](#thunder-bridge-nwc-nwcconnection) | function | Read a `nostr+walletconnect://` URI |
| [`NwcConnection`](#thunder-bridge-nwc-nwcconnection) | interface | A wallet reachable over NIP-47, as its `nostr+walletconnect://` URI describes it |
| [`nwcHoldInvoice`](#thunder-bridge-nwc-nwcholdinvoice) | function | Mint a hold invoice on a hash the wallet does not hold the preimage for, which is what lets an operator be paid only by paying somebody else first |
| [`nwcInvoice`](#thunder-bridge-nwc-nwcinvoice) | function | Mint an invoice on the connected wallet, decoded so the caller need not trust its word |
| [`NwcInvoice`](#thunder-bridge-nwc-nwcinvoice) | interface | A minted invoice and everything needed to watch it |
| [`nwcPay`](#thunder-bridge-nwc-nwcpay) | function | Pay an invoice and keep the preimage the network handed back |
| [`nwcRail`](#thunder-bridge-nwc-nwcrail) | function | Sell for Lightning against a wallet of your own over NIP-47, for a wallet that has no LUD-21 address to be watched at |
| [`NwcRailConfig`](#thunder-bridge-nwc-nwcrailconfig) | interface | A Lightning rail minting on a wallet of your own over NIP-47, bound once per shop |
| [`nwcSettlement`](#thunder-bridge-nwc-nwcsettlement) | function | The preimage the wallet released for this hash, null while it has released none |
| [`NwcVerifyConfig`](#thunder-bridge-nwc-nwcverifyconfig) | interface | The endpoint the gateway polls for an NWC payment, answering off your own wallet |
| [`nwcVerifyEndpoint`](#thunder-bridge-nwc-nwcverifyendpoint) | function | A verify endpoint of your own that asks your wallet over NIP-47, so the gateway polls you and never learns the connection, the relay, or which wallet it is |
| [`nwcVerifyUrl`](#thunder-bridge-nwc-nwcverifyurl) | function | The URL to hand the gateway, with the payment hash sealed inside it |

### askWallet

```ts
async function askWallet(
  connection: NwcConnection,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = DEFAULT_ASK_TIMEOUT_MS,
): Promise<Record<string, unknown>>
```

One NIP-47 call, for a method this SDK does not wrap. The wallet's own info
event lists what it will answer, and anything it refuses comes back as a
`WalletRefused` whose `reason` says which kind of refusal it was

### nwcConnection

```ts
function nwcConnection(uri: string): NwcConnection
```

Read a `nostr+walletconnect://` URI. Refuses a relay that is not `wss`, for the
reason the gateway refuses a verify URL that is not https

### NwcConnection

```ts
interface NwcConnection {
  /** The wallet service's public key, which is what its answers have to be signed by */
  walletPubkey: string;

  /** Where to reach it, tried in order until one answers */
  relays: string[];

  /** Our own private key on this connection, and the only thing that authorises it */
  secret: string;
}
```

A wallet reachable over NIP-47, as its `nostr+walletconnect://` URI describes it

### nwcHoldInvoice

```ts
async function nwcHoldInvoice(
  connection: NwcConnection,
  held: {
    paymentHash: string;
    amountMsat: number;
    description: string;
    expirySecs: number;
    minCltvExpiryDelta?: number;
  },
  timeoutMs = DEFAULT_ASK_TIMEOUT_MS,
): Promise<NwcInvoice>
```

Mint a hold invoice on a hash the wallet does not hold the preimage for, which
is what lets an operator be paid only by paying somebody else first. The hash
has to come from the recipient's own invoice, and the invoice that comes back
is decoded rather than believed

### nwcInvoice

```ts
async function nwcInvoice(
  connection: NwcConnection,
  amountMsat: number,
  description: string,
  timeoutMs = DEFAULT_ASK_TIMEOUT_MS,
): Promise<NwcInvoice>
```

Mint an invoice on the connected wallet, decoded so the caller need not trust its word

### NwcInvoice

```ts
interface NwcInvoice {
  bolt11: string;
  paymentHash: string;
  expiresAt: number;
}
```

A minted invoice and everything needed to watch it

### nwcPay

```ts
async function nwcPay(
  connection: NwcConnection,
  bolt11: string,
  timeoutMs = PAY_TIMEOUT_MS,
): Promise<string>
```

Pay an invoice and keep the preimage the network handed back. Whoever pays
learns it, which is what makes delivery provable to a recipient publishing no
LUD-21 of their own. A preimage that does not hash to the invoice's own hash is
a lie rather than a receipt, so it throws instead of being passed on

### nwcRail

```ts
function nwcRail(gateway: ThunderBridge, config: NwcRailConfig): Rail
```

Sell for Lightning against a wallet of your own over NIP-47, for a wallet that
has no LUD-21 address to be watched at. Your node mints the invoice and releases
the preimage, so the proof comes from one hop nearer than any hosted address can
manage, and the gateway sees a hash and a URL of yours.

This rail lives here rather than on `gateway.rails` because NIP-47 needs the
nostr crypto in this module, and a browser showing a QR should not download it

### NwcRailConfig

```ts
interface NwcRailConfig {
	connection: NwcConnection;
	amount?: ((order: Order) => Amount) | undefined;
	rate?: Ticker | undefined;
	verifyThrough: { endpoint: string; secret: string; };
	description?: ((order: Order) => string) | undefined;
	sealed?: ((order: Order) => string | Promise<string>) | undefined;
	trigger?: string | undefined;
	replay?: number | undefined;
	webhookUrl?: string | undefined;
	name?: string | undefined;
}
```

A Lightning rail minting on a wallet of your own over NIP-47, bound once per shop

### nwcSettlement

```ts
async function nwcSettlement(
  connection: NwcConnection,
  paymentHash: string,
  timeoutMs = DEFAULT_ASK_TIMEOUT_MS,
): Promise<string | null>
```

The preimage the wallet released for this hash, null while it has released
none. A preimage that does not hash to what was asked for is a lie rather than
an answer, so it throws instead of being passed on

### NwcVerifyConfig

```ts
interface NwcVerifyConfig {
  /** The wallet this endpoint speaks for. It never leaves this process */
  connection: NwcConnection;

  /** The secret the payment hash was sealed with, and nothing else uses it */
  secret: string;

  /** How often the gateway should ask, in seconds, sent as `Cache-Control: max-age`, `5` by default */
  pollEverySecs?: number;

  /** How long one `lookup_invoice` may take before the wallet counts as unreachable, `10_000` by default */
  askTimeoutMs?: number;
}
```

The endpoint the gateway polls for an NWC payment, answering off your own wallet

### nwcVerifyEndpoint

```ts
function nwcVerifyEndpoint(
  config: NwcVerifyConfig,
): (request: Request) => Promise<Response>
```

A verify endpoint of your own that asks your wallet over NIP-47, so the gateway
polls you and never learns the connection, the relay, or which wallet it is.

`nwcVerifyUrl` seals the payment hash into the query with your secret, which is
what stops a stranger driving your wallet through this handler. It answers the
LUD-21 shape the gateway already speaks, so nothing on that side changes.

A wallet it cannot reach answers `502` rather than "not settled", because those
are different claims and only one of them is true.

### nwcVerifyUrl

```ts
async function nwcVerifyUrl(
  endpoint: string,
  paymentHash: string,
  secret: string,
): Promise<string>
```

The URL to hand the gateway, with the payment hash sealed inside it. Point it at
wherever `nwcVerifyEndpoint` is mounted
