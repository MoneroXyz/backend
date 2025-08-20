(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  const swapId = params.get("sid") || params.get("swapId") || "";

  const STEP_INDEX = { receiving:0, routing:1, sending:2, complete:3, finished:3, done:3 };

  let pollTimer = null;
  let lastStatus = null;
  let statusEndpoint = null;   // { url, from, firstJson }
  let timerHandle = null;
  let hadProviderQR = false;

  /* ---------- UI helpers ---------- */
  function setAddress(addr) { $("addr").textContent = addr || "—"; }

  function toDataUrlIfNeeded(qr) {
    if (!qr) return "";
    if (/^(data:|https?:)/i.test(qr)) return qr;            // already OK
    if (typeof qr === "string" && qr.trim().startsWith("<svg"))
      return "data:image/svg+xml;utf8," + encodeURIComponent(qr);
    if (/^[A-Za-z0-9+/=]+$/.test(qr) && qr.length > 100)    // bare base64 → assume png
      return `data:image/png;base64,${qr}`;
    return qr;                                              // let browser try
  }

  function setQR(src) {
    const img = $("qr");
    if (!img || !src) return;
    const processed = toDataUrlIfNeeded(src);
    if (!img.src || img.src !== processed) img.src = processed;
    img.alt = "Deposit QR";
  }

  // Fallback QR (if provider doesn't supply one): generate from address
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

  function ensureTimer(deadlineIso) {
    const tl = $("timeLeft");
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    if (!deadlineIso) { if (tl) tl.textContent = "—"; return; }
    const deadline = new Date(deadlineIso).getTime();
    const tick = () => { if (tl) tl.textContent = humanTimeLeft(deadline - Date.now()); };
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
    // Hide countdown once we leave Receiving; otherwise keep visible
    showTimer(norm === "receiving");
  }

  /* ---------- data helpers ---------- */
  const firstTruthy = (...vals) => {
    for (const v of vals) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      return v;
    }
    return undefined;
  };

  function normalizeDeadline(obj) {
    const iso = firstTruthy(obj?.expires_at, obj?.time_left_iso, obj?.deadline, obj?.expire_at);
    if (iso) return iso;

    const sec = Number(firstTruthy(obj?.expires_in, obj?.time_left_seconds, obj?.ttl, obj?.ttl_seconds));
    if (Number.isFinite(sec) && sec > 0) {
      return new Date(Date.now() + sec * 1000).toISOString();
    }
    return null;
  }

  function normalizeFromDirect(raw) {
    return {
      address: firstTruthy(raw.deposit_address, raw.address, raw.addr, raw.depositAddr),
      qr: firstTruthy(raw.qr_png, raw.qr, raw.deposit_qr, raw.qr_image, raw.qr_base64, raw.qrPng, raw.qrUrl),
      status: (firstTruthy(raw.status, raw.state, raw.stage, "receiving") + "").toLowerCase(),
      deadline: normalizeDeadline(raw),
      amount: firstTruthy(raw.in_amount, raw.amount_in, raw.amount),
      asset: firstTruthy(raw.in_asset, raw.asset_in, raw.asset),
      network: firstTruthy(raw.in_network, raw.network_in, raw.network)
    };
  }

  function normalizeFromAdmin(raw) {
    const swap = raw.swap || raw;
    const leg1 = swap.leg1 || {};
    const pinfo = leg1.provider_info || leg1.info || {};

    const address = firstTruthy(
      pinfo.deposit_address, pinfo.address, pinfo.addr, pinfo.payin_address, pinfo.address_in,
      leg1.deposit_address, leg1.address
    );
    const qr = firstTruthy(
      pinfo.qr_png, pinfo.qr, pinfo.deposit_qr, pinfo.qr_image, pinfo.qr_base64, pinfo.qrPng, pinfo.qrUrl
    );
    const status = (firstTruthy(
      swap.status, swap.state, leg1.status, pinfo.status, pinfo.state, pinfo.stage, "receiving"
    )+"").toLowerCase();

    const deadline = normalizeDeadline(pinfo) || normalizeDeadline(swap) || null;

    const request = swap.request || {};
    const amount = firstTruthy(leg1.amount_in, request.amount, swap.amount_in);
    const asset = firstTruthy(request.in_asset, leg1.asset_in, swap.in_asset);
    const network = firstTruthy(request.in_network, leg1.network_in, swap.in_network);

    return { address, qr, status, deadline, amount, asset, network };
  }

  async function detectStatusEndpoint(id) {
    const quick = [
      `/api/checkout?sid=${encodeURIComponent(id)}`,
      `/api/status?sid=${encodeURIComponent(id)}`,
      `/api/order?sid=${encodeURIComponent(id)}`,
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

  function normalizeData(raw, from) {
    try { return from === "admin" ? normalizeFromAdmin(raw) : normalizeFromDirect(raw); }
    catch { return { address:"", qr:"", status:"receiving", deadline:null }; }
  }

  function renderAmountReminder(amount, asset, network) {
    const box = $("amountLine");
    if (!box) return;
    if (amount && asset) {
      $("needAmount").textContent = String(amount);
      $("needAsset").textContent = String(asset);
      $("needNet").textContent = network ? `(${network})` : "";
      box.hidden = false;
    } else {
      box.hidden = true;
    }
  }

  async function pollOnce() {
    if (!statusEndpoint) return;
    try {
      const r = await fetch(statusEndpoint.url, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const raw = await r.json();
      const data = normalizeData(raw, statusEndpoint.from);

      setAddress(data.address);

      // QR: prefer provider; else fallback to generated
      if (data.qr) {
        hadProviderQR = true;
        setQR(data.qr);
      } else if (!hadProviderQR && data.address) {
        setFallbackQRFromAddress(data.address);
      }

      renderAmountReminder(data.amount, data.asset, data.network);

      updateSteps(data.status);

      if (lastStatus !== data.status) {
        if (lastStatus === null && data.status !== "receiving") showDepositReceivedBadge();
        else if (lastStatus === "receiving" && data.status !== "receiving") showDepositReceivedBadge();
        lastStatus = data.status;
      }

      if (data.deadline) ensureTimer(data.deadline);

      if (["complete","finished","done"].includes((data.status||"").toLowerCase())) {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      }
    } catch { /* keep polling */ }
  }

  // boot
  (async function init(){
    $("swapIdLine").textContent = swapId || "—";
    $("copyBtn")?.addEventListener("click", async () => {
      const txt = $("addr")?.textContent || "";
      if (!txt || txt === "—") return;
      try {
        await navigator.clipboard.writeText(txt);
        $("copyBtn").textContent = "Copied!";
        setTimeout(() => $("copyBtn").textContent = "Copy", 1200);
      } catch {}
    });

    if (!swapId) return;

    // Start a 2h timer immediately — will be replaced if provider gives a deadline
    const fallbackDeadline = new Date(Date.now() + 2*60*60*1000).toISOString();
    ensureTimer(fallbackDeadline);
    showTimer(true);

    // Detect endpoint
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

    // First payload
    const first = normalizeData(found.firstJson || {}, found.from);
    setAddress(first.address);

    if (first.qr) {
      hadProviderQR = true;
      setQR(first.qr);
    } else if (first.address) {
      setFallbackQRFromAddress(first.address);
    }

    renderAmountReminder(first.amount, first.asset, first.network);

    if (first.deadline) ensureTimer(first.deadline);

    updateSteps(first.status);
    lastStatus = first.status;

    // Poll
    pollTimer = setInterval(pollOnce, 5000);
  })();
})();
