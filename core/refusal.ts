export type WalletReason =
	| "address-unusable"
	| "unreachable"
	| "amount-not-accepted"
	| "cannot-prove-delivery"
	| "invoice-refused";

export type WalletFailure = { address: string; reason: WalletReason };

export class WalletRefused extends Error {
	readonly reason: WalletReason;

	constructor(reason: WalletReason, message: string) {
		super(message);
		this.reason = reason;
	}
}

export class NoWalletAvailable extends Error {
	readonly wallets: WalletFailure[];

	constructor(wallets: WalletFailure[]) {
		super(wallets.map((wallet) => `${wallet.address} ${wallet.reason}`).join(", "));
		this.wallets = wallets;
	}
}
