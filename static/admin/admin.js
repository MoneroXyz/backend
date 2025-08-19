(function () {
  const $ = (s) => document.querySelector(s);

  const tbody    = $("#tbl tbody");
  const statusSel= $("#status");
  const q        = $("#q");
  const count    = $("#count");
  const pageInfo = $("#pageInfo");

  let page = 1, pageSize = 25;

  const to6 = (v) => (v == null || Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(6));
  const to2 = (v) => (v == null || Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(2));
  const safe = (x) => (x == null ? "" : String(x));

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

  // Map backend bucket -> user-facing badge label
  function prettyStatusLabel(bucket) {
    const b = (bucket || "").toLowerCase();
    if (b === "finished")  return "Completed";
    if (b === "failed")    return "Failed";
    if (b === "expired")   return "Expired";
    if (b === "refunded")  return "Refunded";
    return "Active";
  }

  function pill(bucket) {
    const cls = (bucket || "active").toLowerCase();
    const label = prettyStatusLabel(bucket);
    return `<span class="badge status-${cls}">${label}</span>`;
  }

  function renderTable(j) {
    tbody.innerHTML = "";
    count.textContent = `${j.total ?? 0} result(s)`;
    pageInfo.textContent = `Page ${j.page ?? 1} of ${Math.max(1, Math.ceil((j.total ?? 0) / (j.page_size ?? pageSize)))}`;

    for (const row of (j.items || [])) {
      const tr = document.createElement("tr");
      const id = row.id || "";
      const inStr  = `${row.in_asset || ""} / ${row.in_network || ""}`;
      const outStr = `${row.out_asset || ""} / ${row.out_network || ""}`;
      const st = row.status_bucket || "active";

      tr.innerHTML = `
        <td><a href="#" class="lnk" data-id="${id}">${id.slice(0, 8)}…</a></td>
        <td>${inStr}</td>
        <td>${outStr}</td>
        <td>${row.leg1_provider || ""}</td>
        <td>${row.leg2_provider || ""}</td>
        <td>${pill(st)}</td>
        <td>${to6(row.our_fee_xmr ?? 0)}</td>
      `;

      tbody.appendChild(tr);
    }

    // link handlers
    [...document.querySelectorAll("a.lnk")].forEach((a) => {
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

  const kv = (k, v) => `<div class="kv"><div>${k}</div><div>${v}</div></div>`;

  // Try to discover OUT amount from several common fields if backend didn't store req.out_amount
  function getOutAmount(swap) {
    const req = swap.req || {};
    if (req.out_amount != null && req.out_amount !== "") return req.out_amount;

    const l2 = swap.leg2 || {};
    const cands = [
      l2?.provider_info?.withdrawal?.amount,
      l2?.provider_info?.toAmount,
      l2?.provider_info?.amount_out,
      l2?.order?.withdrawal?.amount,
      l2?.order?.toAmount,
    ];
    for (const v of cands) {
      if (v != null && v !== "") return v;
    }
    return null;
  }

  // Fee line with % that falls back to pending if gross is 0
  function feeLine(label, feeXMR, feePct, feeUSD, gross) {
    let pctText = "pending";
    if (gross > 0) {
      let pct = (feePct != null ? Number(feePct) : null);
      if ((pct == null || Number.isNaN(pct)) && feeXMR != null) {
        const f = Number(feeXMR);
        pct = (Number.isFinite(f) ? (f / gross) * 100 : null);
      }
      pctText = (pct == null || !Number.isFinite(pct)) ? "—" : `${to2(pct)}%`;
    }
    const usdText = (feeUSD == null || Number.isNaN(Number(feeUSD))) ? "—" : to2(feeUSD);
    return kv(label, `${to6(feeXMR)} XMR (${pctText}) — $${usdText}`);
  }

  function renderDetail(j) {
    $("#detail").style.display = "block";

    const s = j.swap || {};
    const m = j.metrics || {};

    $("#d_title").textContent = `Swap ${s.id || ""}`;

    const req = s.req || {};
    const t = fmtLocalWithTZ(s.created || 0);
    const outAmt = getOutAmount(s);

    const summaryHtml = [
      kv("ID:", safe(s.id)),
      kv("Created:", `${t.local} (${t.tz})`),
      kv("Created (UTC):", t.utc),
      kv("Leg1:", safe(s.leg1?.provider)),
      kv("Leg2:", safe(s.leg2?.provider)),
      kv("IN:", `${safe(req.in_asset)} / ${safe(req.in_network)} — ${safe(req.amount)}`),
      kv("OUT:", `${safe(req.out_asset)} / ${safe(req.out_network)}${outAmt != null ? " — " + safe(outAmt) : ""}`),
      kv("Subaddress:", safe(s.subaddr)),
      kv("Last send txid:", safe(s.last_sent_txid)),
    ].join("");
    $("#d_summary").innerHTML = summaryHtml;

    const gross = Number(m.gross_xmr_seen || 0);
    const metricsHtml = [
      kv("XMR/USD:", `$${to2(m.xmr_usd)}`),
      kv("Gross XMR seen:", to6(m.gross_xmr_seen)),
      kv("Net XMR estimated:", to6(m.net_xmr_estimated)),
      `<hr style="border:none;border-top:1px solid #1f1f1f;margin:8px 0;" />`,
      feeLine("Our fee:", m.our_fee_xmr, m.our_fee_pct, m.our_fee_usd, gross),
      feeLine("Provider fee:", m.provider_fee_xmr, m.provider_fee_pct, m.provider_fee_usd, gross),
    ].join("");
    $("#d_metrics").innerHTML = metricsHtml;

    const providersHtml = [
      kv("Leg1 provider:", safe(s.leg1?.provider)),
      kv("Leg1 provider ID:", safe(s.leg1?.tx_id) || "—"),
      kv("Leg2 provider:", safe(s.leg2?.provider)),
      kv("Leg2 provider ID:", safe(s.leg2?.tx_id) || "—"),
    ].join("");
    $("#d_providers").innerHTML = providersHtml;

    // Raw toggle
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

  // events
  $("#btnSearch").addEventListener("click", () => { page = 1; fetchList(); });
  $("#prev").addEventListener("click", () => { page = Math.max(1, page - 1); fetchList(); });
  $("#next").addEventListener("click", () => { page = page + 1; fetchList(); });

  // initial load
  fetchList();
})();
