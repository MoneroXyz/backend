/* app.v5.js (robust ID autodetect + proper payloads for backend) */

let currentSwapId = null;
let poller = null;

/* ---------- DOM helpers (auto-detect IDs) ---------- */
function byId(id) { return document.getElementById(id); }
function pickId(...ids) {
  for (const id of ids) { const el = byId(id); if (el) return el; }
  return null;
}
function qs(sel) { return document.querySelector(sel); }

/* Try to locate controls by multiple common IDs used in various revisions */
const UI = {
  fromSel:        null,
  toSel:          null,
  rateSel:        null,
  amountInput:    null,
  payoutInput:    null,
  leg1Input:      null,
  leg2Input:      null,
  quoteBtn:       null,
  startBtn:       null,
  statusBox:      null,
  quoteBox:       null,
  swapIdInput:    null,
};

function wireDom() {
  UI.fromSel     = pickId("from_asset", "from", "fromSel");
  UI.toSel       = pickId("to_asset", "to", "toSel");
  UI.rateSel     = pickId("rate_type", "rate", "rateSel");
  UI.amountInput = pickId("amount", "amt", "amountInput");
  UI.payoutInput = pickId("payout", "payout_address", "dest", "toAddress");
  UI.leg1Input   = pickId("leg1_provider", "prov1", "l1prov");
  UI.leg2Input   = pickId("leg2_provider", "prov2", "l2prov");
  UI.quoteBtn    = pickId("quoteBtn", "getQuoteBtn", "btnQuote");
  UI.startBtn    = pickId("startBtn", "btnStart");
  UI.statusBox   = pickId("statusBox", "status", "trackBox");
  UI.quoteBox    = pickId("quoteResult", "quoteBox", "bestRouteBox");
  UI.swapIdInput = pickId("swap_id", "swapId", "trackSwapId");

  // As a last resort, fall back to “first two selects are From/To; third is Rate”
  const selAll = Array.from(document.querySelectorAll("select"));
  if (!UI.fromSel && selAll.length > 0) UI.fromSel = selAll[0];
  if (!UI.toSel   && selAll.length > 1) UI.toSel   = selAll[1];
  if (!UI.rateSel && selAll.length > 2) UI.rateSel = selAll[2];

  // Fallback for buttons/boxes
  if (!UI.quoteBox)  UI.quoteBox  = qs("#quoteResult, .quote-result") || document.body;
  if (!UI.statusBox) UI.statusBox = qs("#statusBox, .status-box") || document.body;

  if (!UI.quoteBtn && qs("button")) UI.quoteBtn = qs("button");
  if (!UI.startBtn && qsAll("button")[1]) UI.startBtn = qsAll("button")[1];
}

/* ---------- Assets (value encodes asset+network) ---------- */
const PAIRS = [
  // label, asset, network
  ["BTC (BTC)",        "BTC",  "BTC"],
  ["ETH (ETH)",        "ETH",  "ETH"],
  ["USDT (ETH)",       "USDT", "ETH"],
  ["USDT (TRX)",       "USDT", "TRX"],
  ["USDC (ETH)",       "USDC", "ETH"],
  ["LTC (LTC)",        "LTC",  "LTC"],
  ["XMR (XMR)",        "XMR",  "XMR"],
];

function populatePickers() {
  if (!UI.fromSel || !UI.toSel) return;
  UI.fromSel.innerHTML = "";
  UI.toSel.innerHTML   = "";
  for (const [label, asset, net] of PAIRS) {
    const v = `${asset}:${net}`;
    const o1 = document.createElement("option"); o1.value = v; o1.textContent = label; UI.fromSel.appendChild(o1);
    const o2 = document.createElement("option"); o2.value = v; o2.textContent = label; UI.toSel.appendChild(o2);
  }
  // sensible defaults
  setIf(UI.fromSel, "USDT:ETH");
  setIf(UI.toSel,   "BTC:BTC");

  if (UI.rateSel) {
    UI.rateSel.innerHTML = "";
    const oF = document.createElement("option"); oF.value = "float"; oF.textContent = "Float";
    const oX = document.createElement("option"); oX.value = "fixed"; oX.textContent = "Fixed";
    UI.rateSel.appendChild(oF); UI.rateSel.appendChild(oX);
    UI.rateSel.value = "float";
  }
}
function setIf(sel, val) { if (sel && [...sel.options].some(o=>o.value===val)) sel.value = val; }

/* ---------- Networking helpers ---------- */
async function postJSON(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

/* ---------- Quote ---------- */
function splitPair(v) {
  const [asset, network] = String(v || "").split(":");
  return { asset, network };
}

async function onQuote() {
  try {
    const { asset: in_asset,  network: in_network  } = splitPair(UI.fromSel.value);
    const { asset: out_asset, network: out_network } = splitPair(UI.toSel.value);
    const amount    = parseFloat(UI.amountInput?.value || "0");
    const rate_type = (UI.rateSel?.value || "float").toLowerCase();

    if (!in_asset || !out_asset || !amount || amount <= 0) {
      alert("Please choose assets and enter a valid amount.");
      return;
    }

    const req = { in_asset, in_network, out_asset, out_network, amount, rate_type };
    const q = await postJSON("/api/quote", req);

    renderQuote(q);
    if (UI.startBtn) UI.startBtn.disabled = false;
  } catch (e) {
    renderQuote({ error: String(e) });
  }
}

function renderQuote(q) {
  if (!UI.quoteBox) return;
  if (q.error) { UI.quoteBox.innerHTML = `<div class="error">${q.error}</div>`; return; }
  const opts = q.options || [];
  const best = opts[q.best_index ?? 0];

  let html = `<h3>Best route</h3>`;
  if (best) {
    html += `
      <div>
        <div><b>Leg 1:</b> ${best.leg1.provider} → XMR</div>
        <div><b>Leg 2:</b> ${best.leg2.provider} → ${q.request.out_asset} (${q.request.out_network})</div>
        <div><b>XMR in:</b> ${best.leg1.amount_to.toFixed(6)}</div>
        <div><b>Our fee:</b> ${best.fee.our_fee_xmr.toFixed(6)} XMR</div>
        <div><b>Receive est:</b> ${best.receive_out.toFixed(6)} ${q.request.out_asset}</div>
      </div>
    `;
  } else {
    html += `<div>No routes</div>`;
  }

  if (opts.length > 1) {
    html += `<h4>Other routes</h4>`;
    opts.forEach((o, i) => {
      if (i === (q.best_index ?? 0)) return;
      html += `<div>#${i+1}: ${o.leg1.provider} → XMR → ${o.leg2.provider} — est ${o.receive_out.toFixed(6)} ${q.request.out_asset}</div>`;
    });
  }

  UI.quoteBox.innerHTML = html;
}

/* ---------- Start swap ---------- */
async function onStart() {
  try {
    if (!UI.payoutInput?.value) { alert("Enter payout address"); return; }

    const { asset: in_asset,  network: in_network  } = splitPair(UI.fromSel.value);
    const { asset: out_asset, network: out_network } = splitPair(UI.toSel.value);
    const amount    = parseFloat(UI.amountInput?.value || "0");
    const rate_type = (UI.rateSel?.value || "float").toLowerCase();

    // We’ll simply pick the best route from the last quote:
    const q = window._lastQuote || await postJSON("/api/quote", { in_asset, in_network, out_asset, out_network, amount, rate_type });
    window._lastQuote = q;
    const best = (q.options || [])[q.best_index ?? 0];
    if (!best) { alert("No route available."); return; }

    const body = {
      leg1_provider: best.leg1.provider,
      leg2_provider: best.leg2.provider,
      in_asset, in_network, out_asset, out_network,
      amount, payout_address: UI.payoutInput.value,
      rate_type,
      our_fee_xmr: (best.fee?.our_fee_xmr ?? 0)
    };

    const s = await postJSON("/api/start", body);
    currentSwapId = s.swap_id;

    // show the deposit address (if backend included it) else show leg1 provider deposit from status later
    UI.quoteBox.innerHTML = `
      <b>Swap started.</b><br/>
      Swap ID: <code>${s.swap_id}</code><br/>
      Deposit: <code>${s.deposit_address || '(provider will show deposit)'}</code>
    `;

    // start polling
    startPolling();
  } catch (e) {
    alert(String(e));
  }
}

/* ---------- Status polling ---------- */
function startPolling() {
  if (poller) clearInterval(poller);
  if (!currentSwapId) return;
  poller = setInterval(async () => {
    try {
      const s = await getJSON(`/api/status/${currentSwapId}`);
      renderStatus(s);
    } catch (e) {
      // keep polling; show last error
      UI.statusBox.innerHTML = `<div class="error">${String(e)}</div>`;
    }
  }, 4000);
}

function pill(txt) { return `<li>${txt}</li>`; }

function renderStatus(s) {
  if (!UI.statusBox) return;
  let html = `<h3>Status: ${s.status}</h3>`;
  if (Array.isArray(s.steps)) {
    html += `<ul>${s.steps.map(pill).join("")}</ul>`;
  }

  if (s.leg1) {
    html += `<h4>Leg 1</h4>
      Provider: ${s.leg1.provider || ""}<br>
      Tx: ${s.leg1.tx_id || ""}<br>
      Deposit: ${s.leg1.deposit || ""}${s.leg1.extra ? " / memo: " + s.leg1.extra : ""}
    `;
  }
  if (s.leg2 && (s.leg2.tx_id || s.leg2.provider || s.leg2.deposit)) {
    html += `<h4>Leg 2</h4>
      Provider: ${s.leg2.provider || ""}<br>
      Tx: ${s.leg2.tx_id || ""}<br>
      Deposit: ${s.leg2.deposit || ""}
    `;
  }

  if (s.accounting) {
    const a = s.accounting;
    html += `<h4>Accounting</h4>
      XMR received: ${Number(a.xmr_received||0).toFixed(6)}<br>
      Our fee: ${Number(a.our_fee_xmr||0).toFixed(6)} XMR<br>
      XMR forwarded: ${Number(a.xmr_forwarded||0).toFixed(6)}<br>
    `;
  }

  UI.statusBox.innerHTML = html;
}

/* ---------- Boot ---------- */
window.addEventListener("load", () => {
  wireDom();
  populatePickers();

  // track the last quote so start() can reuse it
  window._lastQuote = null;

  if (UI.quoteBtn) UI.quoteBtn.onclick = async () => {
    await onQuote().then(q => { /* noop */ });
  };
  if (UI.startBtn) {
    UI.startBtn.disabled = true;
    UI.startBtn.onclick = onStart;
  }
});
