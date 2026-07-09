/* Stock desk — where every unit is: inbound AliExpress shipments (the
   logistics state machine), per-location balances from the stock_movements
   log (received / sold / moved / write-off), and the Takealot channel
   mirror. Velocity + listing state join from the buyer payload by ASIN, so
   cover-days need no extra publish. Move-stock / write-offs post to the
   bus (doc.stock.moves → funnel/commands.sink_stock).
   Not in the pipeline yet (bookmarked): FBA stock pool. */

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
    locs: {}, value: 0, received_at: null, product: byAsin[asin] || null,
  };
  for (const h of stock.on_hand || []) {
    const r = row(h.asin);
    r.title = h.title || r.title;
    r.locs = h.locations || { home: h.units || 0 };
    r.home += r.locs.home || 0;
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
    /* Movement locations are the truth; the offer mirror only counts when
       no takealot units are tracked yet (offers carry no stock today). */
    const locUnits = Object.values(r.locs).reduce((s, n) => s + n, 0);
    if (r.locs.takealot != null) r.tkl = r.locs.takealot;
    r.other = Object.entries(r.locs)
      .filter(([k, v]) => k !== "home" && k !== "takealot" && v !== 0);
    r.onHand = locUnits + (r.locs.takealot == null ? (r.tkl || 0) : 0);
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
           movements: stock.movements || [],
           courier: a.courier || null,
           totals: (a.orders || {}).inventory || {} };
}

/* Move-stock / Write-off modal: posts one doc.stock.moves entry to the
   bus; the pipeline validates against the movement log's balance and a
   rejected move comes back in the movements list with the reason. */
function moveStockModal(r) {
  withToken(() => {
    const sources = Object.entries(r.locs).filter(([, v]) => v > 0);
    if (!sources.length) sources.push(["home", r.home]);
    const fromSel = el("select", { class: "in" },
      ...sources.map(([k, v], i) => el("option", {
        value: k, ...(i === 0 ? { selected: "" } : {}),
      }, `${k} (${v})`)));
    const modeSel = el("select", { class: "in" },
      el("option", { value: "move", selected: "" }, "Move to…"),
      el("option", { value: "write_off" }, "Write off"));
    const toChoices = ["takealot", "fba", "home"]
      .filter((k) => k !== sources[0][0]);
    const toSel = el("select", { class: "in" },
      ...toChoices.map((k, i) => el("option", {
        value: k, ...(i === 0 ? { selected: "" } : {}),
      }, k)),
      el("option", { value: "" }, "other…"));
    const toInput = el("input", {
      type: "text", class: "in", style: "display:none",
      placeholder: "location label", autocapitalize: "off",
    });
    toSel.addEventListener("change", () => {
      toInput.style.display = toSel.value ? "none" : "";
    });
    const maxQty = Math.max(...sources.map(([, v]) => v), 1);
    const qtySel = el("select", { class: "in" },
      ...Array.from({ length: Math.min(maxQty, 20) }, (_, i) =>
        el("option", { value: i + 1 }, `${i + 1}`)));
    const noteInput = el("input", {
      type: "text", class: "in wide", style: "margin-top:10px",
      placeholder: "note (why) — lands in the log; write-offs post it to Books",
    });
    const toRow = el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
      el("span", { class: "meta", style: "min-width:44px" }, "to"), toSel, toInput);
    modeSel.addEventListener("change", () => {
      toRow.style.display = modeSel.value === "write_off" ? "none" : "flex";
    });
    const status = statusLine();
    openModal(
      el("h3", {}, `Move stock — ${r.title || r.asin}`),
      el("p", { class: "meta" },
        "A move re-homes units in the log (nothing posts to the channels); " +
        "a write-off removes them and books the loss to Books at landed cost."),
      el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
        el("span", { class: "meta", style: "min-width:44px" }, "what"), modeSel, qtySel,
        el("span", { class: "meta" }, "unit(s)")),
      el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
        el("span", { class: "meta", style: "min-width:44px" }, "from"), fromSel),
      toRow,
      noteInput,
      el("button", {
        class: "b pri wide", style: "margin-top:12px",
        onclick: () => {
          const writeOff = modeSel.value === "write_off";
          const to = (toSel.value || toInput.value.trim().toLowerCase());
          if (!writeOff && !to) {
            status.textContent = "Name the destination location.";
            return;
          }
          if (!writeOff && to === fromSel.value) {
            status.textContent = "Destination matches the source.";
            return;
          }
          const entry = {
            asin: r.asin, quantity: Number(qtySel.value),
            from: fromSel.value,
            note: noteInput.value.trim() || undefined,
            requested_at: new Date().toISOString(),
          };
          if (writeOff) entry.write_off = true;
          else entry.to = to;
          busAct(writeOff ? `write off ${r.asin}` : `move ${r.asin}`, (doc) => {
            const bucket = (doc.stock ??= {});
            prunePush(bucket, "moves", entry, 2);
          }, status,
            "✅ Sent — the movement (or the reason it was rejected) shows " +
            "in the log within ~30s while 'serve' is up.");
        },
      }, "Commit"),
      el("button", {
        class: "b wide", style: "margin-top:8px",
        onclick: () => modalEl().close(),
      }, "Cancel"),
      status);
  });
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
    el("span", {}, "counts update from sales polls, Mark received and the " +
      "movements below — Move… re-homes or writes off units")));
  root.append(tablePanel);

  /* ----- movements log ----- */
  const movesPanel = panelEl("Movements", {
    right: "append-only — every unit in, out or re-homed",
  });
  if (!m.movements.length) {
    movesPanel.append(emptyLine(
      "No movements yet — the first “Mark received” writes the first row."));
  } else {
    const KIND = { received: ["📥", "Received"], sold: ["🛍", "Sold"],
                   moved: ["🔀", "Moved"], write_off: ["🗑", "Write-off"] };
    const t = el("table", { class: "grid" },
      el("tr", {},
        el("th", {}, "When"), el("th", {}, "What"),
        el("th", { class: "r" }, "Qty"), el("th", {}, "Route"),
        el("th", {}, "Note")));
    for (const mv of m.movements) {
      const [icon, label] = KIND[mv.kind] || ["•", mv.kind || "?"];
      const route = mv.kind === "received" ? `→ ${mv.to || "home"}`
        : mv.kind === "sold" ? `${mv.from || "?"} → sold`
        : mv.kind === "write_off" ? `${mv.from || "?"} → ✕`
        : `${mv.from || "?"} → ${mv.to || "?"}`;
      t.append(el("tr", {},
        el("td", { style: "white-space:nowrap;color:var(--ink2)" }, fmtDate(mv.at)),
        el("td", { class: "t" },
          el("div", { class: "rowtitle" },
            `${icon} ${label} — ${mv.title || mv.asin || "?"}`),
          mv.applied === false
            ? el("div", { class: "rowsub" },
                el("span", { class: "st bad" }, `rejected — ${mv.error || "?"}`))
            : (mv.note ? el("div", { class: "rowsub" }, mv.note) : null)),
        el("td", { class: "r" }, fmtNum(mv.quantity || 0)),
        el("td", { style: "white-space:nowrap" }, route),
        el("td", { class: "t", style: "color:var(--ink2)" },
          mv.source === "dashboard" ? "you" :
          mv.source === "sales_poll" ? "sales poll" :
          mv.source || "")));
    }
    movesPanel.append(el("div", { class: "scroll-x" }, t));
  }
  root.append(movesPanel);

  renderCourierPanel(root, m);
}

/* ----- courier panel: house → DC runs on TCG (Shiplogic API) -----
   Quote-first flow: a "Quote only" entry books nothing and comes back
   with the lane's live prices; a Book entry re-quotes at sink time and
   refuses over its price cap (the refusal shows the actual price).
   Delivered runs that carry an ASIN auto-move those units in the log. */
const COURIER_STATUS_TONE = {
  delivered: "ok", cancelled: "mute", quoted: "mute", error: "bad",
  "returned-to-sender": "bad", undeliverable: "bad",
};
function renderCourierPanel(root, m) {
  const c = m.courier;
  if (!c) return; // pre-upgrade payload — serve restart pending
  const right = !c.configured
    ? el("span", { class: "st warn" }, "TCG_API_KEY not set")
    : el("span", {},
        c.balance != null
          ? el("span", { class: c.low_balance ? "st bad" : "" },
              `prepaid ${fmtR(c.balance)}`)
          : "prepaid balance appears after the first poll",
        " · ",
        el("a", {
          onclick: () => bookCourierModal(m), style: "cursor:pointer",
        }, "Book courier…"));
  const panel = panelEl("Courier — DC runs", { right });
  if (c.auth_failed_at) {
    panel.append(el("div", { class: "hint", style: "color:var(--bad)" },
      "⚠ TCG rejected the API key — check TCG_API_KEY in .env (portal → Settings → API Keys)."));
  }
  if (c.low_balance) {
    panel.append(el("div", { class: "hint", style: "color:var(--bad)" },
      `⚠ prepaid balance ${fmtR(c.balance)} — top up in the TCG portal before the next run needs booking.`));
  }
  const ships = c.shipments || [];
  if (!ships.length) {
    panel.append(emptyLine(
      "No courier runs yet — “Book courier…” quotes and books TCG collections " +
      "from home to the Takealot DC or Amazon FC (quote first: it costs nothing)."));
  } else {
    const t = el("table", { class: "grid" },
      el("tr", {},
        el("th", {}, "When"), el("th", {}, "Run"), el("th", {}, "Status"),
        el("th", { class: "r" }, "Rate"), el("th", {}, "")));
    for (const s of ships) {
      const what = s.asin ? `${s.quantity || 1}× ${s.asin}` : (s.note || "parcels");
      const sub = [];
      if (s.tracking_reference) sub.push(s.tracking_reference);
      if (s.quote_only && (s.rates || []).length) {
        sub.push((s.rates || []).map((r) => `${r.code} ${fmtR(r.rate)}`).join(" · "));
      }
      if (s.error) sub.push(s.error);
      else if ((s.last_event || {}).message) sub.push(s.last_event.message);
      const tone = COURIER_STATUS_TONE[s.status]
        || (/exception|failed|rejected|hold/.test(s.status || "") ? "bad" : null);
      const chip = el("span", {
        class: tone === "bad" ? "st bad" : tone === "ok" ? "st hot" : "",
        style: tone === "mute" ? "color:var(--muted)" : "",
      }, s.status || "?");
      const actions = el("span", { style: "white-space:nowrap" });
      if (s.label_url) {
        actions.append(el("a", {
          href: s.label_url, target: "_blank", class: "b sm line",
        }, "Label"));
      } else if (s.tracking_reference && !s.quote_only
                 && !["cancelled", "error"].includes(s.status)) {
        actions.append(el("button", {
          class: "b sm line",
          onclick: () => courierAct(`label ${s.id}`,
            { id: s.id, relabel: true }),
        }, "Get label"));
      }
      if (s.cancellable) {
        actions.append(el("button", {
          class: "b sm line", style: "margin-left:6px",
          onclick: () => courierAct(`cancel ${s.id}`,
            { id: s.id, cancel: true }),
        }, "Cancel"));
      }
      t.append(el("tr", {},
        el("td", { style: "white-space:nowrap;color:var(--ink2)" },
          fmtDate(s.booked_at || s.created_at)),
        el("td", { class: "t" },
          el("div", { class: "rowtitle" },
            `${s.quote_only ? "💬 quote" : "🚚"} ${s.dest_label || s.dest} — ${what}`),
          sub.length ? el("div", { class: "rowsub" }, sub.join(" · ")) : null),
        el("td", {}, chip),
        el("td", { class: "r" }, s.rate != null ? fmtR(s.rate)
          : el("span", { style: "color:var(--muted)" }, "—")),
        el("td", { class: "r" }, actions)));
    }
    panel.append(el("div", { class: "scroll-x" }, t));
  }
  panel.append(el("div", { class: "hint", style: "margin-top:8px" },
    "collection is next business day (LOF cutoff 14:00) · a delivered run " +
    "with an ASIN moves those units home → DC in the log automatically · " +
    "spend posts to Books (Freight & clearing)"));
  root.append(panel);
}

function courierAct(label, fields) {
  withToken(() => {
    const entry = { ...fields, requested_at: new Date().toISOString() };
    busAct(label, (doc) => {
      const bucket = (doc.courier ??= {});
      prunePush(bucket, "requests", entry, 2);
    }, null);
  });
}

function bookCourierModal(m) {
  withToken(() => {
    const c = m.courier || {};
    const dests = (c.destinations || []);
    if (!dests.length) return;
    const modeSel = el("select", { class: "in" },
      el("option", { value: "quote", selected: "" }, "Quote only (free)"),
      el("option", { value: "book" }, "Book collection"));
    const destSel = el("select", { class: "in" },
      ...dests.map((d, i) => el("option", {
        value: d.key, ...(i === 0 ? { selected: "" } : {}),
        ...(d.ready ? {} : { disabled: "" }),
      }, d.label + (d.ready ? "" : " — address unconfirmed"))));
    const destNote = el("div", { class: "hint" });
    const syncNote = () => {
      const d = dests.find((x) => x.key === destSel.value);
      destNote.textContent = (d && d.note) ? `ℹ ${d.note}` : "";
    };
    destSel.addEventListener("change", syncNote);
    syncNote();
    const stocked = m.rows.filter((r) => (r.locs || {}).home > 0);
    const asinSel = el("select", { class: "in" },
      el("option", { value: "", selected: "" }, "— no ASIN (general run) —"),
      ...stocked.map((r) => el("option", { value: r.asin },
        `${r.asin} (${r.locs.home} at home)`)));
    const qtySel = el("select", { class: "in" },
      ...Array.from({ length: 20 }, (_, i) =>
        el("option", { value: i + 1 }, `${i + 1}`)));
    const weightIn = el("input", { type: "text", class: "in", value: "2", style: "width:70px" });
    const dimsIn = ["30", "20", "15"].map((v) =>
      el("input", { type: "text", class: "in", value: v, style: "width:56px" }));
    const levelSel = el("select", { class: "in" },
      el("option", { value: "LOF", selected: "" }, "LOF — overnight"),
      el("option", { value: "ECO" }, "ECO — economy road"),
      el("option", { value: "LSF" }, "LSF — same-day flyer"),
      el("option", { value: "LSE" }, "LSE — same-day economy"));
    const capIn = el("input", { type: "text", class: "in", value: "150", style: "width:80px" });
    const confirmIn = el("input", {
      type: "text", class: "in", placeholder: "type BOOK to confirm",
      autocapitalize: "characters",
    });
    const noteIn = el("input", {
      type: "text", class: "in wide", style: "margin-top:10px",
      placeholder: "note (rides the waybill reference when no ASIN)",
    });
    const bookRows = el("div", {},
      el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
        el("span", { class: "meta", style: "min-width:70px" }, "service"), levelSel,
        el("span", { class: "meta" }, "max"), capIn, el("span", { class: "meta" }, "R")),
      el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
        el("span", { class: "meta", style: "min-width:70px" }, "confirm"), confirmIn));
    bookRows.style.display = "none";
    modeSel.addEventListener("change", () => {
      bookRows.style.display = modeSel.value === "book" ? "" : "none";
    });
    const status = statusLine();
    openModal(
      el("h3", {}, "Courier run — home → warehouse"),
      el("p", { class: "meta" },
        "Quote only answers with the lane's live prices in the runs list " +
        "(nothing books, nothing spends). Book re-quotes live and only " +
        "commits at or under your price cap — refusals report the actual price."),
      el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
        el("span", { class: "meta", style: "min-width:70px" }, "mode"), modeSel),
      el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
        el("span", { class: "meta", style: "min-width:70px" }, "to"), destSel),
      destNote,
      el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
        el("span", { class: "meta", style: "min-width:70px" }, "what"), asinSel, qtySel),
      el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
        el("span", { class: "meta", style: "min-width:70px" }, "parcel"),
        weightIn, el("span", { class: "meta" }, "kg ·"),
        dimsIn[0], el("span", { class: "meta" }, "×"), dimsIn[1],
        el("span", { class: "meta" }, "×"), dimsIn[2], el("span", { class: "meta" }, "cm")),
      bookRows,
      noteIn,
      el("button", {
        class: "b pri wide", style: "margin-top:12px",
        onclick: () => {
          const booking = modeSel.value === "book";
          const weight = parseFloat(weightIn.value);
          if (!(weight > 0 && weight <= 50)) {
            status.textContent = "Weight must be 0–50 kg.";
            return;
          }
          if (booking && confirmIn.value.trim().toUpperCase() !== "BOOK") {
            status.textContent = "Type BOOK to confirm — this spends prepaid balance.";
            return;
          }
          const cap = parseFloat(capIn.value);
          if (booking && !(cap > 0)) {
            status.textContent = "Set a max price cap in Rands.";
            return;
          }
          const entry = {
            dest: destSel.value,
            parcels: [{
              weight_kg: weight,
              length_cm: parseFloat(dimsIn[0].value) || undefined,
              width_cm: parseFloat(dimsIn[1].value) || undefined,
              height_cm: parseFloat(dimsIn[2].value) || undefined,
            }],
            asin: asinSel.value || undefined,
            quantity: asinSel.value ? Number(qtySel.value) : undefined,
            service_level: levelSel.value,
            note: noteIn.value.trim() || undefined,
            requested_at: new Date().toISOString(),
          };
          if (booking) entry.max_rate = cap;
          else entry.quote_only = true;
          busAct(booking ? "book courier" : "quote courier", (doc) => {
            const bucket = (doc.courier ??= {});
            prunePush(bucket, "requests", entry, 2);
          }, status,
            booking
              ? "✅ Sent — the booking (or the refusal with the live price) shows in the runs list within ~30s while 'serve' is up."
              : "✅ Sent — the quote lands in the runs list within ~30s while 'serve' is up.");
        },
      }, "Send"),
      el("button", {
        class: "b wide", style: "margin-top:8px",
        onclick: () => modalEl().close(),
      }, "Cancel"),
      status);
  });
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
  if ((r.other || []).length) sub.push(r.other.map(([k, v]) => `${k} ${v}`).join(" · "));
  if (Object.values(r.locs || {}).some((v) => v < 0)) {
    sub.push("⚠ negative — a sale outran the receipts, check the log");
  }
  const canMove = Object.values(r.locs || {}).some((v) => v > 0);
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
    el("td", { class: "r t", style: "white-space:nowrap" }, action,
      canMove ? el("button", {
        class: "b sm line", style: "margin-left:6px",
        onclick: () => moveStockModal(r),
      }, "Move…") : null));
}
