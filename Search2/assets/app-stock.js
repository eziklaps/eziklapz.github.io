/* Stock desk — where every unit is: inbound AliExpress shipments (the
   logistics state machine), on-hand inventory receipts (Mark received),
   and the Takealot channel mirror. Velocity + listing state join from the
   buyer payload by ASIN, so cover-days need no extra publish.
   Not in the pipeline yet (bookmarked): FBA stock pool, a movements log,
   manual Move-stock / write-off entries. */

function stockModel() {
  const a = S.admin || {};
  const stock = a.stock || {};
  const byAsin = buyerByAsin();
  const account = ((S.seller || {}).takealot || {}).account || {};

  const transit = (stock.transit || []).map((t) => ({
    ...t,
    stalled: t.last_movement_at
      && (Date.now() - new Date(t.last_movement_at).getTime()) > 10 * 864e5,
  }));

  /* Takealot channel stock keyed by SKU title match is unreliable; offers
     carry the pipeline's own SKU (S2-<ASIN>) so parse the ASIN out. */
  const tkStock = {};
  for (const o of account.rows || []) {
    const m = /^S2-([A-Z0-9]{10})/.exec(o.sku || "");
    if (m && o.stock != null) tkStock[m[1]] = (tkStock[m[1]] || 0) + o.stock;
  }

  const rows = {};
  const row = (asin) => rows[asin] ??= {
    asin, title: null, home: 0, road: 0, tkl: tkStock[asin] ?? null,
    value: 0, received_at: null, product: byAsin[asin] || null,
  };
  for (const h of stock.on_hand || []) {
    const r = row(h.asin);
    r.title = h.title || r.title;
    r.home += h.units || 0;
    r.value += h.value_rand || 0;
    r.received_at = h.received_at || r.received_at;
  }
  for (const t of transit) {
    if (!t.asin) continue;
    const r = row(t.asin);
    r.title = t.title || r.title;
    r.road += t.quantity || 0;
    t.row = r;
  }
  for (const r of Object.values(rows)) {
    const p = r.product;
    r.title = r.title || (p && p.title) || r.asin;
    r.onHand = r.home + (r.tkl || 0);
    r.velocity = p && p.est_units_month != null ? p.est_units_month : null;
    r.live = !!(p && (p.listing?.state === "live" || p.takealot?.state === "live"));
    r.queued = !!(p && ((p.listing && !PARKED.has(p.listing.state) && p.listing.state !== "live")
      || (p.takealot && !PARKED.has(p.takealot.state) && p.takealot.state !== "live")));
    r.coverDays = (r.velocity && r.onHand > 0)
      ? r.onHand / (r.velocity / 30) : null;
    if (r.onHand > 0 && r.live && r.coverDays != null && r.coverDays <= 7) {
      r.group = "restock";
    } else if (r.onHand > 0 && !r.live) {
      r.group = "idle";
    } else if (r.onHand === 0 && r.road > 0) {
      r.group = "transit";
    } else {
      r.group = "healthy";
    }
  }
  const account_low = account.low_stock || [];
  return { rows: Object.values(rows), transit, account, account_low,
           totals: (a.orders || {}).inventory || {} };
}

function renderStockBadge() {
  if (!S.admin) return 0;
  const m = stockModel();
  return m.rows.filter((r) => r.group === "restock" || r.group === "idle").length
    + m.account_low.length;
}

function renderStockDesk(root) {
  const m = stockModel();
  const skus = m.rows.filter((r) => r.onHand > 0).length;
  const units = m.rows.reduce((s, r) => s + r.onHand, 0);
  const roadUnits = m.transit.reduce((s, t) => s + (t.quantity || 0), 0);
  const roadValue = m.transit.reduce((s, t) => s + (t.cost || 0), 0);
  const sellable = m.rows.filter((r) => r.live).reduce((s, r) => s + r.onHand, 0);
  const idleUnits = m.rows.filter((r) => r.group === "idle").reduce((s, r) => s + r.onHand, 0);
  const idleSkus = m.rows.filter((r) => r.group === "idle").length;
  const restock = m.rows.filter((r) => r.group === "restock");
  const alerts = restock.length + m.account_low.length;

  root.append(deskHead("Stock",
    `${skus} stocked SKU${skus === 1 ? "" : "s"} of ${((S.buyer || {}).products || []).length} winners · ` +
    "priority-sorted: what needs you floats to the top · landed-cost " +
    "estimates until actuals post"));

  root.append(el("div", { class: "kpis" },
    kpi("On hand", el("span", {}, fmtNum(units), " ",
      el("span", { style: "font-size:14px;color:var(--ink2);font-weight:600" }, "units")),
      `${skus} SKUs · ${fmtR(m.totals.value_rand || 0)} landed (estimate)`),
    kpi("On the road", el("span", {}, fmtNum(roadUnits), " ",
      el("span", { style: "font-size:14px;color:var(--ink2);font-weight:600" }, "inbound")),
      `${fmtR(roadValue)} committed · ${m.transit.length} shipment${m.transit.length === 1 ? "" : "s"}`),
    kpi("Sellable now", el("span", {}, fmtNum(sellable), " ",
      el("span", { style: "font-size:14px;color:var(--ink2);font-weight:600" }, `of ${fmtNum(units)}`)),
      idleUnits ? `${idleUnits} units idle across ${idleSkus} SKU${idleSkus === 1 ? "" : "s"} — no live listing` : "everything on hand is listed"),
    kpi("Restock alerts",
      el("span", { class: alerts ? "v hot" : "" }, fmtNum(alerts)),
      alerts ? "shortest cover floats to the top below" : "nothing running out"),
  ));

  /* ----- flow board ----- */
  const board = panelEl("Where everything is", {
    right: el("span", {}, "sold units flow to ",
      el("a", { onclick: () => setDesk("books"), style: "cursor:pointer" }, "Books →")),
  });
  const roadCell = el("div", { class: "flowcell" },
    el("div", { class: "fh" },
      el("div", { class: "ft" }, "🛣 On the road"),
      el("div", { class: "fn" }, `${fmtNum(roadUnits)} u · ${fmtR(roadValue)}`)),
    el("div", { class: "fs" },
      `${m.transit.length} shipment${m.transit.length === 1 ? "" : "s"} inbound from AliExpress`));
  for (const t of m.transit.slice(0, 3)) {
    roadCell.append(el("div", { class: "flowrow" },
      el("span", { style: "font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis" },
        `${t.title || t.asin || t.intent_id} ×${t.quantity}`),
      t.stalled
        ? el("span", { class: "st bad" }, `⚠ stalled ${Math.round((Date.now() - new Date(t.last_movement_at)) / 864e5)}d`)
        : el("span", { style: "color:var(--ink2);white-space:nowrap" },
            t.eta_at ? `ETA ${fmtDate(t.eta_at)}` : (t.state || "in transit"))));
  }
  if (m.transit.length > 3) {
    roadCell.append(el("div", { class: "flowrow", style: "color:var(--muted)" },
      el("span", {}, `+${m.transit.length - 3} more shipments`)));
  }
  if (!m.transit.length) roadCell.append(el("div", { class: "flowrow", style: "color:var(--muted)" }, el("span", {}, "nothing inbound")));

  const homeSkus = m.rows.filter((r) => r.home > 0);
  const homeCell = el("div", { class: "flowcell acc" },
    el("div", { class: "fh" },
      el("div", { class: "ft" }, "🏠 Home warehouse"),
      el("div", { class: "fn" },
        `${fmtNum(homeSkus.reduce((s, r) => s + r.home, 0))} u · ${fmtR(homeSkus.reduce((s, r) => s + r.value, 0))}`)),
    el("div", { class: "fs" }, `${homeSkus.length} SKU${homeSkus.length === 1 ? "" : "s"} · ships MFN orders + feeds the channels`));
  if (idleSkus) {
    homeCell.append(el("div", { class: "flowrow" },
      el("span", { style: "font-weight:600" }, `${idleUnits} unit${idleUnits === 1 ? "" : "s"} idle, ${idleSkus} SKU${idleSkus === 1 ? "" : "s"}`),
      el("span", { class: "st warn" }, "no live listing")));
  }
  for (const r of homeSkus.filter((x) => x.group !== "idle").slice(0, 2)) {
    homeCell.append(el("div", { class: "flowrow" },
      el("span", { style: "font-weight:600" }, `${r.title} ×${r.home}`),
      el("span", { style: "color:var(--ink2)" }, r.live ? "listed" : "")));
  }
  if (!homeSkus.length) {
    homeCell.append(el("div", { class: "flowrow", style: "color:var(--muted)" },
      el("span", {}, "empty — Mark received books arrivals in here")));
  }

  const tkRows = (m.account.rows || []);
  const channelCol = el("div", { style: "flex:1.05;display:flex;flex-direction:column;gap:8px;min-width:0" },
    el("div", { class: "flowcell", style: "flex:none" },
      el("div", { class: "fh" },
        el("div", { class: "ft" }, "🛒 Takealot"),
        el("div", { class: "fn" }, tkRows.length
          ? `${(m.account.counts || {}).buyable || 0} buyable of ${m.account.total || tkRows.length}`
          : "no offers")),
      m.account_low.length
        ? el("div", { class: "flowrow" },
            el("span", { style: "font-weight:600" }, m.account_low[0].title || m.account_low[0].sku),
            el("span", { class: "st bad" }, `🔴 ${m.account_low[0].stock} left`))
        : null,
      el("div", { class: "fs", style: "margin:4px 0 0" },
        tkRows.length && tkRows.every((o) => o.stock == null)
          ? "leadtime-model offers — stock counts appear once offers carry warehouse stock"
          : "")),
    el("div", { class: "flowcell", style: "flex:none" },
      el("div", { class: "fh" },
        el("div", { class: "ft" }, "📦 Amazon FBA"),
        el("div", { class: "fn" }, "not tracked yet")),
      el("div", { class: "fs", style: "margin:4px 0 0" },
        "FBA stock pool is bookmarked — lands with the first FBA inbound")));

  board.append(el("div", { class: "flow" },
    roadCell,
    el("div", { class: "flowarrow" }, el("span", { style: "font-size:16px" }, "→"),
      el("span", {}, "Mark received", el("br", {}), "books it in")),
    homeCell,
    el("div", { class: "flowarrow" }, el("span", { style: "font-size:16px" }, "→"),
      el("span", {}, "channel stock", el("br", {}), "(mirrors)")),
    channelCol));
  root.append(board);

  /* ----- per-SKU table ----- */
  const tablePanel = panelEl("Stock by product", {
    right: "cover = on hand ÷ daily velocity (rank-estimated)",
  });
  const groups = [
    ["restock", "Restock — cover running out", "bad"],
    ["idle", "Idle — on hand but not selling", "warn"],
    ["transit", "In transit only — not yet on hand", "mute"],
    ["healthy", "Healthy", "ok"],
  ];
  const anyRows = m.rows.length > 0;
  if (!anyRows) {
    tablePanel.append(emptyLine(
      "No stock yet — the first “Mark received” on the Buy desk books goods in here."));
  } else {
    const table = el("table", { class: "grid" },
      el("tr", {},
        el("th", {}, "Product"), el("th", { class: "r" }, "Road"),
        el("th", { class: "r" }, "Home"), el("th", { class: "r" }, "Takealot"),
        el("th", { class: "r" }, "On hand"), el("th", { class: "r" }, "Value"),
        el("th", { class: "r" }, "Cover"), el("th", {}, "")));
    const wrap = el("div", { class: "scroll-x" });
    for (const [key, label, tone] of groups) {
      const rows = m.rows.filter((r) => r.group === key)
        .sort((x, y) => (x.coverDays ?? 1e9) - (y.coverDays ?? 1e9));
      if (!rows.length) continue;
      const isHealthy = key === "healthy";
      const collapsed = isHealthy && !S.stockOpen && rows.length > 4;
      wrap.append(el("div", { class: "groupline" },
        dotEl(tone, true),
        `${label} · ${rows.length} SKU${rows.length === 1 ? "" : "s"} · ` +
        `${fmtNum(rows.reduce((s, r) => s + r.onHand, 0))} units`,
        isHealthy && rows.length > 4
          ? el("a", {
              style: "cursor:pointer;margin-left:8px;text-transform:none;letter-spacing:0",
              onclick: () => { S.stockOpen = !S.stockOpen; renderDesk(); },
            }, collapsed ? `Show all ${rows.length} ▾` : "Hide ▴")
          : null));
      if (collapsed) continue;
      const gtable = table.cloneNode(false);
      gtable.append(table.rows[0].cloneNode(true));
      for (const r of rows) gtable.append(stockRow(r));
      wrap.append(gtable);
    }
    tablePanel.append(wrap);
  }
  tablePanel.append(el("div", { class: "hint", style: "margin-top:8px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap" },
    el("span", {}, `${fmtNum(units)} units on hand · ${fmtR(m.totals.value_rand || 0)} landed (estimate)`),
    el("span", {}, "movements log, Move-stock and write-offs are bookmarked — " +
      "counts update from sales polls, tracking and Mark received")));
  root.append(tablePanel);
}

function stockRow(r) {
  const p = r.product;
  let cover;
  if (r.onHand === 0) {
    cover = el("span", { style: "color:var(--ink2)" }, "in transit");
  } else if (r.coverDays == null) {
    cover = el("span", { style: "color:var(--muted)" }, "—");
  } else if (r.coverDays < 1) {
    cover = el("span", { class: "st bad" }, "<1d 🔴");
  } else if (r.coverDays <= 7) {
    cover = el("span", { class: "st hot" }, `~${Math.round(r.coverDays)}d`);
  } else {
    cover = el("span", { style: "color:var(--ink2)" }, `~${Math.round(r.coverDays)}d`);
  }
  let action = el("span", {});
  if (r.group === "restock" && p) {
    action = el("button", { class: "b sm pri", onclick: () => openOrderModal(p) }, "Reorder");
  } else if (r.group === "idle" && p) {
    action = el("button", {
      class: "b sm line",
      onclick: () => setDesk("sell", { sellTab: p.channel === "takealot" ? "takealot" : "amazon" }),
    }, "Queue listing →");
  } else if (r.group === "transit") {
    action = el("span", { class: "hint" }, "🚚 in transit");
  }
  const sub = [];
  if (r.velocity != null) sub.push(`sells ≈${fmtNum(Math.round(r.velocity))}/mo`);
  if (r.group === "idle") sub.push(p && p.listing ? `listing ${INTENT_LABEL[p.listing.state] || p.listing.state}` : "no listing queued");
  if (r.group === "transit") sub.push(r.queued || r.live ? "listing under way — live by arrival if the feed clears" : "first stock");
  return el("tr", {},
    el("td", { class: "t" },
      el("div", { class: "rowtitle" }, r.title),
      sub.length ? el("div", { class: "rowsub" }, sub.join(" · ")) : null),
    el("td", { class: "r" }, r.road ? fmtNum(r.road) : el("span", { style: "color:var(--muted)" }, "—")),
    el("td", { class: "r" }, r.home ? fmtNum(r.home) : el("span", { style: "color:var(--muted)" }, "—")),
    el("td", { class: "r" }, r.tkl != null ? fmtNum(r.tkl) : el("span", { style: "color:var(--muted)" }, "—")),
    el("td", { class: "r", style: "font-weight:650" },
      r.onHand ? fmtNum(r.onHand) : el("span", { style: "color:var(--muted)" }, "0")),
    el("td", { class: "r" }, r.value ? fmtR(Math.round(r.value)) : el("span", { style: "color:var(--muted)" }, "—")),
    el("td", { class: "r" }, cover),
    el("td", { class: "r t" }, action));
}
