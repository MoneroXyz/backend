(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  const swapId = params.get("sid") || params.get("swapId") || "";

  // Step mapping
  const STEP_INDEX = { receiving:0, routing:1, sending:2, complete:3, finished:3, done:3 };

  let pollTimer = null;
  let lastStatus = null;           // "receiving" | "routing" | "sending" | "complete"
  let statusEndpoint = null;       // { url, from, firstJson }
  let timerHandle = null;
  let hadProviderQR = false;

  /* ---------- Icons (inline SVG) ---------- */
  function coinIconSVG(sym){
    const s = (sym||"").toUpperCase();
    const M = {
      BTC:`<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="11" fill="#F7931A"/><text x="12" y="16" font-size="10" font-weight="700" fill="#fff" text-anchor="middle">฿</text></svg>`,
      ETH:`<svg viewBox="0 0 24 24" width="22" height="22"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3C3C3D"/><stop offset="1" stop-color="#8C8C8C"/></linearGradient></defs><path d="M12 2l6 9-6 4-6-4 6-9z" fill="url(#g)"/><path d="M12 22l6-10-6 4-6-4 6 10z" fill="#8C8C8C"/></svg>`,
      XMR:`<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="11" fill="#FF6600"/><path d="M5 13l3-3 4 4 4-4 3 3v5H5z" fill="#fff"/></svg>`,
      USDT:`<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="11" fill="#26A17B"/><rect x="6" y="7.5" width="12" height="3" rx="1.5" fill="#fff"/><rect x="10.5" y="10.5" width="3" height="6.5" rx="1.5" fill="#fff"/></svg>`,
      USDC:`<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="11" fill="#2775CA"/><circle cx="12" cy="12" r="4" fill="#fff"/></svg>`,
      BNB:`<svg viewBox="0 0 24 24" width="22" height="22"><rect x="6" y="6" width="12" height="12" transform="rotate(45 12 12)" fill="#F3BA2F"/></svg>`,
      SOL:`<svg viewBox="0 0 24 24" width="22" height="22"><rect x="5" y="7" width="14" height="3" fill="#14F195"/><rect x="5" y="11" width="14" height="3" fill="#59FFA0"/><rect x="5" y="15" width="14" height="3" fill="#99FFC7"/></svg>`,
      TRX:`<svg viewBox="0 0 24 24" width="22" height="22"><polygon points="3,5 21,7 12,21" fill="#E50914"/></svg>`,
      LTC:`<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="11" fill="#345D9D"/><path d="M10 5l-2 7h3l-1 4h7" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`,
      XRP:`<svg viewBox="0 0 24 24" width="22" height="22"><path d="M7 6c1.6 1.6 3.2 3 5 3s3.4-1.4 5-3M7 18c1.6-1.6 3.2-3 5-3s3.4 1.4 5 3" stroke="#00A3E0" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`,
      DOGE:`<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="11" fill="#C2A633"/><path d="M8 7h6.2a3.8 3.8 0 0 1 0 7.6H8V7zm0 4h7.2" stroke="#fff" stroke-width="2"/></svg>`,
      MATIC:`<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="11" fill="#8247E5"/><path d="M7 8l5-3 5 3v8l-5 3-5-3V8z" fill="#fff" opacity=".9"/></svg>`,
      TON:`<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 3l7 8-7 10L5 11 12 3z" fill="#0098EA"/></svg>`,
      ADA:`<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="11" fill="#0033AD"/><circle cx="12" cy="12" r="2" fill="#fff"/><circle cx="6" cy="12" r="1.2" fill="#fff"/><circle cx="18" cy="12" r="1.2" fill="#fff"/></svg>`
    };
    return M[s] || `<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="11" fill="#6B7280"/></svg>`;
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
  function deepFind(obj, testFn, maxNodes=12000){
    try{
      const seen = new Set(); const queue = [obj]; let n=0;
      while(queue.length && n<maxNodes){
        const cur = queue.shift(); n++;
        if(!isObj(cur) || seen.has(cur)) continue;
        seen.add(cur);
        for(const k of Object.keys(cur)){
          const v = cur[k];
          if (testFn(k,v,cur)) return v;
          if (isObj(v)) queue.push(v);
        }
      }
    }catch{}
    return null;
  }
  const numify = (x) => x == null ? null : (typeof x === "number" ? x : (typeof x === "string" && x.trim()!=="" ? Number(x) : null));

  /* ---------- Timer (Receiving only) ---------- */
  function deadlineKey(id){ return `monerizer_timer_deadline_${id}`; }
  function getOrCreateDeadline(id, minutes=25){
    const k = deadlineKey(id);
    const saved = Number(localStorage.getItem(k) || "");
    const now = Date.now();
    if (Number.isFinite(saved) && saved > now) return saved;
    const newDeadline = now + minutes*60*1000;
    localStorage.setItem(k, String(newDeadline));
    return newDeadline;
  }
  function clearDeadline(id){ try { localStorage.removeItem(deadlineKey(id)); } catch {} }
  function humanTimeLeft(ms) {
    if (ms <= 0) return "00:00:00";
    const s = Math.floor(ms / 1000);
    const h = String(Math.floor(s / 3600)).padStart(2,"0");
    const m = String(Math.floor((s % 3600) / 60)).padStart(2,"0");
    const ss = String(s % 60).padStart(2,"0");
    return `${h}:${m}:${ss}`;
  }
  function expireUI(){
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    const q = $("qrBox"); if (q) q.innerHTML = "";
    setAddr("—");
    const btn = $("copyBtn"); if (btn) { btn.disabled = true; btn.textContent = "Expired"; }
    const exp = $("expiredBox"); if (exp) exp.classList.remove("mx-hidden");
  }
  const setAddr = (v) => { const a = $("addr"); if (a) a.textContent = v ?? "—"; };
  function ensureReceivingTimerForSwap(id){
    const tl = $("timeLeft");
    if (!tl) return;
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    const deadline = getOrCreateDeadline(id, 25);
    const tick = () => {
      const left = deadline - Date.now();
      tl.textContent = humanTimeLeft(left);
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

  /* ---------- Helpers to read “status-like” text anywhere ---------- */
  function collectStatusTextAnywhere(raw){
    const keys = ["status","state","stage","message","details","progress","status_text","state_text","stage_text","note","info"];
    const out = [];
    deepFind(raw, (k,v)=> {
      if (keys.includes(k) && typeof v === "string" && v.trim().length){
        out.push(v.toLowerCase());
      }
      return false;
    });
    return out.join(" | ");
  }
  function getProviderName(raw){
    return (
      raw?.provider || raw?.provider_name ||
      raw?.legs?.[0]?.provider || raw?.leg1?.provider ||
      raw?.legs?.[0]?.provider_name || raw?.leg1?.provider_name || ""
    ).toString().toLowerCase();
  }

  // Default phrase buckets (broad).
  const WAIT_PHRASES_DEF = /(waiting|awaiting|no payment|no deposit|pending deposit|address created|created|new|idle|looking for|open order|unpaid|not paid|awaiting payment|awaiting deposit|waiting for payment|waiting for deposit)/i;
  const SEEN_PHRASES_DEF = /(confirm|detected|received|paid|payment|deposit|processing|exchang|in[\s_-]?progress|verif|seen|found)/i;
  const L2_SENDING_TEXT_DEF = /(sending|payout|outgoing|broadcast|withdrawing|releasing|transfer(?!\s*to\s*us))/i;
  const COMPLETE_TEXT_DEF   = /(complete|finished|done|success|completed|succeeded)/i;

  // Optional provider-specific overrides: window.MX_STATUS_LEXICON = { changenow:{seen:[...],waiting:[...],sending:[...],complete:[...]} }
  function lexiconFor(raw){
    const p = (window.MX_STATUS_LEXICON || {})[getProviderName(raw)] || {};
    const toRe = (arr, fallback) => {
      if (!arr || !arr.length) return fallback;
      const esc = (s)=> s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      return new RegExp(arr.map(esc).join("|"), "i");
    };
    return {
      WAIT:  toRe(p.waiting, WAIT_PHRASES_DEF),
      SEEN:  toRe(p.seen,    SEEN_PHRASES_DEF),
      SEND:  toRe(p.sending, L2_SENDING_TEXT_DEF),
      DONE:  toRe(p.complete,COMPLETE_TEXT_DEF)
    };
  }

  /* ---------- Phase detector (LEG-SCOPED + ANYWHERE FALLBACK + MONOTONIC) ---------- */
  const leg1Of = (data)=> Array.isArray(data?.legs) ? (data.legs[0]||{}) : (data?.leg1 || {});
  const leg2Of = (data)=> Array.isArray(data?.legs) ? (data.legs[1]||{}) : (data?.leg2 || {});

  const hasField = (obj, re) => deepFind(obj,(k,v)=> re.test(k) && v!=null)!=null;
  const numGt0  = (obj, re) => { const v=deepFind(obj,(k,v)=>re.test(k)&&v!=null); const n=numify(v); return n!=null && n>0; };

  function phaseFromEvidence(raw){
    const { WAIT, SEEN, SEND, DONE } = lexiconFor(raw);

    const l1 = leg1Of(raw), p1 = l1.provider_info || l1.info || {};
    const l2 = leg2Of(raw), p2 = l2.provider_info || l2.info || {};

    const l1Text = [
      collectStatusTextAnywhere(l1),
      collectStatusTextAnywhere(p1)
    ].join(" | ") || collectStatusTextAnywhere(raw); // fallback to anywhere

    // Leave RECEIVING if:
    //  - leg1 has structured deposit evidence, OR
    //  - anywhere text suggests deposit seen/confirming and not waiting.
    const leg1Structured =
      hasField(p1, /^(payin_?tx(id)?|deposit_?tx(id)?|input_?tx(id)?|payin_hash)$/i) ||
      hasField(l1, /^(payin_?tx(id)?|deposit_?tx(id)?|input_?tx(id)?|payin_hash)$/i) ||
      numGt0(p1, /^(amount_received|confirmations|payin_confirmations|in_confirmations)$/i) ||
      numGt0(l1, /^(amount_received|confirmations|payin_confirmations|in_confirmations)$/i);

    const leg1TextSeen = l1Text && !WAIT.test(l1Text) && SEEN.test(l1Text);

    // Leg‑2: stay in ROUTING until actual customer payout starts
    const l2Text = [
      collectStatusTextAnywhere(l2),
      collectStatusTextAnywhere(p2)
    ].join(" | ") || collectStatusTextAnywhere(raw);

    const leg2RecvStructured =
      hasField(p2, /^(payin_?tx(id)?|deposit_?tx(id)?|input_?tx(id)?|payin_hash)$/i) ||
      hasField(l2, /^(payin_?tx(id)?|deposit_?tx(id)?|input_?tx(id)?|payin_hash)$/i) ||
      numGt0(p2, /^(amount_received|confirmations|payin_confirmations|in_confirmations)$/i) ||
      numGt0(l2, /^(amount_received|confirmations|payin_confirmations|in_confirmations)$/i);

    const leg2RecvText = l2Text && !WAIT.test(l2Text) && SEEN.test(l2Text);

    const leg2SendingEvidence =
      hasField(p2, /^(payout_?tx(id)?|txid[_-]?out|out_?tx(id)?|broadcast[_-]?out|tx_hash_out)$/i) ||
      hasField(l2, /^(payout_?tx(id)?|txid[_-]?out|out_?tx(id)?|broadcast[_-]?out|tx_hash_out)$/i) ||
      SEND.test(l2Text);

    const leg2Complete = DONE.test(l2Text);

    // Order: complete > sending > routing > receiving
    if (leg2Complete && leg2SendingEvidence) return "complete";
    if (leg2SendingEvidence)               return "sending";
    if (leg2RecvStructured || leg2RecvText || leg1Structured || leg1TextSeen) return "routing";
    return "receiving";
  }

  function clampMonotonic(nextPhase){
    if (!lastStatus) return nextPhase;
    const cur = STEP_INDEX[String(lastStatus).toLowerCase()] ?? 0;
    const nxt = STEP_INDEX[String(nextPhase).toLowerCase()] ?? 0;
    return (nxt < cur) ? lastStatus : nextPhase;
  }

  /* ---------- Address/QR (strictly leg‑1 deposit) ---------- */
  const looksOut = (k)=> /(payout|withdraw|out|recipient|to_address|toAddress|destination|payoutAddress|withdrawal)/i.test(k);
  const looksIn  = (k)=> /(deposit|payin|pay_in|address_in|in_address|inAddress|input_address|payIn|payinAddress)/i.test(k);

  function extractDepositAddress(data){
    const l1 = leg1Of(data), p = l1.provider_info || l1.info || {};
    let a = firstTruthy(
      data?.deposit_address, data?.payin_address, data?.address_in, data?.in_address,
      l1?.deposit_address, l1?.payin_address, l1?.address_in, l1?.in_address,
      p?.deposit_address, p?.payin_address, p?.address_in
    );
    if (a) return a;
    const fromL1 = deepFind(l1, (k,v)=> typeof v==="string" && /address/i.test(k) && looksIn(k) && !looksOut(k) && v.length>20);
    if (fromL1) return fromL1;
    const anywhere = deepFind(data, (k,v)=> typeof v==="string" && /address/i.test(k) && looksIn(k) && !looksOut(k) && v.length>20);
    return anywhere || "";
  }
  function extractDepositQR(data){
    const l1 = leg1Of(data), p = l1.provider_info || l1.info || {};
    const d = firstTruthy(p?.qr_png,p?.qr,p?.deposit_qr,p?.qr_image,p?.qr_base64,p?.qrUrl,
                          l1?.qr_png,l1?.qr,l1?.deposit_qr,l1?.qr_image,l1?.qr_base64,l1?.qrUrl,
                          data?.qr_png,data?.qr,data?.deposit_qr,data?.qr_image,data?.qr_base64,data?.qrUrl);
    if (d) return d;
    const deep = deepFind(l1,(k,v)=>/qr|qrcode/i.test(k)&&typeof v==="string"&&v.length>10)
             || deepFind(data,(k,v)=>/qr|qrcode/i.test(k)&&typeof v==="string"&&v.length>10);
    return deep || "";
  }

  function toDataUrlIfNeeded(qr) {
    if (!qr) return "";
    if (/^(data:|https?:)/i.test(qr)) return qr;
    if (typeof qr === "string" && qr.trim().startsWith("<svg"))
      return "data:image/svg+xml;utf8," + encodeURIComponent(qr);
    if (/^[A-Za-z0-9+/=]+$/i.test(qr) && qr.length > 100)
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

  // Sleek badge (no white background) when Receiving finishes
  function showDepositReceivedBadge() {
    const box = $("qrBox");
    if (!box) return;
    box.style.background = "transparent";
    box.style.padding = "0";
    box.innerHTML = `
      <div class="mx-qr-badge" aria-label="Deposit received" style="width:260px;height:260px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(160deg,#26d59a,#12b36c);box-shadow:0 10px 24px rgba(0,0,0,.25), inset 0 1px 0 rgba(255,255,255,.35);">
        <svg viewBox="0 0 64 64" role="img" aria-hidden="true" style="width:120px;height:120px">
          <path d="M18 34l10 10L46 24" fill="none" stroke="#082f22" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
    `;
  }

  function setFallbackQRFromAddress(addr) {
    if (!addr) return;
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(addr)}`;
    setQR(url);
  }

  function renderAmountReminder(amount, asset, network) {
    const box = $("amountLine");
    if (!box) return;
    box.style.marginTop = "10px";
    $("needAmount").textContent = (amount ?? "—").toString();
    $("needAsset").textContent = asset ? String(asset).toUpperCase() : "—";
    $("needNet").textContent   = network ? `(${network})` : "";
    const sym = (asset||"").toUpperCase();
    const iconHost = $("needIcon");
    if (iconHost){
      iconHost.innerHTML = coinIconSVG(sym);
      iconHost.style.display = "inline-flex";
      iconHost.style.verticalAlign = "-3px";
      iconHost.style.marginRight = "6px";
    }
    box.hidden = false;
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

    if (norm === "receiving") {
      showTimer(true);
    } else {
      showTimer(false);
      clearDeadline(swapId);
      if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    }
  }

  /* ---------- Endpoint detection ---------- */
  async function detectStatusEndpoint(id) {
    const quick = [
      `/api/status?sid=${encodeURIComponent(id)}`,
      `/api/status/${encodeURIComponent(id)}`,
      `/api/checkout?sid=${encodeURIComponent(id)}`,
      `/api/swap?sid=${encodeURIComponent(id)}`,
      `/api/checkout/${encodeURIComponent(id)}`
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

  function normalizeFromDirect(raw) {
    const address = extractDepositAddress(raw);
    const qr = extractDepositQR(raw);
    const phase = clampMonotonic(phaseFromEvidence(raw));
    const amount  = firstTruthy(raw.in_amount, raw.amount_in, raw.expected_amount_in, raw.request?.amount, raw.amount);
    const asset   = firstTruthy(raw.in_asset,  raw.asset_in,  raw.request?.in_asset,  raw.symbol_in,  raw.asset);
    const network = firstTruthy(raw.in_network,raw.network_in,raw.request?.in_network,raw.chain_in,   raw.network);
    return { address, qr, status: phase, amount, asset, network };
  }
  function normalizeFromAdmin(raw) {
    const swap = raw.swap || raw;
    const l1 = leg1Of(swap);
    const address = extractDepositAddress({legs:[l1],...swap});
    const qr = extractDepositQR({legs:[l1],...swap});
    const phase = clampMonotonic(phaseFromEvidence(swap));

    const req = swap.request || {};
    let amount = firstTruthy(l1.amount_in, req.amount, swap.amount_in);
    let asset  = firstTruthy(req.in_asset,  l1.asset_in,  swap.in_asset);
    let network= firstTruthy(req.in_network,l1.network_in,swap.in_network);
    if (amount==null) amount  = deepFind(swap,(k,v)=>/^(amount(_in)?|inAmount|amountIn)$/i.test(k)&&v!=null);
    if (asset==null)  asset   = deepFind(swap,(k,v)=>/^(in_?asset|asset_?in|from(asset|Coin|Symbol)|coinFrom|symbol_in)$/i.test(k));
    if (network==null)network = deepFind(swap,(k,v)=>/^(in_?network|network_?in|from(Network|Chain)|chain_from|from_chain)$/i.test(k));
    if (typeof asset==="string") asset=asset.toUpperCase();
    if (typeof network==="string") network=network.toUpperCase();

    return { address, qr, status: phase, amount, asset, network };
  }
  function normalizeData(raw, from) {
    try { return from === "admin" ? normalizeFromAdmin(raw) : normalizeFromDirect(raw); }
    catch { return { address:"", qr:"", status: clampMonotonic("receiving") }; }
  }

  /* ---------- Polling ---------- */
  async function pollOnce() {
    if (!statusEndpoint) return;
    try {
      const bustUrl = statusEndpoint.url + (statusEndpoint.url.includes("?") ? "&" : "?") + `_t=${Date.now()}`;
      const r = await fetch(bustUrl, {
        cache: "no-store",
        headers: {
          "cache-control": "no-cache, no-store, must-revalidate",
          "pragma": "no-cache",
          "expires": "0"
        }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const raw = await r.json();
      const data = normalizeData(raw, statusEndpoint.from);

      // Address & QR (deposit side only)
      setAddr(data.address || "—");
      if (data.qr) { hadProviderQR = true; setQR(data.qr); }
      else if (!hadProviderQR && data.address) { setFallbackQRFromAddress(data.address); }

      // Amount/asset/network
      if (data.amount && data.asset) {
        renderAmountReminder(data.amount, data.asset, data.network);
      } else {
        fetch(`/api/admin/swaps/${encodeURIComponent(swapId)}`, { cache: "no-store" })
          .then(x=>x.ok?x.json():null)
          .then(obj=>{ if(!obj) return; const ad = normalizeFromAdmin(obj); renderAmountReminder(ad.amount ?? data.amount, ad.asset ?? data.asset, ad.network ?? data.network); })
          .catch(()=>{});
      }

      const prev = lastStatus;
      updateSteps(data.status);

      // When leaving Receiving, replace QR and hide timer
      if (prev !== data.status) {
        if ((prev===null && data.status!=="receiving") || (prev==="receiving" && data.status!=="receiving")) {
          showDepositReceivedBadge();
          showTimer(false);
          clearDeadline(swapId);
        }
        lastStatus = data.status;
      }

      // Stop polling on completion
      if (String(data.status).toLowerCase() === "complete") {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        showDepositReceivedBadge();
        clearDeadline(swapId);
        showTimer(false);
      }
    } catch { /* ignore and poll again later */ }
  }

  /* ---------- boot ---------- */
  (async function init(){
    $("swapIdLine").textContent = swapId || "—";
    $("copyBtn")?.addEventListener("click", async () => {
      const txt = $("addr")?.textContent || "";
      if (!txt || txt === "—") return;
      try { await navigator.clipboard.writeText(txt); $("copyBtn").textContent = "Copied!"; setTimeout(() => $("copyBtn").textContent = "Copy", 1200); } catch {}
    });

    if (!swapId) return;

    // Receiving-only 25‑min timer (persisted per swap)
    ensureReceivingTimerForSwap(swapId);
    showTimer(true);

    // Detect best status endpoint
    const found = await detectStatusEndpoint(swapId);
    if (!found) {
      const msg = document.createElement("div");
      msg.className = "mx-softerr";
      msg.textContent = "Waiting for provider… (order created, status endpoint not ready yet)";
      document.querySelector(".mx-card")?.appendChild(msg);
      setTimeout(init, 2000);
      return;
    }
    statusEndpoint = found;

    // First paint
    const first = normalizeData(found.firstJson || {}, found.from);
    setAddr(first.address || "—");
    if (first.qr) { hadProviderQR = true; setQR(first.qr); }
    else if (first.address) { setFallbackQRFromAddress(first.address); }

    if (first.amount && first.asset) renderAmountReminder(first.amount, first.asset, first.network);
    else {
      try {
        const r = await fetch(`/api/admin/swaps/${encodeURIComponent(swapId)}`, { cache: "no-store" });
        if (r.ok) {
          const obj = await r.json();
          const ad = normalizeFromAdmin(obj);
          renderAmountReminder(ad.amount ?? first.amount, ad.asset ?? first.asset, ad.network ?? first.network);
        }
      } catch {}
    }

    updateSteps(first.status);
    lastStatus = first.status;

    // If we land already past Receiving, show badge and remove timer now
    if (first.status && String(first.status).toLowerCase() !== "receiving") {
      showDepositReceivedBadge();
      showTimer(false);
      clearDeadline(swapId);
    }

    // Poll
    pollTimer = setInterval(pollOnce, 5000);
  })();
})();
