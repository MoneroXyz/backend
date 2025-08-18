(function(){
  const $ = s => document.querySelector(s);
  const tbody = $("#tbl tbody");
  const statusSel = $("#status");
  const q = $("#q");
  const count = $("#count");
  const pageInfo = $("#pageInfo");
  let page = 1, pageSize = 25;

  const to6 = v => (v == null ? "—" : Number(v).toFixed(6));
  const to2 = v => (v == null ? "—" : Number(v).toFixed(2));

  async function fetchList() {
    const params = new URLSearchParams();
    if (statusSel.value) params.set("status", statusSel.value);
    if (q.value) params.set("q", q.value);
    params.set("page", page);
    params.set("page_size", pageSize);

    const r = await fetch(`/api/admin/swaps?${params.toString()}`);
    const j = await r.json();
    renderTable(j);
  }

  function pill(text) {
    const cls = text;
    return `<span class="pill ${cls}">${text}</span>`;
  }

  function renderTable(j) {
    tbody.innerHTML = "";
    count.textContent = `${j.total} result(s)`;
    pageInfo.textContent = `Page ${j.page} of ${Math.max(1, Math.ceil(j.total / j.page_size))}`;

    for (const row of j.items) {
      const tr = document.createElement("tr");
      const id = row.id || "";
      const inStr = `${row.in_asset || ""} / ${row.in_network || ""}`;
      const outStr = `${row.out_asset || ""} / ${row.out_network || ""}`;
      const st = row.status_bucket || "active";
      tr.innerHTML = `
        <td><a href="#" data-id="${id}" class="lnk">${id.slice(0,8)}…</a></td>
        <td>${inStr}</td>
        <td>${outStr}</td>
        <td>${row.leg1_provider || ""}</td>
        <td>${row.leg2_provider || ""}</td>
        <td>${pill(st)}</td>
        <td>${to6(row.our_fee_xmr ?? 0)}</td>
      `;
      tbody.appendChild(tr);
    }

    [...document.querySelectorAll("a.lnk")].forEach(a => {
      a.addEventListener("click", async (e) => {
        e.preventDefault();
        const id = a.getAttribute("data-id");
        const r = await fetch(`/api/admin/swaps/${id}`);
        const j = await r.json();
        renderDetail(j);
      });
    });
  }

  function fmtLocalWithTZ(epochSec) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Local";
    const d = new Date((epochSec || 0) * 1000);
    const local = d.toLocaleString();
    const utc = d.toISOString().replace("T", " ").replace("Z", " UTC");
    return { local, tz, utc };
  }

  function safeStr(x) { return (x == null ? "" : String(x)); }

  function renderDetail(j) {
    $("#detail").style.display = "block";
    const s = j.swap || {};
    const m = j.metrics || {};
    $("#d_title").textContent = `Swap ${s.id || ""}`;

    const req = s.req || {};
    const t = fmtLocalWithTZ(s.created || 0);
    const sum = `
      <div class="kv"><b>ID:</b> ${s.id || ""}</div>
      <div class="kv"><b>Created:</b> ${t.local} <span class="muted">(${t.tz})</span></div>
      <div class="kv"><b>Created (UTC):</b> ${t.utc}</div>
      <div class="kv"><b>Leg1:</b> ${s.leg1?.provider || ""}</div>
      <div class="kv"><b>Leg2:</b> ${s.leg2?.provider || ""}</div>
      <div class="kv"><b>IN:</b> ${req.in_asset || ""} / ${req.in_network || ""} — ${req.amount ?? ""}</div>
      <div class="kv"><b>OUT:</b> ${req.out_asset || ""} / ${req.out_network || ""}</div>
      <div class="kv"><b>Subaddress:</b> ${s.subaddr || ""}</div>
      <div class="kv"><b>Last send txid:</b> ${s.last_sent_txid || ""}</div>
    `;
    $("#d_summary").innerHTML = sum;

    const met = `
      <div class="kv"><b>XMR/USD:</b> $${to2(m.xmr_usd)}</div>
      <div class="kv"><b>Gross XMR seen:</b> ${to6(m.gross_xmr_seen)}</div>
      <div class="kv"><b>Net XMR estimated:</b> ${to6(m.net_xmr_estimated)}</div>
      <hr />
      <div class="kv"><b>Our fee:</b> ${to6(m.our_fee_xmr)} XMR (${to2(m.our_fee_pct)}%) — $${to2(m.our_fee_usd)}</div>
      <div class="kv"><b>Provider fee:</b> ${to6(m.provider_fee_xmr)} XMR (${to2(m.provider_fee_pct)}%) — $${to2(m.provider_fee_usd)}</div>
    `;
    $("#d_metrics").innerHTML = met;

    // Providers & their IDs section
    const leg1Prov = safeStr(s.leg1?.provider);
    const leg2Prov = safeStr(s.leg2?.provider);
    const leg1Id = safeStr(s.leg1?.tx_id);
    const leg2Id = safeStr(s.leg2?.tx_id);
    const prov = `
      <div class="kv"><b>Leg1 provider:</b> ${leg1Prov}</div>
      <div class="kv"><b>Leg1 provider ID:</b> ${leg1Id || "—"}</div>
      <div class="kv"><b>Leg2 provider:</b> ${leg2Prov}</div>
      <div class="kv"><b>Leg2 provider ID:</b> ${leg2Id || "—"}</div>
    `;
    $("#d_providers").innerHTML = prov;

    // Raw toggle (hidden by default)
    const raw = $("#d_raw");
    raw.style.display = "none";
    raw.textContent = JSON.stringify(s, null, 2);
    const btn = $("#btnRaw");
    btn.textContent = "Show raw";
    btn.onclick = () => {
      const open = raw.style.display !== "none";
      raw.style.display = open ? "none" : "block";
      btn.textContent = open ? "Show raw" : "Hide raw";
    };
  }

  $("#btnSearch").addEventListener("click", () => { page = 1; fetchList(); });
  $("#prev").addEventListener("click", () => { page = Math.max(1, page-1); fetchList(); });
  $("#next").addEventListener("click", () => { page = page+1; fetchList(); });

  // Initial load
  fetchList();
})();
