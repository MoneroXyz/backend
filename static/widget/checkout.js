(() => {
  const $ = (id) => document.getElementById(id);
  const qp = new URLSearchParams(location.search);
  const swapId = qp.get("sid") || qp.get("swapId") || "";

  // Steps
  const STEP_INDEX = { receiving:0, routing:1, sending:2, complete:3, finished:3, done:3 };

  // state
  let pollTimer = null;
  let lastStatus = null;
  let statusEndpoint = null;
  let timerHandle = null;
  let hadProviderQR = false;

  /* ---------- Bright inline SVG logos (no external requests) ---------- */
  function coinIconSVG(sym){
    const s = (sym||"").toUpperCase();
    const M = {
      BTC:`<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#F7931A"/><text x="12" y="16" font-size="10" font-weight="700" fill="#fff" text-anchor="middle">฿</text></svg>`,
      ETH:`<svg viewBox="0 0 24 24"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3C3C3D"/><stop offset="1" stop-color="#8C8C8C"/></linearGradient></defs><path d="M12 2l6 9-6 4-6-4 6-9z" fill="url(#g)"/><path d="M12 22l6-10-6 4-6-4 6 10z" fill="#8C8C8C"/></svg>`,
      XMR:`<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#FF6600"/><path d="M5 13l3-3 4 4 4-4 3 3v5H5z" fill="#fff"/></svg>`,
      USDT:`<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#26A17B"/><rect x="6" y="7.5" width="12" height="3" rx="1.5" fill="#fff"/><rect x="10.5" y="10.5" width="3" height="6.5" rx="1.5" fill="#fff"/></svg>`,
      USDC:`<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#2775CA"/><circle cx="12" cy="12" r="4" fill="#fff"/></svg>`,
      BNB:`<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" transform="rotate(45 12 12)" fill="#F3BA2F"/></svg>`,
      SOL:`<svg viewBox="0 0 24 24"><rect x="5" y="7" width="14" height="3" fill="#14F195"/><rect x="5" y="11" width="14" height="3" fill="#59FFA0"/><rect x="5" y="15" width="14" height="3" fill="#99FFC7"/></svg>`,
      TRX:`<svg viewBox="0 0 24 24"><polygon points="3,5 21,7 12,21" fill="#E50914"/></svg>`,
      LTC:`<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#345D9D"/><path d="M10 5l-2 7h3l-1 4h7" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`,
      XRP:`<svg viewBox="0 0 24 24"><path d="M7 6c1.6 1.6 3.2 3 5 3s3.4-1.4 5-3M7 18c1.6-1.6 3.2-3 5-3s3.4 1.4 5 3" stroke="#00A3E0" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`,
      DOGE:`<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#C2A633"/><path d="M8 7h6.2a3.8 3.8 0 0 1 0 7.6H8V7zm0 4h7.2" stroke="#fff" stroke-width="2"/></svg>`,
      MATIC:`<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#8247E5"/><path d="M7 8l5-3 5 3v8l-5 3-5-3V8z" fill="#fff" opacity=".9"/></svg>`,
      TON:`<svg viewBox="0 0 24 24"><path d="M12 3l7 8-7 10L5 11 12 3z" fill="#0098EA"/></svg>`,
      ADA:`<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#0033AD"/><circle cx="12" cy="12" r="2" fill="#fff"/><circle cx="6" cy="12" r="1.2" fill="#fff"/><circle cx="18" cy="12" r="1.2" fill="#fff"/></svg>`
    };
    return M[s] || `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#6B7280"/></svg>`;
  }

  /* ---------- utils ---------- */
  const isObj = (v) => v && typeof v === "object";
  const firstTruthy = (...vals) => {
    for (const v of vals) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      return v;
    }
    return undefined;
  };
  function deepFind(obj, testFn, maxNodes=6000){
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
  const numify = (x)=> x==null ? null : (typeof x==="number" ? x : (typeof x==="string" && x.trim()!=="" ? Number(x) : null));

  /* ---------- timer (Receiving only) ---------- */
  function deadlineKey(id){ return `monerizer_timer_deadline_${id}`; }
  function getOrCreateDeadline(id, minutes=25){
    const k = deadlineKey(id), saved = Number(localStorage.getItem(k)||""); const now=Date.now();
    if (Number.isFinite(saved) && saved>now) return saved;
    const t = now + minutes*60*1000; localStorage.setItem(k, String(t)); return t;
  }
  function clearDeadline(id){ try{ localStorage.removeItem(deadlineKey(id)); }catch{} }
  function humanTimeLeft(ms){ if (ms<=0) return "00:00:00"; const s=Math.floor(ms/1000); const h=String(Math.floor(s/3600)).padStart(2,"0"); const m=String(Math.floor((s%3600)/60)).padStart(2,"0"); const ss=String(s%60).padStart(2,"0"); return `${h}:${m}:${ss}`; }
  function showTimer(show){ const tl=$("timeLeft"); if (!tl) return; tl.parentElement.style.visibility = show ? "visible" : "hidden"; }
  function startReceivingTimer(){
    const tl=$("timeLeft"); if (!tl) return;
    if (timerHandle) clearInterval(timerHandle);
    const deadline = getOrCreateDeadline(swapId, 25);
    const tick = ()=>{ const left=deadline-Date.now(); tl.textContent = humanTimeLeft(left); if (left<=0){ clearInterval(timerHandle); timerHandle=null; expireUI(); clearDeadline(swapId); } };
    tick(); timerHandle = setInterval(tick, 1000);
  }
  function stopTimer(){ if (timerHandle) clearInterval(timerHandle); timerHandle=null; clearDeadline(swapId); showTimer(false); }
  function expireUI(){
    if (pollTimer) { clearInterval(pollTimer); pollTimer=null; }
    const qrb=$("qrBox"); if (qrb) qrb.innerHTML=""; const addr=$("addr"); if (addr) addr.textContent="—";
    const btn=$("copyBtn"); if (btn){ btn.disabled=true; btn.textContent="Expired"; }
    const exp=$("expiredBox"); if (exp) exp.classList.remove("mx-hidden");
  }

  /* ---------- Address/QR (strictly Leg‑1 deposit) ---------- */
  const looksOut = (k)=> /(payout|withdraw|out|recipient|to_address|toAddress|destination|payoutAddress|withdrawal)/i.test(k);
  const looksIn  = (k)=> /(deposit|payin|pay_in|address_in|in_address|inAddress|input_address|payIn|payinAddress)/i.test(k);
  const leg1Of   = (data)=> Array.isArray(data?.legs) ? (data.legs[0]||{}) : (data?.leg1 || {});

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
  function toDataUrlIfNeeded(qr){
    if (!qr) return "";
    if (/^(data:|https?:)/i.test(qr)) return qr;
    if (typeof qr==="string" && qr.trim().startsWith("<svg")) return "data:image/svg+xml;utf8,"+encodeURIComponent(qr);
    if (/^[A-Za-z0-9+/=]+$/i.test(qr) && qr.length>100) return `data:image/png;base64,${qr}`;
    return qr;
  }
  function setQR(src){ const img=$("qr"); if (!img||!src) return; const s=toDataUrlIfNeeded(src); if (!img.src || img.src!==s) img.src=s; img.alt="Deposit QR"; }
  function setFallbackQR(addr){ if (!addr) return; setQR(`https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(addr)}`); }

  /* ---------- Phase detection (provider‑agnostic) ---------- */
  function phaseFromEvidence(raw){
    const has = (k)=> deepFind(raw,(kk,v)=> kk===k && v!=null);
    const hasNum = (k)=> { const v = deepFind(raw,(kk,vv)=> kk===k && vv!=null); const n=numify(v); return n!=null && n>0; };

    // completion first (some providers jump straight there)
    const st = String(firstTruthy(raw.status, raw.state, raw.stage, raw.provider_status, "" )).toLowerCase();
    if (/(complete|finished|done|success|completed)/.test(st)) return "complete";

    // payout/broadcast → sending
    if ( has('payout_txid') || has('payout_hash') || has('payout_tx') || has('broadcast_out') || has('txid_out') || /(sending|payout|broadcast|outgoing)/.test(st) )
      return "sending";

    // deposit detected/confirmations → routing
    if ( has('payin_txid') || has('payin_hash') || has('payin_tx') || hasNum('confirmations') || hasNum('payin_confirmations') || hasNum('amount_received') || /(detected|paid|confirm|pending|in_progress|awaiting_confirm)/.test(st) )
      return "routing";

    return "receiving";
  }

  function normalizeFromDirect(raw){
    const address = extractDepositAddress(raw);
    const qr = extractDepositQR(raw);
    const status = phaseFromEvidence(raw);
    const amount  = firstTruthy(raw.in_amount, raw.amount_in, raw.expected_amount_in, raw.request?.amount, raw.amount);
    const asset   = firstTruthy(raw.in_asset,  raw.asset_in,  raw.request?.in_asset,  raw.symbol_in,  raw.asset);
    const network = firstTruthy(raw.in_network,raw.network_in,raw.request?.in_network,raw.chain_in,   raw.network);
    return { address, qr, status, amount, asset, network };
  }

  function normalizeFromAdmin(raw){
    const swap = raw.swap || raw;
    const l1 = leg1Of(swap);
    const pinfo = l1.provider_info || l1.info || {};
    const address = extractDepositAddress({legs:[l1],...swap});
    const qr = extractDepositQR({legs:[l1],...swap});
    const status = phaseFromEvidence({ ...swap, ...pinfo });

    const req = swap.request || {};
    let amount = firstTruthy(l1.amount_in, req.amount, swap.amount_in);
    let asset  = firstTruthy(req.in_asset,  l1.asset_in,  swap.in_asset);
    let network= firstTruthy(req.in_network,l1.network_in,swap.in_network);
    if (amount==null) amount  = deepFind(swap,(k,v)=>/^(amount(_in)?|inAmount|amountIn)$/i.test(k)&&v!=null);
    if (asset==null)  asset   = deepFind(swap,(k,v)=>/^(in_?asset|asset_?in|from(asset|Coin|Symbol)|coinFrom|symbol_in)$/i.test(k));
    if (network==null)network = deepFind(swap,(k,v)=>/^(in_?network|network_?in|from(Network|Chain)|chain_from|from_chain)$/i.test(k));
    if (typeof asset==="string") asset=asset.toUpperCase();
    if (typeof network==="string") network=network.toUpperCase();

    return { address, qr, status, amount, asset, network };
  }

  async function detectStatusEndpoint(id){
    const urls = [
      `/api/status?sid=${encodeURIComponent(id)}`,
      `/api/status/${encodeURIComponent(id)}`,
      `/api/checkout?sid=${encodeURIComponent(id)}`,
      `/api/swap?sid=${encodeURIComponent(id)}`,
      `/api/checkout/${encodeURIComponent(id)}`
    ];
    for (const url of urls){
      try{ const r=await fetch(url,{cache:"no-store"}); if(r.ok){ const j=await r.json().catch(()=>({})); return {url, firstJson:j, from:"direct"}; } }catch{}
    }
    try{
      const url=`/api/admin/swaps/${encodeURIComponent(id)}`;
      const r=await fetch(url,{cache:"no-store"}); if(r.ok){ const j=await r.json().catch(()=>({})); return {url, firstJson:j, from:"admin"};}
    }catch{}
    return null;
  }

  function normalizeData(raw, from){ try{ return from==="admin" ? normalizeFromAdmin(raw) : normalizeFromDirect(raw); }catch{ return {address:"",qr:"",status:"receiving"}; } }

  /* ---------- render ---------- */
  function setAddress(addr){ $("addr").textContent = addr || "—"; }

  function renderAmount(amount, asset, network){
    const box=$("amountLine"); if (!box) return;
    box.style.marginTop="10px";

    const sym = (asset||"").toUpperCase();
    const showNet = network && String(network).toUpperCase() !== sym ? `(${network})` : "";

    $("needAmount").textContent = (amount ?? "—").toString();
    $("needAsset").textContent  = sym || "—";
    $("needNet").textContent    = showNet;

    const iconHost=$("needIcon");
    if (iconHost){
      iconHost.innerHTML = coinIconSVG(sym);
    }
    box.hidden = false;
  }

  function showCheck(){ const box=$("qrBox"); if(!box) return; box.innerHTML=""; const d=document.createElement("div"); d.className="mx-qr-ok"; d.textContent="✓"; box.appendChild(d); }

  function updateSteps(status){
    const norm=(status||"").toLowerCase();
    const idx = STEP_INDEX[norm] ?? STEP_INDEX.receiving;
    const steps = Array.from(document.querySelectorAll("#steps .mx-step"));
    steps.forEach((li,i)=>{ li.classList.remove("done","active","upcoming"); if(i<idx) li.classList.add("done"); else if(i===idx) li.classList.add("active"); else li.classList.add("upcoming"); });

    if (norm==="receiving") showTimer(true); else stopTimer();
  }

  /* ---------- polling ---------- */
  async function pollOnce(){
    if (!statusEndpoint) return;
    try{
      const r=await fetch(statusEndpoint.url,{cache:"no-store"});
      if(!r.ok) throw new Error(r.status);
      const raw = await r.json();
      const data = normalizeData(raw, statusEndpoint.from);

      setAddress(data.address);
      if (data.qr){ hadProviderQR=true; setQR(data.qr); }
      else if (!hadProviderQR && data.address){ setFallbackQR(data.address); }

      if (data.amount && data.asset) renderAmount(data.amount, data.asset, data.network);
      else {
        fetch(`/api/admin/swaps/${encodeURIComponent(swapId)}`,{cache:"no-store"})
          .then(x=>x.ok?x.json():null)
          .then(obj=>{ if(!obj) return; const ad = normalizeFromAdmin(obj); renderAmount(ad.amount ?? data.amount, ad.asset ?? data.asset, ad.network ?? data.network); })
          .catch(()=>{});
      }

      const prev = lastStatus;
      updateSteps(data.status);
      if (prev !== data.status){
        if ((prev===null && data.status!=="receiving") || (prev==="receiving" && data.status!=="receiving")) showCheck();
        lastStatus = data.status;
      }

      if (["complete","finished","done","success"].includes((data.status||"").toLowerCase())){
        clearInterval(pollTimer); pollTimer=null; showCheck(); stopTimer();
      }
    }catch{/* keep polling */}
  }

  /* ---------- boot ---------- */
  (async function init(){
    $("swapIdLine").textContent = swapId || "—";
    $("copyBtn")?.addEventListener("click", async ()=>{
      const txt=$("addr")?.textContent||""; if(!txt || txt==="—") return;
      try{ await navigator.clipboard.writeText(txt); $("copyBtn").textContent="Copied!"; setTimeout(()=>$("copyBtn").textContent="Copy",1200); }catch{}
    });

    if (!swapId) return;

    startReceivingTimer(); showTimer(true);

    const found = await detectStatusEndpoint(swapId);
    if (!found){
      const msg=document.createElement("div"); msg.className="mx-softerr"; msg.textContent="Waiting for provider… (order created, status endpoint not ready yet)";
      document.querySelector(".mx-card")?.appendChild(msg);
      setTimeout(init, 2000);
      return;
    }
    statusEndpoint = found;

    const first = normalizeData(found.firstJson || {}, found.from);
    setAddress(first.address);
    if (first.qr) { hadProviderQR=true; setQR(first.qr); } else if (first.address) { setFallbackQR(first.address); }
    if (first.amount && first.asset) renderAmount(first.amount, first.asset, first.network);

    updateSteps(first.status); lastStatus = first.status;

    pollTimer = setInterval(pollOnce, 5000);
  })();
})();
