import { type Charge, fiat, ThunderBridge } from "thunder-bridge";
import { coinbase, kraken, medianOf } from "thunder-bridge/price";

export const DEMO_GATEWAY = "https://public.thunder-bridge.agora.gripe";

export async function checkout(
  into: { innerHTML: string },
  charge: Charge = {
    paidTo: ["iamfatik@blink.sv"],
    amount: fiat("0.21", "USD", {
      rate: medianOf([coinbase(), kraken()], { maxSpreadBps: 50 }),
      spreadBps: 100,
    }),
  },
  via = DEMO_GATEWAY,
): Promise<string | null> {
  const gateway = new ThunderBridge(via);

  const asked = await gateway.requestPayment(charge);

  into.innerHTML = asked.qr;

  await asked.paid();

  return await asked.prove();
}
