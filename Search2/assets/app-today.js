/* Today desk — the morning check. Four figures that move money, the
   Needs-you queue (one row per parcel / claim / gate), what the machine
   proposes, the machine's pulse, the kill switches and the top of the
   Buy desk. Everything renders from the three payloads already in S. */

function renderTodayDesk(root) {
  const a = S.admin || {};
  const products = (S.buyer || {}).products || [];
  const orders = a.orders || {};
  const oc = orders.counts || {};
  const inFlight = (oc.pending || 0) + (oc.verified || 0)
    + (oc.placing || 0) + (oc.placed || 0);
  const out = orders.outstanding || {};
  const acc = a.accounting || {};
  const pnl = acc.pnl || [];
  const month = pnl[pnl.length - 1] || {};
  const gate = (a.banking || {}).gate || {};
  const lanes = a.lanes || {};
  const busy = Object.values(lanes).filter((l) => l.state === "running").length;
  const running = a.funnel_state === "running";
  const now = new Date();

  root.append(deskHead("Today", [
    { text: now.toLocaleDateString("en-ZA",
        { weekday: "long", day: "numeric", month: "long" }), plain: true },
    running
      ? { text: `run active · ${busy}/${Object.keys(lanes).length} lanes busy`,
          tone: "ok", title: a.run_id ? `run ${a.run_id}` : "" }
      : { text: `no run · ${a.funnel_state || "idle"}`,
          title: a.run_id ? `last run ${a.run_id}` : "" },
    { text: "published", ago: a.generated_at,
      tone: agoMinutes(a.generated_at) <= 20 ? "ok" : "warn" },
  ]));

  /* ----- the four figures ----- */
  const stock = typeof stockModel === "function" ? stockModel() : null;
  const sellable = stock ? stock.rows.filter((r) => r.live)
    .reduce((s, r) => s + Math.max(r.available, 0), 0) : null;
  const onHand = stock ? stock.rows.reduce((s, r) => s + r.onHand, 0) : null;
  const road = stock ? stock.transit.reduce((s, r) => s + r.remaining, 0) : 0;
  const gateTone = { green: "ok", amber: "warn", red: "bad" }[gate.status] || "mute";
  const inFlightBits = ["placed", "placing", "verified", "pending"]
    .filter((s) => oc[s]).map((s) => `${oc[s]} ${s}`).join(" · ");

  root.append(el("div", { class: "kpis" },
    kpi("Cash", gate.cash_zar != null ? fmtR(gate.cash_zar) : "—",
      gate.status
        ? el("span", {},
            el("span", { class: `st ${gateTone}`, title: (gate.watch || []).concat(gate.reasons || []).join(" · ") },
              `gate ${gate.status}`),
            (gate.verified_age_days ?? gate.age_days) != null
              ? ((gate.verified_age_days ?? gate.age_days) === 0
                  ? " · bank seen today"
                  : ` · bank seen ${gate.verified_age_days ?? gate.age_days}d ago`) : "")
        : el("a", { onclick: () => setDesk("books") }, "no balance evidence yet →")),
    kpi(`Net · ${month.month || "this month"}`,
      el("span", { class: (month.net ?? 0) >= 0 ? "v ok" : "v hot" }, fmtR(month.net ?? 0)),
      `${fmtR((month.revenue || {}).total || 0)} sales`
        + (month.estimate_rand ? ` · ${fmtR(month.estimate_rand)} estimated` : "")),
    kpi("Orders in flight", fmtNum(inFlight),
      out.count
        ? el("span", {}, `${fmtR(out.total_rand)} unpaid · `,
            el("a", { href: ALI_ORDERS_URL, target: "_blank", rel: "noopener" },
              "pay on AliExpress ↗"))
        : (inFlightBits || "nothing placed")),
    kpi("Sellable stock",
      sellable != null
        ? el("span", {}, fmtNum(sellable),
            el("span", { class: "unit" }, `of ${fmtNum(onHand)} on hand`))
        : "—",
      road ? `${fmtNum(road)} units on the road` : "nothing inbound"),
  ));

  /* ----- needs you + right column ----- */
  const items = needsYouItems();
  const needsPanel = panelEl("Needs you", {
    right: items.length
      ? `${items.length} item${items.length === 1 ? "" : "s"} · earliest deadline first`
      : "",
  });
  if (!items.length) {
    needsPanel.append(emptyLine("Nothing needs you — the machine is doing the rest."));
  }
  for (const it of items) {
    const tone = dueTone(it.dueIso);
    needsPanel.append(el("div", { class: "needrow" },
      dotEl(it.tone),
      el("div", {},
        el("div", { class: "nt" }, it.title),
        el("div", { class: "ns" }, it.sub || "")),
      el("div", { class: "due" },
        el("div", { class: "d1", style: it.dueIso
          ? `color:var(--${tone === "bad" ? "bad" : tone === "warn" ? "warn-text" : "ink"})`
          : "color:var(--muted)" },
          it.dueIso ? fmtIn(it.dueIso) : "—"),
        el("div", { class: "d2" },
          it.dueIso ? fmtDate(it.dueIso) : (it.dueLabel || ""))),
      el("div", { class: "act" }, it.action || el("span", {})),
    ));
  }

  root.append(el("div", { class: "todaygrid" },
    needsPanel,
    el("div", { style: "display:flex;flex-direction:column;gap:16px" },
      recentCommandsPanel(a),
      machineMini(a),
      killSwitchPanel()),
  ));

  /* ----- the propose queue (Phase 5) ----- */
  const proposals = proposalQueueItems();
  if (proposals.length) {
    const pq = panelEl("The machine proposes", {
      right: el("span", {
        title: "nothing here spends or lists without your press, unless the " +
               "matching dial on Machine is set to AUTO",
      }, `${proposals.length} proposal${proposals.length === 1 ? "" : "s"} · your press decides`),
    });
    const table = el("table", { class: "grid" },
      el("tr", {},
        el("th", {}, "Kind"), el("th", {}, "Product"),
        el("th", {}, "Terms"), el("th", {}, ""), el("th", {}, "")));
    for (const pr of proposals) {
      table.append(el("tr", {},
        el("td", { class: "t" }, el("span", { class: "tag" }, pr.kind)),
        el("td", { class: "t" },
          el("div", { class: "rowtitle" }, pr.title),
          el("div", { class: "rowsub" }, pr.sub || "")),
        el("td", { style: "white-space:nowrap" }, pr.figure || "—"),
        el("td", { class: "r" }, pr.action()),
        el("td", { class: "r" }, el("button", {
          class: "b xs line", onclick: pr.open,
        }, "Open on desk"))));
    }
    pq.append(el("div", { class: "scroll-x" }, table));
    root.append(pq);
  }

  /* ----- best on the Buy desk ----- */
  const top = products.slice(0, 3);
  const best = panelEl("Best on the Buy desk", {
    right: el("a", { onclick: () => setDesk("buy") },
      `all ${fmtNum(products.length)} winners →`),
  });
  if (!top.length) {
    best.append(emptyLine("No winners yet — the pipeline is still hunting."));
  } else {
    const table = el("table", { class: "grid" },
      el("tr", {},
        el("th", {}, ""), el("th", {}, "Product"), el("th", {}, "Score"),
        el("th", {}, "Margin"), el("th", {}, "Demand"), el("th", {}, "")));
    for (const p of top) {
      table.append(el("tr", {},
        el("td", {}, thumbEl(p, true)),
        el("td", { class: "t" },
          el("div", { class: "rowtitle" }, cleanTitle(p)),
          el("div", { class: "rowsub" }, buySubline(p))),
        el("td", {}, scoreTag(p)),
        el("td", {}, marginCell(p)),
        el("td", { class: "t" }, demandCell(p)),
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

/* Recent commands: every dashboard click, from "on the bus" to "applied"
   (or FAILED) — the answer to the app going quiet after "sent". Waiting
   entries come from the bus doc (token-gated read); applied/failed rows are
   the pipeline's own journal riding the admin payload. */
function recentCommandsPanel(a) {
  const journal = a.activity || [];
  const stamps = journalStamps();
  const genAt = a.generated_at ? new Date(a.generated_at).getTime() : 0;
  // Journal stamp missing + a payload built well after the entry hit the
  // bus = the sinks saw it and changed nothing (usually a replayed click).
  const pending = pendingBusEntries().filter((e) => !stamps.has(e.stamp))
    .map((e) => ({
      ...e,
      seen: genAt > new Date(e.stamp).getTime() + 45e3,
    }));
  const waiting = pending.filter((e) => !e.seen);

  const p = panelEl("Recent commands", {
    right: waiting.length
      ? el("span", { class: "st warn" }, `${waiting.length} waiting`)
      : el("span", { class: "st ok" }, "all applied"),
  });

  const rows = [
    ...pending.map((e) => ({
      tone: e.seen ? "mute" : "warn",
      text: e.label + (e.seen ? " — no change recorded" : ""),
      at: e.stamp, kind: e.kind,
      title: e.seen
        ? "the pipeline read the bus after this entry but journalled no change — " +
          "usually a replayed click or an entry from before the journal existed"
        : "committed to the bus — the pipeline applies commands within ~30s " +
          "while a run or serve is active",
    })),
    ...journal.map((r) => ({
      tone: r.ok ? "ok" : "bad",
      text: tidyMessage(r.message), at: r.at, kind: r.kind, title: "",
    })),
  ];

  if (!rows.length) {
    p.append(emptyLine(S.commands
      ? "No commands yet — actions you take land here with their outcome."
      : "Applied commands land here — take any action to see the waiting queue too."));
    return p;
  }
  const CAP = 6;
  for (const r of rows.slice(0, CAP)) {
    p.append(el("div", { class: "cmdrow", title: r.title },
      dotEl(r.tone, true),
      el("div", { class: "ns",
                  style: r.tone === "bad" ? "color:var(--bad)" : "" },
        r.text),
      el("div", { class: "when" },
        el("span", { class: "k" }, r.kind),
        agoSpan(r.at))));
  }
  if (rows.length > CAP) {
    p.append(el("div", { class: "hint", style: "padding:6px 0 0" },
      `${rows.length - CAP} more in the 30-day journal`));
  }
  return p;
}

/* Machine mini-panel: lane dots, the top of the backlog, the sweep and
   the account's health — the pulse, not the controls. */
function machineMini(a) {
  const p = panelEl("Machine", {
    right: el("a", { onclick: () => setDesk("machine") }, "open →"),
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
          lane.state === "running" && lane.cycles != null
            ? `${fmtNum(lane.cycles)}c` : lane.state)));
    }
    p.append(grid);
  }
  const depths = Object.entries(a.feed_depths || {})
    .sort((x, y) => y[1] - x[1]);
  const total = depths.reduce((s, [, n]) => s + n, 0);
  const rows = el("div", {
    style: Object.keys(lanes).length
      ? "margin-top:10px;padding-top:8px;border-top:1px solid var(--line-soft)" : "",
  });
  rows.append(el("div", { class: "kvrow" },
    el("span", { class: "k" }, "Backlog"),
    el("span", { class: "v" }, total
      ? `${fmtNum(total)} docs` + (a.work_eta_seconds > 0 ? ` · ~${fmtDur(a.work_eta_seconds)}` : "")
      : "drained")));
  if (depths.length) {
    const max = depths[0][1];
    const bars = el("div", { class: "bars sm" });
    for (const [stage, count] of depths.slice(0, 3)) {
      bars.append(el("div", { class: "brow" },
        el("span", {}, stage),
        el("div", { class: "track" },
          el("div", { class: "fill", style: `width:${Math.max(4, (count / max) * 100)}%` })),
        el("span", { class: "n" }, fmtNum(count))));
    }
    rows.append(bars);
  }
  const sweep = a.sweep || {};
  rows.append(el("div", { class: "kvrow" },
    el("span", { class: "k" }, "Snapshot sweep"),
    el("span", { class: "v" }, sweep.running
      ? el("span", { class: "st warn" }, "running now")
      : sweep.last_completed_at
        ? el("span", {}, agoSpan(sweep.last_completed_at), ` · next ${fmtIn(sweep.next_due_at)}`)
        : "never")));
  const ah = a.account_health || {};
  const claims = (ah.claims || {}).count;
  const fine = ah.ahr_status &&
    ["GREAT", "GOOD", "NORMAL", "HEALTHY"].includes(String(ah.ahr_status).toUpperCase());
  rows.append(el("div", { class: "kvrow" },
    el("span", { class: "k" }, "Amazon account health"),
    el("span", { class: `v st ${fine ? "ok" : ah.ahr_status ? "bad" : "mute"}` },
      ah.ahr_status
        ? `${ah.ahr_status}${claims ? ` · ${claims} claim${claims === 1 ? "" : "s"} open` : ""}`
        : "no report yet")));
  const bm = a.buyer_messages || {};
  if (bm.configured === false) {
    rows.append(el("div", { class: "kvrow" },
      el("span", { class: "k" }, "Mailbox watch"),
      el("span", { class: "v st warn" }, "off — needs the Gmail app password")));
  }
  p.append(rows);
  return p;
}

function killSwitchPanel() {
  const p = panelEl("Kill switches", {
    right: el("span", {
      title: "remote half only — the .env master switch on the pipeline " +
             "machine must also be on; killing is always instant",
    }, "instant"),
  });
  const status = statusLine();
  for (const s of switchStates()) {
    // SELL is one row for two bus keys (Amazon listings + Takealot offers)
    // — killing or arming it flips both in a single commit.
    const label = s.label === "ORDERS"
      ? "Ordering" : "Selling (Amazon + Takealot)";
    const setAll = (doc, enabled) => {
      for (const key of s.keys) doc[key] = { ...(doc[key] || {}), enabled };
    };
    p.append(el("div", { class: "switchrow" },
      el("span", {}, label),
      el("span", { style: "display:flex;gap:8px;align-items:center" },
        el("span", {
          class: `st ${s.armed ? "warn" : "mute"}`, title: s.title,
        }, s.armed ? "ARMED" : "SAFE"),
        s.remote
          ? el("button", {
              class: "b xs danger",
              onclick: () => busAct(`KILL ${label}`,
                (doc) => setAll(doc, false),
                status, `Kill switch tripped — ${label} stops within ~30s.`),
            }, "Kill")
          : el("button", {
              class: "b xs line",
              onclick: () => busAct(`re-enable ${label}`,
                (doc) => setAll(doc, true),
                status,
                `${label} enabled remotely — still needs the .env switch on the pipeline machine.`),
            }, "Arm"))));
  }
  p.append(status);
  return p;
}
