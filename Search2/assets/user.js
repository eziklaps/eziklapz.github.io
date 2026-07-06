/* Product showcase + order desk: fetch user.enc, decrypt with the shared
   passphrase (common.js), render winners as cards. Order-now is REAL:
   it commits an order intent to commands.json (GitHub PAT required) and the
   pipeline's orders stage verifies price/freight/margin, then places via
   aliexpress.ds.order.create. Deep auth on purpose — passphrase to see the
   page, PAT to write, and a typed ORDER confirmation per intent. */

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
  if (!rank && !price) return null;

  const rows = [];
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
   Unrecognised shapes pass through untouched, and the onerror chain always
   ends at the original URLs, so a CDN dropping the convention costs one
   retried request, never a broken card. */

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

function productCard(p, index) {
  const img = productImage(p, index);

  const duty = p.import_percentage != null
    ? `${p.import_percentage}%${p.is_fallback_duty ? " (fallback)" : ""}` : "—";

  const compare = el("table", { class: "compare" },
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
        p.score_category === "sole_seller_candidate"
          ? el("span", { class: "flagchip" }, "🥇 sole-seller candidate")
          : null),
      el("h3", {}, p.title),
      flagChips(p),
      compare,
      trendBlock(p),
      el("div", { class: "links" },
        p.amazon_url ? el("a", { href: p.amazon_url, target: "_blank", rel: "noopener" }, "Amazon ↗") : null,
        p.aliexpress_url ? el("a", { href: p.aliexpress_url, target: "_blank", rel: "noopener" }, "AliExpress ↗") : null),
      orderArea(p),
    ));
}

/* Order button or, when an intent is already in flight for this ASIN, its
   state (so a second click can't double-order). rejected/failed free the
   button again — with the reason on display. */
const ORDER_STATE_LABEL = {
  pending: "⏳ order sent — awaiting verification",
  verified: "✅ verified — placement queued",
  placing: "🛒 placing on AliExpress…",
  placed: "📦 ordered",
  needs_review: "🚨 needs review — see admin page",
};

function orderArea(p) {
  const o = p.order;
  if (o && ORDER_STATE_LABEL[o.state]) {
    return el("div", { class: "orderstate" },
      el("span", { class: "flagchip" }, ORDER_STATE_LABEL[o.state]),
      o.state === "placed" && o.ae_order_ids?.length
        ? el("div", { class: "meta" },
            `AliExpress order ${o.ae_order_ids.join(", ")} — pay on aliexpress.com if not auto-paid`)
        : null);
  }
  return el("div", {},
    o ? el("div", { class: "meta", style: "margin-bottom:6px" },
          `↩ previous intent ${o.state}${o.note ? `: ${o.note}` : ""}`)
      : null,
    el("button", { class: "btn order", onclick: () => orderNow(p) },
      o ? "Order again" : "Order now"));
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

  // Write credential first: intents are commits to commands.json.
  if (!localStorage.getItem(PAT_KEY)) {
    const patInput = el("input", {
      type: "password", placeholder: "Fine-grained GitHub token (contents R/W)",
      style: "width:100%;padding:8px 10px;margin:8px 0;border:1px solid var(--hairline);" +
             "border-radius:8px;background:var(--surface);color:var(--ink);",
    });
    dialog.replaceChildren(
      el("h3", {}, "Ordering needs the GitHub token"),
      el("p", { class: "meta" },
        "Order intents are committed to commands.json on the data branch. " +
        "Paste the same fine-grained token the admin page uses (contents " +
        "read/write on the site repo only). Stored in this browser only."),
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

/* Called up to twice per load (cached copy, then fresh) and again on every
   poll tick. The meta line always updates; the grid only rebuilds when the
   product content actually changed — the hourly force-republish bumps
   generated_at without changing content, and rebuilding re-decodes every
   image for nothing. */
function render(data, fromCache) {
  updateStaleness(document.getElementById("stale"), data.generated_at, 24 * 60);
  document.getElementById("meta").textContent =
    `${data.products.length} products · updated ${fmtAgo(data.generated_at)}`;
  const key = JSON.stringify(data.products);
  if (key === renderedProductsKey) return;
  renderedProductsKey = key;
  const grid = document.getElementById("products");
  grid.replaceChildren();
  if (!data.products.length) {
    grid.append(el("p", {}, "No winning products yet — the pipeline is still hunting."));
    return;
  }
  data.products.forEach((p, i) => grid.append(productCard(p, i)));
}

/* ---- boot: passphrase gate over user.enc ----
   Same gate as the admin page (shared passphrase + remembered value).
   The SWR fast paint survives encryption: the cached ENVELOPE decrypts
   locally, so a return visit with a remembered passphrase paints without
   waiting on the network. */

let passphrase = null;

async function tryRender(envelope, fromCache) {
  const data = await decryptEnvelope(envelope, passphrase); // throws on wrong pass
  document.getElementById("gate").hidden = true;
  document.getElementById("main").hidden = false;
  render(data, fromCache);
}

function refresh() {
  return fetchJsonCached("user.enc", (envelope, fromCache) => {
    tryRender(envelope, fromCache).catch(console.warn);
  });
}

async function boot() {
  const gateError = document.getElementById("gate-error");
  const input = document.getElementById("pass-input");

  async function attempt(pass, remember) {
    passphrase = pass;
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem("s2cache:user.enc")); } catch (e) {}
    try {
      if (cached) {
        try {
          await tryRender(cached, true);
        } catch (e) {
          if (e.name !== "OperationError") throw e;
          // Cache from a rotated passphrase era — the fresh copy decides.
          await tryRender(await fetchJson("user.enc"), false);
        }
      } else {
        await tryRender(await fetchJson("user.enc"), false);
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
