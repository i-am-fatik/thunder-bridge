import { nwcRail as railOverNwc, nwcVerifyEndpoint as verifyOverNwc } from "../nwc.js";

export type { NwcConnection, NwcInvoice, NwcRailConfig, NwcVerifyConfig } from "../nwc.js";
export {
  askWallet,
  nwcConnection,
  nwcHoldInvoice,
  nwcInvoice,
  nwcPay,
  nwcSettlement,
  nwcVerifyUrl,
} from "../nwc.js";

/**
 * The NWC rail as a free function, which is how it was reached before 2.2.0
 *
 * @deprecated Use `gateway.rails.nwc(config)`, the same rail beside every other one
 */
export const nwcRail = railOverNwc;

/**
 * The NWC verify endpoint as a free function, which is how it was reached before 2.2.0
 *
 * @deprecated Use `gateway.serve.nwcVerify(config)`, beside every other verify endpoint
 */
export const nwcVerifyEndpoint = verifyOverNwc;
