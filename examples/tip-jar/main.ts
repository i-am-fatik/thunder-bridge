import { type Charge, sats, ThunderBridge } from "thunder-bridge";

export const DEMO_GATEWAY = "https://public.thunder-bridge.agora.gripe";

export async function tipJar(
  into: { innerHTML: string },
  charge: Charge = { paidTo: ["iamfatik@blink.sv"], amount: sats(21) },
  via = DEMO_GATEWAY,
): Promise<string | null> {
  const gateway = new ThunderBridge(via);

  const asked = await gateway.requestPayment(charge);

  into.innerHTML = asked.qr;

  await asked.paid();

  return await asked.prove();
}
