import { type Payment, ThunderBridge } from "thunder-bridge";

export const DEMO_GATEWAY = "https://public.thunder-bridge.agora.gripe";

export function watchAPlace(
  watchSecret: string,
  onPayment: (settled: Payment) => void,
  via = DEMO_GATEWAY,
): () => void {
  const gateway = new ThunderBridge(via);
  const stop = gateway.follow(watchSecret, { onPayment });

  return stop;
}
