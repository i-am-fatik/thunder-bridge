export interface Door {
	specifier: string;
	entry: string;
}

export const DOORS: Door[] = [
	{ specifier: "thunder-bridge", entry: "sdk/src/index.ts" },
	{ specifier: "thunder-bridge/qr", entry: "sdk/src/entry/qr.ts" },
	{ specifier: "thunder-bridge/price", entry: "sdk/src/entry/price.ts" },
	{ specifier: "thunder-bridge/bank", entry: "sdk/src/entry/bank.ts" },
	{ specifier: "thunder-bridge/nwc", entry: "sdk/src/entry/nwc.ts" },
];
