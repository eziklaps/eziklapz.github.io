/* Product showcase: fetch user.json, render the winners as cards with the
   full Amazon-vs-AliExpress comparison and an Order-now stub (real ordering
   via aliexpress.ds.order.create comes later — the button carries the ids
   it will need). */

const REFRESH_MS = 5 * 60_000;

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
      compare,
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
