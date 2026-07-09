/* Search2 App — shell for the six-desk console.
   Decrypts all three published payloads (admin.enc + buyer.enc + seller.enc)
   behind one passphrase gate and renders one desk at a time; every action
   commits to the same command bus the legacy pages use (common.js
   mutateCommands), so /app can run alongside /buyer /seller /admin during
   the cutover. Desk renderers live in app-<desk>.js; this file owns state,
   data plumbing, the status bar, the rail, modals and shared UI helpers. */

const REFRESH_MS = 60_000;

const DESKS = [
  ["today", "Today"],
  ["buy", "Buy"],
  ["stock", "Stock"],
  ["sell", "Sell"],
  ["machine", "Machine"],
  ["books", "Books"],
];

const S = {
  desk: (location.hash || "").replace("#", "") || "today",
  admin: null, buyer: null, seller: null,
  commands: null,           // last token-gated read of the commands doc
  passphrase: null,
  // per-desk UI state survives re-renders
  buyTab: "amazon", buySearch: "", buySort: "score", buySel: null,
  sellTab: "amazon",
  stockOpen: false,
};

const CIPHERS = {};          // name -> last decrypted ciphertext

/* ---------- tiny DOM + format helpers (el/fmt* come from common.js) ---------- */

function fmtDur(seconds) {
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
}

function fmtIn(iso) {
  if (!iso) return "—";
  const min = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (min <= 0) return "now";
  if (min < 60) return `in ${min}m`;
  if (min < 48 * 60) return `in ${Math.floor(min / 60)}h ${min % 60}m`;
  return `in ${Math.floor(min / 1440)}d`;
}

/* "in 18h" urgency coloring for deadline cells */
function dueTone(iso) {
  if (!iso) return "";
  const h = (new Date(iso).getTime() - Date.now()) / 3600e3;
  if (h <= 24) return "bad";
  if (h <= 96) return "warn";
  return "";
}

function agoSpan(iso, prefix = "") {
  return el("span", { "data-ago": iso || "" },
    iso ? `${prefix}${fmtAgo(iso)}` : "—");
}

function tickAgo() {
  document.querySelectorAll("[data-ago]").forEach((node) => {
    const iso = node.getAttribute("data-ago");
    if (iso) node.textContent = node.textContent.replace(/(?:just now|\d+[mhd].*ago)$/, fmtAgo(iso));
  });
}

function pill(cls, ...children) {
  return el("span", { class: `pill ${cls}` }, ...children);
}

function dotEl(tone, sm) {
  return el("span", { class: `dot ${tone}${sm ? " sm" : ""}` });
}

function panelEl(title, opts = {}, ...children) {
  const head = el("div", { class: "ph" },
    el("div", { class: "t" }, title,
      opts.soft ? el("span", { class: "soft" }, ` ${opts.soft}`) : null),
    opts.right ? el("div", { class: "r" }, opts.right) : null);
  return el("section", { class: "panel" }, head, ...children);
}

function deskHead(title, metaText) {
  return el("div", { class: "deskhead" },
    el("h1", {}, title),
    el("div", { class: "meta" }, metaText || ""));
}

function statusLine() {
  return el("div", { class: "status" });
}

function emptyLine(text) {
  return el("div", { class: "empty" }, text);
}

/* ---------- sparklines (ported from buyer.js) ---------- */

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) node.append(child);
  return node;
}

function sparkline(points, { betterDown = false, label = "" } = {}) {
  if (!points || points.length < 2) return null;
  const w = 96, h = 24, pad = 4;
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
    class: "spark", width: w, height: h, viewBox: `0 0 ${w} ${h}`, role: "img",
    "aria-label": `${label}: ${fmtNum(points[0][1])} to ${fmtNum(last[1])}`,
  },
    svgEl("title", {}, `${label} ${points[0][0]} → ${last[0]}`),
    svgEl("polyline", { class: "spark-base", points: pts.join(" ") }),
    svgEl("polyline", { class: "spark-now", points: pts.slice(-2).join(" ") }),
    svgEl("circle", { class: "spark-dot", r: 3,
      cx: x(points.length - 1).toFixed(1), cy: y(last[1]).toFixed(1) }));
}

/* ---------- product thumbnails (ported from buyer.js) ---------- */

const AMAZON_IMG_RE = /^(https:\/\/m\.media-amazon\.com\/images\/I\/[^./]+)\.(jpe?g|png|webp)$/i;
const ALI_IMG_RE = /^https:\/\/ae-pic-a1\.aliexpress-media\.com\/kf\/[^_]+\.(jpe?g|png)$/i;

function thumbUrl(url) {
  if (!url) return null;
  const m = (url || "").match(AMAZON_IMG_RE);
  if (m) return `${m[1]}._SX300_.${m[2]}`;
  if (ALI_IMG_RE.test(url)) return `${url}_480x480q75.jpg_.webp`;
  return null;
}

function thumbEl(p, lg) {
  const candidates = [];
  for (const url of [p.image_url, p.ali_image_url]) {
    if (!url) continue;
    const t = thumbUrl(url);
    if (t) candidates.push(t);
    candidates.push(url);
  }
  if (!candidates.length) return el("div", { class: `nothumb${lg ? " lg" : ""}` });
  let idx = 0;
  return el("img", {
    class: `thumb${lg ? " lg" : ""}`, src: candidates[0], alt: "",
    loading: "lazy", decoding: "async",
    onerror: (ev) => {
      idx += 1;
      if (idx < candidates.length) ev.target.src = candidates[idx];
      else ev.target.replaceWith(el("div", { class: `nothumb${lg ? " lg" : ""}` }));
    },
  });
}

/* ---------- shared intent-state vocabulary ---------- */

const INTENT_LABEL = {
  pending: "queued", ready: "payload ready", validated: "validated",
  submitting: "submitting…", submitted: "submitted", live: "🟢 live",
  loadsheet: "on the loadsheet", offer_ready: "priced — offer queued",
  blocked_exemption: "blocked: GTIN exemption", fix_required: "needs a fix",
  needs_review: "needs review", rejected: "rejected",
};
const INTENT_TONE = {
  pending: "mute", ready: "mute", validated: "ok", submitting: "warn",
  submitted: "ok", live: "ok", loadsheet: "warn", offer_ready: "ok",
  blocked_exemption: "warn", fix_required: "hot", needs_review: "bad",
  rejected: "mute",
};
const PARKED = new Set(["fix_required", "rejected", "needs_review",
                        "blocked_exemption"]);

function stateWord(state, labels = INTENT_LABEL, tones = INTENT_TONE) {
  return el("span", { class: `st ${tones[state] || "mute"}` },
    labels[state] || state || "?");
}

const ORDER_STATE_LABEL = {
  pending: "⏳ awaiting verification", verified: "✅ verified",
  placing: "🛒 placing…", placed: "📦 placed",
  received: "📥 received", needs_review: "🚨 needs review",
  rejected: "↩ rejected", failed: "✗ failed", cancelled: "🚫 cancelled",
};
const ORDER_STATE_TONE = {
  pending: "mute", verified: "ok", placing: "warn", placed: "ok",
  received: "ok", needs_review: "bad", rejected: "mute", failed: "hot",
  cancelled: "mute",
};

/* ---------- modal + command-bus plumbing ---------- */

function modalEl() { return document.getElementById("modal"); }

function openModal(...children) {
  const dialog = modalEl();
  dialog.replaceChildren(
    el("button", { class: "x", onclick: () => dialog.close() }, "✕"),
    ...children);
  dialog.showModal();
  return dialog;
}

function withToken(next) {
  if (localStorage.getItem(PAT_KEY)) { next(); return; }
  const copy = tokenPromptCopy();
  const input = el("input", {
    type: "password", class: "in wide", style: "margin:10px 0 4px",
    placeholder: LIVE_BASE ? "Dashboard admin token"
                           : "Fine-grained GitHub token (contents R/W)",
  });
  openModal(
    el("h3", {}, `This action ${copy.title}`),
    el("p", { class: "meta" },
      `Actions ride the pipeline's command bus. ${copy.hint}`),
    input,
    el("div", { style: "margin-top:10px;display:flex;gap:8px" },
      el("button", {
        class: "b pri", onclick: () => {
          if (input.value.trim()) {
            localStorage.setItem(PAT_KEY, input.value.trim());
            modalEl().close();
            readCommandsSafe().finally(() => renderApp());
            next();
          }
        },
      }, "Save token"),
      el("button", { class: "b", onclick: () => modalEl().close() }, "Cancel")));
}

/* One-shot bus action with consistent error/token handling. */
function busAct(label, mutate, statusEl, doneText) {
  withToken(async () => {
    if (statusEl) statusEl.textContent = `${label}…`;
    try {
      await mutateCommands(mutate, `Dashboard: ${label}`);
      if (statusEl) {
        statusEl.textContent = doneText
          || `✅ ${label} sent — the pipeline applies commands within ~30s ` +
             "while a run or serve is active.";
      }
      readCommandsSafe().catch(() => {});
    } catch (e) {
      if (statusEl) statusEl.textContent = `${label} failed: ${e.message}`;
      if (/401|403/.test(e.message)) localStorage.removeItem(PAT_KEY);
    }
  });
}

/* Prune helper shared by every array-shaped bus lane. */
function prunePush(doc, key, entry, days = 7) {
  doc[key] = (doc[key] || []).filter((x) =>
    x.requested_at && Date.now() - new Date(x.requested_at) < days * 864e5);
  doc[key].push(entry);
}

/* Typed-confirmation modal (ORDER / LIST): the two commit flows with real
   consequences share one shape. spec = { title, product, lines[], warn,
   word, qtyLabel, qtyDefault, confirmLabel, entryFor(qty), busKey, doneText } */
function typedCommitModal(spec) {
  withToken(() => {
    const qtySelect = el("select", { class: "in" },
      ...[1, 2, 3, 4, 5].map((n) => el("option", {
        value: n, ...(n === (spec.qtyDefault || 1) ? { selected: "" } : {}),
      }, `${n}`)));
    const confirmInput = el("input", {
      type: "text", class: "in wide", style: "margin-top:12px",
      placeholder: `Type ${spec.word} to arm the button`,
      autocomplete: "off", autocapitalize: "characters", spellcheck: "false",
    });
    const status = statusLine();
    const commitBtn = el("button", {
      class: "b pri wide", style: "margin-top:12px", disabled: "",
    }, spec.confirmLabel);
    confirmInput.addEventListener("input", () => {
      if (confirmInput.value.trim() === spec.word) commitBtn.removeAttribute("disabled");
      else commitBtn.setAttribute("disabled", "");
    });
    commitBtn.addEventListener("click", async () => {
      commitBtn.setAttribute("disabled", "");
      confirmInput.setAttribute("disabled", "");
      status.textContent = "Committing intent…";
      try {
        await mutateCommands((doc) =>
          prunePush(doc, spec.busKey, spec.entryFor(Number(qtySelect.value))),
          `Dashboard: ${spec.title}`);
        status.textContent = "";
        commitBtn.replaceWith(el("div", { class: "note ok", style: "margin-top:12px" },
          el("b", {}, "✅ Intent committed. "), spec.doneText));
      } catch (e) {
        status.textContent = `Failed: ${e.message}`;
        if (/401|403/.test(e.message)) localStorage.removeItem(PAT_KEY);
        confirmInput.removeAttribute("disabled");
        commitBtn.removeAttribute("disabled");
      }
    });
    openModal(
      el("h3", {}, spec.title),
      el("div", { style: "margin-top:8px" },
        el("div", { style: "font-size:13.5px;font-weight:600" }, spec.product),
        ...(spec.lines || []).map((line) =>
          el("div", { class: "meta", style: "margin-top:2px" }, line))),
      spec.warn ? el("div", { class: "note warn", style: "margin-top:12px" }, spec.warn) : null,
      el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:14px" },
        el("span", { class: "meta" }, spec.qtyLabel || "Quantity"), qtySelect),
      spec.note ? el("div", { class: "note", style: "margin-top:12px" }, spec.note) : null,
      confirmInput, commitBtn,
      el("button", {
        class: "b wide", style: "margin-top:8px",
        onclick: () => modalEl().close(),
      }, "Cancel"),
      status);
  });
}

/* ---------- commands doc (switch states + ack) ---------- */

async function readCommandsSafe() {
  if (!localStorage.getItem(PAT_KEY)) return null;
  try {
    const { doc } = LIVE_BASE ? await liveGetCommands() : await ghGetCommands();
    S.commands = doc;
    return doc;
  } catch (e) {
    return null;
  }
}

/* The three double switches: env half from the payloads, remote half from
   the commands doc (absence = enabled). armed = both halves on. */
function switchStates() {
  const c = S.commands || {};
  const remote = (key) => (c[key] || {}).enabled !== false;
  const envOrdering = S.admin ? !!S.admin.ordering_enabled_env : null;
  const envListing = S.seller ? !!(S.seller.amazon || {}).enabled : null;
  const envTakealot = S.seller ? !!(S.seller.takealot || {}).enabled : null;
  const known = !!S.commands;
  return [
    { key: "ordering", label: "ORDERS", env: envOrdering, remote: remote("ordering"), known },
    { key: "listing", label: "LISTINGS", env: envListing, remote: remote("listing"), known },
    { key: "takealot", label: "OFFERS", env: envTakealot, remote: remote("takealot"), known },
  ].map((s) => ({
    ...s,
    armed: s.env === true && s.remote,
    title: `${s.label.toLowerCase()}: .env ${s.env === null ? "?" : s.env ? "on" : "off"}`
      + ` · remote ${s.known ? (s.remote ? "on" : "KILLED") : "unknown (token needed)"}`
      + " — both halves must be on for anything to post",
  }));
}

/* ---------- cross-payload lookups ---------- */

function buyerByAsin() {
  const map = {};
  for (const p of (S.buyer || {}).products || []) map[p.asin] = p;
  return map;
}

function needsYouItems() {
  /* The Today desk's queue + the rail badge: merge every "a human must
     act" signal across the payloads. Each item: {tone, title, sub, dueIso,
     dueLabel, action: node}. Sorted worst-first by due date then tone. */
  const items = [];
  const a = S.admin || {};

  for (const it of a.attention || []) {
    const order = (it.ae_order_ids || [])[0];
    const tone = { critical: "bad", serious: "hot", warning: "warn" }[it.severity] || "warn";
    let action = null;
    if (it.kind === "ship_amazon_order") {
      action = el("button", { class: "b sm line", onclick: () => setDesk("sell") }, "Open on Sell");
    } else if (it.kind === "ship_takealot_dc") {
      action = el("button", { class: "b sm line", onclick: () => setDesk("stock") }, "Open on Stock");
    } else if (it.kind === "confirm_received") {
      action = el("button", { class: "b sm line", onclick: () => setDesk("buy", { buyTab: "ordered" }) }, "Open on Buy");
    } else if (order) {
      action = el("a", {
        class: "b sm line", target: "_blank", rel: "noopener",
        href: `https://www.aliexpress.com/p/order/detail.html?orderId=${order}`,
      }, "Open order ↗");
    } else if (it.order_id) {
      action = el("a", {
        class: "b sm line", target: "_blank", rel: "noopener",
        href: `https://sellercentral.amazon.co.za/orders-v3/order/${it.order_id}`,
      }, "Open order ↗");
    }
    items.push({
      tone,
      title: `${(it.kind || "?").replace(/_/g, " ")}` + (it.asin ? ` — ${it.asin}` : ""),
      sub: it.message,
      dueIso: it.act_by, action,
    });
  }

  const bm = a.buyer_messages || {};
  for (const m of bm.unhandled || []) {
    // The attention queue may already carry mailbox items; dedupe by id.
    if ((a.attention || []).some((it) => it.intent_id === m.id)) continue;
    items.push({
      tone: m.kind === "a_to_z" ? "bad" : "warn",
      title: m.kind === "a_to_z" ? "A-to-Z claim" : `Buyer message — ${m.subject || "?"}`,
      sub: `${m.from || "?"} · reply from the mailbox stops the clock`,
      dueIso: m.sla_deadline,
      action: el("button", {
        class: "b sm line",
        onclick: (ev) => {
          const btn = ev.target;
          busAct(`mark message handled`, (doc) => {
            const fresh = (doc.messages || []).filter((x) =>
              x.id !== m.id && x.requested_at &&
              Date.now() - new Date(x.requested_at) < 2 * 864e5);
            fresh.push({ id: m.id, handled: true,
                         requested_at: new Date().toISOString() });
            doc.messages = fresh;
          }, null);
          btn.replaceWith(el("span", { class: "st ok" }, "✓ sent"));
        },
      }, "✓ Mark handled"),
    });
  }

  const auth = a.aliexpress_auth || {};
  if (["expired", "expiring", "missing"].includes(auth.status)) {
    items.push({
      tone: auth.status === "expiring" ? "warn" : "bad",
      title: auth.status === "expiring"
        ? "AliExpress refresh token expires"
        : `AliExpress tokens ${auth.status}`,
      sub: "intake, SKU + freight stall when it dies · re-auth takes one sign-in",
      dueIso: auth.refresh_expires_at,
      action: auth.authorize_url ? el("a", {
        class: "b sm line", href: auth.authorize_url,
        target: "_blank", rel: "noreferrer",
      }, "Re-authenticate ↗") : null,
    });
  }

  const todos = a.seller_todos || {};
  for (const ex of todos.exemptions || []) {
    items.push({
      tone: "warn",
      title: `GTIN exemption needed — ${ex.product_type}`,
      sub: `${ex.count} intent${ex.count > 1 ? "s" : ""} blocked · ${(ex.asins || []).join(", ")} · needs 2–9 photos of the physical product`,
      dueLabel: "~48h review",
      action: el("button", { class: "b sm line", onclick: () => setDesk("sell") }, "Open on Sell"),
    });
  }
  const blocked = (todos.compliance || []).filter((c) => c.risk === "blocked");
  if (blocked.length) {
    items.push({
      tone: "warn",
      title: `ZA compliance — ${blocked.length} blocked ASIN${blocked.length > 1 ? "s" : ""}`,
      sub: "regulator approval legally required (ICASA/NRCS) — zero-scored until cleared",
      action: el("button", { class: "b sm line", onclick: () => setDesk("sell") }, "Open on Sell"),
    });
  }

  const gate = ((a.banking || {}).gate) || {};
  if (gate.status === "red") {
    items.push({
      tone: "bad",
      title: "Affordability gate RED — order placements held",
      sub: (gate.reasons || []).join(" · ") +
        " · a fresh statement or balance confirm reopens it",
      action: el("button", { class: "b sm line", onclick: () => setDesk("books") },
        "Open on Books"),
    });
  }

  const exceptions = (((a.banking || {}).recon) || {}).unmatched_total || 0;
  if (exceptions) {
    items.push({
      tone: "warn",
      title: `${exceptions} bank line${exceptions > 1 ? "s" : ""} the books can't explain`,
      sub: "match, post as expense, or dismiss on the reconciliation workbench",
      action: el("button", { class: "b sm line", onclick: () => setDesk("books") },
        "Open on Books"),
    });
  }

  const docs = ((a.accounting || {}).documents || [])
    .filter((d) => d.status === "extracted");
  if (docs.length) {
    items.push({
      tone: "warn",
      title: `${docs.length} document${docs.length > 1 ? "s" : ""} read, awaiting posting`,
      sub: docs.slice(0, 2).map((d) =>
        `${d.doc_type || d.filename || d.id}${d.total_amount != null
          ? ` ${d.currency || ""} ${fmtNum(d.total_amount)}` : ""}`).join(" · ")
        + " · suggested ledger rows ready",
      dueLabel: "nothing posts unreviewed",
      action: el("button", { class: "b sm line", onclick: () => setDesk("books") },
        `Review ${docs.length}`),
    });
  }

  // Low stock on live Takealot offers.
  const account = ((S.seller || {}).takealot || {}).account;
  for (const low of (account || {}).low_stock || []) {
    items.push({
      tone: "hot",
      title: `Low stock — ${low.title || low.sku}`,
      sub: `${low.stock} unit${low.stock === 1 ? "" : "s"} left on Takealot · restock is a Buy-desk click`,
      dueLabel: "soon",
      action: el("button", { class: "b sm line", onclick: () => setDesk("buy") }, "Open on Buy"),
    });
  }

  const toneRank = { bad: 0, hot: 1, warn: 2 };
  items.sort((x, y) => {
    const dx = x.dueIso ? new Date(x.dueIso).getTime() : Infinity;
    const dy = y.dueIso ? new Date(y.dueIso).getTime() : Infinity;
    if (dx !== dy) return dx - dy;
    return (toneRank[x.tone] ?? 3) - (toneRank[y.tone] ?? 3);
  });
  return items;
}

/* ---------- topbar + rail ---------- */

function renderTopbar() {
  const bar = document.getElementById("topbar");
  const a = S.admin || {};
  const running = a.funnel_state === "running";
  const budget = a.budget || {};
  const status = statusLine();

  const runbits = [];
  if (running && budget.minutes) {
    runbits.push(`${fmtDur(budget.minutes * 60)} budget`);
    if (budget.deadline_at) runbits.push(`ends ${fmtIn(budget.deadline_at)}`);
  } else if (running) {
    runbits.push("until done");
  } else if (a.funnel_state) {
    runbits.push(a.funnel_state);
  }

  const chips = switchStates().map((s) => el("span", {
    class: `swchip ${s.armed ? "armed" : "safe"}`, title: s.title,
    onclick: () => setDesk("today"),
  }, `${s.label} ${s.armed ? "ARMED" : "SAFE"}`));

  bar.replaceChildren(
    el("div", { class: "logo" },
      el("div", { class: "mark" }, "S2"),
      el("div", { class: "name" }, "Search2")),
    el("div", { class: "vsep" }),
    el("div", { class: `runpill${running ? "" : " idle"}` },
      dotEl(running ? "ok" : "mute"),
      el("b", {}, running ? "Run active" : "No run"),
      runbits.length ? el("span", { class: "sub" }, runbits.join(" · ")) : null),
    running
      ? el("button", {
          class: "b sm danger", onclick: () =>
            busAct("stop run", (doc) => { (doc.run ??= {}).desired = "stopped"; },
                   status, "Stop sent — the run winds down within ~30s."),
        }, "■ Stop run")
      : el("button", {
          class: "b sm line", onclick: () => setDesk("machine"),
        }, "▶ Start on Machine"),
    el("div", { style: "flex:1" }),
    el("div", { class: "pubdot" },
      dotEl(agoMinutes(a.generated_at) <= 20 ? "ok" : "warn", true),
      agoSpan(a.generated_at, "published ")),
    el("div", { class: "vsep" }),
    el("div", { class: "switchchips" }, ...chips),
    status);
}

function agoMinutes(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

function railBadges() {
  const a = S.admin || {};
  const needs = needsYouItems().length;
  const winners = ((S.buyer || {}).products || []).length;
  const stock = typeof renderStockBadge === "function" ? renderStockBadge() : 0;
  const seller = S.seller || {};
  const sellCount =
    (((seller.amazon || {}).intents) || []).filter((i) => PARKED.has(i.state)).length
    + (((seller.takealot || {}).intents) || []).filter((i) => PARKED.has(i.state)).length
    + (((a.seller_todos || {}).exemptions) || []).length
    + (((a.seller_todos || {}).restricted) || []).length;
  const machine = (a.errors || []).length
    + (["expired", "missing"].includes((a.aliexpress_auth || {}).status) ? 1 : 0);
  const books = (((a.accounting || {}).documents) || [])
    .filter((d) => d.status === "extracted").length
    + (((a.orders || {}).outstanding || {}).count || 0)
    + ((((a.banking || {}).recon) || {}).unmatched_total || 0)
    + ((((a.banking || {}).gate) || {}).status === "red" ? 1 : 0);
  return {
    today: { n: needs, cls: needs ? "alert" : "" },
    buy: { n: winners, cls: "" },
    stock: { n: stock, cls: stock ? "warn" : "" },
    sell: { n: sellCount, cls: "" },
    machine: { n: machine, cls: machine ? "warn" : "" },
    books: { n: books, cls: books ? "warn" : "" },
  };
}

function renderRail() {
  const rail = document.getElementById("rail");
  const badges = railBadges();
  rail.replaceChildren(
    el("div", { class: "railhead" }, "DESKS"),
    ...DESKS.map(([id, label]) => {
      const b = badges[id] || { n: 0, cls: "" };
      return el("button", {
        class: `navitem${S.desk === id ? " active" : ""}`,
        onclick: () => setDesk(id),
      }, label,
        b.n ? el("span", { class: `navbadge ${b.cls}` }, fmtNum(b.n)) : el("span", {}));
    }),
    el("div", { style: "flex:1" }),
    el("div", { class: "railfoot" },
      "Decrypted locally in your browser · auto-refreshes every 60s",
      el("br", {}),
      el("a", { onclick: lockDesk }, "Lock the desk")));
}

function lockDesk() {
  localStorage.removeItem(PASS_KEY);
  location.reload();
}

/* ---------- router + render ---------- */

function setDesk(desk, extra = {}) {
  Object.assign(S, extra);
  S.desk = desk;
  location.hash = desk;
  renderApp();
  document.querySelector(".main").scrollTop = 0;
  window.scrollTo(0, 0);
}

/* app.js loads last (see app/index.html), so the desk renderers defined in
   the app-<desk>.js files already exist by the time this parses. */
const DESK_RENDERERS = {
  today: renderTodayDesk,
  buy: renderBuyDesk,
  stock: renderStockDesk,
  sell: renderSellDesk,
  machine: renderMachineDesk,
  books: renderBooksDesk,
};

function renderDesk() {
  const root = document.getElementById("desk");
  root.replaceChildren();
  const renderer = DESK_RENDERERS[S.desk] || DESK_RENDERERS.today;
  try {
    renderer(root);
  } catch (e) {
    console.error(e);
    root.append(el("div", { class: "warnbar bad" },
      `This desk failed to render: ${e.message}`));
  }
}

function renderApp() {
  if (!S.admin && !S.buyer && !S.seller) return;
  renderTopbar();
  renderRail();
  renderDesk();
}

/* ---------- data plumbing ---------- */

const FILE_KEYS = { "admin.enc": "admin", "buyer.enc": "buyer", "seller.enc": "seller" };

async function loadOne(name) {
  const envelope = await fetchJson(name);
  if (CIPHERS[name] && envelope.ciphertext === CIPHERS[name]) return false;
  const data = await decryptEnvelope(envelope, S.passphrase); // throws on wrong pass
  CIPHERS[name] = envelope.ciphertext;
  S[FILE_KEYS[name]] = data;
  return true;
}

let refreshTimer = null;
let liveDebounce = null;

async function refreshAll({ firstUnlock = false } = {}) {
  const results = await Promise.allSettled(
    Object.keys(FILE_KEYS).map((name) => loadOne(name)));
  const wrong = results.find((r) =>
    r.status === "rejected" && r.reason?.name === "OperationError");
  if (wrong) throw wrong.reason;
  if (firstUnlock && results.every((r) => r.status === "rejected")) {
    throw results[0].reason;
  }
  const changed = results.some((r) => r.status === "fulfilled" && r.value);
  if (changed) renderApp();
  else tickAgo();
}

/* ---------- boot ---------- */

async function boot() {
  const gate = document.getElementById("gate");
  const gateError = document.getElementById("gate-error");
  const input = document.getElementById("pass-input");

  async function attempt(pass, remember) {
    S.passphrase = pass;
    try {
      await refreshAll({ firstUnlock: true });
    } catch (e) {
      S.passphrase = null;
      localStorage.removeItem(PASS_KEY);
      gateError.textContent = e.name === "OperationError"
        ? "Wrong passphrase." : `Could not load data: ${e.message}`;
      return false;
    }
    if (remember) localStorage.setItem(PASS_KEY, pass);
    gate.hidden = true;
    document.getElementById("app").hidden = false;
    readCommandsSafe().then((doc) => { if (doc) renderTopbar(); });
    refreshTimer = setInterval(() => refreshAll().catch(console.warn), REFRESH_MS);
    setInterval(tickAgo, 30_000);
    liveConnect((name) => {
      if (!(name in FILE_KEYS)) return;
      clearTimeout(liveDebounce);
      liveDebounce = setTimeout(() => refreshAll().catch(console.warn), 400);
    });
    renderApp();
    return true;
  }

  document.getElementById("gate-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    gateError.textContent = "";
    await attempt(input.value, true);
  });

  window.addEventListener("hashchange", () => {
    const desk = (location.hash || "").replace("#", "");
    if (desk && desk !== S.desk && DESK_RENDERERS[desk]) {
      S.desk = desk;
      renderApp();
    }
  });

  const stored = localStorage.getItem(PASS_KEY);
  if (stored) await attempt(stored, false);
}

boot();
