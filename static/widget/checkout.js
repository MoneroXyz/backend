(() => {
  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(window.location.search);
  const swapId = params.get("sid") || params.get("swapId") || "";

  // Map backend status → index (0-based) in our stepper
  const STEP_INDEX = { receiving:0, routing:1, sending:2, complete:3 };

  let pollTimer = null;
  let lastStatus = null;

  function setAddress(addr) {
    $("addr").textContent = addr || "—";
  }

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

  // Stepper UI update
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

  async function poll() {
    try {
      const r = await fetch(`/api/checkout?sid=${encodeURIComponent(swapId)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();

      // expected: { deposit_address, qr_png, status, expires_at | time_left_iso }
      setAddress(data.deposit_address || data.address || "");
      if (lastStatus == null) {
        // first render QR
        setQR(data.qr_png || data.qr || "");
      }

      const status = (data.status || data.state || "receiving").toLowerCase();
      updateSteps(status);

      // When we leave "receiving", switch QR to green check
      if (lastStatus !== status) {
        if (lastStatus === null && status !== "receiving") {
          // if first status already past receiving, show badge directly
          showDepositReceivedBadge();
        } else if (lastStatus === "receiving" && status !== "receiving") {
          showDepositReceivedBadge();
        }
        lastStatus = status;
      }

      if (data.expires_at || data.time_left_iso) {
        updateTimer(data.expires_at || data.time_left_iso);
      }

      // stop polling on completion
      if (status === "complete" && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    } catch (e) {
      // soft fail; try again
      console.warn("poll error", e);
    }
  }

  function setupCopy() {
    $("copyBtn").addEventListener("click", async () => {
      const text = $("addr").textContent.trim();
      try { await navigator.clipboard.writeText(text); } catch(_) {}
      const btn = $("copyBtn"); const old = btn.textContent;
      btn.textContent = "Copied!"; setTimeout(()=>btn.textContent = old, 1000);
    });
  }

  // boot
  (function init(){
    $("swapIdLine").textContent = swapId || "—";
    setupCopy();
    if (!swapId) return;

    // first load
    poll();
    // then poll every 5s while not complete
    pollTimer = setInterval(poll, 5000);
  })();
})();
