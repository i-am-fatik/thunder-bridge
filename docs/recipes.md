# Every use case, as one program you can run

Generated from `examples/` by [`tools/recipes.ts`](../tools/recipes.ts). Every name in a
recipe below was found by the TypeScript compiler and links to its own entry in
[the reference](api.md), so no link here is written or kept by hand. Run
`node tools/recipes.ts` after changing a recipe, and CI refuses a diff.

| Recipe | Rail | What it is for |
|---|---|---|
| [Tip jar on a static page](#tip-jar) | `rails.lightning` | Take a tip with no backend of your own and no wallet of your own |

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
