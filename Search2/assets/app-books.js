/* Books desk — money: monthly P&L off the transactions ledger, the VAT
   threshold gauge, IRP6, the newest ledger rows, and the documents flow
   (upload → drain → Gemini-extract → you post; nothing posts unreviewed).
   Bookmarked for a later build (not in the pipeline yet): bank-statement
   import + reconciliation workbench, cash-position cards, the
   affordability gate, FX/fee-anomaly watch, evidence coverage, SARS
   export pack. */

function renderBooksDesk(root) {
  const a = S.admin || {};
  const acc = a.accounting || {};
  const orders = a.orders || {};
  const pnl = acc.pnl || [];
  const month = pnl[pnl.length - 1] || {};

  root.append(deskHead("Books",
    "cash → ledger → views · append-only ledger, corrections are reversing " +
    "entries · actions ride the command queue · updated " + fmtAgo(a.generated_at)));

  if ((acc.finances || {}).role_denied_at) {
    root.append(el("div", { class: "warnbar bad" },
      "Amazon Finances denied — grant the SP-API app the 'Finance and " +
      "Accounting' role in Seller Central; settlement actuals are missing until then."));
  }

  /* awaiting payment + stock chips */
  const out = orders.outstanding || {};
  const inv = orders.inventory || {};
  root.append(el("div", { class: "chiprow", style: "margin:0" },
    out.count
      ? pill("warn", `${out.count} order${out.count > 1 ? "s" : ""} awaiting payment — ${fmtR(out.total_rand)}`)
      : pill("ok", "no payments outstanding"),
    el("a", {
      class: "b sm line",
      href: "https://www.aliexpress.com/p/order/index.html",
      target: "_blank", rel: "noopener",
    }, "💳 Pay on AliExpress ↗"),
    inv.rows
      ? el("span", {
          class: "pill ok", style: "cursor:pointer",
          onclick: () => setDesk("stock"),
        }, `📥 ${fmtNum(inv.units)} units on hand — ${fmtR(inv.value_rand)} landed (estimate) · Stock desk →`)
      : null));

  /* P&L KPI cards */
  const rev = month.revenue || {};
  const totalSales = (rev.amazon || 0) + (rev.takealot || 0);
  root.append(el("div", { class: "kpis" },
    kpi(`Sales · Amazon`, fmtR(rev.amazon || 0),
      totalSales ? `${Math.round(((rev.amazon || 0) / totalSales) * 100)}% of ${month.month || "this month"}` : month.month || ""),
    kpi(`Sales · Takealot`, fmtR(rev.takealot || 0),
      totalSales ? `${Math.round(((rev.takealot || 0) / totalSales) * 100)}% · second channel` : ""),
    kpi("Total sales", fmtR(totalSales), `${month.month || "this month"} · both channels`),
    kpi("Net · after costs",
      el("span", { class: (month.net ?? 0) >= 0 ? "v ok" : "v hot" }, fmtR(month.net ?? 0)),
      month.estimate_rand ? `${fmtR(month.estimate_rand)} rests on estimates` : "actuals only")));

  /* main grid */
  const left = el("div", { style: "display:flex;flex-direction:column;gap:14px;min-width:0" });
  const right = el("div", { style: "display:flex;flex-direction:column;gap:14px;min-width:0" });
  root.append(el("div", {
    style: "display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:14px;align-items:start",
    class: "bookgrid",
  }, left, right));

  left.append(pnlPanel(acc, pnl));
  left.append(ledgerPanel(acc));
  right.append(taxPanel(acc));
  right.append(docsPanelEl(acc));

  root.append(el("div", { class: "hint" },
    "Bookmarked for a later build: bank-statement import & reconciliation, " +
    "cash-position cards (Capitec / Shyft), the affordability gate, FX & " +
    "fee-anomaly watch, evidence coverage and the SARS export pack."));
}

function pnlPanel(acc, pnl) {
  const p = panelEl("Monthly P&L", {
    soft: "— per channel, off the transactions ledger",
    right: (acc.finances || {}).events_polled_at
      ? el("span", {}, "finances polled ", agoSpan(acc.finances.events_polled_at))
      : "Amazon Finances not yet polled",
  });
  if (!pnl.length) {
    p.append(emptyLine("no ledger months yet — the first sale or posted " +
      "document starts the P&L"));
    return p;
  }
  const table = el("table", { class: "grid" },
    el("tr", {}, el("th", {}, "Month"), el("th", { class: "r" }, "Amazon"),
      el("th", { class: "r" }, "Takealot"), el("th", { class: "r" }, "Fees"),
      el("th", { class: "r" }, "COGS"), el("th", { class: "r" }, "Expenses"),
      el("th", { class: "r" }, "Net")));
  for (const m of [...pnl].reverse()) {
    table.append(el("tr", {},
      el("td", { class: "t" }, m.month + (m.estimate_rand ? " ~" : "")),
      el("td", { class: "r" }, fmtR((m.revenue || {}).amazon)),
      el("td", { class: "r" }, fmtR((m.revenue || {}).takealot)),
      el("td", { class: "r" }, fmtR(m.fees)),
      el("td", { class: "r" }, fmtR((m.cogs || {}).total)),
      el("td", { class: "r" }, fmtR(m.expenses)),
      el("td", { class: "r", style: `font-weight:650;color:var(--${(m.net ?? 0) >= 0 ? "ok-text" : "bad"})` },
        fmtR(m.net))));
  }
  p.append(el("div", { class: "scroll-x" }, table),
    el("div", { class: "hint", style: "margin-top:6px" },
      "~ = month includes estimated rows (AliExpress supplier costs post as " +
      "order-time ZAR estimates until actuals replace them)"));
  return p;
}

function ledgerPanel(acc) {
  const p = panelEl("Ledger", {
    soft: `— ${fmtNum(acc.ledger_rows || 0)} rows · append-only`,
  });
  if (!(acc.recent || []).length) {
    p.append(emptyLine("no ledger rows yet"));
    return p;
  }
  const table = el("table", { class: "grid" },
    el("tr", {}, el("th", {}, "When"), el("th", {}, "Account"),
      el("th", {}, "Description"), el("th", { class: "r" }, "Amount"),
      el("th", {}, "Basis")));
  for (const r of acc.recent) {
    table.append(el("tr", {},
      el("td", { class: "t", style: "color:var(--muted);font-size:12px" }, fmtDate(r.posted_at)),
      el("td", { class: "t", style: "font-size:12px" },
        `${r.account ?? ""} ${r.account_name ?? ""}`),
      el("td", { class: "t", style: "color:var(--ink2);font-size:12px" }, r.description ?? ""),
      el("td", { class: "r", style: (r.amount ?? 0) > 0 ? "color:var(--ok-text)" : "" },
        (r.amount ?? 0) > 0 ? `+${fmtR(r.amount).slice(2)}` : fmtR(r.amount)),
      el("td", { class: "t" }, el("span", {
        class: `st ${r.basis === "actual" ? "mute" : "warn"}`,
        style: "font-weight:400;font-size:12px",
      }, r.basis ?? ""))));
  }
  p.append(el("div", { class: "scroll-x" }, table),
    el("div", { class: "hint", style: "margin-top:6px" },
      "append-only by design: corrections post a reversing entry plus the " +
      "correction — full history via scripts/accounting_admin.py"));
  return p;
}

function taxPanel(acc) {
  const supplies = acc.supplies_12mo || {};
  const irp6 = acc.irp6 || {};
  const pct = Math.round((supplies.fraction || 0) * 100);
  const p = panelEl("Tax", {
    right: acc.vat_registered ? pill("warn", "VAT REGISTERED") : null,
  });
  p.append(el("div", { class: "kvrow" },
    el("span", { class: "k" }, "VAT registration threshold — rolling 12mo"),
    el("span", { class: "v", style: "font-weight:650" }, `${pct}%`)));
  p.append(el("div", { class: "gauge" },
    el("span", { style: `width:${Math.min(100, pct)}%` })));
  p.append(el("div", { class: "hint", style: "margin-top:4px" },
    `${fmtR(supplies.total_rand)} of ${fmtR(supplies.threshold_rand)}` +
    (pct < 60 ? " — headroom; the alert arms at 60%" : " — nearing the threshold")));
  p.append(el("div", { class: "kvrow", style: "margin-top:8px;padding-top:8px;border-top:1px solid var(--line-soft)" },
    el("span", { class: "k" },
      `${irp6.next_deadline_label || "IRP6"} · tax year ${irp6.tax_year ?? "—"}`),
    el("span", { class: "v", style: "font-weight:650" },
      irp6.days_to_deadline != null ? `in ${irp6.days_to_deadline}d` : "—")));
  p.append(el("div", { class: "kvrow" },
    el("span", { class: "k" }, "YTD profit"),
    el("span", { class: "v" }, fmtR(irp6.ytd_profit_rand))));
  p.append(el("div", { class: "kvrow" },
    el("span", { class: "k" }, "Annualised"),
    el("span", { class: "v" }, fmtR(irp6.annualised_rand))));
  p.append(el("div", { class: "hint", style: "margin-top:4px" },
    "records live in SA for 5 years — the documents panel below is the evidence store"));
  return p;
}

/* Documents: upload → Worker R2 transit → serve drains to the local store →
   Gemini extracts → Post/Ignore here (accounting.post_docs / ignore_docs). */
const DOC_STATUS_TONE = {
  new: "mute", extracted: "warn", posted: "ok",
  ignored: "mute", extract_failed: "hot", ingested: "ok",
};

function docsPanelEl(acc) {
  const status = statusLine();
  const p = panelEl("Documents & evidence", {
    soft: "— upload → Gemini reads → you post",
  });

  const transit = el("div", { class: "hint", style: "margin-top:6px" });
  async function loadTransit() {
    if (!localStorage.getItem(PAT_KEY) || !LIVE_BASE) return;
    try {
      const resp = await fetch(`${LIVE_BASE}/api/docs`,
        { headers: liveHeaders(), cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const docs = (await resp.json()).docs || [];
      transit.textContent = docs.length
        ? `in transit, awaiting drain: ${docs.map((d) => d.name).join(", ")}`
        : "";
    } catch (e) { transit.textContent = ""; }
  }
  loadTransit();

  async function upload(files) {
    if (!localStorage.getItem(PAT_KEY)) { withToken(() => upload(files)); return; }
    let done = 0;
    for (const file of files) {
      status.textContent = `Uploading ${file.name}…`;
      try {
        const resp = await fetch(`${LIVE_BASE}/api/docs`, {
          method: "POST",
          headers: { ...liveHeaders(),
                     "content-type": file.type || "application/octet-stream",
                     "x-doc-name": encodeURIComponent(file.name) },
          body: file,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        done++;
      } catch (e) {
        status.textContent = `Upload of ${file.name} failed: ${e.message}`;
        if (/401|403/.test(e.message)) localStorage.removeItem(PAT_KEY);
        return;
      }
    }
    try {
      await mutateCommands((doc) => {
        doc.docs = { ...(doc.docs || {}), uploaded_at: new Date().toISOString() };
      }, "Dashboard: documents uploaded");
      status.textContent = `${done} file(s) uploaded — the pipeline drains and ` +
        "extracts within seconds ('serve' must be up).";
    } catch (e) {
      status.textContent = `${done} file(s) uploaded — wake-up stamp failed; ` +
        "the backstop drain picks them up within ~5 min.";
    }
    loadTransit();
  }

  const input = el("input", {
    type: "file", multiple: "", accept: ".pdf,.jpg,.jpeg,.png,.webp,.csv",
    style: "display:none",
    onchange: (ev) => {
      if (ev.target.files?.length) upload([...ev.target.files]);
      ev.target.value = "";
    },
  });
  const drop = el("div", {
    class: "drop", style: "cursor:pointer",
    onclick: () => input.click(),
    ondragover: (ev) => { ev.preventDefault(); drop.classList.add("over"); },
    ondragleave: () => drop.classList.remove("over"),
    ondrop: (ev) => {
      ev.preventDefault();
      drop.classList.remove("over");
      if (ev.dataTransfer?.files?.length) upload([...ev.dataTransfer.files]);
    },
  },
    el("div", { class: "ic" }, "⇪"),
    el("div", { style: "flex:1" },
      el("div", { style: "font-size:12.5px;font-weight:600" },
        "Drop files or ", el("span", { style: "color:var(--acc)" }, "browse")),
      el("div", { class: "hint" },
        "PDF/JPG/PNG/WEBP/CSV up to 25 MB — supplier invoices, SAD 500 / " +
        "clearance, courier invoices, bank statements (Capitec/Shyft " +
        "exports become reconciliation lines)")),
    input);
  p.append(drop, transit,
    el("div", { class: "hint", style: "margin-top:6px" },
      "uploads drain to the local canonical store within seconds (SARS: " +
      "records live in SA) · nothing posts without a click"));

  function decide(id, action) {
    busAct(`${action} document`, (doc) => {
      const bucket = (doc.accounting ??= {});
      const key = action === "post" ? "post_docs" : "ignore_docs";
      const fresh = (bucket[key] || []).filter((e) => e.id !== id &&
        Date.now() - new Date(e.requested_at).getTime() < 48 * 3600 * 1000);
      fresh.push({ id, requested_at: new Date().toISOString() });
      bucket[key] = fresh;
    }, status, `${action} sent — applied within ~30s ('serve' must be up).`);
  }

  const docs = acc.documents || [];
  const cards = el("div", { style: "margin-top:12px" });
  for (const d of docs) {
    const tone = DOC_STATUS_TONE[d.status] || "mute";
    const read = d.bank
      ? `statement → ${d.bank.account} · ${d.bank.lines_added} new line(s)` +
        (d.bank.closing_balance != null
          ? ` · closing ${d.currency ?? ""} ${fmtNum(d.bank.closing_balance)}` : "")
      : d.doc_type
      ? `${d.doc_type} — ${d.supplier ?? "?"}` +
        (d.total_amount != null ? ` · ${d.currency ?? ""} ${fmtNum(d.total_amount)}` : "")
      : (d.error ?? "—");
    const suggested = (d.suggested || [])
      .map((s) => `${s.account}: ${fmtR(s.amount)} — ${s.description ?? ""}`).join("; ");
    cards.append(el("div", { class: "doccard" },
      el("div", { class: "dh" },
        el("span", { class: "fn" }, d.filename ?? d.id),
        el("span", { class: `pill ${tone}`, style: "font-size:11px" }, d.status),
        el("span", { style: "flex:1" }),
        d.confidence != null
          ? el("span", { class: "hint" }, `conf ${Math.round(d.confidence * 100)}%`)
          : (d.drained_at ? el("span", { class: "hint" }, fmtDate(d.drained_at)) : null)),
      el("div", { style: "font-size:12px;color:var(--ink2);margin-top:4px" },
        read, suggested ? el("span", {}, " · suggests ", el("b", {}, suggested)) : null),
      ["extracted", "extract_failed", "new"].includes(d.status)
        ? el("div", { style: "display:flex;gap:8px;margin-top:8px" },
            d.status === "extracted"
              ? el("button", { class: "b sm pri", onclick: () => decide(d.id, "post") },
                  "Post to ledger") : null,
            el("button", { class: "b sm", onclick: () => decide(d.id, "ignore") }, "Ignore"))
        : null));
  }
  if (!docs.length) {
    cards.append(emptyLine("no documents drained yet"));
  }
  p.append(cards, status);
  return p;
}
