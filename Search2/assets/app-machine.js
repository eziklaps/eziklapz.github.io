/* Machine desk — the pipeline itself: run control (start/stop/budget +
   the one-off stage runner), lane cards with pause/resume, backlogs,
   Gemini batch jobs, keywords, the snapshot sweep and the webhook pipe.
   Everything control-shaped commits to the command bus. */

const MACHINE_LANES = ["intake", "spapi", "gemini", "aliexpress", "local", "publisher"];

const STAGE_OPTIONS = [
  ["embed-submit", "embed-submit — submit embedding backlog (Gemini batch)"],
  ["vision-submit", "vision-submit — submit vision backlog (Gemini batch)"],
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
  root.append(deskHead("Machine",
    `funnel: ${a.funnel_state || "none"}` +
    (a.run_id ? ` · run ${a.run_id}` : "") +
    " · commands apply within ~30s"));

  root.append(connectionChips(a));

  /* auth banner */
  const auth = a.aliexpress_auth || {};
  if (["expired", "expiring", "missing"].includes(auth.status)) {
    const critical = auth.status !== "expiring";
    root.append(el("div", { class: `warnbar${critical ? " bad" : ""}` },
      el("span", {},
        el("b", {}, critical
          ? `⛔ AliExpress tokens ${auth.status}`
          : `⚠ AliExpress refresh token expires ${fmtIn(auth.refresh_expires_at)}`),
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
  const kpis = el("div", { class: "kpis" },
    kpi("Products", fmtNum(total), "in the funnel"),
    kpi("Winners", el("span", { class: "v ok" }, fmtNum(winners)), "margin calculated"),
    kpi("Batch jobs", fmtNum((a.batch_jobs || []).length), "at Google"),
    kpi("Backlog", fmtNum(backlog), a.work_eta_seconds > 0
      ? `paced ~${fmtDur(a.work_eta_seconds)} (excl. Gemini batches)`
      : "docs awaiting a stage"));
  root.append(kpis);

  root.append(runControlPanel(a));
  const ap = autonomyPanel(a);
  if (ap) root.append(ap);
  root.append(lanesGrid(a));

  /* backlog + batches | keywords + sweep + webhooks */
  root.append(el("div", {
    style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;align-items:start",
  },
    el("div", { style: "display:flex;flex-direction:column;gap:14px" },
      backlogPanel(a), batchPanel(a)),
    el("div", { style: "display:flex;flex-direction:column;gap:14px" },
      keywordsPanel(a), sweepPanelEl(a.sweep), webhooksPanel(a.takealot_events))));

  root.append(el("div", {
    style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;align-items:start",
  }, statusCountsPanel(counts, total), errorsPanel(a.errors)));
}

/* Connection honesty row: the publish heartbeat is the pipeline's pulse —
   a live run pushes every ~10s and an idle serve at least hourly, so the
   thresholds differ by funnel state. wsChip/S.net come from app.js. */
function connectionChips(a) {
  const running = a.funnel_state === "running";
  const age = agoMinutes(a.generated_at);
  const pubTone = running
    ? (age <= 5 ? "ok" : "bad")
    : (age <= STALE_PUBLISH_MIN ? "ok" : "bad");
  const pubNote = running && pubTone === "bad"
    ? " — run active but publishing is stuck" : "";
  return el("div", { class: "connchips" },
    pill(pubTone, dotEl(pubTone, true),
      " publish heartbeat · ", agoSpan(a.generated_at), pubNote),
    wsChip(),
    S.net.failing
      ? pill("bad", dotEl("bad", true), " data fetch FAILING — showing old data")
      : pill("ok", dotEl("ok", true), " data fetch OK · ",
          S.net.lastOkAt ? agoSpan(S.net.lastOkAt) : el("span", {}, "—")));
}

function runControlPanel(a) {
  const status = statusLine();
  const running = a.funnel_state === "running";
  const budget = a.budget || {};
  const ack = a.commands_ack || {};

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

  const p = panelEl("Run control", {});
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
    el("button", {
      class: "b danger",
      onclick: () => busAct("stop run", (doc) => {
        (doc.run ??= {}).desired = "stopped";
      }, status, "Stop sent — in-flight Gemini batches survive and are collected next run."),
    }, "■ Stop run"),
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
    }, "▶ Start run"),
    el("div", { class: "vsep" }),
    stageSelect,
    el("button", {
      class: "b line",
      onclick: () => busAct(`run stage ${stageSelect.value}`, (doc) => {
        doc.run = { ...(doc.run || {}), stages: [stageSelect.value],
                    stages_requested_at: new Date().toISOString() };
      }, status),
    }, "Run stage")));
  p.append(el("div", { class: "hint", style: "margin-top:8px" },
    "one-off stages run between publish ticks without a full funnel run " +
    "('serve' must be up) · in-flight Gemini batches survive a stop and are " +
    "collected next run · " +
    (ack.applied_at
      ? `last ack ${fmtAgo(ack.applied_at)} (run: ${ack.run ?? "—"})`
      : "no ack yet — is a run (or 'serve') active?")),
    status);
  return p;
}

/* ---------- the autonomy dial (Phase 5) ---------- */

const AUTONOMY_SUBS = [
  ["reorder", "Reorder", (c) =>
    `up to ${c.max_per_pass ?? 5} proposals every ${c.pass_hours ?? 6}h · ` +
    "proven sellers, cheap freight · AUTO self-approves into the normal " +
    "verify → affordability → place path (payment stays yours)"],
  ["repricer", "Repricer", (c) =>
    `pass every ${Math.round((c.pass_seconds ?? 1800) / 60)}min · ` +
    "floor-guarded, capped daily · PROPOSE refreshes decisions without " +
    "moving prices; AUTO moves them"],
  ["twins", "Takealot twins", () =>
    "each Amazon order proposes its Takealot twin · AUTO queues twins " +
    "itself (barcode/loadsheet machinery unchanged)"],
  ["wide_listings", "Wide listings", (c) =>
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
    soft: "— off = still · propose = cards wait for you · auto = " +
          "self-approving (hard gates always bind)",
  });
  for (const [key, label, describe] of AUTONOMY_SUBS) {
    const cfg = auto[key] || {};
    // A press still riding the bus wins the display (switch contract).
    const press = ((S.commands || {}).autonomy || {})[key] || null;
    const pending = press && press.requested_at
      && press.requested_at !== cfg.requested_at ? press : null;
    const mode = pending ? pending.mode : (cfg.mode || "off");
    const seg = el("span", { class: "chiprow", style: "display:inline-flex;gap:0" });
    for (const m of ["off", "propose", "auto"]) {
      seg.append(el("button", {
        class: `b xs ${m === mode ? (m === "auto" ? "danger" : "pri") : "line"}`,
        ...(pending || m === mode ? { disabled: "" } : {}),
        onclick: () => {
          const ask = (AUTONOMY_CONFIRM[m] || {})[key];
          if (ask && !confirm(ask)) return;
          busAct(`autonomy ${key} → ${m}`, (doc) => {
            doc.autonomy = { ...(doc.autonomy || {}),
              [key]: { mode: m, requested_at: new Date().toISOString() } };
          }, status);
          seg.replaceWith(el("span", { class: "st warn" }, "🕐 applying"));
        },
      }, m));
    }
    p.append(el("div", { class: "switchrow", style: "align-items:flex-start" },
      el("span", {},
        el("div", { style: "font-weight:650" }, label,
          pending ? el("span", { class: "st warn", style: "margin-left:8px" },
            "🕐 applying") : null,
          key === "wide_listings" && cfg.paused_reason
            ? el("span", { class: "st hot", style: "margin-left:8px" },
                `⏸ ${cfg.paused_reason}`) : null),
        el("div", { class: "hint", style: "max-width:520px" }, describe(cfg))),
      seg));
  }
  p.append(el("div", { class: "hint", style: "margin-top:6px" },
    "proposals land on Today's propose queue and the desks · AUTO only " +
    "skips the Approve press — affordability, floors, caps, exemptions " +
    "and the kill rule gate exactly as before"), status);
  return p;
}

const LANE_TONE = { running: "ok", idle: "mute", done: "ok", paused: "warn",
                    error: "hot", failed: "bad", stopped: "mute", starting: "mute" };
const LANE_ICON = { running: "▶", idle: "…", done: "✓", paused: "⏸",
                    error: "!", failed: "✗", stopped: "■", starting: "○" };

function lanesGrid(a) {
  const lanes = a.lanes || {};
  const status = statusLine();
  const wrap = el("div", {});
  const grid = el("div", {
    style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px",
  });
  const names = Object.keys(lanes).length ? Object.keys(lanes) : MACHINE_LANES;
  for (const name of names) {
    const lane = lanes[name] || {};
    const tone = LANE_TONE[lane.state] || "mute";
    grid.append(el("div", { class: "panel", style: "padding:12px 14px" },
      el("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:8px" },
        el("span", { style: "font-size:13.5px;font-weight:650" }, name),
        el("span", { style: "display:flex;gap:6px" },
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
          }, "Resume"))),
      el("div", { style: "display:flex;align-items:center;gap:6px;margin-top:4px" },
        dotEl(tone, true),
        el("span", { class: `st ${tone}` },
          `${LANE_ICON[lane.state] || "·"} ${lane.state || "no data"}` +
          (lane.pending ? " · work pending" : ""))),
      el("div", { class: "hint", style: "margin-top:4px" },
        lane.cycles != null
          ? `${fmtNum(lane.cycles)} cycles · last activity ${fmtAgo(lane.last_activity)}`
          : "appears while a run is live"),
      lane.last_error
        ? el("div", { style: "font-size:11.5px;color:var(--bad);margin-top:4px;overflow-wrap:anywhere" },
            `last error: ${lane.last_error.message} (${fmtAgo(lane.last_error.at)})`)
        : null));
  }
  wrap.append(grid, status);
  return wrap;
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
    p.append(emptyLine("no backlog — every stage is drained"));
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
  const p = panelEl("Gemini batch jobs", {});
  if (!jobs.length) {
    p.append(emptyLine("none in flight"));
  } else {
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
  }
  p.append(el("div", { class: "hint", style: "margin-top:6px" },
    "batch = 50% cheaper, results within minutes–24h · 'collect' ingests finished jobs"));
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
    el("tr", {}, el("th", {}, ""), el("th", {}, "Keyword"), el("th", {}, "Score"),
      el("th", {}, "Found"), el("th", {}, "Margined")));
  const row = (marker, e) => el("tr", {},
    el("td", { class: "t" }, marker),
    el("td", { class: "t" }, e.keyword),
    el("td", {}, e.score ?? "—"),
    el("td", {}, fmtNum(e.products_found)),
    el("td", {}, fmtNum(e.margin_success)));
  for (const e of kw.top || []) table.append(row("⭐", e));
  for (const e of kw.bottom || []) table.append(row("💤", e));
  if ((kw.top || []).length + (kw.bottom || []).length === 0) {
    p.append(emptyLine("no scored keywords yet"));
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
  const p = panelEl("Snapshot sweep", {});
  if (!sweep) { p.append(emptyLine("no sweep has run yet")); return p; }

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
    el("div", { style: "font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase" }, label),
    el("div", { style: "font-size:16px;font-weight:650;margin-top:2px" }, value),
    sub ? el("div", { class: "hint" }, sub) : null);
  grid.append(
    cell("Last swept", sweep.last_completed_at ? fmtAgo(sweep.last_completed_at) : "never",
      sweep.asins ? `${fmtNum(sweep.asins)} ASINs` : null),
    cell("Next due", sweep.running ? "running" : fmtIn(sweep.next_due_at),
      "daily task · post-run sweeps fire earlier"),
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
    soft: ev ? `— ${fmtNum(ev.total)} total · edge receiver → 15-min drain` : null,
  });
  if (!ev || !(ev.recent || []).length) {
    p.append(emptyLine("no webhook deliveries yet — the pipe wakes with the " +
      "first live offer event"));
    return p;
  }
  const table = el("table", { class: "grid" },
    el("tr", {}, el("th", {}, "Event"), el("th", {}, "Verified"),
      el("th", {}, "Received"), el("th", {}, "Drained")));
  for (const e of ev.recent) {
    table.append(el("tr", {},
      el("td", { class: "t", title: e.delivery }, e.event || "?"),
      el("td", { class: "t" }, e.verified
        ? el("span", { class: "st ok" }, "✓ signed")
        : el("span", { class: "st warn" }, "⚠ unsigned")),
      el("td", { class: "t", style: "color:var(--muted);font-size:12px" }, fmtAgo(e.received_at)),
      el("td", { class: "t", style: "color:var(--muted);font-size:12px" }, fmtAgo(e.drained_at))));
  }
  p.append(el("div", { class: "scroll-x" }, table));
  return p;
}

function statusCountsPanel(counts, total) {
  const p = panelEl("Products per status", { soft: `— ${fmtNum(total)} total` });
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
  const p = panelEl("Recent lane errors", {});
  if (!(errors || []).length) {
    p.append(emptyLine("no recent errors"));
    return p;
  }
  const table = el("table", { class: "grid" },
    el("tr", {}, el("th", {}, "Lane"), el("th", {}, "When"), el("th", {}, "Error")));
  for (const err of errors) {
    table.append(el("tr", {},
      el("td", { class: "t" }, err.lane),
      el("td", { class: "t", style: "color:var(--muted);font-size:12px" }, fmtAgo(err.at)),
      el("td", { class: "t", style: "color:var(--ink2);font-size:12px;overflow-wrap:anywhere" }, err.message)));
  }
  p.append(el("div", { class: "scroll-x" }, table),
    el("div", { class: "hint", style: "margin-top:6px" },
      "API-spending stages keep the one-attempt-per-doc-per-run rule — " +
      "errors park the doc, never loop it"));
  return p;
}
