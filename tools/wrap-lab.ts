import { createServer } from "node:http";
import { decodeInvoice, preimageMatchesHash } from "../core/bolt11.ts";
import { checkSettled } from "../core/lnurl.ts";
import { proveWrapped, wrapFeeCeiling } from "../sdk/dist/index.js";
import { askWallet, nwcConnection, nwcHoldInvoice, nwcPay } from "../sdk/dist/server.js";
import { type Bridged, ledgerAt, settleWhatIsOwed } from "./wrap-ledger.ts";

const PORT = Number(process.env.PORT ?? 8480);
const HOLD_EXPIRY_SECS = 900;
const WATCH_EVERY_MS = 2000;
const BRIDGE_PATH = "/bridge/verify/";
const LEDGER = process.env.WRAP_LEDGER ?? "wrap-lab.ledger.json";

const wallet = process.env.NWC_URI ? nwcConnection(process.env.NWC_URI) : null;

const bridging = ledgerAt(LEDGER);

const settleThroughTheWallet = (preimage: string) =>
	askWallet(wallet!, "settle_hold_invoice", { preimage });

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>lud-21 bridge lab</title>
<style>
:root{color-scheme:dark;--bg:#0d1117;--fg:#e6edf3;--dim:#8b949e;--line:#30363d;--ok:#3fb950;--no:#f85149;--wait:#d29922}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1.5rem;background:var(--bg);color:var(--fg);font:14px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}
main{max-width:44rem;margin:0 auto}
h1{font-size:1rem;margin:0 0 .4rem;font-weight:600}
p.lead{color:var(--dim);margin:0 0 1.6rem}
form{display:flex;gap:.6rem;flex-wrap:wrap}
input{flex:1 1 16rem;font:inherit;background:#161b22;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:.55rem .8rem}
input.amount{flex:0 0 8rem}
button{font:inherit;background:#1f6feb;color:#fff;border:0;border-radius:6px;padding:.55rem 1.1rem;cursor:pointer}
button:disabled{opacity:.45;cursor:default}
h2{font-size:.72rem;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);margin:1.8rem 0 .7rem;font-weight:600}
.row{display:flex;gap:.8rem;padding:.12rem 0}
.row b{color:var(--dim);font-weight:400;flex:0 0 12rem}
.row span{word-break:break-all}
pre{white-space:pre-wrap;word-break:break-all;margin:.7rem 0 0;font-size:11.5px;color:var(--dim)}
.ok{color:var(--ok)}.no{color:var(--no)}.wait{color:var(--wait)}
.qr{background:#fff;padding:.7rem;border-radius:6px;width:max-content;margin:.9rem 0}
.qr svg{display:block;width:200px;height:200px}
.path{border-left:2px solid var(--line);padding-left:.9rem;margin:.5rem 0 0}
</style></head><body><main>
<h1>lud-21 bridge lab</h1>
<p class="lead">LUD-21 is used whenever the recipient publishes one. When they do not, the wrap takes over: a hold invoice on their payment hash, forwarded by this node, and the preimage served back as a LUD-21 endpoint. Nothing is paid until you pay the invoice shown.</p>

<form id="f">
  <input id="addr" value="iamfatik@bitlifi.com" spellcheck="false" aria-label="lightning address">
  <input id="msat" class="amount" value="21000" spellcheck="false" aria-label="millisatoshi">
  <button id="go">go</button>
</form>

<div id="out"></div>
</main><script>
const out = document.getElementById("out");
const go = document.getElementById("go");
let polling = null;

const esc = (v) => String(v ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
const row = (k, v, cls) => '<div class="row"><b>' + k + '</b><span class="' + (cls ?? "") + '">' + esc(v) + "</span></div>";

async function post(path, body) {
  const answer = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const said = await answer.json();
  if (!answer.ok) throw new Error(said.detail ?? answer.status);
  return said;
}

document.getElementById("f").onsubmit = async (event) => {
  event.preventDefault();
  clearInterval(polling);
  go.disabled = true;
  out.innerHTML = '<h2>working</h2><pre>resolving the address and choosing a path</pre>';

  try {
    const it = await post("/api/offer", {
      address: document.getElementById("addr").value.trim(),
      amountMsat: Number(document.getElementById("msat").value),
    });
    render(it, null);
    watch(it);
  } catch (failed) {
    out.innerHTML = '<h2>refused</h2><div class="row no">' + esc(failed.message) + "</div>";
    go.disabled = false;
  }
};

function render(it, seen) {
  const settled = seen !== null && seen.settled;
  const proof = seen === null
    ? row("settlement", "asking", "wait")
    : row("settled", settled ? "YES" : "not yet", settled ? "ok" : "wait") +
      (seen.state ? row("hold invoice state", seen.state, settled ? "ok" : "wait") : "") +
      (seen.note ? row("engine", seen.note, seen.state === "failed" ? "no" : "wait") : "") +
      (seen.preimage ? row("preimage", seen.preimage, "ok") : "") +
      (settled ? row("hashes to the payment hash", seen.binds ? "YES" : "NO", seen.binds ? "ok" : "no") : "");

  out.innerHTML =
    "<h2>recipient</h2>" +
    row("address", it.address) +
    row("payment hash", it.paymentHash) +
    row("amount asked", it.amountMsat + " msat") +
    row("publishes lud-21", it.speaksLud21 ? "YES" : "NO", it.speaksLud21 ? "ok" : "no") +
    "<h2>" + (it.speaksLud21 ? "path: their own lud-21" : "path: wrapped, because they publish none") + "</h2>" +
    row("verify url", it.verifyUrl, "ok") +
    (it.speaksLud21
      ? ""
      : row("wrap amount", it.wrapAmountMsat + " msat", "") +
        row("fee over recipient", it.feeMsat + " msat") +
        row("proveWrapped", it.proven ? "PASSED" : "REFUSED " + it.refusal, it.proven ? "ok" : "no")) +
    '<div class="qr">' + it.qr + "</div>" +
    "<pre>" + esc(it.payable) + "</pre>" +
    '<div class="path">' + row("pay this", it.speaksLud21 ? "the recipient directly" : "this node, which forwards it", "ok") + "</div>" +
    "<h2>proof</h2>" + proof;

  if (settled) {
    clearInterval(polling);
    go.disabled = false;
  }
}

function watch(it) {
  const ask = async () => {
    const seen = await post("/api/settled", { verifyUrl: it.verifyUrl, paymentHash: it.paymentHash }).catch(() => null);
    if (seen !== null) render(it, seen);
  };
  ask();
  polling = setInterval(ask, 2500);
}
</script></body></html>`;

const server = createServer(async (incoming, outgoing) => {
	const url = new URL(incoming.url ?? "/", `http://127.0.0.1:${PORT}`);

	if (url.pathname === "/") {
		outgoing.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		outgoing.end(PAGE);
		return;
	}
	if (url.pathname.startsWith(BRIDGE_PATH)) {
		outgoing.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=2" });
		outgoing.end(JSON.stringify(bridgeAnswer(url.pathname.slice(BRIDGE_PATH.length))));
		return;
	}
	if (incoming.method !== "POST") {
		outgoing.writeHead(404).end();
		return;
	}

	const asked = JSON.parse(await bodyOf(incoming)) as {
		address: string;
		amountMsat: number;
		verifyUrl: string;
		paymentHash: string;
	};
	try {
		const answered = url.pathname === "/api/offer" ? await offered(asked) : await settled(asked);
		outgoing.writeHead(200, { "content-type": "application/json" });
		outgoing.end(JSON.stringify(answered));
	} catch (failed: unknown) {
		console.error(`${url.pathname} refused: ${String(failed)}`);
		outgoing.writeHead(502, { "content-type": "application/json" });
		outgoing.end(JSON.stringify({ detail: String(failed) }));
	}
});

server.listen(PORT, async () => {
	console.log(`lud-21 bridge lab on http://127.0.0.1:${PORT}`);
	console.log(wallet ? `wrapping through ${wallet.walletPubkey}` : "no NWC_URI, wrapping off");
	if (wallet !== null) {
		const recovered = await settleWhatIsOwed(bridging, settleThroughTheWallet);
		console.log(
			`ledger recovery settled ${recovered.settled.length}, refused ${recovered.refused.length}, unprovable ${recovered.unprovable.length}`,
		);
	}
});

/**
 * LUD-21 wherever the recipient publishes one, and the wrap only where they do
 * not. The caller never picks - what the recipient can prove picks for them, and a
 * recipient who can prove nothing with no wrapper configured is refused the way
 * the gateway refuses them today
 */
async function offered(asked: { address: string; amountMsat: number }) {
	const real = await payRequested(asked.address, asked.amountMsat);
	const { qrToSvg } = await import("../sdk/dist/index.js");
	const shared = {
		address: asked.address,
		paymentHash: real.paymentHash,
		amountMsat: asked.amountMsat,
		speaksLud21: real.verifyUrl !== null,
	};

	if (real.verifyUrl !== null) {
		return {
			...shared,
			verifyUrl: real.verifyUrl,
			payable: real.bolt11,
			qr: qrToSvg(real.bolt11.toUpperCase()),
		};
	}
	if (wallet === null) {
		throw new Error(`${asked.address} publishes no LUD-21 and no wrapper is configured`);
	}

	const feeMsat = wrapFeeCeiling(asked.amountMsat);
	const held = await nwcHoldInvoice(wallet, {
		paymentHash: real.paymentHash,
		amountMsat: asked.amountMsat + feeMsat,
		description: `wrap of ${real.paymentHash.slice(0, 12)}`,
		expirySecs: HOLD_EXPIRY_SECS,
	});

	let proven = true;
	let refusal = "";
	try {
		proveWrapped(held.bolt11, real.bolt11);
	} catch (refused: unknown) {
		proven = false;
		refusal = String(refused);
	}

	bridging.set(real.paymentHash.toLowerCase(), {
		recipient: real.bolt11,
		wrap: held.bolt11,
		state: "waiting",
		preimage: null,
		note: "waiting for the wrap to be paid",
	});
	forwardWhenHeld(real.paymentHash.toLowerCase());
	console.log(`wrapped ${real.paymentHash} for ${asked.amountMsat + feeMsat} msat`);

	return {
		...shared,
		verifyUrl: `http://127.0.0.1:${PORT}${BRIDGE_PATH}${real.paymentHash.toLowerCase()}`,
		payable: held.bolt11,
		qr: qrToSvg(held.bolt11.toUpperCase()),
		wrapAmountMsat: asked.amountMsat + feeMsat,
		feeMsat,
		proven,
		refusal,
	};
}

/**
 * The engine, such as it is. The wallet publishes no notifications on this
 * connection, so `accepted` has to be polled for. Paying the recipient is what
 * teaches us the preimage, and settling with it is the only way to keep what the
 * payer sent
 */
function forwardWhenHeld(paymentHash: string) {
	const deadline = Date.now() + HOLD_EXPIRY_SECS * 1000;
	const watching = setInterval(async () => {
		const held = bridging.get(paymentHash);
		if (held === undefined || held.state === "settled" || held.state === "failed") {
			clearInterval(watching);
			return;
		}
		if (Date.now() > deadline) {
			clearInterval(watching);
			bridging.set(paymentHash, {
				...held,
				state: "failed",
				note: "the hold invoice expired unpaid",
			});
			return;
		}
		if (held.state !== "waiting") {
			return;
		}

		const seen = (await askWallet(wallet!, "lookup_invoice", { payment_hash: paymentHash }).catch(
			() => null,
		)) as { state?: string } | null;
		if (seen?.state !== "accepted") {
			return;
		}

		clearInterval(watching);
		bridging.set(paymentHash, { ...held, state: "forwarding", note: "paying the recipient" });
		console.log(`${paymentHash} held, forwarding to the recipient`);
		await forward(paymentHash, held);
	}, WATCH_EVERY_MS);
}

async function forward(paymentHash: string, held: Bridged) {
	try {
		const preimage = await nwcPay(wallet!, held.recipient);
		bridging.set(paymentHash, {
			...held,
			state: "forwarding",
			preimage,
			note: "the recipient is paid, the wrap is not settled yet",
		});
		console.log(`${paymentHash} recipient paid, preimage ${preimage}`);
		await askWallet(wallet!, "settle_hold_invoice", { preimage });
		bridging.set(paymentHash, {
			...held,
			state: "settled",
			preimage,
			note: "forwarded and settled",
		});
		console.log(`${paymentHash} settled`);
	} catch (failed: unknown) {
		console.error(`${paymentHash} forward failed: ${String(failed)}`);
		bridging.set(paymentHash, {
			...held,
			state: "failed",
			note: `forward failed, cancelling: ${String(failed)}`,
		});
		await askWallet(wallet!, "cancel_hold_invoice", { payment_hash: paymentHash }).catch(
			() => null,
		);
	}
}

function bridgeAnswer(paymentHash: string) {
	const held = bridging.get(paymentHash.toLowerCase());

	return {
		status: "OK",
		settled: held?.state === "settled",
		preimage: held?.preimage ?? null,
		pr: held?.wrap ?? null,
		state: held?.state ?? "unknown",
		note: held?.note ?? "",
	};
}

/**
 * The recipient's own invoice whether or not they publish a verify url, because
 * the wrap exists exactly for the ones that do not. `resolve` in core refuses
 * those outright, so this asks the same two endpoints and leaves `verifyUrl` null
 */
async function payRequested(address: string, amountMsat: number) {
	const [user, domain] = address.split("@");
	const pay = await answered<{ callback?: string }>(`https://${domain}/.well-known/lnurlp/${user}`);
	if (typeof pay.callback !== "string") {
		throw new Error(`${address} served no payRequest`);
	}

	const separator = pay.callback.includes("?") ? "&" : "?";
	const issued = await answered<{ pr?: string; verify?: string | null; reason?: string }>(
		`${pay.callback}${separator}amount=${amountMsat}`,
	);
	if (typeof issued.pr !== "string") {
		throw new Error(`${address} issued no invoice: ${issued.reason ?? "no reason given"}`);
	}

	const decoded = decodeInvoice(issued.pr);
	if (decoded.paymentHash === null) {
		throw new Error(`${address} issued an invoice we cannot decode`);
	}
	if (decoded.amountMsat !== amountMsat) {
		throw new Error(`${address} issued ${decoded.amountMsat} msat, not ${amountMsat}`);
	}

	return { bolt11: issued.pr, paymentHash: decoded.paymentHash, verifyUrl: issued.verify ?? null };
}

async function settled(asked: { verifyUrl: string; paymentHash: string }) {
	if (asked.verifyUrl.includes(BRIDGE_PATH)) {
		const seen = bridgeAnswer(new URL(asked.verifyUrl).pathname.slice(BRIDGE_PATH.length));
		return { ...seen, binds: bound(seen.preimage, asked.paymentHash) };
	}

	const seen = await checkSettled(asked.verifyUrl, asked.paymentHash);

	return {
		settled: seen.preimage !== null,
		preimage: seen.preimage,
		binds: bound(seen.preimage, asked.paymentHash),
	};
}

function bound(preimage: string | null, paymentHash: string): boolean {
	return preimage !== null && preimageMatchesHash(preimage, paymentHash);
}

async function answered<T>(url: string): Promise<T> {
	const answer = await fetch(url, { headers: { accept: "application/json" } });
	if (!answer.ok) {
		throw new Error(`${url} answered ${answer.status}`);
	}

	return (await answer.json()) as T;
}

async function bodyOf(incoming: AsyncIterable<Buffer>): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of incoming) {
		chunks.push(chunk);
	}

	return Buffer.concat(chunks).toString() || "{}";
}
