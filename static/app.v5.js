/* Monerizer UI (v6) - best route + show/hide others + status lights */

const ASSETS = [
  { symbol: "USDT", name: "Tether USD", networks: ["ETH","TRX","BSC"] },
  { symbol: "USDC", name: "USD Coin", networks: ["ETH"] },
  { symbol: "BTC",  name: "Bitcoin", networks: ["BTC"] },
  { symbol: "ETH",  name: "Ethereum", networks: ["ETH"] },
  { symbol: "LTC",  name: "Litecoin", networks: ["LTC"] },
  { symbol: "XMR",  name: "Monero", networks: ["XMR"] },
];

let chosen = null;           // chosen route (object)
let pollTimer = null;        // watch loop
let lastQuote = null;        // full quote response (to re-render others)
let othersVisible = false;   // toggle state for other routes

// ------------- DOM helpers -------------
const $ = (id) => document.getElementById(id);
const fmt = (n, d=8) => Number(n ?? 0).toFixed(d).replace(/\.?0+$/,"");

function setHidden(el, hide) {
  if (!el) return;
  if (hide) el.classList.add("hidden");
  else el.classList.remove("hidden");
}

// ------------- Populate selects -------------
function fillAssets() {
  const fa = $("fromAsset"), ta = $("toAsset");
  fa.innerHTML = ""; ta.innerHTML = "";
  for (const a of ASSETS) {
    fa.add(new Option(a.symbol, a.symbol));
    ta.add(new Option(a.symbol, a.symbol));
  }
  fa.value = "USDT";
  ta.value = "BTC";
  fillNetworks("from");
  fillNetworks("to");
}
function fillNetworks(side) {
  const assetSel = $(side === "from" ? "fromAsset" : "toAsset");
  const netSel   = $(side === "from" ? "fromNet"   : "toNet");
  const a = ASSETS.find(x => x.symbol === assetSel.value);
  netSel.innerHTML = "";
  (a?.networks || []).forEach(n => netSel.add(new Option(n, n)));
  if (a?.symbol === "XMR") netSel.value = "XMR";
}
$("fromAsset").addEventListener("change", () => fillNetworks("from"));
$("toAsset").addEventListener("change", () => fillNetworks("to"));

// ------------- Quote -------------
$("btnQuote").addEventListener("click", async () => {
  try {
    $("btnQuote").disabled = true;
    chosen = null;
    lastQuote = null;
    othersVisible = false;
    $("bestRoute").innerHTML = "";
    $("otherRoutes").innerHTML = "";
    setHidden($("otherRoutesRow"), true);

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
    lastQuote = data;

    if (!data?.options?.length) {
      $("bestRoute").innerHTML = `<div class="route">No routes returned.</div>`;
      return;
    }

    // Render best route only
    renderBestRoute(data);
    // Prepare other routes (hidden by default)
    renderOtherRoutes(data);

    // show toggle button if there are other routes
    const countOthers = Math.max(0, (data.options?.length || 0) - 1);
    if (countOthers > 0) {
      $("btnToggleRoutes").textContent = `Show ${countOthers} other route${countOthers>1?"s":""}`;
      setHidden($("otherRoutesRow"), false);
      setHidden($("otherRoutes"), true);
      othersVisible = false;
    } else {
      setHidden($("otherRoutesRow"), true);
      setHidden($("otherRoutes"), true);
    }
  } catch (e) {
    $("bestRoute").innerHTML = `<div class="route">Failed to quote: ${e}</div>`;
  } finally {
    $("btnQuote").disabled = false;
  }
});

$("btnToggleRoutes").addEventListener("click", () => {
  if (!lastQuote || !lastQuote.options) return;
  const countOthers = Math.max(0, (lastQuote.options.length || 0) - 1);
  othersVisible = !othersVisible;
  setHidden($("otherRoutes"), !othersVisible);
  $("btnToggleRoutes").textContent = othersVisible
    ? `Hide ${countOthers} other route${countOthers>1?"s":""}`
    : `Show ${countOthers} other route${countOthers>1?"s":""}`;
});

// Helpers to render a single route card
function routeCard(opt, req, rank) {
  return `
<div class="kv"><div><b>${opt.leg1.provider}</b> → <b>${opt.leg2.provider}</b></div><span class="badge">rank #${rank}${rank===1 ? " · BEST" : ""}</span></div>
<div class="kv"><div class="muted">Leg 1</div><div>${fmt(opt.leg1.amount_from,6)} ${req.in_asset} → ${fmt(opt.leg1.amount_to,6)} XMR</div></div>
<div class="kv"><div class="muted">Leg 2 (est)</div><div>${fmt(opt.leg2.amount_to,6)} ${req.out_asset}</div></div>
<div class="kv"><div class="muted">Our fee</div><div>${fmt(opt.fee.our_fee_xmr,6)} XMR</div></div>
<div class="kv"><div class="muted">Receive (est.)</div><div><b>${fmt(opt.receive_out,8)} ${req.out_asset}</b></div></div>
<div class="row gap">
  <button class="btn-choose" data-rank="${rank}">Choose</button>
</div>`;
}

function bindChooseButtons(q) {
  [...document.querySelectorAll(".btn-choose")].forEach(btn => {
    btn.addEventListener("click", () => {
      const rank = Number(btn.dataset.rank);
      const i = Math.max(0, rank - 1);
      chosen = q.options[i];
      $("leg1Prov").value = chosen.leg1.provider;
      $("leg2Prov").value = chosen.leg2.provider || "";
      $("startOut").classList.add("hidden");
      $("btnStart").dataset.ctx = JSON.stringify(q.request);
      document.querySelector(".card h2:nth-of-type(2)")?.scrollIntoView({behavior:"smooth", block:"start"});
    });
  });
}

function renderBestRoute(q) {
  const best = q.options[0];
  $("bestRoute").innerHTML = `<div class="route">${routeCard(best, q.request, 1)}</div>`;
  bindChooseButtons(q);
}

function renderOtherRoutes(q) {
  const rest = (q.options || []).slice(1);
  if (rest.length === 0) {
    $("otherRoutes").innerHTML = "";
    return;
  }
  const frag = document.createDocumentFragment();
  rest.forEach((opt, idx) => {
    const d = document.createElement("div");
    d.className = "route";
    d.innerHTML = routeCard(opt, q.request, idx + 2);
    frag.appendChild(d);
  });
  $("otherRoutes").innerHTML = "";
  $("otherRoutes").appendChild(frag);
  bindChooseButtons(q);
}

// ------------- Start -------------
$("btnStart").addEventListener("click", async () => {
  try {
    if (!chosen) return alert("Choose a route first.");
    const payout = $("payout").value.trim();
    if (!payout) return alert("Enter payout address.");

    const reqCtx = JSON.parse($("btnStart").dataset.ctx || "{}");
    const body = {
      leg1_provider: $("leg1Prov").value,
      leg2_provider: $("leg2Prov").value || null,
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

// ------------- Status (watch / lights) -------------
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

/* === UPDATED: step inference so pill #1 doesn't skip === */
function computeStepsFromSwap(swap) {
  // Buckets for provider status strings (lowercased)
  const WAITING = new Set([
    "waiting", "waiting_for_deposit", "awaiting", "new",
    "no_deposits", "pending", "hold", "need_kyt"
  ]);
  const PROCESS = new Set(["confirming", "exchanging", "sending", "processing"]);
  const DONE    = new Set(["finished", "success", "completed", "complete", "done", "paid", "refunded"]);

  const leg1Info = (swap.leg1 && swap.leg1.provider_info) || {};
  const leg2Info = (swap.leg2 && swap.leg2.provider_info) || {};

  const leg1Status = (leg1Info.status || leg1Info.state || "").toString().toLowerCase();
  const leg2Status = (leg2Info.status || leg2Info.state || "").toString().toLowerCase();

  // defaults
  let waitingDeposit  = true;
  let leg1Processing  = false;
  let leg1Complete    = false;
  let waitingUnlock   = false;
  let leg2Sent        = false;
  let leg2Processing  = false;
  let complete        = false;

  // If we have no provider_info yet (right after start), still show "waiting deposit"
  // Keep waitingDeposit ON while provider says "waiting/awaiting/pending".
  if (leg1Status) {
    if (WAITING.has(leg1Status)) {
      waitingDeposit = true;
    } else if (PROCESS.has(leg1Status)) {
      waitingDeposit = false;
      leg1Processing = true;
    } else if (DONE.has(leg1Status)) {
      waitingDeposit = false;
      leg1Complete = true;
    } else {
      // unknown string: be conservative, keep waiting ON until we see PROCESS/DONE
      waitingDeposit = true;
    }
  } else {
    // no status yet -> still waiting for deposit
    waitingDeposit = true;
  }

  // After leg1 complete but before leg2 is created, we wait for wallet unlock
  if (leg1Complete && !(swap.leg2 && swap.leg2.created)) waitingUnlock = true;

  // Leg 2 creation / send
  if (swap.leg2 && swap.leg2.created) {
    waitingUnlock = false;
    leg2Sent = true;
  }
  if (swap.last_sent_txid) leg2Sent = true;

  // Leg 2 provider lifecycle
  if (PROCESS.has(leg2Status) && !DONE.has(leg2Status)) leg2Processing = true;
  if (DONE.has(leg2Status)) { leg2Sent = true; leg2Processing = false; complete = true; }

  // timeline hints
  const tl = new Set(swap.timeline || []);
  if (tl.has("routing_xmr_to_leg2")) { leg2Sent = true; waitingUnlock = false; }

  return { waitingDeposit, leg1Processing, leg1Complete, waitingUnlock, leg2Sent, leg2Processing, complete };
}

function drawSteps(swap) {
  const el = $("statusSteps");
  el.innerHTML = "";
  const steps = computeStepsFromSwap(swap);
  const order = [
    ["waiting deposit",  steps.waitingDeposit],
    ["leg1 processing",  steps.leg1Processing],
    ["leg1 complete",    steps.leg1Complete],
    ["waiting unlock",   steps.waitingUnlock],
    ["leg2 sent",        steps.leg2Sent],
    ["leg2 processing",  steps.leg2Processing],
    ["complete",         steps.complete],
  ];
  for (const [name, on] of order) {
    const d = document.createElement("div");
    d.className = "step" + (on ? " on" : "");
    d.textContent = name;
    el.appendChild(d);
  }
  const pre = $("statusJson");
  pre.textContent = JSON.stringify(swap, null, 2);
  pre.classList.remove("hidden");
}

// ------------- boot -------------
document.addEventListener("DOMContentLoaded", () => {
  fillAssets();
});
