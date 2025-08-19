/* Monerizer UI (v7.1) – best route first + toggle others + proper status lights */
const ASSETS = [
  { symbol: "USDT", name: "Tether USD", networks: ["ETH","TRX","BSC"] },
  { symbol: "USDC", name: "USD Coin", networks: ["ETH"] },
  { symbol: "BTC",  name: "Bitcoin",   networks: ["BTC"] },
  { symbol: "ETH",  name: "Ethereum",  networks: ["ETH"] },
  { symbol: "LTC",  name: "Litecoin",  networks: ["LTC"] },
  { symbol: "XMR",  name: "Monero",    networks: ["XMR"] },
];

let chosen = null;
let pollTimer = null;

const $ = (id) => document.getElementById(id);
const fmt = (n, d=8) => Number(n ?? 0).toFixed(d).replace(/\.?0+$/,"");

/* ---------- Populate selects ---------- */
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
  if (a?.symbol === "XMR") netSel.value = "XMR";
}
$("fromAsset").addEventListener("change", () => fillNetworks("from"));
$("toAsset").addEventListener("change", () => fillNetworks("to"));

/* ---------- Provider selects helper ---------- */
function ensureProviderOptionsFromQuotes(q) {
  const provs = new Set();
  (q?.options || []).forEach(o => {
    if (o?.leg1?.provider) provs.add(o.leg1.provider);
    if (o?.leg2?.provider) provs.add(o.leg2.provider);
  });
  ["ChangeNOW","Exolix","SimpleSwap","StealthEX"].forEach(p => provs.add(p));
  const l1 = $("leg1Prov"), l2 = $("leg2Prov");
  const have = (sel, name) => [...sel.options].some(o => o.value === name);
  provs.forEach(p => {
    if (!have(l1,p)) l1.add(new Option(p,p));
    if (!have(l2,p)) l2.add(new Option(p,p));
  });
}

/* ---------- Quote ---------- */
$("btnQuote").addEventListener("click", async () => {
  try {
    $("btnQuote").disabled = true;
    chosen = null;
    $("quoteBox").innerHTML = `<div class="muted">Fetching quotes…</div>`;

    const body = {
      in_asset: $("fromAsset").value,
      in_network: $("fromNet").value,
      out_asset: $("toAsset").value,
      out_network: $("toNet").value,
      amount: Number($("amount").value),
      rate_type: $("rateType").value
    };
    const r = await fetch("/api/quote", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`Quote HTTP ${r.status}`);
    const data = await r.json();

    if (!data?.options?.length) {
      $("quoteBox").innerHTML = `<div class="muted">No routes returned.</div>`;
      return;
    }
    ensureProviderOptionsFromQuotes(data);
    renderRoutesBestFirst(data);
  } catch (e) {
    $("quoteBox").innerHTML = `<div class="muted">Failed to quote: ${e}</div>`;
  } finally {
    $("btnQuote").disabled = false;
  }
});

function renderRoutesBestFirst(q) {
  const box = $("quoteBox");
  box.innerHTML = "";

  // sort already done server-side, but be safe:
  const routes = [...q.options].sort((a,b)=> (b.receive_out - a.receive_out));
  const best = routes[0];
  const rest = routes.slice(1);

  // BEST card
  const bestEl = document.createElement("div");
  bestEl.className = "route";
  bestEl.innerHTML = `
    <div class="kv">
      <div><strong>${best.leg1.provider}</strong> → <strong>${best.leg2.provider}</strong> <span class="best-tag">BEST</span></div>
      <div class="badge">rank #1</div>
    </div>
    <div class="row"><div class="kv"><div>Leg 1</div><div>${fmt(best.leg1.amount_from,6)} ${q.request.in_asset} → ${fmt(best.leg1.amount_to,6)} XMR</div></div></div>
    <div class="row"><div class="kv"><div>Our fee</div><div>${fmt(best.fee.our_fee_xmr,6)} XMR</div></div></div>
    <div class="row"><div class="kv"><div>Leg 2 (est)</div><div>${fmt(best.leg2.amount_to,6)} ${q.request.out_asset}</div></div></div>
    <div class="row"><div class="kv"><div><strong>Receive (est.)</strong></div><div><strong>${fmt(best.receive_out,8)} ${q.request.out_asset}</strong></div></div></div>
    <div class="row"><button class="btn-choose" data-i="0">Choose best</button></div>
  `;
  box.appendChild(bestEl);

  // Toggle for others
  const toggleWrap = document.createElement("div");
  toggleWrap.className = "toggle-wrap";
  const btnId = "btnToggleOthers";
  toggleWrap.innerHTML = `
    <button id="${btnId}" class="toggle-btn">${rest.length ? `Show ${rest.length} more route${rest.length>1?"s":""}` : "No other routes"}</button>
  `;
  box.appendChild(toggleWrap);

  const othersWrap = document.createElement("div");
  othersWrap.id = "othersWrap";
  othersWrap.className = rest.length ? "": "hidden";
  rest.forEach((opt, i) => {
    const el = document.createElement("div");
    el.className = "route";
    el.innerHTML = `
      <div class="kv">
        <div><strong>${opt.leg1.provider}</strong> → <strong>${opt.leg2.provider}</strong></div>
        <div class="badge">rank #${i+2}</div>
      </div>
      <div class="row"><div class="kv"><div>Leg 1</div><div>${fmt(opt.leg1.amount_from,6)} ${q.request.in_asset} → ${fmt(opt.leg1.amount_to,6)} XMR</div></div></div>
      <div class="row"><div class="kv"><div>Our fee</div><div>${fmt(opt.fee.our_fee_xmr,6)} XMR</div></div></div>
      <div class="row"><div class="kv"><div>Leg 2 (est)</div><div>${fmt(opt.leg2.amount_to,6)} ${q.request.out_asset}</div></div></div>
      <div class="row"><div class="kv"><div><strong>Receive (est.)</strong></div><div><strong>${fmt(opt.receive_out,8)} ${q.request.out_asset}</strong></div></div></div>
      <div class="row"><button class="btn-choose" data-i="${i+1}">Choose</button></div>
    `;
    othersWrap.appendChild(el);
  });
  if (rest.length) box.appendChild(othersWrap);

  // Toggle behavior
  setTimeout(() => {
    const b = $(btnId);
    if (b && rest.length) {
      b.addEventListener("click", () => {
        const isHidden = othersWrap.classList.toggle("hidden");
        b.textContent = isHidden ? `Show ${rest.length} more route${rest.length>1?"s":""}` : "Hide other routes";
      });
    } else if (b && !rest.length) {
      b.disabled = true;
    }
  }, 0);

  // Hook choose buttons (best + others)
  [...box.querySelectorAll(".btn-choose")].forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.i);
      const route = routes[idx];
      chosen = route;
      $("leg1Prov").value = route.leg1.provider;
      $("leg2Prov").value = route.leg2.provider || "";
      $("startOut").classList.add("hidden"); // reset start section
      $("btnStart").dataset.ctx = JSON.stringify(q.request);
    });
  });
}

/* ---------- Start ---------- */
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
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.detail || JSON.stringify(j));

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

/* ---------- Status ---------- */
$("btnStatus").addEventListener("click", () => fetchStatus());
$("btnWatch").addEventListener("click", () => {
  if (pollTimer) clearInterval(pollTimer);
  fetchStatus();
  pollTimer = setInterval(fetchStatus, 3000);
});
$("btnStop").addEventListener("click", () => {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
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

function drawSteps(s) {
  const el = $("statusSteps");
  el.innerHTML = "";

  // This must match backend "timeline" semantics
  const tl = Array.isArray(s?.timeline) ? s.timeline : [];
  const names = ["created","waiting_deposit","leg1_processing","leg1_complete","awaiting_wallet_unlocked","routing_xmr_to_leg2","leg2_processing","complete"];

  names.forEach(name => {
    const d = document.createElement("div");
    const isOn = tl.includes(name) || s?.status === name;
    d.className = "step" + (isOn ? " on" : "");
    d.textContent = name.replaceAll("_"," ");
    el.appendChild(d);
  });

  const pre = $("statusJson");
  pre.textContent = JSON.stringify(s, null, 2);
  pre.classList.remove("hidden");
}

/* ---------- boot ---------- */
document.addEventListener("DOMContentLoaded", () => {
  fillAssets();
  // Ensure provider dropdowns include all providers
  ["ChangeNOW","Exolix","SimpleSwap","StealthEX"].forEach(p => {
    if (![...$("leg1Prov").options].some(o=>o.value===p)) $("leg1Prov").add(new Option(p,p));
    if (![...$("leg2Prov").options].some(o=>o.value===p)) $("leg2Prov").add(new Option(p,p));
  });
});
