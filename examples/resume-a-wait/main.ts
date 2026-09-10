import { proveSettlement, ThunderBridge } from "thunder-bridge";
import { invoiceToSvg } from "thunder-bridge/qr";

export const DEMO_GATEWAY = "https://public.thunder-bridge.agora.gripe";

export async function resumeAWait(
  into: { innerHTML: string },
  id: string,
  via = DEMO_GATEWAY,
): Promise<string | null> {
  const gateway = new ThunderBridge(via);

  const asked = await gateway.payment(id);
  if (asked?.kind !== "minted") {
    throw new Error(`${id} is not an invoice this gateway minted`);
  }

  into.innerHTML = invoiceToSvg(asked.bolt11);

  await gateway.settled(id);

  return await proveSettlement(asked, { paidTo: [asked.lnAddress], amountMsat: asked.amountMsat });
}
