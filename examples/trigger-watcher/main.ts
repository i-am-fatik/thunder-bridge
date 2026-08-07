import { ThunderBridge, type TriggerEvent } from "thunder-bridge";

const GATEWAY_URL = Deno.env.get("GATEWAY_URL") ??
  "https://thunder-bridge-production.up.railway.app";
const WATCH_SECRET = Deno.env.get("WATCH_SECRET") ?? "";

if (WATCH_SECRET === "") throw new Error("WATCH_SECRET is the same one the endpoint was given");

const gateway = new ThunderBridge(GATEWAY_URL);

function ring(payment: TriggerEvent): void {
  const sats = payment.amountMsat === null ? "some" : payment.amountMsat / 1000;
  const to = payment.lnAddress ?? "an address the gateway was never told";

  console.log(`${sats} sat to ${to}, preimage ${payment.preimage?.slice(0, 16)}`);
}

const stop = gateway.followTrigger(WATCH_SECRET, {
  onPayment: ring,
  onError: (failure) => console.error("stream", failure),
});

console.log(`watching ${GATEWAY_URL}, ctrl-c to stop`);

Deno.addSignalListener("SIGINT", () => {
  stop();
  Deno.exit(0);
});
