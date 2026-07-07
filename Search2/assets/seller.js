/* Seller page: listings & approvals per channel. Fetches seller.enc,
   decrypts (common.js), renders read-only panels — Amazon listing intents
   + Seller Central to-dos on one tab, Takealot intents + loadsheet + the
   "ready to offer" discovery shelf on the other. Mutating controls (kill
   switches, run control) deliberately live on /admin only. */

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

function intentTable(intents, { withMargin = false } = {}) {
  const table = el("table", { class: "data" },
    el("tr", {},
      el("th", {}, "product"), el("th", {}, "state"),
      el("th", {}, "price"), withMargin ? el("th", {}, "margin") : null,
      el("th", {}, "when"), el("th", {}, "last note")));
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
      el("td", { class: "t" }, it.note ?? "")));
  }
  return el("div", { class: "scroll-x" }, table);
}

/* ---- Amazon tab ---- */

const GTIN_FORM_URL = "https://sellercentral.amazon.co.za/gtinx";
const APPS_DASHBOARD_URL = "https://sellercentral.amazon.co.za/hz/myqdashboard";

/* Seller Central to-dos: the two manual approval queues the pipeline can
   prepare but never click through — per-productType GTIN exemptions and
   per-ASIN "Apply to sell" links (captured by the restrictions gate, which
   re-polls every 24h and unblocks granted ones on its own). */
function todosPanel(todos) {
  const exemptions = todos.exemptions || [];
  const restricted = todos.restricted || [];
  const body = el("div", {});

  if (!exemptions.length && !restricted.length) {
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
        target: "_blank", rel: "noopener",
      }, "Apply for exemption ↗")));
  }
  if (exemptions.length) {
    body.append(el("div", { class: "hint" },
      "Brand “Generic” + the category; needs 2–9 photos of the PHYSICAL " +
      "product showing no branding (supplier photos/mockups fail), ~48h review. " +
      "After approval run ", el("code", {}, "python scripts/listing_admin.py grant <TYPE>"),
      " on the pipeline machine."));
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

  const footer = el("div", { style: "margin-top:10px" });
  for (const g of todos.granted || []) {
    footer.append(el("span", { class: "chip good", style: "margin-right:8px" },
      el("span", { class: "dot" }), `exemption granted: ${g}`));
  }
  footer.append(el("a", {
    class: "btn ghost", href: APPS_DASHBOARD_URL,
    target: "_blank", rel: "noopener",
  }, "All selling applications ↗"));
  body.append(footer);

  return panel("Seller Central to-dos", body);
}

function amazonTab(root, data) {
  root.append(todosPanel(data.todos || {}));

  const az = data.amazon || {};
  const body = el("div", {});
  body.append(el("div", { style: "margin-bottom:10px" },
    enabledChip(az.enabled, "Amazon listing")));
  body.append((az.intents || []).length
    ? intentTable(az.intents)
    : el("div", { class: "chip neutral" }, el("span", { class: "dot" }),
        "no Amazon listing intents — placed orders auto-create them; " +
        "manual: scripts/listing_admin.py list <ASIN>"));
  root.append(panel("Amazon listing intents", body));
}

/* ---- Takealot tab ---- */

function takealotTab(root, data) {
  const tk = data.takealot || {};

  // Discovery output first: what the funnel says is worth selling there.
  const offerBody = el("div", {});
  if ((tk.offerable || []).length) {
    const table = el("table", { class: "data" },
      el("tr", {},
        el("th", {}, "product"), el("th", {}, "score"),
        el("th", {}, "margin"), el("th", {}, "their price"),
        el("th", {}, "offers"), el("th", {}, "barcode")));
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
          ? el("code", {}, o.barcode) : "—")));
    }
    offerBody.append(el("div", { class: "scroll-x" }, table));
    offerBody.append(el("div", { class: "hint", style: "margin-top:8px" },
      "Discovery winners with the offer stack + barcode captured " +
      "(takealot-enrich). Queue one with ",
      el("code", {}, "python scripts/listing_admin.py takealot <id> --barcode <ean>"),
      " on the pipeline machine — offers on an existing barcode CANNOT be " +
      "deleted via the API, so this stays a deliberate manual step."));
  } else {
    offerBody.append(el("div", { class: "chip neutral" },
      el("span", { class: "dot" }),
      "no enriched Takealot winners yet — run pull-takealot, let a funnel " +
      "run carry the docs through, then takealot-enrich"));
  }
  root.append(panel("Ready to offer (discovery winners)", offerBody));

  const body = el("div", {});
  body.append(el("div", { style: "margin-bottom:10px" },
    enabledChip(tk.enabled, "Takealot offer")));
  const loadsheet = (tk.intents || []).filter((i) => i.state === "loadsheet");
  if (loadsheet.length) {
    body.append(el("div", { style: "margin-bottom:10px" },
      el("span", { class: "chip warning", style: "margin-right:8px" },
        el("span", { class: "dot" }),
        `${loadsheet.length} intent${loadsheet.length > 1 ? "s" : ""} on the loadsheet`),
      el("span", { class: "hint" },
        "upload data/takealot_loadsheet.csv in the Seller Portal; approval " +
        "is auto-detected by SKU poll")));
  }
  body.append((tk.intents || []).length
    ? intentTable(tk.intents, { withMargin: true })
    : el("div", { class: "chip neutral" }, el("span", { class: "dot" }),
        "no Takealot listing intents — queue winners with " +
        "scripts/listing_admin.py takealot <ASIN>"));
  root.append(panel("Takealot listing intents", body));
}

/* ---- render ---- */

function renderTabs() {
  const nav = document.getElementById("tabs");
  const data = lastData || {};
  const azCount = ((data.amazon || {}).intents || []).length
    + ((data.todos || {}).restricted || []).length
    + ((data.todos || {}).exemptions || []).length;
  const tkCount = ((data.takealot || {}).intents || []).length
    + ((data.takealot || {}).offerable || []).length;
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

function render(data) {
  updateStaleness(document.getElementById("stale"), data.generated_at, 24 * 60);
  const az = ((data.amazon || {}).intents || []).length;
  const tk = ((data.takealot || {}).intents || []).length;
  document.getElementById("meta").textContent =
    `${az} Amazon · ${tk} Takealot intents · updated ${fmtAgo(data.generated_at)}`;
  lastData = data;
  renderTabs();
  renderPanels();
}

function panel(title, body) {
  return el("section", { class: "panel" }, el("h2", {}, title), body);
}

/* ---- boot: passphrase gate over seller.enc ---- */

async function loadAndRender(passphrase) {
  const envelope = await fetchJson("seller.enc");
  const data = await decryptEnvelope(envelope, passphrase);
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
