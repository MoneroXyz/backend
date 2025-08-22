(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  const swapId = params.get("sid") || params.get("swapId") || "";

  // UI step mapping
  const STEP_INDEX = { receiving:0, routing:1, sending:2, complete:3, finished:3, done:3 };

  // timers/polling
  let pollTimer = null;
  let lastStatus = null;
  let statusEndpoint = null;   // { url, from, firstJson }
  let timerHandle = null;
  let hadProviderQR = false;

  /* ---------- Icons ---------- */
  function coinIconSVG(sym){
    const s = (sym||"").toUpperCase();
    const C = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/></svg>';
    const MAP = {
      BTC: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="10"/><text x="12" y="16" font-size="10" text-anchor="middle" fill="var(--bg)"><tspan>฿</tspan></text></svg>',
      ETH: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 2l6 9-6 4-6-4 6-9zm0 20l6-10-6 4-6-4 6 10z"/></svg>',
      XMR: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="10"/><path d="M5 13l3-3 4 4 4-4 3 3v5H5z" fill="var(--bg)"/></svg>',
      USDT: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="10"/><rect x="6" y="7" width="12" height="4" rx="2" fill="var(--bg)"/></svg>',
      TRX: '<svg viewBox="0 0 24 24" width="18" height="18"><polygon points="3,5 21,7 12,21" /></svg>',
      BNB: '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="6" y="6" width="12" height="12" transform="rotate(45 12 12)"/></svg>',
      SOL: '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="5" y="7" width="14" height="3"/><rect x="5" y="11" width="14" height="3"/><rect x="5" y="15" width="14" height="3"/></svg>'
    };
    return MAP[s] || C;
  }

  /* ---------- Utils ---------- */
  const isObj = (v) => v && typeof v === "object";
  const firstTruthy = (...vals) => {
    for (const v of vals) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      return v;
    }
    return undefined;
  };
  function deepFind(obj, testFn, maxDepth=8){
    try{
      const seen = new Set();
      const stack = [obj];
      while(stack.length && maxDepth-- > 0){
        const cur = stack.shift();
        if(!isObj(cur) || seen.has(cur)) continue;
        seen.add(cur);
        for(const k of Object.keys(cur)){
          const v = cur[k];
          if(testFn(k, v, cur)) return v;
          if(isObj(v)) stack.push(v);
        }
      }
    }catch{}
    return null;
  }
  const numify = (x) => x == null ? null : (typeof x === "string" ? (x.trim()===""?null:Number(x)) : (typeof x === "number" ? x : null));

  /* ---------- Admin fallback ---------- */
  async function fetchAdminSwap(id){
    try{
      const r = await fetch(`/api/admin/swaps/${encodeURIComponent(id)}`, {cache:'no-store'});
      if(!r.ok) return null;
      return await r.json();
    }catch{ return null; }
  }
  async function fetchAdminMeta(id){
    const obj = await fetchAdminSwap(id);
    if(!obj) return null;
    const swap = obj?.swap || obj || {};
    const request = swap.request || {};
    const legs = swap.legs || swap.leg || [];
    const leg1 = Array.isArray(legs) ? (legs[0]||{}) : (swap.leg1 || {});
    let amount = request.amount ?? leg1.amount_in ?? swap.amount_in;
    let asset  = request.in_asset ?? leg1.asset_in ?? swap.in_asset;
    let network= request.in_network ?? leg1.network_in ?? swap.in_network;
    if(amount == null) amount = deepFind(swap, (k,v)=>/^(amount(_in)?|inAmount|amountIn)$/i.test(k) && numify(v)!=null);
    if(asset  == null) asset  = deepFind(swap, (k,v)=>/^(in_?asset|asset_?in|from(asset|Coin|Symbol)|coinFrom|symbol_in)$/i.test(k));
    if(network== null) network= deepFind(swap, (k,v)=>/^(in_?network|network_?in|from(Network|Chain)|chain_from|from_chain)$/i.test(k));
    amount = numify(amount) ?? amount;
    if (typeof asset === "string") asset = asset.toUpperCase();
    if (typeof network === "string") network = network.toUpperCase();
    return { amount, asset, network, raw: swap };
  }

  /* ---------- UI helpers ---------- */
  function setAddress(addr) { $("addr").textContent = addr || "—"; }
  function toDataUrlIfNeeded(qr) {
    if (!qr) return "";
    if (/^(data:|https?:)/i.test(qr)) return qr;
    if (typeof qr === "string" && qr.trim().startsWith("<svg"))
      return "data:image/svg+xml;utf8," + encodeURIComponent(qr);
    if (/^[A-Za-z0-9+/=]+$/.test(qr) && qr.length > 100)
      return `data:image/png;base64,${qr}`;
    return qr;
  }
  function setQR(src) {
    const img = $("qr");
    if (!img || !src) return;
    const processed = toDataUrlIfNeeded(src);
    if (!img.src || img.src !== processed) img.src = processed;
    img.alt = "Deposit QR";
  }
  function setFallbackQRFromAddress(addr) {
    if (!addr) return;
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(addr)}`;
    setQR(url);
  }
  function showDepositReceivedBadge() {
    const box = $("qrBox");
    if (!box) return;
    box.innerHTML = "";
    const badge = document.createElement("div");
    badge.className = "mx-qr-ok";
    badge.textContent = "✓";
    box.appendChild(badge);
  }
  function humanTimeLeft(ms) {
    if (ms <= 0) return "00:00:00";
    const s = Math.floor(ms / 1000);
    const h = String(Math.floor(s / 3600)).padStart(2,"0");
    const m = String(Math.floor((s % 3600) / 60)).padStart(2,"0");
    const ss = String(s % 60).padStart(2,"0");
    return `${h}:${m}:${ss}`;
  }

  // Persisted 25‑min visual deadline per swap
  function deadlineKey(id){ return `monerizer_timer_deadline_${id}`; }
  function getOrCreateDeadline(id, minutes=25){
    const k = deadlineKey(id);
    const saved = Number(localStorage.getItem(k) || "");
    const now = Date.now();
    // Reuse if still in the future; else create a new one
    if (Number.isFinite(saved) && saved > now) return saved;
    const newDeadline = now + minutes*60*1000;
    localStorage.setItem(k, String(newDeadline));
    return newDeadline;
  }
  function clearDeadline(id){ try { localStorage.removeItem(deadlineKey(id)); } catch {} }

  function expireUI(){
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    const q = $("qrBox"); if (q) q.innerHTML = "";
    const addr = $("addr"); if (addr) addr.textContent = "—";
    const btn = $("copyBtn"); if (btn) { btn.disabled = true; btn.textContent = "Expired"; }
    const exp = $("expiredBox"); if (exp) exp.classList.remove("mx-hidden");
  }

  function ensureTimerForSwap(id){
    const tl = $("timeLeft");
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    const deadline = getOrCreateDeadline(id, 25);
    const tick = () => {
      const left = deadline - Date.now();
      if (tl) tl.textContent = humanTimeLeft(left);
      if (left <= 0) { clearInterval(timerHandle); timerHandle = null; expireUI(); clearDeadline(id); }
    };
    tick();
    timerHandle = setInterval(tick, 1000);
  }

  function showTimer(show) {
    const tl = $("timeLeft");
    if (!tl) return;
    tl.parentElement.style.visibility = show ? "visible" : "hidden";
  }

  function updateSteps(status) {
    const norm = (status || "").toLowerCase();
    const idx = STEP_INDEX[norm] ?? STEP_INDEX.receiving;
    const steps = Array.from(document.querySelectorAll("#steps .mx-step"));
    steps.forEach((li, i) => {
      li.classList.remove("done","active","upcoming");
      if (i < idx) li.classList.add("done");
      else if (i === idx) li.classList.add("active");
      else li.classList.add("upcoming");
    });
    showTimer(true);
  }

  /* ---------- Status normalization ---------- */
  function normalizeDeadline(obj) {
    const iso = firstTruthy(obj?.expires_at, obj?.time_left_iso, obj?.deadline, obj?.expire_at);
    if (iso) return iso;
    const sec = Number(firstTruthy(obj?.expires_in, obj?.time_left_seconds, obj?.ttl, obj?.ttl_seconds));
    if (Number.isFinite(sec) && sec > 0) {
      return new Date(Date.now() + sec * 1000).toISOString();
    }
    return null;
  }
  function mapProviderStatusToUI(s){
    const x = (s||"").toLowerCase();
    if (!x) return "receiving";
    if (/(confirm|detected|payin|received|pending)/.test(x)) return "routing"; // as soon as deposit seen
    if (/(sending|payout|transfer_out|broadcast_out)/.test(x)) return "sending";
    if (/(complete|finished|done|success)/.test(x)) return "complete";
    if (/(refund)/.test(x)) return "receiving"; // keep it in first bubble for UI
    return x;
  }
  function normalizeFromDirect(raw) {
    const statusRaw = firstTruthy(raw.status, raw.state, raw.stage, "receiving");
    return {
      address: firstTruthy(raw.deposit_address, raw.address, raw.addr, raw.depositAddr),
      qr: firstTruthy(raw.qr_png, raw.qr, raw.deposit_qr, raw.qr_image, raw.qr_base64, raw.qrPng, raw.qrUrl),
      status: mapProviderStatusToUI(statusRaw),
      deadline: normalizeDeadline(raw),
      amount: firstTruthy(raw.in_amount, raw.amount_in, raw.amount),
      asset: firstTruthy(raw.in_asset, raw.asset_in, raw.asset),
      network: firstTruthy(raw.in_network, raw.network_in, raw.network)
    };
  }
  function normalizeFromAdmin(raw) {
    const swap = raw.swap || raw;
    const leg1 = swap.leg1 || (Array.isArray(swap.legs) ? swap.legs[0] : {}) || {};
    const pinfo = leg1.provider_info || leg1.info || {};

    const address = firstTruthy(
      pinfo.deposit_address, pinfo.address, pinfo.addr, pinfo.payin_address, pinfo.address_in,
      leg1.deposit_address, leg1.address
    );
    const qr = firstTruthy(
      pinfo.qr_png, pinfo.qr, pinfo.deposit_qr, pinfo.qr_image, pinfo.qr_base64, pinfo.qrPng, pinfo.qrUrl
    );

    // Status (with heuristic: any deposit evidence => routing)
    let s = firstTruthy(swap.status, swap.state, leg1.status, pinfo.status, pinfo.state, pinfo.stage, "receiving");
    const depositHints = ["payin_hash","payinTxId","payin_tx","txid","deposit_received","received","confirmations","payin_confirmations","amount_received","in_confirmations"];
    const hasDeposit = depositHints.some(k => deepFind(pinfo, (kk,v)=>kk===k && v!=null) != null);
    if (hasDeposit) s = "routing";

    return {
      address, qr,
      status: mapProviderStatusToUI(s),
      deadline: normalizeDeadline(pinfo) || normalizeDeadline(swap) || null,
      amount: null, asset: null, network: null
    };
  }

  async function detectStatusEndpoint(id) {
    const quick = [
      `/api/checkout?sid=${encodeURIComponent(id)}`,
      `/api/status?sid=${encodeURIComponent(id)}`,
      `/api/order?sid=${encodeURIComponent(id)}`,
      `/api/swap?sid=${encodeURIComponent(id)}`,
      `/api/checkout/${encodeURIComponent(id)}`,
      `/api/status/${encodeURIComponent(id)}` // path param variant
    ];
    for (const url of quick) {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (r.ok) {
          const firstJson = await r.json().catch(() => ({}));
          return { url, firstJson, from: "direct" };
        }
      } catch(_) {}
    }
    // fallback to admin
    try {
      const url = `/api/admin/swaps/${encodeURIComponent(id)}`;
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok) {
        const firstJson = await r.json().catch(() => ({}));
        return { url, firstJson, from: "admin" };
      }
    } catch(_) {}
    return null;
  }

  function normalizeData(raw, from) {
    try { return from === "admin" ? normalizeFromAdmin(raw) : normalizeFromDirect(raw); }
    catch { return { address:"", qr:"", status:"receiving", deadline:null }; }
  }

  function renderAmountReminder(amount, asset, network) {
    const box = $("amountLine");
    if (!box) return;
    $("needAmount").textContent = (amount ?? "—").toString();
    $("needAsset").textContent = asset ? String(asset) : "—";
    $("needNet").textContent   = network ? `(${network})` : "";
    const sym = (asset||"").toUpperCase();
    const iconHost = $("needIcon"); if (iconHost){ iconHost.innerHTML = coinIconSVG(sym); iconHost.style.display="inline-flex"; }
    box.hidden = false;
  }

  async function pollOnce() {
    if (!statusEndpoint) return;
    try {
      const r = await fetch(statusEndpoint.url, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const raw = await r.json();
      const data = normalizeData(raw, statusEndpoint.from);

      setAddress(data.address);
      if (data.qr) { hadProviderQR = true; setQR(data.qr); }
      else if (!hadProviderQR && data.address) { setFallbackQRFromAddress(data.address); }

      // Amount/asset/network — try direct then admin meta
      if (data.amount && data.asset) {
        renderAmountReminder(data.amount, data.asset, data.network);
      } else {
        fetchAdminMeta(swapId).then(meta => {
          if(meta) renderAmountReminder(meta.amount, meta.asset, meta.network);
        });
      }

      updateSteps(data.status);

      // Receiving -> Routing tick when deposit is detected
      if (lastStatus !== data.status) {
        if (lastStatus === null && data.status !== "receiving") showDepositReceivedBadge();
        else if (lastStatus === "receiving" && data.status !== "receiving") showDepositReceivedBadge();
        lastStatus = data.status;
      }

      // Stop polling on completion
      if (["complete","finished","done"].includes((data.status||"").toLowerCase())) {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        // Show big ✓ and clear deadline so a refresh doesn't show timer again
        showDepositReceivedBadge();
        clearDeadline(swapId);
      }
    } catch { /* keep polling */ }
  }

  // boot
  (async function init(){
    $("swapIdLine").textContent = swapId || "—";
    $("copyBtn")?.addEventListener("click", async () => {
      const txt = $("addr")?.textContent || "";
      if (!txt || txt === "—") return;
      try { await navigator.clipboard.writeText(txt); $("copyBtn").textContent = "Copied!"; setTimeout(() => $("copyBtn").textContent = "Copy", 1200); } catch {}
    });

    if (!swapId) return;

    // Persisted 25‑minute visual timer per swap (no reset on refresh)
    ensureTimerForSwap(swapId);
    showTimer(true);

    // Detect best status endpoint
    const found = await detectStatusEndpoint(swapId);
    if (!found) {
      const msg = document.createElement("div");
      msg.className = "mx-softerr";
      msg.textContent = "Waiting for provider… (order created, status endpoint not ready yet)";
      document.querySelector(".mx-card").appendChild(msg);
      setTimeout(init, 2000);
      return;
    }
    statusEndpoint = found;

    // First paint
    const first = normalizeData(found.firstJson || {}, found.from);
    setAddress(first.address);
    if (first.qr) { hadProviderQR = true; setQR(first.qr); }
    else if (first.address) { setFallbackQRFromAddress(first.address); }

    if (first.amount && first.asset) renderAmountReminder(first.amount, first.asset, first.network);
    else {
      const meta = await fetchAdminMeta(swapId);
      if (meta) renderAmountReminder(meta.amount, meta.asset, meta.network);
    }

    updateSteps(first.status);
    lastStatus = first.status;

    // Start live polling
    pollTimer = setInterval(pollOnce, 5000);
  })();
})();
