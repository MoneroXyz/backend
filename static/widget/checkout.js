(() => {
  const $ = (id) => document.getElementById(id);
  const qs = (sel) => document.querySelector(sel);

  // ----- swap id -----
  const params = new URLSearchParams(location.search);
  const pathUUID = (location.pathname.match(/[0-9a-fA-F\-]{36}/) || [])[0] || "";
  const swapId = params.get("sid") || params.get("swapId") || pathUUID || "";

  // ----- phases + helpers -----
  const STEP_INDEX = { receiving: 0, routing: 1, sending: 2 };
  const rank = (s) => STEP_INDEX[String(s || "").toLowerCase()] ?? -1;
  const isObj = (v) => v && typeof v === "object";
  const firstTruthy = (...vals) => { for (const v of vals) { if (v==null) continue; if (typeof v==="string" && v.trim()==="") continue; return v; } };
  const numify = (x) => x == null ? null : (typeof x === "number" ? x : (typeof x === "string" && x.trim() !== "" ? Number(x) : null));
  function deepFind(obj, testFn, maxNodes = 8000) {
    try {
      const seen = new Set(); const q = [obj]; let n = 0;
      while (q.length && n < maxNodes) {
        const cur = q.shift(); n++;
        if (!isObj(cur) || seen.has(cur)) continue;
        seen.add(cur);
        for (const k of Object.keys(cur)) {
          const v = cur[k];
          if (testFn(k, v, cur)) return v;
          if (isObj(v)) q.push(v);
        }
      }
    } catch {}
    return null;
  }

  // ----- persist furthest phase (5 min TTL) -----
  function getPersistedStatus(id) {
    try {
      const s = localStorage.getItem(`monerizer_status_${id}`);
      const t = Number(localStorage.getItem(`monerizer_status_timestamp_${id}`) || "0");
      if (s && Date.now() - t < 5 * 60 * 1000) return s;
    } catch {}
    return null;
  }
  function setPersistedStatusMonotonic(id, s) {
    try {
      const prev = getPersistedStatus(id);
      if (rank(s) >= rank(prev)) {
        localStorage.setItem(`monerizer_status_${id}`, s);
        localStorage.setItem(`monerizer_status_timestamp_${id}`, String(Date.now()));
      }
    } catch {}
  }
  function clampMonotonic(nextPhase) {
    const canonical = nextPhase === "sending_done" ? "sending" : nextPhase;
    const floor = getPersistedStatus(swapId);
    const curIdx = Math.max(rank(window.lastStatus), rank(floor));
    const nxtIdx = rank(canonical);
    return nxtIdx < curIdx ? (window.lastStatus || floor || canonical) : canonical;
  }

  // ----- snapshot for ops panel -----
  const SNAP_K = (id) => `mx_snap_${id}`;
  const SNAP_TS_K = (id) => `mx_snap_ts_${id}`;
  function saveSnapshot(id, raw, finished = false) {
    try {
      if (!raw || typeof raw !== "object") return;
      localStorage.setItem(SNAP_K(id), JSON.stringify(raw));
      localStorage.setItem(SNAP_TS_K(id), `${Date.now()}|${finished ? "F" : "L"}`);
    } catch {}
  }
  function loadSnapshot(id) {
    try {
      const raw = localStorage.getItem(SNAP_K(id));
      const meta = localStorage.getItem(SNAP_TS_K(id)) || "";
      if (!raw || !meta) return null;
      const [tsStr, flag] = meta.split("|");
      const ts = Number(tsStr || "0");
      const now = Date.now();
      const maxAge = flag === "F" ? 5 * 24 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
      if (!Number.isFinite(ts) || now - ts > maxAge) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }
  function markSnapshotFinished(id) {
    try {
      const meta = localStorage.getItem(SNAP_TS_K(id)) || "";
      if (!meta) return;
      const [tsStr] = meta.split("|");
      localStorage.setItem(SNAP_TS_K(id), `${tsStr || Date.now()}|F`);
    } catch {}
  }

  // ----- UI bits -----
  let pollTimer = null;
  let timerHandle = null;
  let hadProviderQR = false;
  let finalized = false;
  window.lastStatus = null;
  window.__opsLastRaw = null;

  const qrHintEl = qs(".mx-qr-hint");
  const setQrHintVisible = (show) => { if (!qrHintEl) return; qrHintEl.classList.toggle("mx-hidden", !show); };
  const setAddr = (v) => { const a = $("addr"); if (a) a.textContent = v ?? "—"; };

  // receiving timer
  function deadlineKey(id) { return `monerizer_timer_deadline_${id}`; }
  function getOrCreateDeadline(id, minutes = 25) {
    const k = deadlineKey(id);
    const saved = Number(localStorage.getItem(k) || "");
    const now = Date.now();
    if (Number.isFinite(saved) && saved > now) return saved;
    const newDeadline = now + minutes * 60 * 1000;
    localStorage.setItem(k, String(newDeadline));
    return newDeadline;
  }
  function clearDeadline(id) { try { localStorage.removeItem(deadlineKey(id)); } catch {} }
  function humanTimeLeft(ms) { if (ms <= 0) return "00:00:00"; const s = Math.floor(ms/1000);
    const h = String(Math.floor(s/3600)).padStart(2,"0"); const m = String(Math.floor((s%3600)/60)).padStart(2,"0"); const ss = String(s%60).padStart(2,"0");
    return `${h}:${m}:${ss}`; }
  function ensureReceivingTimerForSwap(id) {
    const tl = $("timeLeft"); if (!tl) return;
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    const deadline = getOrCreateDeadline(id, 25);
    const tick = () => {
      const left = deadline - Date.now();
      tl.textContent = humanTimeLeft(left);
      if (left <= 0) { clearInterval(timerHandle); timerHandle = null; expireUI(); clearDeadline(id); }
    };
    tick(); timerHandle = setInterval(tick, 1000);
  }
  function showTimer(show) { const tl = $("timeLeft"); if (!tl) return; tl.parentElement.style.visibility = show ? "visible" : "hidden"; }
  function expireUI() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    const q = $("qrBox"); if (q) q.innerHTML = "";
    setAddr("—");
    const btn = $("copyBtn"); if (btn) { btn.disabled = true; btn.textContent = "Expired"; }
    $("expiredBox")?.classList.remove("mx-hidden");
    setQrHintVisible(false);
  }

  function toDataUrlIfNeeded(qr) {
    if (!qr) return "";
    if (/^(data:|https?:)/i.test(qr)) return qr;
    if (typeof qr === "string" && qr.trim().startsWith("<svg"))
      return "data:image/svg+xml;utf8," + encodeURIComponent(qr);
    if (/^[A-Za-z0-9+/=]+$/i.test(qr) && qr.length > 100) return `data:image/png;base64,${qr}`;
    return qr;
  }
  function setQR(src) { const img = $("qr"); if (!img || !src) return; const processed = toDataUrlIfNeeded(src); if (!img.src || img.src !== processed) img.src = processed; img.alt = "Deposit QR"; }
  function setFallbackQRFromAddress(addr) { if (!addr) return; const url = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(addr)}`; setQR(url); }
  function showDepositReceivedBadge() {
    const box = $("qrBox"); if (!box) return;
    box.style.background = "transparent"; box.style.padding = "0";
    box.innerHTML = `
      <div class="mx-gif-box">
        <img src="https://media0.giphy.com/media/v1.Y2lkPTc5MGI3NjExbzE3M2hzMG10emV3MjFpemVpcWVxbmo4NzM1ZDZ5cXNjM2VuYmh2ZyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9cw/svpb0hF4Fz1HBWPCqB/giphy.gif" alt="processing">
      </div>
      <div class="mx-waiting-text">Wait until we monerize your assets <span class="dots"><span>.</span><span>.</span><span>.</span></span></div>
    `;
    setQrHintVisible(false);
  }

  // ----- icons for amount line -----
  function coinIconSVG(sym) {
    const s = (sym || "").toUpperCase();
    const M = {
      BTC: `<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="11" fill="#F7931A"/><text x="12" y="16" font-size="10" font-weight="700" fill="#fff" text-anchor="middle">฿</text></svg>`,
      ETH: `<svg viewBox="0 0 24 24" width="22" height="22"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3C3C3D"/><stop offset="1" stop-color="#8C8C8C"/></linearGradient></defs><path d="M12 2l6 9-6 4-6-4 6-9z" fill="url(#g)"/><path d="M12 22l6-10-6 4-6-4 6 10z" fill="#8C8C8C"/></svg>`,
      XMR: `<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="11" fill="#FF6600"/><path d="M5 13l3-3 4 4 4-4 3 3v5H5z" fill="#fff"/></svg>`,
      USDT: `<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="11" fill="#26A17B"/><rect x="6" y="7.5" width="12" height="3" rx="1.5" fill="#fff"/><rect x="10.5" y="10.5" width="3" height="6.5" rx="1.5" fill="#fff"/></svg>`,
      USDC: `<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="11" fill="#2775CA"/><circle cx="12" cy="12" r="4" fill="#fff"/></svg>`,
      BNB: `<svg viewBox="0 0 24 24" width="22" height="22"><rect x="6" y="6" width="12" height="12" transform="rotate(45 12 12)" fill="#F3BA2F"/></svg>`,
      SOL: `<svg viewBox="0 0 24 24" width="22" height="22"><rect x="5" y="7" width="14" height="3" fill="#14F195"/><rect x="5" y="11" width="14" height="3" fill="#59FFA0"/><rect x="5" y="15" width="14" height="3" fill="#99FFC7"/></svg>`,
      TRX: `<svg viewBox="0 0 24 24" width="22" height="22"><polygon points="3,5 21,7 12,21" fill="#E50914"/></svg>`,
      LTC: `<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="11" fill="#345D9D"/><path d="M10 5l-2 7h3l-1 4h7" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`,
      XRP: `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M7 6c1.6 1.6 3.2 3 5 3s3.4-1.4 5-3M7 18c1.6-1.6 3.2-3 5-3s3.4 1.4 5 3" stroke="#00A3E0" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`,
      DOGE: `<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="11" fill="#C2A633"/><path d="M8 7h6.2a3.8 3.8 0 0 1 0 7.6H8V7zm0 4h7.2" stroke="#fff" stroke-width="2"/></svg>`,
      MATIC:`<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="11" fill="#8247E5"/><path d="M7 8l5-3 5 3v8l-5 3-5-3V8z" fill="#fff" opacity=".9"/></svg>`,
      TON: `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 3l7 8-7 10L5 11 12 3z" fill="#0098EA"/></svg>`,
      ADA: `<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="11" fill="#0033AD"/><circle cx="12" cy="12" r="2" fill="#fff"/><circle cx="6" cy="12" r="1.2" fill="#fff"/><circle cx="18" cy="12" r="1.2" fill="#fff"/></svg>`
    };
    return M[s] || `<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="11" fill="#6B7280"/></svg>`;
  }

  // amount line (logo + amount + symbol)
  function setAmountLine(amount, asset, network) {
    const box = $("amountLine"); if (!box) return;
    $("needAmount").textContent = (amount ?? "—").toString();
    $("needAsset").textContent = asset ? String(asset).toUpperCase() : "—";
    $("needNet").textContent = network ? `(${network})` : "";
    const iconHost = $("needIcon");
    if (iconHost) {
      iconHost.innerHTML = coinIconSVG(asset);
      iconHost.style.display = "inline-flex";
      iconHost.style.verticalAlign = "-3px";
      iconHost.style.marginRight = "6px";
    }
    box.hidden = false;
  }

  // ----- phase inference (direct JSON only) -----
  const K_WAIT_OR_NEW = /(waiting|wait|new)/i;
  const K_ROUTING     = /(confirming|confirmation|confirmed|exchanging|verifying)/i;
  const K_SENDING     = /(sending)/i;
  const K_DONE        = /(finished|success|completed)/i;
  const K_DETECTED    = /(detect|detected|received|paid|payment received|payment|tx detected)/i;

  const leg1Of = (data) => (Array.isArray(data?.legs) ? data.legs[0] || {} : data?.leg1 || {});
  const leg2Of = (data) => (Array.isArray(data?.legs) ? data.legs[1] || {} : data?.leg2 || {});

  function collectStatusText(obj) {
    const texts = [];
    (function sweep(o) {
      if (!o || typeof o !== "object") return;
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v === "string" && /status|state|stage|message|details|progress|reason|note|info/i.test(k)) {
          texts.push(String(v).toLowerCase());
        } else if (Array.isArray(v)) v.forEach(sweep);
        else if (v && typeof v === "object") sweep(v);
      }
    })(obj);
    return texts.join(" | ");
  }
  const hasField = (obj, re) => deepFind(obj, (k, v) => re.test(k) && v != null) != null;
  const numGt0 = (obj, re) => { const v = deepFind(obj, (k, v) => re.test(k) && v != null); const n = numify(v); return n != null && n > 0; };
  function phaseFromEvidence(raw) {
    const l1 = leg1Of(raw), p1 = l1.provider_info || l1.info || {};
    const l2 = leg2Of(raw), p2 = l2.provider_info || l2.info || {};
    const l1Text = collectStatusText({ l: l1, p: p1 });
    const leg1Detected =
      K_ROUTING.test(l1Text) ||
      (!K_WAIT_OR_NEW.test(l1Text) && K_DETECTED.test(l1Text)) ||
      hasField(p1, /^(payin_?tx(id)?|deposit_?tx(id)?|input_?tx(id)?|payin_hash)$/i) ||
      hasField(l1, /^(payin_?tx(id)?|deposit_?tx(id)?|input_?tx(id)?|payin_hash)$/i) ||
      numGt0(p1, /^(amount_received|confirmations|payin_confirmations|in_confirmations)$/i);
    const l2Text = collectStatusText({ l: l2, p: p2 });
    const leg2Sending =
      K_SENDING.test(l2Text) ||
      hasField(p2, /^(payout_?tx(id)?|txid[_-]?out|out_?tx(id)?|broadcast[_-]?out|tx_hash_out)$/i) ||
      hasField(l2, /^(payout_?tx(id)?|txid[_-]?out|out_?tx(id)?|broadcast[_-]?out|tx_hash_out)$/i);
    const leg2Done = K_DONE.test(l2Text);
    if (leg2Done) return "sending_done";
    if (leg2Sending) return "sending";
    if (leg1Detected) return "routing";
    return "receiving";
  }

  // deposit address/QR extraction
  const looksOut = (k) => /(payout|withdraw|out|recipient|to_address|toAddress|destination|payoutAddress|withdrawal)/i.test(k);
  const looksIn  = (k) => /(deposit|payin|pay_in|address_in|in_address|inAddress|input_address|payIn|payinAddress)/i.test(k);
  function extractDepositAddress(data) {
    const l1 = leg1Of(data), p = l1.provider_info || l1.info || {};
    let a = firstTruthy(
      data?.deposit_address, data?.payin_address, data?.address_in, data?.in_address,
      l1?.deposit_address, l1?.payin_address, l1?.address_in, l1?.in_address,
      p?.deposit_address, p?.payin_address, p?.address_in
    );
    if (a) return a;
    const fromL1 = deepFind(l1, (k, v) => typeof v === "string" && /address/i.test(k) && looksIn(k) && !looksOut(k) && v.length > 20);
    if (fromL1) return fromL1;
    const anywhere = deepFind(data, (k, v) => typeof v === "string" && /address/i.test(k) && looksIn(k) && !looksOut(k) && v.length > 20);
    return anywhere || "";
  }
  function extractDepositQR(data) {
    const l1 = leg1Of(data), p = l1.provider_info || l1.info || {};
    const d = firstTruthy(
      p?.qr_png, p?.qr, p?.deposit_qr, p?.qr_image, p?.qr_base64, p?.qrUrl,
      l1?.qr_png, l1?.qr, l1?.deposit_qr, l1?.qr_image, l1?.qr_base64, l1?.qrUrl,
      data?.qr_png, data?.qr, data?.deposit_qr, data?.qr_image, data?.qr_base64, data?.qrUrl
    );
    if (d) return d;
    const deep = deepFind(l1, (k, v) => /qr|qrcode/i.test(k) && typeof v === "string" && v.length > 10)
      || deepFind(data, (k, v) => /qr|qrcode/i.test(k) && typeof v === "string" && v.length > 10);
    return deep || "";
  }

  // ----- amount/asset/network extraction (wider) -----
  function extractInAmountAssetNetwork(raw) {
    const req = raw.request || raw.req || {};
    const l1  = leg1Of(raw);
    const p1  = l1.provider_info || l1.info || {};

    // many possible keys vendors use
    const amount = firstTruthy(
      raw.in_amount, raw.amount_in, raw.expected_amount_in,
      req.amount, req.amountFrom, req.fromAmount, req.expectedAmount,
      l1.amount_in, l1.expectedAmount, l1.expected_amount,
      p1.amount_in, p1.amountFrom, p1.expectedAmountFrom, p1.expected_from_amount,
      deepFind(raw, (k,v)=>/^amount(from|_from|_in)?$/i.test(k) && v!=null)
    );

    let asset = firstTruthy(
      raw.in_asset, raw.asset_in, req.in_asset, req.fromAsset, req.assetFrom,
      l1.asset_in, p1.asset_in, p1.fromAsset, p1.symbolFrom, raw.symbol_in, raw.asset
    );
    if (!asset) {
      asset = deepFind(raw, (k,v)=>/^(in_?asset|asset_?in|from(asset|Coin|Symbol)|coinFrom|symbol_in)$/i.test(k) && typeof v==="string");
    }

    let network = firstTruthy(
      raw.in_network, raw.network_in, req.in_network, req.fromNetwork, req.chainFrom, req.chain_in,
      l1.network_in, p1.network_in, raw.network
    );
    if (!network) {
      network = deepFind(raw, (k,v)=>/^(in_?network|network_?in|from(Network|Chain)|chain_from|from_chain)$/i.test(k) && typeof v==="string");
    }

    const amountNum = numify(amount);
    const assetSym  = asset ? String(asset).toUpperCase() : null;
    const netSym    = network ? String(network).toUpperCase() : null;
    return { amount: amountNum ?? amount, asset: assetSym, network: netSym };
  }

  // ----- normalize (direct JSON)
  function normalizeFromDirect(raw) {
    const address = extractDepositAddress(raw);
    const qr = extractDepositQR(raw);
    const rawPhase = phaseFromEvidence(raw);
    const phase = clampMonotonic(rawPhase);

    const { amount, asset, network } = extractInAmountAssetNetwork(raw);
    return { address, qr, status: phase, rawPhase, amount, asset, network };
  }

  // ----- OPS panel (direct JSON only) -----
  function pickHash(x){ if(!x) return ""; if(Array.isArray(x)) return pickHash(x[0]); if(typeof x==="string") return x; if(typeof x==="number") return String(x);
    if(typeof x==="object"){ const K=["txid","txId","txHash","hash","hashIn","hashOut","payinHash","payoutHash","inputTxid","inputTxHash","outputTxid","transactionHash","id","tx_hash"]; for(const k of K){ if(x[k]) return pickHash(x[k]); } } return ""; }
  function ex(sym, net, h){ if(!h) return ""; const H=encodeURIComponent(h); sym=(sym||"").toUpperCase(); net=(net||"").toUpperCase();
    if(sym==="BTC") return `https://mempool.space/tx/${H}`;
    if(sym==="ETH"||net==="ETH") return `https://etherscan.io/tx/${H}`;
    if(sym==="USDT"&&net==="TRX") return `https://tronscan.org/#/transaction/${H}`;
    if((sym==="USDT"||sym==="USDC")&&net==="ETH") return `https://etherscan.io/tx/${H}`;
    if(sym==="LTC") return `https://litecoinspace.org/tx/${H}`;
    return ""; }

  // FIX: never show [object Object]; show "Pending…" until we have a string txid
  function row(label, value, sym, net){
    const h = pickHash(value);
    let full = (h || value || "—");
    if (typeof full === "object" || (typeof full === "string" && /^\[object Object\]$/.test(full))) {
      full = "Pending…";
    }
    const url = (typeof full === "string" && full !== "Pending…") && h ? ex(sym, net, h) : "";
    const v = url
      ? `<a class="v" href="${url}" target="_blank" rel="noopener" data-copy="${full}">${full}</a>`
      : `<span class="v" data-copy="${full}">${full}</span>`;
    return `<div class="k">${label}</div>${v}`;
  }

  function amt(n){ if(n==null||n==="") return "—"; const x=Number(n); if(!isFinite(x)) return String(n); let s=x.toFixed(Math.abs(x)<1?8:6); s=s.replace(/0+$/,'').replace(/\.$/,''); return s; }
  function mxBuildPanel(raw){
    if(!raw || !isObj(raw)) return `<div class="opsv2"><div class="sec"><div class="h">No data yet</div><div style="opacity:.7;font-size:12px">Waiting for provider payload…</div></div></div>`;
    const l1=(raw.leg1)||(Array.isArray(raw.legs)?raw.legs[0]:{})||{};
    const l2=(raw.leg2)||(Array.isArray(raw.legs)?raw.legs[1]:{})||{};
    const p1=l1.provider_info||l1.info||{}; const p2=l2.provider_info||l2.info||{}; const req=raw.req||raw.request||{};
    const inAsset=(firstTruthy(req.in_asset,l1.asset_in,raw.in_asset)||"").toString().toUpperCase();
    const inNet  = firstTruthy(req.in_network,l1.network_in,raw.in_network);
    const outAsset=(firstTruthy(req.out_asset,l2.asset_out,raw.out_asset)||"").toString().toUpperCase();
    const outNet  = firstTruthy(req.out_network,l2.network_out,raw.out_network);
    const inAmt=firstTruthy(l1.amount_in,p1.amount_in,p1.expectedAmountFrom,p1.amountFrom,p1.amount_from,req.amount);
    const dep1=firstTruthy(l1.deposit_address,l1.order?.depositAddress,l1.order?.payinAddress,p1.payinAddress,p1.depositAddress) || extractDepositAddress(raw);
    const hin1=firstTruthy(p1.payinHash,p1.inputTxid,p1.inputTxHash,p1.hashIn,p1.txHashIn,p1.depositHash,p1.depositTxId,l1.order?.payinHash);
    const hout1=firstTruthy(p1.payoutHash,p1.outputTxid,p1.txHashOut,p1.hashOut,p1.payout_txid,l1.order?.payoutHash,l1.hash_out);
    const xmrInAmt=firstTruthy(l2.order?.fromAmount,l2.order?.amountFrom,p2.amount_from,p2.fromAmount);
    const dep2=firstTruthy(l2.order?.depositAddress,l2.order?.payinAddress,p2.payinAddress,p2.depositAddress);
    const hin2=firstTruthy(raw.last_sent_txid,p2.inputTxid,p2.inputTxHash);
    const expectOut=firstTruthy(l2.order?.toAmount,l2.order?.amountTo,p2.amount_to,p2.toAmount,p2.amountTo);
    const userAddr=firstTruthy(req.payout_address,p2.payoutAddress,l2.order?.payoutAddress,raw.payout_address);
    const hout2=firstTruthy(p2.payoutHash,p2.outputTxid,p2.hashOut,p2.txHashOut,p2.txId,p2.transactionHash,p2.hash,l2.hash_out);
    const leg1Done = !!pickHash(hout1) || /finished|success|completed/.test(String(p1.status||p1.state||p1.stage||"").toLowerCase());
    const leg2Pending = !leg1Done ? `<div class="pending">Status: awaiting Leg 1 to finish…</div>` : "";
    return `
      <div class="opsv2">
        <div class="sec">
          <div class="h">Leg 1 — ${inAsset || "IN"} → XMR</div>
          <div class="grid">
            ${row("You sent:", inAmt?`${amt(inAmt)} ${inAsset}`:"—")}
            <div class="row"></div>
            ${row("Deposit address:", dep1)}
            <div class="row"></div>
            ${row("Hash in:", hin1, inAsset, inNet)}
            <div class="row"></div>
            ${row("Hash out (XMR):", hout1, "XMR","XMR")}
          </div>
        </div>
        <div class="sec">
          <div class="h">Leg 2 — XMR → ${outAsset || "OUT"}</div>
          <div class="grid">
            ${leg2Pending}
            ${row("You sent (XMR):", xmrInAmt?`${amt(xmrInAmt)} XMR`:"—")}
            <div class="row"></div>
            ${row("Deposit address:", dep2)}
            <div class="row"></div>
            ${row("Hash in (XMR):", hin2, "XMR","XMR")}
            <div class="row"></div>
            ${row("You get:", expectOut?`${amt(expectOut)} ${outAsset}`:"—")}
            <div class="row"></div>
            ${row("Recipient address:", userAddr)}
            <div class="row"></div>
            ${row("Hash out:", hout2, outAsset, outNet)}
          </div>
        </div>
      </div>`;
  }

  // — lazy fetch for panel if empty —
  let endpoint = null;
  async function detectStatusEndpoint(id) {
    const quick = [
      `/api/status/${encodeURIComponent(id)}`,
      `/api/status?sid=${encodeURIComponent(id)}`,
      `/api/checkout/${encodeURIComponent(id)}`,
      `/api/checkout?sid=${encodeURIComponent(id)}`,
      `/api/swap?sid=${encodeURIComponent(id)}`
    ];
    for (const url of quick) {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (r.ok) {
          const firstJson = await r.json().catch(() => ({}));
          return { url, firstJson };
        }
      } catch (_) {}
    }
    return null;
  }
  async function fetchLatestDirectRaw() {
    try {
      let url = endpoint;
      if (!url) {
        const found = await detectStatusEndpoint(swapId);
        if (!found) return null;
        endpoint = found.url;
        window.__opsLastRaw = found.firstJson || null;
        if (window.__opsLastRaw) saveSnapshot(swapId, window.__opsLastRaw, false);
        return window.__opsLastRaw;
      }
      const r = await fetch(url + (url.includes("?") ? "&" : "?") + `_t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return null;
      const raw = await r.json();
      window.__opsLastRaw = raw;
      saveSnapshot(swapId, raw, false);
      return raw;
    } catch { return null; }
  }

  window.mxOps_update = function(raw, phase){
    try{
      const wrap=$("opsWrap"), panel=$("opsPanel"); if(!wrap||!panel) return;
      wrap.style.display = (String(phase).toLowerCase()==="receiving") ? "none" : "block";
      if (panel.classList.contains("mx-hidden")) return;

      const useRaw = raw || window.__opsLastRaw || loadSnapshot(swapId) || null;
      panel.innerHTML = mxBuildPanel(useRaw);

      panel.querySelectorAll(".v").forEach(el=>{
        el.addEventListener("click", async ()=>{
          const v = el.getAttribute("data-copy") || "";
          if(!v || v==="—" || v==="Pending…") return;
          try{ await navigator.clipboard.writeText(v); el.classList.add("copied"); setTimeout(()=>el.classList.remove("copied"), 500);}catch{}
        });
      });
    }catch(e){ console.warn("opspanel err", e); }
  };

  (function(){
    const btn=$("opsToggle"), panel=$("opsPanel"); if(!btn||!panel) return;
    btn.addEventListener("click", async ()=>{
      panel.classList.toggle("mx-hidden");
      if (!panel.classList.contains("mx-hidden")){
        if (!window.__opsLastRaw && !loadSnapshot(swapId)) {
          const raw = await fetchLatestDirectRaw();
          window.mxOps_update(raw || null, window.lastStatus || "receiving");
        } else {
          window.mxOps_update(window.__opsLastRaw || null, window.lastStatus || "receiving");
        }
      }
    });
  })();

  // steps UI
  function updateSteps(status) {
    const steps = Array.from(document.querySelectorAll("#steps .mx-step"));
    const norm = (status || "").toLowerCase();
    const idx = STEP_INDEX[norm] ?? STEP_INDEX.receiving;
    steps.forEach((li, i) => {
      li.classList.remove("done", "active", "upcoming");
      if (i < idx) li.classList.add("done");
      else if (i === idx) li.classList.add("active");
      else li.classList.add("upcoming");
    });
    if (norm === "receiving") {
      showTimer(true);
      qs(".mx-row") && (qs(".mx-row").style.display = "flex");
      $("amountLine") && ($("amountLine").style.display = "flex");
      qs(".mx-label") && (qs(".mx-label").style.display = "block");
      setQrHintVisible(true);
    } else {
      showTimer(false);
      clearDeadline(swapId);
      if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
      qs(".mx-row") && (qs(".mx-row").style.display = "none");
      $("amountLine") && ($("amountLine").style.display = "none");
      qs(".mx-label") && (qs(".mx-label").style.display = "none");
      setQrHintVisible(false);
    }
    window.lastStatus = norm;
    window.mxOps_update(window.__opsLastRaw, norm);
  }

  function showDoneMessage() {
    const stepsWrap = $("steps"); if (stepsWrap) stepsWrap.style.display = "none";
    const grid = qs(".mx-grid");
    if (grid && !$("mxDoneNote")) {
      const note = document.createElement("div");
      note.id = "mxDoneNote";
      note.setAttribute("style", [
        "margin-top:20px","padding:12px 14px","border-radius:12px","display:flex","flex-direction:column","align-items:center","gap:6px",
        "background:linear-gradient(135deg, rgba(16,179,255,.14), rgba(16,179,255,.08))",
        "border:1px solid rgba(16,179,255,.35)","box-shadow:0 8px 22px rgba(0,0,0,.18), inset 0 1px 0 rgba(255,255,255,.15)",
        "color:var(--fg)","font-weight:700","text-align:center"
      ].join(";"));
      note.innerHTML = `<div style="display:flex;align-items:center;gap:8px;">
          <span aria-hidden="true" style="display:inline-grid;place-items:center;width:28px;height:28px;border-radius:999px;background:rgba(16,179,255,.25);border:1px solid rgba(16,179,255,.45);">
            <svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 12l4 4 8-8" fill="none" stroke="rgba(255,255,255,.95)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
          <span>🎉 Congratulations! Your swap is completed.</span>
        </div>
        <div style="font-weight:400;color:#9aa8b5;font-size:14px;margin-top:4px;">We'll be here when you're ready for your next swap</div>`;
      grid.appendChild(note);
    }
  }
  function finalizeSwapUI() {
    if (finalized) return;
    finalized = true;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    showTimer(false); clearDeadline(swapId);
    const box = $("qrBox");
    if (box) {
      box.classList.remove("grayed"); box.style.background = "transparent"; box.style.padding = "0";
      box.innerHTML = `<div class="mx-qr-badge" aria-label="Deposit received" style="margin-top:40px; margin-bottom:10px;">
          <svg viewBox="0 0 64 64" role="img" aria-hidden="true" style="width:120px;height:120px">
            <path d="M18 34l10 10L46 24" fill="none" stroke="#082f22" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>`;
    }
    setQrHintVisible(false);
    markSnapshotFinished(swapId);
    showDoneMessage();
  }

  // polling (direct JSON only)
  async function pollOnce() {
    if (!endpoint || finalized) return;
    try {
      const url = endpoint + (endpoint.includes("?") ? "&" : "?") + `_t=${Date.now()}`;
      const r = await fetch(url, {
        cache: "no-store",
        headers: { "cache-control":"no-cache, no-store, must-revalidate","pragma":"no-cache","expires":"0" }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const raw = await r.json();

      window.__opsLastRaw = raw;
      saveSnapshot(swapId, raw, false);

      const d = normalizeFromDirect(raw);
      setAddr(d.address || "—");
      if (d.qr) { hadProviderQR = true; setQR(d.qr); }
      else if (!hadProviderQR && d.address) { setFallbackQRFromAddress(d.address); }
      if (d.amount && d.asset) setAmountLine(d.amount, d.asset, d.network);

      const prev = window.lastStatus;
      const nxt = clampMonotonic(d.status);
      updateSteps(nxt);

      if ((prev === null && nxt !== "receiving") || (prev === "receiving" && nxt !== "receiving")) {
        showDepositReceivedBadge();
      }

      setPersistedStatusMonotonic(swapId, nxt);

      if (d.rawPhase === "sending_done") {
        markSnapshotFinished(swapId);
        finalizeSwapUI();
      }
    } catch (e) {
      console.error("Polling error:", e);
    }
  }

  // init
  (async function init(){
    $("swapIdLine").textContent = swapId || "—";
    $("copyBtn")?.addEventListener("click", async () => {
      const txt = $("addr")?.textContent || "";
      if (!txt || txt === "—") return;
      try { await navigator.clipboard.writeText(txt); $("copyBtn").textContent = "Copied!"; setTimeout(()=>$("copyBtn").textContent="Copy",1200);} catch(e){}
    });
    $("swapIdLine")?.addEventListener("click", async () => {
      const txt = $("swapIdLine")?.textContent || "";
      if (!txt || txt === "—") return;
      try { await navigator.clipboard.writeText(txt); $("swapIdLine").textContent="Copied!"; $("swapIdLine").classList.add("copied"); setTimeout(()=>{ $("swapIdLine").textContent = swapId || "—"; $("swapIdLine").classList.remove("copied"); }, 1200);} catch(e){}
    });
    if (!swapId) return;

    const persisted = getPersistedStatus(swapId);
    updateSteps(persisted || "receiving");
    ensureReceivingTimerForSwap(swapId);
    setQrHintVisible(true);

    // hydrate panel early if we have a snapshot
    const snap = loadSnapshot(swapId);
    if (snap) window.__opsLastRaw = snap;

    const found = await detectStatusEndpoint(swapId);
    if (!found) {
      const msg = document.createElement("div");
      msg.className = "mx-softerr";
      msg.textContent = "Waiting for provider… (order created, status endpoint not ready yet)";
      qs(".mx-card")?.appendChild(msg);
      setTimeout(init, 2000);
      return;
    }
    endpoint = found.url;

    // paint with first payload
    const d0 = normalizeFromDirect(found.firstJson || {});
    window.__opsLastRaw = found.firstJson || window.__opsLastRaw || null;
    if (window.__opsLastRaw) saveSnapshot(swapId, window.__opsLastRaw, false);

    setAddr(d0.address || "—");
    if (d0.qr) { hadProviderQR = true; setQR(d0.qr); }
    else if (d0.address) { setFallbackQRFromAddress(d0.address); }
    if (d0.amount && d0.asset) setAmountLine(d0.amount, d0.asset, d0.network);

    let startPhase = d0.status;
    if (persisted && rank(persisted) > rank(startPhase)) startPhase = persisted;
    updateSteps(startPhase);
    setPersistedStatusMonotonic(swapId, startPhase);

    if (startPhase && String(startPhase).toLowerCase() !== "receiving") {
      showDepositReceivedBadge();
      showTimer(false); clearDeadline(swapId);
      qs(".mx-row") && (qs(".mx-row").style.display = "none");
      $("amountLine") && ($("amountLine").style.display = "none");
      qs(".mx-label") && (qs(".mx-label").style.display = "none");
      setQrHintVisible(false);
    }
    if (d0.rawPhase === "sending_done") {
      markSnapshotFinished(swapId);
      finalizeSwapUI();
      return;
    }

    pollTimer = setInterval(pollOnce, 5000);
  })();
})();
