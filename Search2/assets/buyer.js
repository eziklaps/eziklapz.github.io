/* Buyer page: sourcing & ordering across BOTH demand channels.
   Fetches buyer.enc, decrypts with the shared passphrase (common.js) and
   renders winners as cards — Amazon-discovered and Takealot-discovered
   products carry a `channel` field and get channel-shaped compare tables.
   Order-now is REAL: it commits an order intent to the command bus and the
   pipeline's orders stage verifies price/freight/margin, then places via
   aliexpress.ds.order.create. Deep auth on purpose — passphrase to see the
   page, admin token to write, and a typed ORDER confirmation per intent. */

const REFRESH_MS = 5 * 60_000;

/* ---- history sparklines (data: p.history from the snapshot ledger) ---- */

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) node.append(child);
  return node;
}

/* Single-series mini trend line: the series rides the de-emphasis hue, the
   current segment + ringed end-dot ride the accent, values stay in text
   tokens (see style.css). betterDown flips the y-mapping so an improving
   sales rank (numerically falling) still draws upward. */
function sparkline(points, { betterDown = false, label = "" } = {}) {
  if (!points || points.length < 2) return null;
  const w = 96, h = 26, pad = 4;
  const values = points.map((pt) => pt[1]);
  let min = Math.min(...values), max = Math.max(...values);
  if (min === max) { min -= 1; max += 1; }
  const x = (i) => pad + (i / (points.length - 1)) * (w - 2 * pad);
  const y = (v) => {
    const t = (v - min) / (max - min);
    return pad + (betterDown ? t : 1 - t) * (h - 2 * pad);
  };
  const pts = points.map((pt, i) => `${x(i).toFixed(1)},${y(pt[1]).toFixed(1)}`);
  const last = points[points.length - 1];
  return svgEl("svg", {
    class: "spark", width: w, height: h, viewBox: `0 0 ${w} ${h}`,
    role: "img",
    "aria-label": `${label}: ${fmtNum(points[0][1])} on ${points[0][0]}` +
      ` to ${fmtNum(last[1])} on ${last[0]}`,
  },
    svgEl("title", {}, `${label} ${points[0][0]} → ${last[0]}`),
    svgEl("polyline", { class: "spark-base", points: pts.join(" ") }),
    svgEl("polyline", { class: "spark-now", points: pts.slice(-2).join(" ") }),
    svgEl("circle", { class: "spark-dot", r: 3.5,
      cx: x(points.length - 1).toFixed(1), cy: y(last[1]).toFixed(1) }),
  );
}

/* 30-day rank + price history rows; nothing renders until the ledger has
   two days of numbers for a series. Rank delta: ▲ = climbed the chart. */
function trendBlock(p) {
  const hist = p.history || {};
  const rank = sparkline(hist.rank, { betterDown: true, label: "Sales rank" });
  const price = sparkline(hist.price, { label: "Price" });
  const sales = salesRow(p);
  if (!rank && !price && !sales) return null;

  const rows = [];
  if (sales) rows.push(sales);
  if (rank) {
    const d = p.rank_delta_24h;
    rows.push(el("div", { class: "row" },
      el("span", { class: "tlabel" }, "Rank"), rank,
      d ? el("span", {
            class: `tval ${d < 0 ? "up" : "down"}`,
            title: `sales rank ${d < 0 ? "improved" : "slipped"} ` +
                   `${fmtNum(Math.abs(d))} places in 24h`,
          }, `${d < 0 ? "▲" : "▼"} ${fmtNum(Math.abs(d))} / 24h`)
        : el("span", { class: "tval" }, "")));
  }
  if (price) {
    const values = hist.price.map((pt) => pt[1]);
    const min = Math.min(...values), max = Math.max(...values);
    rows.push(el("div", { class: "row" },
      el("span", { class: "tlabel" }, "Price"), price,
      el("span", { class: "tval" },
        min === max ? "" : `${fmtR(min)}–${fmtR(max)} seen`)));
  }
  return el("div", { class: "trend" }, ...rows);
}

/* Rank→sales estimate off the pipeline's self-calibrated ZA curve
   (services/velocity.py) — an order-of-magnitude read, so the tooltip
   carries the confidence and the measured sale-days behind it. */
function salesRow(p) {
  const est = p.est_units_month;
  const events = p.sale_events_28d;
  if (est == null && !events) return null;
  const text = est != null
    ? `≈${fmtNum(Math.round(est))}/mo`
    : `${events} sale-day${events === 1 ? "" : "s"}/28d`;
  const title = est != null
    ? `estimated units/month from rank (confidence: ${p.velocity_confidence}); ` +
      `${events || 0} sale-day${events === 1 ? "" : "s"} measured in 28d`
    : `rank moved on ${events} day${events === 1 ? "" : "s"} in 28d — units sold`;
  return el("div", { class: "row" },
    el("span", { class: "tlabel" }, "Sales"),
    el("span", {}, ""),
    el("span", { class: "tval", title }, text));
}

/* Ledger event flags (icon + words, never color alone). */
const FLAG_LABELS = {
  "rank-appeared": "🆕 first rank — sales started",
  "first-offer": "🥇 first offer",
  "offers-gone": "🕳 competitor out",
};

function flagChips(p) {
  if (!p.trend_flags) return null;
  return el("div", { class: "flags" },
    ...p.trend_flags.split(" | ").map((flag) =>
      el("span", { class: "flagchip" }, FLAG_LABELS[flag] || flag)));
}

/* ---- image thumbnails ----
   Both CDNs serve resized variants via URL convention (verified live):
   Amazon  .../images/I/<id>.jpg → .../images/I/<id>._SX600_.jpg  (~86→30 KB)
   Ali     .../kf/<id>.jpg       → <url>_480x480q75.jpg_.webp     (~88→26 KB)
   Takealot gallery URLs arrive pre-sized (the intake resolved {size} to
   pdpxl). Unrecognised shapes pass through untouched, and the onerror
   chain always ends at the original URLs, so a CDN dropping the convention
   costs one retried request, never a broken card. */

const AMAZON_IMG_RE = /^(https:\/\/m\.media-amazon\.com\/images\/I\/[^./]+)\.(jpe?g|png|webp)$/i;
const ALI_IMG_RE = /^https:\/\/ae-pic-a1\.aliexpress-media\.com\/kf\/[^_]+\.(jpe?g|png)$/i;

function amazonThumb(url, px) {
  const m = (url || "").match(AMAZON_IMG_RE);
  return m ? `${m[1]}._SX${px}_.${m[2]}` : null;
}

function thumb(url) {
  if (!url) return null;
  const az = amazonThumb(url, 600);
  if (az) return az;
  if (ALI_IMG_RE.test(url)) return `${url}_480x480q75.jpg_.webp`;
  return null;
}

/* Ordered URLs to try: resized primary → original primary → resized ali →
   original ali. */
function imageCandidates(p) {
  const out = [];
  for (const url of [p.image_url, p.ali_image_url]) {
    if (!url) continue;
    const t = thumb(url);
    if (t) out.push(t);
    out.push(url);
  }
  return out;
}

/* The first grid row paints eagerly (the LCP element is a product image);
   everything below the fold stays lazy. */
const EAGER_CARDS = 3;

function productImage(p, index) {
  const candidates = imageCandidates(p);
  if (!candidates.length) return el("div", { class: "noimg" }, "no image");
  let candidateIdx = 0;
  const attrs = {
    src: candidates[0],
    alt: p.title, width: 600, height: 600, decoding: "async",
    loading: index < EAGER_CARDS ? "eager" : "lazy",
    onerror: (ev) => {
      const node = ev.target;
      candidateIdx += 1;
      if (candidateIdx < candidates.length) {
        node.removeAttribute("srcset");
        node.removeAttribute("sizes");
        node.src = candidates[candidateIdx];
      } else {
        node.replaceWith(el("div", { class: "noimg" }, "no image"));
      }
    },
  };
  if (index < EAGER_CARDS) attrs.fetchpriority = "high";
  const azSmall = amazonThumb(p.image_url, 300);
  if (azSmall && candidates[0] === amazonThumb(p.image_url, 600)) {
    attrs.srcset = `${azSmall} 300w, ${candidates[0]} 600w`;
    attrs.sizes = "(max-width: 640px) 90vw, 330px";
  }
  return el("img", attrs);
}

/* ---- channel-shaped compare tables ---- */

function amazonCompare(p) {
  const duty = p.import_percentage != null
    ? `${p.import_percentage}%${p.is_fallback_duty ? " (fallback)" : ""}` : "—";
  return el("table", { class: "compare" },
    el("tr", {}, el("th", {}, ""), el("th", {}, "Amazon"), el("th", {}, "AliExpress")),
    el("tr", {}, el("th", {}, "Price"), el("td", {}, fmtR(p.amazon_price)),
       el("td", {}, fmtR(p.sku_price ?? p.ali_price_used))),
    el("tr", {}, el("th", {}, "Buy Box"), el("td", {}, fmtR(p.amazon_buybox_price)),
       el("td", {}, p.ali_price_source === "sku" ? "SKU price"
          : p.ali_price_source ? "search price" : "—")),
    el("tr", {}, el("th", {}, "Offers"), el("td", {}, fmtNum(p.amazon_total_offers)),
       el("td", {}, "")),
    el("tr", {}, el("th", {}, "Rank"),
       el("td", {}, p.sales_rank ? `#${fmtNum(p.sales_rank)}` : "—"),
       el("td", {}, "")),
    el("tr", {}, el("th", {}, "Freight"), el("td", {}, ""), el("td", {}, fmtR(p.freight))),
    el("tr", {}, el("th", {}, "Duty"), el("td", {}, ""), el("td", {}, duty)),
  );
}

/* Takealot demand column: reviews stand in for rank (the channel exposes no
   sales rank), the offer stack comes from takealot-enrich (— until it runs). */
function takealotCompare(p) {
  const duty = p.import_percentage != null
    ? `${p.import_percentage}%${p.is_fallback_duty ? " (fallback)" : ""}` : "—";
  const detail = p.takealot_detail || {};
  const reviews = p.takealot_reviews != null
    ? `${fmtNum(p.takealot_reviews)}${p.takealot_rating != null ? ` · ${p.takealot_rating}★` : ""}`
    : "—";
  const offers = detail.offer_count != null
    ? `${fmtNum(detail.offer_count)}${detail.seller ? ` (${detail.seller})` : ""}`
    : "—";
  return el("table", { class: "compare" },
    el("tr", {}, el("th", {}, ""), el("th", {}, "Takealot"), el("th", {}, "AliExpress")),
    el("tr", {}, el("th", {}, "Price"), el("td", {}, fmtR(p.takealot_price)),
       el("td", {}, fmtR(p.sku_price ?? p.ali_price_used))),
    el("tr", {}, el("th", {}, "Reviews"), el("td", {}, reviews), el("td", {}, "")),
    el("tr", {}, el("th", { title: "buybox offer stack (takealot-enrich)" }, "Offers"),
       el("td", {}, offers), el("td", {}, "")),
    el("tr", {}, el("th", {}, "Stock"),
       el("td", { class: "t" }, p.takealot_in_stock ?? "—"), el("td", {}, "")),
    el("tr", {}, el("th", {}, "Freight"), el("td", {}, ""), el("td", {}, fmtR(p.freight))),
    el("tr", {}, el("th", {}, "Duty"), el("td", {}, ""), el("td", {}, duty)),
  );
}

function productCard(p, index) {
  const img = productImage(p, index);
  const isTakealot = p.channel === "takealot";

  return el("div", { class: "product" },
    el("div", { class: "imgbox" }, img),
    el("div", { class: "body" },
      el("div", { class: "badges" },
        el("span", { class: "badge" },
          `${fmtR(p.margin_total)} · ${p.margin_percent ?? "—"}%`),
        p.opportunity_score != null
          ? el("span", { class: "badge score", title: scoreTooltip(p) },
              `⚡ ${p.opportunity_score}`)
          : null,
        isTakealot
          ? el("span", { class: "flagchip" }, "🛒 Takealot find")
          : null,
        p.score_category === "sole_seller_candidate"
          ? el("span", { class: "flagchip" }, "🥇 sole-seller candidate")
          : null),
      el("h3", {}, p.title),
      flagChips(p),
      isTakealot ? takealotCompare(p) : amazonCompare(p),
      trendBlock(p),
      el("div", { class: "links" },
        p.amazon_url ? el("a", { href: p.amazon_url, target: "_blank", rel: "noopener" }, "Amazon ↗") : null,
        isTakealot && p.takealot_url
          ? el("a", { href: p.takealot_url, target: "_blank", rel: "noopener" }, "Takealot ↗") : null,
        p.aliexpress_url ? el("a", { href: p.aliexpress_url, target: "_blank", rel: "noopener" }, "AliExpress ↗") : null,
        isTakealot ? null : takealotMatchLink(p)),
      sellStateLine(p),
      orderArea(p),
    ));
}

/* Read-only sell-side chips: what the SELLER page is doing with this
   product per channel (listing actions live there — the chips link
   through). The restock hint closes the loop: stock was bought, the
   listing is live, the next buy decision is the buyer's again. */
const SELL_STATE_SHORT = {
  pending: "queued", ready: "preparing", validated: "validated",
  submitting: "submitting…", submitted: "submitted", live: "🟢 live",
  loadsheet: "loadsheet", offer_ready: "offer queued",
  blocked_exemption: "blocked: exemption", fix_required: "needs fix",
  needs_review: "needs review", rejected: "rejected",
};

function sellStateLine(p) {
  const chips = [];
  const chip = (label, state, note) => el("a", {
    class: "flagchip", href: "../seller/",
    title: note ? `${label}: ${note}` : label,
    style: "text-decoration:none",
  }, `${label}: ${SELL_STATE_SHORT[state] || state}`);
  if (p.listing) chips.push(chip("Amazon listing", p.listing.state, p.listing.note));
  if (p.takealot) chips.push(chip("Takealot", p.takealot.state, p.takealot.note));
  if (!chips.length) return null;
  const anySold = p.order?.state === "placed";
  const anyLive = p.listing?.state === "live" || p.takealot?.state === "live";
  if (anySold && anyLive) {
    chips.push(el("span", { class: "flagchip" },
      "♻ selling live — consider restock"));
  }
  return el("div", { class: "flags" }, ...chips);
}

/* Cross-channel price check from the takealot-match stage (Amazon cards
   only — Takealot-discovered cards ARE the Takealot listing): a link with
   the competing Takealot price when the catalog has the product, a quiet
   "not on Takealot" (= open field there) once checked, nothing before. */
function takealotMatchLink(p) {
  const m = p.takealot_match;
  if (!m) return null;
  if (!m.found) {
    return el("span", { class: "meta", title: `checked ${fmtAgo(m.checked_at)}` },
      "not on Takealot");
  }
  const bits = [];
  if (m.offer_count) bits.push(`${m.offer_count} offer${m.offer_count > 1 ? "s" : ""}`);
  if (m.seller) bits.push(`buybox: ${m.seller}`);
  if (m.cosine != null) bits.push(`image match ${m.cosine}`);
  else if (m.score != null) bits.push(`match score ${m.score}`);
  bits.push(`checked ${fmtAgo(m.checked_at)}`);
  return el("a", {
    href: m.url, target: "_blank", rel: "noopener", title: bits.join(" · "),
  }, `Takealot ${m.price_min != null ? fmtR(m.price_min) : ""} ↗`);
}

/* Order button or, when an intent is already in flight for this product,
   its state (so a second click can't double-order). rejected/failed free
   the button again — with the reason on display. placed keeps its state
   chip but offers "Order again" (restocking is deliberate; each click
   commits a fresh intent id, and the pipeline re-verifies from scratch). */
const ORDER_STATE_LABEL = {
  pending: "⏳ order sent — awaiting verification",
  verified: "✅ verified — placement queued",
  placing: "🛒 placing on AliExpress…",
  placed: "📦 ordered",
  received: "📥 received — in stock",
  needs_review: "🚨 needs review — see admin page",
};

function orderArea(p) {
  const o = p.order;
  if (o && ORDER_STATE_LABEL[o.state]) {
    // Once tracking exists the chip carries the latest fulfilment stage
    // ("Order shipped") instead of the static "ordered".
    const latest = o.tracking?.events?.[0];
    const chipText = o.state === "placed" && latest
      ? `🚚 ${latest.name || "shipped"}`
      : ORDER_STATE_LABEL[o.state];
    return el("div", { class: "orderstate" },
      el("span", { class: "flagchip" }, chipText),
      o.state === "placed" && o.ae_order_ids?.length
        ? el("div", { class: "meta" },
            `AliExpress order ${o.ae_order_ids.join(", ")}`
            + (o.payment_state === "paid" ? " — paid"
               : latest ? "" : " — pay on aliexpress.com if not auto-paid"))
        : null,
      o.state === "received" && o.ae_order_ids?.length
        ? el("div", { class: "meta" },
            `AliExpress order ${o.ae_order_ids.join(", ")} — in inventory`)
        : null,
      o.state === "placed" ? trackingBlock(o.tracking) : null,
      o.state === "placed"
        ? el("div", { style: "margin-top:8px" },
            el("button", { class: "btn order",
                           onclick: () => orderNow(p) }, "Order again"),
            " ",
            el("button", { class: "btn ghost",
                           onclick: () => markReceived(p, o) }, "Mark received"),
            " ",
            el("button", { class: "btn ghost",
                           onclick: () => markCancelled(p, o) }, "Mark cancelled"))
        : null,
      o.state === "received"
        ? el("div", { style: "margin-top:8px" },
            el("button", { class: "btn order",
                           onclick: () => orderNow(p) }, "Order again"))
        : null);
  }
  return el("div", {},
    o ? el("div", { class: "meta", style: "margin-bottom:6px" },
          `↩ previous intent ${o.state}${o.note ? `: ${o.note}` : ""}`)
      : null,
    el("button", { class: "btn order", onclick: () => orderNow(p) },
      o ? "Order again" : "Order now"));
}

/* Fulfilment timeline off the 6h tracking poll: newest event emphasized,
   older ones below, waybill + carrier + ETA as the footer line. */
function trackingBlock(t) {
  if (!t || !(t.events || []).length) return null;
  const footer = [
    t.mail_no ? `waybill ${t.mail_no}` : null,
    t.carrier,
    t.eta_at ? `ETA ${fmtDate(t.eta_at)}` : null,
  ].filter(Boolean).join(" · ");
  return el("div", { class: "trackline" },
    ...t.events.map((e, i) => el("div", {
      class: `tstep${i === 0 ? " now" : ""}`,
      title: e.desc && e.desc !== e.name ? e.desc : "",
    }, `${i === 0 ? "●" : "○"} ${e.name || e.desc || "update"} · ${fmtAgo(e.at)}`)),
    footer ? el("div", { class: "meta" }, footer) : null);
}

/* The happy-path mirror of markCancelled: the box is physically in hand.
   A received entry rides the commands.json wire; the pipeline flips the
   intent to 'received', posts any missing COGS rows (arrival proves
   payment) and books the goods into the inventory collection at their
   estimated landed cost (services/logistics.receive_intent). */
function markReceived(p, o) {
  const dialog = document.getElementById("order-modal");
  if (!localStorage.getItem(PAT_KEY)) {
    orderNow(p); // the order flow collects the token first
    return;
  }
  const status = el("p", { class: "meta" }, "");
  const confirmBtn = el("button", { class: "btn" }, "Mark received");
  confirmBtn.addEventListener("click", async () => {
    confirmBtn.setAttribute("disabled", "");
    status.textContent = "Committing receipt…";
    try {
      await mutateCommands((doc) => {
        doc.orders = (doc.orders || []).filter((x) =>
          x.requested_at && Date.now() - new Date(x.requested_at) < 7 * 864e5);
        doc.orders.push({ id: o.id, received: true,
                          requested_at: new Date().toISOString() });
      }, `Dashboard: mark ${o.id} received`);
      status.textContent = "✅ Receipt committed — the intent flips to " +
        "received and the goods book into inventory when the pipeline " +
        "next syncs (within ~30s while a run or serve is active).";
      confirmBtn.replaceWith(el("button", {
        class: "btn ghost", onclick: () => dialog.close() }, "Done"));
    } catch (e) {
      status.textContent = `Failed: ${e.message}`;
      if (/401|403/.test(e.message)) localStorage.removeItem(PAT_KEY);
      confirmBtn.removeAttribute("disabled");
    }
  });
  dialog.replaceChildren(
    el("h3", {}, "Mark order received"),
    el("p", { class: "meta" },
      `The parcel for intent ${o.id} (AliExpress order ` +
      (o.ae_order_ids || []).join(", ") +
      ") arrived. This closes tracking for it, books the goods into " +
      "inventory at their estimated landed cost, and frees the Order " +
      "button for a restock."),
    confirmBtn, " ",
    el("button", { class: "btn ghost", onclick: () => dialog.close() }, "Close"),
    status);
  dialog.showModal();
}

/* Cancelled-on-the-website orders can't be auto-detected (the AliExpress
   order-status endpoint is registration-gated for this app), so cancelling
   is a manual claim: a cancel entry rides the same commands.json wire as
   the intents, and the pipeline flips the intent to 'cancelled' when it
   sinks it. This marks the dashboard only — it does NOT cancel the actual
   AliExpress order. */
function markCancelled(p, o) {
  const dialog = document.getElementById("order-modal");
  if (!localStorage.getItem(PAT_KEY)) {
    orderNow(p); // the order flow collects the token first
    return;
  }
  const status = el("p", { class: "meta" }, "");
  const confirmBtn = el("button", { class: "btn" }, "Mark cancelled");
  confirmBtn.addEventListener("click", async () => {
    confirmBtn.setAttribute("disabled", "");
    status.textContent = "Committing cancel claim…";
    try {
      await mutateCommands((doc) => {
        doc.orders = (doc.orders || []).filter((x) =>
          x.requested_at && Date.now() - new Date(x.requested_at) < 7 * 864e5);
        doc.orders.push({ id: o.id, cancel: true,
                          requested_at: new Date().toISOString() });
      }, `Dashboard: mark ${o.id} cancelled`);
      status.textContent = "✅ Claim committed — the intent flips to " +
        "cancelled when the pipeline next syncs (within ~30s while a run " +
        "or serve is active).";
      confirmBtn.replaceWith(el("button", {
        class: "btn ghost", onclick: () => dialog.close() }, "Done"));
    } catch (e) {
      status.textContent = `Failed: ${e.message}`;
      if (/401|403/.test(e.message)) localStorage.removeItem(PAT_KEY);
      confirmBtn.removeAttribute("disabled");
    }
  });
  dialog.replaceChildren(
    el("h3", {}, "Mark order cancelled"),
    el("p", { class: "meta" },
      `For orders you cancelled on aliexpress.com. Marks intent ${o.id} ` +
      "(AliExpress order " + (o.ae_order_ids || []).join(", ") +
      ") as cancelled on this dashboard and frees the Order button — it " +
      "does not touch the AliExpress order itself."),
    confirmBtn, " ",
    el("button", { class: "btn ghost", onclick: () => dialog.close() }, "Close"),
    status);
  dialog.showModal();
}

/* Hover breakdown for the opportunity-score badge: the five component
   values (— = signal unavailable, lowering confidence instead of score). */
function scoreTooltip(p) {
  const c = p.score_components || {};
  const bits = ["margin", "demand", "moat", "stability", "quality"]
    .map((k) => `${k} ${c[k] == null ? "—" : c[k]}`);
  if (p.score_confidence != null) bits.push(`confidence ${p.score_confidence}`);
  if (c.quality_penalties && c.quality_penalties.length) {
    bits.push(`penalties: ${c.quality_penalties.join(", ")}`);
  }
  return bits.join(" · ");
}

function orderNow(p) {
  const dialog = document.getElementById("order-modal");

  if (!p.ali_id || !p.sku_id) {
    dialog.replaceChildren(
      el("h3", {}, "Can't order this one"),
      el("p", { class: "meta" },
        "No matched AliExpress SKU on record — the pipeline can only order " +
        "products it has SKU-matched."),
      el("button", { class: "btn ghost", onclick: () => dialog.close() }, "Close"));
    dialog.showModal();
    return;
  }

  // Write credential first: intents are writes to the command bus.
  if (!localStorage.getItem(PAT_KEY)) {
    const copy = tokenPromptCopy();
    const patInput = el("input", {
      type: "password",
      placeholder: LIVE_BASE ? "Dashboard admin token"
                             : "Fine-grained GitHub token (contents R/W)",
      style: "width:100%;padding:8px 10px;margin:8px 0;border:1px solid var(--hairline);" +
             "border-radius:8px;background:var(--surface);color:var(--ink);",
    });
    dialog.replaceChildren(
      el("h3", {}, `Ordering ${copy.title}`),
      el("p", { class: "meta" },
        `Order intents ride the pipeline's command bus. ${copy.hint}`),
      patInput,
      el("button", {
        class: "btn", onclick: () => {
          if (patInput.value.trim()) {
            localStorage.setItem(PAT_KEY, patInput.value.trim());
            dialog.close();
            orderNow(p);
          }
        },
      }, "Save token"),
      " ",
      el("button", { class: "btn ghost", onclick: () => dialog.close() }, "Cancel"));
    dialog.showModal();
    return;
  }

  const unitCost = p.sku_price ?? p.ali_price_used;
  const qtySelect = el("select", {
    style: "padding:8px 10px;border:1px solid var(--hairline);border-radius:8px;" +
           "background:var(--surface);color:var(--ink);",
  }, ...[1, 2, 3, 4, 5].map((n) => el("option", { value: n }, `${n}`)));
  const confirmInput = el("input", {
    type: "text", placeholder: "Type ORDER to arm the button",
    autocomplete: "off", autocapitalize: "characters", spellcheck: "false",
    style: "width:100%;padding:8px 10px;margin-top:8px;border:1px solid var(--hairline);" +
           "border-radius:8px;background:var(--surface);color:var(--ink);",
  });
  const status = el("p", { class: "meta" }, "");
  const placeBtn = el("button", { class: "btn", disabled: "" }, "Commit order intent");
  confirmInput.addEventListener("input", () => {
    if (confirmInput.value.trim() === "ORDER") placeBtn.removeAttribute("disabled");
    else placeBtn.setAttribute("disabled", "");
  });

  placeBtn.addEventListener("click", async () => {
    placeBtn.setAttribute("disabled", "");
    confirmInput.setAttribute("disabled", "");
    status.textContent = "Committing order intent…";
    const intent = {
      id: `web-${p.asin}-${Date.now()}`,
      asin: p.asin, ali_id: p.ali_id, sku_id: p.sku_id,
      quantity: Number(qtySelect.value), source: "manual",
      requested_at: new Date().toISOString(),
    };
    try {
      await mutateCommands((doc) => {
        // Prune intents the pipeline sank long ago; the Mongo intent is
        // the durable record, commands.json is just the wire.
        doc.orders = (doc.orders || []).filter((o) =>
          o.requested_at && Date.now() - new Date(o.requested_at) < 7 * 864e5);
        doc.orders.push(intent);
      }, `Dashboard: order ${p.asin} x${intent.quantity}`);
      status.textContent =
        "✅ Intent committed. The pipeline re-verifies price, freight, " +
        "restrictions and margin, then places the order (within ~30s while " +
        "a run or serve is active). This page will show the state on its " +
        "next refresh.";
      placeBtn.replaceWith(el("button", {
        class: "btn ghost", onclick: () => dialog.close() }, "Done"));
    } catch (e) {
      status.textContent = `Failed: ${e.message}`;
      if (/401|403/.test(e.message)) localStorage.removeItem(PAT_KEY);
      confirmInput.removeAttribute("disabled");
    }
  });

  dialog.replaceChildren(
    el("h3", {}, "Order from AliExpress"),
    el("p", { class: "meta" }, p.title),
    el("p", { class: "meta" },
      `item ${p.ali_id} · SKU ${p.sku_id} · ~${fmtR(unitCost)}/unit + freight ` +
      `(re-verified at order time)`),
    el("div", { style: "margin:8px 0" }, "Quantity: ", qtySelect),
    el("p", { class: "meta" },
      "The pipeline only places this if it still clears the margin floor, " +
      "stock, restrictions and the daily caps — and payment is completed " +
      "on aliexpress.com afterwards."),
    confirmInput,
    el("div", { style: "margin-top:10px" },
      placeBtn, " ",
      el("button", { class: "btn ghost", onclick: () => dialog.close() }, "Cancel")),
    status);
  dialog.showModal();
}

let renderedProductsKey = null;
let activeTab = "amazon";
let lastProducts = [];

/* Ordered tab: every product whose latest intent exists, in-flight and
   placed first (stable sort keeps the score order within each state). */
const TAB_STATE_RANK = {
  placed: 0, placing: 1, verified: 2, pending: 3, needs_review: 4,
};

function tabProducts(products) {
  if (activeTab === "ordered") {
    return products
      .filter((p) => p.order)
      .slice()
      .sort((a, b) => (TAB_STATE_RANK[a.order.state] ?? 9)
                      - (TAB_STATE_RANK[b.order.state] ?? 9));
  }
  return products.filter((p) => (p.channel || "amazon") === activeTab);
}

function renderTabs() {
  const nav = document.getElementById("tabs");
  if (!nav) return;
  const amazon = lastProducts.filter((p) => (p.channel || "amazon") === "amazon").length;
  const takealot = lastProducts.filter((p) => p.channel === "takealot").length;
  const ordered = lastProducts.filter((p) => p.order).length;
  nav.hidden = false;
  const tab = (id, label) => el("button", {
    class: `tab${activeTab === id ? " active" : ""}`,
    onclick: () => {
      if (activeTab === id) return;
      activeTab = id;
      renderTabs();
      renderGrid();
    },
  }, label);
  nav.replaceChildren(
    tab("amazon", `Amazon (${amazon})`),
    tab("takealot", `Takealot (${takealot})`),
    tab("ordered", `Ordered (${ordered})`));
}

function renderGrid() {
  const grid = document.getElementById("products");
  grid.replaceChildren();
  const list = tabProducts(lastProducts);
  if (!list.length) {
    grid.append(el("p", {}, activeTab === "ordered"
      ? "Nothing ordered yet — every product card has an Order button."
      : activeTab === "takealot"
      ? "No Takealot-discovered winners yet — run the pull-takealot stage " +
        "(admin → Run stage) and let a funnel run carry the docs through."
      : "No winning products yet — the pipeline is still hunting."));
    return;
  }
  list.forEach((p, i) => grid.append(productCard(p, i)));
}

/* Called up to twice per load (cached copy, then fresh) and again on every
   poll tick. The meta line always updates; the grid only rebuilds when the
   product content actually changed — the hourly force-republish bumps
   generated_at without changing content, and rebuilding re-decodes every
   image for nothing. Tab switches rebuild via renderGrid directly. */
function renderMeta(data) {
  updateStaleness(document.getElementById("stale"), data.generated_at, 24 * 60);
  const kw = data.keywords || {};
  const kwBits = ["amazon", "takealot"]
    .filter((m) => kw[m])
    .map((m) => `${m} intake: ${kw[m].pending ?? 0} pending`);
  document.getElementById("meta").textContent =
    `${data.products.length} winners · ${kwBits.join(" · ")} · ` +
    `updated ${fmtAgo(data.generated_at)}`;
}

function render(data, fromCache) {
  renderMeta(data);
  const key = JSON.stringify(data.products);
  if (key === renderedProductsKey) return;
  renderedProductsKey = key;
  lastProducts = data.products;
  renderTabs();
  renderGrid();
}

/* ---- boot: passphrase gate over buyer.enc ----
   Same gate as the other pages (shared passphrase + remembered value).
   The SWR fast paint survives encryption: the cached ENVELOPE decrypts
   locally, so a return visit with a remembered passphrase paints without
   waiting on the network. */

let passphrase = null;

/* Identical ciphertext = identical payload (the publisher is hash-gated),
   so skip the PBKDF2 decrypt entirely — the grid dedupe in render() can't
   help with that cost. Only set after a successful decrypt: a wrong
   passphrase must keep hitting the gate. */
let lastCiphertext = null;
let lastRendered = null;

async function tryRender(envelope, fromCache) {
  if (lastCiphertext && envelope.ciphertext === lastCiphertext) {
    if (lastRendered) renderMeta(lastRendered);   // the clock lines keep aging
    return;
  }
  const data = await decryptEnvelope(envelope, passphrase); // throws on wrong pass
  lastCiphertext = envelope.ciphertext;
  lastRendered = data;
  document.getElementById("gate").hidden = true;
  document.getElementById("main").hidden = false;
  render(data, fromCache);
}

function refresh() {
  return fetchJsonCached("buyer.enc", (envelope, fromCache) => {
    tryRender(envelope, fromCache).catch(console.warn);
  });
}

async function boot() {
  const gateError = document.getElementById("gate-error");
  const input = document.getElementById("pass-input");

  async function attempt(pass, remember) {
    passphrase = pass;
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem("s2cache:buyer.enc")); } catch (e) {}
    try {
      if (cached) {
        try {
          await tryRender(cached, true);
        } catch (e) {
          if (e.name !== "OperationError") throw e;
          // Cache from a rotated passphrase era — the fresh copy decides.
          await tryRender(await fetchJson("buyer.enc"), false);
        }
      } else {
        await tryRender(await fetchJson("buyer.enc"), false);
      }
    } catch (e) {
      passphrase = null;
      localStorage.removeItem(PASS_KEY);
      gateError.textContent = e.name === "OperationError"
        ? "Wrong passphrase." : `Could not load data: ${e.message}`;
      return false;
    }
    if (remember) localStorage.setItem(PASS_KEY, pass);
    refresh().catch(console.warn);            // fresh copy behind the paint
    setInterval(() => refresh().catch(console.warn), REFRESH_MS);
    // Live layer (no-op when off): a publish stamps buyer.enc and the page
    // refreshes within seconds; the interval above stays as the fallback.
    liveConnect((name) => {
      if (name === "buyer.enc") refresh().catch(console.warn);
    });
    return true;
  }

  document.getElementById("gate-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    gateError.textContent = "";
    await attempt(input.value, true);
  });

  const stored = localStorage.getItem(PASS_KEY);
  if (stored) await attempt(stored, false);
}

boot();
