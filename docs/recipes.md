# Every use case, as one program you can run

Generated from `examples/` by [`tools/recipes.ts`](../tools/recipes.ts). Every name in a
recipe below was found by the TypeScript compiler and links to its own entry in
[the reference](api.md), so no link here is written or kept by hand. Run
`node tools/recipes.ts` after changing a recipe, and CI refuses a diff.

| Recipe | Rail | What it is for |
|---|---|---|
| [A price named in dollars, paid in bitcoin](#fiat-checkout) | `rails.lightning` | Charge 0.21 USD without ever converting it yourself |
| [A lightning address of your own](#pay-me) | `rails.lightning` | Print one QR that never expires and lets the payer choose what to give |
| [Pick a wait back up after a reload](#resume-a-wait) | `rails.lightning` | Carry on waiting for an invoice you already minted, holding nothing but its id |
| [Tip jar on a static page](#tip-jar) | `rails.lightning` | Take a tip with no backend of your own and no wallet of your own |
| [Watch every payment made to one place](#watch-a-place) | `rails.lightning` | See the money arrive at an endpoint nobody is standing in front of |

## <a id="fiat-checkout"></a>A price named in dollars, paid in bitcoin

Charge 0.21 USD without ever converting it yourself. It lives in `examples/fiat-checkout/main.ts`, and what it claims is asserted in `examples/fiat-checkout/main.test.ts`.

<pre><code>import { type <a href="api.md#thunder-bridge-interface-charge">Charge</a>, <a href="api.md#thunder-bridge-function-fiat">fiat</a>, <a href="api.md#thunder-bridge-class-thunderbridge">ThunderBridge</a> } from "thunder-bridge";
import { <a href="api.md#thunder-bridge-price-function-coinbase">coinbase</a>, <a href="api.md#thunder-bridge-price-function-kraken">kraken</a>, <a href="api.md#thunder-bridge-price-function-medianof">medianOf</a> } from "thunder-bridge/price";

export const DEMO_GATEWAY = "https://public.thunder-bridge.agora.gripe";

export async function checkout(
  into: { innerHTML: string },
  charge: <a href="api.md#thunder-bridge-interface-charge">Charge</a> = {
    paidTo: ["iamfatik@blink.sv"],
    amount: <a href="api.md#thunder-bridge-function-fiat">fiat</a>("0.21", "USD", {
      rate: <a href="api.md#thunder-bridge-price-function-medianof">medianOf</a>([<a href="api.md#thunder-bridge-price-function-coinbase">coinbase</a>(), <a href="api.md#thunder-bridge-price-function-kraken">kraken</a>()], { maxSpreadBps: 50 }),
      spreadBps: 100,
    }),
  },
  via = DEMO_GATEWAY,
): Promise&lt;string | null&gt; {
  const gateway = new <a href="api.md#thunder-bridge-class-thunderbridge">ThunderBridge</a>(via);

  const asked = await gateway.<a href="api.md#thunder-bridge-class-thunderbridge-requestpayment">requestPayment</a>(charge);

  into.innerHTML = asked.<a href="api.md#thunder-bridge-interface-paymentrequest">qr</a>;

  await asked.<a href="api.md#thunder-bridge-interface-paymentrequest">paid</a>();

  return await asked.<a href="api.md#thunder-bridge-interface-paymentrequest">prove</a>();
}</code></pre>

- the price stays in dollars and becomes millisatoshi at the moment the invoice is minted
- the rate is the median of the venues you name, refused when they disagree by more than you allow
- the spread over the rate is yours to set, because a lightning invoice lives an hour
- everything after the price is the tip jar unchanged, so pricing in fiat costs the flow nothing

## <a id="pay-me"></a>A lightning address of your own

Print one QR that never expires and lets the payer choose what to give. It lives in `examples/pay-me/main.ts`, and what it claims is asserted in `examples/pay-me/main.test.ts`.

<pre><code>import { type <a href="api.md#thunder-bridge-type-handler">Handler</a>, <a href="api.md#thunder-bridge-function-sats">sats</a>, <a href="api.md#thunder-bridge-class-thunderbridge">ThunderBridge</a> } from "thunder-bridge";
import { <a href="api.md#thunder-bridge-qr-function-lnurlendpointtosvg">lnurlEndpointToSvg</a> } from "thunder-bridge/qr";

export const DEMO_GATEWAY = "https://public.thunder-bridge.agora.gripe";

export function payMe(
  into: { innerHTML: string },
  endpoint: string,
  secret: string,
  watchSecret: string,
  paidTo: string | string[] = ["iamfatik@blink.sv"],
  via = DEMO_GATEWAY,
): <a href="api.md#thunder-bridge-type-handler">Handler</a> {
  const gateway = new <a href="api.md#thunder-bridge-class-thunderbridge">ThunderBridge</a>(via);

  into.innerHTML = <a href="api.md#thunder-bridge-qr-function-lnurlendpointtosvg">lnurlEndpointToSvg</a>(endpoint);

  return gateway.<a href="api.md#thunder-bridge-class-thunderbridge-serve">serve</a>.<a href="api.md#thunder-bridge-class-serve-lnurlpay">lnurlPay</a>({
    paidTo,
    amount: { least: <a href="api.md#thunder-bridge-function-sats">sats</a>(21), most: sats(210_000) },
    secret,
    watchSecret,
  });
}</code></pre>

- the endpoint is a fetch handler, so it mounts on anything that speaks Request and Response
- a range instead of one amount is what makes a wallet offer a field to type in
- the QR carries your own url, so the addresses behind it can change without reprinting it
- the secret signs the callback, so nobody else can make the endpoint mint on your wallets
- the watch secret is a second, weaker key, and watch-a-place is what reads it

## <a id="resume-a-wait"></a>Pick a wait back up after a reload

Carry on waiting for an invoice you already minted, holding nothing but its id. It lives in `examples/resume-a-wait/main.ts`, and what it claims is asserted in `examples/resume-a-wait/main.test.ts`.

<pre><code>import { <a href="api.md#thunder-bridge-function-provesettlement">proveSettlement</a>, <a href="api.md#thunder-bridge-class-thunderbridge">ThunderBridge</a> } from "thunder-bridge";
import { <a href="api.md#thunder-bridge-qr-function-invoicetosvg">invoiceToSvg</a> } from "thunder-bridge/qr";

export const DEMO_GATEWAY = "https://public.thunder-bridge.agora.gripe";

export async function resumeAWait(
  into: { innerHTML: string },
  id: string,
  via = DEMO_GATEWAY,
): Promise&lt;string | null&gt; {
  const gateway = new <a href="api.md#thunder-bridge-class-thunderbridge">ThunderBridge</a>(via);

  const asked = await gateway.<a href="api.md#thunder-bridge-class-thunderbridge-payment">payment</a>(id);
  if (asked?.<a href="api.md#thunder-bridge-interface-mintedpayment">kind</a> !== "minted") {
    throw new Error(`${id} is not an invoice this gateway minted`);
  }

  into.innerHTML = <a href="api.md#thunder-bridge-qr-function-invoicetosvg">invoiceToSvg</a>(asked.<a href="api.md#thunder-bridge-interface-mintedpayment">bolt11</a>);

  await gateway.<a href="api.md#thunder-bridge-class-thunderbridge-settled">settled</a>(id);

  return await <a href="api.md#thunder-bridge-function-provesettlement">proveSettlement</a>(asked, { paidTo: [asked.<a href="api.md#thunder-bridge-interface-mintedpayment">lnAddress</a>], <a href="api.md#thunder-bridge-interface-mintedpayment">amountMsat</a>: asked.amountMsat });
}</code></pre>

- the id is the whole handle, so a page that reloads keeps nothing else
- payment reads the invoice back and the QR redraws from its own bolt11
- settled opens the socket again, so a payment made while nobody watched still arrives
- the proof takes the invoice as it was read, because nothing it checks changes when the money lands

## <a id="tip-jar"></a>Tip jar on a static page

Take a tip with no backend of your own and no wallet of your own. It lives in `examples/tip-jar/main.ts`, and what it claims is asserted in `examples/tip-jar/main.test.ts`.

<pre><code>import { type <a href="api.md#thunder-bridge-interface-charge">Charge</a>, <a href="api.md#thunder-bridge-function-sats">sats</a>, <a href="api.md#thunder-bridge-class-thunderbridge">ThunderBridge</a> } from "thunder-bridge";

export const DEMO_GATEWAY = "https://public.thunder-bridge.agora.gripe";

export async function tipJar(
  into: { innerHTML: string },
  charge: <a href="api.md#thunder-bridge-interface-charge">Charge</a> = { paidTo: ["iamfatik@blink.sv"], amount: <a href="api.md#thunder-bridge-function-sats">sats</a>(21) },
  via = DEMO_GATEWAY,
): Promise&lt;string | null&gt; {
  const gateway = new <a href="api.md#thunder-bridge-class-thunderbridge">ThunderBridge</a>(via);

  const asked = await gateway.<a href="api.md#thunder-bridge-class-thunderbridge-requestpayment">requestPayment</a>(charge);

  into.innerHTML = asked.<a href="api.md#thunder-bridge-interface-paymentrequest">qr</a>;

  await asked.<a href="api.md#thunder-bridge-interface-paymentrequest">paid</a>();

  return await asked.<a href="api.md#thunder-bridge-interface-paymentrequest">prove</a>();
}</code></pre>

- one call mints the invoice, proves it against the recipient's own domain and draws the QR
- the QR is an SVG string, so any container that takes innerHTML can hold it
- paid asks the gateway and prove asks the recipient's own server, and only the second is evidence
- who is paid, how much and which gateway all have a default, so the whole jar is one call

## <a id="watch-a-place"></a>Watch every payment made to one place

See the money arrive at an endpoint nobody is standing in front of. It lives in `examples/watch-a-place/main.ts`, and what it claims is asserted in `examples/watch-a-place/main.test.ts`.

<pre><code>import { type <a href="api.md#thunder-bridge-type-payment">Payment</a>, <a href="api.md#thunder-bridge-class-thunderbridge">ThunderBridge</a> } from "thunder-bridge";

export const DEMO_GATEWAY = "https://public.thunder-bridge.agora.gripe";

export function watchAPlace(
  watchSecret: string,
  onPayment: (settled: <a href="api.md#thunder-bridge-type-payment">Payment</a>) =&gt; void,
  via = DEMO_GATEWAY,
): () =&gt; void {
  const gateway = new <a href="api.md#thunder-bridge-class-thunderbridge">ThunderBridge</a>(via);
  const stop = gateway.<a href="api.md#thunder-bridge-class-thunderbridge-follow">follow</a>(watchSecret, { onPayment });

  return stop;
}</code></pre>

- the watch secret is the only handle, and it never travels in a QR
- the recent settlements replay on connect, then it runs live
- it reconnects on its own, and the function it returns is how you stop
- watching is a different program from serving, so it holds no secret that mints
