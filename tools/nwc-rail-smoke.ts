import { createServer } from "node:http";
import { preimageMatchesHash } from "../core/bolt11.ts";
import { ThunderBridge } from "../sdk/dist/index.js";
import { nwcConnection, nwcRail, nwcVerifyEndpoint } from "../sdk/dist/server.js";

const SEALING_SECRET = "rail_smoke_secret_b73e4f19ac0d258614fa";
const PORT = Number(process.env.PORT ?? 8477);
const AMOUNT_MSAT = Number(process.env.AMOUNT_MSAT ?? 1000);
const ASK_EVERY_MS = 3000;

const uri = process.env.NWC_URI;
const gatewayUrl = process.env.GATEWAY;
const publicEndpoint = process.env.VERIFY_ENDPOINT;
if (!uri || !gatewayUrl || !publicEndpoint) {
	console.error("needs NWC_URI, GATEWAY and VERIFY_ENDPOINT");
	process.exit(1);
}

const connection = nwcConnection(uri);
const endpoint = nwcVerifyEndpoint({ connection, secret: SEALING_SECRET, pollEverySecs: 3 });
createServer(async (incoming, outgoing) => {
	const answer = await endpoint(
		new Request(`${publicEndpoint}${incoming.url}`, {
			method: incoming.method,
			body: incoming.method === "POST" ? await bodyOf(incoming) : undefined,
		}),
	);
	outgoing.writeHead(answer.status, Object.fromEntries(answer.headers));
	outgoing.end(await answer.text());
}).listen(PORT);

console.log(`wallet   ${connection.walletPubkey}`);
console.log(`gateway  ${gatewayUrl}`);
console.log(`endpoint ${publicEndpoint}\n`);

const rail = nwcRail({
	gateway: new ThunderBridge(gatewayUrl),
	connection,
	amountMsat: () => AMOUNT_MSAT,
	verifyThrough: { endpoint: publicEndpoint, secret: SEALING_SECRET },
	description: (order) => `thunder-bridge rail smoke ${order.reference}`,
});

const leg = await rail({ reference: "rail-smoke-1", amountMinor: 1, currency: "CZK" });
console.log(`watched  ${leg.id}`);
console.log(`rail     ${leg.rail}`);
console.log(`expires  ${new Date(leg.expiresAt * 1000).toISOString()}\n`);
console.log(`${leg.scan}\n`);
console.log("the gateway is polling your endpoint now, pay the invoice above\n");

const watching = new ThunderBridge(gatewayUrl);
for (let attempt = 1; ; attempt++) {
	if (Math.floor(Date.now() / 1000) > leg.expiresAt) {
		console.log(`\nthe invoice expired unpaid after ${attempt - 1} checks`);
		process.exit(2);
	}

	const seen = await watching.getWatched(leg.id).catch(() => null);
	console.log(`  ${attempt}  ${seen?.status ?? "unreachable"}`);

	if (seen?.preimage) {
		const binds = preimageMatchesHash(seen.preimage, seen.paymentHash ?? "");
		console.log(`\npreimage ${seen.preimage}`);
		console.log(binds ? "it hashes to the payment hash" : "IT DOES NOT HASH TO THE PAYMENT HASH");
		process.exit(binds ? 0 : 1);
	}
	await new Promise((wake) => setTimeout(wake, ASK_EVERY_MS));
}

async function bodyOf(incoming: { [Symbol.asyncIterator]: () => AsyncIterator<Buffer> }) {
	const chunks: Buffer[] = [];
	for await (const chunk of incoming as AsyncIterable<Buffer>) {
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString();
}
