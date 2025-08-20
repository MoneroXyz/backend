(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  const swapId = params.get("sid") || params.get("swapId") || "";

  // Map backend status → index (0-based) in our stepper
  const STEP_INDEX = { receiving:0, routing:1, sending:2, complete:3 };

  let pollTimer = null;
  let lastStatus = null;
  let statusEndpoint = null; // will be detected

  function setAddress(addr) { $("addr").textContent = addr || "—"; }
  function setQR(src) {
    const img = $("qr");
    if (src) img.src = src;
    img.alt = "Deposit QR";
  }
  function showDepositReceivedBadge() {
    const box = $("qrBox");
    box.innerHTML = ""; // clear QR
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
  function updateTimer(deadlineIso) {
    if (!deadlineIso) { $("timeLeft").textContent = "—"; return; }
    const deadline = new Date(deadlineIso).getTime();
    const tick = () => { $("timeLeft").textContent = humanTimeLeft(deadline - Date.now()); };
    tick();
    setInterval(tick, 1000);
  }
  function updateSteps(status) {
    const idx = STEP_INDEX[(status || "").toLowerCase()] ?? 0;
    const steps = Array.from(document.querySelectorAll("#steps .mx-step"));
    steps.forEach((li, i) => {
      li.classList.remove("done","active","upcoming");
      if (i < idx) li.classList.add("done");
      else if (i === idx) li.classList.add("active");
      else li.classList.add("upcoming");
    });
  }

  // Try multiple endpoints until one works:
  //  - /api/checkout?sid=...
  //  - /api/status?sid=...
  //  - /api/order?sid=...
  //  - /api/swap?sid=...
  //  - /api/checkout/<sid>
  async function detectStatusEndpoint(id) {
    const candidates = [
      `/api/checkout?sid=${encodeURIComponent(id)}`,
      `/api/status?sid=${encodeURIComponent(id)}`,
      `/api/order?sid=${encodeURIComponent(id)}`,
      `/api/swap?sid=${encodeURIComponent(id)}`,
      `/api/checkout/${encodeURIComponent(id)}`
    ];
    for (const url of candidates) {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (r.ok) {
          // cache the exact url we will poll next time
          return { url, first: await r.json() };
        }
      } catch(_) {}
    }
    return null;
  }

  function normalizeData(raw) {
    // Accept many backends: deposit_address | address,
    // qr_png | qr | deposit_qr, status | state,
    // expires_at | time_left_iso | deadline
    return {
      address: raw.deposit_address || raw.address || "",
      qr: raw.qr_png || raw.qr || raw.deposit_qr || "",
      status: (raw.status || raw.state || "receiving").toLowerCase(),
      deadline: raw.expires_at || raw.time_left_iso || raw.deadline || null
    };
  }

  async function pollOnce() {
    if (!statusEndpoint) return;
    try {
      const r = await fetch(statusEndpoint, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = normalizeData(await r.json());

      setAddress(data.address);
      if (lastStatus == null) { setQR(data.qr); }

      updateSteps(data.status);

      if (lastStatus !== data.status) {
        if (lastStatus === null && data.status !== "receiving") {
          showDepositReceivedBadge();
        } else if (lastStatus === "receiving" && data.status !== "receiving") {
          showDepositReceivedBadge();
        }
        lastStatus = data.status;
      }

      if (data.deadline) updateTimer(data.deadline);

      if (data.status === "complete" && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    } catch (e) {
      console.warn("poll error", e);
      // keep polling; backend may be briefly unavailable
    }
  }

  // boot
  (async function init(){
    $("swapIdLine").textContent = swapId || "—";
    if (!swapId) return;

    // Detect endpoint & render first response immediately
    const found = await detectStatusEndpoint(swapId);
    if (!found) {
      // show soft message instead of whole‑page "Not found"
      const msg = document.createElement("div");
      msg.className = "mx-softerr";
      msg.textContent = "Waiting for provider… (order created, status endpoint not ready yet)";
      document.querySelector(".mx-card").appendChild(msg);
      // try again in a moment
      setTimeout(init, 2000);
      return;
    }

    statusEndpoint = found.url;

    // Render the first payload
    const first = normalizeData(found.first);
    setAddress(first.address);
    setQR(first.qr);
    updateSteps(first.status);
    if (first.deadline) updateTimer(first.deadline);
    lastStatus = first.status;

    // Start polling
    pollTimer = setInterval(pollOnce, 5000);
  })();
})();
