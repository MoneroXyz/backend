(async function(){
  const $ = s => document.querySelector(s);
  const tbody = $("#tbl tbody");
  const statusSel = $("#status");
  const q = $("#q");
  const count = $("#count");
  const pageInfo = $("#pageInfo");

  let page = 1, pageSize = 25;

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
        <td>${(row.our_fee_xmr ?? 0).toFixed(6)}</td>
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

  function renderDetail(j) {
    $("#detail").style.display = "block";
    const s = j.swap || {};
    $("#d_title").textContent = `Swap ${s.id || ""}`;

    const req = s.req || {};
    const sum = `
      <div><b>ID:</b> ${s.id || ""}</div>
      <div><b>Created:</b> ${new Date((s.created || 0) * 1000).toLocaleString()}</div>
      <div><b>Leg1:</b> ${s.leg1?.provider || ""}</div>
      <div><b>Leg2:</b> ${s.leg2?.provider || ""}</div>
      <div><b>IN:</b> ${req.in_asset || ""} / ${req.in_network || ""} — ${req.amount ?? ""}</div>
      <div><b>OUT:</b> ${req.out_asset || ""} / ${req.out_network || ""}</div>
      <div><b>Our fee (XMR):</b> ${s.our_fee_xmr ?? 0}</div>
      <div><b>Subaddress:</b> ${s.subaddr || ""}</div>
      <div><b>Last send txid:</b> ${s.last_sent_txid || ""}</div>
    `;
    $("#d_summary").innerHTML = sum;

    const m = j.metrics || {};
    const met = `
      <div><b>Gross XMR seen:</b> ${Number(m.gross_xmr_seen || 0).toFixed(6)}</div>
      <div><b>Net XMR estimated:</b> ${Number(m.net_xmr_estimated || 0).toFixed(6)}</div>
    `;
    $("#d_metrics").innerHTML = met;

    $("#d_raw").textContent = JSON.stringify(s, null, 2);
  }

  $("#btnSearch").addEventListener("click", () => { page = 1; fetchList(); });
  $("#prev").addEventListener("click", () => { page = Math.max(1, page-1); fetchList(); });
  $("#next").addEventListener("click", () => { page = page+1; fetchList(); });

  // Initial load
  fetchList();
})();
