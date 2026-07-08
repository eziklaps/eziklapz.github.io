/* Admin dashboard: fetch admin.enc, decrypt (decryptEnvelope in common.js),
   render. The passphrase is remembered in localStorage; a wrong one fails
   GCM auth, clears the stored value and re-prompts. */

const REFRESH_MS = 60_000;

const LANE_CHIP = {
  running: "good", idle: "neutral", done: "good", paused: "warning",
  error: "serious", failed: "critical", stopped: "neutral", starting: "neutral",
};
const LANE_ICON = {
  running: "▶", idle: "…", done: "✓", paused: "⏸",
  error: "!", failed: "✗", stopped: "■", starting: "○",
};

function render(data) {
  const root = document.getElementById("dash");
  root.replaceChildren();
  updateStaleness(document.getElementById("stale"), data.generated_at);

  document.getElementById("runmeta").textContent =
    `funnel: ${data.funnel_state ?? "none"}` +
    (data.run_id ? ` · run ${data.run_id}` : "") +
    ` · published ${fmtAgo(data.generated_at)}`;

  // --- AliExpress credential health ---
  const authBanner = authWarning(data.aliexpress_auth);
  if (authBanner) root.append(authBanner);

  // --- stat tiles ---
  const counts = data.status_counts || {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const winners = counts["margin_calculation_success"] || 0;
  const tiles = el("div", { class: "grid tiles" },
    tile("Products", fmtNum(total)),
    tile("Winners", fmtNum(winners), "margin calculated"),
    tile("Batch jobs", fmtNum((data.batch_jobs || []).length), "in flight"),
    tile("Backlog", fmtNum(Object.values(data.feed_depths || {}).reduce((a, b) => a + b, 0)),
         "docs awaiting a stage"),
  );
  if (data.work_eta_seconds > 0) {
    // The ETA only covers deterministically-paced calls; Gemini batch
    // turnaround is Google's call, so name the excluded volume instead of
    // silently hiding it.
    const geminiDocs = ["embed-submit", "vision-submit", "duties-submit"]
      .reduce((a, k) => a + ((data.feed_depths || {})[k] || 0), 0);
    tiles.append(tile("Paced work left", `~${fmtDur(data.work_eta_seconds)}`,
                      geminiDocs
                        ? `SP-API + Ali pacing; excl. ${fmtNum(geminiDocs)} docs on Gemini batches`
                        : "SP-API + AliExpress pacing; Gemini batches excluded"));
  }
  if (data.budget && data.budget.deadline_at) {
    tiles.append(tile("Time budget", fmtDur((data.budget.minutes || 0) * 60),
                      `ends ${fmtIn(data.budget.deadline_at)}`));
  }
  root.append(tiles);

  // --- lanes ---
  const lanes = data.lanes || {};
  if (Object.keys(lanes).length) {
    const cards = el("div", { class: "grid cards" });
    for (const [name, lane] of Object.entries(lanes)) {
      const chip = LANE_CHIP[lane.state] || "neutral";
      const icon = LANE_ICON[lane.state] || "·";
      cards.append(el("div", { class: "card lane" },
        el("div", { class: "name" }, name),
        el("span", { class: `chip ${chip}` },
          el("span", { class: "dot" }), `${icon} ${lane.state}` +
          (lane.pending ? " · work pending" : "")),
        el("div", { class: "meta" },
          `${lane.cycles ?? 0} cycles · last activity ${fmtAgo(lane.last_activity)}`),
        lane.last_error
          ? el("div", { class: "err" }, `${lane.last_error.message} (${fmtAgo(lane.last_error.at)})`)
          : null,
      ));
    }
    root.append(panel("Lanes", cards, "lanes-controls"));
  }

  // --- remote control ---
  root.append(controlsPanel(data));

  // --- ordering ---
  root.append(ordersPanel(data));

  // --- logistics attention queue (dispute windows, stalled packages) ---
  if (Array.isArray(data.attention)) root.append(attentionPanel(data.attention));

  // --- selling kill switches (Amazon listings + Takealot offers) ---
  root.append(sellingPanel(data));

  // --- accounting: monthly P&L + tax gauges (transactions ledger) ---
  if (data.accounting) root.append(accountingPanel(data.accounting));

  // --- uploaded documents (receipts/invoices/customs → ledger) ---
  root.append(docsPanel(data.accounting || {}));

  // --- snapshot sweep status ---
  if (data.sweep) root.append(sweepPanel(data.sweep));

  // --- Seller Central to-dos (manual approvals only Andrew can click) ---
  root.append(todosPanel(data));

  // --- funnel backlog bars ---
  const depths = Object.entries(data.feed_depths || {});
  if (depths.length) {
    const max = Math.max(...depths.map(([, v]) => v));
    const bars = el("div", { class: "bars" });
    for (const [stage, count] of depths) {
      bars.append(el("div", { class: "row" },
        el("div", { class: "name" }, stage),
        el("div", { class: "track" },
          el("div", { class: "fill", style: `width:${Math.max(2, (count / max) * 100)}%` })),
        el("div", { class: "count" }, fmtNum(count)),
      ));
    }
    root.append(panel("Awaiting each stage", bars));
  }

  // --- product status counts ---
  const statusTable = el("table", { class: "data" },
    el("tr", {}, el("th", {}, "status"), el("th", {}, "products")));
  for (const [status, count] of Object.entries(counts)) {
    statusTable.append(el("tr", {},
      el("td", { class: "t" }, status), el("td", {}, fmtNum(count))));
  }
  root.append(panel("Products per status", el("div", { class: "scroll-x" }, statusTable)));

  // --- batch jobs ---
  const jobs = data.batch_jobs || [];
  const jobsBody = jobs.length
    ? el("table", { class: "data" },
        el("tr", {}, el("th", {}, "stage"), el("th", {}, "state"),
           el("th", {}, "docs"), el("th", {}, "submitted")),
        ...jobs.map((j) => el("tr", {},
          el("td", { class: "t" }, j.stage),
          el("td", { class: "t" }, j.provider_state),
          el("td", {}, fmtNum(j.doc_count)),
          el("td", { class: "t" }, fmtAgo(j.submitted_at)))))
    : el("div", { class: "chip neutral" }, el("span", { class: "dot" }), "none in flight");
  root.append(panel("Gemini batch jobs", jobsBody));

  // --- keywords ---
  const kw = data.keywords || {};
  const kwBody = el("div", {});
  for (const market of ["amazon", "aliexpress", "takealot"]) {
    const stats = kw[market] || {};
    kwBody.append(el("div", { class: "chip neutral", style: "margin-right:16px" },
      el("span", { class: "dot" }),
      `${market}: ${stats.pending ?? 0} pending · ${stats.processing ?? 0} processing · ${stats.completed ?? 0} done`));
  }
  const kwTable = el("table", { class: "data", style: "margin-top:10px" },
    el("tr", {}, el("th", {}, ""), el("th", {}, "keyword"), el("th", {}, "score"),
       el("th", {}, "found"), el("th", {}, "margined")));
  for (const entry of kw.top || []) kwTable.append(kwRow("⭐", entry));
  for (const entry of kw.bottom || []) kwTable.append(kwRow("💤", entry));
  kwBody.append(el("div", { class: "scroll-x" }, kwTable));
  root.append(panel("Keywords", kwBody));

  // --- recent errors ---
  if ((data.errors || []).length) {
    const list = el("table", { class: "data" },
      el("tr", {}, el("th", {}, "lane"), el("th", {}, "when"), el("th", {}, "error")));
    for (const err of data.errors) {
      list.append(el("tr", {},
        el("td", { class: "t" }, err.lane),
        el("td", { class: "t" }, fmtAgo(err.at)),
        el("td", { class: "t" }, err.message)));
    }
    root.append(panel("Recent lane errors", el("div", { class: "scroll-x" }, list)));
  }
}

/* AliExpress credential banner: warns when the tokens are expired/expiring
   (published by funnel/metrics.py, env-only). The button opens the AliExpress
   sign-in; the token exchange itself needs the app secret, which only lives
   on the pipeline machine — hence the runtime.py hint. */
function authWarning(auth) {
  if (!auth || !["expired", "expiring", "missing"].includes(auth.status)) return null;
  const critical = auth.status !== "expiring";
  const text = {
    expired: "AliExpress tokens have expired — intake, SKU matching and freight are stalled.",
    missing: "AliExpress tokens are missing from .env — nothing can be pulled from AliExpress.",
    expiring: `AliExpress refresh token expires ${fmtIn(auth.refresh_expires_at)} — re-authorize before it dies.`,
  }[auth.status];
  // Text and button on separate rows — an inline button tall enough to
  // click paints over the message text otherwise.
  return el("div", {
    class: "banner show",
    style: critical ? "border-left-color: var(--critical)" : "",
  },
    el("div", {},
      `${critical ? "⛔" : "⚠"} ${text} `,
      "Run ", el("code", {}, "python runtime.py auth"),
      " on the pipeline machine (it opens this sign-in and saves fresh tokens), or:"),
    el("div", {},
      el("a", {
        class: "btn", href: auth.authorize_url, target: "_blank",
        rel: "noreferrer", style: "margin-top:8px",
      }, "Re-authenticate AliExpress")));
}

/* Remote control: pause/resume lanes, stop/start the run — every action is
   a commit to commands.json; the pipeline polls it within ~30s. The ack
   block shows what the pipeline last applied. */
const CONTROL_LANES = ["intake", "spapi", "gemini", "aliexpress", "local", "publisher"];

function controlsPanel(data) {
  const body = el("div", {});
  const status = el("div", { class: "hint", style: "margin-top:8px" });

  if (!localStorage.getItem(PAT_KEY)) {
    const copy = tokenPromptCopy();
    const input = el("input", {
      type: "password",
      placeholder: LIVE_BASE ? "Dashboard admin token"
                             : "Fine-grained GitHub token (contents R/W)",
      style: "width:100%;max-width:420px;padding:8px 10px;margin-right:8px;" +
             "border:1px solid var(--hairline);border-radius:8px;" +
             "background:var(--surface);color:var(--ink);",
    });
    body.append(
      el("p", { class: "hint" },
        `Remote control ${copy.title}. ${copy.hint}`),
      input,
      el("button", {
        class: "btn", onclick: () => {
          if (input.value.trim()) {
            localStorage.setItem(PAT_KEY, input.value.trim());
            location.reload();
          }
        },
      }, "Enable remote control"));
    return panel("Remote control", body);
  }

  async function act(label, mutate) {
    status.textContent = `${label}…`;
    try {
      await mutateCommands(mutate, `Dashboard: ${label}`);
      status.textContent =
        `${label} sent — the pipeline applies commands within ~30s.`;
    } catch (e) {
      status.textContent = `${label} failed: ${e.message}`;
      if (/401|403/.test(e.message)) localStorage.removeItem(PAT_KEY);
    }
  }

  const ack = data.commands_ack || {};
  const ackLanes = ack.lanes || {};
  const table = el("table", { class: "data" },
    el("tr", {}, el("th", {}, "lane"), el("th", {}, "acknowledged"),
       el("th", {}, ""), el("th", {}, "")));
  for (const name of CONTROL_LANES) {
    table.append(el("tr", {},
      el("td", { class: "t" }, name),
      el("td", { class: "t" }, ackLanes[name] ?? "—"),
      el("td", { class: "t" }, el("button", {
        class: "btn ghost", onclick: () => act(`pause ${name}`,
          (doc) => { (doc.lanes ??= {})[name] = "paused"; }),
      }, "Pause")),
      el("td", { class: "t" }, el("button", {
        class: "btn ghost", onclick: () => act(`resume ${name}`,
          (doc) => { (doc.lanes ??= {})[name] = "running"; }),
      }, "Resume"))));
  }

  // Duration picker for Start run: budget_minutes rides along on the
  // command; the run sizes its keyword claim to it and flush-exits at the
  // deadline (in-flight Gemini jobs are collected by the next run).
  const budgetSelect = el("select", {
    style: "padding:8px 10px;margin-right:8px;" +
           "border:1px solid var(--hairline);border-radius:8px;" +
           "background:var(--surface);color:var(--ink);",
  },
    el("option", { value: "" }, "Until done"),
    el("option", { value: "60" }, "1 hour"),
    el("option", { value: "180" }, "3 hours"),
    el("option", { value: "360" }, "6 hours"),
    el("option", { value: "720" }, "12 hours"),
    el("option", { value: "1440" }, "24 hours"));

  // One-off stage runner: 'serve' runs exactly the picked stage between
  // publish ticks — the way to clear a single backlog (embed-submit,
  // collect, matching, …) without paying for a full funnel run. The lane
  // pause/resume buttons below do NOT do this: they only flag a lane of an
  // already-live run.
  const STAGE_OPTIONS = [
    ["embed-submit", "embed-submit — submit embedding backlog (Gemini batch)"],
    ["vision-submit", "vision-submit — submit vision backlog (Gemini batch)"],
    ["duties-submit", "duties-submit — submit duties backlog (Gemini batch)"],
    ["collect", "collect — ingest finished Gemini batches now"],
    ["matching", "matching — vector matching"],
    ["gate", "gate — provisional margin gate"],
    ["margins", "margins — calculate margins"],
    ["score", "score — opportunity score"],
    ["re-embed", "re-embed — refresh old vectors at the new image size (paid)"],
    ["takealot-match", "takealot-match — check winners against the Takealot catalog"],
    ["pull-takealot", "pull-takealot — Takealot demand discovery (keyword search intake)"],
    ["takealot-enrich", "takealot-enrich — offer stack + barcode for Takealot winners"],
    ["restrictions", "restrictions — Amazon listing restrictions gate"],
    ["listings", "listings — process Amazon listing intents (prepare + validate + submit)"],
    ["takealot-listings", "takealot-listings — process Takealot intents (prepare + loadsheet + offers)"],
  ];
  const selectStyle = "padding:8px 10px;margin-right:8px;" +
    "border:1px solid var(--hairline);border-radius:8px;" +
    "background:var(--surface);color:var(--ink);max-width:100%;";
  const stageSelect = el("select", { style: selectStyle },
    ...STAGE_OPTIONS.map(([value, label]) => el("option", { value }, label)));

  body.append(
    el("div", {},
      budgetSelect,
      el("button", {
        class: "btn", onclick: () => {
          const minutes = budgetSelect.value ? Number(budgetSelect.value) : null;
          const label = minutes
            ? `start run (${budgetSelect.selectedOptions[0].textContent})`
            : "start run";
          act(label, (doc) => {
            doc.run = { ...(doc.run || {}),
                        desired: "running",
                        start_requested_at: new Date().toISOString(),
                        budget_minutes: minutes };
          });
        },
      }, "Start run"),
      " ",
      el("button", {
        class: "btn ghost", onclick: () => act("stop run", (doc) => {
          (doc.run ??= {}).desired = "stopped";
        }),
      }, "Stop run"),
      ack.applied_at
        ? el("span", { class: "hint", style: "margin-left:12px" },
            `last applied ${fmtAgo(ack.applied_at)} (run: ${ack.run ?? "—"})`)
        : el("span", { class: "hint", style: "margin-left:12px" },
            "no ack yet — is a run (or 'serve') active?")),
    el("div", { style: "margin-top:10px" },
      stageSelect,
      el("button", {
        class: "btn ghost", onclick: () => {
          const stage = stageSelect.value;
          act(`run stage ${stage}`, (doc) => {
            doc.run = { ...(doc.run || {}),
                        stages: [stage],
                        stages_requested_at: new Date().toISOString() };
          });
        },
      }, "Run stage"),
      el("div", { class: "hint", style: "margin-top:4px" },
        "Runs one stage without a full funnel run ('serve' must be up). " +
        "Gemini batches submit and are collected automatically when Google " +
        "finishes them.")),
    el("div", { class: "scroll-x", style: "margin-top:10px" }, table),
    status);
  return panel("Remote control", body);
}

/* Ordering: intent states from the snapshot + the remote kill switch.
   The kill switch rides commands.json (ordering.enabled=false); the .env
   master switch ORDERING_ENABLED on the pipeline machine must ALSO be on
   for anything to be placed — this button can only ever make it safer. */
const ORDER_STATE_CHIP = {
  pending: "neutral", verified: "good", placing: "warning", placed: "good",
  received: "good", rejected: "neutral", failed: "serious",
  needs_review: "critical",
};

function ordersPanel(data) {
  const body = el("div", {});
  const status = el("div", { class: "hint", style: "margin-top:8px" });
  const summary = data.orders || {};
  const counts = summary.counts || {};

  const chips = el("div", {});
  for (const [state, count] of Object.entries(counts)) {
    chips.append(el("span", {
      class: `chip ${ORDER_STATE_CHIP[state] || "neutral"}`,
      style: "margin-right:8px",
    }, el("span", { class: "dot" }), `${state}: ${count}`));
  }
  body.append(Object.keys(counts).length
    ? chips
    : el("div", { class: "chip neutral" }, el("span", { class: "dot" }),
        "no order intents yet"));

  // Outstanding payments: placed, not known paid, no tracking yet. Payment
  // is deliberately manual — AliExpress's bulk "Pay all" on My Orders.
  const out = summary.outstanding || {};
  body.append(el("div", { style: "margin-top:10px" },
    out.count
      ? el("span", { class: "chip warning", style: "margin-right:10px" },
          el("span", { class: "dot" }),
          `${out.count} order${out.count > 1 ? "s" : ""} awaiting payment — ${fmtR(out.total_rand)}`)
      : el("span", { class: "chip good", style: "margin-right:10px" },
          el("span", { class: "dot" }), "no payments outstanding"),
    el("a", {
      class: "btn ghost",
      href: "https://www.aliexpress.com/p/order/index.html?spm=a2g0o.order_list",
      target: "_blank", rel: "noopener",
    }, "💳 Pay on AliExpress ↗")));

  // Stock on hand: what "Mark received" has booked into the inventory
  // collection (estimated landed cost until actuals exist).
  const inv = summary.inventory || {};
  if (inv.rows) {
    body.append(el("div", { style: "margin-top:10px" },
      el("span", { class: "chip good" }, el("span", { class: "dot" }),
        `📥 ${fmtNum(inv.units)} unit${inv.units > 1 ? "s" : ""} in stock ` +
        `across ${inv.rows} receipt${inv.rows > 1 ? "s" : ""} — ` +
        `${fmtR(inv.value_rand)} (estimate)`)));
  }

  if ((summary.recent || []).length) {
    const table = el("table", { class: "data" },
      el("tr", {}, el("th", {}, "intent"), el("th", {}, "asin"),
         el("th", {}, "state"), el("th", {}, "qty"), el("th", {}, "cost"),
         el("th", {}, "when"), el("th", {}, "tracking"),
         el("th", {}, "last note")));
    for (const o of summary.recent) {
      table.append(el("tr", {},
        el("td", { class: "t" }, o.id),
        el("td", { class: "t" }, o.asin ?? "—"),
        el("td", { class: "t" }, (o.state ?? "?") +
          (o.ae_order_ids?.length ? ` (AE ${o.ae_order_ids.join(", ")})` : "")),
        el("td", {}, fmtNum(o.quantity)),
        el("td", {}, o.order_cost != null ? fmtR(o.order_cost) : "—"),
        el("td", { class: "t" }, fmtAgo(o.received_at)),
        el("td", { class: "t" }, trackingCell(o.tracking)),
        el("td", { class: "t" }, o.note ?? "")));
    }
    body.append(el("div", { class: "scroll-x", style: "margin-top:10px" }, table));
  }

  if (localStorage.getItem(PAT_KEY)) {
    async function setKill(enabled) {
      const label = enabled ? "enable ordering" : "KILL ordering";
      status.textContent = `${label}…`;
      try {
        await mutateCommands((doc) => {
          doc.ordering = { ...(doc.ordering || {}), enabled };
        }, `Dashboard: ${label}`);
        status.textContent = enabled
          ? "Ordering enabled remotely — placement still needs " +
            "ORDERING_ENABLED=1 in .env on the pipeline machine."
          : "Kill switch tripped — the pipeline stops placing orders " +
            "within ~30s. Already-placed orders are unaffected.";
      } catch (e) {
        status.textContent = `${label} failed: ${e.message}`;
        if (/401|403/.test(e.message)) localStorage.removeItem(PAT_KEY);
      }
    }
    body.append(el("div", { style: "margin-top:12px" },
      el("button", { class: "btn", onclick: () => setKill(false) },
        "🛑 Kill switch — stop all ordering"),
      " ",
      el("button", { class: "btn ghost", onclick: () => setKill(true) },
        "Re-enable ordering")));
  } else {
    body.append(el("p", { class: "hint", style: "margin-top:10px" },
      "Paste the GitHub token under Remote control to use the kill switch."));
  }
  body.append(status);
  return panel("Ordering", body);
}

/* Selling kill switches: the remote halves of the double switches guarding
   channel submissions (services/listings.py reads commands.listing.enabled,
   services/takealot.py reads commands.takealot.enabled). Same contract as
   the ordering kill: tripping it stops submissions within ~30s; enabling
   still needs the matching .env switch on the pipeline machine, so these
   buttons can only ever make things safer. Queueing intents on the seller
   page is unaffected either way — queued work just waits. */
function sellingPanel(data) {
  const body = el("div", {});
  const status = el("div", { class: "hint", style: "margin-top:8px" });

  if (!localStorage.getItem(PAT_KEY)) {
    body.append(el("p", { class: "hint" },
      "Paste the token under Remote control to use the kill switches."));
    return panel("Selling kill switches", body);
  }

  async function setKill(key, label, enabled) {
    const action = enabled ? `enable ${label}` : `KILL ${label}`;
    status.textContent = `${action}…`;
    try {
      await mutateCommands((doc) => {
        doc[key] = { ...(doc[key] || {}), enabled };
      }, `Dashboard: ${action}`);
      status.textContent = enabled
        ? `${label} enabled remotely — submissions still need the .env ` +
          "switch on the pipeline machine."
        : `Kill switch tripped — ${label} submissions stop within ~30s. ` +
          "Queued intents keep their state and wait.";
    } catch (e) {
      status.textContent = `${action} failed: ${e.message}`;
      if (/401|403/.test(e.message)) localStorage.removeItem(PAT_KEY);
    }
  }

  for (const [key, label] of [["listing", "Amazon listings"],
                              ["takealot", "Takealot offers"]]) {
    body.append(el("div", { style: "margin-bottom:8px" },
      el("button", { class: "btn", onclick: () => setKill(key, label, false) },
        `🛑 Kill ${label}`),
      " ",
      el("button", { class: "btn ghost", onclick: () => setKill(key, label, true) },
        `Re-enable ${label}`)));
  }
  body.append(status);
  return panel("Selling kill switches", body);
}

/* Snapshot sweep status: live phase + ETA while sweeping, last completion
   with per-channel observation counts, next scheduled fire (daily 09:00
   task; post-run sweeps fire earlier when the 12h gap allows), and the
   recent completion history — one chip per swept day. */
const SWEEP_PHASE_LABEL = {
  rank: "rank pass (Amazon)", pricing: "pricing pass (Amazon)",
  takealot: "Takealot pass",
};

function sweepPanel(sweep) {
  const body = el("div", {});

  if (sweep.running && sweep.phase) {
    const done = sweep.phase_done || 0;
    const total = sweep.phase_total || 1;
    body.append(el("div", { style: "margin-bottom:8px" },
      el("span", { class: "chip warning", style: "margin-right:10px" },
        el("span", { class: "dot" }),
        `sweeping — ${SWEEP_PHASE_LABEL[sweep.phase] || sweep.phase}`),
      el("span", { class: "hint" },
        `${fmtNum(done)}/${fmtNum(total)} chunks` +
        (sweep.eta_seconds ? ` · ~${fmtDur(sweep.eta_seconds)} left in this phase` : "") +
        (sweep.started_at ? ` · started ${fmtAgo(sweep.started_at)}` : ""))));
    body.append(el("div", { class: "bars" }, el("div", { class: "row" },
      el("div", { class: "name" }, sweep.phase),
      el("div", { class: "track" },
        el("div", { class: "fill",
                    style: `width:${Math.max(2, (done / total) * 100)}%` })),
      el("div", { class: "count" }, `${Math.round((done / total) * 100)}%`))));
  } else if (sweep.state === "died mid-sweep") {
    body.append(el("div", { class: "chip serious", style: "margin-bottom:8px" },
      el("span", { class: "dot" }),
      `sweep died mid-pass (no progress since ${fmtAgo(sweep.progress_at)}) — ` +
      "the next scheduled sweep re-covers it"));
  }

  const tiles = el("div", { class: "grid tiles" },
    tile("Last swept", sweep.last_completed_at
      ? fmtAgo(sweep.last_completed_at) : "never",
      sweep.asins ? `${fmtNum(sweep.asins)} ASINs` : null),
    tile("Next due", sweep.running ? "running now" : fmtIn(sweep.next_due_at),
      "daily 09:00 task; post-run sweeps fire earlier when the 12h gap allows"),
    tile("Observations",
      `${fmtNum((sweep.rank_observations || 0) + (sweep.pricing_observations || 0))}`,
      `rank ${fmtNum(sweep.rank_observations)} · pricing ${fmtNum(sweep.pricing_observations)}` +
      (sweep.takealot_observations != null
        ? ` · takealot ${fmtNum(sweep.takealot_observations)}` : "")),
  );
  body.append(tiles);

  if ((sweep.history || []).length) {
    const days = el("div", { style: "margin-top:10px" });
    for (const h of sweep.history.slice(0, 14)) {
      days.append(el("span", {
        class: "chip neutral", style: "margin-right:6px;margin-bottom:6px",
        title: `${fmtNum(h.asins)} ASINs · rank ${fmtNum(h.rank)} · ` +
               `pricing ${fmtNum(h.pricing)}` +
               (h.takealot != null ? ` · takealot ${fmtNum(h.takealot)}` : "") +
               (h.duration_minutes ? ` · ${h.duration_minutes} min` : ""),
      }, el("span", { class: "dot" }), fmtDate(h.at)));
    }
    body.append(el("div", { class: "hint" }, "days swept (newest first):"), days);
  }

  return panel("Snapshot sweep", body);
}

/* Seller Central to-dos: the two manual approval queues the pipeline can
   prepare but never click through — per-productType GTIN exemptions and
   per-ASIN "Apply to sell" links (captured by the restrictions gate, which
   re-polls every 24h and unblocks granted ones on its own). */
const GTIN_FORM_URL = "https://sellercentral.amazon.co.za/gtinx";
const APPS_DASHBOARD_URL = "https://sellercentral.amazon.co.za/hz/myqdashboard";

function todosPanel(data) {
  const todos = data.seller_todos || {};
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

/* Accounting: monthly per-channel P&L off the transactions ledger, the
   rolling VAT-threshold gauge, the IRP6 provisional-tax numbers and the
   newest ledger rows. Data comes from metrics._accounting_summary();
   everything here is read-only — money entries happen via the Documents
   panel below or scripts/accounting_admin.py. */
function accountingPanel(acc) {
  const body = el("div", {});
  const pnl = acc.pnl || [];
  const current = pnl[pnl.length - 1] || {};
  const supplies = acc.supplies_12mo || {};
  const irp6 = acc.irp6 || {};

  if (acc.finances?.role_denied_at) {
    body.append(el("div", { class: "chip serious", style: "margin-bottom:10px" },
      el("span", { class: "dot" }),
      "Amazon Finances denied — grant the SP-API app the 'Finance and " +
      "Accounting' role in Seller Central; settlement actuals are missing " +
      "until then"));
  }

  const pct = Math.round((supplies.fraction || 0) * 100);
  body.append(el("div", { class: "grid tiles" },
    tile("Net this month", fmtR(current.net ?? 0),
      current.estimate_rand
        ? `${fmtR(current.estimate_rand)} of it rests on estimates`
        : "actuals only"),
    tile("VAT threshold", `${pct}%`,
      `${fmtR(supplies.total_rand)} of ${fmtR(supplies.threshold_rand)} ` +
      `· rolling 12mo supplies` + (acc.vat_registered ? " · REGISTERED" : "")),
    tile(irp6.next_deadline_label || "IRP6",
      irp6.days_to_deadline != null ? `${irp6.days_to_deadline}d` : "—",
      `YTD profit ${fmtR(irp6.ytd_profit_rand)} · ` +
      `annualised ${fmtR(irp6.annualised_rand)} (tax year ${irp6.tax_year ?? "—"})`),
    tile("Ledger rows", fmtNum(acc.ledger_rows || 0),
      acc.finances?.events_polled_at
        ? `finances polled ${fmtAgo(acc.finances.events_polled_at)}`
        : "Amazon Finances not yet polled"),
  ));

  if (pnl.length) {
    const table = el("table", { class: "data" },
      el("tr", {}, el("th", {}, "month"), el("th", {}, "amazon"),
         el("th", {}, "takealot"), el("th", {}, "fees"),
         el("th", {}, "cogs"), el("th", {}, "expenses"),
         el("th", {}, "net")));
    for (const m of [...pnl].reverse()) {
      table.append(el("tr", {},
        el("td", { class: "t" }, m.month + (m.estimate_rand ? " ~" : "")),
        el("td", {}, fmtR(m.revenue?.amazon)),
        el("td", {}, fmtR(m.revenue?.takealot)),
        el("td", {}, fmtR(m.fees)),
        el("td", {}, fmtR(m.cogs?.total)),
        el("td", {}, fmtR(m.expenses)),
        el("td", {}, fmtR(m.net))));
    }
    body.append(el("div", { class: "scroll-x", style: "margin-top:10px" }, table),
      el("div", { class: "hint" },
        "~ = month includes estimated rows (AliExpress supplier costs post " +
        "as order-time ZAR estimates — no settled-amount API)."));
  }

  if ((acc.recent || []).length) {
    const table = el("table", { class: "data" },
      el("tr", {}, el("th", {}, "when"), el("th", {}, "account"),
         el("th", {}, "description"), el("th", {}, "amount"),
         el("th", {}, "basis")));
    for (const r of acc.recent) {
      table.append(el("tr", {},
        el("td", { class: "t" }, fmtDate(r.posted_at)),
        el("td", { class: "t" }, `${r.account} ${r.account_name ?? ""}`),
        el("td", { class: "t" }, r.description ?? ""),
        el("td", {}, fmtR(r.amount)),
        el("td", { class: "t" }, r.basis ?? "")));
    }
    body.append(el("div", { class: "hint", style: "margin-top:10px" },
      "newest ledger rows:"),
      el("div", { class: "scroll-x" }, table));
  }
  return panel("Accounting", body);
}

/* Documents: upload receipts/invoices/customs paperwork → the Worker's R2
   transit → the pipeline drains them to the local canonical store (SARS:
   records live in SA), Gemini extracts the fields, and the suggested
   ledger rows wait HERE for review — Post/Ignore write accounting.
   post_docs / ignore_docs entries onto the command bus. Nothing posts
   without a click. */
const DOC_STATUS_CHIP = {
  new: "neutral", extracted: "warning", posted: "good",
  ignored: "neutral", extract_failed: "serious",
};

function docsPanel(acc) {
  const body = el("div", {});
  const status = el("div", { class: "hint", style: "margin-top:8px" });

  if (!localStorage.getItem(PAT_KEY)) {
    body.append(el("p", { class: "hint" },
      "Paste the token under Remote control to upload and review documents."));
    return panel("Documents", body);
  }

  const transit = el("div", { class: "hint", style: "margin-top:6px" });
  async function loadTransit() {
    try {
      const resp = await fetch(`${LIVE_BASE}/api/docs`,
        { headers: liveHeaders(), cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const docs = (await resp.json()).docs || [];
      transit.textContent = docs.length
        ? `in transit, awaiting drain: ${docs.map((d) => d.name).join(", ")}`
        : "";
    } catch (e) { transit.textContent = ""; }
  }
  loadTransit();

  async function upload(files) {
    let done = 0;
    for (const file of files) {
      status.textContent = `Uploading ${file.name}…`;
      try {
        const resp = await fetch(`${LIVE_BASE}/api/docs`, {
          method: "POST",
          headers: { ...liveHeaders(),
                     "content-type": file.type || "application/octet-stream",
                     "x-doc-name": encodeURIComponent(file.name) },
          body: file,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        done++;
      } catch (e) {
        status.textContent = `Upload of ${file.name} failed: ${e.message}`;
        if (/401|403/.test(e.message)) localStorage.removeItem(PAT_KEY);
        return;
      }
    }
    try {
      // The stamp wakes serve's long-poll, so the drain + extraction run
      // within seconds instead of on the backstop timer.
      await mutateCommands((doc) => {
        doc.docs = { ...(doc.docs || {}),
                     uploaded_at: new Date().toISOString() };
      }, "Dashboard: documents uploaded");
      status.textContent = `${done} file(s) uploaded — the pipeline drains ` +
        "and extracts within seconds ('serve' must be up).";
    } catch (e) {
      status.textContent = `${done} file(s) uploaded — wake-up stamp failed ` +
        `(${e.message}); the backstop drain picks them up within ~5 min.`;
    }
    loadTransit();
  }

  const input = el("input", {
    type: "file", multiple: "", accept: ".pdf,.jpg,.jpeg,.png,.webp",
    style: "max-width:100%",
    onchange: (ev) => {
      if (ev.target.files?.length) upload([...ev.target.files]);
      ev.target.value = "";
    },
  });
  body.append(
    el("div", {}, input),
    el("div", { class: "hint" },
      "PDF/JPG/PNG/WEBP up to 25 MB — receipts, supplier invoices, customs " +
      "paperwork (SAD 500 / clearance), courier invoices, statements."),
    transit);

  async function decide(id, action) {
    status.textContent = `${action} ${id}…`;
    try {
      await mutateCommands((doc) => {
        const bucket = (doc.accounting ??= {});
        const key = action === "post" ? "post_docs" : "ignore_docs";
        const fresh = (bucket[key] || []).filter((e) => e.id !== id &&
          Date.now() - new Date(e.requested_at).getTime() < 48 * 3600 * 1000);
        fresh.push({ id, requested_at: new Date().toISOString() });
        bucket[key] = fresh;
      }, `Dashboard: ${action} document ${id}`);
      status.textContent =
        `${action} sent for ${id} — applied within ~30s ('serve' must be up).`;
    } catch (e) {
      status.textContent = `${action} failed: ${e.message}`;
      if (/401|403/.test(e.message)) localStorage.removeItem(PAT_KEY);
    }
  }

  const docs = acc.documents || [];
  if (docs.length) {
    const table = el("table", { class: "data" },
      el("tr", {}, el("th", {}, "file"), el("th", {}, "status"),
         el("th", {}, "read as"), el("th", {}, "suggested rows"),
         el("th", {}, ""), el("th", {}, "")));
    for (const d of docs) {
      const read = d.doc_type
        ? `${d.doc_type} — ${d.supplier ?? "?"}` +
          (d.total_amount != null
            ? ` · ${d.currency ?? ""} ${fmtNum(d.total_amount)}` : "") +
          (d.confidence != null
            ? ` · conf ${Math.round(d.confidence * 100)}%` : "")
        : (d.error ?? "—");
      const suggested = (d.suggested || [])
        .map((s) => `${s.account}: ${fmtR(s.amount)} — ${s.description ?? ""}`)
        .join("; ");
      table.append(el("tr", {},
        el("td", { class: "t" }, d.filename ?? d.id),
        el("td", { class: "t" },
          el("span", { class: `chip ${DOC_STATUS_CHIP[d.status] || "neutral"}` },
            el("span", { class: "dot" }), d.status)),
        el("td", { class: "t" }, read),
        el("td", { class: "t" }, suggested || "—"),
        el("td", { class: "t" }, d.status === "extracted"
          ? el("button", { class: "btn",
                           onclick: () => decide(d.id, "post") },
              "Post to ledger")
          : ""),
        el("td", { class: "t" },
          ["extracted", "extract_failed", "new"].includes(d.status)
            ? el("button", { class: "btn ghost",
                             onclick: () => decide(d.id, "ignore") }, "Ignore")
            : "")));
    }
    body.append(el("div", { class: "scroll-x", style: "margin-top:10px" }, table));
  } else {
    body.append(el("div", { class: "chip neutral", style: "margin-top:10px" },
      el("span", { class: "dot" }), "no documents drained yet"));
  }
  body.append(status);
  return panel("Documents", body);
}

/* Logistics attention queue (services/logistics.attention_items): placed
   orders that need a human decision, worst first. Every row is an action
   with a deadline — the dispute-window ones are the money ones: after the
   buyer-protection window closes a refund is impossible, so they escalate
   to critical at 5 days out. */
function attentionPanel(items) {
  const body = el("div", {});
  if (!items.length) {
    body.append(el("div", { class: "chip good" }, el("span", { class: "dot" }),
      "no orders need attention"));
    return panel("Logistics attention", body);
  }
  const table = el("table", { class: "data" },
    el("tr", {}, el("th", {}, "issue"), el("th", {}, "order"),
       el("th", {}, "asin"), el("th", {}, "what to do"),
       el("th", {}, "act by")));
  for (const it of items) {
    const order = it.ae_order_ids?.[0];
    table.append(el("tr", {},
      el("td", {}, el("span", { class: `chip ${it.severity || "neutral"}` },
        el("span", { class: "dot" }), (it.kind || "?").replace(/_/g, " "))),
      el("td", { class: "t" }, order
        ? el("a", {
            href: `https://www.aliexpress.com/p/order/detail.html?orderId=${order}`,
            target: "_blank", rel: "noopener", title: it.intent_id,
          }, `AE ${order} ↗`)
        : it.order_id
          ? el("a", {
              href: `https://sellercentral.amazon.co.za/orders-v3/order/${it.order_id}`,
              target: "_blank", rel: "noopener", title: it.intent_id,
            }, `AMZ ${it.order_id} ↗`)
          : it.intent_id),
      el("td", { class: "t" }, it.asin ?? "—"),
      el("td", { class: "t" }, it.message),
      el("td", { class: "t" }, it.act_by ? fmtDate(it.act_by) : "—")));
  }
  body.append(el("div", { class: "scroll-x" }, table));
  return panel(`Logistics attention (${items.length})`, body);
}

/* Compact tracking cell: newest event + age, full detail on hover.
   The pipeline polls aliexpress.ds.order.tracking.get every 6h per placed
   order (services/ordering._track_placed). */
function trackingCell(t) {
  const latest = t?.events?.[0];
  if (!latest) return "—";
  const bits = [];
  if (latest.desc && latest.desc !== latest.name) bits.push(latest.desc);
  if (t.mail_no) bits.push(`waybill ${t.mail_no}` +
                           (t.carrier ? ` via ${t.carrier}` : ""));
  if (t.eta_at) bits.push(`ETA ${fmtDate(t.eta_at)}`);
  bits.push(`checked ${fmtAgo(t.checked_at)}`);
  return el("span", { title: bits.join(" — ") },
    `📦 ${latest.name || "update"} · ${fmtAgo(latest.at)}`);
}

function fmtDur(seconds) {
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
}

function fmtIn(iso) {
  const min = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  return min <= 0 ? "now (winding down)" : `in ${fmtDur(min * 60)}`;
}

function tile(label, value, hint) {
  return el("div", { class: "tile" },
    el("div", { class: "label" }, label),
    el("div", { class: "value" }, value),
    hint ? el("div", { class: "hint" }, hint) : null);
}

function panel(title, body, id) {
  return el("section", { class: "panel", ...(id ? { id } : {}) },
    el("h2", {}, title), body);
}

function kwRow(marker, entry) {
  return el("tr", {},
    el("td", { class: "t" }, marker),
    el("td", { class: "t" }, entry.keyword),
    el("td", {}, entry.score ?? "—"),
    el("td", {}, fmtNum(entry.products_found)),
    el("td", {}, fmtNum(entry.margin_success)));
}

async function loadAndRender(passphrase) {
  const envelope = await fetchJson("admin.enc");
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
        if (name !== "admin.enc") return;
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
