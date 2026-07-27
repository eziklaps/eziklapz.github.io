/* Buy desk — sourcing & ordering across both demand channels: a master
   table (Amazon / Takealot / Reorder / Ordered tabs) with a sticky detail
   panel.
   Ordering is REAL: the modal commits an order intent to the command bus
   and the pipeline re-verifies price/freight/margin before placing.
   Row cells here are shared with the Today desk's "best of" table. */

const FLAG_LABELS = {
  "rank-appeared": "🆕 first rank — sales started",
  "first-offer": "🥇 first offer",
  "offers-gone": "🕳 competitor out",
};

/* proposed first: an auto-reorder waiting on a human decision outranks
   watching money that already moved. */
const ORDERED_RANK = { proposed: -1, placed: 0, placing: 1, verified: 2,
                       pending: 3, needs_review: 4, received: 5 };

function renderBuyDesk(root) {
  const products = (S.buyer || {}).products || [];
  const kw = (S.buyer || {}).keywords || {};
  const bf = (S.buyer || {}).buy_filter || {};
  // The desk's default view = buy-ready only: net margin (after the
  // inbound-courier allocation) clears the floor AND no listing block.
  // Pre-restart payloads carry no buy_ready field — filtering on those
  // would hide every row, so the filter only arms once the field exists.
  const filterable = products.some((p) => "buy_ready" in p);
  const shown = (list) => (filterable && !S.buyShowAll)
    ? list.filter((p) => p.buy_ready) : list;
  const amazon = products.filter((p) => (p.channel || "amazon") === "amazon");
  const takealot = products.filter((p) => p.channel === "takealot");
  const ordered = products.filter((p) => p.order);
  // Reorder queue (server-computed, services/replenish.py): stocked
  // products whose runway ends inside the reorder window, urgency-sorted.
  // Pre-restart payloads carry no reorders key — the tab waits for it.
  const reorders = Array.isArray((S.buyer || {}).reorders)
    ? S.buyer.reorders : null;
  const reorderDue = (reorders || []).filter((r) => r.status === "order_now");
  const hidden = filterable
    ? (amazon.length - shown(amazon).length)
      + (takealot.length - shown(takealot).length)
    : 0;
  // Committed on the bus, not yet in any payload — optimistic rows so a
  // fresh ORDER shows up here immediately instead of after the next sync.
  const phantoms = busOrderPhantoms();

  const kwBits = ["amazon", "takealot"].filter((m) => kw[m])
    .map((m) => `${m} ${kw[m].pending ?? 0}`).join(" / ");
  root.append(deskHead("Buy",
    `${products.length} winners · intake pending: ${kwBits || "—"} · margins ` +
    "include SARS duties, import VAT & channel fees" +
    (filterable
      ? ` · net deducts ~${fmtR(bf.inbound_unit_cost ?? 10)}/unit inbound courier`
      : "") +
    " · updated " + fmtAgo((S.buyer || {}).generated_at)));

  /* tabs + search + sort */
  const tab = (id, label) => el("button", {
    class: `tab${S.buyTab === id ? " active" : ""}`,
    onclick: () => { S.buyTab = id; S.buySel = null; renderDesk(); },
  }, label);
  const search = el("input", {
    type: "text", class: "in round", placeholder: "Search winners…",
    value: S.buySearch, style: "width:200px",
    oninput: (ev) => { S.buySearch = ev.target.value; renderList(); },
  });
  const sort = el("select", {
    class: "in round",
    onchange: (ev) => { S.buySort = ev.target.value; renderList(); },
  },
    el("option", { value: "score" }, "Sort: Score"),
    el("option", { value: "marginR" }, "Sort: Margin R"),
    el("option", { value: "marginPct" }, "Sort: Margin %"),
    el("option", { value: "demand" }, "Sort: Demand"));
  sort.value = S.buySort;
  // "buy-ready only" is the default; the toggle keeps hidden rows one tap
  // away so the filter is auditable, never a black box.
  const filterChip = filterable ? el("button", {
    class: `tab${S.buyShowAll ? " active" : ""}`,
    title: `buy-ready = net margin ≥ ${fmtR(bf.net_floor ?? 10)} after ` +
           `~${fmtR(bf.inbound_unit_cost ?? 10)}/unit inbound courier, and ` +
           "no restriction / GTIN-exemption / compliance block",
    onclick: () => { S.buyShowAll = !S.buyShowAll; renderDesk(); },
  }, S.buyShowAll
    ? "✓ showing all — tap for buy-ready only"
    : `${hidden} hidden (blocked or < ${fmtR(bf.net_floor ?? 10)} net)`) : null;
  root.append(el("div", { class: "tabs" },
    tab("amazon", `Amazon (${shown(amazon).length})`),
    tab("takealot", `Takealot (${shown(takealot).length})`),
    reorders ? tab("reorder", `Reorder (${reorderDue.length})`) : null,
    tab("ordered", `Ordered (${ordered.length + phantoms.length})`),
    filterChip,
    el("div", { style: "flex:1" }),
    search, sort));

  const listWrap = el("section", { class: "panel tight" });
  const detailWrap = el("div", { class: "detail" });
  root.append(el("div", { class: "buygrid" }, listWrap, detailWrap));

  function currentList() {
    // Ordered stays unfiltered — money already moved; hiding it would lie.
    let list = S.buyTab === "ordered" ? ordered
      : S.buyTab === "takealot" ? shown(takealot) : shown(amazon);
    if (S.buyTab === "ordered") {
      list = [...list].sort((x, y) =>
        (ORDERED_RANK[x.order.state] ?? 9) - (ORDERED_RANK[y.order.state] ?? 9));
    } else {
      const key = {
        score: (p) => p.opportunity_score || 0,
        marginR: (p) => p.net_margin ?? p.margin_total ?? 0,
        marginPct: (p) => p.margin_percent || 0,
        demand: (p) => p.est_units_month || 0,
      }[S.buySort] || ((p) => p.opportunity_score || 0);
      list = [...list].sort((x, y) => key(y) - key(x));
    }
    const q = S.buySearch.trim().toLowerCase();
    if (q) list = list.filter((p) => (p.title || "").toLowerCase().includes(q));
    return list;
  }

  function renderList() {
    if (S.buyTab === "reorder") { renderReorder(); return; }
    const list = currentList();
    const sel = list.find((p) => p.asin === S.buySel) || list[0] || null;
    listWrap.replaceChildren();
    const baseLen = (S.buyTab === "takealot" ? takealot : amazon).length;
    if (!list.length && !(S.buyTab === "ordered" && phantoms.length)) {
      listWrap.append(el("div", { class: "empty", style: "padding:14px" },
        S.buyTab === "ordered"
          ? "Nothing ordered yet — every row has an Order button."
          : baseLen > 0
          ? `All ${baseLen} winners here are hidden — blocked or under the ` +
            "net floor. The chip above shows them."
          : S.buyTab === "takealot"
          ? "No Takealot-discovered winners yet — run the pull-takealot stage on Machine."
          : "No winners yet — the pipeline is still hunting."));
    } else if (S.buyTab === "ordered") {
      listWrap.append(orderedTable(list, sel, phantoms));
      listWrap.append(el("div", { class: "hint", style: "padding:8px 10px" },
        "payment is deliberately manual — AliExpress “Pay all” on My Orders · " +
        "rejected/failed intents free the Order button with the reason on display"));
    } else {
      listWrap.append(masterTable(list, sel));
    }
    detailWrap.replaceChildren();
    if (sel) detailWrap.append(buyDetail(sel));
  }

  function masterTable(list, sel) {
    // Cap the DOM at the useful top of the list — search reaches the rest.
    const CAP = 150;
    const capped = list.slice(0, CAP);
    const table = el("table", { class: "grid" },
      el("tr", {},
        el("th", {}, ""), el("th", {}, "Product"), el("th", {}, "Score"),
        el("th", {}, "Margin"), el("th", {}, "Demand"),
        el("th", { class: "r" }, "Order")));
    for (const p of capped) {
      table.append(el("tr", {
        class: `click${sel && sel.asin === p.asin ? " sel" : ""}`,
        "data-focus": p.asin,
        onclick: () => { S.buySel = p.asin; renderList(); },
      },
        el("td", {}, thumbEl(p)),
        el("td", { class: "t" },
          el("div", { class: "rowtitle" }, p.title),
          el("div", { class: "rowsub" }, buySubline(p))),
        el("td", {}, scoreTag(p)),
        el("td", {}, marginCell(p)),
        el("td", { class: "t" }, demandCell(p)),
        el("td", { class: "r t" }, buyRowAction(p))));
    }
    const wrap = el("div", { class: "scroll-x" }, table);
    if (list.length > CAP) {
      wrap.append(el("div", { class: "hint", style: "padding:8px 10px" },
        `…${fmtNum(list.length - CAP)} more, sorted — search to reach the rest`));
    }
    return wrap;
  }

  function orderedTable(list, sel, busPhantoms = []) {
    const byId = {};
    for (const r of ((S.admin || {}).orders || {}).recent || []) byId[r.id] = r;
    const byAsin = buyerByAsin();
    const table = el("table", { class: "grid" },
      el("tr", {},
        el("th", {}, "Product · intent"), el("th", {}, "State"),
        el("th", {}, "Qty"), el("th", {}, "Cost"), el("th", {}, "When"),
        el("th", {}, "Tracking / note")));
    for (const o of busPhantoms) {
      const p = byAsin[o.asin] || {};
      table.append(el("tr", {},
        el("td", { class: "t" },
          el("div", { class: "rowtitle" }, p.title || o.asin),
          el("div", { class: "rowsub" }, o.id)),
        el("td", { class: "t" }, el("span", { class: "st warn" }, "🕐 on the bus")),
        el("td", {}, fmtNum(o.quantity || 1)),
        el("td", {}, "—"),
        el("td", { class: "t" }, fmtAgo(o.requested_at)),
        el("td", { class: "t", style: "font-size:11.5px" },
          "committed — the pipeline picks it up within ~30s while a run " +
          "or serve is active")));
    }
    for (const p of list) {
      const o = p.order;
      const joined = byId[o.id] || {};
      const latest = o.tracking?.events?.[0];
      let note;
      if (o.state === "proposed") {
        note = proposalActions(o);
      } else if (o.state === "placed" && latest) {
        note = el("span", {}, `🚚 ${latest.name || "update"} · ${fmtAgo(latest.at)}`
          + (o.tracking.eta_at ? ` · ETA ${fmtDate(o.tracking.eta_at)}` : ""));
      } else if (o.state === "placed" && o.payment_state !== "paid") {
        note = el("span", { class: "st warn" }, "pay on AliExpress");
      } else {
        note = el("span", {}, o.note || "");
      }
      table.append(el("tr", {
        class: `click${sel && sel.asin === p.asin ? " sel" : ""}`,
        "data-focus": p.asin,
        onclick: () => { S.buySel = p.asin; renderList(); },
      },
        el("td", { class: "t" },
          el("div", { class: "rowtitle" }, p.title),
          el("div", { class: "rowsub" },
            `${o.id}${o.ae_order_ids?.length ? ` · AE ${o.ae_order_ids.join(", ")}` : ""}` +
            (o.tracking?.mail_no ? ` · 🏷 ${o.tracking.mail_no}` : "") +
            (o.payment_state === "paid" ? " · paid" : ""))),
        el("td", { class: "t" }, stateWord(o.state, ORDER_STATE_LABEL, ORDER_STATE_TONE)),
        el("td", {}, (o.quantity ?? joined.quantity) != null
          ? fmtNum(o.quantity ?? joined.quantity) : "—"),
        el("td", {}, o.order_cost != null ? fmtR(o.order_cost) : "—"),
        el("td", { class: "t" }, fmtAgo(o.placed_at || joined.received_at)),
        el("td", { class: "t", style: "font-size:11.5px" }, note)));
    }
    return el("div", { class: "scroll-x" }, table);
  }

  /* The Reorder tab: rows come from the server's replenish feed, not the
     products list — the queue IS the sort (most urgent runway first), so
     the sort select doesn't apply here; search still narrows by title. */
  function renderReorder() {
    const q = S.buySearch.trim().toLowerCase();
    let list = reorders || [];
    if (q) list = list.filter((r) => (r.title || "").toLowerCase().includes(q));
    const sel = list.find((r) => r.asin === S.buySel) || list[0] || null;
    listWrap.replaceChildren();
    const arm = autoReorderSwitch();
    if (arm) listWrap.append(arm);
    if (!list.length) {
      listWrap.append(el("div", { class: "empty", style: "padding:14px" },
        "Nothing needs reordering — stocked products appear here once " +
        "their runway (sellable + inbound, at the observed sales rate) " +
        `drops under ${bf.reorder_window ?? 35} days or they sell out.`));
    } else {
      listWrap.append(reorderTable(list, sel));
      listWrap.append(el("div", { class: "hint", style: "padding:8px 10px" },
        "sorted by runway — this list is the order queue · ⚡ fast freight " +
        "is suggested only when a PROVEN seller (own sales) would stock " +
        "out before cheap freight lands · greyed rows are already " +
        "preordered"));
    }
    detailWrap.replaceChildren();
    const p = sel ? buyerByAsin()[sel.asin] : null;
    if (p) detailWrap.append(buyDetail(p));
    else if (sel) detailWrap.append(reorderDetail(sel));
  }

  function reorderTable(list, sel) {
    const byAsin = buyerByAsin();
    const table = el("table", { class: "grid" },
      el("tr", {},
        el("th", {}, ""), el("th", {}, "Product"), el("th", {}, "Stock"),
        el("th", {}, "Sells"), el("th", {}, "Runway"),
        el("th", {}, "Suggested"), el("th", { class: "r" }, "Order")));
    for (const r of list) {
      const p = byAsin[r.asin];
      table.append(el("tr", {
        class: `click${sel && sel.asin === r.asin ? " sel" : ""}`,
        style: r.status === "covered" ? "opacity:.55" : "",
        "data-focus": r.asin,
        onclick: () => { S.buySel = r.asin; renderList(); },
      },
        el("td", {}, thumbEl(r)),
        el("td", { class: "t" },
          el("div", { class: "rowtitle" }, r.title),
          el("div", { class: "rowsub" },
            (r.channel === "takealot" ? "🛒 Takealot · " : "") + r.asin +
            (r.manual ? ` · wholesale (${r.supplier || "supplier"})` : ""))),
        el("td", { class: "t", style: "font-size:12px" }, reorderStockCell(r)),
        el("td", { class: "t" }, reorderSellsCell(r)),
        el("td", {}, reorderRunwayCell(r)),
        el("td", { class: "t" }, reorderSuggestCell(r)),
        el("td", { class: "r t" }, reorderAction(r, p))));
    }
    return el("div", { class: "scroll-x" }, table);
  }

  renderList();
}

/* ---------- row cells (shared with Today) ---------- */

function buySubline(p) {
  const bits = [];
  if (p.channel === "takealot") bits.push("🛒 Takealot find");
  if (p.score_category === "sole_seller_candidate") bits.push("🥇 sole-seller candidate");
  for (const flag of (p.trend_flags || "").split(" | ").filter(Boolean)) {
    bits.push(FLAG_LABELS[flag] || flag);
  }
  const o = p.order;
  if (o?.state === "placed") {
    const latest = o.tracking?.events?.[0];
    bits.push(latest ? `ordered · ${latest.name || "in transit"} ${fmtAgo(latest.at)}` : "ordered");
  } else if (o?.state === "received") bits.push("📥 in stock");
  if (p.listing?.state === "live") bits.push("● live on Amazon");
  else if (p.listing && !PARKED.has(p.listing.state)) bits.push("◐ listing queued");
  if (p.takealot?.state === "live") bits.push("● live on Takealot");
  return bits.slice(0, 3).join(" · ");
}

function scoreTag(p) {
  return p.opportunity_score != null
    ? el("span", { class: "tag acc num", title: scoreTooltipText(p) },
        String(Math.round(p.opportunity_score)))
    : el("span", { class: "st mute" }, "—");
}

function scoreTooltipText(p) {
  const c = p.score_components || {};
  const bits = ["margin", "demand", "moat", "stability", "quality"]
    .map((k) => `${k} ${c[k] == null ? "—" : c[k]}`);
  if (p.score_confidence != null) bits.push(`confidence ${p.score_confidence}`);
  return bits.join(" · ");
}

function marginCell(p) {
  // Net (after the inbound-courier allocation) leads once the payload
  // carries it; gross stays a hover away. Older payloads show gross alone.
  const bf = (S.buyer || {}).buy_filter || {};
  const net = p.net_margin != null;
  return el("span", {
    class: "num",
    title: net
      ? `net of ~${fmtR(bf.inbound_unit_cost ?? 10)}/unit inbound courier · ` +
        `gross ${fmtR(p.margin_total)}`
      : "",
  },
    el("b", { style: "color:var(--ok-text)" },
      fmtR(net ? p.net_margin : p.margin_total)),
    el("span", { style: "color:var(--muted)" },
      `${net ? " net" : ""} · ${p.margin_percent ?? "—"}%`));
}

function demandCell(p) {
  const est = p.est_units_month != null
    ? `≈${fmtNum(Math.round(p.est_units_month))}/mo` : null;
  if (p.channel === "takealot") {
    const reviews = p.takealot_reviews != null ? `${fmtNum(p.takealot_reviews)} reviews` : null;
    return el("span", { class: "num", style: "font-size:12px;color:var(--ink2)" },
      [est, reviews].filter(Boolean).join(" · ") || "—");
  }
  const d = p.rank_delta_24h;
  const parts = [];
  if (d) {
    parts.push(el("span", {
      class: `st ${d < 0 ? "ok" : "hot"}`,
      title: `sales rank ${d < 0 ? "improved" : "slipped"} ${fmtNum(Math.abs(d))} places in 24h`,
    }, `${d < 0 ? "▲" : "▼"}${fmtNum(Math.abs(d))}`));
  } else if (p.sales_rank) {
    parts.push(`#${fmtNum(p.sales_rank)}`);
  }
  if (est) parts.push(est);
  if (!parts.length && p.sale_events_28d) parts.push(`${p.sale_events_28d} sale-days/28d`);
  const span = el("span", { class: "num", style: "font-size:12px;color:var(--ink2)" });
  parts.forEach((x, i) => span.append(i ? " · " : "", x));
  if (!parts.length) span.append("—");
  return span;
}

function priceCell(p) {
  const anchor = p.channel === "takealot" ? p.takealot_price : p.amazon_price;
  const ali = p.sku_price ?? p.ali_price_used;
  return el("span", { class: "num", style: "font-size:12.5px" },
    fmtR(anchor), el("span", { style: "color:var(--muted)" }, " / "), fmtR(ali));
}

function sellingChip(p) {
  if (p.listing?.state === "live") return el("span", { class: "st ok" }, "● live on Amazon");
  if (p.takealot?.state === "live") return el("span", { class: "st ok" }, "● live on Takealot");
  if (p.listing && !PARKED.has(p.listing.state)) return el("span", { class: "st warn" }, "◐ listing queued");
  if (p.takealot && !PARKED.has(p.takealot.state)) return el("span", { class: "st warn" }, "◐ offer queued");
  return null;
}

function buyRowAction(p, orderOpts) {
  const o = p.order;
  if (o?.state === "proposed") return proposalActions(o);
  const active = { pending: 1, verified: 1, placing: 1 };
  if (o && active[o.state]) {
    return stateWord(o.state, ORDER_STATE_LABEL, ORDER_STATE_TONE);
  }
  if (o?.state === "needs_review") {
    return stateWord("needs_review", ORDER_STATE_LABEL, ORDER_STATE_TONE);
  }
  if (o?.state === "placed") {
    return el("button", {
      class: "b sm line",
      onclick: (ev) => { ev.stopPropagation(); S.buySel = p.asin; S.buyTab = "ordered"; renderDesk(); },
    }, "Track");
  }
  // Already committed to the bus this session — block the double-order
  // (a second click would mint a fresh intent id and order twice).
  if (busOrderPhantomForAsin(p.asin)) {
    return el("span", { class: "st warn",
      title: "order committed — the pipeline picks it up within ~30s" },
      "🕐 on the bus");
  }
  const again = o && (o.state === "received" || o.state === "rejected"
    || o.state === "failed" || o.state === "cancelled");
  return el("button", {
    class: `b sm ${again ? "line" : "pri"}`,
    onclick: (ev) => { ev.stopPropagation(); openOrderModal(p, orderOpts); },
  }, again ? "Order again" : "Order");
}

/* Approve / Dismiss for an auto-reorder proposal (Phase C): both are
   plain bus claims — approve flips proposed→pending (then the normal
   verify/place path runs, gates and all), dismiss cancels and starts the
   re-mint cooldown. The wrap swaps to a sent-chip so one decision can't
   be pressed twice. */
function proposalActions(o) {
  const wrap = el("span", { style: "display:inline-flex;gap:6px;align-items:center" });
  const claim = (label, entry, chip) => (ev) => {
    ev.stopPropagation();
    busAct(`${label} ${o.id}`, (doc) => prunePush(doc, "orders", {
      id: o.id, ...entry, requested_at: new Date().toISOString(),
    }), null, "");
    wrap.replaceChildren(el("span", { class: "st warn" }, chip));
  };
  wrap.append(
    el("button", {
      class: "b sm pri",
      title: o.note || "auto-reorder proposal — approving queues the normal " +
             "verify → place path (margin floor, affordability gate, caps)",
      onclick: claim("approve proposal", { approve: true }, "🕐 approval sent"),
    }, "Approve"),
    el("button", {
      class: "b sm",
      title: "dismisses this proposal — the ASIN won't be re-proposed for " +
             "the cooldown window",
      onclick: claim("dismiss proposal", { cancel: true }, "🕐 dismissal sent"),
    }, "Dismiss"));
  return wrap;
}

/* The Phase C arm: a switch that lets the pipeline mint 'proposed' reorder
   intents on its own (proven sellers, cheap freight, capped per pass).
   Proposals stay inert — Approve/Dismiss on the desk is still the money
   decision, which is why a confirm() suffices here where ordering itself
   demands the typed-word modal. Renders nothing on payloads that predate
   the switch (serve not restarted yet). */
function autoReorderSwitch() {
  const cfg = (S.buyer || {}).auto_reorder;
  if (!cfg) return null;
  // A press still riding the bus wins the display: the sink stamps the
  // applied press into runtime_state, and the payload echoes that stamp —
  // a bus stamp the payload hasn't echoed yet = flip in flight.
  const press = (S.commands || {}).auto_reorder || null;
  const pending = press && press.requested_at
    && press.requested_at !== cfg.requested_at ? press : null;
  const on = pending ? !!pending.enabled : !!cfg.enabled;
  const cadence = `up to ${cfg.max_per_pass ?? 5} proposals every ` +
    `${cfg.pass_hours ?? 6}h — proven sellers (own sales), cheap freight ` +
    "only; every proposal still waits for Approve";
  const btn = el("button", {
    class: `b sm ${on ? "" : "pri"}`,
    ...(pending ? { disabled: "" } : {}),
    onclick: () => {
      if (!confirm(on
        ? "Switch auto-reorder OFF? The pipeline stops proposing reorders; " +
          "proposals already on the desk stay until approved or dismissed."
        : `Switch auto-reorder ON? The pipeline mints ${cadence}.`)) return;
      busAct(`auto-reorder ${on ? "off" : "on"}`, (doc) => {
        doc.auto_reorder = {
          enabled: !on, requested_at: new Date().toISOString(),
        };
      }, null, "");
      // Same one-press guard as proposalActions: the button dies the
      // moment a flip is committed; the payload echo re-arms it.
      btn.replaceWith(el("span", { class: "st warn" }, "🕐 applying"));
    },
  }, on ? "Switch off" : "Switch on…");
  return el("div", {
    class: "note", style: "display:flex;align-items:center;gap:10px;" +
      "flex-wrap:wrap;margin:10px 10px 4px",
  },
    el("b", {}, `🤖 Auto-reorder ${on ? "ON" : "OFF"}`),
    pending ? el("span", { class: "st warn",
      title: "the flip is on the command bus — the pipeline applies it " +
             "within ~30s while a run or serve is active" }, "🕐 applying")
      : null,
    el("span", { class: "hint", style: "flex:1;min-width:200px" },
      on ? cadence
         : "off — the queue below is advice only; nothing is proposed"),
    btn);
}

/* ---------- Reorder tab cells (rows from services/replenish.py) ---------- */

function reorderStockCell(r) {
  const bits = [`${fmtNum(r.available)} sellable`];
  if (r.inbound_units) bits.push(`+${fmtNum(r.inbound_units)} inbound`);
  if (r.committed) bits.push(`${fmtNum(r.committed)} promised`);
  return el("span", {}, bits.join(" · "));
}

function reorderSellsCell(r) {
  if (r.own_sold_28d) {
    return el("span", {}, `${fmtNum(r.own_sold_28d)} sold/28d `,
      r.proven
        ? el("span", { class: "st ok",
            title: "own sales prove the demand — fast freight unlockable" },
            "proven")
        : el("span", { class: "st",
            title: "too few own sales to prove demand yet" }, "thin"));
  }
  if (r.est_units_month != null) {
    return el("span", {}, `≈${fmtNum(Math.round(r.est_units_month))}/mo `,
      el("span", { class: "st",
        title: "market estimate — no own sales recorded yet" }, "estimate"));
  }
  return el("span", { style: "color:var(--muted)" }, "no signal");
}

function reorderRunwayCell(r) {
  if (r.status === "covered") {
    return el("span", { class: "st" },
      "covered" + (r.inbound_eta ? ` · ETA ${fmtDate(r.inbound_eta)}` : ""));
  }
  if (r.available <= 0) return el("span", { class: "st bad" }, "OUT");
  if (r.position_days == null) {
    return el("span", { style: "color:var(--muted)" }, "—");
  }
  const d = r.position_days;
  const cls = d < 7 ? "st bad" : d < 20 ? "st hot" : "st";
  return el("span", { class: cls }, `~${Math.round(d)}d`);
}

function reorderSuggestCell(r) {
  if (r.status === "covered") {
    return el("span", { style: "color:var(--muted)" }, "preordered");
  }
  const cell = el("span", {});
  if (r.suggest_qty) cell.append(`${fmtNum(r.suggest_qty)} units · `);
  cell.append(r.freight_tier === "fast"
    ? el("span", { class: "st hot",
        title: `cheap freight would land ≈${r.gap_days_if_cheap}d after ` +
               "stockout — proven demand justifies paying for speed" },
        "⚡ fast freight")
    : el("span", { class: "st",
        title: "cheap freight lands before the stockout deadline" },
        "🐢 cheap freight"));
  if (r.freight_tier === "cheap" && r.gap_days_if_cheap) {
    // Caught short WITHOUT proven demand: cheap stays the rule, but the
    // expected stockout gap is stated instead of silently eaten.
    cell.append(" ", el("span", { class: "st warn",
      title: "demand not proven by own sales — cheap freight stays the " +
             "rule; this is the expected out-of-stock gap it costs" },
      `≈${r.gap_days_if_cheap}d gap`));
  }
  return cell;
}

function reorderAction(r, p) {
  if (r.status === "covered") return el("span", { class: "st" }, "🚚 on the road");
  if (r.manual) {
    return el("span", { class: "st",
      title: "wholesale/manual stock — no AliExpress intent to reorder through" },
      `reorder from ${r.supplier || "supplier"}`);
  }
  if (!p) {
    return el("span", { style: "color:var(--muted)", title:
      "not in the winners payload (no matched AliExpress SKU on record) — " +
      "reorder on AliExpress directly" }, "no intent path");
  }
  return buyRowAction(p, {
    qtyDefault: r.suggest_qty || undefined,
    line: `reorder: ~${r.position_days ?? "?"}d runway · suggested ` +
          `${r.suggest_qty ?? "?"} units via ${r.freight_tier || "cheap"} ` +
          "freight — pick the matching service in the Shipping selector" +
          (r.freight_tier === "fast"
            ? ` (cheap would land ≈${r.gap_days_if_cheap}d late)` : ""),
  });
}

/* Detail fallback for reorder rows whose product left the winners payload
   — stock context only, no margin trail to show. */
function reorderDetail(r) {
  const card = el("div", { class: "panel" });
  card.append(el("h3", {}, r.title));
  card.append(el("div", { class: "chiprow" },
    reorderRunwayCell(r), reorderSellsCell(r),
    r.live ? el("span", { class: "st ok" }, "● live") : null));
  card.append(el("div", { class: "sect" },
    el("div", { class: "sl" }, "Stock position"),
    el("div", { style: "font-size:12.5px;line-height:1.7" },
      `on hand ${fmtNum(r.on_hand)} · sellable ${fmtNum(r.available)} · ` +
      `inbound ${fmtNum(r.inbound_units)} · promised ${fmtNum(r.committed)}` +
      (r.returns_held ? ` · returns held ${fmtNum(r.returns_held)}` : ""))));
  card.append(el("div", { class: "hint" },
    "this product is no longer in the winners payload, so there is no " +
    "margin trail or Order intent path here — reorder on AliExpress " +
    "directly, or via the supplier for wholesale stock"));
  return card;
}

/* ---------- detail panel ---------- */

/* The supplier pair behind the margin, with the human veto. Born from the
   dash-cam ↔ phone-holder incident (similarity 0.79 passed vision): the
   image + title + similarity sit next to the reject button so a misfit is
   spottable and fixable in one place. */
function matchSection(p) {
  if (!p.ali_id) return null;
  const sect = el("div", { class: "sect" },
    el("div", { class: "sl" }, "Supplier match"));
  const row = el("div", { style: "display:flex;gap:10px;align-items:flex-start" });
  if (p.ali_image_url) {
    row.append(el("img", {
      src: p.ali_image_url, alt: "", loading: "lazy",
      style: "width:64px;height:64px;object-fit:cover;border-radius:8px;" +
             "border:1px solid var(--line);flex:none",
    }));
  }
  const name = p.ali_title || `Ali ${p.ali_id}`;
  const info = el("div", { style: "min-width:0;flex:1" },
    el("div", { style: "font-size:12.5px;line-height:1.4" },
      p.aliexpress_url
        ? el("a", { href: p.aliexpress_url, target: "_blank", rel: "noopener" }, name)
        : name),
    el("div", { class: "hint", style: "margin-top:2px" }, [
      p.match_similarity != null
        ? `similarity ${(p.match_similarity * 100).toFixed(1)}%` : null,
      // absent field = payload predates the fields (serve not restarted
      // yet) — don't guess a verdict the pipeline never published
      !("match_vision" in p) ? null
        : p.match_vision === true ? "vision-confirmed"
        : p.match_vision === false ? "vision-refuted"
        : "best candidate",
    ].filter(Boolean).join(" · ") || "match details publish on the next serve cycle"));
  row.append(info);
  sect.append(row);

  if (busMatchRejectFor(p.asin)) {
    sect.append(el("div", { class: "st warn",
      style: "margin-top:8px;white-space:normal" },
      "🕐 wrong-match sent — re-matches without this supplier next run"));
    return sect;
  }
  const status = statusLine();
  sect.append(el("div", { style: "margin-top:8px" },
    el("button", {
      class: "b sm danger",
      title: "pushes this Ali item onto the never-again list and sends the " +
             "product back through matching",
      onclick: () => {
        if (!confirm(`Reject this match? ${p.asin} drops off the winners ` +
            "list and re-matches on the next run — the rejected AliExpress " +
            "item is never re-selected.")) return;
        busAct(`wrong match ${p.asin}`, (doc) => prunePush(doc, "matches", {
          asin: p.asin, ali_id: String(p.ali_id), reject: true,
          requested_at: new Date().toISOString(),
        }), status, "Sent — re-matches without this supplier on the next run.");
      },
    }, "✗ Wrong match"),
    status));
  return sect;
}

function buyDetail(p) {
  const card = el("div", { class: "panel" });
  card.append(heroEl(p));
  card.append(el("h3", {}, p.title));

  const bf = (S.buyer || {}).buy_filter || {};
  const chips = el("div", { class: "chiprow" },
    p.net_margin != null
      ? el("span", {
          class: "pill ok",
          title: `net of ~${fmtR(bf.inbound_unit_cost ?? 10)}/unit inbound ` +
                 `courier · gross ${fmtR(p.margin_total)}`,
        }, `${fmtR(p.net_margin)} net · ${p.margin_percent ?? "—"}%`)
      : pill("ok", `${fmtR(p.margin_total)} · ${p.margin_percent ?? "—"}%`),
    p.opportunity_score != null
      ? el("span", { class: "pill acc", title: scoreTooltipText(p) },
          `⚡ ${Math.round(p.opportunity_score)}`) : null);
  const BLOCK_LABEL = {
    restricted: "🔒 Amazon approval needed",
    compliance: "⛔ ZA compliance (ICASA/NRCS)",
    gtin_exemption: "🔒 GTIN exemption needed",
  };
  for (const b of p.listing_blocks || []) {
    chips.append(el("span", {
      class: "pill warn", style: "cursor:pointer",
      title: "not immediately listable — details on the Sell desk",
      onclick: () => setDesk("sell", { sellTab: "amazon", focus: p.asin }),
    }, BLOCK_LABEL[b] || b));
  }
  if (p.buy_ready === false && !(p.listing_blocks || []).length) {
    chips.append(el("span", {
      class: "pill mute",
      title: `net margin under the ${fmtR(bf.net_floor ?? 10)} floor`,
    }, "thin margin"));
  }
  for (const flag of (p.trend_flags || "").split(" | ").filter(Boolean)) {
    chips.append(el("span", { class: "tag" }, FLAG_LABELS[flag] || flag));
  }
  if (p.channel === "takealot") chips.append(el("span", { class: "tag" }, "🛒 Takealot find"));
  if (p.score_category === "sole_seller_candidate") {
    chips.append(el("span", { class: "tag" }, "sole-seller candidate"));
  }
  if (p.listing) {
    chips.append(el("span", {
      class: "tag", style: "cursor:pointer",
      title: p.listing.note || "",
      onclick: () => setDesk("sell", { sellTab: "amazon", focus: p.asin }),
    }, `Amazon listing: ${INTENT_LABEL[p.listing.state] || p.listing.state} →`));
  }
  if (p.takealot) {
    chips.append(el("span", {
      class: `tag${p.takealot.state === "live" ? " ok" : ""}`, style: "cursor:pointer",
      title: p.takealot.note || "",
      onclick: () => setDesk("sell", { sellTab: "takealot", focus: p.asin }),
    }, `Takealot offer: ${INTENT_LABEL[p.takealot.state] || p.takealot.state} →`));
  }
  card.append(chips);

  const match = matchSection(p);
  if (match) card.append(match);

  /* score breakdown */
  const c = p.score_components || {};
  if (Object.keys(c).length) {
    const sect = el("div", { class: "sect" },
      el("div", { class: "sl" },
        `Score breakdown${p.score_confidence != null ? ` · confidence ${p.score_confidence}` : ""}`));
    const bars = el("div", { class: "scorebars" });
    for (const k of ["margin", "demand", "moat", "stability", "quality"]) {
      const v = c[k];
      // components are 0..1 floats — draw and label them on a 0..100 scale
      const pct = v == null ? 0 : Math.min(100, Math.round(v * 100));
      bars.append(el("div", { class: "brow" },
        el("span", {}, k),
        el("div", { class: "track" },
          el("div", { class: "fill", style: `width:${pct}%` })),
        el("span", { class: "num", style: "text-align:right" }, v == null ? "—" : String(pct))));
    }
    sect.append(bars);
    if ((c.quality_penalties || []).length) {
      sect.append(el("div", { class: "hint" }, `penalties: ${c.quality_penalties.join(", ")}`));
    }
    card.append(sect);
  }

  /* order status + tracking */
  const o = p.order;
  if (o && ["placed", "received", "pending", "verified", "placing", "needs_review"].includes(o.state)) {
    const sect = el("div", { class: "sect" },
      el("div", { class: "sl" }, `Order · ${o.id}`));
    sect.append(el("div", { style: "display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600" },
      stateWord(o.state, ORDER_STATE_LABEL, ORDER_STATE_TONE),
      o.order_cost != null ? el("span", { class: "num", style: "color:var(--ink2);font-weight:400" }, fmtR(o.order_cost)) : null));
    if (o.ae_order_ids?.length) {
      sect.append(el("div", { class: "hint", style: "margin-top:4px" },
        `AE order ${o.ae_order_ids.join(", ")}` +
        (o.payment_state === "paid" ? " — paid"
          : o.state === "placed" && !o.tracking ? " — pay on aliexpress.com if not auto-paid" : "")));
    }
    const t = o.tracking;
    if (t?.events?.length) {
      const line = el("div", { class: "trackline", style: "margin-top:8px" });
      t.events.slice(0, 5).forEach((e, i) => {
        line.append(el("div", { class: `tstep${i === 0 ? " now" : ""}`,
                           title: e.desc && e.desc !== e.name ? e.desc : "" },
          el("span", { class: "glyph" }, i === 0 ? "●" : "○"),
          el("span", {}, `${e.name || e.desc || "update"} · ${fmtAgo(e.at)}`)));
      });
      sect.append(line);
      const footer = [
        t.mail_no ? `waybill ${t.mail_no}` : null, t.carrier,
        t.eta_at ? `ETA ${fmtDate(t.eta_at)}` : null,
        t.checked_at ? `checked ${fmtAgo(t.checked_at)} (6h poll)` : null,
      ].filter(Boolean).join(" · ");
      if (footer) sect.append(el("div", { class: "hint", style: "margin-top:6px" }, footer));
    }
    if (o.state === "placed") {
      sect.append(el("div", { style: "display:flex;gap:8px;margin-top:10px;flex-wrap:wrap" },
        el("button", { class: "b sm line", onclick: () => openOrderModal(p) }, "Order again"),
        el("button", { class: "b sm line", onclick: () => markReceivedModal(p, o) }, "Mark received"),
        el("button", { class: "b sm danger", onclick: () => markCancelledModal(p, o) }, "Mark cancelled")));
    }
    if (o.state === "needs_review" && o.note) {
      sect.append(el("div", { class: "note warn", style: "margin-top:8px" }, o.note));
    }
    card.append(sect);
  } else if (o && o.note) {
    card.append(el("div", { class: "sect hint" },
      `↩ previous intent ${o.state}: ${o.note}`));
  }

  /* channel comparison */
  card.append(el("div", { class: "sect" },
    el("div", { class: "sl" },
      p.channel === "takealot" ? "Takealot vs AliExpress" : "Amazon vs AliExpress"),
    p.channel === "takealot" ? takealotCompareTable(p) : amazonCompareTable(p)));

  /* 30-day trends */
  const trends = trendSection(p);
  if (trends) card.append(trends);

  /* links */
  const links = el("div", { class: "sect linkrow" });
  if (p.amazon_url) links.append(el("a", { href: p.amazon_url, target: "_blank", rel: "noopener" }, "Amazon ↗"));
  if (p.aliexpress_url) links.append(el("a", { href: p.aliexpress_url, target: "_blank", rel: "noopener" }, "AliExpress ↗"));
  if (p.channel === "takealot" && p.takealot_url) {
    links.append(el("a", { href: p.takealot_url, target: "_blank", rel: "noopener" }, "Takealot ↗"));
  } else if (p.takealot_match) {
    const m = p.takealot_match;
    links.append(m.found
      ? el("a", {
          href: m.url, target: "_blank", rel: "noopener",
          title: [`${m.offer_count || "?"} offers`, m.seller ? `buybox ${m.seller}` : null,
                  m.cosine != null ? `image match ${m.cosine}` : null,
                  `checked ${fmtAgo(m.checked_at)}`].filter(Boolean).join(" · "),
        }, `Takealot ${m.price_min != null ? fmtR(m.price_min) : ""} ↗`)
      : el("span", { class: "hint", title: `checked ${fmtAgo(m.checked_at)}` },
          "not on Takealot — open field"));
  }
  card.append(links);

  /* order button */
  if (!o || ["received", "rejected", "failed", "cancelled"].includes(o.state)) {
    if (busOrderPhantomForAsin(p.asin)) {
      card.append(el("div", { class: "note warn", style: "margin-top:12px" },
        el("b", {}, "🕐 Order committed. "),
        "It's on the command bus — the pipeline verifies and places it " +
        "within ~30s while a run or serve is active."));
    } else {
      card.append(el("button", {
        class: "b pri wide", style: "margin-top:12px",
        onclick: () => openOrderModal(p),
      }, `Order${o ? " again" : ""} from AliExpress…`));
      card.append(el("div", { class: "hint", style: "margin-top:6px;text-align:center" },
        "re-verifies price, freight, restrictions & margin before placing"));
    }
  }
  return card;
}

function heroEl(p) {
  const hero = el("div", { class: "hero" });
  const candidates = [];
  for (const url of [p.image_url, p.ali_image_url]) {
    if (!url) continue;
    const m = (url || "").match(AMAZON_IMG_RE);
    if (m) candidates.push(`${m[1]}._SX600_.${m[2]}`);
    else if (ALI_IMG_RE.test(url)) candidates.push(`${url}_480x480q75.jpg_.webp`);
    candidates.push(url);
  }
  if (!candidates.length) {
    hero.append(el("span", { class: "ph-note" }, "no product image"));
    return hero;
  }
  let idx = 0;
  hero.append(el("img", {
    src: candidates[0], alt: p.title, loading: "lazy", decoding: "async",
    onerror: (ev) => {
      idx += 1;
      if (idx < candidates.length) ev.target.src = candidates[idx];
      else ev.target.replaceWith(el("span", { class: "ph-note" }, "no product image"));
    },
  }));
  return hero;
}

function amazonCompareTable(p) {
  const duty = p.import_percentage != null
    ? `${p.import_percentage}%${p.is_fallback_duty ? " (fallback)" : ""}` : "—";
  const row = (label, az, ali) => el("tr", {}, el("th", {}, label),
    el("td", {}, az), el("td", {}, ali));
  return el("table", { class: "compare" },
    el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "Amazon"), el("th", {}, "AliExpress"))),
    row("Price", fmtR(p.amazon_price),
      el("span", {}, fmtR(p.sku_price ?? p.ali_price_used),
        p.ali_price_source === "sku" ? el("span", { class: "hint" }, " SKU") : null)),
    row("Buy Box", fmtR(p.amazon_buybox_price), "—"),
    row("Offers", fmtNum(p.amazon_total_offers), "—"),
    row("Rank", p.sales_rank ? `#${fmtNum(p.sales_rank)}` : "—", "—"),
    row("Freight", "—", fmtR(p.freight)),
    row("Duty (SARS)", "—", duty));
}

function takealotCompareTable(p) {
  const duty = p.import_percentage != null
    ? `${p.import_percentage}%${p.is_fallback_duty ? " (fallback)" : ""}` : "—";
  const detail = p.takealot_detail || {};
  const row = (label, tk, ali) => el("tr", {}, el("th", {}, label),
    el("td", {}, tk), el("td", {}, ali));
  return el("table", { class: "compare" },
    el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "Takealot"), el("th", {}, "AliExpress"))),
    row("Price", fmtR(p.takealot_price), fmtR(p.sku_price ?? p.ali_price_used)),
    row("Reviews", p.takealot_reviews != null
      ? `${fmtNum(p.takealot_reviews)}${p.takealot_rating != null ? ` · ${p.takealot_rating}★` : ""}`
      : "—", "—"),
    row("Offers", detail.offer_count != null
      ? `${fmtNum(detail.offer_count)}${detail.seller ? ` (${detail.seller})` : ""}` : "—", "—"),
    row("Stock", p.takealot_in_stock ?? "—", "—"),
    row("Freight", "—", fmtR(p.freight)),
    row("Duty (SARS)", "—", duty));
}

function trendSection(p) {
  const hist = p.history || {};
  const rank = sparkline(hist.rank, { betterDown: true, label: "Sales rank" });
  const price = sparkline(hist.price, { label: "Price" });
  const est = p.est_units_month;
  const events = p.sale_events_28d;
  if (!rank && !price && est == null && !events) return null;
  const sect = el("div", { class: "sect" },
    el("div", { class: "sl" }, "30-day trends"));
  const rows = el("div", { class: "trend" });
  if (est != null || events) {
    rows.append(el("div", { class: "trow" },
      el("span", { class: "tl" }, "Sales"), el("span", {}),
      el("span", {
        class: "tv",
        title: est != null
          ? `estimated units/month from rank (confidence: ${p.velocity_confidence}); ` +
            `${events || 0} sale-days measured in 28d`
          : `rank moved on ${events} days in 28d — units sold`,
      }, est != null
        ? `≈${fmtNum(Math.round(est))}/mo${p.velocity_confidence ? ` (${p.velocity_confidence} conf)` : ""}`
        : `${events} sale-day${events === 1 ? "" : "s"}/28d`)));
  }
  if (rank) {
    const d = p.rank_delta_24h;
    rows.append(el("div", { class: "trow" },
      el("span", { class: "tl" }, "Rank"), rank,
      d ? el("span", { class: `tv ${d < 0 ? "up" : "down"}` },
            `${d < 0 ? "▲" : "▼"} ${fmtNum(Math.abs(d))} / 24h`)
        : el("span", { class: "tv" }, "")));
  }
  if (price) {
    const values = hist.price.map((pt) => pt[1]);
    const min = Math.min(...values), max = Math.max(...values);
    rows.append(el("div", { class: "trow" },
      el("span", { class: "tl" }, "Price"), price,
      el("span", { class: "tv" }, min === max ? "" : `${fmtR(min)}–${fmtR(max)} seen`)));
  }
  sect.append(rows);
  return sect;
}

/* ---------- order flows ---------- */

/* The money math at the commit point: what the card pays AliExpress now
   vs what SARS collects at import — the same landed-cost model
   services/margin.py prices margins with (duty on goods; import VAT =
   (goods × 1.10 uplift + duty) × 15%). The freight figure is the
   payload's single-unit shipment quote; multi-unit freight re-quotes
   live at verification, so it's labelled, not multiplied. */
function orderSpendBox(p, qty, freightOverride) {
  const unit = p.sku_price ?? p.ali_price_used;
  if (unit == null) return null;
  const goods = unit * qty;
  const freight = freightOverride != null ? Number(freightOverride)
    : p.freight != null ? Number(p.freight) : null;
  const pct = p.import_percentage != null ? Number(p.import_percentage) : null;
  const duty = pct != null ? goods * (pct / 100) : null;
  const vat = duty != null ? (goods * 1.10 + duty) * 0.15 : null;
  const payNow = goods + (freight || 0);
  const landed = payNow + (duty || 0) + (vat || 0);
  const row = (k, v, bold) => el("div", {
    class: "kvrow", style: bold ? "font-weight:650" : "",
  }, el("span", { class: "k", style: bold ? "color:var(--ink)" : "" }, k),
     el("span", { class: "v" }, v));
  return el("div", { class: "note", style: "margin-top:12px" },
    row(`Goods — ${qty} × ${fmtR(unit)}`, fmtR(goods)),
    row("Freight (one shipment — single-unit quote)",
        freight != null ? fmtR(freight) : "—"),
    row("You pay AliExpress", `≈ ${fmtR(payNow)}`, true),
    row(`SARS duty at import (${pct != null ? pct + "%" : "?"}` +
        `${p.is_fallback_duty ? " fallback" : ""})`,
        duty != null ? fmtR(duty) : "—"),
    row("Import VAT ((goods ×1.10 + duty) ×15%)",
        vat != null ? fmtR(vat) : "—"),
    row("All-in landed", `≈ ${fmtR(landed)}`, true),
    el("div", { class: "hint", style: "margin-top:6px" },
      "estimates from the last sweep — price, freight and margin re-verify " +
      "live before anything places; multi-unit freight re-quotes then"));
}

/* Commit-point gate banner: RED means the intent will queue and verify
   but placement HOLDS (services/ordering reads the same gate). */
function orderGateWarn() {
  const gate = (((S.admin || {}).banking) || {}).gate || {};
  if (gate.status === "red") {
    return el("span", {},
      el("b", {}, "⛔ Affordability gate RED — placement holds. "),
      `${(gate.reasons || []).join(" · ") || "no cash evidence"}. ` +
      "The intent still queues and verifies, but nothing places until the " +
      "gate reopens — a fresh statement or balance confirm on Books does it.");
  }
  if (gate.status === "amber") {
    return el("span", {},
      el("b", {}, "▲ Affordability gate AMBER. "),
      `${(gate.watch || []).join(" · ")} — placements still run; ` +
      "a fresh balance confirm keeps it green.");
  }
  return null;
}

function openOrderModal(p, opts = {}) {
  if (!p.ali_id || !p.sku_id) {
    openModal(
      el("h3", {}, "Can't order this one"),
      el("p", { class: "meta" },
        "No matched AliExpress SKU on record — the pipeline can only order " +
        "products it has SKU-matched."),
      el("button", { class: "b wide", style: "margin-top:10px", onclick: () => modalEl().close() }, "Close"));
    return;
  }
  const unitCost = p.sku_price ?? p.ali_price_used;

  /* Shipping picker (Phase B of the deadline-driven freight plan): the
     stored single-unit quotes name the choices; the pipeline re-quotes at
     the real quantity and matches the chosen code (falling back to
     cheapest with the swap on record if the service vanished). Keeping
     the cheapest selected sends NO code — the pipeline keeps picking the
     fresh cheapest, immune to stale quotes. */
  const freightOpts = (p.freight_options || []).filter((o) => o.code);
  const cheapestOpt = freightOpts.find((o) => o.cheapest)
    || (freightOpts.length ? freightOpts.reduce((a, b) =>
         ((a.cost ?? Infinity) <= (b.cost ?? Infinity) ? a : b)) : null);
  const optLabel = (o) => {
    const eta = Object.entries(o).find(([k, v]) =>
      !["code", "company", "cost", "free", "cheapest"].includes(k)
      && v != null && v !== "");
    return `${o.company || o.code} — ${o.free ? "free" : o.cost != null
      ? fmtR(o.cost) : "?"}${eta ? ` · ${eta[1]}` : ""}` +
      (o === cheapestOpt ? " (cheapest)" : "");
  };
  const freightSel = freightOpts.length > 1
    ? el("select", { class: "in", style: "flex:1;min-width:0;font-size:12px" },
        ...freightOpts.map((o) => el("option", { value: o.code }, optLabel(o))))
    : null;
  if (freightSel && cheapestOpt) freightSel.value = cheapestOpt.code;
  const chosen = () => freightOpts.find((o) => o.code === freightSel?.value)
    || cheapestOpt;
  const freightExtra = freightSel ? el("div", {},
    el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
      el("span", { class: "meta" }, "Shipping"), freightSel),
    el("div", { class: "hint", style: "margin-top:4px" },
      "single-unit stored quotes — re-quoted at the real quantity before " +
      "placing; a pick that can't clear the margin floor is rejected, " +
      "never silently placed")) : null;

  typedCommitModal({
    title: "Order from AliExpress",
    product: p.title,
    lines: [`item ${p.ali_id} · SKU ${p.sku_id} · ~${fmtR(unitCost)}/unit · ` +
            (p.net_margin != null ? `net ${fmtR(p.net_margin)} / ` : "") +
            `margin ${fmtR(p.margin_total)} (${p.margin_percent ?? "—"}%) at ` +
            `${p.channel === "takealot" ? "Takealot" : "Amazon"} price`,
            ...(opts.line ? [opts.line] : [])],
    warn: orderGateWarn(),
    word: "ORDER",
    qtyDefault: opts.qtyDefault,
    qtyLabel: "Quantity",
    confirmLabel: "Commit order intent",
    busKey: "orders",
    extra: freightExtra,
    bindRefresh: (refresh) => {
      if (freightSel) freightSel.addEventListener("change", refresh);
    },
    spendFor: (qty) => orderSpendBox(p, qty, chosen()?.cost),
    note: "The pipeline only places this if it still clears the margin floor, " +
      "stock, restrictions and the daily caps — and payment is completed on " +
      "aliexpress.com afterwards.",
    entryFor: (qty) => ({
      id: `web-${p.asin}-${Date.now()}`,
      asin: p.asin, ali_id: p.ali_id, sku_id: p.sku_id,
      quantity: qty, source: "manual",
      // Cheapest stays implicit (no code pinned) — see picker note above.
      ...(chosen() && chosen() !== cheapestOpt
        ? { freight_code: chosen().code } : {}),
      requested_at: new Date().toISOString(),
    }),
    doneText: "The pipeline re-verifies price, freight, restrictions and " +
      "margin, then places the order — within ~30s while a run or serve is " +
      "active. The Buy desk shows its state on the next refresh.",
  });
}

function markReceivedModal(p, o) {
  withToken(() => {
    const status = statusLine();
    /* the Stock desk hands refs in; the Buy desk's order carries one */
    const refs = (o.tracking_refs || []).length ? o.tracking_refs
      : (o.tracking?.mail_no ? [o.tracking.mail_no] : []);
    const expected = o.quantity != null ? Number(o.quantity) : null;
    const qtyIn = el("input", {
      type: "number", class: "in", min: "1", max: "999",
      style: "width:80px", ...(expected ? { value: String(expected) } : {}),
      placeholder: expected ? String(expected) : "count",
    });
    const partialChk = el("input", { type: "checkbox" });
    const btn = el("button", { class: "b pri wide", style: "margin-top:14px" }, "Mark received");
    btn.addEventListener("click", async () => {
      const partial = partialChk.checked;
      const qty = qtyIn.value.trim() === "" ? null : Math.round(Number(qtyIn.value));
      if (qty != null && !(qty >= 1 && qty <= 999)) {
        status.textContent = "Count must be 1–999 (or leave it at the ordered quantity).";
        return;
      }
      if (partial && qty == null) {
        status.textContent = "A partial delivery needs the count that actually arrived.";
        return;
      }
      btn.setAttribute("disabled", "");
      status.textContent = "Committing receipt…";
      try {
        await mutateCommands((doc) => prunePush(doc, "orders", {
          id: o.id, received: true,
          ...(qty != null && (partial || qty !== expected) ? { quantity: qty } : {}),
          ...(partial ? { partial: true } : {}),
          requested_at: new Date().toISOString(),
        }), `Dashboard: mark ${o.id} received`);
        status.textContent = "";
        btn.replaceWith(el("div", { class: "note ok", style: "margin-top:14px" },
          el("b", {}, "✅ Receipt committed. "),
          partial
            ? "The tranche books into inventory and the intent stays open " +
              "for the remaining boxes — the final delivery uses a plain " +
              "Mark received."
            : "The intent flips to received and the goods book into inventory " +
              "when the pipeline next syncs (within ~30s while a run or serve " +
              "is active). Missing COGS rows post automatically — arrival " +
              "proves payment."));
      } catch (e) {
        status.textContent = `Failed: ${e.message}`;
        if (/401|403/.test(e.message)) localStorage.removeItem(PAT_KEY);
        btn.removeAttribute("disabled");
      }
    });
    openModal(
      el("h3", {}, "Mark order received"),
      el("p", { class: "meta", style: "margin-top:8px" },
        `The parcel for intent ${o.id} (AliExpress order ` +
        `${(o.ae_order_ids || []).join(", ")}` +
        (refs.length ? ` · waybill ${refs.join(", ")}` : "") +
        ") arrived. This closes tracking, " +
        "books the goods into inventory at their estimated landed cost, and " +
        "frees the Order button for a restock."),
      el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:12px" },
        el("span", { class: "meta" }, "units in hand"), qtyIn,
        expected ? el("span", { class: "meta" }, `ordered ${expected}`) : null),
      el("label", { style: "display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12.5px;color:var(--ink2)" },
        partialChk,
        "partial delivery — book this box now, keep the order open (Ali splits orders)"),
      el("p", { class: "meta", style: "margin-top:8px" },
        "A different count books what's actually on the shelf — the full " +
        "spend stays on the books either way."),
      btn,
      el("button", { class: "b wide", style: "margin-top:8px", onclick: () => modalEl().close() }, "Close"),
      status);
  });
}

function markCancelledModal(p, o) {
  withToken(() => {
    const status = statusLine();
    const btn = el("button", { class: "b pri wide", style: "margin-top:14px" }, "Mark cancelled");
    btn.addEventListener("click", async () => {
      btn.setAttribute("disabled", "");
      status.textContent = "Committing cancel claim…";
      try {
        await mutateCommands((doc) => prunePush(doc, "orders", {
          id: o.id, cancel: true, requested_at: new Date().toISOString(),
        }), `Dashboard: mark ${o.id} cancelled`);
        status.textContent = "";
        btn.replaceWith(el("div", { class: "note ok", style: "margin-top:14px" },
          el("b", {}, "✅ Claim committed. "),
          "The intent flips to cancelled when the pipeline next syncs."));
      } catch (e) {
        status.textContent = `Failed: ${e.message}`;
        if (/401|403/.test(e.message)) localStorage.removeItem(PAT_KEY);
        btn.removeAttribute("disabled");
      }
    });
    openModal(
      el("h3", {}, "Mark order cancelled"),
      el("p", { class: "meta", style: "margin-top:8px" },
        `For orders you cancelled on aliexpress.com. Marks intent ${o.id} ` +
        `(AliExpress order ${(o.ae_order_ids || []).join(", ")}) as cancelled ` +
        "on this dashboard and frees the Order button — it does not touch " +
        "the AliExpress order itself."),
      btn,
      el("button", { class: "b wide", style: "margin-top:8px", onclick: () => modalEl().close() }, "Close"),
      status);
  });
}
