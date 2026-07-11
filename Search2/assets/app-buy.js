/* Buy desk — sourcing & ordering across both demand channels: a master
   table (Amazon / Takealot / Ordered tabs) with a sticky detail panel.
   Ordering is REAL: the modal commits an order intent to the command bus
   and the pipeline re-verifies price/freight/margin before placing.
   Row cells here are shared with the Today desk's "best of" table. */

const FLAG_LABELS = {
  "rank-appeared": "🆕 first rank — sales started",
  "first-offer": "🥇 first offer",
  "offers-gone": "🕳 competitor out",
};

const ORDERED_RANK = { placed: 0, placing: 1, verified: 2, pending: 3,
                       needs_review: 4, received: 5 };

function renderBuyDesk(root) {
  const products = (S.buyer || {}).products || [];
  const kw = (S.buyer || {}).keywords || {};
  const amazon = products.filter((p) => (p.channel || "amazon") === "amazon");
  const takealot = products.filter((p) => p.channel === "takealot");
  const ordered = products.filter((p) => p.order);
  // Committed on the bus, not yet in any payload — optimistic rows so a
  // fresh ORDER shows up here immediately instead of after the next sync.
  const phantoms = busOrderPhantoms();

  const kwBits = ["amazon", "takealot"].filter((m) => kw[m])
    .map((m) => `${m} ${kw[m].pending ?? 0}`).join(" / ");
  root.append(deskHead("Buy",
    `${products.length} winners · intake pending: ${kwBits || "—"} · margins ` +
    "include SARS duties, import VAT & channel fees · updated " +
    fmtAgo((S.buyer || {}).generated_at)));

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
  root.append(el("div", { class: "tabs" },
    tab("amazon", `Amazon (${amazon.length})`),
    tab("takealot", `Takealot (${takealot.length})`),
    tab("ordered", `Ordered (${ordered.length + phantoms.length})`),
    el("div", { style: "flex:1" }),
    search, sort));

  const listWrap = el("section", { class: "panel tight" });
  const detailWrap = el("div", { class: "detail" });
  root.append(el("div", { class: "buygrid" }, listWrap, detailWrap));

  function currentList() {
    let list = S.buyTab === "ordered" ? ordered
      : S.buyTab === "takealot" ? takealot : amazon;
    if (S.buyTab === "ordered") {
      list = [...list].sort((x, y) =>
        (ORDERED_RANK[x.order.state] ?? 9) - (ORDERED_RANK[y.order.state] ?? 9));
    } else {
      const key = {
        score: (p) => p.opportunity_score || 0,
        marginR: (p) => p.margin_total || 0,
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
    const list = currentList();
    const sel = list.find((p) => p.asin === S.buySel) || list[0] || null;
    listWrap.replaceChildren();
    if (!list.length && !(S.buyTab === "ordered" && phantoms.length)) {
      listWrap.append(el("div", { class: "empty", style: "padding:14px" },
        S.buyTab === "ordered"
          ? "Nothing ordered yet — every row has an Order button."
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
      if (o.state === "placed" && latest) {
        note = el("span", {}, `🚚 ${latest.name || "update"} · ${fmtAgo(latest.at)}`
          + (o.tracking.eta_at ? ` · ETA ${fmtDate(o.tracking.eta_at)}` : ""));
      } else if (o.state === "placed" && o.payment_state !== "paid") {
        note = el("span", { class: "st warn" }, "pay on AliExpress");
      } else {
        note = el("span", {}, o.note || "");
      }
      table.append(el("tr", {
        class: `click${sel && sel.asin === p.asin ? " sel" : ""}`,
        onclick: () => { S.buySel = p.asin; renderList(); },
      },
        el("td", { class: "t" },
          el("div", { class: "rowtitle" }, p.title),
          el("div", { class: "rowsub" },
            `${o.id}${o.ae_order_ids?.length ? ` · AE ${o.ae_order_ids.join(", ")}` : ""}` +
            (o.payment_state === "paid" ? " · paid" : ""))),
        el("td", { class: "t" }, stateWord(o.state, ORDER_STATE_LABEL, ORDER_STATE_TONE)),
        el("td", {}, joined.quantity != null ? fmtNum(joined.quantity) : "—"),
        el("td", {}, o.order_cost != null ? fmtR(o.order_cost) : "—"),
        el("td", { class: "t" }, fmtAgo(o.placed_at || joined.received_at)),
        el("td", { class: "t", style: "font-size:11.5px" }, note)));
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
  return el("span", { class: "num" },
    el("b", { style: "color:var(--ok-text)" }, fmtR(p.margin_total)),
    el("span", { style: "color:var(--muted)" },
      ` · ${p.margin_percent ?? "—"}%`));
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

function buyRowAction(p) {
  const o = p.order;
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
    onclick: (ev) => { ev.stopPropagation(); openOrderModal(p); },
  }, again ? "Order again" : "Order");
}

/* ---------- detail panel ---------- */

function buyDetail(p) {
  const card = el("div", { class: "panel" });
  card.append(heroEl(p));
  card.append(el("h3", {}, p.title));

  const chips = el("div", { class: "chiprow" },
    pill("ok", `${fmtR(p.margin_total)} · ${p.margin_percent ?? "—"}%`),
    p.opportunity_score != null
      ? el("span", { class: "pill acc", title: scoreTooltipText(p) },
          `⚡ ${Math.round(p.opportunity_score)}`) : null);
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
      title: p.listing.note || "", onclick: () => setDesk("sell"),
    }, `Amazon listing: ${INTENT_LABEL[p.listing.state] || p.listing.state} →`));
  }
  if (p.takealot) {
    chips.append(el("span", {
      class: `tag${p.takealot.state === "live" ? " ok" : ""}`, style: "cursor:pointer",
      title: p.takealot.note || "",
      onclick: () => setDesk("sell", { sellTab: "takealot" }),
    }, `Takealot offer: ${INTENT_LABEL[p.takealot.state] || p.takealot.state} →`));
  }
  card.append(chips);

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
function orderSpendBox(p, qty) {
  const unit = p.sku_price ?? p.ali_price_used;
  if (unit == null) return null;
  const goods = unit * qty;
  const freight = p.freight != null ? Number(p.freight) : null;
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

function openOrderModal(p) {
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
  typedCommitModal({
    title: "Order from AliExpress",
    product: p.title,
    lines: [`item ${p.ali_id} · SKU ${p.sku_id} · ~${fmtR(unitCost)}/unit` +
            ` · margin ${fmtR(p.margin_total)} (${p.margin_percent ?? "—"}%) at ` +
            `${p.channel === "takealot" ? "Takealot" : "Amazon"} price`],
    warn: orderGateWarn(),
    word: "ORDER",
    qtyLabel: "Quantity",
    confirmLabel: "Commit order intent",
    busKey: "orders",
    spendFor: (qty) => orderSpendBox(p, qty),
    note: "The pipeline only places this if it still clears the margin floor, " +
      "stock, restrictions and the daily caps — and payment is completed on " +
      "aliexpress.com afterwards.",
    entryFor: (qty) => ({
      id: `web-${p.asin}-${Date.now()}`,
      asin: p.asin, ali_id: p.ali_id, sku_id: p.sku_id,
      quantity: qty, source: "manual",
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
        `${(o.ae_order_ids || []).join(", ")}) arrived. This closes tracking, ` +
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
