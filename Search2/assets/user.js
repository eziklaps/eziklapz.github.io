/* Product showcase: fetch user.json, render the winners as cards with the
   full Amazon-vs-AliExpress comparison and an Order-now stub (real ordering
   via aliexpress.ds.order.create comes later — the button carries the ids
   it will need). */

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

function productCard(p) {
  const img = el("img", {
    src: p.image_url || p.ali_image_url || "",
    alt: p.title, loading: "lazy",
    onerror: (ev) => {
      const node = ev.target;
      if (p.ali_image_url && node.src !== p.ali_image_url) node.src = p.ali_image_url;
      else node.replaceWith(el("div", { class: "noimg" }, "no image"));
    },
  });

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
      el("div", {},
        el("span", { class: "badge" },
          `${fmtR(p.margin_total)} · ${p.margin_percent ?? "—"}%`)),
      el("h3", {}, p.title),
      flagChips(p),
      compare,
      trendBlock(p),
      el("div", { class: "links" },
        p.amazon_url ? el("a", { href: p.amazon_url, target: "_blank", rel: "noopener" }, "Amazon ↗") : null,
        p.aliexpress_url ? el("a", { href: p.aliexpress_url, target: "_blank", rel: "noopener" }, "AliExpress ↗") : null),
      el("button", {
        class: "btn order", "data-ali-id": p.ali_id ?? "", "data-sku-id": p.sku_id ?? "",
        onclick: () => orderNow(p),
      }, "Order now"),
    ));
}

function orderNow(p) {
  const dialog = document.getElementById("order-modal");
  dialog.replaceChildren(
    el("h3", {}, "Ordering is coming soon"),
    el("p", { class: "meta" },
      "One-click ordering through the AliExpress Dropship API " +
      "(aliexpress.ds.order.create) is on the roadmap. For now, order manually:"),
    el("p", { class: "meta" },
      `item ${p.ali_id ?? "?"}${p.sku_id ? ` · SKU ${p.sku_id}` : ""}`),
    p.aliexpress_url
      ? el("p", {}, el("a", { href: p.aliexpress_url, target: "_blank", rel: "noopener" },
          "Open the AliExpress listing ↗"))
      : null,
    el("button", { class: "btn ghost", onclick: () => dialog.close() }, "Close"),
  );
  dialog.showModal();
}

async function load() {
  const data = await fetchJson("user.json");
  updateStaleness(document.getElementById("stale"), data.generated_at, 24 * 60);
  document.getElementById("meta").textContent =
    `${data.products.length} products · updated ${fmtAgo(data.generated_at)}`;
  const grid = document.getElementById("products");
  grid.replaceChildren();
  if (!data.products.length) {
    grid.append(el("p", {}, "No winning products yet — the pipeline is still hunting."));
    return;
  }
  for (const p of data.products) grid.append(productCard(p));
}

load().catch((e) => {
  document.getElementById("meta").textContent = `Could not load data: ${e.message}`;
});
setInterval(() => load().catch(console.warn), REFRESH_MS);
