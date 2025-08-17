/* Monerizer UI (v6) – matches FastAPI contract exactly */

const ASSETS = [
  { symbol: "USDT", name: "Tether USD", networks: ["ETH","TRX","BSC"] },
  { symbol: "USDC", name: "USD Coin", networks: ["ETH"] },
  { symbol: "BTC",  name: "Bitcoin",     networks: ["BTC"] },
  { symbol: "ETH",  name: "Ethereum",    networks: ["ETH"] },
  { symbol: "LTC",  name: "Litecoin",    networks: ["LTC"] },
  { symbol: "XMR",  name: "Monero",      networks: ["XMR"] },
];

let chosen = null;     // chosen route (object)
let pollTimer = null;  // watch loop

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
const fmt = (n, d=8) => Number(n ?? 0).toFixed(d).replace(/\.?0+$/,"");

// ---------- Populate selects ----------
function fillAssets() {
  const fa = $("fromAsset"), ta = $("toAsset");
  fa.innerHTML = ""; ta.innerHTML = "";
  for (const a of ASSETS) {
    fa.add(new Option(`${a.symbol}`, a.symbol));
    ta.add(new Option(`${a.symbol}`, a.symbol));
  }
  fa.value = "USDT"; ta.value = "BTC";
  fillNetworks("from");
  fillNetworks("to");
}

function fillNetworks(side) {
  const assetSel = $(side === "from" ? "fromAsset" : "toAsset");
  const netSel   = $(side === "from" ? "fromNet"   : "toNet");
  const a = ASSETS.find(x => x.symbol === assetSel.value);
  netSel.innerHTML = "";
  (a?.networks || []).forEach(n => netSel.add(new Option(n, n)));
  // pick the first network; special-case XMR
  if (a?.symbol === "XMR") netSel.value = "XMR";
}

$("fromAsset").addEventListener("change", () => fillNetworks("from"));
$("toAsset").addEventListener("change", () => fillNetworks("to"));

// ---------- Quote ----------
$("btnQuote").addEventListener("click", async () => {
  try {
    $("btnQuote").disabled = true;
    chosen = null;
    $("quoteBox").innerHTML = `

Fetching quotes…

`;
    const body = {
      in_asset: $("fromAsset").value,
      in_network: $("fromNet").value,
      out_asset: $("toAsset").value,
      out_network: $("toNet").value,
      amount: Number($("amount").value),
      rate_type: $("rateType").value
    };
    const r = await fetch("/api/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Quote HTTP ${r.status}`);
    const data = await r.json();

    if (!data?.options?.length) {
      $("quoteBox").innerHTML = `

No routes returned.

`;
      return;
    }
    renderRoutes(data);
  } catch (e) {
    $("quoteBox").innerHTML = `

Failed to quote: ${e}

`;
  } finally {
    $("btnQuote").disabled = false;
  }
});

function renderRoutes(q) {
  const box = $("quoteBox");
  box.innerHTML = "";

  q.options.forEach((opt, i) => {
    const el = document.createElement("div");
    el.className = "route";
    el.innerHTML = `
<div class="kv"><div><b>${opt.leg1.provider}</b> → <b>${opt.leg2.provider}</b></div><span class="badge">best rank #${i+1}${i===0 ? " · BEST" : ""}</span></div>

<div class="kv"><div class="muted">Leg 1</div><div>${fmt(opt.leg1.amount_from,6)} ${q.request.in_asset} → ${fmt(opt.leg1.amount_to,6)} XMR</div></div>

<div class="kv"><div class="muted">Leg 2 (est)</div><div>${fmt(opt.leg2.amount_to,6)} ${q.request.out_asset}</div></div>

<div class="kv"><div class="muted">Our fee</div><div>${fmt(opt.fee.our_fee_xmr,6)} XMR</div></div>

<div class="kv"><div class="muted">Receive (est.)</div><div><b>${fmt(opt.receive_out,8)} ${q.request.out_asset}</b></div></div>

<div class="row gap">
  <button class="btn-choose" data-i="${i}">Choose</button>
</div>
`;
    box.appendChild(el);
  });

  // hook choose buttons
  [...document.querySelectorAll(".btn-choose")].forEach(btn => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.i);
      chosen = q.options[i];
      // prefill providers and remember fee
      $("leg1Prov").value = chosen.leg1.provider;
      $("leg2Prov").value = chosen.leg2.provider || "";
      $("startOut").classList.add("hidden");
      // stash request context for start()
      $("btnStart").dataset.ctx = JSON.stringify(q.request);
    });
  });
}

// ---------- Start ----------
$("btnStart").addEventListener("click", async () => {
  try {
    if (!chosen) return alert("Choose a route first.");
    const payout = $("payout").value.trim();
    if (!payout) return alert("Enter payout address.");
    const reqCtx = JSON.parse($("btnStart").dataset.ctx || "{}");

    const body = {
      leg1_provider: $("leg1Prov").value,
      leg2_provider: $("leg2Prov").value || null, // let server auto if blank
      in_asset:  reqCtx.in_asset,
      in_network:reqCtx.in_network,
      out_asset: reqCtx.out_asset,
      out_network:reqCtx.out_network,
      amount: Number(reqCtx.amount),
      payout_address: payout,
      rate_type: reqCtx.rate_type,
      our_fee_xmr: Number(chosen?.fee?.our_fee_xmr || 0)
    };

    $("btnStart").disabled = true;
    const r = await fetch("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.detail || r.status);

    $("sid").textContent = j.swap_id;
    $("deposit").textContent = j.deposit_address || "";
    $("memoWrap").textContent = j.deposit_extra ? ` · Memo/Tag: ${j.deposit_extra}` : "";
    $("startOut").classList.remove("hidden");
    $("swapId").value = j.swap_id;
  } catch (e) {
    alert("Start failed: " + e);
  } finally {
    $("btnStart").disabled = false;
  }
});

// ---------- Status ----------
$("btnStatus").addEventListener("click", () => fetchStatus());
$("btnWatch").addEventListener("click", () => {
  if (pollTimer) clearInterval(pollTimer);
  fetchStatus();
  pollTimer = setInterval(fetchStatus, 3000);
});
$("btnStop").addEventListener("click", () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
});

async function fetchStatus() {
  const id = $("swapId").value.trim();
  if (!id) return;
  try {
    const r = await fetch(`/api/status/${encodeURIComponent(id)}`);
    const j = await r.json();
    drawSteps(j);
  } catch (e) {
    console.error(e);
  }
}

/* --- NEW: infer step lights from the raw swap JSON --- */
function computeStepsFromSwap(swap) {
  const done = new Set(["finished","success","completed","complete","done"]);
  const processing = new Set(["confirming","exchanging","sending","pending","processing","awaiting","waiting"]);

  const leg1Info = (swap.leg1 && swap.leg1.provider_info) || {};
  const leg2Info = (swap.leg2 && swap.leg2.provider_info) || {};

  const leg1Status = (leg1Info.status || leg1Info.state || "").toString().toLowerCase();
  const leg2Status = (leg2Info.status || leg2Info.state || "").toString().toLowerCase();

  let waitingDeposit  = true;
  let leg1Processing  = false;
  let leg1Complete    = false;
  let waitingUnlock   = false;
  let leg2Sent        = false;
  let leg2Processing  = false;
  let complete        = false;

  // Once provider has an order, we are out of waiting_deposit
  if (swap.leg1 && swap.leg1.order) waitingDeposit = false;

  // Leg1 transitions
  if (processing.has(leg1Status)) leg1Processing = true;
  if (done.has(leg1Status)) {
    leg1Processing = false;
    leg1Complete = true;
  }

  // After leg1 complete but before leg2 created we are waiting for unlock
  if (leg1Complete && !(swap.leg2 && swap.leg2.created)) waitingUnlock = true;

  // Leg2 creation / send
  if (swap.leg2 && swap.leg2.created) {
    waitingUnlock = false;
    leg2Sent = true;
  }
  // If we already broadcast XMR, also count as sent
  if (swap.last_sent_txid) leg2Sent = true;

  // Leg2 provider status
  if (processing.has(leg2Status) && !done.has(leg2Status)) leg2Processing = true;
  if (done.has(leg2Status)) {
    leg2Sent = true;
    leg2Processing = false;
    complete = true;
  }

  // Fallback: timeline hints (optional)
  const tl = new Set(swap.timeline || []);
  if (tl.has("waiting_deposit")) waitingDeposit = true;
  if (tl.has("routing_xmr_to_leg2")) { leg2Sent = true; waitingUnlock = false; }

  return {
    waitingDeposit, leg1Processing, leg1Complete,
    waitingUnlock, leg2Sent, leg2Processing, complete
  };
}

function drawSteps(swap) {
  // Build the seven status pills, turning "on" those that apply
  const el = $("statusSteps");
  el.innerHTML = "";
  const steps = computeStepsFromSwap(swap);

  const order = [
    ["waiting_deposit",  steps.waitingDeposit],
    ["leg1_processing",  steps.leg1Processing],
    ["leg1_complete",    steps.leg1Complete],
    ["waiting_unlock",   steps.waitingUnlock],
    ["leg2_sent",        steps.leg2Sent],
    ["leg2_processing",  steps.leg2Processing],
    ["complete",         steps.complete],
  ];

  for (const [name, on] of order) {
    const d = document.createElement("div");
    d.className = "step" + (on ? " on" : "");
    d.textContent = name.replaceAll("_"," ");
    el.appendChild(d);
  }

  // Keep the raw JSON below for debugging
  const pre = $("statusJson");
  pre.textContent = JSON.stringify(swap, null, 2);
  pre.classList.remove("hidden");
}

// ---------- boot ----------
document.addEventListener("DOMContentLoaded", () => {
  fillAssets();
});
