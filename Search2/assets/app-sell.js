/* Sell desk — listings & approvals per channel, plus own-channel sales.
   Every action commits a `listings` / `shipments` entry to the command bus
   (funnel/commands.sink_listings / sink_shipments applies it). Queueing is
   always the safe half: nothing POSTs anywhere until the matching .env
   switch is on at the pipeline machine AND the remote switch isn't killed. */

const GTIN_FORM_URL = "https://sellercentral.amazon.co.za/gtinx";
const APPS_DASHBOARD_URL = "https://sellercentral.amazon.co.za/hz/myqdashboard";

function renderSellDesk(root) {
  const data = S.seller || {};
  const az = data.amazon || {};
  const tk = data.takealot || {};
  const todos = data.todos || {};
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
  root.append(el("div", { class: "tabs" },
    tab("amazon", `Amazon (${azCount + (todos.restricted || []).length + (todos.exemptions || []).length})`),
    tab("takealot", `Takealot (${tkCount + (tk.offerable || []).length + (tk.matched || []).length})`)));

  if (S.sellTab === "takealot") renderSellTakealot(root, tk);
  else renderSellAmazon(root, az, todos);
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

/* ---------- Amazon tab ---------- */

function renderSellAmazon(root, az, todos) {
  root.append(sellTodosPanel(todos));

  /* listing intents */
  const status = statusLine();
  const p = panelEl("Amazon listing intents", {
    right: enabledPill(az.enabled, "Amazon listing"),
  });
  // Bus-committed intents the payload doesn't know yet render as
  // "on the bus" rows — a fresh queue click is visible immediately.
  const azMerged = [...busListingPhantoms("amazon", az.intents),
                    ...(az.intents || [])];
  if (azMerged.length) {
    p.append(intentTableEl(azMerged, "amazon", status));
  } else {
    p.append(emptyLine("no Amazon listing intents — placed orders auto-create " +
      "them, or queue one by ASIN below"));
  }
  const asinInput = el("input", {
    type: "text", class: "in mono", placeholder: "ASIN (e.g. B0ABC12345)",
    autocomplete: "off", spellcheck: "false", style: "width:190px",
  });
  const qtySelect = el("select", { class: "in" },
    ...[1, 2, 3, 4, 5].map((n) => el("option", { value: n }, `qty ${n}`)));
  p.append(el("div", {
    style: "display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:12px;" +
           "border-top:1px solid var(--line-soft);flex-wrap:wrap",
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
    el("span", { class: "hint" }, "placed orders auto-create intents — this is the manual twin")),
    status);
  root.append(p);

  root.append(sellSalesPanel(az.sales, "Amazon"));
}

function sellTodosPanel(todos) {
  const exemptions = todos.exemptions || [];
  const restricted = todos.restricted || [];
  const compliance = todos.compliance || [];
  const status = statusLine();
  const p = panelEl("Seller Central to-dos", {
    soft: "— the pipeline prepares, only you can click approve",
    right: el("a", { href: APPS_DASHBOARD_URL, target: "_blank", rel: "noopener" },
      "all selling applications ↗"),
  });

  if (!exemptions.length && !restricted.length && !compliance.length) {
    p.append(pill("ok", "nothing awaiting manual approval"));
  }

  for (const ex of exemptions) {
    p.append(el("div", {
      class: "warnbar", style: "margin-bottom:6px",
      "data-focus": ex.product_type,
    },
      el("span", { style: "font-weight:600" },
        `GTIN exemption needed: ${ex.product_type} — ${ex.count} intent${ex.count > 1 ? "s" : ""}`),
      el("span", { class: "mono", style: "color:var(--ink2);font-size:12px" },
        (ex.asins || []).join(", ")),
      el("span", { style: "flex:1" }),
      el("a", {
        class: "b sm line", href: GTIN_FORM_URL, target: "_blank", rel: "noopener",
      }, "Apply for exemption ↗"),
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
      "Brand “Generic” + the category · needs 2–9 photos of the PHYSICAL " +
      "product with no branding (supplier photos fail) · ~48h review. Mark " +
      "granted re-prepares the blocked intents on the next listings pass."));
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

/* Why a parked intent is stuck + the move that unstalls it — inline in the
   State cell, joined from the seller_todos queues. Nobody should have to
   cross-reference three panels to learn what a state word means. */
function intentReasonEl(it) {
  const todos = (S.seller || {}).todos || {};
  const wrap = (tone, ...kids) => el("div", {
    class: `st ${tone}`, style: "font-size:11px;margin-top:3px;white-space:normal",
  }, ...kids);
  if (it.state === "blocked_exemption") {
    const ex = (todos.exemptions || [])
      .find((x) => (x.asins || []).includes(it.asin));
    return wrap("warn",
      `needs a GTIN exemption${ex ? ` — ${ex.product_type}` : ""} · apply on the form, then `,
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
        PARKED.has(it.state) ? intentReasonEl(it) : null),
      el("td", {}, it.list_price != null ? fmtR(it.list_price) : "—"),
      channel === "takealot"
        ? el("td", {}, it.takealot_margin_percent != null
            ? `${it.takealot_margin_percent}%` : "—")
        : estMarginCell(it.asin),
      el("td", { class: "t", style: "color:var(--muted);font-size:12px" }, fmtAgo(it.received_at)),
      el("td", { class: "t", style: "color:var(--ink2);font-size:12px" }, it.note ?? ""),
      el("td", { class: "r t" }, PARKED.has(it.state)
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

function sellSalesPanel(sales, label) {
  const counts = (sales || {}).counts || {};
  const recent = (sales || {}).recent || [];
  const chips = el("span", { style: "display:inline-flex;gap:10px;flex-wrap:wrap" });
  for (const [state, n] of Object.entries(counts)) {
    chips.append(el("span", {
      class: `st ${state === "Shipped" ? "ok" : state === "Unshipped" ? "warn" : "mute"}`,
    }, `${state} ${n}`));
  }
  const p = panelEl(`Sales — ${label}`, {
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

/* ---------- Takealot tab ---------- */

function renderSellTakealot(root, tk) {
  const status = statusLine();

  /* ready to offer (enriched discovery winners) */
  const offer = panelEl("Ready to offer", {
    soft: "— discovery winners with offer stack + barcode (takealot-enrich)",
  });
  if ((tk.offerable || []).length) {
    const table = el("table", { class: "grid" },
      el("tr", {}, el("th", {}, "Product"), el("th", {}, "Score"),
        el("th", {}, "Margin"), el("th", {}, "Their price"),
        el("th", { title: "units in the stock log — Takealot's 3-day SLA needs local stock" }, "On hand"),
        el("th", {}, "Offers"), el("th", {}, "Barcode"), el("th", {}, "")));
    for (const o of tk.offerable) {
      table.append(el("tr", { "data-focus": o.id || "" },
        el("td", { class: "t" }, o.url
          ? el("a", { href: o.url, target: "_blank", rel: "noopener", class: "rowtitle" }, o.title || o.id)
          : el("span", { class: "rowtitle" }, o.title || o.id)),
        el("td", {}, o.score != null ? String(Math.round(o.score)) : "—"),
        el("td", {}, marginCell(o)),
        el("td", {}, fmtR(o.takealot_price)),
        el("td", {}, onHandCell(o.id)),
        el("td", { class: "t", style: "font-size:12px;color:var(--ink2)" },
          o.offer_count != null ? `${o.offer_count}${o.seller ? ` (${o.seller})` : ""}` : "—"),
        el("td", { class: "t mono", style: "font-size:11.5px" }, o.barcode || "—"),
        el("td", { class: "r t" }, o.barcode
          ? shelfActionEl(o, { barcode: o.barcode }, status) : "")));
    }
    offer.append(el("div", { class: "scroll-x" }, table),
      el("div", { class: "hint", style: "margin-top:8px" },
        "queueing commits the intent; the offer only POSTs once the switches arm"));
  } else {
    offer.append(emptyLine("no enriched Takealot winners yet — run pull-takealot, " +
      "let a funnel run carry the docs through, then takealot-enrich"));
  }
  root.append(offer);

  /* matched (Amazon winners already on Takealot) */
  const matched = panelEl("On Takealot already", {
    soft: "— Amazon winners matched into their catalog (takealot-match); offer by PLID",
  });
  if ((tk.matched || []).length) {
    const table = el("table", { class: "grid" },
      el("tr", {}, el("th", {}, "Product"), el("th", {}, "Score"),
        el("th", {}, "Margin"), el("th", {}, "Amazon"), el("th", {}, "Takealot"),
        el("th", { title: "units in the stock log — Takealot's 3-day SLA needs local stock" }, "On hand"),
        el("th", {}, "Offers"), el("th", {}, "")));
    for (const m of tk.matched) {
      table.append(el("tr", { "data-focus": m.id || "" },
        el("td", { class: "t" }, m.url
          ? el("a", { href: m.url, target: "_blank", rel: "noopener", class: "rowtitle" }, m.title || m.id)
          : el("span", { class: "rowtitle" }, m.title || m.id)),
        el("td", {}, m.score != null ? String(Math.round(m.score)) : "—"),
        el("td", {}, marginCell(m)),
        el("td", {}, fmtR(m.amazon_price)),
        el("td", {}, fmtR(m.takealot_price)),
        el("td", {}, onHandCell(m.id)),
        el("td", { class: "t", style: "font-size:12px;color:var(--ink2)" },
          m.offer_count != null ? `${m.offer_count}${m.seller ? ` (${m.seller})` : ""}` : "—"),
        el("td", { class: "r t" }, shelfActionEl(m, { plid: m.plid }, status))));
    }
    matched.append(el("div", { class: "scroll-x" }, table),
      el("div", { class: "hint", style: "margin-top:8px" },
        "the pipeline fetches the barcode from the product page when you " +
        "queue one — never guessed, never probed"));
  } else {
    matched.append(emptyLine("no catalog matches yet — run takealot-match on " +
      "the winners (Machine → Run stage)"));
  }
  root.append(matched);

  /* intents + loadsheet */
  const p = panelEl("Takealot listing intents", {
    right: enabledPill(tk.enabled, "Takealot offer"),
  });
  const loadsheetIntents = (tk.intents || []).filter((i) => i.state === "loadsheet");
  if (loadsheetIntents.length) {
    p.append(el("div", { class: "warnbar", style: "margin-bottom:10px" },
      el("span", { style: "font-weight:600" },
        `${loadsheetIntents.length} intent${loadsheetIntents.length > 1 ? "s" : ""} on the loadsheet`),
      el("span", { class: "hint" },
        "upload in the Seller Portal (Add New Products) — approval auto-detected by SKU poll"),
      el("span", { style: "flex:1" }),
      tk.loadsheet
        ? el("button", {
            class: "b sm line", onclick: () => downloadLoadsheetEl(tk.loadsheet),
          }, "⬇ Download loadsheet CSV") : null));
  }
  const tkMerged = [...busListingPhantoms("takealot", tk.intents),
                    ...(tk.intents || [])];
  if (tkMerged.length) {
    p.append(intentTableEl(tkMerged, "takealot", status));
  } else {
    p.append(emptyLine("no Takealot listing intents — queue winners from the shelves above"));
  }
  p.append(el("div", { class: "hint", style: "margin-top:8px" },
    "⚠ offers on a real barcode can never be deleted via the API — only " +
    "disabled in the Seller Portal; the typed LIST confirmation stays for that reason"),
    status);
  root.append(p);

  /* account offers + sales side by side */
  root.append(el("div", {
    style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;align-items:start",
  }, accountPanelEl(tk.account), sellSalesPanel(tk.sales, "Takealot")));
}

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

const OFFER_STATUS_TONE = {
  buyable: "ok", not_buyable: "warn",
  disabled_by_seller: "mute", disabled_by_takealot: "hot",
};

function accountPanelEl(account) {
  const p = panelEl("On Takealot — account offers", {
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
    const table = el("table", { class: "grid" },
      el("tr", {}, el("th", {}, "Offer"), el("th", {}, "Status"),
        el("th", {}, "Price"), el("th", {}, "Stock"),
        el("th", {}, "Wishlist 30d"), el("th", {}, "Returns")));
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
        el("td", {}, fmtNum(o.wishlist_30d)),
        el("td", {}, fmtNum(o.returned_30d))));
    }
    p.append(el("div", { class: "scroll-x" }, table));
  }
  p.append(el("div", { class: "hint", style: "margin-top:8px" },
    "stock column fills once offers carry warehouse stock (today's are leadtime-model)"));
  return p;
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
