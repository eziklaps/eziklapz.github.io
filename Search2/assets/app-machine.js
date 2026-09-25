/* Machine desk — the pipeline itself: run control (start/stop/budget +
   the one-off stage runner), the autonomy dial, lanes with pause/resume,
   the backlog, and — behind one disclosure — the long tails (products per
   status, keywords, webhooks, sweep history, Gemini batches). Everything
   control-shaped commits to the command bus. */

const MACHINE_LANES = ["intake", "spapi", "gemini", "aliexpress", "local", "publisher"];

const STAGE_OPTIONS = [
  ["embed-submit", "embed-submit — submit embedding backlog (Gemini batch)"],
  ["vision-submit", "vision-submit — submit vision backlog (Gemini batch)"],
  ["vision-reverify", "vision-reverify — re-judge old rejections under the current gate (paid)"],
  ["pack-check", "pack-check — re-read pack counts on existing winners (paid)"],
  ["duties-submit", "duties-submit — submit duties backlog (Gemini batch)"],
  ["collect", "collect — ingest finished Gemini batches now"],
  ["matching", "matching — vector matching"],
  ["gate", "gate — provisional margin gate"],
  ["margins", "margins — calculate margins"],
  ["score", "score — opportunity score"],
  ["re-embed", "re-embed — refresh old vectors (paid)"],
  ["takealot-match", "takealot-match — winners vs Takealot catalog"],
  ["pull-takealot", "pull-takealot — Takealot demand discovery"],
  ["takealot-enrich", "takealot-enrich — offer stack + barcode"],
  ["restrictions", "restrictions — Amazon restrictions gate"],
  ["listings", "listings — process Amazon listing intents"],
  ["takealot-listings", "takealot-listings — process Takealot intents"],
];

function renderMachineDesk(root) {
  const a = S.admin || {};
  const running = a.funnel_state === "running";
  // The publish heartbeat is the pipeline's pulse — a live run pushes
  // every ~10s and an idle serve at least hourly, so the thresholds
  // differ by funnel state. wsChip/S.net come from app.js.
  const age = agoMinutes(a.generated_at);
  const pubTone = running
    ? (age <= 5 ? "ok" : "bad")
    : (age <= STALE_PUBLISH_MIN ? "ok" : "bad");
  const ack = a.commands_ack || {};

  root.append(deskHead("Machine", [
    running
      ? { text: "run active", tone: "ok", title: a.run_id ? `run ${a.run_id}` : "" }
      : { text: `no run · ${a.funnel_state || "idle"}`,
          title: a.run_id ? `last run ${a.run_id}` : "" },
    { text: "published", ago: a.generated_at, tone: pubTone,
      title: running && pubTone === "bad"
        ? "run active but publishing is stuck"
        : "publish heartbeat — a live run pushes every ~10s, an idle serve at least hourly" },
    wsChip(),
    S.net.failing ? { text: "data fetch failing — showing old data", tone: "bad" } : null,
    ack.applied_at
      ? { text: "last ack", ago: ack.applied_at, plain: true,
          title: `commands apply within ~30s while a run or serve is up (run ${ack.run ?? "—"})` }
      : { text: "no ack yet — is serve up?", tone: "warn" },
  ]));

  /* auth banner */
  const auth = a.aliexpress_auth || {};
  if (["expired", "expiring", "missing"].includes(auth.status)) {
    const critical = auth.status !== "expiring";
    root.append(el("div", { class: `warnbar${critical ? " bad" : ""}` },
      el("span", {},
        el("b", {}, critical
          ? `AliExpress tokens ${auth.status}`
          : `AliExpress refresh token expires ${fmtIn(auth.refresh_expires_at)}`),
        " — intake, SKU matching and freight stall on dead tokens. Run ",
        el("code", {}, "python runtime.py auth"),
        " on the pipeline machine, or:"),
      auth.authorize_url ? el("a", {
        class: "b sm line", href: auth.authorize_url,
        target: "_blank", rel: "noreferrer",
      }, "Re-authenticate AliExpress ↗") : null));
  }

  /* KPIs */
  const counts = a.status_counts || {};
  const total = Object.values(counts).reduce((x, y) => x + y, 0);
  const winners = counts["margin_calculation_success"] || 0;
  const backlog = Object.values(a.feed_depths || {}).reduce((x, y) => x + y, 0);
  const jobs = a.batch_jobs || [];
  const sweep = a.sweep || {};
  root.append(el("div", { class: "kpis" },
    kpi("Products", fmtNum(total), "in the funnel"),
    kpi("Winners", el("span", { class: "v ok" }, fmtNum(winners)), "margin calculated"),
    kpi("Backlog", fmtNum(backlog),
      (backlog
        ? (a.work_eta_seconds > 0 ? `paced ~${fmtDur(a.work_eta_seconds)}` : "docs awaiting a stage")
        : "every stage drained")
      + (jobs.length ? ` · ${jobs.length} Gemini batch${jobs.length > 1 ? "es" : ""} at Google` : "")),
    kpi("Snapshot sweep",
      sweep.running
        ? el("span", { class: "v warn", style: "color:var(--warn-text)" }, "running")
        : sweep.last_completed_at ? fmtAgo(sweep.last_completed_at) : "never",
      sweep.running && sweep.phase
        ? `${SWEEP_PHASE_LABEL[sweep.phase] || sweep.phase} · ` +
          `${fmtNum(sweep.phase_done || 0)}/${fmtNum(sweep.phase_total || 0)} chunks` +
          (sweep.eta_seconds ? ` · ~${fmtDur(sweep.eta_seconds)} left` : "")
        : sweep.state === "died mid-sweep"
          ? `died mid-pass · no progress since ${fmtAgo(sweep.progress_at)}`
          : `${sweep.asins ? `${fmtNum(sweep.asins)} ASINs · ` : ""}next ${fmtIn(sweep.next_due_at)}`)));

  root.append(runControlPanel(a));
  const ap = autonomyPanel(a);
  if (ap) root.append(ap);
  const dp = discoveryPanel(a);
  if (dp) root.append(dp);

  root.append(el("div", {
    style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;align-items:start",
  }, lanesPanel(a), backlogPanel(a)));

  if ((a.errors || []).length) root.append(errorsPanel(a.errors));

  /* the long tails — worth having, not worth seeing every day */
  const detail = el("div", { class: "disclose" },
    el("a", {
      onclick: () => { S.machineDetail = !S.machineDetail; renderDesk(); },
    }, S.machineDetail ? "Hide pipeline detail ▴" : "Pipeline detail ▾"),
    " — products per status, keywords, Takealot webhooks, sweep history" +
    (jobs.length ? ", Gemini batches" : ""));
  root.append(detail);
  if (S.machineDetail) {
    root.append(el("div", {
      style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;align-items:start",
    },
      el("div", { style: "display:flex;flex-direction:column;gap:16px" },
        statusCountsPanel(counts, total),
        jobs.length ? batchPanel(a) : null),
      el("div", { style: "display:flex;flex-direction:column;gap:16px" },
        keywordsPanel(a), sweepPanelEl(a.sweep), webhooksPanel(a.takealot_events))));
  }
}

function runControlPanel(a) {
  const status = statusLine();
  const running = a.funnel_state === "running";
  const budget = a.budget || {};

  const budgetSelect = el("select", { class: "in" },
    el("option", { value: "" }, "Next run: until done"),
    el("option", { value: "60" }, "1 hour"),
    el("option", { value: "180" }, "3 hours"),
    el("option", { value: "360" }, "6 hours"),
    el("option", { value: "720" }, "12 hours"),
    el("option", { value: "1440" }, "24 hours"),
    el("option", { value: "continuous" }, "Continuous (24/7)"));
  const stageSelect = el("select", { class: "in", style: "max-width:290px" },
    ...STAGE_OPTIONS.map(([value, label]) => el("option", { value }, label)));

  const p = panelEl("Run control", {
    right: el("span", {
      title: "one-off stages run between publish ticks without a full funnel " +
             "run ('serve' must be up) · in-flight Gemini batches survive a " +
             "stop and are collected next run",
    }, "stop is graceful · stages run without a full run"),
  });
  p.append(el("div", { style: "display:flex;align-items:center;gap:12px;flex-wrap:wrap" },
    el("div", { class: `runpill${running ? "" : " idle"}` },
      dotEl(running ? "ok" : "mute"),
      el("b", {}, running ? "Running" : (a.funnel_state || "no run")),
      running && budget.minutes
        ? el("span", { class: "sub" },
            budget.continuous
              ? `continuous 24/7 · cycle ${budget.cycle || 1}`
              : budget.run_until
                ? `cycle ${budget.cycle || 1} · run ends ${fmtIn(budget.run_until)}`
                : `${fmtDur(budget.minutes * 60)} budget` +
                  (budget.deadline_at ? ` · ends ${fmtIn(budget.deadline_at)}` : ""))
        : null),
    running ? el("button", {
      class: "b danger",
      onclick: () => busAct("stop run", (doc) => {
        (doc.run ??= {}).desired = "stopped";
      }, status, "Stop sent — in-flight Gemini batches survive and are collected next run."),
    }, "Stop run") : null,
    el("div", { class: "vsep" }),
    budgetSelect,
    el("button", {
      class: "b pri",
      onclick: () => {
        const continuous = budgetSelect.value === "continuous";
        const minutes = !continuous && budgetSelect.value
          ? Number(budgetSelect.value) : null;
        const label = continuous ? "start run (continuous 24/7)"
          : minutes ? `start run (${fmtDur(minutes * 60)})` : "start run";
        // continuous is written both ways: a stale true from a previous
        // 24/7 start must not ride along under a plain duration pick.
        busAct(label, (doc) => {
          doc.run = { ...(doc.run || {}), desired: "running",
                      start_requested_at: new Date().toISOString(),
                      budget_minutes: minutes, continuous };
        }, status);
      },
    }, "Start run"),
    el("div", { class: "vsep" }),
    stageSelect,
    el("button", {
      class: "b line",
      onclick: () => busAct(`run stage ${stageSelect.value}`, (doc) => {
        doc.run = { ...(doc.run || {}), stages: [stageSelect.value],
                    stages_requested_at: new Date().toISOString() };
      }, status),
    }, "Run stage")));
  p.append(status);
  return p;
}

/* ---------- the autonomy dial (Phase 5) ---------- */

const AUTONOMY_SUBS = [
  ["reorder", "Reorder", "replenishment proposals for proven sellers", (c) =>
    `up to ${c.max_per_pass ?? 5} proposals every ${c.pass_hours ?? 6}h · ` +
    "proven sellers, cheap freight · AUTO self-approves into the normal " +
    "verify → affordability → place path (payment stays yours)"],
  ["repricer", "Repricer", "price moves inside the caps", (c) =>
    `pass every ${Math.round((c.pass_seconds ?? 1800) / 60)}min · ` +
    "floor-guarded, capped daily · PROPOSE refreshes decisions without " +
    "moving prices; AUTO moves them"],
  ["twins", "Takealot twins", "a Takealot offer for each Amazon order", () =>
    "each Amazon order proposes its Takealot twin · AUTO queues twins " +
    "itself (barcode/loadsheet machinery unchanged)"],
  ["wide_listings", "Wide listings", "new Amazon pages for no-counterpart winners", (c) =>
    `daily propose pass (spends AE + SP-API probes) · pilot ` +
    `${c.in_flight ?? 0}/${c.pilot_cap ?? 50} in flight · kill rule and ` +
    "8571 backoff bind in every position"],
];

const AUTONOMY_CONFIRM = {
  propose: {
    wide_listings: "Put wide listings on the daily PROPOSE cadence? Each " +
      "pass probes AliExpress + SP-API for surviving candidates (capped), " +
      "and proposals land on Today for your Approve.",
  },
  auto: {
    reorder: "Set reorder to AUTO? Fresh proposals approve THEMSELVES " +
      "into the order path — affordability gate, daily budget and margin " +
      "floor still bind, and payment stays a human press.",
    repricer: "Set the repricer to AUTO? Prices start moving — floor-" +
      "guarded, inside the daily caps.",
    twins: "Set twins to AUTO? New Amazon orders queue their Takealot " +
      "twin without waiting for Approve.",
    wide_listings: "Set wide listings to AUTO? Daily proposals queue " +
      "themselves toward validation preview — pilot cap and the zero-" +
      "sale kill rule still bind.",
  },
};

function autonomyPanel(a) {
  const auto = a.autonomy;
  if (!auto) return null; // payload predates the dial (serve not restarted)
  const status = statusLine();
  const p = panelEl("Autonomy", {
    right: el("span", {
      title: "off = the pass stays still · propose = cards wait for your " +
             "press on Today · auto = fresh proposals approve themselves. " +
             "Affordability, floors, caps, exemptions and the kill rule " +
             "bind in every position; payment is always a human press.",
    }, "off · propose · auto — hard gates always bind"),
  });
  for (const [key, label, short, describe] of AUTONOMY_SUBS) {
    const cfg = auto[key] || {};
    // A press still riding the bus wins the display (switch contract).
    const press = ((S.commands || {}).autonomy || {})[key] || null;
    const pending = press && press.requested_at
      && press.requested_at !== cfg.requested_at ? press : null;
    const mode = pending ? pending.mode : (cfg.mode || "off");
    const seg = el("span", { style: "display:inline-flex;gap:4px" });
    for (const m of ["off", "propose", "auto"]) {
      seg.append(el("button", {
        class: `b xs ${m === mode ? (m === "auto" ? "danger" : "pri") : ""}`,
        ...(pending || m === mode ? { disabled: "" } : {}),
        onclick: () => {
          const ask = (AUTONOMY_CONFIRM[m] || {})[key];
          if (ask && !confirm(ask)) return;
          busAct(`autonomy ${key} → ${m}`, (doc) => {
            doc.autonomy = { ...(doc.autonomy || {}),
              [key]: { mode: m, requested_at: new Date().toISOString() } };
          }, status);
          seg.replaceWith(el("span", { class: "st warn" }, "applying"));
        },
      }, m));
    }
    p.append(el("div", { class: "switchrow" },
      el("span", { title: describe(cfg) },
        el("span", { style: "font-weight:600" }, label),
        el("span", { class: "hint", style: "margin-left:8px" }, short),
        pending ? el("span", { class: "st warn", style: "margin-left:8px" },
          "applying") : null,
        key === "wide_listings" && cfg.paused_reason
          ? el("span", { class: "st hot", style: "margin-left:8px" },
              `paused — ${cfg.paused_reason}`) : null),
      seg));
  }
  p.append(status);
  return p;
}

/* ---------- the discovery-mode switch (2026-09-23) ---------- */

function discoveryPanel(a) {
  const d = a.discovery;
  if (!d || d.error) return null; // payload predates the switch
  const status = statusLine();
  const p = panelEl("Discovery", {
    right: el("span", {
      title: "which source the 24h machine's Takealot intake pulls from " +
             "each cycle. Bestsellers: Takealot's own bestseller + trending " +
             "lists per department and category — what actually sells; " +
             "matched ones move their seller to the head of the seller " +
             "queue. Sellers: browse the in-stock storefronts of PROVEN " +
             "sellers — a rating history is sales evidence and DC stock is " +
             "capital committed. Keywords: search what shoppers type (the " +
             "keyword ledger). Rotate: each source in turn, pass by pass.",
    }, "the Takealot intake source"),
  });
  // A press still riding the bus wins the display (switch contract).
  const press = (S.commands || {}).discovery || null;
  const pending = press && press.requested_at
    && press.requested_at !== d.applied_stamp ? press : null;
  const mode = pending ? pending.mode : (d.mode || "rotate");
  const seg = el("span", { style: "display:inline-flex;gap:4px;flex-wrap:wrap" });
  for (const m of d.modes || ["rotate", "bestsellers", "sellers", "keywords"]) {
    seg.append(el("button", {
      class: `b xs ${m === mode ? "pri" : ""}`,
      ...(pending || m === mode ? { disabled: "" } : {}),
      onclick: () => {
        busAct(`discovery mode → ${m}`, (doc) => {
          doc.discovery = { mode: m, requested_at: new Date().toISOString() };
        }, status);
        seg.replaceWith(el("span", { class: "st warn" }, "applying"));
      },
    }, m));
  }
  const s = d.sellers || {};
  p.append(el("div", { class: "switchrow" },
    el("span", {
      title: "the seller ledger fills passively from every product page " +
             "the pipeline reads (the winners sweep names each page's " +
             "buybox winner with its rating history); browseworthy = " +
             "enough recent ratings, decent average, real DC stock, not " +
             "us, not retail-scale",
    },
      el("span", { style: "font-weight:600" }, "Takealot intake"),
      el("span", { class: "hint", style: "margin-left:8px" },
        s.total != null
          ? `${fmtNum(s.browseworthy ?? 0)} browseworthy of ` +
            `${fmtNum(s.total)} sellers seen · ${fmtNum(s.rated ?? 0)} rated`
          : "seller ledger fills from the daily page reads",
        d.rotation && mode === "rotate"
          ? ` · next pass: ${d.rotation.next}` : "",
        d.bestsellers
          ? ` · ${fmtNum(d.bestsellers.scored ?? 0)}/` +
            `${fmtNum(d.bestsellers.categories ?? 0)} categories scored · ` +
            `${fmtNum(d.bestsellers.lists_today ?? 0)} lists today · ` +
            `${fmtNum(d.bestsellers.chained_sellers ?? 0)} demand-backed sellers`
          : ""),
      pending ? el("span", { class: "st warn", style: "margin-left:8px" },
        "applying") : null),
    seg));
  p.append(status);
  return p;
}

const LANE_TONE = { running: "ok", idle: "mute", done: "ok", paused: "warn",
                    error: "hot", failed: "bad", stopped: "mute", starting: "mute" };

function lanesPanel(a) {
  const lanes = a.lanes || {};
  const status = statusLine();
  const names = Object.keys(lanes).length ? Object.keys(lanes) : MACHINE_LANES;
  const p = panelEl("Lanes", {
    right: Object.keys(lanes).length ? "" : "states appear while a run is live",
  });
  for (const name of names) {
    const lane = lanes[name] || {};
    const tone = LANE_TONE[lane.state] || "mute";
    p.append(el("div", { class: "lanerow" },
      dotEl(tone, true),
      el("span", { class: "ln" }, name),
      el("span", { class: "ls" },
        el("span", { class: `st ${tone}` }, lane.state || "no data"),
        lane.pending ? " · work pending" : "",
        lane.cycles != null
          ? ` · ${fmtNum(lane.cycles)} cycles · last ${fmtAgo(lane.last_activity)}` : "",
        lane.last_error
          ? el("div", { style: "color:var(--bad)" },
              `last error: ${lane.last_error.message} (${fmtAgo(lane.last_error.at)})`)
          : null),
      el("span", { style: "display:flex;gap:4px" },
        el("button", {
          class: "b xs",
          onclick: () => busAct(`pause ${name}`, (doc) => {
            (doc.lanes ??= {})[name] = "paused";
          }, status),
        }, "Pause"),
        el("button", {
          class: "b xs",
          onclick: () => busAct(`resume ${name}`, (doc) => {
            (doc.lanes ??= {})[name] = "running";
          }, status),
        }, "Resume"))));
  }
  p.append(status);
  return p;
}

function backlogPanel(a) {
  const depths = Object.entries(a.feed_depths || {}).sort((x, y) => y[1] - x[1]);
  const totalDocs = depths.reduce((s, [, n]) => s + n, 0);
  const p = panelEl("Awaiting each stage", {
    right: depths.length
      ? `${fmtNum(totalDocs)} docs` +
        (a.work_eta_seconds > 0 ? ` · paced ~${fmtDur(a.work_eta_seconds)}` : "")
      : null,
  });
  if (!depths.length) {
    p.append(emptyLine("No backlog — every stage is drained."));
    return p;
  }
  const max = depths[0][1];
  const bars = el("div", { class: "bars" });
  for (const [stage, count] of depths) {
    bars.append(el("div", { class: "brow" },
      el("span", {}, stage),
      el("div", { class: "track" },
        el("div", { class: "fill", style: `width:${Math.max(3, (count / max) * 100)}%` })),
      el("span", { class: "n" }, fmtNum(count))));
  }
  p.append(bars);
  return p;
}

function batchPanel(a) {
  const jobs = a.batch_jobs || [];
  const p = panelEl("Gemini batch jobs", {
    right: el("span", {
      title: "batch = 50% cheaper, results within minutes–24h · 'collect' ingests finished jobs",
    }, `${jobs.length} in flight`),
  });
  const table = el("table", { class: "grid" },
    el("tr", {}, el("th", {}, "Stage"), el("th", {}, "State"),
      el("th", {}, "Docs"), el("th", {}, "Submitted")));
  for (const j of jobs) {
    const tone = /RUN|PEND/i.test(j.provider_state) ? "warn"
      : /SUCC/i.test(j.provider_state) ? "ok" : "mute";
    table.append(el("tr", {},
      el("td", { class: "t" }, j.stage),
      el("td", { class: "t" }, el("span", { class: `st ${tone}` },
        (j.provider_state || "?").replace(/^JOB_STATE_/, ""))),
      el("td", {}, fmtNum(j.doc_count)),
      el("td", { class: "t", style: "color:var(--muted);font-size:12px" },
        fmtAgo(j.submitted_at))));
  }
  p.append(el("div", { class: "scroll-x" }, table));
  return p;
}

function keywordsPanel(a) {
  const kw = a.keywords || {};
  const bits = ["amazon", "takealot"].filter((m) => kw[m]).map((m) => {
    const s = kw[m];
    return `${m} ${s.pending ?? 0} pending · ${s.processing ?? 0} processing · ${s.completed ?? 0} done`;
  }).join(" — ");
  const p = panelEl("Keywords", { right: bits });
  const table = el("table", { class: "grid" },
    el("tr", {}, el("th", {}, "Keyword"), el("th", {}, "Score"),
      el("th", {}, "Found"), el("th", {}, "Margined")));
  const row = (tone, e) => el("tr", {},
    el("td", { class: "t" }, el("span", { class: `st ${tone}`, style: "font-weight:500" }, e.keyword)),
    el("td", {}, e.score ?? "—"),
    el("td", {}, fmtNum(e.products_found)),
    el("td", {}, fmtNum(e.margin_success)));
  for (const e of kw.top || []) table.append(row("ok", e));
  for (const e of kw.bottom || []) table.append(row("mute", e));
  if ((kw.top || []).length + (kw.bottom || []).length === 0) {
    p.append(emptyLine("No scored keywords yet."));
  } else {
    p.append(el("div", { class: "scroll-x" }, table));
  }
  return p;
}

const SWEEP_PHASE_LABEL = {
  rank: "rank pass (Amazon)", pricing: "pricing pass (Amazon)",
  takealot: "Takealot pass",
};

function sweepPanelEl(sweep) {
  const p = panelEl("Snapshot sweep", {
    right: "daily task · post-run sweeps fire earlier",
  });
  if (!sweep) { p.append(emptyLine("No sweep has run yet.")); return p; }

  if (sweep.running && sweep.phase) {
    const done = sweep.phase_done || 0, total = sweep.phase_total || 1;
    p.append(el("div", { style: "margin-bottom:8px" },
      pill("warn", `sweeping — ${SWEEP_PHASE_LABEL[sweep.phase] || sweep.phase}`),
      el("span", { class: "hint", style: "margin-left:8px" },
        `${fmtNum(done)}/${fmtNum(total)} chunks` +
        (sweep.eta_seconds ? ` · ~${fmtDur(sweep.eta_seconds)} left` : ""))),
      el("div", { class: "gauge", style: "margin-bottom:10px" },
        el("span", { style: `width:${Math.max(2, (done / total) * 100)}%` })));
  } else if (sweep.state === "died mid-sweep") {
    p.append(el("div", { style: "margin-bottom:8px" },
      pill("hot", `sweep died mid-pass (no progress since ${fmtAgo(sweep.progress_at)})`)));
  }

  const grid = el("div", { style: "display:grid;grid-template-columns:repeat(3,1fr);gap:10px" });
  const cell = (label, value, sub) => el("div", {},
    el("div", { style: "font-size:11px;color:var(--muted);font-weight:650;text-transform:uppercase;letter-spacing:.06em" }, label),
    el("div", { style: "font-size:16px;font-weight:650;margin-top:2px" }, value),
    sub ? el("div", { class: "hint" }, sub) : null);
  grid.append(
    cell("Last swept", sweep.last_completed_at ? fmtAgo(sweep.last_completed_at) : "never",
      sweep.asins ? `${fmtNum(sweep.asins)} ASINs` : null),
    cell("Next due", sweep.running ? "running" : fmtIn(sweep.next_due_at), null),
    cell("Observations",
      fmtNum((sweep.rank_observations || 0) + (sweep.pricing_observations || 0)
        + (sweep.takealot_observations || 0)),
      `rank ${fmtNum(sweep.rank_observations)} · pricing ${fmtNum(sweep.pricing_observations)}` +
      (sweep.takealot_observations != null ? ` · tkl ${fmtNum(sweep.takealot_observations)}` : "")));
  p.append(grid);

  if ((sweep.history || []).length) {
    const days = el("div", { class: "chiprow", style: "margin-top:10px" });
    for (const h of sweep.history.slice(0, 7)) {
      days.append(el("span", {
        class: "tag",
        title: `${fmtNum(h.asins)} ASINs · rank ${fmtNum(h.rank)} · pricing ${fmtNum(h.pricing)}` +
          (h.takealot != null ? ` · tkl ${fmtNum(h.takealot)}` : "") +
          (h.duration_minutes ? ` · ${h.duration_minutes} min` : ""),
      }, fmtDate(h.at)));
    }
    p.append(days);
  }
  return p;
}

function webhooksPanel(ev) {
  const p = panelEl("Takealot webhooks", {
    right: ev ? `${fmtNum(ev.total)} total · edge receiver → 15-min drain` : null,
  });
  if (!ev || !(ev.recent || []).length) {
    p.append(emptyLine("No webhook deliveries yet — the pipe wakes with the " +
      "first live offer event."));
    return p;
  }
  const table = el("table", { class: "grid" },
    el("tr", {}, el("th", {}, "Event"), el("th", {}, "Verified"),
      el("th", {}, "Received"), el("th", {}, "Drained")));
  for (const e of ev.recent) {
    table.append(el("tr", {},
      el("td", { class: "t", title: e.delivery }, e.event || "?"),
      el("td", { class: "t" }, e.verified
        ? el("span", { class: "st ok" }, "signed")
        : el("span", { class: "st warn" }, "unsigned")),
      el("td", { class: "t", style: "color:var(--muted);font-size:12px" }, fmtAgo(e.received_at)),
      el("td", { class: "t", style: "color:var(--muted);font-size:12px" }, fmtAgo(e.drained_at))));
  }
  p.append(el("div", { class: "scroll-x" }, table));
  return p;
}

function statusCountsPanel(counts, total) {
  const p = panelEl("Products per status", { right: `${fmtNum(total)} total` });
  const table = el("table", { class: "grid" },
    el("tr", {}, el("th", {}, "Status"), el("th", { class: "r" }, "Products")));
  for (const [st, count] of Object.entries(counts).sort((x, y) => y[1] - x[1])) {
    const winner = st === "margin_calculation_success";
    table.append(el("tr", {},
      el("td", { class: "t", style: winner ? "color:var(--ok-text);font-weight:600" : "color:var(--ink2)" }, st),
      el("td", { class: "r", style: winner ? "color:var(--ok-text);font-weight:600" : "" }, fmtNum(count))));
  }
  p.append(el("div", { class: "scroll-x" }, table));
  return p;
}

function errorsPanel(errors) {
  const p = panelEl("Recent lane errors", {
    right: el("span", {
      title: "API-spending stages keep the one-attempt-per-doc-per-run rule — " +
             "errors park the doc, never loop it",
    }, `${errors.length} parked`),
  });
  const table = el("table", { class: "grid" },
    el("tr", {}, el("th", {}, "Lane"), el("th", {}, "When"), el("th", {}, "Error")));
  for (const err of errors) {
    table.append(el("tr", {},
      el("td", { class: "t" }, err.lane),
      el("td", { class: "t", style: "color:var(--muted);font-size:12px" }, fmtAgo(err.at)),
      el("td", { class: "t", style: "color:var(--ink2);font-size:12px;overflow-wrap:anywhere" }, err.message)));
  }
  p.append(el("div", { class: "scroll-x" }, table));
  return p;
}
