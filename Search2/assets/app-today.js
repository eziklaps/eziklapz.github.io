/* Today desk — the morning triage: KPIs, the Needs-you queue, a machine
   mini-panel, data freshness, the kill switches and the top of the Buy
   desk. Everything renders from the three payloads already in S. */

function renderTodayDesk(root) {
  const a = S.admin || {};
  const products = (S.buyer || {}).products || [];
  const counts = a.status_counts || {};
  const scanned = Object.values(counts).reduce((x, y) => x + y, 0);
  const orders = a.orders || {};
  const oc = orders.counts || {};
  const inFlight = (oc.pending || 0) + (oc.verified || 0)
    + (oc.placing || 0) + (oc.placed || 0);
  const out = orders.outstanding || {};
  const acc = a.accounting || {};
  const pnl = acc.pnl || [];
  const month = pnl[pnl.length - 1] || {};
  const supplies = acc.supplies_12mo || {};
  const vatPct = Math.round((supplies.fraction || 0) * 100);
  const lanes = a.lanes || {};
  const busy = Object.values(lanes).filter((l) => l.state === "running").length;

  const now = new Date();
  root.append(deskHead("Today",
    `${now.toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" })}` +
    (a.run_id ? ` · run ${a.run_id}` : "") +
    (Object.keys(lanes).length ? ` · ${busy} of ${Object.keys(lanes).length} lanes busy` : "") +
    ` · funnel ${a.funnel_state || "?"}`));

  /* ----- KPI strip ----- */
  root.append(el("div", { class: "kpis" },
    kpi("Winners", fmtNum(products.length),
      `${fmtNum(scanned)} scanned`),
    kpi("Orders in flight", fmtNum(inFlight),
      ["placed", "placing", "verified", "pending"]
        .filter((s) => oc[s]).map((s) => `${oc[s]} ${s}`).join(" · ") || "none"),
    kpi("Awaiting payment", out.count ? fmtR(out.total_rand) : "R 0",
      el("span", {}, `${out.count || 0} order${out.count === 1 ? "" : "s"} · `,
        el("a", {
          href: "https://www.aliexpress.com/p/order/index.html",
          target: "_blank", rel: "noopener",
        }, "pay on AliExpress ↗"))),
    kpi(`Net · ${month.month || "this month"}`,
      el("span", { class: month.net >= 0 ? "v ok" : "v hot" }, fmtR(month.net ?? 0)),
      month.estimate_rand ? `${fmtR(month.estimate_rand)} rests on estimates` : "actuals only"),
    el("div", { class: "kpi" },
      el("div", { class: "l" }, "VAT threshold"),
      el("div", { class: "v" }, `${vatPct}%`),
      el("div", { class: "gauge", style: "margin-top:7px" },
        el("span", { style: `width:${Math.min(100, vatPct)}%` }))),
  ));

  /* ----- needs you + right column ----- */
  const items = needsYouItems();
  const needsPanel = panelEl("Needs you", {
    right: `${items.length} item${items.length === 1 ? "" : "s"} · sorted by deadline`,
  });
  if (!items.length) {
    needsPanel.append(emptyLine("Nothing needs you — the machine is doing the rest."));
  }
  for (const it of items) {
    needsPanel.append(el("div", { class: "needrow" },
      dotEl(it.tone),
      el("div", {},
        el("div", { class: "nt" }, it.title),
        el("div", { class: "ns" }, it.sub || "")),
      el("div", { class: "due" },
        el("div", { class: "d1", style: it.dueIso
          ? `color:var(--${dueTone(it.dueIso) === "bad" ? "bad" : dueTone(it.dueIso) === "warn" ? "warn-text" : "ink"})` : "color:var(--muted)" },
          it.dueIso ? fmtIn(it.dueIso) : (it.dueLabel && !it.dueIso ? "—" : "—")),
        el("div", { class: "d2" },
          it.dueIso ? fmtDate(it.dueIso) : (it.dueLabel || ""))),
      el("div", { class: "act" }, it.action || el("span", {})),
    ));
  }

  root.append(el("div", { class: "todaygrid" },
    needsPanel,
    el("div", { style: "display:flex;flex-direction:column;gap:16px" },
      machineMini(a),
      freshDataPanel(a),
      killSwitchPanel()),
  ));

  /* ----- best on the Buy desk ----- */
  const top = products.slice(0, 3);
  const best = panelEl("Best on the Buy desk", {
    right: el("a", { onclick: () => setDesk("buy"), style: "cursor:pointer" },
      `all ${products.length} winners →`),
  });
  if (!top.length) {
    best.append(emptyLine("No winners yet — the pipeline is still hunting."));
  } else {
    const table = el("table", { class: "grid" },
      el("tr", {},
        el("th", {}, ""), el("th", {}, "Product"), el("th", {}, "Score"),
        el("th", {}, "Margin"), el("th", {}, "Demand"),
        el("th", {}, "Price / Ali"), el("th", {}, "Selling"), el("th", {}, "")));
    for (const p of top) {
      table.append(el("tr", {},
        el("td", {}, thumbEl(p, true)),
        el("td", { class: "t" },
          el("div", { class: "rowtitle" }, p.title),
          el("div", { class: "rowsub" }, buySubline(p))),
        el("td", {}, scoreTag(p)),
        el("td", {}, marginCell(p)),
        el("td", { class: "t" }, demandCell(p)),
        el("td", {}, priceCell(p)),
        el("td", { class: "t" }, sellingChip(p) || "—"),
        el("td", { class: "r" }, buyRowAction(p))));
    }
    best.append(el("div", { class: "scroll-x" }, table));
  }
  root.append(best);
}

function kpi(label, value, sub) {
  return el("div", { class: "kpi" },
    el("div", { class: "l" }, label),
    el("div", { class: "v" }, value),
    sub ? el("div", { class: "s" }, sub) : null);
}

/* Machine mini-panel: lane dots + the top of the backlog. */
function machineMini(a) {
  const p = panelEl("Machine", {
    right: el("a", { onclick: () => setDesk("machine"), style: "cursor:pointer" }, "open →"),
  });
  const lanes = a.lanes || {};
  if (Object.keys(lanes).length) {
    const grid = el("div", { class: "mini" });
    for (const [name, lane] of Object.entries(lanes)) {
      const tone = { running: "ok", done: "ok", paused: "warn",
                     error: "hot", failed: "bad" }[lane.state] || "mute";
      grid.append(el("div", { class: "mrow" },
        dotEl(tone, true), name,
        el("span", { class: "mr" },
          lane.cycles != null ? `${fmtNum(lane.cycles)}c` : lane.state)));
    }
    p.append(grid);
  } else {
    p.append(emptyLine("no live run — lane states appear while one is active"));
  }
  const depths = Object.entries(a.feed_depths || {})
    .sort((x, y) => y[1] - x[1]);
  if (depths.length) {
    const total = depths.reduce((s, [, n]) => s + n, 0);
    const max = depths[0][1];
    const bars = el("div", { class: "bars sm", style: "margin-top:10px;padding-top:10px;border-top:1px solid var(--line-soft)" },
      el("div", { class: "kvrow" },
        el("span", { class: "k" }, `Backlog · ${fmtNum(total)} docs`),
        el("span", { class: "v" }, a.work_eta_seconds > 0
          ? `paced ~${fmtDur(a.work_eta_seconds)}` : "")));
    for (const [stage, count] of depths.slice(0, 4)) {
      bars.append(el("div", { class: "brow" },
        el("span", {}, stage),
        el("div", { class: "track" },
          el("div", { class: "fill", style: `width:${Math.max(4, (count / max) * 100)}%` })),
        el("span", { class: "n" }, fmtNum(count))));
    }
    p.append(bars);
  }
  return p;
}

function freshDataPanel(a) {
  const p = panelEl("Fresh data", {});
  const sweep = a.sweep || {};
  p.append(el("div", { class: "kvrow" },
    el("span", { class: "k" }, "Snapshot sweep"),
    el("span", { class: "v" }, sweep.last_completed_at
      ? el("span", {}, agoSpan(sweep.last_completed_at),
          sweep.asins ? ` · ${fmtNum(sweep.asins)} ASINs` : "")
      : "never")));
  p.append(el("div", { class: "kvrow" },
    el("span", { class: "k" }, "Next sweep"),
    el("span", { class: "v" }, sweep.running ? "running now" : fmtIn(sweep.next_due_at))));
  const ev = a.takealot_events || {};
  p.append(el("div", { class: "kvrow" },
    el("span", { class: "k" }, "Takealot webhooks"),
    el("span", { class: "v" }, `${fmtNum(ev.total || 0)} total` +
      ((ev.recent || []).length && ev.recent.every((e) => e.verified) ? " · verified" : ""))));
  const ah = a.account_health || {};
  const claims = (ah.claims || {}).count;
  const fine = ah.ahr_status &&
    ["GREAT", "GOOD", "NORMAL", "HEALTHY"].includes(String(ah.ahr_status).toUpperCase());
  p.append(el("div", { class: "kvrow" },
    el("span", { class: "k" }, "Account health"),
    el("span", { class: `v st ${fine ? "ok" : ah.ahr_status ? "bad" : "mute"}` },
      ah.ahr_status
        ? `AHR ${ah.ahr_status}${claims != null ? ` · ${claims} claims open` : ""}`
        : "no report yet")));
  const bm = a.buyer_messages || {};
  if (bm.configured === false) {
    p.append(el("div", { class: "kvrow" },
      el("span", { class: "k" }, "Mailbox watch"),
      el("span", { class: "v st warn" }, "OFF — needs the Gmail app password")));
  }
  return p;
}

function killSwitchPanel() {
  const p = panelEl("Kill switches", {});
  const status = statusLine();
  for (const s of switchStates()) {
    const label = { ordering: "Ordering", listing: "Amazon listings",
                    takealot: "Takealot offers" }[s.key];
    p.append(el("div", { class: "switchrow" },
      el("span", {}, label),
      el("span", { style: "display:flex;gap:8px;align-items:center" },
        el("span", {
          class: `st ${s.armed ? "warn" : "mute"}`, title: s.title,
        }, s.armed ? "ARMED" : "SAFE"),
        s.remote
          ? el("button", {
              class: "b xs danger",
              onclick: () => busAct(`KILL ${label}`, (doc) => {
                doc[s.key] = { ...(doc[s.key] || {}), enabled: false };
              }, status, `Kill switch tripped — ${label} stops within ~30s.`),
            }, "Kill")
          : el("button", {
              class: "b xs line",
              onclick: () => busAct(`re-enable ${label}`, (doc) => {
                doc[s.key] = { ...(doc[s.key] || {}), enabled: true };
              }, status,
              `${label} enabled remotely — still needs the .env switch on the pipeline machine.`),
            }, "Arm"))));
  }
  p.append(el("div", { class: "hint", style: "margin-top:6px" },
    "Remote half only — the .env master switch on the pipeline machine must " +
    "also be on. Killing is always instant."),
    status);
  return p;
}
