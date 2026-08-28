import { createServer } from "node:http";
import { preimageMatchesHash } from "../core/bolt11.ts";
import { nwcConnection, nwcInvoice, nwcVerifyEndpoint, nwcVerifyUrl } from "../sdk/dist/server.js";

const SEALING_SECRET = "smoke_secret_a41f7c02be93d5681047ff2c";
const PORT = Number(process.env.PORT ?? 8477);
const AMOUNT_MSAT = Number(process.env.AMOUNT_MSAT ?? 1000);
const ASK_EVERY_MS = 3000;

const uri = process.env.NWC_URI;
if (!uri) {
	console.error("set NWC_URI to the nostr+walletconnect:// string your wallet issued");
	process.exit(1);
}

const connection = nwcConnection(uri);
console.log(`wallet  ${connection.walletPubkey}`);
console.log(`relays  ${connection.relays.join(", ")}\n`);

const invoice = await nwcInvoice(connection, AMOUNT_MSAT, "thunder-bridge nwc smoke");
console.log(`minted  ${AMOUNT_MSAT} msat`);
console.log(`hash    ${invoice.paymentHash}`);
console.log(`expires ${new Date(invoice.expiresAt * 1000).toISOString()}\n`);
console.log(`${invoice.bolt11}\n`);

const endpoint = nwcVerifyEndpoint({ connection, secret: SEALING_SECRET, pollEverySecs: 3 });
createServer(async (incoming, outgoing) => {
	const answer = await endpoint(
		new Request(`http://127.0.0.1:${PORT}${incoming.url}`, { method: incoming.method }),
	);
	outgoing.writeHead(answer.status, Object.fromEntries(answer.headers));
	outgoing.end(await answer.text());
}).listen(PORT);

const verifyUrl = await nwcVerifyUrl(
	`http://127.0.0.1:${PORT}/verify/nwc`,
	invoice.paymentHash,
	SEALING_SECRET,
);
console.log(`the gateway would poll ${verifyUrl}\n`);
console.log("pay the invoice above\n");

let reached = 0;
let missed = 0;

for (let attempt = 1; ; attempt++) {
	if (Math.floor(Date.now() / 1000) > invoice.expiresAt) {
		console.log(`\nthe invoice expired unpaid after ${attempt - 1} polls`);
		console.log(`the wallet answered ${reached} of them and was unreachable for ${missed}`);
		process.exit(2);
	}

	const said = await asked(verifyUrl);
	if (said === null) {
		console.log(`  ${attempt}  the endpoint itself could not be reached`);
	} else {
		reached += said.status === 200 ? 1 : 0;
		missed += said.status === 200 ? 0 : 1;
		console.log(`  ${attempt}  ${said.status}  settled=${said.settled}  ${said.paced}`);
	}

	if (said?.settled && said.preimage) {
		const binds = preimageMatchesHash(said.preimage, invoice.paymentHash);
		console.log(`\npreimage ${said.preimage}`);
		console.log(binds ? "it hashes to the payment hash" : "IT DOES NOT HASH TO THE PAYMENT HASH");
		process.exit(binds ? 0 : 1);
	}
	await new Promise((wake) => setTimeout(wake, ASK_EVERY_MS));
}

async function asked(url: string) {
	try {
		const answer = await fetch(url);
		const said = (await answer.json()) as { settled: boolean; preimage: string | null };
		return { ...said, status: answer.status, paced: answer.headers.get("cache-control") };
	} catch {
		return null;
	}
}
