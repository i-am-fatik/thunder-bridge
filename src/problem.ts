import type { WalletFailure, WalletReason } from "../core/refusal.ts";

export {
	NoWalletAvailable,
	WalletRefused,
	type WalletFailure,
	type WalletReason,
} from "../core/refusal.ts";

export const INVALID_REQUEST = "urn:problem-type:thunder-bridge:invalid-request";
export const NO_WALLET_AVAILABLE = "urn:problem-type:thunder-bridge:no-wallet-available";
export const REQUEST_IN_FLIGHT = "urn:problem-type:thunder-bridge:request-in-flight";
export const KEY_REUSED = "urn:problem-type:thunder-bridge:idempotency-key-reused";
export const ALREADY_WATCHED = "urn:problem-type:thunder-bridge:payment-already-watched";

const STATUS: Record<WalletReason, number> = {
	"address-unusable": 400,
	"amount-not-accepted": 400,
	"cannot-prove-delivery": 422,
	"invoice-refused": 422,
	unreachable: 502,
};

export class MalformedRequest extends Error {}

export function statusForWallets(wallets: WalletFailure[]): number {
	const codes = wallets.map((wallet) => STATUS[wallet.reason]);
	if (codes.includes(502)) return 502;
	if (codes.includes(422)) return 422;
	return 400;
}
