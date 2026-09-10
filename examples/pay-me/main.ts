import { type Handler, sats, ThunderBridge } from "thunder-bridge";
import { lnurlEndpointToSvg } from "thunder-bridge/qr";

export const DEMO_GATEWAY = "https://public.thunder-bridge.agora.gripe";

export function payMe(
  into: { innerHTML: string },
  endpoint: string,
  secret: string,
  watchSecret: string,
  paidTo: string | string[] = ["iamfatik@blink.sv"],
  via = DEMO_GATEWAY,
): Handler {
  const gateway = new ThunderBridge(via);

  into.innerHTML = lnurlEndpointToSvg(endpoint);

  return gateway.serve.lnurlPay({
    paidTo,
    amount: { least: sats(21), most: sats(210_000) },
    secret,
    watchSecret,
  });
}
