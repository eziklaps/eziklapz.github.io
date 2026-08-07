/* Stock desk — where every unit is: inbound AliExpress shipments (the
   logistics state machine), per-location balances from the stock_movements
   log (received / sold / moved / write-off / returned / adjust), the
   Takealot channel mirror and the FBA pool (synced from the FBA Inventory
   API each sales poll). Velocity + listing state join from the buyer
   payload by ASIN, so cover-days need no extra publish. Move-stock /
   write-offs / count adjustments post to the bus (doc.stock.moves →
   funnel/commands.sink_stock). */

/* Reorder math: an AliExpress order takes ~a month door to door, so the
   reorder point is lead-time demand plus a safety buffer, netted against
   what's already on the road — firing at "cover ≤ 7d" guaranteed a
   three-week stockout. The suggested quantity tops the position back up
   to lead + safety + one order cycle. */
const LEAD_TIME_DAYS = 30, SAFETY_STOCK_DAYS = 10, ORDER_CYCLE_DAYS = 30;

function stockModel() {
  const a = S.admin || {};
  const stock = a.stock || {};
  const byAsin = buyerByAsin();
  const account = ((S.seller || {}).takealot || {}).account || {};

  const transit = (stock.transit || []).map((t) => ({
    ...t,
    /* still on the road = ordered minus tranches already on the shelf —
       a split order's received boxes must stop counting as inbound */
    remaining: Math.max((t.quantity || 1) - (t.received_units || 0), 0),
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
    maxSendable: null,
  };
  for (const h of stock.on_hand || []) {
    const r = row(h.asin);
    r.title = h.title || r.title;
    r.locs = h.locations || { home: h.units || 0 };
    r.home += r.locs.home || 0;
    r.value += h.value_rand || 0;
    r.basis = h.cost_basis || r.basis;
    r.received_at = h.received_at || r.received_at;
    /* Manual/wholesale receipts (Receive stock…): no AliExpress intent
       exists to reorder through — the row says who supplied it instead. */
    r.manual = h.manual || r.manual;
    r.supplier = h.supplier || r.supplier;
    /* Portal max sendable — typed off the Takealot booking screen and
       remembered server-side; null = never captured (or cleared). */
    r.maxSendable = h.max_sendable != null ? h.max_sendable : null;
    /* Catalog shipped-package figures — the booking modal's box prefill. */
    r.packageWeight = h.package_weight_kg || null;
    r.packageDims = h.package_dims_cm || null;
  }
  for (const t of transit) {
    if (!t.asin) continue;
    const r = row(t.asin);
    r.title = t.title || r.title;
    r.road += t.remaining;
    t.row = r;
  }
  const committed = stock.committed || {};
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
    /* ATP: what could actually be sold right now. On hand already nets a
       negative DC balance (units owed to Takealot), so subtract only the
       open-MFN holds and returned boxes awaiting inspection. Negative
       available = oversold, worth seeing. */
    r.dcOwed = Math.max(0, -(r.locs.takealot || 0));
    r.mfnOpen = committed[r.asin] || 0;
    r.returns = Math.max(0, r.locs.returns || 0);
    r.available = r.onHand - r.mfnOpen - r.returns;
    r.velocity = p && p.est_units_month != null ? p.est_units_month : null;
    r.live = !!(p && (p.listing?.state === "live" || p.takealot?.state === "live"));
    r.queued = !!(p && ((p.listing && !PARKED.has(p.listing.state) && p.listing.state !== "live")
      || (p.takealot && !PARKED.has(p.takealot.state) && p.takealot.state !== "live")));
    const daily = r.velocity ? r.velocity / 30 : null;
    r.coverDays = (daily && r.available > 0) ? r.available / daily : null;
    /* Net position (sellable + inbound) against the reorder point. */
    const position = r.available + r.road;
    r.positionDays = daily ? Math.max(position, 0) / daily : null;
    const ropUnits = daily ? daily * (LEAD_TIME_DAYS + SAFETY_STOCK_DAYS) : null;
    if (r.live && daily && position < ropUnits) {
      r.group = "restock";
      r.suggestQty = Math.max(1, Math.ceil(
        daily * (LEAD_TIME_DAYS + SAFETY_STOCK_DAYS + ORDER_CYCLE_DAYS) - position));
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
           fbaSyncedAt: stock.fba_synced_at || null,
           totals: (a.orders || {}).inventory || {} };
}

/* Move-stock / Write-off / Adjust-count modal: posts one doc.stock.moves
   entry to the bus. Moves are validated against the movement log's
   balance (a rejected move comes back in the log with the reason); an
   adjust is a stocktake correction — the shelf is the truth, no balance
   check, and Books only posts when it's flagged shrinkage. */
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
      el("option", { value: "write_off" }, "Write off"),
      el("option", { value: "adjust" }, "Adjust count"));
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
    const qtyIn = el("input", {
      type: "number", class: "in", value: "1", min: "1", max: "999",
      style: "width:70px",
    });
    const signSel = el("select", { class: "in" },
      el("option", { value: "-1", selected: "" }, "− missing"),
      el("option", { value: "1" }, "+ found"));
    const adjLocSel = el("select", { class: "in" },
      ...[...new Set(["home", "takealot", "fba", "returns",
                      ...Object.keys(r.locs || {})])]
        .map((k, i) => el("option", {
          value: k, ...(i === 0 ? { selected: "" } : {}),
        }, r.locs[k] != null ? `${k} (${r.locs[k]})` : k)));
    const shrinkChk = el("input", { type: "checkbox" });
    const shrinkRow = el("label", {
      style: "display:flex;align-items:center;gap:8px;margin-top:10px;" +
        "font-size:12.5px;color:var(--ink2)",
    }, shrinkChk,
      "shrinkage — goods genuinely lost (posts the Books expense at avg cost)");
    const noteInput = el("input", {
      type: "text", class: "in wide", style: "margin-top:10px",
      placeholder: "note (why) — lands in the log; write-offs post it to Books",
    });
    const fromRow = el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
      el("span", { class: "meta", style: "min-width:44px" }, "from"), fromSel);
    const toRow = el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
      el("span", { class: "meta", style: "min-width:44px" }, "to"), toSel, toInput);
    const adjRow = el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
      el("span", { class: "meta", style: "min-width:44px" }, "count"), signSel, adjLocSel);
    const sync = () => {
      const mode = modeSel.value;
      toRow.style.display = mode === "move" ? "flex" : "none";
      fromRow.style.display = mode === "adjust" ? "none" : "flex";
      adjRow.style.display = mode === "adjust" ? "flex" : "none";
      shrinkRow.style.display =
        mode === "adjust" && signSel.value === "-1" ? "flex" : "none";
    };
    modeSel.addEventListener("change", sync);
    signSel.addEventListener("change", sync);
    const status = statusLine();
    openModal(
      el("h3", {}, `Move stock — ${r.title || r.asin}`),
      el("p", { class: "meta" },
        "A move re-homes units in the log (nothing posts to the channels); " +
        "a write-off removes them and books the loss to Books at landed " +
        "cost; an adjust corrects the count to what the stocktake found."),
      el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
        el("span", { class: "meta", style: "min-width:44px" }, "what"), modeSel, qtyIn,
        el("span", { class: "meta" }, "unit(s)")),
      fromRow,
      toRow,
      adjRow,
      shrinkRow,
      noteInput,
      el("button", {
        class: "b pri wide", style: "margin-top:12px",
        onclick: () => {
          const mode = modeSel.value;
          const writeOff = mode === "write_off";
          const qty = Math.round(Number(qtyIn.value));
          if (!(qty >= 1 && qty <= 999)) {
            status.textContent = "Quantity must be 1–999.";
            return;
          }
          const to = (toSel.value || toInput.value.trim().toLowerCase());
          if (mode === "move" && !to) {
            status.textContent = "Name the destination location.";
            return;
          }
          if (mode === "move" && to === fromSel.value) {
            status.textContent = "Destination matches the source.";
            return;
          }
          let entry;
          if (mode === "adjust") {
            entry = {
              asin: r.asin, quantity: qty * Number(signSel.value),
              adjust: true, location: adjLocSel.value,
              note: noteInput.value.trim() || undefined,
              requested_at: new Date().toISOString(),
            };
            if (signSel.value === "-1" && shrinkChk.checked) entry.shrinkage = true;
          } else {
            entry = {
              asin: r.asin, quantity: qty,
              from: fromSel.value,
              note: noteInput.value.trim() || undefined,
              requested_at: new Date().toISOString(),
            };
            if (writeOff) entry.write_off = true;
            else entry.to = to;
          }
          busAct(mode === "adjust" ? `adjust ${r.asin}`
            : writeOff ? `write off ${r.asin}` : `move ${r.asin}`, (doc) => {
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
    sync();
  });
}

/* Receive-stock modal: books goods bought OUTSIDE AliExpress — Alibaba
   wholesale, local buys, own-brand stock — as one doc.stock.receipts
   entry (funnel/commands.sink_stock → services/intake.apply_receipt).
   One commit lands the product doc (minted if the SKU is new), the
   costed inventory row at the invoice's landed cost, the Books rows
   (310 goods / 311 freight) and the received movement; linking an
   uploaded invoice marks it posted against exactly those rows. */
function receiveStockModal(m) {
  withToken(() => {
    const known = new Set([
      ...m.rows.map((r) => r.asin),
      ...Object.keys(buyerByAsin()),
    ]);
    const skuIn = el("input", {
      type: "text", class: "in", placeholder: "ASIN / barcode / own SKU",
      autocapitalize: "characters", style: "width:170px",
    });
    const titleIn = el("input", {
      type: "text", class: "in wide", style: "margin-top:10px",
      placeholder: "title — required when the SKU is new to the system",
    });
    const qtyIn = el("input", {
      type: "number", class: "in", value: "1", min: "1", max: "9999",
      style: "width:80px",
    });
    const goodsIn = el("input", {
      type: "number", class: "in", placeholder: "goods total R",
      min: "0", step: "0.01", style: "width:130px",
    });
    const freightIn = el("input", {
      type: "number", class: "in", placeholder: "freight R (opt)",
      min: "0", step: "0.01", style: "width:130px",
    });
    const vatIn = el("input", {
      type: "number", class: "in", placeholder: "VAT R (opt)",
      min: "0", step: "0.01", style: "width:110px",
    });
    const supplierIn = el("input", {
      type: "text", class: "in wide", style: "margin-top:10px",
      placeholder: "supplier — e.g. Alibaba · Shenzhen Foo Ltd",
    });
    const locSel = el("select", { class: "in" },
      ...["home", "takealot", "fba"].map((k, i) => el("option", {
        value: k, ...(i === 0 ? { selected: "" } : {}),
      }, k)));
    const channelSel = el("select", { class: "in" },
      el("option", { value: "amazon", selected: "" }, "Amazon"),
      el("option", { value: "takealot" }, "Takealot"));
    const targetIn = el("input", {
      type: "number", class: "in", placeholder: "target sell price R",
      min: "0", step: "0.01", style: "width:150px",
    });
    const brandIn = el("input", {
      type: "text", class: "in", placeholder: "brand (opt)",
      style: "width:130px",
    });
    const barcodeIn = el("input", {
      type: "text", class: "in", placeholder: "barcode (opt)",
      style: "width:140px",
    });
    const imageIn = el("input", {
      type: "url", class: "in wide", style: "margin-top:10px",
      placeholder: "image URL (opt — a create-own listing needs one)",
    });
    const docs = (((S.admin || {}).accounting || {}).documents || [])
      .filter((d) => d.status === "new" || d.status === "extracted");
    const docSel = el("select", { class: "in wide", style: "margin-top:10px" },
      el("option", { value: "", selected: "" }, "no invoice linked"),
      ...docs.map((d) => el("option", { value: d.id },
        `${d.filename || d.id}${d.supplier ? ` — ${d.supplier}` : ""}` +
        `${d.total_amount != null ? ` — ${d.currency || "R"} ${d.total_amount}` : ""}`)));
    const noteIn = el("input", {
      type: "text", class: "in wide", style: "margin-top:10px",
      placeholder: "note (opt) — lands in the movement log",
    });
    const status = statusLine();
    const rowOf = (label, ...kids) => el("div",
      { style: "display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap" },
      el("span", { class: "meta", style: "min-width:56px" }, label), ...kids);
    openModal(
      el("h3", {}, "Receive stock — outside AliExpress"),
      el("p", { class: "meta" },
        "Books a wholesale/local arrival in one shot: costed inventory at " +
        "the invoice's landed price, the Books COGS rows, the movement — " +
        "and a new product doc if the SKU is new (it enters the Sell side " +
        "once it has a cost and a price to margin against)."),
      rowOf("what", skuIn, el("span", { class: "meta" }, "×"), qtyIn,
        el("span", { class: "meta" }, "unit(s) into"), locSel),
      titleIn,
      rowOf("cost", goodsIn, freightIn, vatIn),
      supplierIn,
      rowOf("sell via", channelSel, targetIn, brandIn, barcodeIn),
      el("div", { class: "hint", style: "margin-top:4px" },
        "target price prices/scores a brand-new item until a market price " +
        "exists — required for a new own-SKU on Amazon; a known ASIN gets " +
        "its live market price automatically"),
      imageIn,
      docSel,
      noteIn,
      el("button", {
        class: "b pri wide", style: "margin-top:12px",
        onclick: () => {
          const sku = skuIn.value.trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, "");
          const qty = Math.round(Number(qtyIn.value));
          const goods = Number(goodsIn.value);
          const isNew = sku && !known.has(sku);
          const ownSku = !/^[A-Z0-9]{10}$/.test(sku);
          if (!sku) { status.textContent = "Enter the SKU/ASIN."; return; }
          if (!(qty >= 1 && qty <= 9999)) {
            status.textContent = "Quantity must be 1–9999."; return;
          }
          if (!(goods > 0)) {
            status.textContent = "Goods total (Rands, off the invoice) is required.";
            return;
          }
          if (isNew && !titleIn.value.trim()) {
            status.textContent = "This SKU is new to the system — give it a title.";
            return;
          }
          if (isNew && ownSku && channelSel.value !== "takealot"
              && !(Number(targetIn.value) > 0)) {
            status.textContent =
              "A new own-SKU needs a target sell price — nothing can market-price an unlisted product.";
            return;
          }
          const entry = {
            sku, quantity: qty, goods_rand: goods,
            requested_at: new Date().toISOString(),
          };
          if (titleIn.value.trim()) entry.title = titleIn.value.trim();
          if (Number(freightIn.value) > 0) entry.freight_rand = Number(freightIn.value);
          if (Number(vatIn.value) > 0) entry.vat_rand = Number(vatIn.value);
          if (supplierIn.value.trim()) entry.supplier = supplierIn.value.trim();
          if (locSel.value !== "home") entry.location = locSel.value;
          entry.channel = channelSel.value;
          if (Number(targetIn.value) > 0) entry.target_price_rand = Number(targetIn.value);
          if (brandIn.value.trim()) entry.brand = brandIn.value.trim();
          if (barcodeIn.value.trim()) entry.barcode = barcodeIn.value.trim();
          if (imageIn.value.trim()) entry.image_url = imageIn.value.trim();
          if (docSel.value) entry.document_id = docSel.value;
          if (noteIn.value.trim()) entry.note = noteIn.value.trim();
          busAct(`receive ${sku}`, (doc) => {
            const bucket = (doc.stock ??= {});
            prunePush(bucket, "receipts", entry, 2);
          }, status,
            "✅ Sent — inventory, Books rows and the movement land within " +
            "~30s while 'serve' is up; a new SKU appears here on the next " +
            "publish.");
        },
      }, "Receive"),
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
  const roadUnits = m.transit.reduce((s, t) => s + t.remaining, 0);
  const roadValue = m.transit.reduce((s, t) => s + (t.cost || 0)
    * (t.quantity ? t.remaining / t.quantity : 1), 0);
  const sellable = m.rows.filter((r) => r.live)
    .reduce((s, r) => s + Math.max(r.available, 0), 0);
  const committedUnits = m.rows.reduce((s, r) => s + r.mfnOpen + r.dcOwed + r.returns, 0);
  const idleUnits = m.rows.filter((r) => r.group === "idle").reduce((s, r) => s + r.onHand, 0);
  const idleSkus = m.rows.filter((r) => r.group === "idle").length;
  const restock = m.rows.filter((r) => r.group === "restock");
  const alerts = restock.length + m.account_low.length;

  root.append(deskHead("Stock",
    `${skus} stocked SKU${skus === 1 ? "" : "s"} of ${((S.buyer || {}).products || []).length} winners · ` +
    "priority-sorted: what needs you floats to the top · landed-cost " +
    "estimates until actuals post"));

  const bases = new Set(m.rows.filter((r) => r.value > 0)
    .map((r) => r.basis).filter(Boolean));
  const basisWord = bases.size === 1 && bases.has("actual") ? "actuals"
    : bases.has("actual") || bases.has("mixed") ? "part actuals" : "estimate";
  root.append(el("div", { class: "kpis" },
    kpi("On hand", el("span", {}, fmtNum(units), " ",
      el("span", { style: "font-size:14px;color:var(--ink2);font-weight:600" }, "units")),
      `${skus} SKUs · ${fmtR(m.totals.value_rand || 0)} landed (${basisWord})`),
    kpi("On the road", el("span", {}, fmtNum(roadUnits), " ",
      el("span", { style: "font-size:14px;color:var(--ink2);font-weight:600" }, "inbound")),
      `${fmtR(roadValue)} committed · ${m.transit.length} shipment${m.transit.length === 1 ? "" : "s"}`),
    kpi("Sellable now", el("span", {}, fmtNum(sellable), " ",
      el("span", { style: "font-size:14px;color:var(--ink2);font-weight:600" }, `of ${fmtNum(units)}`)),
      [committedUnits ? `${committedUnits} committed — open orders, DC debt, returns` : null,
       idleUnits ? `${idleUnits} units idle across ${idleSkus} SKU${idleSkus === 1 ? "" : "s"} — no live listing` : null,
      ].filter(Boolean).join(" · ") || "everything on hand is listed"),
    kpi("Restock alerts",
      el("span", { class: alerts ? "v hot" : "" }, fmtNum(alerts)),
      alerts ? "below the reorder point — shortest runway floats to the top"
        : `nothing below the reorder point (${LEAD_TIME_DAYS}d lead + safety, net of inbound)`),
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
        `${t.title || t.asin || t.intent_id} ×${t.remaining}`),
      t.stalled
        ? el("span", { class: "st bad" }, `⚠ stalled ${Math.round((Date.now() - new Date(t.last_movement_at)) / 864e5)}d`)
        : el("span", { style: "color:var(--ink2);white-space:nowrap" },
            t.eta_at ? `ETA ${fmtDate(t.eta_at)}` : (t.state || "in transit"))));
    /* the waybill is what's printed on the box — the match key in hand */
    const bits = [];
    if ((t.tracking_refs || []).length) bits.push(`🏷 ${t.tracking_refs.join(" · ")}`);
    if (t.received_units) bits.push(`${t.received_units} of ${t.quantity} already in`);
    if (bits.length) {
      roadCell.append(el("div", {
        class: "flowrow",
        style: "border-top:0;padding-top:0;color:var(--ink2)",
      }, el("span", {}, bits.join(" · "))));
    }
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
  const dcOwedTotal = m.rows.reduce((s, r) => s + r.dcOwed, 0);
  const fbaRows = m.rows.filter((r) => (r.locs || {}).fba > 0);
  const fbaUnits = fbaRows.reduce((s, r) => s + r.locs.fba, 0);
  const channelCol = el("div", { style: "flex:1.05;display:flex;flex-direction:column;gap:8px;min-width:0" },
    el("div", { class: "flowcell", style: "flex:none" },
      el("div", { class: "fh" },
        el("div", { class: "ft" }, "🛒 Takealot"),
        el("div", { class: "fn" }, tkRows.length
          ? `${(m.account.counts || {}).buyable || 0} buyable of ${m.account.total || tkRows.length}`
          : "no offers")),
      dcOwedTotal
        ? el("div", { class: "flowrow" },
            el("span", { style: "font-weight:600" },
              `owes the DC ${dcOwedTotal} unit${dcOwedTotal === 1 ? "" : "s"}`),
            el("span", { class: "st bad" }, "🚚 3-day SLA"))
        : null,
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
        el("div", { class: "fn" }, m.fbaSyncedAt
          ? (fbaUnits ? `${fmtNum(fbaUnits)} u · ${fbaRows.length} SKU${fbaRows.length === 1 ? "" : "s"}` : "empty")
          : "not tracked yet")),
      el("div", { class: "fs", style: "margin:4px 0 0" },
        m.fbaSyncedAt
          ? `synced from the FBA Inventory API with each sales poll (last ${fmtAgo(m.fbaSyncedAt)})`
          : "FBA pool sync rides the sales poll — appears after the next serve restart")));

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
    right: el("span", {},
      "cover = available (on hand − committed) ÷ daily velocity · " +
      `reorder when position < ${LEAD_TIME_DAYS + SAFETY_STOCK_DAYS}d · `,
      el("a", { onclick: () => findParcelModal(m), style: "cursor:pointer" },
        "Find parcel…"),
      " · ",
      el("a", { onclick: () => receiveStockModal(m), style: "cursor:pointer" },
        "Receive stock…")),
  });
  tablePanel.dataset.focus = "stock-table";
  const groups = [
    ["restock", "Restock — below the reorder point, incl. inbound", "bad"],
    ["idle", "Idle — on hand but not selling", "warn"],
    ["transit", "In transit only — not yet on hand", "mute"],
    ["healthy", "Healthy", "ok"],
  ];
  const anyRows = m.rows.length > 0;
  if (!anyRows) {
    tablePanel.append(emptyLine(
      "No stock yet — “Mark received” on the Buy desk books AliExpress " +
      "arrivals in here, and “Receive stock…” (above) books anything " +
      "bought elsewhere."));
  } else {
    const table = el("table", { class: "grid" },
      el("tr", {},
        el("th", {}, "Product"), el("th", { class: "r" }, "Road"),
        el("th", { class: "r" }, "Home"), el("th", { class: "r" }, "Takealot"),
        el("th", { class: "r" }, "On hand"), el("th", { class: "r" }, "Avail"),
        el("th", { class: "r" }, "Value"),
        el("th", { class: "r" }, "Cover"), el("th", {}, "")));
    const wrap = el("div", { class: "scroll-x" });
    for (const [key, label, tone] of groups) {
      const rows = m.rows.filter((r) => r.group === key)
        .sort((x, y) => (x.positionDays ?? x.coverDays ?? 1e9)
          - (y.positionDays ?? y.coverDays ?? 1e9));
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
      for (const r of rows) gtable.append(stockRow(r, m));
      wrap.append(gtable);
    }
    tablePanel.append(wrap);
  }
  tablePanel.append(el("div", { class: "hint", style: "margin-top:8px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap" },
    el("span", {}, `${fmtNum(units)} units on hand · ${fmtR(m.totals.value_rand || 0)} landed (${basisWord})`),
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
                   moved: ["🔀", "Moved"], write_off: ["🗑", "Write-off"],
                   returned: ["↩️", "Returned"], adjust: ["🧮", "Adjusted"] };
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
        : mv.kind === "returned" ? `sold ↩ ${mv.to || "returns"}`
        : mv.kind === "adjust" ? (mv.to ? `count +→ ${mv.to}` : `count −→ ${mv.from || "?"}`)
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

  renderSendAdvisor(root, m);
  renderCourierPanel(root, m);
}

/* ----- send-advisor: what should leave the house, and why -----
   One row per stocked LIVE SKU and channel. Amazon: send everything
   sellable — FBA is free until 31 Mar 2027 and inbound is 90% off until
   31 Dec 2026, so home units earn nothing that the FC pool wouldn't.
   Takealot: bounded by the portal's max sendable (a per-SKU number that
   exists ONLY on the portal booking screen — typed here once, remembered
   server-side) and by ~35 days of cover (storage is free below 35d).
   The suggestion is ADVISORY: packed quantities come from the PO the
   portal booking issues, never from this panel. */
/* Takealot runs THREE replenishment DCs and the SLA wants stock in all
   of them (a customer order from a DC you didn't stock = Auto-IBT,
   R20+/unit ex VAT). House rule: ≈70% JHB / 30% CPT by demand weight —
   rebalance here (and add takealot_dbn a share) once its address lands. */
const TAKEALOT_DC_SPLIT = [["takealot_jhb", 0.7], ["takealot_cpt", 0.3]];
/* MIN-LANE RULE (Andrew 2026-08-07): a lane only earns its own parcel
   when its share of the send comes to at least this many whole units —
   a 1-unit box to CPT beside a 4-unit box to JHB pays a second courier
   fee to dodge an R20/unit Auto-IBT, which never pays off. Sends below
   the bar ride whole to the primary DC; with 70/30 the CPT leg reaches
   5 units at a 17-unit send, so splitting starts there. */
const TAKEALOT_MIN_LANE_UNITS = 5;

function sendAdvice(m) {
  const dests = (m.courier || {}).destinations || [];
  const destFor = (channel) => {
    const lanes = dests.filter((d) => d.channel === channel);
    return lanes.find((d) => d.ready) || lanes[0] || null;
  };
  const advice = [];
  for (const r of m.rows) {
    const home = (r.locs || {}).home || 0;
    const p = r.product;
    if (home <= 0 || !p) continue;
    /* what could leave: home units not spoken for by open MFN orders
       or boxes sitting in returns */
    const sendable = Math.max(0, Math.min(home, r.available));

    /* Takealot first — it's the demand-gated channel, so it claims its
       bounded allocation and Amazon gets the remainder (a SKU live on
       both channels must not be told "send everything" twice). */
    let takealotQty = 0;
    if (p.takealot && p.takealot.state === "live") {
      const daily = r.velocity ? r.velocity / 30 : null;
      const atDc = Math.max(r.tkl || 0, 0);
      let qty = sendable;
      const why = [];
      if (daily) {
        const coverTarget = Math.max(0, Math.ceil(daily * 35) - atDc);
        qty = Math.min(qty, coverTarget);
        why.push(`35d cover ≈ ${Math.ceil(daily * 35)}u minus ${atDc} ` +
          "at the DC (storage free ≤35d cover)");
      } else {
        why.push("no sales history yet — storage free ≤35d cover, start small");
      }
      if (r.maxSendable != null) {
        qty = Math.min(qty, r.maxSendable);
        why.push(`portal max sendable ${r.maxSendable}`);
      } else {
        qty = Math.min(qty, 5);
        why.push("portal max unknown — new offers usually cap at 5; " +
          "type it in from the portal booking screen");
      }
      takealotQty = qty;
      /* split across the DCs the house rule names; a lane without a
         confirmed address drops out and its share folds into the rest,
         and so does a lane whose share would land under the min-lane
         bar (smallest share folds first; the fold can cascade) */
      let lanes = TAKEALOT_DC_SPLIT
        .map(([key, share]) => ({ dest: dests.find((d) => d.key === key), share }))
        .filter((x) => x.dest && x.dest.ready)
        .sort((a, b) => b.share - a.share);
      let splitFrom = null; // send size at which the folded lane returns
      while (lanes.length > 1) {
        const total = lanes.reduce((s, x) => s + x.share, 0);
        const tail = lanes[lanes.length - 1];
        if (qty * (tail.share / total) >= TAKEALOT_MIN_LANE_UNITS) break;
        splitFrom = Math.ceil(TAKEALOT_MIN_LANE_UNITS * total / tail.share);
        lanes = lanes.slice(0, -1);
      }
      if (lanes.length >= 2) {
        const total = lanes.reduce((s, x) => s + x.share, 0);
        let left = qty;
        lanes.forEach((lane, i) => {
          const part = i === lanes.length - 1
            ? left : Math.round(qty * lane.share / total);
          left -= part;
          if (part > 0) {
            advice.push({
              r, channel: "takealot", dest: lane.dest, qty: part,
              why: `≈${Math.round(lane.share * 100)}% of ${qty} — the SLA ` +
                "wants every DC stocked (Auto-IBT R20+/unit otherwise) · " +
                why.join(" · "),
              askMax: i === 0,
            });
          }
        });
      } else {
        const solo = (lanes[0] || {}).dest || destFor("takealot");
        advice.push({
          r, channel: "takealot",
          qty,
          dest: solo,
          why: why.join(" · ")
            + (splitFrom
               ? ` · all to ${solo ? solo.label : "one DC"} — below ` +
                 `${splitFrom}u a split leg would carry under ` +
                 `${TAKEALOT_MIN_LANE_UNITS} units and the extra courier ` +
                 "fee beats the Auto-IBT saving"
               : (lanes.length < 2 && TAKEALOT_DC_SPLIT.length >= 2
                  ? " · single DC only — confirm the other DC's address to split 70/30"
                  : "")),
          askMax: true,
        });
      }
    }

    if (p.listing && p.listing.state === "live") {
      const qty = Math.max(0, sendable - takealotQty);
      if (qty > 0) {
        advice.push({
          r, channel: "amazon", dest: destFor("amazon"), qty,
          why: "FBA free until 31 Mar 2027, inbound 90% off — send " +
            "everything sellable" +
            (takealotQty ? ` after Takealot's ${takealotQty}` : "") +
            (r.mfnOpen ? ` (${r.mfnOpen} held for open MFN orders)` : "") +
            (r.returns ? ` (${r.returns} in returns held back)` : ""),
        });
      }
    }
  }
  return advice;
}

function maxSendableInput(r, status) {
  const input = el("input", {
    type: "number", class: "in", min: "0", max: "9999",
    style: "width:70px", placeholder: "max",
    value: r.maxSendable != null ? String(r.maxSendable) : "",
  });
  const save = el("button", {
    class: "b sm line",
    onclick: () => withToken(() => {
      const raw = input.value.trim();
      const value = raw === "" ? null : Math.round(Number(raw));
      if (value != null && !(value >= 0 && value <= 9999)) {
        if (status) status.textContent = "Max sendable must be 0–9999.";
        return;
      }
      busAct(`max sendable ${r.asin}`, (doc) => {
        const bucket = (doc.stock ??= {});
        prunePush(bucket, "max_sendable", {
          asin: r.asin, value, requested_at: new Date().toISOString(),
        }, 2);
      }, status,
        "✅ Saved — the advisor and the booking clamp pick it up on the " +
        "next publish (~30s while 'serve' is up).");
    }),
  }, "Save");
  return el("span", { style: "white-space:nowrap" },
    input, " ", save);
}

function renderSendAdvisor(root, m) {
  const advice = sendAdvice(m);
  if (!advice.length) return; // nothing stocked + live — no advice to give
  const panel = panelEl("Send to warehouse — advisor", {
    right: "suggestions only — the PO from the portal booking decides " +
      "what gets packed",
  });
  const status = statusLine();
  const groups = new Map();
  for (const a of advice) {
    const key = a.dest ? a.dest.key : `${a.channel}-none`;
    if (!groups.has(key)) groups.set(key, { dest: a.dest, channel: a.channel, rows: [] });
    groups.get(key).rows.push(a);
  }
  for (const g of groups.values()) {
    const label = g.dest ? g.dest.label
      : (g.channel === "amazon" ? "Amazon FC" : "Takealot DC");
    const bookable = g.rows.filter((a) => a.qty > 0);
    const units = bookable.reduce((s, a) => s + a.qty, 0);
    const head = el("div", { class: "groupline", style: "display:flex;align-items:center;gap:10px" },
      el("span", { style: "flex:1" },
        `${label} · ${bookable.length} SKU${bookable.length === 1 ? "" : "s"} · ${units} unit${units === 1 ? "" : "s"} suggested`),
      g.dest && g.dest.ready && units
        ? el("button", {
            class: "b sm pri",
            onclick: () => bookCourierModal(m, {
              dest: g.dest.key,
              items: bookable.map((a) => ({ asin: a.r.asin, quantity: a.qty })),
            }),
          }, "Book run…")
        : el("span", { class: "hint" },
            g.dest && !g.dest.ready ? "address unconfirmed — Edit destinations…"
            : units ? "" : "nothing to send"));
    panel.append(head);
    for (const a of g.rows) {
      panel.append(el("div", { class: "flowrow", style: "align-items:center" },
        el("span", { style: "flex:1;min-width:0" },
          el("span", { style: "font-weight:600" },
            `${a.r.title || a.r.asin} — send ${a.qty}`),
          el("span", { class: "rowsub", style: "display:block" }, a.why)),
        a.askMax ? maxSendableInput(a.r, status) : null));
    }
  }
  panel.append(status);
  root.append(panel);
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
/* The run's story at a glance: two ticks are hands-on (packed, labels
   — they persist server-side per run), the rest derive from fields the
   doc already carries. null = nothing to step (quotes, dead runs). */
function runSteps(s) {
  if (s.quote_only || ["error", "cancelled"].includes(s.status)) return null;
  const external = s.carrier === "external";
  const checks = s.checks || {};
  const preCollection = ["submitted", "collection-assigned",
                         "collection-unassigned", "external"].includes(s.status);
  const steps = [
    { key: "paper", label: s.fba_ref ? "FBA ref" : "PO",
      done: !!(s.po_number || s.fba_ref) },
    { key: "packed", label: "packed",
      done: !!(checks.packed || {}).done, manual: true },
    { key: "labels", label: "labels",
      done: !!(checks.labels || {}).done, manual: true },
  ];
  if (!external) {
    steps.push({ key: "collected", label: "collected", done: !preCollection });
  }
  steps.push(
    { key: "delivered", label: "delivered", done: s.status === "delivered" },
    { key: "checked", label: "checked in", done: !!s.movements_recorded_at });
  return steps;
}

function renderCourierPanel(root, m) {
  const c = m.courier;
  if (!c) return; // pre-upgrade payload — serve restart pending
  const extLink = el("a", {
    onclick: () => externalRunModal(m), style: "cursor:pointer",
  }, "External run…");
  const destLink = el("a", {
    onclick: () => editDestinationsModal(m), style: "cursor:pointer",
  }, "Destinations…");
  const right = !c.configured
    ? el("span", {}, el("span", { class: "st warn" }, "TCG_API_KEY not set"),
        " · ", extLink, " · ", destLink)
    : el("span", {},
        c.balance != null
          ? el("span", { class: c.low_balance ? "st bad" : "" },
              `prepaid ${fmtR(c.balance)}`)
          : "prepaid balance appears after the first poll",
        " · ",
        el("a", {
          onclick: () => bookCourierModal(m), style: "cursor:pointer",
        }, "Book courier…"),
        " · ", extLink, " · ", destLink);
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
      const what = (s.items || []).length
        ? s.items.map((i) => `${i.quantity}× ${i.asin}`).join(" + ")
        : s.asin ? `${s.quantity || 1}× ${s.asin}` : (s.note || "parcels");
      const sub = [];
      if (s.po_number) sub.push(`PO ${s.po_number}`);
      if (s.fba_ref) sub.push(`FBA ${s.fba_ref}`);
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
                 && s.carrier !== "external"
                 && !["cancelled", "error"].includes(s.status)) {
        actions.append(el("button", {
          class: "b sm line",
          onclick: () => courierAct(`label ${s.id}`,
            { id: s.id, relabel: true }),
        }, "Get label"));
      }
      if (s.carrier === "external" && s.status === "external") {
        actions.append(el("button", {
          class: "b sm pri", style: "margin-left:6px",
          onclick: () => courierAct(`delivered ${s.id}`,
            { id: s.id, delivered: true }),
        }, "Mark delivered"));
      }
      if (s.cancellable) {
        actions.append(el("button", {
          class: "b sm line", style: "margin-left:6px",
          onclick: () => courierAct(`cancel ${s.id}`,
            { id: s.id, cancel: true }),
        }, "Cancel"));
      }
      /* stepper: ☐ chips are the hands-on ticks — click to (un)tick */
      const steps = runSteps(s);
      let stepsLine = null;
      if (steps) {
        stepsLine = el("div", { class: "rowsub", style: "margin-top:3px" });
        steps.forEach((st, i) => {
          if (i) stepsLine.append(" › ");
          if (st.manual) {
            stepsLine.append(el("a", {
              style: "cursor:pointer" + (st.done ? "" : ";font-weight:600"),
              title: st.done ? "click to untick" : "click to tick",
              onclick: () => courierAct(
                `${st.label} ${st.done ? "untick" : "tick"} ${s.id}`,
                { id: s.id, check: st.key, done: !st.done }),
            }, `${st.done ? "✓" : "☐"} ${st.label}`));
          } else {
            stepsLine.append(el("span",
              { style: st.done ? "" : "color:var(--muted)" },
              `${st.done ? "✓" : "○"} ${st.label}`));
          }
        });
      }
      t.append(el("tr", {},
        el("td", { style: "white-space:nowrap;color:var(--ink2)" },
          fmtDate(s.booked_at || s.created_at)),
        el("td", { class: "t" },
          el("div", { class: "rowtitle" },
            `${s.quote_only ? "💬 quote" : s.carrier === "external" ? "🚛 TFS/ext" : "🚚"} ${s.dest_label || s.dest} — ${what}`),
          sub.length ? el("div", { class: "rowsub" }, sub.join(" · ")) : null,
          stepsLine),
        el("td", {}, chip),
        el("td", { class: "r" }, s.rate != null ? fmtR(s.rate)
          : el("span", { style: "color:var(--muted)" }, "—")),
        el("td", { class: "r" }, actions)));
    }
    panel.append(el("div", { class: "scroll-x" }, t));
  }
  panel.append(el("div", { class: "hint", style: "margin-top:8px" },
    "collection is next business day (LOF cutoff 14:00) · Takealot wants " +
    "the portal booking confirmed ≥48h before the due date · a delivered " +
    "run moves its whole manifest home → DC in the log automatically · " +
    "spend posts to Books (Freight & clearing) · eyeball the first live " +
    "waybill: the PO must show on it"));
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

/* Best known price for a lane: the newest quote or booking in the runs
   list that matches destination + service level. Quotes carry the whole
   rate card; bookings carry the one rate they paid. */
function courierEstimate(c, destKey, level) {
  for (const s of c.shipments || []) {
    if (s.dest !== destKey) continue;
    if (s.quote_only && (s.rates || []).length) {
      const o = s.rates.find((r) => r.code === level);
      if (o) return { rate: o.rate, at: s.created_at, from: "quote" };
    } else if (!s.quote_only && s.rate != null && s.service_level === level
               && s.status !== "error") {
      return { rate: s.rate, at: s.booked_at || s.created_at, from: "booking" };
    }
  }
  return null;
}

function bookCourierModal(m, prefill) {
  withToken(() => {
    const c = m.courier || {};
    const dests = (c.destinations || []);
    if (!dests.length) return;
    const modeSel = el("select", { class: "in" },
      el("option", { value: "quote", selected: "" }, "Quote only (free)"),
      el("option", { value: "book" }, "Book collection"));
    const preDest = prefill && prefill.dest;
    const destSel = el("select", { class: "in" },
      ...dests.map((d, i) => el("option", {
        value: d.key,
        ...((preDest ? d.key === preDest : i === 0) ? { selected: "" } : {}),
        ...(d.ready ? {} : { disabled: "" }),
      }, d.label + (d.ready ? "" : " — address unconfirmed"))));
    const destChannel = () =>
      (dests.find((x) => x.key === destSel.value) || {}).channel;
    const destNote = el("div", { class: "hint" });
    const syncNote = () => {
      const d = dests.find((x) => x.key === destSel.value);
      destNote.textContent = (d && d.note) ? `ℹ ${d.note}` : "";
    };
    destSel.addEventListener("change", syncNote);
    syncNote();
    const stocked = m.rows.filter((r) => (r.locs || {}).home > 0);

    /* Manifest: one row per SKU in the box(es). A mixed box is normal —
       every line lands its own stock movement on delivery. */
    const itemRows = [];
    const itemsBox = el("div", {});
    const readItems = () => itemRows
      .map((it) => ({ asin: it.sel.value,
                      quantity: Math.round(Number(it.qtyIn.value)) }))
      .filter((it) => it.asin && it.quantity >= 1);
    const addItem = (asin, qty) => {
      const sel = el("select", { class: "in" },
        el("option", { value: "" }, "— SKU —"),
        ...stocked.map((r) => el("option", {
          value: r.asin, ...(r.asin === asin ? { selected: "" } : {}),
        }, `${r.asin} (${r.locs.home} at home)`)));
      const qtyIn = el("input", {
        type: "number", class: "in", value: String(qty || 1),
        min: "1", max: "999", style: "width:70px",
      });
      const item = { sel, qtyIn };
      const row = el("div",
        { style: "display:flex;align-items:center;gap:10px;margin-top:8px" },
        sel, el("span", { class: "meta" }, "×"), qtyIn,
        el("a", {
          style: "cursor:pointer;color:var(--muted)",
          onclick: () => {
            row.remove();
            itemRows.splice(itemRows.indexOf(item), 1);
            syncManifest();
          },
        }, "✕"));
      itemRows.push(item);
      itemsBox.append(row);
      sel.addEventListener("change", syncManifest);
      qtyIn.addEventListener("input", syncManifest);
    };
    const manifestNote = el("div", { class: "hint" });
    /* Paperwork the receiving warehouse reads off the waybill — the DC
       bounces parcels without their PO; an FC box needs its FBA ref. */
    const poIn = el("input", {
      type: "text", class: "in", style: "flex:1",
      placeholder: "PO number — from the portal replenishment booking",
    });
    const fbaIn = el("input", {
      type: "text", class: "in", style: "flex:1", autocapitalize: "characters",
      placeholder: "FBA shipment ID — from Send-to-Amazon",
    });
    const poRow = el("div",
      { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
      el("span", { class: "meta", style: "min-width:70px" }, "PO"), poIn);
    const fbaRow = el("div",
      { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
      el("span", { class: "meta", style: "min-width:70px" }, "FBA ref"), fbaIn);
    /* Boxes: one row per physical parcel. Weight prefills from the
       catalog's shipped-package figures for whatever the manifest says
       is inside — typing any box figure takes over from the estimate. */
    const boxRows = [];
    const boxesBox = el("div", {});
    let boxesTouched = false;
    const addBox = (weight, dims) => {
      const weightIn = el("input", {
        type: "text", class: "in", value: weight || "2", style: "width:70px",
      });
      const dimsIn = (dims || ["30", "20", "15"]).map((v) =>
        el("input", { type: "text", class: "in", value: v, style: "width:56px" }));
      const box = { weightIn, dimsIn };
      const row = el("div",
        { style: "display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap" },
        weightIn, el("span", { class: "meta" }, "kg ·"),
        dimsIn[0], el("span", { class: "meta" }, "×"),
        dimsIn[1], el("span", { class: "meta" }, "×"),
        dimsIn[2], el("span", { class: "meta" }, "cm"),
        el("a", {
          style: "cursor:pointer;color:var(--muted)",
          onclick: () => {
            row.remove();
            boxRows.splice(boxRows.indexOf(box), 1);
            boxesTouched = true;
            syncManifest();
          },
        }, "✕"));
      weightIn.addEventListener("input", () => { boxesTouched = true; syncManifest(); });
      for (const d of dimsIn) d.addEventListener("input", () => { boxesTouched = true; });
      boxRows.push(box);
      boxesBox.append(row);
      return box;
    };
    const boxNote = el("div", { class: "hint" });
    const syncManifest = () => {
      const channel = destChannel();
      poRow.style.display = channel === "takealot" ? "flex" : "none";
      fbaRow.style.display = channel === "amazon" ? "flex" : "none";
      const items = readItems();
      const units = items.reduce((s, it) => s + it.quantity, 0);
      const over = items.filter((it) => {
        const r = stocked.find((x) => x.asin === it.asin);
        return r && it.quantity > r.locs.home;
      });
      const bits = [];
      if (units) bits.push(`${units} unit${units === 1 ? "" : "s"} across ${items.length} SKU${items.length === 1 ? "" : "s"}`);
      if (units >= 50 && channel === "takealot") {
        bits.push("⚠ Takealot wants <50 units per shipment — split the booking");
      }
      for (const it of over) bits.push(`⚠ ${it.asin}: only ${(stocked.find((x) => x.asin === it.asin) || { locs: {} }).locs.home} at home`);
      for (const it of clampBreaches(items, channel)) {
        bits.push(`⛔ ${it.asin}: portal max sendable is ${it.max} — the DC bounces the overage`);
      }
      manifestNote.textContent = bits.join(" · ");

      /* weight estimate off catalog package data */
      const withRow = items.map((it) => ({
        ...it, r: stocked.find((x) => x.asin === it.asin),
      }));
      const known = withRow.filter((it) => it.r && it.r.packageWeight);
      const est = known.reduce((s, it) => s + it.quantity * it.r.packageWeight, 0);
      const unknown = withRow.filter((it) => it.r && !it.r.packageWeight);
      if (!boxesTouched && boxRows.length === 1 && est > 0) {
        boxRows[0].weightIn.value = String(Math.min(Math.ceil(est * 10) / 10, 50));
        const dims = items.length === 1 && known.length === 1
          && known[0].quantity === 1 && known[0].r.packageDims;
        if (dims && dims.length && dims.width && dims.height) {
          boxRows[0].dimsIn[0].value = String(Math.ceil(dims.length));
          boxRows[0].dimsIn[1].value = String(Math.ceil(dims.width));
          boxRows[0].dimsIn[2].value = String(Math.ceil(dims.height));
        }
      }
      const boxBits = [];
      if (est > 0) {
        boxBits.push(`≈${Math.ceil(est * 10) / 10}kg packed (catalog package weights)`);
      }
      if (unknown.length) {
        boxBits.push(`no catalog weight for ${unknown.map((it) => it.asin).join(", ")} — weigh the box`);
      }
      if (est > 25) {
        boxBits.push(`⚠ over 25kg — pack ~${Math.ceil(est / 25)} boxes (+ add box)`);
      }
      const declared = boxRows.reduce((s, b) => s + (parseFloat(b.weightIn.value) || 0), 0);
      if (boxRows.some((b) => parseFloat(b.weightIn.value) > 25)) {
        boxBits.push("⚠ a box over 25kg is a two-person lift the DC may refuse");
      }
      if (est > 0 && declared > 0 && declared < est * 0.7) {
        boxBits.push(`⚠ boxes declare ${Math.ceil(declared * 10) / 10}kg vs ≈${Math.ceil(est * 10) / 10}kg estimated — under-declaring reprices at the hub`);
      }
      boxNote.textContent = boxBits.join(" · ");
    };
    /* The manifest CLAMPS to the portal limit: packed quantities come
       from the PO, and the PO can never exceed max sendable — a line
       over it is a mistyped manifest, not a judgement call. */
    const clampBreaches = (items, channel) => {
      if (channel !== "takealot") return [];
      return items.map((it) => {
        const r = stocked.find((x) => x.asin === it.asin);
        return r && r.maxSendable != null && it.quantity > r.maxSendable
          ? { asin: it.asin, max: r.maxSendable } : null;
      }).filter(Boolean);
    };
    destSel.addEventListener("change", syncManifest);
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

    /* Pre-flight: prepaid balance vs the lane's best-known price. Booking
       spends the prepaid account, and TCG just fails opaquely when it's
       short (R50 on the account vs R117 LOF is the live trap) — so the
       modal does the arithmetic up front and refuses to arm Send. */
    const preflight = el("div", { class: "note", style: "margin-top:12px" });
    const sendBtn = el("button", {
      class: "b pri wide", style: "margin-top:12px",
    }, "Send");
    const syncPreflight = () => {
      const booking = modeSel.value === "book";
      sendBtn.removeAttribute("disabled");
      preflight.className = "note";
      if (!booking) {
        preflight.textContent =
          "💬 Quotes are free — no prepaid balance needed.";
        return;
      }
      const est = courierEstimate(c, destSel.value, levelSel.value);
      const estText = est
        ? `~${fmtR(est.rate)} (last ${levelSel.value} ${est.from} ` +
          `${fmtAgo(est.at)})`
        : null;
      const cap = parseFloat(capIn.value);
      // No estimate for the lane yet → the cap is the spend ceiling.
      const needed = est ? est.rate : (cap > 0 ? cap : null);
      if (c.balance == null) {
        preflight.className = "note warn";
        preflight.textContent =
          "⚠ Prepaid balance unknown (first poll pending) — TCG refuses " +
          "the booking if the account is short." +
          (estText ? ` Lane estimate ${estText}.` : "");
        return;
      }
      if (needed != null && needed > c.balance) {
        preflight.className = "note warn";
        preflight.replaceChildren(
          el("b", {}, `⛔ Prepaid balance ${fmtR(c.balance)} is short: `),
          est
            ? `this lane last cost ${estText}. Top up in the TCG portal ` +
              "first — or send a free quote to check the current price."
            : `your ${fmtR(cap)} cap exceeds it, so a booking up to the ` +
              "cap can fail at TCG. Top up first, or quote (free) to " +
              "learn the lane price.");
        sendBtn.setAttribute("disabled", "");
        return;
      }
      preflight.textContent =
        `✓ Prepaid ${fmtR(c.balance)} covers ` +
        (estText ? `the ${estText} estimate` : `your ${fmtR(cap)} cap`) +
        " — the booking still refuses over-cap prices at quote time.";
    };
    modeSel.addEventListener("change", () => {
      bookRows.style.display = modeSel.value === "book" ? "" : "none";
      syncPreflight();
    });
    destSel.addEventListener("change", syncPreflight);
    levelSel.addEventListener("change", syncPreflight);
    capIn.addEventListener("input", syncPreflight);
    syncPreflight();
    for (const it of (prefill && prefill.items) || []) {
      addItem(it.asin, it.quantity);
    }
    if (!itemRows.length) addItem();
    addBox();
    syncManifest();
    const status = statusLine();
    sendBtn.addEventListener("click", () => {
      const booking = modeSel.value === "book";
      const parcels = boxRows.map((b) => ({
        weight_kg: parseFloat(b.weightIn.value),
        length_cm: parseFloat(b.dimsIn[0].value) || undefined,
        width_cm: parseFloat(b.dimsIn[1].value) || undefined,
        height_cm: parseFloat(b.dimsIn[2].value) || undefined,
      }));
      if (!parcels.length
          || parcels.some((p) => !(p.weight_kg > 0 && p.weight_kg <= 50))) {
        status.textContent = "Every box needs a weight between 0 and 50 kg.";
        return;
      }
      const channel = destChannel();
      const items = readItems();
      if (booking && channel === "takealot" && !poIn.value.trim()) {
        status.textContent = "Takealot DC runs need the PO number — the DC " +
          "bounces parcels whose waybill doesn't carry it.";
        return;
      }
      if (booking && channel === "amazon" && !fbaIn.value.trim()) {
        status.textContent = "Amazon FC runs need the FBA shipment ID from " +
          "Send-to-Amazon as the waybill reference.";
        return;
      }
      const breaches = clampBreaches(items, channel);
      if (booking && breaches.length) {
        status.textContent = `${breaches[0].asin} exceeds the portal max ` +
          `sendable (${breaches[0].max}) — pack what the PO says, or ` +
          "update the max if the portal moved it.";
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
        parcels,
        items: items.length ? items : undefined,
        po_number: poIn.value.trim() || undefined,
        fba_ref: fbaIn.value.trim().toUpperCase() || undefined,
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
    });
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
      el("div", { style: "display:flex;align-items:flex-start;gap:10px;margin-top:10px" },
        el("span", { class: "meta", style: "min-width:70px;margin-top:8px" }, "manifest"),
        el("div", { style: "flex:1" },
          itemsBox,
          el("a", {
            style: "cursor:pointer;display:inline-block;margin-top:8px",
            onclick: () => { addItem(); syncManifest(); },
          }, "+ add SKU"),
          manifestNote)),
      poRow,
      fbaRow,
      el("div", { style: "display:flex;align-items:flex-start;gap:10px;margin-top:10px" },
        el("span", { class: "meta", style: "min-width:70px;margin-top:8px" }, "boxes"),
        el("div", { style: "flex:1" },
          boxesBox,
          el("a", {
            style: "cursor:pointer;display:inline-block;margin-top:8px",
            onclick: () => { boxesTouched = true; addBox(); syncManifest(); },
          }, "+ add box"),
          boxNote)),
      bookRows,
      noteIn,
      preflight,
      sendBtn,
      el("button", {
        class: "b wide", style: "margin-top:8px",
        onclick: () => modalEl().close(),
      }, "Cancel"),
      status);
  });
}

/* External run: a collection booked OUTSIDE the API — the TFS portal
   beats TCG 35–50% on Takealot lanes but is portal-only, and a run the
   desk can't see is a run whose movements and cost silently vanish.
   Records the manifest + typed cost (posts to Books immediately — the
   portal already charged it); "Mark delivered" on the runs list moves
   the stock when it lands. */
function externalRunModal(m) {
  withToken(() => {
    const c = m.courier || {};
    const dests = c.destinations || [];
    if (!dests.length) return;
    const destSel = el("select", { class: "in" },
      ...dests.map((d, i) => el("option", {
        value: d.key, ...(i === 0 ? { selected: "" } : {}),
      }, d.label)));
    const destChannel = () =>
      (dests.find((x) => x.key === destSel.value) || {}).channel;
    const stocked = m.rows.filter((r) => (r.locs || {}).home > 0);
    const itemRows = [];
    const itemsBox = el("div", {});
    const addItem = () => {
      const sel = el("select", { class: "in" },
        el("option", { value: "" }, "— SKU —"),
        ...stocked.map((r) => el("option", { value: r.asin },
          `${r.asin} (${r.locs.home} at home)`)));
      const qtyIn = el("input", {
        type: "number", class: "in", value: "1", min: "1", max: "999",
        style: "width:70px",
      });
      const item = { sel, qtyIn };
      const row = el("div",
        { style: "display:flex;align-items:center;gap:10px;margin-top:8px" },
        sel, el("span", { class: "meta" }, "×"), qtyIn,
        el("a", {
          style: "cursor:pointer;color:var(--muted)",
          onclick: () => {
            row.remove();
            itemRows.splice(itemRows.indexOf(item), 1);
          },
        }, "✕"));
      itemRows.push(item);
      itemsBox.append(row);
    };
    addItem();
    const costIn = el("input", {
      type: "number", class: "in", min: "0", step: "0.01",
      placeholder: "cost R", style: "width:110px",
    });
    const refIn = el("input", {
      type: "text", class: "in", style: "flex:1",
      placeholder: "waybill / booking ref (opt)",
    });
    const poIn = el("input", {
      type: "text", class: "in", style: "flex:1",
      placeholder: "PO number — from the portal replenishment booking",
    });
    const fbaIn = el("input", {
      type: "text", class: "in", style: "flex:1", autocapitalize: "characters",
      placeholder: "FBA shipment ID — from Send-to-Amazon",
    });
    const poRow = el("div",
      { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
      el("span", { class: "meta", style: "min-width:70px" }, "PO"), poIn);
    const fbaRow = el("div",
      { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
      el("span", { class: "meta", style: "min-width:70px" }, "FBA ref"), fbaIn);
    const syncPaper = () => {
      const channel = destChannel();
      poRow.style.display = channel === "takealot" ? "flex" : "none";
      fbaRow.style.display = channel === "amazon" ? "flex" : "none";
    };
    destSel.addEventListener("change", syncPaper);
    syncPaper();
    const noteIn = el("input", {
      type: "text", class: "in wide", style: "margin-top:10px",
      placeholder: "note (opt) — e.g. TFS Courier, booked 28 Jul",
    });
    const status = statusLine();
    openModal(
      el("h3", {}, "External run — booked outside the API"),
      el("p", { class: "meta" },
        "For TFS-portal (or any hand-booked) collections: nothing books " +
        "here — this records the run so the manifest's stock movements " +
        "and the cost still land. The cost posts to Books now; press " +
        "Mark delivered on the runs list when the DC signs for it."),
      el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
        el("span", { class: "meta", style: "min-width:70px" }, "to"), destSel),
      el("div", { style: "display:flex;align-items:flex-start;gap:10px;margin-top:10px" },
        el("span", { class: "meta", style: "min-width:70px;margin-top:8px" }, "manifest"),
        el("div", { style: "flex:1" },
          itemsBox,
          el("a", {
            style: "cursor:pointer;display:inline-block;margin-top:8px",
            onclick: () => addItem(),
          }, "+ add SKU"))),
      poRow,
      fbaRow,
      el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
        el("span", { class: "meta", style: "min-width:70px" }, "paid"), costIn,
        el("span", { class: "meta" }, "R ·"), refIn),
      noteIn,
      el("button", {
        class: "b pri wide", style: "margin-top:12px",
        onclick: () => {
          const items = itemRows
            .map((it) => ({ asin: it.sel.value,
                            quantity: Math.round(Number(it.qtyIn.value)) }))
            .filter((it) => it.asin && it.quantity >= 1);
          if (!items.length) {
            status.textContent = "Pick at least one SKU — the movements " +
              "are the point of recording the run.";
            return;
          }
          const entry = {
            external: true,
            dest: destSel.value,
            items,
            cost_rand: Number(costIn.value) > 0 ? Number(costIn.value) : undefined,
            tracking_ref: refIn.value.trim() || undefined,
            po_number: poIn.value.trim() || undefined,
            fba_ref: fbaIn.value.trim().toUpperCase() || undefined,
            note: noteIn.value.trim() || undefined,
            requested_at: new Date().toISOString(),
          };
          busAct("record external run", (doc) => {
            const bucket = (doc.courier ??= {});
            prunePush(bucket, "requests", entry, 2);
          }, status,
            "✅ Sent — the run shows in the list within ~30s while 'serve' " +
            "is up; Mark delivered moves the stock when it lands.");
        },
      }, "Record run"),
      el("button", {
        class: "b wide", style: "margin-top:8px",
        onclick: () => modalEl().close(),
      }, "Cancel"),
      status);
  });
}

/* Destinations editor: the registry is code+env, but an address that
   only arrives mid-flow (Amazon reveals the FC inside Send-to-Amazon)
   used to need a .env edit + serve restart. Desk edits land in Mongo
   and win over both; Reset drops the edit so the registry shows through. */
function editDestinationsModal(m) {
  withToken(() => {
    const dests = (m.courier || {}).destinations || [];
    if (!dests.length) return;
    const destSel = el("select", { class: "in" },
      ...dests.map((d, i) => el("option", {
        value: d.key, ...(i === 0 ? { selected: "" } : {}),
      }, `${d.label}${d.ready ? "" : " — not bookable"}${d.overridden ? " · desk-edited" : ""}`)));
    const fields = [
      ["label", "label"], ["company", "company"],
      ["street_address", "street"], ["local_area", "suburb"],
      ["city", "city"], ["zone", "province"], ["code", "postal code"],
      ["note", "note"],
    ];
    const inputs = {};
    const rows = fields.map(([key, label]) => {
      inputs[key] = el("input", {
        type: "text", class: "in", style: "flex:1", placeholder: label,
      });
      return el("div",
        { style: "display:flex;align-items:center;gap:10px;margin-top:8px" },
        el("span", { class: "meta", style: "min-width:90px" }, label),
        inputs[key]);
    });
    const readyNote = el("div", { class: "hint", style: "margin-top:6px" });
    const fill = () => {
      const d = dests.find((x) => x.key === destSel.value) || {};
      for (const [key] of fields) inputs[key].value = d[key] || "";
      readyNote.textContent = d.ready
        ? "✓ bookable — street + postal code on file"
        : "not bookable yet — a street address and postal code make it so";
    };
    destSel.addEventListener("change", fill);
    fill();
    const status = statusLine();
    const send = (entry, label, done) => busAct(label, (doc) => {
      const bucket = (doc.courier ??= {});
      prunePush(bucket, "destinations", entry, 2);
    }, status, done);
    openModal(
      el("h3", {}, "Destinations — where runs can go"),
      el("p", { class: "meta" },
        "Saved edits apply within ~30s while 'serve' is up and win over " +
        "the built-in registry and .env — no restart, mid-flow is fine. " +
        "Check the address against the courier portal's pre-added entry " +
        "before the first booking to a new one."),
      el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
        el("span", { class: "meta", style: "min-width:90px" }, "destination"),
        destSel),
      ...rows,
      readyNote,
      el("button", {
        class: "b pri wide", style: "margin-top:12px",
        onclick: () => {
          const entry = { key: destSel.value,
                          requested_at: new Date().toISOString() };
          for (const [key] of fields) {
            const value = inputs[key].value.trim();
            if (value) entry[key] = value;
          }
          send(entry, `destination ${destSel.value}`,
            "✅ Saved — applies within ~30s; re-open this dialog after the " +
            "next publish to see it echoed back.");
        },
      }, "Save destination"),
      el("button", {
        class: "b wide", style: "margin-top:8px",
        onclick: () => send(
          { key: destSel.value, reset: true,
            requested_at: new Date().toISOString() },
          `reset destination ${destSel.value}`,
          "✅ Reset sent — the built-in/.env registry value shows through " +
          "after the next publish."),
      }, "Reset to registry"),
      el("button", {
        class: "b wide", style: "margin-top:8px",
        onclick: () => modalEl().close(),
      }, "Close"),
      status);
  });
}

/* In-transit → on-hand from the Stock desk: the Road units behind a row
   are order intents, so receiving rides the Buy desk's markReceivedModal
   (same bus command — books inventory, closes tracking, posts COGS).
   Several parcels for one SKU need a pick first; the app has ONE modal
   dialog, so the picker must close before the receipt modal opens. */
function receiveInboundModal(r, inbound) {
  const toOrder = (t) => ({ id: t.intent_id,
                            quantity: t.remaining || t.quantity,
                            ordered: t.quantity,
                            received: t.received_units || 0,
                            ae_order_ids: t.ae_order_ids || [],
                            tracking_refs: t.tracking_refs || [] });
  if (inbound.length === 1) { markReceivedModal(r.product, toOrder(inbound[0])); return; }
  withToken(() => {
    openModal(
      el("h3", {}, "Which parcel arrived?"),
      el("p", { class: "meta", style: "margin-top:8px" },
        `${r.title} has ${inbound.length} shipments on the road — receive ` +
        "the one in your hands; the rest stay in transit."),
      ...inbound.map((t) => el("div",
        { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
        el("span", { class: "meta", style: "flex:1;min-width:0" },
          (t.tracking_refs || []).length
            ? el("span", { style: "font-weight:650;color:var(--ink)" },
                `🏷 ${t.tracking_refs.join(", ")} · `)
            : null,
          `×${t.remaining}` +
          (t.received_units ? ` (${t.received_units} of ${t.quantity} in)` : "") +
          (t.eta_at ? ` · ETA ${fmtDate(t.eta_at)}` : "") +
          ((t.ae_order_ids || []).length ? ` · AE ${t.ae_order_ids.join(", ")}` : "")),
        el("button", {
          class: "b sm pri",
          onclick: () => { modalEl().close(); markReceivedModal(r.product, toOrder(t)); },
        }, "Mark received…"))),
      el("button", { class: "b wide", style: "margin-top:14px",
        onclick: () => modalEl().close() }, "Cancel"));
  });
}

/* Parcel-first receiving — the label in your hand finds its product.
   Type any part of the waybill (ZA000375450R), AE order or title, or
   photograph the label: its barcode IS the waybill, and the browser's
   built-in BarcodeDetector reads the still photo — no upload, no server,
   no OCR bill. The typed/tapped list is always there as the manual
   fallback (and the only path where BarcodeDetector is unsupported). */
function findParcelModal(m) {
  withToken(() => {
    const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const parcels = m.transit.map((t) => ({
      t,
      hay: [...(t.tracking_refs || []), ...(t.ae_order_ids || []),
            t.asin, t.title, t.intent_id].map(norm).filter(Boolean).join(" "),
    }));
    const input = el("input", {
      class: "in", style: "flex:1",
      placeholder: "waybill / AE order / product",
    });
    const list = el("div", {});
    const status = statusLine();
    const receive = (t) => {
      modalEl().close();
      markReceivedModal((t.row || {}).product || null, {
        id: t.intent_id, quantity: t.remaining || t.quantity,
        ordered: t.quantity, received: t.received_units || 0,
        ae_order_ids: t.ae_order_ids || [],
        tracking_refs: t.tracking_refs || [],
      });
    };
    const draw = () => {
      const q = norm(input.value);
      const hits = q ? parcels.filter((p) => p.hay.includes(q)) : parcels;
      list.replaceChildren();
      if (!parcels.length) {
        list.append(el("p", { class: "meta", style: "margin-top:12px" },
          "Nothing on the road — arrivals bought elsewhere book in via " +
          "Receive stock…"));
      } else if (!hits.length) {
        list.append(el("p", { class: "meta", style: "margin-top:12px" },
          "No inbound parcel matches that — it may already be received, " +
          "or the tracking poll hasn't seen its waybill yet."));
      }
      for (const { t } of hits) {
        list.append(el("div",
          { style: "display:flex;align-items:center;gap:10px;margin-top:10px" },
          el("span", { class: "meta", style: "flex:1;min-width:0" },
            el("span", { style: "font-weight:650;color:var(--ink)" },
              (t.tracking_refs || []).length
                ? `🏷 ${t.tracking_refs.join(", ")}`
                : "🏷 no waybill yet"),
            el("br", {}),
            `${t.title || t.asin || t.intent_id} ×${t.remaining}` +
            (t.received_units ? ` (${t.received_units} of ${t.quantity} in)` : "") +
            (t.eta_at ? ` · ETA ${fmtDate(t.eta_at)}` : "") +
            ((t.ae_order_ids || []).length ? ` · AE ${t.ae_order_ids.join(", ")}` : "")),
          el("button", { class: "b sm pri", onclick: () => receive(t) },
            "Mark received…")));
      }
      return hits.length;
    };
    input.addEventListener("input", draw);

    /* Photo path: <input capture> opens the camera straight from the
       browser (Android Chrome); ignore sub-6-char codes — labels carry
       small hub/routing barcodes that would substring-match everything. */
    const snap = el("input", { type: "file", accept: "image/*",
                               capture: "environment", style: "display:none" });
    let scanBtn = null;
    if ("BarcodeDetector" in window) {
      scanBtn = el("button", { class: "b sm line", style: "white-space:nowrap" },
        "📷 Scan label");
      scanBtn.addEventListener("click", () => { snap.value = ""; snap.click(); });
      snap.addEventListener("change", async () => {
        const file = snap.files && snap.files[0];
        if (!file) return;
        status.textContent = "Reading barcodes…";
        try {
          const bitmap = await createImageBitmap(file);
          const codes = await new BarcodeDetector().detect(bitmap);
          const values = [...new Set(codes.map((c) => norm(c.rawValue)))]
            .filter((v) => v.length >= 6);
          if (!values.length) {
            status.textContent = "No barcode readable — try closer and " +
              "flatter, or type the reference off the label.";
            return;
          }
          /* one label carries several codes (waybill, AE order, customs);
             a scanned code can also be longer than the stored ref */
          const hit = values.find((v) => parcels.some((p) => p.hay.includes(v)))
            || values.find((v) => parcels.some((p) => p.hay.split(" ")
              .some((h) => h.length >= 6 && v.includes(h))));
          input.value = hit || values[0];
          const n = draw();
          status.textContent = n
            ? `Scanned ${values.join(", ")} — ${n === 1
                ? "that's the parcel below."
                : `${n} possible parcels below.`}`
            : `Scanned ${values.join(", ")} — no inbound parcel matches.`;
        } catch (e) {
          status.textContent = `Scan failed: ${e.message} — type the reference instead.`;
        }
      });
    }

    draw();
    openModal(
      el("h3", {}, "Find parcel — receive by label"),
      el("p", { class: "meta", style: "margin-top:8px" },
        "Match the box in your hand: type any part of the waybill on the " +
        "label" + (scanBtn ? ", or photograph its barcode" : "") +
        " — Mark received books it in."),
      el("div", { style: "display:flex;align-items:center;gap:8px;margin-top:12px" },
        input, scanBtn, snap),
      list,
      status,
      el("button", { class: "b wide", style: "margin-top:14px",
        onclick: () => modalEl().close() }, "Close"));
  });
}

function stockRow(r, m) {
  const p = r.product;
  const inbound = r.road > 0
    ? m.transit.filter((t) => t.asin === r.asin) : [];
  let cover;
  if (r.coverDays != null) {
    cover = r.coverDays < 1 ? el("span", { class: "st bad" }, "<1d 🔴")
      : r.coverDays <= 7 ? el("span", { class: "st hot" }, `~${Math.round(r.coverDays)}d`)
      : el("span", { style: "color:var(--ink2)" }, `~${Math.round(r.coverDays)}d`);
  } else if (r.onHand === 0 && r.road > 0) {
    cover = el("span", { style: "color:var(--ink2)" }, "in transit");
  } else if (r.onHand > 0 && r.available <= 0) {
    cover = el("span", { class: "st bad" }, "committed");
  } else {
    cover = el("span", { style: "color:var(--muted)" }, "—");
  }
  let action = el("span", {});
  if (r.group === "restock" && r.manual) {
    /* Manual/wholesale stock has no AliExpress intent to reorder through
       — restocking means phoning the supplier and Receive stock… again. */
    action = el("span", { class: "hint" },
      `reorder from ${r.supplier || "supplier"}`);
  } else if (r.group === "restock" && p) {
    action = el("button", { class: "b sm pri", onclick: () => openOrderModal(p) }, "Reorder");
  } else if (r.group === "idle" && p) {
    action = el("button", {
      class: "b sm line",
      onclick: () => setDesk("sell", {
        sellTab: p.channel === "takealot" ? "takealot" : "amazon",
        focus: r.asin,
      }),
    }, "Queue listing →");
  } else if (r.group === "transit") {
    action = inbound.length
      ? el("button", { class: "b sm pri",
          onclick: () => receiveInboundModal(r, inbound) },
          inbound.length > 1 ? `Mark received (${inbound.length})` : "Mark received")
      : el("span", { class: "hint" }, "🚚 in transit");
  }
  const sub = [];
  /* Waybills of everything inbound for this SKU — the reference on the
     parcel label (ZA…R), so a box in hand matches its row at a glance. */
  const refs = inbound.flatMap((t) => t.tracking_refs || []);
  if (refs.length) sub.push(`🏷 ${refs.join(" · ")}`);
  if (r.manual) sub.push(`📦 manual stock${r.supplier ? ` — ${r.supplier}` : ""}`);
  if (r.velocity != null) sub.push(`sells ≈${fmtNum(Math.round(r.velocity))}/mo`);
  if (r.group === "restock" && r.suggestQty) {
    sub.push(`order ≈${r.suggestQty} — position ${r.positionDays != null
      ? "~" + Math.round(r.positionDays) + "d" : "?"} vs ${LEAD_TIME_DAYS + SAFETY_STOCK_DAYS}d point`);
  }
  if (r.mfnOpen) sub.push(`${r.mfnOpen} committed to open MFN order${r.mfnOpen === 1 ? "" : "s"}`);
  if (r.returns) sub.push(`↩️ ${r.returns} in returns — inspect, then Move home or Write off`);
  if (r.dcOwed) {
    sub.push(`🚚 owes the DC ${r.dcOwed} unit${r.dcOwed === 1 ? "" : "s"} — leadtime sale, 3-day SLA`);
  }
  if (r.group === "idle") sub.push(p && p.listing ? `listing ${INTENT_LABEL[p.listing.state] || p.listing.state}` : "no listing queued");
  if (r.group === "transit") sub.push(r.queued || r.live ? "listing under way — live by arrival if the feed clears" : "first stock");
  if ((r.other || []).length) sub.push(r.other.filter(([k]) => k !== "returns")
    .map(([k, v]) => `${k} ${v}`).join(" · "));
  if (Object.entries(r.locs || {}).some(([k, v]) => k !== "takealot" && v < 0)) {
    sub.push("⚠ negative — a sale outran the receipts, check the log");
  }
  const canMove = Object.values(r.locs || {}).some((v) => v > 0);
  return el("tr", { "data-focus": r.asin || "" },
    el("td", { class: "t" },
      el("div", { class: "rowtitle" }, r.title),
      sub.length ? el("div", { class: "rowsub" }, sub.join(" · ")) : null),
    el("td", { class: "r" }, r.road ? fmtNum(r.road) : el("span", { style: "color:var(--muted)" }, "—")),
    el("td", { class: "r" }, r.home ? fmtNum(r.home) : el("span", { style: "color:var(--muted)" }, "—")),
    el("td", { class: "r" }, r.tkl != null
      ? el("span", { class: r.tkl < 0 ? "st bad" : "" }, fmtNum(r.tkl))
      : el("span", { style: "color:var(--muted)" }, "—")),
    el("td", { class: "r" },
      r.onHand ? fmtNum(r.onHand) : el("span", { style: "color:var(--muted)" }, "0")),
    el("td", { class: "r", style: "font-weight:650" },
      r.available !== r.onHand || r.available < 0
        ? el("span", { class: r.available < 0 ? "st bad" : "" }, fmtNum(r.available))
        : fmtNum(r.available)),
    el("td", { class: "r" }, r.value ? fmtR(Math.round(r.value)) : el("span", { style: "color:var(--muted)" }, "—")),
    el("td", { class: "r" }, cover),
    el("td", { class: "r t", style: "white-space:nowrap" }, action,
      r.group !== "transit" && inbound.length ? el("button", {
        class: "b sm line", style: "margin-left:6px",
        onclick: () => receiveInboundModal(r, inbound),
      }, "Mark received") : null,
      r.dcOwed ? el("button", {
        class: "b sm line", style: "margin-left:6px",
        onclick: () => bookCourierModal(m),
      }, "Ship to DC…") : null,
      canMove ? el("button", {
        class: "b sm line", style: "margin-left:6px",
        onclick: () => moveStockModal(r),
      }, "Move…") : null));
}
