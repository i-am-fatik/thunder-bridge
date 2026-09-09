import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		qr: "src/entry/qr.ts",
		price: "src/entry/price.ts",
		bank: "src/entry/bank.ts",
		nwc: "src/entry/nwc.ts",
	},
	format: ["esm", "cjs"],
	dts: true,
	clean: true,
	splitting: false,
});
