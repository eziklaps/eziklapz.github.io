/* Sell desk — one universal channel template rendered twice (Amazon and
   Takealot), so the two tabs read identically: Offer candidates → Listing
   intents → Account offers + Sales → Parked approvals (Amazon, bottom).
   Every action commits a `listings` / `shipments` entry to the command bus
   (funnel/commands.sink_listings / sink_shipments applies it). Queueing is
   always the safe half: nothing POSTs anywhere until the matching .env
   switch is on at the pipeline machine AND the remote switch isn't killed. */

// Amazon retired the standalone /gtinx form — exemptions are now applied
// for INSIDE the Add-products flow (search the catalog → "I'm adding a
// product not sold on Amazon" → brand "Generic" surfaces the exemption).
const GTIN_FORM_URL = "https://sellercentral.amazon.co.za/product-search";
const APPS_DASHBOARD_URL = "https://sellercentral.amazon.co.za/hz/myqdashboard";

function renderSellDesk(root) {
  const data = S.seller || {};
  const az = data.amazon || {};
  const tk = data.takealot || {};
  const azCount = (az.intents || []).length;
  const tkCount = (tk.intents || []).length;

  root.append(deskHead("Sell",
    `${azCount} Amazon · ${tkCount} Takealot intents · queueing is always ` +
    "safe — nothing posts until the switches arm · updated " +
    fmtAgo(data.generated_at)));

  const tab = (id, label) => el("button", {
    class: `tab${S.sellTab === id ? " active" : ""}`,
    onclick: () => { S.sellTab = id; renderDesk(); },
  }, label);
  // Cross-channel by design (one switch, one floor, both books), so it
  // sits above the tabs. Renders nothing on payloads that predate it.
  const rp = repricerPanel(data.repricer);
  if (rp) root.append(rp);

  root.append(el("div", { class: "tabs" },
    // Tab counts = listing intents only; shelves and approval queues live
    // inside their own panels and don't inflate the numbers.
    tab("amazon", `Amazon (${azCount})`),
    tab("takealot", `Takealot (${tkCount})`)));

  if (S.sellTab === "takealot") renderSellChannel(root, "takealot", tk);
  else renderSellChannel(root, "amazon", az);
}

/* The template. Both tabs walk the same panel order; only the data
   adapters differ per channel. */
function renderSellChannel(root, channel, data) {
  const status = statusLine();
  root.append(candidatesPanelEl(channel, data, status));
  root.append(intentsPanelEl(channel, data, status));
  root.append(el("div", {
    style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;align-items:start",
  },
    accountPanelEl(channel, data.account),
    sellSalesPanel(data.sales, channel === "takealot" ? "Takealot" : "Amazon")));
  if (channel === "amazon") root.append(sellTodosPanel((S.seller || {}).todos || {}));
}

/* ---------- the repricer (Phase 3: stay winning) ---------- */

const REPRICE_ACTION_TONE = {
  lower: "ok", raise: "ok", outpriced: "bad", hold: "mute", skip: "mute",
};

/* One switch + one table for both channels: what the automation decided
   per live offer, floor-guarded at buy-ready net margin. Decisions are
   computed even while the switch is off (via the manual 'repricer' stage),
   so the panel earns trust before a single price moves. The switch press
   mirrors autoReorderSwitch's bus contract exactly (key `repricer`). */
function repricerPanel(cfg) {
  if (!cfg) return null;
  const press = (S.commands || {}).repricer || null;
  const pending = press && press.requested_at
    && press.requested_at !== cfg.requested_at ? press : null;
  const on = pending ? !!pending.enabled : !!cfg.enabled;

  const btn = el("button", {
    class: `b sm ${on ? "" : "pri"}`,
    ...(pending ? { disabled: "" } : {}),
    onclick: () => {
      if (!confirm(on
        ? "Switch the repricer OFF? Prices freeze where they are; " +
          "decisions stay visible here."
        : "Switch the repricer ON? Live offers track the best competitor " +
          `(undercut R${cfg.undercut ?? 1}), never below the buy-ready ` +
          `floor (R${cfg.net_floor ?? 10} net after inbound), capped at ` +
          `${cfg.max_per_day ?? 25}/channel/day and ` +
          `${cfg.sku_max_per_day ?? 4}/offer/day.`)) return;
      busAct(`repricer ${on ? "off" : "on"}`, (doc) => {
        doc.repricer = {
          enabled: !on, requested_at: new Date().toISOString(),
        };
      }, null, "");
      btn.replaceWith(el("span", { class: "st warn" }, "🕐 applying"));
    },
  }, on ? "Switch off" : "Switch on…");

  const p = panelEl("Repricer", {
    soft: "— stay winning on both channels",
    right: cfg.last_pass_at
      ? el("span", {}, "last pass ", agoSpan(cfg.last_pass_at))
      : "no pass yet",
  });

  const book = Object.entries(cfg.book || {})
    .map(([ch, n]) => `${ch} ${n}`).join(" · ");
  const applied = Object.entries(cfg.applied_today || {})
    .map(([ch, n]) => `${ch} ${n}`).join(" · ");
  p.append(el("div", { class: "chiprow", style: "margin:0 0 8px;align-items:center;display:flex;gap:10px;flex-wrap:wrap" },
    el("span", { class: `st ${on ? "ok" : cfg.mode === "propose" ? "warn" : "mute"}` },
      on ? "ARMED — prices move inside the caps"
        : cfg.mode === "propose"
          ? "PROPOSE — decisions refresh on cadence, prices frozen " +
            "(dial on Machine)"
          : "off — decisions only"),
    btn,
    el("span", { class: "st mute" }, `book: ${book || "no live own-offers yet"}`),
    applied ? el("span", { class: "st ok" }, `applied today: ${applied}`) : null));

  const rows = cfg.rows || [];
  if (rows.length) {
    const table = el("table", { class: "grid" },
      el("tr", {}, el("th", {}, "Offer"), el("th", {}, "Channel"),
        el("th", {}, "Current"), el("th", {}, "Floor"),
        el("th", {}, "Best rival"), el("th", {}, "Verdict"),
        el("th", {}, "Target"), el("th", {}, "When")));
    for (const r of rows) {
      table.append(el("tr", {},
        el("td", { class: "t mono", style: "font-size:11.5px", title: r.reason || "" }, r.sku),
        el("td", { class: "t" }, r.channel),
        el("td", {}, fmtR(r.current)),
        el("td", { title: "buy-ready line: net margin after inbound allocation never drops under the floor" }, fmtR(r.floor)),
        el("td", {}, r.competitor != null ? fmtR(r.competitor) : "—"),
        el("td", { class: "t", title: r.reason || "" }, el("span", {
          class: `st ${REPRICE_ACTION_TONE[r.action] || "mute"}`,
        }, r.action + (r.apply_result && r.apply_result !== "accepted" ? " ⚠" : ""))),
        el("td", {}, r.target != null ? fmtR(r.target) : "—"),
        el("td", { class: "t", style: "color:var(--muted);font-size:12px" },
          fmtAgo(r.applied_at || r.decided_at))));
    }
    p.append(el("div", { class: "scroll-x" }, table));
  } else {
    p.append(emptyLine(cfg.last_pass_at
      ? "book is empty — no live own-offers to defend yet"
      : "no decisions yet — run the 'repricer' stage (Machine desk) to " +
        "preview what the automation would do, or arm the switch"));
  }
  p.append(el("div", { class: "hint", style: "margin-top:8px" },
    "hover a verdict for the why · floor = the price where net margin " +
    "hits the buy-ready line — no competitor, cap or knob can push under " +
    "it; rivals already below it read as 'outpriced', never chased"));
  return p;
}

function enabledPill(enabled, what) {
  return enabled
    ? el("span", { class: "pill warn", title: `${what}: the .env switch is ON — prepared work posts` },
        `${what} submissions ARMED (.env)`)
    : el("span", { class: "pill mute", title: `${what}: everything is prepared, nothing posts until the .env switch is on` },
        "submissions inert — prepared only");
}

/* ---------- client-side joins (margin + stock live in other payloads) ---------- */

/* Current pipeline margin for an ASIN, from the buyer payload — the same
   client-side ASIN join the Stock desk uses. Null when the product isn't
   on the winners list (the cell reads "—", never guessed). */
function sellMarginFor(asin) {
  const p = asin ? buyerByAsin()[asin] : null;
  return p && p.margin_total != null
    ? { total: p.margin_total, pct: p.margin_percent } : null;
}

/* Our own listings carry the pipeline SKU (S2-<ASIN>) on both channels. */
function asinFromSku(sku) {
  const m = /^S2-([A-Z0-9]{10})/.exec(sku || "");
  return m ? m[1] : null;
}

/* Units on hand for a product key (ASIN, or the Takealot doc id for
   discovery winners) from the stock-movements rollup in the admin payload.
   Null = the stock log has never seen the product; 0 = seen and empty. */
function stockOnHandFor(key) {
  let units = null;
  if (!key) return units;
  for (const h of (((S.admin || {}).stock || {}).on_hand) || []) {
    if (h.asin !== key) continue;
    const locs = h.locations || { home: h.units || 0 };
    units = (units ?? 0) + Object.values(locs).reduce((s, n) => s + (n || 0), 0);
  }
  return units;
}

function onHandCell(key) {
  const units = stockOnHandFor(key);
  if (units == null) return el("span", {
    class: "hint", title: "the stock log has never seen this product" }, "—");
  return el("span", { class: `st ${units > 0 ? "ok" : "warn"}` }, fmtNum(units));
}

function estMarginCell(asin) {
  const m = sellMarginFor(asin);
  return el("td", {
    title: "pipeline estimate at today's prices — real P&L lands on Books as fees settle",
  }, m ? `${fmtR(m.total)} · ${m.pct ?? "—"}%` : "—");
}

/* ---------- panel 1: offer candidates ---------- */

/* Where new offers start. Takealot: the merged shelf (discovery winners
   with a captured barcode + Amazon winners takealot-match tied to a PLID —
   same action, so one table with a source chip instead of two panels).
   Amazon: the queue-by-ASIN form — placed orders auto-create intents, so
   the manual twin is all the shelf there is. */
function candidatesPanelEl(channel, data, status) {
  if (channel === "amazon") return amazonCandidatesPanelEl(data, status);

  const rows = [
    ...(data.offerable || []).map((o) => ({ ...o, source: "discovery" })),
    ...(data.matched || []).map((m) => ({ ...m, source: "match" })),
  ].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)
                   || (b.margin_total ?? -1) - (a.margin_total ?? -1));

  const p = panelEl("Offer candidates", {
    soft: "— winners you could sell on Takealot but haven't queued",
  });
  if (!rows.length) {
    p.append(emptyLine("no candidates yet — run pull-takealot (discovery) " +
      "or takealot-match on the winners (Machine → Run stage)"));
    return p;
  }
  const table = el("table", { class: "grid" },
    el("tr", {},
      el("th", {}, "Product"),
      el("th", { title: "discovery = found on Takealot with the barcode captured · Amazon match = an Amazon winner matched into their catalog by PLID" }, "Source"),
      el("th", {}, "Score"), el("th", {}, "Margin"),
      el("th", {}, "Amazon"), el("th", {}, "Takealot"),
      el("th", { title: "units in the stock log — Takealot's 3-day SLA needs local stock" }, "On hand"),
      el("th", {}, "Offers"), el("th", {}, "")));
  for (const r of rows) {
    table.append(el("tr", { "data-focus": r.id || "" },
      el("td", { class: "t" }, r.url
        ? el("a", { href: r.url, target: "_blank", rel: "noopener", class: "rowtitle" }, r.title || r.id)
        : el("span", { class: "rowtitle" }, r.title || r.id)),
      el("td", { class: "t" }, el("span", {
        class: `tag ${r.source === "discovery" ? "ok" : ""}`,
        title: r.source === "discovery"
          ? `barcode ${r.barcode} captured by takealot-enrich`
          : `PLID ${r.plid} — the barcode resolves from the product page at queue time`,
      }, r.source === "discovery" ? "discovery" : "Amazon match")),
      el("td", {}, r.score != null ? String(Math.round(r.score)) : "—"),
      el("td", {}, marginCell(r)),
      el("td", {}, r.amazon_price != null ? fmtR(r.amazon_price) : "—"),
      el("td", {}, fmtR(r.takealot_price)),
      el("td", {}, onHandCell(r.id)),
      el("td", { class: "t", style: "font-size:12px;color:var(--ink2)" },
        r.offer_count != null ? `${r.offer_count}${r.seller ? ` (${r.seller})` : ""}` : "—"),
      el("td", { class: "r t" },
        r.source === "discovery"
          ? (r.barcode ? shelfActionEl(r, { barcode: r.barcode }, status) : "")
          : shelfActionEl(r, { plid: r.plid }, status))));
  }
  p.append(el("div", { class: "scroll-x" }, table),
    el("div", { class: "hint", style: "margin-top:8px" },
      "queueing commits the intent; the offer only POSTs once the switches " +
      "arm — barcodes are captured or fetched server-side, never guessed"));
  return p;
}

function amazonCandidatesPanelEl(data, status) {
  const p = panelEl("Offer candidates", {
    soft: "— placed orders auto-create Amazon intents; this is the manual twin",
  });
  const asinInput = el("input", {
    type: "text", class: "in mono", placeholder: "ASIN (e.g. B0ABC12345)",
    autocomplete: "off", spellcheck: "false", style: "width:190px",
  });
  const qtySelect = el("select", { class: "in" },
    ...[1, 2, 3, 4, 5].map((n) => el("option", { value: n }, `qty ${n}`)));
  p.append(el("div", {
    style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap",
  },
    asinInput, qtySelect,
    el("button", {
      class: "b line", onclick: () => {
        const asin = asinInput.value.trim().toUpperCase();
        if (!/^[A-Z0-9]{10}$/.test(asin)) {
          status.textContent = "That doesn't look like an ASIN (10 chars).";
          return;
        }
        busAct(`queue Amazon intent ${asin}`, (doc) => prunePush(doc, "listings", {
          asin, channel: "amazon", quantity: Number(qtySelect.value),
          source: "dashboard", requested_at: new Date().toISOString(),
        }), status);
        asinInput.value = "";
      },
    }, "Queue listing intent"),
    el("span", { class: "hint" }, "sourcing candidates live on the Buy desk — " +
      "ordering a winner queues its listing by itself")));
  return p;
}

/* ---------- panel 2: listing intents ---------- */

function intentsPanelEl(channel, data, status) {
  const label = channel === "takealot" ? "Takealot offer" : "Amazon listing";
  const p = panelEl("Listing intents", {
    right: enabledPill(data.enabled, label),
  });

  if (channel === "takealot") {
    const loadsheetIntents = (data.intents || []).filter((i) => i.state === "loadsheet");
    if (loadsheetIntents.length) {
      p.append(el("div", { class: "warnbar", style: "margin-bottom:10px" },
        el("span", { style: "font-weight:600" },
          `${loadsheetIntents.length} intent${loadsheetIntents.length > 1 ? "s" : ""} on the loadsheet`),
        el("span", { class: "hint" },
          "upload in the Seller Portal (Add New Products) — approval auto-detected by SKU poll"),
        el("span", { style: "flex:1" }),
        data.loadsheet
          ? el("button", {
              class: "b sm line", onclick: () => downloadLoadsheetEl(data.loadsheet),
            }, "⬇ Download loadsheet CSV") : null));
    }
  }

  // Bus-committed intents the payload doesn't know yet render as
  // "on the bus" rows — a fresh queue click is visible immediately.
  const merged = [...busListingPhantoms(channel, data.intents),
                  ...(data.intents || [])];
  if (merged.length) {
    p.append(intentTableEl(merged, channel, status));
  } else {
    p.append(emptyLine(channel === "takealot"
      ? "no Takealot listing intents — queue winners from the candidates above"
      : "no Amazon listing intents — placed orders auto-create them, or " +
        "queue one by ASIN above"));
  }
  if (channel === "takealot") {
    p.append(el("div", { class: "hint", style: "margin-top:8px" },
      "⚠ offers on a real barcode can never be deleted via the API — only " +
      "disabled in the Seller Portal; the typed LIST confirmation stays for that reason"));
  }
  p.append(status);
  return p;
}

/* Why a parked intent is stuck + the move that unstalls it — inline in the
   State cell, joined from the seller_todos queues. Nobody should have to
   cross-reference three panels to learn what a state word means. */
function intentReasonEl(it) {
  const todos = (S.seller || {}).todos || {};
  const wrap = (tone, ...kids) => el("div", {
    class: `st ${tone}`, style: "font-size:11px;margin-top:3px;white-space:normal",
  }, ...kids);
  if (it.state === "proposed") {
    if (it.source === "wide_listing") {
      const w = it.wide || {};
      return wrap("warn",
        `wide listing: ${w.orders ? w.orders.toLocaleString() + "+ Ali orders, " : ""}` +
        `no ZA counterpart — a NEW page, ships ≤${it.leadtime_days || "?"}d` +
        `${w.net_per_unit ? `, ≈R${w.net_per_unit}/unit net` : ""}` +
        `${w.product_type_granted === false ? " · exemption still needed" : ""}` +
        " — Approve queues it, Dismiss retires it for good");
    }
    return wrap("warn",
      "dual-listing twin: stock from an Amazon order can also sell here — " +
      "Approve queues it, Dismiss retires it for good");
  }
  if (it.state === "blocked_exemption") {
    const ex = (todos.exemptions || [])
      .find((x) => (x.asins || []).includes(it.asin));
    return wrap("mute",
      `parked: GTIN exemption${ex ? ` — ${ex.product_type}` : ""} · apply ` +
      "inside Add products, then ",
      el("a", {
        onclick: () => setDesk("sell", {
          sellTab: "amazon", focus: ex ? ex.product_type : it.asin }),
      }, "Mark granted"));
  }
  if (it.state === "rejected") {
    const r = (todos.restricted || []).find((x) => x.asin === it.asin);
    if (r) {
      const link = (r.links || [])[0];
      return wrap("warn", `Amazon restricts it: ${r.reason} · `,
        link
          ? el("a", { href: link.url, target: "_blank", rel: "noopener" },
              "apply for approval ↗")
          : "approval needed",
        " · the 24h poll auto-requeues once granted");
    }
    return wrap("mute", "see the note — Requeue retries it");
  }
  if (it.state === "fix_required") {
    return wrap("hot",
      "payload failed validation — the note names the problem; fix, then Requeue");
  }
  if (it.state === "needs_review") {
    return wrap("bad",
      "validation preview wants human eyes before this submits");
  }
  return null;
}

function intentTableEl(intents, channel, statusEl) {
  const table = el("table", { class: "grid" },
    el("tr", {},
      el("th", {}, "Product"), el("th", {}, "State"), el("th", {}, "Price"),
      el("th", {}, "Margin"),
      el("th", {}, "When"), el("th", {}, "Last note"), el("th", {}, "")));
  for (const it of intents) {
    table.append(el("tr", { "data-focus": it.asin || "" },
      el("td", { class: "t" },
        el("span", { class: "rowtitle", title: it.id }, it.title || it.asin || it.id)),
      el("td", { class: "t" }, stateWord(it.state),
        PARKED.has(it.state) || it.state === "proposed"
          ? intentReasonEl(it) : null),
      el("td", {}, it.list_price != null ? fmtR(it.list_price) : "—"),
      channel === "takealot"
        ? el("td", {}, it.takealot_margin_percent != null
            ? `${it.takealot_margin_percent}%` : "—")
        : estMarginCell(it.asin),
      el("td", { class: "t", style: "color:var(--muted);font-size:12px" }, fmtAgo(it.received_at)),
      el("td", { class: "t", style: "color:var(--ink2);font-size:12px" }, it.note ?? ""),
      el("td", { class: "r t" }, it.state === "proposed"
        ? el("span", {},
            el("button", {
              class: "b sm",
              onclick: () => busAct(`approve ${it.asin}`, (doc) => prunePush(doc, "listings", {
                asin: it.asin, channel, approve: true,
                requested_at: new Date().toISOString(),
              }), statusEl),
            }, "Approve"), " ",
            el("button", {
              class: "b sm line",
              onclick: () => busAct(`dismiss ${it.asin}`, (doc) => prunePush(doc, "listings", {
                asin: it.asin, channel, cancel: true,
                requested_at: new Date().toISOString(),
              }), statusEl),
            }, "Dismiss"))
        : PARKED.has(it.state)
        ? el("button", {
            class: "b sm line",
            onclick: () => busAct(`requeue ${it.asin}`, (doc) => prunePush(doc, "listings", {
              asin: it.asin, channel, requeue: true,
              requested_at: new Date().toISOString(),
            }), statusEl),
          }, "Requeue")
        : "")));
  }
  return el("div", { class: "scroll-x" }, table);
}

/* ---------- panel 3: account offers (shared, adaptive columns) ---------- */

const OFFER_STATUS_TONE = {
  buyable: "ok", not_buyable: "warn", inactive: "mute",
  disabled_by_seller: "mute", disabled_by_takealot: "hot",
};

function accountPanelEl(channel, account) {
  const name = channel === "takealot" ? "Takealot" : "Amazon";
  const p = panelEl("Account offers", {
    soft: `— live on ${name}`,
    right: account ? el("span", {}, "checked ", agoSpan(account.checked_at)) : null,
  });
  if (!account) {
    p.append(emptyLine("not checked yet — the 'sales' poll mirrors the " +
      "account's offer list every 6h"));
    return p;
  }
  const chips = el("div", { class: "chiprow", style: "margin:0 0 8px" },
    el("span", { class: "st ok" },
      `${(account.counts || {}).buyable || 0} buyable of ${account.total}`));
  for (const [st, n] of Object.entries(account.counts || {})) {
    if (st === "buyable") continue;
    chips.append(el("span", { class: `st ${OFFER_STATUS_TONE[st] || "mute"}` }, `${st}: ${n}`));
  }
  p.append(chips);
  for (const low of account.low_stock || []) {
    p.append(el("div", { class: "warnbar bad", style: "margin-bottom:8px;padding:8px 12px;font-size:12px" },
      `▲ LOW STOCK: ${low.title || low.sku} — ${low.stock} left`));
  }
  if ((account.rows || []).length) {
    const tk = channel === "takealot";
    const table = el("table", { class: "grid" },
      el("tr", {}, el("th", {}, "Offer"), el("th", {}, "Status"),
        el("th", {}, "Price"), el("th", {}, "Stock"),
        tk ? el("th", {}, "Wishlist 30d") : el("th", {}, "Fulfilment"),
        tk ? el("th", {}, "Returns") : null));
    for (const o of account.rows) {
      table.append(el("tr", {},
        el("td", { class: "t" }, o.url
          ? el("a", { href: o.url, target: "_blank", rel: "noopener", class: "rowtitle" }, o.title || o.sku)
          : el("span", { class: "rowtitle" }, o.title || o.sku)),
        el("td", { class: "t" }, el("span", {
          class: `st ${OFFER_STATUS_TONE[o.status] || "mute"}`,
        }, (o.status || "?").replace(/_by_seller|_by_takealot/, ""))),
        el("td", {}, fmtR(o.selling_price)),
        el("td", {}, o.stock ?? "—"),
        tk ? el("td", {}, fmtNum(o.wishlist_30d))
           : el("td", { class: "t" }, o.fulfillment || "—"),
        tk ? el("td", {}, fmtNum(o.returned_30d)) : null));
    }
    p.append(el("div", { class: "scroll-x" }, table));
  }
  p.append(el("div", { class: "hint", style: "margin-top:8px" }, tkHint(channel)));
  return p;
}

function tkHint(channel) {
  return channel === "takealot"
    ? "stock column fills once offers carry warehouse stock (today's are leadtime-model)"
    : "mirrored from the Listings API — the same listings Seller Central shows under Manage Inventory";
}

/* ---------- panel 4: sales (shared) ---------- */

function sellSalesPanel(sales, label) {
  const counts = (sales || {}).counts || {};
  const recent = (sales || {}).recent || [];
  const chips = el("span", { style: "display:inline-flex;gap:10px;flex-wrap:wrap" });
  for (const [state, n] of Object.entries(counts)) {
    chips.append(el("span", {
      class: `st ${state === "Shipped" ? "ok" : state === "Unshipped" ? "warn" : "mute"}`,
    }, `${state} ${n}`));
  }
  const p = panelEl("Sales", {
    soft: `— sold on ${label}`,
    right: (sales || {}).polled_at
      ? el("span", {}, "polled ", agoSpan(sales.polled_at), " (6h cycle)")
      : "not polled yet",
  });
  if (Object.keys(counts).length) p.append(el("div", { style: "margin-bottom:8px" }, chips));
  if (recent.length) {
    const shippable = label === "Amazon";
    const table = el("table", { class: "grid" },
      el("tr", {}, el("th", {}, "Order"), el("th", {}, "Product"),
        el("th", {}, "Qty"), el("th", {}, "Price"),
        el("th", {}, "Est. margin"), el("th", {}, "State"),
        el("th", {}, "When"),
        shippable ? el("th", {}, "Fulfilment (MFN)") : null));
    for (const s of recent) {
      table.append(el("tr", { "data-focus": s.order_id || "" },
        el("td", { class: "t mono", style: "font-size:11.5px" }, s.order_id),
        el("td", { class: "t" }, el("span", { class: "rowtitle" }, s.title || s.sku || "—")),
        el("td", {}, fmtNum(s.quantity)),
        el("td", {}, fmtR(s.selling_price)),
        estMarginCell(s.asin || asinFromSku(s.sku)),
        el("td", { class: "t" }, el("span", {
          class: `st ${s.state === "Shipped" ? "ok" : s.state === "Unshipped" ? "warn" : "mute"}`,
        }, s.state ?? "—")),
        el("td", { class: "t", style: "color:var(--muted);font-size:12px" }, fmtAgo(s.ordered_at)),
        shippable ? el("td", { class: "t" }, shipCellEl(s)) : null));
    }
    p.append(el("div", { class: "scroll-x" }, table));
    if (shippable) {
      p.append(el("div", { class: "hint", style: "margin-top:8px" },
        "ZA has no buy-shipping API — buy the courier label yourself, then " +
        "confirm here; the pipeline POSTs shipmentConfirmation to the Orders API"));
    }
  } else {
    p.append(emptyLine((sales || {}).polled_at
      ? `nothing sold yet — ${label} checked ${fmtAgo(sales.polled_at)}`
      : "no sales data yet — the 'sales' poll runs every 6h"));
  }
  return p;
}

function shipCellEl(s) {
  if (s.fulfillment === "AFN") return el("span", { class: "hint" }, "FBA — Amazon fulfils");
  if (s.ship_confirmed_at) {
    return el("span", { class: "st ok" },
      `✓ confirmed${s.ship_tracking ? ` · ${s.ship_tracking}` : ""}`);
  }
  if (!["Unshipped", "PartiallyShipped"].includes(s.state)) return "—";
  const cell = el("span", {});
  if (s.ship_confirm_error) {
    cell.append(el("div", { class: "st bad", title: s.ship_confirm_error },
      "confirm failed — retry"));
  }
  cell.append(el("button", { class: "b sm pri", onclick: () => confirmShipModalEl(s) },
    "🚚 Confirm shipment"));
  if (s.latest_ship_date) {
    cell.append(el("div", {
      style: `font-size:11px;margin-top:3px;color:var(--${dueTone(s.latest_ship_date) === "bad" ? "bad" : "ink2"})`,
    }, `ship by ${fmtDate(s.latest_ship_date)} — feeds Late Shipment <4%`));
  }
  return cell;
}

function confirmShipModalEl(s) {
  withToken(() => {
    const carrier = el("input", {
      type: "text", class: "in wide", style: "margin-top:12px",
      placeholder: "Courier (e.g. The Courier Guy)" });
    const tracking = el("input", {
      type: "text", class: "in wide", style: "margin-top:8px",
      placeholder: "Tracking / waybill number (required — feeds Valid Tracking Rate)" });
    const status = statusLine();
    const btn = el("button", { class: "b pri wide", style: "margin-top:12px" }, "Confirm shipment");
    btn.addEventListener("click", async () => {
      const trackingNo = tracking.value.trim();
      if (!trackingNo) {
        status.textContent = "Tracking number required — it feeds Valid Tracking Rate.";
        return;
      }
      btn.setAttribute("disabled", "");
      status.textContent = "Committing shipment confirmation…";
      try {
        await mutateCommands((doc) => prunePush(doc, "shipments", {
          order_id: s.order_id, carrier: carrier.value.trim(),
          tracking: trackingNo, requested_at: new Date().toISOString(),
        }, 2), `Dashboard: confirm shipment ${s.order_id}`);
        status.textContent = "";
        btn.replaceWith(el("div", { class: "note ok", style: "margin-top:12px" },
          el("b", {}, "✅ Committed. "),
          "The pipeline POSTs the confirmation to Amazon within ~30s while " +
          "serve is up; the sales row flips once it lands."));
      } catch (e) {
        status.textContent = `Failed: ${e.message}`;
        if (/401|403/.test(e.message)) localStorage.removeItem(PAT_KEY);
        btn.removeAttribute("disabled");
      }
    });
    openModal(
      el("h3", {}, "Confirm shipment"),
      el("p", { class: "meta", style: "margin-top:8px" },
        `Amazon order ${s.order_id}${s.title ? ` — ${s.title}` : ""}. Buy the ` +
        "courier label first, then enter its details; the pipeline calls the " +
        "Orders API confirmShipment." +
        (s.latest_ship_date ? ` Ship-by date: ${fmtDate(s.latest_ship_date)}.` : "")),
      carrier, tracking, btn,
      el("button", { class: "b wide", style: "margin-top:8px", onclick: () => modalEl().close() }, "Close"),
      status);
  });
}

/* ---------- panel 5: parked approvals (Amazon only, bottom by design) ---------- */

function sellTodosPanel(todos) {
  const exemptions = todos.exemptions || [];
  const restricted = todos.restricted || [];
  const compliance = todos.compliance || [];
  const status = statusLine();
  const total = exemptions.length + restricted.length + compliance.length;
  const p = panelEl("Parked approvals", {
    soft: "— not being chased right now",
    right: el("a", { href: APPS_DASHBOARD_URL, target: "_blank", rel: "noopener" },
      "selling applications ↗"),
  });

  if (!total) {
    p.append(pill("ok", "nothing parked"), status);
    return p;
  }

  // One calm line, collapsed by default: these queues wait on Seller
  // Central approvals Andrew has chosen not to pursue for now, and the Buy
  // desk's buy-ready filter already keeps the blocked products out of the
  // sourcing view — no reason for this panel to shout.
  const bits = [
    restricted.length
      ? `${restricted.length} restricted ASIN${restricted.length > 1 ? "s" : ""}` : null,
    exemptions.length
      ? `${exemptions.length} GTIN categor${exemptions.length > 1 ? "ies" : "y"}` : null,
    compliance.length
      ? `${compliance.length} ZA compliance` : null,
  ].filter(Boolean).join(" · ");
  p.append(el("div", { class: "hint" },
    `${bits} — parked until you take up the approval process; the Buy desk ` +
    "hides these products meanwhile. ",
    el("a", {
      style: "cursor:pointer",
      onclick: () => { S.sellTodosOpen = !S.sellTodosOpen; renderDesk(); },
    }, S.sellTodosOpen ? "Hide ▴" : "Details ▾")));
  if (!S.sellTodosOpen) {
    p.append(status);
    return p;
  }

  for (const ex of exemptions) {
    p.append(el("div", {
      class: "note", style: "margin:8px 0 6px;display:flex;gap:8px;" +
        "align-items:center;flex-wrap:wrap",
      "data-focus": ex.product_type,
    },
      el("span", { style: "font-weight:600" },
        `GTIN exemption: ${ex.product_type} — ${ex.count} intent${ex.count > 1 ? "s" : ""}`),
      el("span", { class: "mono", style: "color:var(--ink2);font-size:12px" },
        (ex.asins || []).join(", ")),
      el("span", { style: "flex:1" }),
      el("a", {
        class: "b sm line", href: GTIN_FORM_URL, target: "_blank", rel: "noopener",
      }, "Add products flow ↗"),
      el("button", {
        class: "b sm line",
        onclick: () => busAct(`grant ${ex.product_type}`, (doc) => prunePush(doc, "listings", {
          grant: ex.product_type, requested_at: new Date().toISOString(),
        }), status,
        `✅ grant noted — blocked intents re-prepare on the next listings pass.`),
      }, "✓ Mark granted")));
  }
  if (exemptions.length) {
    p.append(el("div", { class: "hint", style: "margin:6px 0 10px" },
      "The old /gtinx form is retired — apply inside Add products: search " +
      "the catalog, choose “I'm adding a product not sold on Amazon”, brand " +
      "“Generic”, and the exemption path appears. 2–9 photos of the " +
      "PHYSICAL product with no branding (supplier photos fail) · ~48h " +
      "review · Mark granted re-prepares the blocked intents."));
  }

  if (restricted.length) {
    const table = el("table", { class: "grid" },
      el("tr", {}, el("th", {}, "Restricted ASIN"), el("th", {}, "Score"),
        el("th", {}, "Restriction"), el("th", {}, ""), el("th", {}, "Checked")));
    for (const r of restricted) {
      const link = (r.links || [])[0];
      table.append(el("tr", { "data-focus": r.asin },
        el("td", { class: "t mono" }, el("a", {
          href: `https://www.amazon.co.za/dp/${r.asin}`,
          target: "_blank", rel: "noopener",
        }, r.asin)),
        el("td", {}, r.score != null ? String(Math.round(r.score)) : "—"),
        el("td", { class: "t", style: "color:var(--ink2)" },
          (r.reason || "").replace(/^APPROVAL_REQUIRED:\s*/, "")),
        el("td", { class: "t" }, link
          ? el("a", { class: "b sm line", href: link.url, target: "_blank", rel: "noopener" }, "Apply ↗")
          : el("span", { class: "hint" }, "no form — not accepting applications")),
        el("td", { class: "t", style: "color:var(--muted);font-size:12px" }, fmtAgo(r.checked_at))));
    }
    p.append(el("div", { class: "scroll-x" }, table),
      el("div", { class: "hint", style: "margin-top:4px" },
        "auto-granted ones cost one click; invoice-walled ones can be skipped " +
        "— the 24h re-poll unblocks granted ASINs by itself"));
  }

  if (compliance.length) {
    p.append(el("div", { style: "font-size:12px;font-weight:650;color:var(--ink2);margin-top:14px" },
      "ZA COMPLIANCE (ICASA / NRCS / LIABILITY)"));
    const table = el("table", { class: "grid" },
      el("tr", {}, el("th", {}, "ASIN"), el("th", {}, "Risk"),
        el("th", {}, "Needs / why"), el("th", {}, "Score"), el("th", {}, "")));
    for (const c of compliance) {
      const needs = [...(c.requires || []), ...(c.flags || [])]
        .map((k) => k.replace(/_/g, " ")).join(", ");
      table.append(el("tr", { "data-focus": c.asin },
        el("td", { class: "t mono" }, el("a", {
          href: `https://www.amazon.co.za/dp/${c.asin}`,
          target: "_blank", rel: "noopener",
        }, c.asin)),
        el("td", { class: "t" }, el("span", {
          class: `st ${c.risk === "blocked" ? "bad" : "warn"}`,
        }, c.risk === "blocked" ? "⛔ blocked" : "▲ review")),
        el("td", { class: "t", style: "color:var(--ink2)" },
          [needs, c.reason].filter(Boolean).join(" — ") || "—"),
        el("td", {}, c.score != null ? String(Math.round(c.score)) : "—"),
        el("td", { class: "t" }, el("button", {
          class: "b sm line",
          onclick: () => busAct(`clear ${c.asin}`, (doc) => prunePush(doc, "listings", {
            compliance_clear: c.asin, requested_at: new Date().toISOString(),
          }), status),
        }, "✓ Mark cleared"))));
    }
    p.append(el("div", { class: "scroll-x" }, table),
      el("div", { class: "hint", style: "margin-top:4px" },
        "“Mark cleared” = approval obtained, risk accepted, or the classifier " +
        "got it wrong — the gate lifts and parked intents un-park on their own"));
  }

  if ((todos.granted || []).length) {
    p.append(el("div", { class: "chiprow", style: "margin-top:10px" },
      ...todos.granted.map((g) => el("span", { class: "tag ok" },
        `✓ exemption granted: ${g}`))));
  }
  p.append(status);
  return p;
}

/* ---------- candidate actions ---------- */

function shelfActionEl(row, handle, statusEl) {
  if (row.intent && !PARKED.has(row.intent.state)) {
    return stateWord(row.intent.state);
  }
  // Committed to the bus but not yet an intent — block the double-queue.
  if (!row.intent && busListingPhantoms("takealot", [])
      .some((ph) => ph.asin === row.id)) {
    return el("span", { class: "st warn",
      title: "committed — the pipeline applies it within ~30s" },
      "🕐 on the bus");
  }
  if (row.intent) {
    return el("span", {}, stateWord(row.intent.state), " ",
      el("button", {
        class: "b sm line", title: row.intent.note || "",
        onclick: () => busAct(`requeue ${row.id}`, (doc) => prunePush(doc, "listings", {
          asin: row.id, channel: "takealot", requeue: true,
          requested_at: new Date().toISOString(),
        }), statusEl),
      }, "Requeue"));
  }
  return el("button", {
    class: "b sm pri", onclick: () => listOnTakealotModal(row, handle),
  }, "List on Takealot");
}

function listOnTakealotModal(row, handle) {
  typedCommitModal({
    title: "List on Takealot",
    product: row.title || row.id,
    lines: [handle.barcode
      ? `barcode ${handle.barcode} (captured by takealot-enrich) — the offer attaches to the existing catalog product`
      : `PLID ${handle.plid} — the pipeline fetches the barcode from the product page server-side, then the offer attaches to it`],
    warn: el("span", {}, el("b", {}, "⚠ Permanent footprint: "),
      "offers on a real barcode can never be deleted via the API — only " +
      "disabled in the Seller Portal. Queue products you actually want to sell."),
    word: "LIST",
    qtyLabel: "Stock quantity",
    qtyDefault: 3,
    confirmLabel: "Queue Takealot offer",
    busKey: "listings",
    entryFor: (qty) => ({
      asin: row.id, channel: "takealot", quantity: qty,
      source: "dashboard", requested_at: new Date().toISOString(),
      ...handle,
    }),
    doneText: "The pipeline prices it against the landed-cost floor and " +
      "readies the offer; it POSTs only while TAKEALOT_ENABLED=1 on the " +
      "pipeline machine. State appears in the intents table on the next refresh.",
  });
}

function downloadLoadsheetEl(loadsheet) {
  const blob = new Blob([loadsheet.csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: "takealot_loadsheet.csv" });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
