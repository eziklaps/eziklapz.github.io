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

// Manage A-to-z Guarantee claims (Seller Central) — responding THERE is
// the only thing that stops a claim's clock; nothing local touches it.
const ATOZ_CLAIMS_URL =
  "https://sellercentral.amazon.co.za/gp/guarantee-claims/homepage.html";

const S = {
  desk: (location.hash || "").replace("#", "") || "today",
  admin: null, buyer: null, seller: null,
  commands: null,           // last token-gated read of the commands doc
  passphrase: null,
  // per-desk UI state survives re-renders
  buyTab: "amazon", buySearch: "", buySort: "score", buySel: null,
  buyShowAll: false,
  sellTab: "amazon",
  sellTodosOpen: false,
  stockOpen: false,
  // connection honesty: failing = last refresh sweep lost every fetch;
  // wsUp = live-push socket state (null until it first connects/is off)
  net: { failing: false, lastOkAt: null, wsUp: null },
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
  proposed: "🤖 proposed — approve?",
  pending: "queued", ready: "payload ready", validated: "validated",
  submitting: "submitting…", submitted: "submitted", live: "🟢 live",
  loadsheet: "on the loadsheet", offer_ready: "priced — offer queued",
  blocked_exemption: "blocked: GTIN exemption", fix_required: "needs a fix",
  needs_review: "needs review", rejected: "rejected",
  bus: "🕐 on the bus",
};
const INTENT_TONE = {
  proposed: "warn",
  pending: "mute", ready: "mute", validated: "ok", submitting: "warn",
  submitted: "ok", live: "ok", loadsheet: "warn", offer_ready: "ok",
  blocked_exemption: "warn", fix_required: "hot", needs_review: "bad",
  rejected: "mute",
  bus: "warn",
};
const PARKED = new Set(["fix_required", "rejected", "needs_review",
                        "blocked_exemption"]);

function stateWord(state, labels = INTENT_LABEL, tones = INTENT_TONE) {
  return el("span", { class: `st ${tones[state] || "mute"}` },
    labels[state] || state || "?");
}

const ORDER_STATE_LABEL = {
  proposed: "🤖 proposed — approve?", pending: "⏳ awaiting verification",
  verified: "✅ verified", placing: "🛒 placing…", placed: "📦 placed",
  received: "📥 received", needs_review: "🚨 needs review",
  rejected: "↩ rejected", failed: "✗ failed", cancelled: "🚫 cancelled",
};
const ORDER_STATE_TONE = {
  proposed: "warn", pending: "mute", verified: "ok", placing: "warn",
  placed: "ok", received: "ok", needs_review: "bad", rejected: "mute",
  failed: "hot", cancelled: "mute",
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
  // The gate passphrase derives the bus token (common.js), so this normally
  // resolves silently; the paste prompt below survives only as the fallback
  // for a derivation the Worker rejected (secret not rotated yet) or for
  // legacy GitHub-PAT mode.
  adoptBusToken().then((ok) => {
    if (ok) {
      readCommandsSafe().finally(() => renderApp());
      next();
    } else {
      promptForToken(next);
    }
  });
}

function promptForToken(next) {
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

/* Every bus write in the app funnels through mutateCommands (common.js) —
   wrap it once so a successful commit immediately becomes visible state:
   the returned doc replaces S.commands (no extra read) and the app repaints
   a beat later, turning "✅ sent" into a queued row on the Recent-commands
   panel and phantom rows on the desks instead of 60s of silence. The delay
   leaves the ✅ note readable before the repaint clears it. */
const _mutateCommandsRaw = mutateCommands;
mutateCommands = async (mutate, message) => {
  const doc = await _mutateCommandsRaw(mutate, message);
  if (doc) {
    S.commands = doc;
    setTimeout(() => renderApp(), 4000);
  }
  return doc;
};

/* Typed-confirmation modal (ORDER / LIST): the two commit flows with real
   consequences share one shape. spec = { title, product, lines[], warn,
   word, qtyLabel, qtyDefault, confirmLabel, entryFor(qty), busKey, doneText,
   spendFor(qty)? — a node with the money math, re-built when qty changes,
   extra? — caller-owned node rendered above the spend box (e.g. the
   freight picker), bindRefresh?(fn) — hands the caller the spend-box
   refresher so controls inside `extra` can re-run spendFor on change } */
function typedCommitModal(spec) {
  withToken(() => {
    const qtySelect = el("input", {
      type: "number", class: "in", min: "1", max: "999", step: "1",
      style: "width:80px", value: String(spec.qtyDefault || 1),
    });
    const qtyValue = () => {
      const n = Math.round(Number(qtySelect.value));
      return Number.isFinite(n) && n >= 1 ? Math.min(n, 999) : 1;
    };
    const spendWrap = spec.spendFor ? el("div", {}) : null;
    const syncSpend = () => {
      if (!spendWrap) return;
      spendWrap.replaceChildren(spec.spendFor(qtyValue()) || "");
    };
    qtySelect.addEventListener("input", syncSpend);
    if (spec.bindRefresh) spec.bindRefresh(syncSpend);
    syncSpend();
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
          prunePush(doc, spec.busKey, spec.entryFor(qtyValue())),
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
      spec.extra || null,
      spendWrap,
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

/* ---------- pending-command surfacing (the anti-fire-and-forget layer)
   The bus doc carries every not-yet-pruned entry; the admin payload's
   activity journal carries what the pipeline actually did, stamped with
   each entry's requested_at. Everything here is derived: an entry whose
   stamp appears in the journal is done (the journal row tells the story);
   an unmatched one is still waiting — or applied silently before the
   journal existed, which the panel words carefully. ---------- */

function pendingBusEntries() {
  const c = S.commands;
  if (!c) return [];
  const out = [];
  const push = (kind, label, stamp, ref) => {
    if (!stamp) return;
    const age = Date.now() - new Date(stamp).getTime();
    // Old riders (applied long ago, journal rolled past them) stay quiet.
    if (!(age > -600e3 && age < 48 * 3600e3)) return;
    out.push({ kind, label, stamp, ref });
  };
  for (const o of c.orders || []) {
    if (o.cancel) push("order", `Mark ${o.id} cancelled`, o.requested_at, o.id);
    else if (o.received) {
      push("order", `Mark ${o.id} received${o.partial ? " (partial)" : ""}`,
        o.requested_at, o.id);
    } else {
      push("order", `Order ${o.quantity || 1} × ${o.asin || o.ali_id}`,
        o.requested_at, o.id);
    }
  }
  for (const l of c.listings || []) {
    if (l.grant) push("listing", `Mark exemption granted: ${l.grant}`, l.requested_at, l.grant);
    else if (l.compliance_clear) push("listing", `Clear ZA compliance: ${l.compliance_clear}`, l.requested_at, l.compliance_clear);
    else if (l.requeue) push("listing", `Requeue ${l.asin} (${l.channel})`, l.requested_at, l.asin);
    else push("listing", `List ${l.asin} on ${l.channel}`, l.requested_at, l.asin);
  }
  for (const m of c.matches || []) {
    if (m.reject) {
      push("match", `Wrong match: ${m.asin} ↔ Ali ${m.ali_id}`,
        m.requested_at, m.asin);
    }
  }
  for (const s of c.shipments || []) {
    push("shipment", `Confirm shipment ${s.order_id}`, s.requested_at, s.order_id);
  }
  for (const m of c.messages || []) {
    push("message", "Mark buyer message handled", m.requested_at, m.id);
  }
  const stockBucket = c.stock || {};
  for (const mv of stockBucket.moves || []) {
    const what = mv.write_off ? `Write off ${mv.quantity} × ${mv.asin}`
      : mv.adjust ? `Adjust count: ${mv.asin} ${mv.quantity > 0 ? "+" : ""}${mv.quantity}`
      : `Move ${mv.quantity} × ${mv.asin} ${mv.from} → ${mv.to}`;
    push("stock", what, mv.requested_at, mv.asin);
  }
  for (const r of stockBucket.receipts || []) {
    push("stock", `Receive ${r.quantity} × ${r.sku}`, r.requested_at, r.sku);
  }
  for (const q of (c.courier || {}).requests || []) {
    const what = q.cancel ? `Cancel courier ${q.id}`
      : q.relabel ? `Fresh label for ${q.id}`
      : q.quote_only ? `Courier quote — ${q.dest}`
      : `Book courier — ${q.dest}`;
    push("courier", what, q.requested_at, q.dest || q.id);
  }
  const bank = c.banking || {};
  for (const b of bank.balances || []) {
    push("books", `Confirm balance: ${b.account} ${fmtR(b.amount)}`, b.requested_at, b.account);
  }
  for (const e of bank.expense_lines || []) {
    push("books", "Post bank line as expense", e.requested_at, e.id);
  }
  for (const d of bank.dismiss_lines || []) {
    push("books", "Dismiss bank line", d.requested_at, d.id);
  }
  const acc = c.accounting || {};
  for (const d of acc.post_docs || []) {
    push("books", `Post document ${d.id}`, d.requested_at, d.id);
  }
  for (const d of acc.ignore_docs || []) {
    push("books", `Ignore document ${d.id}`, d.requested_at, d.id);
  }
  if ((c.affordability || {}).requested_at) {
    push("books", "Update affordability knobs", c.affordability.requested_at, "affordability");
  }
  if ((c.auth || {}).at) push("auth", "AliExpress sign-in code", c.auth.at, "auth");
  out.sort((x, y) => new Date(y.stamp) - new Date(x.stamp));
  return out;
}

function journalStamps() {
  return new Set(((S.admin || {}).activity || [])
    .map((row) => row.stamp).filter(Boolean));
}

/* Order entries committed to the bus that no payload reflects yet — the
   Buy desk's phantom rows, and the guard that keeps the Order button from
   double-committing while the pipeline catches up. */
function busOrderPhantoms() {
  const c = S.commands;
  if (!c) return [];
  const known = new Set(
    (((S.admin || {}).orders || {}).recent || []).map((r) => r.id));
  const byAsin = buyerByAsin();
  return (c.orders || []).filter((o) => {
    if (o.cancel || o.received || o.approve || !o.id || !o.requested_at) return false;
    const age = Date.now() - new Date(o.requested_at).getTime();
    if (!(age > -600e3 && age < 48 * 3600e3)) return false;
    if (known.has(o.id)) return false;
    if ((byAsin[o.asin] || {}).order?.id === o.id) return false;
    return true;
  });
}

function busOrderPhantomForAsin(asin) {
  return busOrderPhantoms().find((o) => o.asin === asin) || null;
}

/* A "Wrong match" verdict already riding the bus for this ASIN — the Buy
   detail swaps the reject button for a waiting note so one misfit can't
   be rejected twice. */
function busMatchRejectFor(asin) {
  return ((S.commands || {}).matches || []).find((m) =>
    m.reject && m.asin === asin && m.requested_at
    && Date.now() - new Date(m.requested_at).getTime() < 48 * 3600e3) || null;
}

/* Listing entries on the bus with no matching intent in the seller payload
   yet — rendered as state:"bus" rows in the intent tables. */
function busListingPhantoms(channel, intents) {
  const c = S.commands;
  if (!c) return [];
  const have = new Set((intents || []).map((i) => i.asin));
  return (c.listings || []).filter((l) => {
    if (!l.asin || l.grant || l.compliance_clear || l.requeue) return false;
    if ((l.channel || "amazon") !== channel || have.has(l.asin)) return false;
    if (!l.requested_at) return false;
    const age = Date.now() - new Date(l.requested_at).getTime();
    return age > -600e3 && age < 48 * 3600e3;
  }).map((l) => ({
    id: `bus-${l.asin}`, asin: l.asin, title: l.asin, state: "bus",
    received_at: l.requested_at,
    note: "committed — the pipeline applies it within ~30s while serve is up",
  }));
}

/* The double switches: env half from the payloads, remote half from the
   commands doc (absence = enabled). armed = every half on. SELL is one
   switch in the UI but two underneath (Amazon listings + Takealot offers —
   separate .env vars and bus keys); the chip arms only when both channels
   are fully on, and killing it trips both. */
function switchStates() {
  const c = S.commands || {};
  const remote = (key) => (c[key] || {}).enabled !== false;
  const envOrdering = S.admin ? !!S.admin.ordering_enabled_env : null;
  const envListing = S.seller ? !!(S.seller.amazon || {}).enabled : null;
  const envTakealot = S.seller ? !!(S.seller.takealot || {}).enabled : null;
  const known = !!S.commands;
  const half = (env, rem) =>
    `.env ${env === null ? "?" : env ? "on" : "off"} · remote `
    + (known ? (rem ? "on" : "KILLED") : "unknown (token needed)");
  const bothEnv = envListing === null && envTakealot === null
    ? null : envListing === true && envTakealot === true;
  return [
    {
      keys: ["ordering"], label: "ORDERS",
      env: envOrdering, remote: remote("ordering"), known,
      armed: envOrdering === true && remote("ordering"),
      title: `ordering: ${half(envOrdering, remote("ordering"))}`
        + " — both halves must be on for anything to post",
    },
    {
      keys: ["listing", "takealot"], label: "SELL",
      env: bothEnv, remote: remote("listing") && remote("takealot"), known,
      armed: bothEnv === true && remote("listing") && remote("takealot"),
      title: `Amazon listings: ${half(envListing, remote("listing"))}`
        + ` · Takealot offers: ${half(envTakealot, remote("takealot"))}`
        + " — one switch, both channels: every half must be on to post",
    },
  ];
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
    if (it.kind === "a_to_z") {
      // Never "Mark handled" here — only a response in Seller Central
      // stops Amazon's clock; the claim auto-grants if it runs out.
      action = el("a", {
        class: "b sm pri", href: ATOZ_CLAIMS_URL,
        target: "_blank", rel: "noopener",
      }, "Respond to claim ↗");
    } else if (it.kind === "buyer_message") {
      action = el("a", {
        class: "b sm line", href: "https://mail.google.com/",
        target: "_blank", rel: "noopener",
        title: "replying from the mailbox routes back through Amazon and stops the SLA clock",
      }, "Open mailbox ↗");
    } else if (it.kind === "ship_amazon_order") {
      action = el("button", {
        class: "b sm line",
        onclick: () => setDesk("sell", { sellTab: "amazon", focus: it.order_id }),
      }, "Open on Sell");
    } else if (it.kind === "ship_takealot_dc") {
      action = el("button", {
        class: "b sm line",
        onclick: () => setDesk("stock", { focus: it.asin || "stock-table" }),
      }, "Open on Stock");
    } else if (it.kind === "confirm_received") {
      action = el("button", {
        class: "b sm line",
        onclick: () => setDesk("buy", {
          buyTab: "ordered", focus: it.asin,
          ...(it.asin ? { buySel: it.asin } : {}),
        }),
      }, "Open on Buy");
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
    const isClaim = m.kind === "a_to_z";
    const markBtn = (label, cls, title) => el("button", {
      class: `b sm ${cls}`, ...(title ? { title } : {}),
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
    }, label);
    items.push({
      tone: isClaim ? "bad" : "warn",
      title: isClaim ? "A-to-Z claim — defend it"
        : `Buyer message — ${m.subject || "?"}`,
      sub: isClaim
        ? `${m.from || "?"} · only a Seller Central response stops the ` +
          "clock — unanswered claims auto-grant against the account"
        : `${m.from || "?"} · reply from the mailbox stops the clock`,
      dueIso: m.sla_deadline,
      action: isClaim
        ? el("span", { style: "display:inline-flex;gap:6px;align-items:center" },
            el("a", {
              class: "b sm pri", href: ATOZ_CLAIMS_URL,
              target: "_blank", rel: "noopener",
            }, "Respond ↗"),
            markBtn("✓", "line",
              "clear from this queue AFTER responding in Seller Central — " +
              "this does not touch the claim itself"))
        : markBtn("✓ Mark handled", "line"),
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

  // Parked approval queues (GTIN exemptions + compliance blocks) fold into
  // ONE quiet line — they wait on Seller Central applications that aren't
  // being pursued right now, and Buy already hides the blocked products.
  // Today only nags about things that move money this week.
  const todos = a.seller_todos || {};
  const exN = (todos.exemptions || []).length;
  const blockedN = (todos.compliance || [])
    .filter((c) => c.risk === "blocked").length;
  if (exN + blockedN) {
    items.push({
      tone: "mute",
      title: "Parked approvals",
      sub: [
        exN ? `${exN} GTIN categor${exN > 1 ? "ies" : "y"}` : null,
        blockedN ? `${blockedN} compliance-blocked` : null,
      ].filter(Boolean).join(" · ") +
        " — hidden from Buy · details on Sell whenever you take them up",
      action: el("button", {
        class: "b sm line",
        onclick: () => setDesk("sell", { sellTab: "amazon" }),
      }, "Open on Sell"),
    });
  }

  const gate = ((a.banking || {}).gate) || {};
  if (gate.status === "red") {
    items.push({
      tone: "bad",
      title: "Affordability gate RED — order placements held",
      sub: (gate.reasons || []).join(" · ") +
        " · a fresh statement or balance confirm reopens it",
      action: el("button", {
        class: "b sm line", onclick: () => setDesk("books", { focus: "gate" }),
      }, "Open on Books"),
    });
  }

  const exceptions = (((a.banking || {}).recon) || {}).unmatched_total || 0;
  if (exceptions) {
    items.push({
      tone: "warn",
      title: `${exceptions} bank line${exceptions > 1 ? "s" : ""} the books can't explain`,
      sub: "match, post as expense, or dismiss on the reconciliation workbench",
      action: el("button", {
        class: "b sm line", onclick: () => setDesk("books", { focus: "recon" }),
      }, "Open on Books"),
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
      action: el("button", {
        class: "b sm line", onclick: () => setDesk("books", { focus: "documents" }),
      }, `Review ${docs.length}`),
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
  // Badge = intents a click can actually fix today. Approval-parked work
  // (blocked_exemption / rejected-restricted / the todo queues) sits
  // quietly on the desk instead of inflating the rail.
  const actionable = new Set(["fix_required", "needs_review"]);
  const sellCount =
    (((seller.amazon || {}).intents) || []).filter((i) => actionable.has(i.state)).length
    + (((seller.takealot || {}).intents) || []).filter((i) => actionable.has(i.state)).length;
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
  // One stray tap used to wipe the passphrase and reload mid-work.
  if (!confirm("Lock the desk? You'll need the passphrase to get back in.")) return;
  localStorage.removeItem(PASS_KEY);
  // The bus token is passphrase-derived — locking must drop it too, or the
  // desk stays actionable. Legacy mode keeps its hand-pasted GitHub PAT.
  if (LIVE_BASE) localStorage.removeItem(PAT_KEY);
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
  applyFocus();
}

/* One-shot deep-link landing: setDesk(..., { focus: "<key>" }) scrolls to
   the [data-focus="<key>"] node the desk just rendered and flashes it, so
   cross-desk buttons land ON the item instead of at the top of the desk. */
function applyFocus() {
  const key = S.focus;
  S.focus = null;
  if (!key) return;
  const node = document.querySelector(`[data-focus="${CSS.escape(key)}"]`);
  if (!node) return;
  node.scrollIntoView({ block: "center", behavior: "smooth" });
  node.classList.add("focus-flash");
  setTimeout(() => node.classList.remove("focus-flash"), 2600);
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
  // API-first (plaintext + ETag, no PBKDF2): attempt() adopts the derived
  // bearer before the first refresh, so even the first unlock goes API-first
  // while the desk API is up. The envelope path below covers API-down, and
  // is what proves a wrong passphrase (GCM auth failure) — the API merely
  // 401s a wrong-passphrase bearer and falls through to it.
  const api = await fetchDeskPayload(name);
  if (api.status === "changed") {
    S[FILE_KEYS[name]] = api.data;
    CIPHERS[name] = null; // blob dedupe stamp is meaningless across sources
    return true;
  }
  if (api.status === "unchanged") {
    // 304: keep the payload, but let the build stamp age honestly so the
    // staleness banner doesn't cry wolf on a quiet-but-healthy pipeline.
    const held = S[FILE_KEYS[name]];
    if (held && api.generatedAt) held.generated_at = api.generatedAt;
    return false;
  }
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
  // Connection honesty: a fully-failed sweep means the desks are painting
  // old data — surface it instead of console.warn-ing into the void.
  if (results.some((r) => r.status === "fulfilled")) {
    S.net.failing = false;
    S.net.lastOkAt = new Date().toISOString();
  } else {
    S.net.failing = true;
  }
  const changed = results.some((r) => r.status === "fulfilled" && r.value);
  if (changed) renderApp();
  else tickAgo();
  renderConnBar();
}

/* ---------- connection honesty banner ---------- */

/* Idle serve force-republishes hourly (config.PUBLISH_FORCE_SECONDS), so a
   healthy pipeline never lets generated_at age past ~65min. Beyond that the
   serve loop itself is down or stuck — not merely quiet. */
const STALE_PUBLISH_MIN = 75;

function connState() {
  if (S.net.failing) return "offline";
  if (agoMinutes((S.admin || {}).generated_at) > STALE_PUBLISH_MIN) return "stale";
  return "ok";
}

function renderConnBar() {
  let bar = document.getElementById("connbar");
  if (!bar) {
    const top = document.getElementById("topbar");
    if (!top) return;
    bar = el("div", { id: "connbar" });
    bar.hidden = true;
    top.after(bar);
  }
  const state = connState();
  bar.hidden = state === "ok";
  if (state === "ok") return;
  bar.className = `connbar ${state === "offline" ? "bad" : "warn"}`;
  if (state === "offline") {
    bar.replaceChildren(
      el("span", {},
        el("b", {}, "⚠ Offline — the data feed isn't reachable."),
        " Showing data fetched ",
        S.net.lastOkAt ? agoSpan(S.net.lastOkAt) : "before this page opened",
        " · commands may not reach the bus."),
      el("button", {
        class: "b sm line",
        onclick: () => refreshAll().catch(console.warn),
      }, "Retry now"));
  } else {
    bar.replaceChildren(
      el("span", {},
        el("b", {}, "⚠ Pipeline quiet"),
        " — last publish ", agoSpan((S.admin || {}).generated_at),
        " (a healthy serve republishes at least hourly). ",
        "The serve process may be down."),
      el("button", {
        class: "b sm line", onclick: () => setDesk("machine"),
      }, "Open Machine"));
  }
}

/* Live-push socket chip — Machine's connection row owns it; the state
   callback swaps it in place so a socket flap never rebuilds the desk
   (which would eat half-filled run-control inputs). */
function wsChip() {
  const up = S.net.wsUp;
  const tone = up === true ? "ok" : up === false ? "warn" : "mute";
  const label = up === true ? "live push connected"
    : up === false ? "live push reconnecting — 60s polling covers"
    : "live push off";
  const chip = pill(tone, dotEl(tone, true), ` ${label}`);
  chip.id = "wschip";
  return chip;
}

/* ---------- boot ---------- */

async function boot() {
  const gate = document.getElementById("gate");
  const gateError = document.getElementById("gate-error");
  const input = document.getElementById("pass-input");

  async function attempt(pass, remember) {
    const btn = document.querySelector("#gate-form button");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Unlocking…";
    S.passphrase = pass;
    // Derive the bus bearer BEFORE the first fetch: with it stored, loadOne
    // takes the API-first plaintext path, so the unlock costs ONE 600k
    // PBKDF2 run instead of four (three per-envelope decrypts + this
    // token) plus three MB-scale blob downloads. It also doubles as the
    // command-bus credential, so actions need nothing else. A wrong
    // passphrase derives a wrong bearer — the API 401s, the blob path
    // still runs, and GCM auth gives the definitive verdict below.
    const hadStoredToken = !!localStorage.getItem(PAT_KEY);
    await adoptBusToken(pass);
    try {
      await refreshAll({ firstUnlock: true });
    } catch (e) {
      S.passphrase = null;
      localStorage.removeItem(PASS_KEY);
      // Don't let a bearer derived from an unproven passphrase linger.
      if (!hadStoredToken) localStorage.removeItem(PAT_KEY);
      gateError.textContent = e.name === "OperationError"
        ? "Wrong passphrase." : `Could not load data: ${e.message}`;
      return false;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
    if (remember) localStorage.setItem(PASS_KEY, pass);
    gate.hidden = true;
    document.getElementById("app").hidden = false;
    readCommandsSafe().then((doc) => { if (doc) renderTopbar(); });
    refreshTimer = setInterval(() => refreshAll().catch(console.warn), REFRESH_MS);
    // 30s tick keeps ago-labels honest AND lets the stale banner appear by
    // time passing alone (a dead serve never triggers a repaint otherwise).
    setInterval(() => { tickAgo(); renderConnBar(); }, 30_000);
    liveConnect((name) => {
      if (!(name in FILE_KEYS)) return;
      clearTimeout(liveDebounce);
      liveDebounce = setTimeout(() => refreshAll().catch(console.warn), 400);
    }, (up) => {
      S.net.wsUp = up;
      const chip = document.getElementById("wschip");
      if (chip) chip.replaceWith(wsChip());
    });
    // Desk-API dirty hints ride the same debounce; harmless double signal
    // while the publish loop still runs (Phase 3 retires that side).
    sseConnect(() => {
      clearTimeout(liveDebounce);
      liveDebounce = setTimeout(() => refreshAll().catch(console.warn), 400);
    }, null);
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
