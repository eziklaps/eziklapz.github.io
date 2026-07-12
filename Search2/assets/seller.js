/* Seller page: listings & approvals per channel — and since 2026-07-08,
   the place listing ACTIONS live (design call: buyer = decide & buy,
   seller = list & manage; buyer cards show read-only sell-state chips).
   Fetches seller.enc, decrypts (common.js), renders panels; every action
   commits a `listings` entry to the command bus (same wire as the buyer
   page's order intents) and the pipeline's sink_listings applies it:

     queue Takealot offer  {asin, channel, quantity, barcode|plid}  typed LIST
     queue Amazon intent   {asin, channel, quantity}                one-click
     requeue parked intent {asin, channel, requeue:true}            one-click
     grant GTIN exemption  {grant: productType}                     one-click

   Takealot queueing keeps the typed confirmation because offers on a real
   barcode can NEVER be deleted via the API (portal disable only). Nothing
   POSTs anywhere until TAKEALOT_ENABLED=1 / LISTING_ENABLED=1 in .env on
   the pipeline machine — queueing from here is always the safe half. */

const REFRESH_MS = 60_000;

let activeChannel = "amazon";
let lastData = null;

/* Intent state chips across both channels' state machines. */
const INTENT_CHIP = {
  pending: "neutral", ready: "neutral", validated: "good",
  submitting: "warning", submitted: "good", live: "good",
  loadsheet: "warning", offer_ready: "good",
  blocked_exemption: "warning", fix_required: "serious",
  needs_review: "critical", rejected: "neutral",
};

const INTENT_LABEL = {
  pending: "queued", ready: "payload ready", validated: "validated",
  submitting: "submitting…", submitted: "submitted", live: "🟢 live",
  loadsheet: "on the loadsheet", offer_ready: "priced — offer queued",
  blocked_exemption: "blocked: GTIN exemption", fix_required: "needs a fix",
  needs_review: "needs review", rejected: "rejected",
};

/* Parked states a Requeue can rescue (mirrors commands._sink_requeue). */
const PARKED = new Set(["fix_required", "rejected", "needs_review",
                        "blocked_exemption"]);

function stateChip(state) {
  return el("span", { class: `chip ${INTENT_CHIP[state] || "neutral"}` },
    el("span", { class: "dot" }), INTENT_LABEL[state] || state || "?");
}

function enabledChip(enabled, what) {
  return enabled
    ? el("span", { class: "chip good" }, el("span", { class: "dot" }),
        `${what} submissions ARMED (.env)`)
    : el("span", { class: "chip neutral" }, el("span", { class: "dot" }),
        `${what} submissions inert — everything is prepared, nothing posts ` +
        "until the .env switch is on");
}

/* ---- command-bus plumbing ----
   Entries ride doc.listings; the Mongo intent is the durable record, the
   commands doc is just the wire — prune entries the pipeline sank ages
   ago, exactly like the buyer page does for orders. */

function pushListing(doc, entry) {
  doc.listings = (doc.listings || []).filter((x) =>
    x.requested_at && Date.now() - new Date(x.requested_at) < 7 * 864e5);
  doc.listings.push(entry);
}

/* Collects the admin token if missing, then runs next(). The token is
   normally derived from the gate passphrase (common.js adoptBusToken), so
   the paste dialog is a fallback only. */
function withToken(next) {
  if (localStorage.getItem(PAT_KEY)) { next(); return; }
  adoptBusToken().then((ok) => {
    if (ok) { next(); return; }
    promptForToken(next);
  });
}

function promptForToken(next) {
  const dialog = document.getElementById("act-modal");
  const copy = tokenPromptCopy();
  const input = el("input", {
    type: "password",
    placeholder: LIVE_BASE ? "Dashboard admin token"
                           : "Fine-grained GitHub token (contents R/W)",
    style: "width:100%;padding:8px 10px;margin:8px 0;border:1px solid var(--hairline);" +
           "border-radius:8px;background:var(--surface);color:var(--ink);",
  });
  dialog.replaceChildren(
    el("h3", {}, `Listing actions ${copy.title}`),
    el("p", { class: "meta" },
      `Listing actions ride the pipeline's command bus. ${copy.hint}`),
    input,
    el("button", {
      class: "btn", onclick: () => {
        if (input.value.trim()) {
          localStorage.setItem(PAT_KEY, input.value.trim());
          dialog.close();
          next();
        }
      },
    }, "Save token"),
    " ",
    el("button", { class: "btn ghost", onclick: () => dialog.close() }, "Cancel"));
  dialog.showModal();
}

/* One-click action: commit an entry, report into statusEl. */
function commitEntry(entry, label, statusEl) {
  withToken(async () => {
    statusEl.textContent = `${label}…`;
    try {
      await mutateCommands((doc) => pushListing(doc, entry),
        `Dashboard: ${label}`);
      statusEl.textContent =
        `✅ ${label} sent — serve sinks it within seconds; this page ` +
        "updates on the next publish.";
    } catch (e) {
      statusEl.textContent = `${label} failed: ${e.message}`;
      if (/401|403/.test(e.message)) localStorage.removeItem(PAT_KEY);
    }
  });
}

/* Typed-confirmation modal for queueing a Takealot offer (the only action
   with a permanent footprint on the account). `handle` is {barcode} for
   the enriched shelf, {plid} for the matched shelf. */
function listOnTakealot(row, handle) {
  withToken(() => {
    const dialog = document.getElementById("act-modal");
    const qtySelect = el("select", {
      style: "padding:8px 10px;border:1px solid var(--hairline);border-radius:8px;" +
             "background:var(--surface);color:var(--ink);",
    }, ...[1, 2, 3, 4, 5].map((n) => el("option", { value: n }, `${n}`)));
    const confirmInput = el("input", {
      type: "text", placeholder: "Type LIST to arm the button",
      autocomplete: "off", autocapitalize: "characters", spellcheck: "false",
      style: "width:100%;padding:8px 10px;margin-top:8px;border:1px solid var(--hairline);" +
             "border-radius:8px;background:var(--surface);color:var(--ink);",
    });
    const status = el("p", { class: "meta" }, "");
    const queueBtn = el("button", { class: "btn", disabled: "" },
      "Queue Takealot offer");
    confirmInput.addEventListener("input", () => {
      if (confirmInput.value.trim() === "LIST") queueBtn.removeAttribute("disabled");
      else queueBtn.setAttribute("disabled", "");
    });
    queueBtn.addEventListener("click", async () => {
      queueBtn.setAttribute("disabled", "");
      confirmInput.setAttribute("disabled", "");
      status.textContent = "Committing listing intent…";
      const entry = {
        asin: row.id, channel: "takealot",
        quantity: Number(qtySelect.value), source: "dashboard",
        requested_at: new Date().toISOString(),
        ...handle,
      };
      try {
        await mutateCommands((doc) => pushListing(doc, entry),
          `Dashboard: takealot ${row.id}`);
        status.textContent =
          "✅ Intent committed. The pipeline prices it against the landed-" +
          "cost floor and readies the offer; nothing POSTs to Takealot " +
          "until TAKEALOT_ENABLED=1 in .env. State appears in the intents " +
          "table on the next refresh.";
        queueBtn.replaceWith(el("button", {
          class: "btn ghost", onclick: () => dialog.close() }, "Done"));
      } catch (e) {
        status.textContent = `Failed: ${e.message}`;
        if (/401|403/.test(e.message)) localStorage.removeItem(PAT_KEY);
        confirmInput.removeAttribute("disabled");
      }
    });
    dialog.replaceChildren(
      el("h3", {}, "List on Takealot"),
      el("p", { class: "meta" }, row.title || row.id),
      el("p", { class: "meta" }, handle.barcode
        ? `barcode ${handle.barcode} (captured by takealot-enrich) — the ` +
          "offer attaches to the existing catalog product"
        : `PLID ${handle.plid} — the pipeline fetches the barcode from the ` +
          "product page server-side, then the offer attaches to it"),
      el("p", { class: "meta" },
        "⚠ Offers on a real barcode cannot be deleted via the API — only " +
        "disabled in the Seller Portal. Queue products you actually want " +
        "to sell."),
      el("div", { style: "margin:8px 0" }, "Stock quantity: ", qtySelect),
      confirmInput,
      el("div", { style: "margin-top:10px" },
        queueBtn, " ",
        el("button", { class: "btn ghost", onclick: () => dialog.close() }, "Cancel")),
      status);
    dialog.showModal();
  });
}

/* Action cell for the two Takealot shelves: the existing intent's state
   when one is queued, the List button when the road is clear, Requeue
   when the intent parked. */
function shelfAction(row, handle, statusEl) {
  if (row.intent && !PARKED.has(row.intent.state)) {
    return stateChip(row.intent.state);
  }
  if (row.intent) {
    return el("span", {}, stateChip(row.intent.state), " ",
      el("button", {
        class: "btn ghost", title: row.intent.note || "",
        onclick: () => commitEntry({
          asin: row.id, channel: "takealot", requeue: true,
          requested_at: new Date().toISOString(),
        }, `requeue ${row.id}`, statusEl),
      }, "Requeue"));
  }
  return el("button", {
    class: "btn order", onclick: () => listOnTakealot(row, handle),
  }, "List on Takealot");
}

function intentTable(intents, channel, statusEl, { withMargin = false } = {}) {
  const table = el("table", { class: "data" },
    el("tr", {},
      el("th", {}, "product"), el("th", {}, "state"),
      el("th", {}, "price"), withMargin ? el("th", {}, "margin") : null,
      el("th", {}, "when"), el("th", {}, "last note"), el("th", {}, "")));
  for (const it of intents) {
    table.append(el("tr", {},
      el("td", { class: "t" },
        el("span", { title: it.id }, it.title || it.asin || it.id)),
      el("td", { class: "t" }, stateChip(it.state)),
      el("td", {}, it.list_price != null ? fmtR(it.list_price) : "—"),
      withMargin
        ? el("td", {}, it.takealot_margin_percent != null
            ? `${it.takealot_margin_percent}%` : "—")
        : null,
      el("td", { class: "t" }, fmtAgo(it.received_at)),
      el("td", { class: "t" }, it.note ?? ""),
      el("td", { class: "t" }, PARKED.has(it.state)
        ? el("button", {
            class: "btn ghost",
            onclick: () => commitEntry({
              asin: it.asin, channel, requeue: true,
              requested_at: new Date().toISOString(),
            }, `requeue ${it.asin}`, statusEl),
          }, "Requeue")
        : "")));
  }
  return el("div", { class: "scroll-x" }, table);
}

/* ---- Amazon tab ---- */

// /gtinx is retired — the exemption is applied for inside Add products.
const GTIN_FORM_URL = "https://sellercentral.amazon.co.za/product-search";
const APPS_DASHBOARD_URL = "https://sellercentral.amazon.co.za/hz/myqdashboard";

/* Seller Central to-dos: the two manual approval queues the pipeline can
   prepare but never click through — per-productType GTIN exemptions and
   per-ASIN "Apply to sell" links (captured by the restrictions gate, which
   re-polls every 24h and unblocks granted ones on its own). "Mark granted"
   records the grant on the bus — no pipeline-machine CLI needed. */
function todosPanel(todos) {
  const exemptions = todos.exemptions || [];
  const restricted = todos.restricted || [];
  const compliance = todos.compliance || [];
  const body = el("div", {});
  const status = el("div", { class: "hint", style: "margin-top:8px" });

  if (!exemptions.length && !restricted.length && !compliance.length) {
    body.append(el("div", { class: "chip good" }, el("span", { class: "dot" }),
      "nothing awaiting manual approval"));
  }

  for (const ex of exemptions) {
    body.append(el("div", { style: "margin-bottom:8px" },
      el("span", { class: "chip warning", style: "margin-right:10px" },
        el("span", { class: "dot" }),
        `GTIN exemption needed: ${ex.product_type} — ${ex.count} intent${ex.count > 1 ? "s" : ""}`),
      el("span", { class: "t", style: "margin-right:10px" },
        (ex.asins || []).join(", ")),
      el("a", {
        class: "btn ghost", href: GTIN_FORM_URL,
        target: "_blank", rel: "noopener", style: "margin-right:8px",
      }, "Apply for exemption ↗"),
      el("button", {
        class: "btn ghost",
        onclick: () => commitEntry({
          grant: ex.product_type,
          requested_at: new Date().toISOString(),
        }, `grant ${ex.product_type}`, status),
      }, "✓ Mark granted")));
  }
  if (exemptions.length) {
    body.append(el("div", { class: "hint" },
      "Brand “Generic” + the category; needs 2–9 photos of the PHYSICAL " +
      "product showing no branding (supplier photos/mockups fail), ~48h " +
      "review. Once Seller Central approves, hit “Mark granted” — blocked " +
      "intents re-prepare on the next listings pass."));
  }

  if (restricted.length) {
    const table = el("table", { class: "data" },
      el("tr", {}, el("th", {}, "asin"), el("th", {}, "score"),
         el("th", {}, "restriction"), el("th", {}, ""),
         el("th", {}, "checked")));
    for (const r of restricted) {
      const link = (r.links || [])[0];
      table.append(el("tr", {},
        el("td", { class: "t" }, el("a", {
          href: `https://www.amazon.co.za/dp/${r.asin}`,
          target: "_blank", rel: "noopener",
        }, r.asin)),
        el("td", {}, r.score != null ? String(Math.round(r.score)) : "—"),
        el("td", { class: "t" },
          (r.reason || "").replace(/^APPROVAL_REQUIRED:\s*/, "")),
        el("td", { class: "t" }, link
          ? el("a", { class: "btn ghost", href: link.url,
                      target: "_blank", rel: "noopener" }, "Apply ↗")
          : "no form (not accepting applications)"),
        el("td", { class: "t" }, fmtAgo(r.checked_at))));
    }
    body.append(el("div", { class: "scroll-x", style: "margin-top:10px" }, table));
    body.append(el("div", { class: "hint" },
      "Auto-granted ones cost one click; invoice-walled ones can be skipped " +
      "— the 24h re-poll unblocks and requeues granted ASINs by itself."));
  }

  /* ZA compliance decisions (services/compliance.py): blocked = a
     regulator's approval is legally required (score hard-gated to 0),
     review = elevated CPA-s61 liability, informational. "Mark cleared"
     records approval-obtained / risk-accepted / classifier-wrong on the
     bus — the gate lifts and parked intents un-park on their own. */
  if (compliance.length) {
    const table = el("table", { class: "data" },
      el("tr", {}, el("th", {}, "asin"), el("th", {}, "risk"),
         el("th", {}, "needs / flags"), el("th", {}, "why"),
         el("th", {}, "score"), el("th", {}, "")));
    for (const c of compliance) {
      const needs = [...(c.requires || []), ...(c.flags || [])]
        .map((k) => k.replace(/_/g, " ")).join(", ");
      table.append(el("tr", {},
        el("td", { class: "t" }, el("a", {
          href: `https://www.amazon.co.za/dp/${c.asin}`,
          target: "_blank", rel: "noopener",
        }, c.asin)),
        el("td", {}, el("span", {
          class: `chip ${c.risk === "blocked" ? "bad" : "warning"}`,
        }, el("span", { class: "dot" }), c.risk)),
        el("td", { class: "t" }, needs || "—"),
        el("td", { class: "t" }, c.reason || "—"),
        el("td", {}, c.score != null ? String(Math.round(c.score)) : "—"),
        el("td", {}, el("button", {
          class: "btn ghost",
          onclick: () => commitEntry({
            compliance_clear: c.asin,
            requested_at: new Date().toISOString(),
          }, `clear ${c.asin}`, status),
        }, "✓ Mark cleared"))));
    }
    body.append(el("div", { style: "margin-top:10px" },
      el("b", {}, "ZA compliance (ICASA / NRCS / liability)")),
      el("div", { class: "scroll-x" }, table),
      el("div", { class: "hint" },
        "blocked = illegal to sell without the approval (ICASA radio / " +
        "NRCS mains LOA) — the pipeline zero-scores it until cleared; " +
        "review = sellable but you carry CPA s61 importer liability. " +
        "“Mark cleared” = approval obtained, risk accepted, or the " +
        "classifier got it wrong."));
  }

  const footer = el("div", { style: "margin-top:10px" });
  for (const g of todos.granted || []) {
    footer.append(el("span", { class: "chip good", style: "margin-right:8px" },
      el("span", { class: "dot" }), `exemption granted: ${g}`));
  }
  footer.append(el("a", {
    class: "btn ghost", href: APPS_DASHBOARD_URL,
    target: "_blank", rel: "noopener",
  }, "All selling applications ↗"));
  body.append(footer, status);

  return panel("Seller Central to-dos", body);
}

function amazonTab(root, data) {
  root.append(todosPanel(data.todos || {}));

  const az = data.amazon || {};
  const body = el("div", {});
  const status = el("div", { class: "hint", style: "margin-top:8px" });
  body.append(el("div", { style: "margin-bottom:10px" },
    enabledChip(az.enabled, "Amazon listing")));
  body.append((az.intents || []).length
    ? intentTable(az.intents, "amazon", status)
    : el("div", { class: "chip neutral" }, el("span", { class: "dot" }),
        "no Amazon listing intents — placed orders auto-create them, or " +
        "queue one by ASIN below"));

  // Manual queue-by-ASIN: the web twin of listing_admin.py intent <ASIN>.
  const asinInput = el("input", {
    type: "text", placeholder: "ASIN (e.g. B0ABC12345)",
    autocomplete: "off", spellcheck: "false",
    style: "padding:8px 10px;margin-right:8px;border:1px solid var(--hairline);" +
           "border-radius:8px;background:var(--surface);color:var(--ink);",
  });
  const qtySelect = el("select", {
    style: "padding:8px 10px;margin-right:8px;border:1px solid var(--hairline);" +
           "border-radius:8px;background:var(--surface);color:var(--ink);",
  }, ...[1, 2, 3, 4, 5].map((n) => el("option", { value: n }, `qty ${n}`)));
  body.append(el("div", { style: "margin-top:12px" },
    asinInput, qtySelect,
    el("button", {
      class: "btn ghost", onclick: () => {
        const asin = asinInput.value.trim().toUpperCase();
        if (!/^[A-Z0-9]{10}$/.test(asin)) {
          status.textContent = "That doesn't look like an ASIN (10 chars).";
          return;
        }
        commitEntry({
          asin, channel: "amazon", quantity: Number(qtySelect.value),
          source: "dashboard", requested_at: new Date().toISOString(),
        }, `queue Amazon intent ${asin}`, status);
        asinInput.value = "";
      },
    }, "Queue listing intent")),
    status);
  root.append(panel("Amazon listing intents", body));
  root.append(salesPanel(az.sales, "Amazon"));
}

/* ---- Takealot tab ---- */

function takealotTab(root, data) {
  const tk = data.takealot || {};
  const status = el("div", { class: "hint", style: "margin-top:8px" });

  // Discovery output first: what the funnel says is worth selling there.
  const offerBody = el("div", {});
  if ((tk.offerable || []).length) {
    const table = el("table", { class: "data" },
      el("tr", {},
        el("th", {}, "product"), el("th", {}, "score"),
        el("th", {}, "margin"), el("th", {}, "their price"),
        el("th", {}, "offers"), el("th", {}, "barcode"), el("th", {}, "")));
    for (const o of tk.offerable) {
      table.append(el("tr", {},
        el("td", { class: "t" }, o.url
          ? el("a", { href: o.url, target: "_blank", rel: "noopener" },
              o.title || o.id)
          : (o.title || o.id)),
        el("td", {}, o.score != null ? String(Math.round(o.score)) : "—"),
        el("td", {}, `${fmtR(o.margin_total)} · ${o.margin_percent ?? "—"}%`),
        el("td", {}, fmtR(o.takealot_price)),
        el("td", { class: "t" }, o.offer_count != null
          ? `${o.offer_count}${o.seller ? ` (${o.seller})` : ""}` : "—"),
        el("td", { class: "t" }, o.barcode
          ? el("code", {}, o.barcode) : "—"),
        el("td", { class: "t" }, o.barcode
          ? shelfAction(o, { barcode: o.barcode }, status)
          : "")));
    }
    offerBody.append(el("div", { class: "scroll-x" }, table));
    offerBody.append(el("div", { class: "hint", style: "margin-top:8px" },
      "Discovery winners with the offer stack + barcode captured " +
      "(takealot-enrich). Queueing here commits the intent; the offer only " +
      "POSTs once TAKEALOT_ENABLED=1 in .env on the pipeline machine."));
  } else {
    offerBody.append(el("div", { class: "chip neutral" },
      el("span", { class: "dot" }),
      "no enriched Takealot winners yet — run pull-takealot, let a funnel " +
      "run carry the docs through, then takealot-enrich"));
  }
  root.append(panel("Ready to offer (discovery winners)", offerBody));

  // Amazon winners the match stage tied to an existing Takealot product:
  // piggyback candidates, offerable by PLID.
  const matchedBody = el("div", {});
  if ((tk.matched || []).length) {
    const table = el("table", { class: "data" },
      el("tr", {},
        el("th", {}, "product"), el("th", {}, "score"),
        el("th", {}, "margin"), el("th", {}, "Amazon"),
        el("th", {}, "Takealot"), el("th", {}, "offers"), el("th", {}, "")));
    for (const m of tk.matched) {
      table.append(el("tr", {},
        el("td", { class: "t" }, m.url
          ? el("a", { href: m.url, target: "_blank", rel: "noopener" },
              m.title || m.id)
          : (m.title || m.id)),
        el("td", {}, m.score != null ? String(Math.round(m.score)) : "—"),
        el("td", {}, `${fmtR(m.margin_total)} · ${m.margin_percent ?? "—"}%`),
        el("td", {}, fmtR(m.amazon_price)),
        el("td", {}, fmtR(m.takealot_price)),
        el("td", { class: "t" }, m.offer_count != null
          ? `${m.offer_count}${m.seller ? ` (${m.seller})` : ""}` : "—"),
        el("td", { class: "t" }, shelfAction(m, { plid: m.plid }, status))));
    }
    matchedBody.append(el("div", { class: "scroll-x" }, table));
    matchedBody.append(el("div", { class: "hint", style: "margin-top:8px" },
      "Amazon-discovered winners already in Takealot's catalog " +
      "(takealot-match). The pipeline fetches the barcode from the product " +
      "page when you queue one — never guessed, never probed."));
  } else {
    matchedBody.append(el("div", { class: "chip neutral" },
      el("span", { class: "dot" }),
      "no catalog matches yet — run takealot-match on the winners " +
      "(admin → Run stage)"));
  }
  root.append(panel("On Takealot already (matched winners)", matchedBody));

  const body = el("div", {});
  body.append(el("div", { style: "margin-bottom:10px" },
    enabledChip(tk.enabled, "Takealot offer")));
  const loadsheet = (tk.intents || []).filter((i) => i.state === "loadsheet");
  if (loadsheet.length) {
    body.append(el("div", { style: "margin-bottom:10px" },
      el("span", { class: "chip warning", style: "margin-right:8px" },
        el("span", { class: "dot" }),
        `${loadsheet.length} intent${loadsheet.length > 1 ? "s" : ""} on the loadsheet`),
      tk.loadsheet
        ? el("button", {
            class: "btn ghost", style: "margin-right:8px",
            onclick: () => downloadLoadsheet(tk.loadsheet),
          }, "⬇ Download loadsheet CSV")
        : null,
      el("span", { class: "hint" },
        "upload in the Seller Portal (Add New Products); approval is " +
        "auto-detected by SKU poll — no further step here")));
  }
  body.append((tk.intents || []).length
    ? intentTable(tk.intents, "takealot", status, { withMargin: true })
    : el("div", { class: "chip neutral" }, el("span", { class: "dot" }),
        "no Takealot listing intents — queue winners from the shelves above"));
  body.append(status);
  root.append(panel("Takealot listing intents", body));

  root.append(accountPanel(tk.account));
  root.append(salesPanel(tk.sales, "Takealot"));
}

/* Own-channel sales (services/own_sales.py polls both seller APIs every
   6h): counts + newest rows, or an honest "checked Xh ago — nothing sold
   yet" while the ledger is empty. */
function salesPanel(sales, label) {
  const body = el("div", {});
  const counts = (sales || {}).counts || {};
  const recent = (sales || {}).recent || [];
  if (Object.keys(counts).length) {
    const chips = el("div", { style: "margin-bottom:10px" });
    for (const [state, n] of Object.entries(counts)) {
      chips.append(el("span", { class: "chip good", style: "margin-right:8px" },
        el("span", { class: "dot" }), `${state}: ${n}`));
    }
    body.append(chips);
  }
  if (recent.length) {
    const shippable = label === "Amazon";
    const table = el("table", { class: "data" },
      el("tr", {}, el("th", {}, "order"), el("th", {}, "product"),
         el("th", {}, "qty"), el("th", {}, "price"), el("th", {}, "state"),
         el("th", {}, "when"),
         shippable ? el("th", {}, "fulfilment") : null));
    for (const s of recent) {
      table.append(el("tr", {},
        el("td", { class: "t" }, s.order_id),
        el("td", { class: "t" }, s.title || s.sku || "—"),
        el("td", {}, fmtNum(s.quantity)),
        el("td", {}, fmtR(s.selling_price)),
        el("td", { class: "t" }, s.state ?? "—"),
        el("td", { class: "t" }, fmtAgo(s.ordered_at)),
        shippable ? el("td", { class: "t" }, shipCell(s)) : null));
    }
    body.append(el("div", { class: "scroll-x" }, table));
  } else {
    body.append(el("div", { class: "chip neutral" },
      el("span", { class: "dot" }),
      (sales || {}).polled_at
        ? `nothing sold yet — ${label} checked ${fmtAgo(sales.polled_at)}`
        : `no sales data yet — the 'sales' poll runs every 6h once serve ` +
          "is on the new code"));
  }
  return panel(`Sales — ${label}`, body);
}

/* MFN fulfilment cell + form. ZA has no buy-shipping API, so the label is
   bought at the courier by hand; the form's entry rides doc.shipments on
   the command bus and funnel/commands.sink_shipments POSTs the Orders API
   shipmentConfirmation. Confirming on time is what keeps Late Shipment
   (<4%) and Valid Tracking (>=95%) intact. */
function shipCell(s) {
  if (s.fulfillment === "AFN") return "FBA";
  if (s.ship_confirmed_at) {
    return el("span", { class: "chip good" }, el("span", { class: "dot" }),
      `🚚 confirmed${s.ship_tracking ? ` · ${s.ship_tracking}` : ""}`);
  }
  if (!["Unshipped", "PartiallyShipped"].includes(s.state)) return "—";
  const cell = el("span", {});
  if (s.ship_confirm_error) {
    cell.append(el("span", {
      class: "chip critical", style: "margin-right:8px",
      title: s.ship_confirm_error,
    }, el("span", { class: "dot" }), "confirm failed — retry"));
  }
  cell.append(el("button", { class: "btn", onclick: () => confirmShipModal(s) },
    "🚚 Confirm shipment"));
  if (s.latest_ship_date) {
    cell.append(el("div", { class: "meta" },
      `ship by ${fmtDate(s.latest_ship_date)}`));
  }
  return cell;
}

function confirmShipModal(s) {
  withToken(() => {
    const dialog = document.getElementById("act-modal");
    const inputStyle =
      "width:100%;padding:8px 10px;margin:8px 0;border:1px solid " +
      "var(--hairline);border-radius:8px;background:var(--surface);" +
      "color:var(--ink);";
    const carrier = el("input", {
      type: "text", placeholder: "Courier (e.g. The Courier Guy)",
      style: inputStyle });
    const tracking = el("input", {
      type: "text", placeholder: "Tracking / waybill number",
      style: inputStyle });
    const status = el("p", { class: "meta" }, "");
    const confirmBtn = el("button", { class: "btn" }, "Confirm shipment");
    confirmBtn.addEventListener("click", async () => {
      const trackingNo = tracking.value.trim();
      if (!trackingNo) {
        status.textContent =
          "Tracking number required — it feeds Valid Tracking Rate.";
        return;
      }
      confirmBtn.setAttribute("disabled", "");
      status.textContent = "Committing shipment confirmation…";
      try {
        await mutateCommands((doc) => {
          doc.shipments = (doc.shipments || []).filter((x) =>
            x.requested_at &&
            Date.now() - new Date(x.requested_at) < 2 * 864e5);
          doc.shipments.push({
            order_id: s.order_id, carrier: carrier.value.trim(),
            tracking: trackingNo,
            requested_at: new Date().toISOString() });
        }, `Dashboard: confirm shipment ${s.order_id}`);
        status.textContent = "✅ Committed — the pipeline POSTs the " +
          "confirmation to Amazon within ~30s while serve is up; the row " +
          "flips once it lands.";
        confirmBtn.replaceWith(el("button", {
          class: "btn ghost", onclick: () => dialog.close() }, "Done"));
      } catch (e) {
        status.textContent = `Failed: ${e.message}`;
        if (/401|403/.test(e.message)) localStorage.removeItem(PAT_KEY);
        confirmBtn.removeAttribute("disabled");
      }
    });
    dialog.replaceChildren(
      el("h3", {}, "Confirm shipment"),
      el("p", { class: "meta" },
        `Amazon order ${s.order_id}${s.title ? ` — ${s.title}` : ""}. ` +
        "Buy the courier label first, then enter its details; the " +
        "pipeline calls the Orders API confirmShipment." +
        (s.latest_ship_date
          ? ` Ship-by date: ${fmtDate(s.latest_ship_date)}.` : "")),
      carrier, tracking,
      confirmBtn, " ",
      el("button", { class: "btn ghost", onclick: () => dialog.close() },
        "Close"),
      status);
    dialog.showModal();
  });
}

/* What's actually live under the Takealot account (GET /offers mirror):
   buyable count, disabled offers, wishlist demand, low-stock flags (stock
   fields appear once offers carry warehouse stock). */
const OFFER_STATUS_CHIP = {
  buyable: "good", not_buyable: "warning",
  disabled_by_seller: "neutral", disabled_by_takealot: "serious",
};

function accountPanel(account) {
  const body = el("div", {});
  if (!account) {
    body.append(el("div", { class: "chip neutral" }, el("span", { class: "dot" }),
      "not checked yet — the 'sales' poll mirrors the account's offer " +
      "list every 6h"));
    return panel("On Takealot (account offers)", body);
  }
  const chips = el("div", { style: "margin-bottom:10px" });
  chips.append(el("span", { class: "chip good", style: "margin-right:8px" },
    el("span", { class: "dot" }),
    `${(account.counts || {}).buyable || 0} buyable of ${account.total} offers`));
  for (const [status, n] of Object.entries(account.counts || {})) {
    if (status === "buyable") continue;
    chips.append(el("span", {
      class: `chip ${OFFER_STATUS_CHIP[status] || "neutral"}`,
      style: "margin-right:8px",
    }, el("span", { class: "dot" }), `${status}: ${n}`));
  }
  body.append(chips);

  for (const low of account.low_stock || []) {
    body.append(el("div", { style: "margin-bottom:6px" },
      el("span", { class: "chip serious" }, el("span", { class: "dot" }),
        `LOW STOCK: ${low.title || low.sku} — ${low.stock} left`)));
  }

  if ((account.rows || []).length) {
    const table = el("table", { class: "data" },
      el("tr", {}, el("th", {}, "offer"), el("th", {}, "status"),
         el("th", {}, "price"), el("th", {}, "stock"),
         el("th", {}, "wishlist 30d"), el("th", {}, "returns 30d")));
    for (const o of account.rows) {
      table.append(el("tr", {},
        el("td", { class: "t" }, o.url
          ? el("a", { href: o.url, target: "_blank", rel: "noopener" },
              o.title || o.sku)
          : (o.title || o.sku)),
        el("td", { class: "t" }, el("span", {
          class: `chip ${OFFER_STATUS_CHIP[o.status] || "neutral"}`,
        }, el("span", { class: "dot" }), o.status || "?")),
        el("td", {}, fmtR(o.selling_price)),
        el("td", {}, o.stock ?? "—"),
        el("td", {}, fmtNum(o.wishlist_30d)),
        el("td", {}, fmtNum(o.returned_30d))));
    }
    body.append(el("div", { class: "scroll-x" }, table));
  }
  body.append(el("div", { class: "hint", style: "margin-top:8px" },
    `checked ${fmtAgo(account.checked_at)} — stock column fills once ` +
    "offers carry warehouse stock (today's are leadtime-model)"));
  return panel("On Takealot (account offers)", body);
}

/* The loadsheet CSV rides the encrypted payload — hand it to the browser
   as a download so the portal upload needs no pipeline-machine access. */
function downloadLoadsheet(loadsheet) {
  const blob = new Blob([loadsheet.csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: "takealot_loadsheet.csv" });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---- render ---- */

function renderTabs() {
  const nav = document.getElementById("tabs");
  const data = lastData || {};
  const azCount = ((data.amazon || {}).intents || []).length
    + ((data.todos || {}).restricted || []).length
    + ((data.todos || {}).exemptions || []).length;
  const tkCount = ((data.takealot || {}).intents || []).length
    + ((data.takealot || {}).offerable || []).length
    + ((data.takealot || {}).matched || []).length;
  nav.hidden = false;
  const tab = (id, label) => el("button", {
    class: `tab${activeChannel === id ? " active" : ""}`,
    onclick: () => {
      if (activeChannel === id) return;
      activeChannel = id;
      renderTabs();
      renderPanels();
    },
  }, label);
  nav.replaceChildren(
    tab("amazon", `Amazon (${azCount})`),
    tab("takealot", `Takealot (${tkCount})`));
}

function renderPanels() {
  const root = document.getElementById("dash");
  root.replaceChildren();
  if (!lastData) return;
  if (activeChannel === "takealot") takealotTab(root, lastData);
  else amazonTab(root, lastData);
}

function renderMeta(data) {
  updateStaleness(document.getElementById("stale"), data.generated_at, 24 * 60);
  const az = ((data.amazon || {}).intents || []).length;
  const tk = ((data.takealot || {}).intents || []).length;
  document.getElementById("meta").textContent =
    `${az} Amazon · ${tk} Takealot intents · updated ${fmtAgo(data.generated_at)}`;
}

function render(data) {
  renderMeta(data);
  lastData = data;
  renderTabs();
  renderPanels();
}

function panel(title, body) {
  return el("section", { class: "panel" }, el("h2", {}, title), body);
}

/* ---- boot: passphrase gate over seller.enc ---- */

/* Identical ciphertext = identical payload (the publisher is hash-gated):
   skip the PBKDF2 decrypt and the DOM rebuild — rebuilds reset the active
   tab's scroll, typed prices and status lines. Only set after a successful
   decrypt: a wrong passphrase must keep hitting the gate. */
let lastCiphertext = null;

async function loadAndRender(passphrase) {
  const envelope = await fetchJson("seller.enc");
  if (lastCiphertext && envelope.ciphertext === lastCiphertext) {
    if (lastData) renderMeta(lastData);   // the clock lines keep aging
    return;
  }
  const data = await decryptEnvelope(envelope, passphrase);
  lastCiphertext = envelope.ciphertext;
  document.getElementById("gate").hidden = true;
  document.getElementById("main").hidden = false;
  render(data);
}

async function boot() {
  const gateError = document.getElementById("gate-error");
  const input = document.getElementById("pass-input");
  const stored = localStorage.getItem(PASS_KEY);

  async function attempt(passphrase, remember) {
    try {
      await loadAndRender(passphrase);
      if (remember) localStorage.setItem(PASS_KEY, passphrase);
      await adoptBusToken(passphrase);  // gate passphrase = bus credential
      setInterval(async () => {
        try { await loadAndRender(passphrase); } catch (e) { console.warn(e); }
      }, REFRESH_MS);
      // Live layer (no-op when off): refresh the moment a publish lands.
      liveConnect(async (name) => {
        if (name !== "seller.enc") return;
        try { await loadAndRender(passphrase); } catch (e) { console.warn(e); }
      });
      return true;
    } catch (e) {
      localStorage.removeItem(PASS_KEY);
      gateError.textContent = e.name === "OperationError"
        ? "Wrong passphrase." : `Could not load data: ${e.message}`;
      return false;
    }
  }

  document.getElementById("gate-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    gateError.textContent = "";
    await attempt(input.value, true);
  });

  if (stored) await attempt(stored, false);
}

boot();
