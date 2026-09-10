import { type Payment, ThunderBridge } from "thunder-bridge";

export const DEMO_GATEWAY = "https://public.thunder-bridge.agora.gripe";

export function watchAPlace(
  watchSecret: string,
  arrived: (settled: Payment) => void,
  via = DEMO_GATEWAY,
): () => void {
  return new ThunderBridge(via).follow(watchSecret, { onPayment: arrived });
}
