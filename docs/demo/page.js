import {
  checkout,
  coinbase,
  fiat,
  invoiceToSvg,
  kraken,
  lnurlEndpointToSvg,
  medianOf,
  sats,
  tipJar,
  watchAPlace,
} from "./bundle.js";

const RECIPE = JSON.parse(document.getElementById("recipe").textContent);
const KEY = `thunder-bridge:${RECIPE.slug}`;
const whole = (value) => Number(value.replace(/_/g, ""));
async function asJson(url) {
  const answer = await fetch(url);
  const body = await answer.json();
  if (body.status === "ERROR") {
    throw new Error(body.reason ?? "the endpoint refused");
  }

  return body;
}

async function askTheEndpoint(values) {
  const asked = new URLSearchParams({
    to: values.paidTo,
    least: String(whole(values.least)),
    most: String(whole(values.most)),
    via: values.gateway,
  });
  await fetch(`/paid-to?${asked}`, { method: "POST" });
  const offered = await asJson("/lnurlp/tips");
  stepAt("ask", "done");
  stepAt("callback", "running");

  const minted = await asJson(`${offered.callback}&amount=${offered.minSendable}`);
  stepAt("callback", "done");
  stepAt("invoice", "running");
  mintedQr.innerHTML = invoiceToSvg(minted.pr);
  mintedBolt.textContent = `a real invoice for ${offered.minSendable / 1000} satoshi, the least the range allows. Pay it and it lands below`;
  mintedCard.classList.add("on");
  stepAt("invoice", "done");

  return { bolt11: minted.pr, least: offered.minSendable / 1000, most: offered.maxSendable / 1000 };
}

const SETTLED = (preimage) =>
  preimage === null
    ? "The recipient's own server says it has not settled."
    : `Settled. The recipient released the preimage <code>${preimage}</code>, and it hashes to the payment hash the invoice named.`;

const RUNS = {
  tipJar: {
    run: (into, values) =>
      tipJar(into, { paidTo: values.paidTo, amount: sats(whole(values.sats)) }, values.gateway),
    said: SETTLED,
  },
  checkout: {
    run: (into, values) =>
      checkout(
        into,
        {
          paidTo: values.paidTo,
          amount: fiat(values.price, values.currency, {
            rate: medianOf([coinbase(), kraken()], { maxSpreadBps: whole(values.maxSpreadBps) }),
            spreadBps: whole(values.spreadBps),
          }),
        },
        values.gateway,
      ),
    said: SETTLED,
  },
  payMe: {
    run: (_into, values) => askTheEndpoint(values),
    said: ({ bolt11, least, most }) =>
      `Your endpoint offered ${least} to ${most} satoshi and its callback minted <code>${bolt11.slice(0, 34)}...</code> for the least. Pay it with any wallet and the tile below fills.`,
  },
};
const PLAUSIBLE = {
  number: (value) => /^[1-9](?:[0-9_]*[0-9])?$/.test(value),
  url: (value) => /^https?:\/\/[^\s/]+/.test(value),
  address: (value) => /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value),
  decimal: (value) => /^\d+(?:\.\d{1,2})?$/.test(value),
  currency: (value) => /^[A-Z]{3}$/.test(value),
};

const fields = [...document.querySelectorAll(".edit")];
const steps = [...document.querySelectorAll(".steps li")];
const wire = document.getElementById("wire");
const runButton = document.getElementById("run");
const resetButton = document.getElementById("reset");
const qrCard = document.getElementById("qrcard");
const qr = document.getElementById("qr");
const ident = document.getElementById("ident");
const verdict = document.getElementById("verdict");
const bolt = document.getElementById("bolt");
const mintedCard = document.getElementById("minted");
const mintedQr = document.getElementById("mintedqr");
const mintedBolt = document.getElementById("mintedbolt");

const NOTHING_YET = wire.innerHTML;
const realFetch = window.fetch.bind(window);
const RealSocket = window.WebSocket;
let running = false;

function typed() {
  return Object.fromEntries(fields.map((one) => [one.dataset.key, one.textContent.trim()]));
}

function paint() {
  const values = typed();
  for (const one of fields) {
    one.classList.toggle("wrong", !PLAUSIBLE[one.dataset.kind](values[one.dataset.key]));
  }
  if (RECIPE.call === "payMe") {
    const most = fields.find((one) => one.dataset.key === "most");
    if (whole(values.most) < whole(values.least)) {
      most.classList.add("wrong");
    }
    bolt.textContent = `bech32 of ${location.origin}/lnurlp/tips, the way LUD-01 asks. A wallet scanning it is offered ${whole(values.least)} to ${whole(values.most)} satoshi`;
  }
  runButton.disabled = running || fields.some((one) => one.classList.contains("wrong"));
}

function log(verb, code, where, tone) {
  wire.querySelector(".empty")?.remove();
  const row = document.createElement("div");
  row.innerHTML =
    `<span class="verb">${verb}</span><span class="code2 ${tone ?? ""}">${code}</span>` +
    `<span class="where">${where}</span>`;
  wire.append(row);
  wire.scrollTop = wire.scrollHeight;
}

function shorten(url) {
  try {
    const at = new URL(url);

    return at.host + at.pathname.replace(/(\/[0-9a-f]{12})[0-9a-f]+/, "$1...");
  } catch {
    return url;
  }
}

function stepAt(key, state) {
  const li = steps.find((one) => one.dataset.step === key);
  if (!li) {
    return;
  }
  li.classList.remove("running", "done");
  li.classList.add(state);
  for (const row of document.querySelectorAll(".row")) {
    row.classList.remove("live");
  }
  if (state === "running") {
    document.getElementById(`L${li.dataset.line}`)?.classList.add("live");
  }
}

function clearRun() {
  wire.innerHTML = NOTHING_YET;
  ident.replaceChildren();
  verdict.className = "verdict";
  verdict.replaceChildren();
  for (const one of steps) {
    one.classList.remove("running", "done");
  }
  if (RECIPE.call === "payMe") {
    mintedCard.classList.remove("on");
    mintedQr.replaceChildren();
    mintedBolt.replaceChildren();

    return;
  }
  qrCard.classList.remove("on");
  qr.replaceChildren();
  bolt.replaceChildren();
}

function whyItFailed(refused) {
  return refused instanceof TypeError
    ? "The gateway never answered. Check the url in the code and that this browser can reach it."
    : String(refused?.message ?? refused);
}

window.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  const verb = (init?.method ?? input?.method ?? "GET").toUpperCase();
  try {
    const answer = await realFetch(input, init);
    log(verb, answer.status, shorten(url), answer.ok ? "ok" : "no");

    return answer;
  } catch (refused) {
    log(verb, "err", shorten(url), "no");
    throw refused;
  }
};

window.WebSocket = class extends RealSocket {
  constructor(url, protocols) {
    super(url, protocols);
    const named = String(url).match(/\/ws\/incoming-payments\/([0-9a-f]{64})/);
    if (named !== null) {
      const at = new URL(String(url).replace(/^ws/, "http")).origin;
      ident.innerHTML =
        `This invoice is <code>${named[1]}</code>. ` +
        `<a href="${at}/incoming-payments/${named[1]}" target="_blank" rel="noreferrer">Ask the gateway what became of it</a>.`;
    }
    log("WS", "open", shorten(String(url).replace(/^ws/, "http")));
    stepAt("wait", "running");
    this.addEventListener("message", (event) => {
      let status = "frame";
      try {
        status = JSON.parse(event.data).status ?? "frame";
      } catch {}
      log("WS", status, "one incoming_payment as json", status === "paid" ? "ok" : "");
      if (status === "paid") {
        stepAt("wait", "done");
        stepAt("prove", "running");
      }
    });
  }
};

new MutationObserver(() => {
  if (qr.innerHTML.trim() === "" || RECIPE.call === "payMe") {
    return;
  }
  qrCard.classList.add("on");
  stepAt("mint", "done");
  stepAt("qr", "done");
  stepAt("wait", "running");
}).observe(qr, { childList: true, subtree: true });

for (const one of fields) {
  one.addEventListener("input", () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(typed()));
    } catch {}
    paint();
  });
  one.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
    }
  });
}

try {
  const held = JSON.parse(localStorage.getItem(KEY) ?? "null");
  for (const [key, value] of Object.entries(held ?? {})) {
    const one = fields.find((field) => field.dataset.key === key);
    if (one && typeof value === "string" && value !== "") {
      one.textContent = value;
    }
  }
} catch {}
paint();

async function followThisPlace() {
  const arrived = document.getElementById("arrived");
  const { watchSecret } = await (await fetch("/watch-secret")).json();

  watchAPlace(watchSecret, (settled) => {
    arrived.querySelector(".empty")?.remove();
    const row = document.createElement("div");
    row.className = "arrival";
    row.innerHTML =
      `<span class="paid">paid</span>` +
      `<strong class="amount">${settled.amountMsat / 1000} satoshi</strong>` +
      `<span class="proof">preimage ${String(settled.preimage).slice(0, 16)}...</span>`;
    arrived.append(row);
    arrived.scrollTop = arrived.scrollHeight;
  });
}

if (RECIPE.call === "payMe") {
  followThisPlace();
  qr.innerHTML = lnurlEndpointToSvg(`${location.origin}/lnurlp/tips`);
  qrCard.classList.add("on");
}

runButton.addEventListener("click", async () => {
  const values = typed();
  running = true;
  paint();
  for (const one of fields) {
    one.contentEditable = "false";
  }
  clearRun();
  stepAt(RECIPE.call === "payMe" ? "ask" : "mint", "running");

  try {
    const came = await RUNS[RECIPE.call].run(qr, values);
    stepAt("prove", "done");
    verdict.className = "verdict on good";
    verdict.innerHTML = RUNS[RECIPE.call].said(came);
  } catch (refused) {
    for (const one of steps) {
      one.classList.remove("running");
    }
    verdict.className = "verdict on bad";
    verdict.innerHTML = refused?.code
      ? `<code>${refused.code}</code> ${whyItFailed(refused)}`
      : whyItFailed(refused);
  } finally {
    running = false;
    for (const one of fields) {
      one.contentEditable = "plaintext-only";
    }
    paint();
  }
});

resetButton.addEventListener("click", () => {
  try {
    localStorage.removeItem(KEY);
  } catch {}
  for (const one of fields) {
    one.textContent = RECIPE.defaults[one.dataset.key];
  }
  clearRun();
  paint();
});
