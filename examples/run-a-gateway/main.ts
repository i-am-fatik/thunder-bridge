import { type Service, start } from "../../src/index.ts";
import { Ledger } from "../../src/ledger.ts";
import { Store } from "../../src/store.ts";

export async function runAGateway(
  key: Uint8Array,
  socket = "./gateway.sock",
  ledgerPath = "./ledger.db",
): Promise<Service> {
  const ledger = new Ledger(ledgerPath, key);
  const store = new Store(ledger, key);
  const gateway = await start({ key, socket, mints: true }, store);

  return {
    at: gateway.at,
    stop: async () => {
      await gateway.stop();
      store.close();
    },
  };
}
