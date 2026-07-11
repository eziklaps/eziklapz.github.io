/* Books desk — money: cash-position cards + the affordability gate +
   the reconciliation workbench (bank statements ↔ ledger), monthly P&L
   off the transactions ledger, the VAT threshold gauge, IRP6, the newest
   ledger rows, and the documents flow (upload → drain → Gemini-extract →
   you post; nothing posts unreviewed). Bookmarked for a later build:
   FX/fee-anomaly watch, evidence coverage, SARS export pack,
   order-to-cash strip. */

function renderBooksDesk(root) {
  const a = S.admin || {};
  const acc = a.accounting || {};
  const bank = a.banking || {};
  const orders = a.orders || {};
  const pnl = acc.pnl || [];
  const month = pnl[pnl.length - 1] || {};

  root.append(deskHead("Books",
    "cash → ledger → views · append-only ledger, corrections are reversing " +
    "entries · actions ride the command queue · updated " + fmtAgo(a.generated_at)));

  if ((acc.finances || {}).role_denied_at) {
    root.append(el("div", { class: "warnbar bad" },
      "Amazon Finances denied — grant the SP-API app the 'Finance and " +
      "Accounting' role in Seller Central; settlement actuals are missing until then."));
  }
  if (((bank.gate || {}).status) === "red") {
    root.append(el("div", { class: "warnbar bad" },
      "Affordability gate RED — order placements are held: " +
      ((bank.gate || {}).reasons || []).join(" · ")));
  }

  /* Xero feed pulse: auth failure / errors / staleness. Ages are
     computed here at render time — the payload carries timestamps only.
     Freshness is RECONCILIATION freshness: the balance's as_of is the
     newest coded line, so a lazy week in Xero ages toward gate RED. */
  const feed = bank.feed || {};
  const feedAgeDays = feed.synced_at
    ? (Date.now() - new Date(feed.synced_at).getTime()) / 86400e3 : null;
  if (feed.auth_failed_at) {
    root.append(el("div", { class: "warnbar bad" },
      "Xero feed auth FAILED — the rotated refresh token was likely " +
      "lost; re-run accounting_admin.py xero auth (on the VPS)."));
  } else if (feed.error) {
    root.append(el("div", { class: "warnbar" },
      `Xero feed error: ${feed.error} — see accounting_admin.py xero.`));
  } else if (feed.configured && !feed.connected) {
    root.append(el("div", { class: "warnbar" },
      "Xero app credentials are in .env but the account isn't connected " +
      "yet — run accounting_admin.py xero auth (on the VPS)."));
  } else if (feed.connected && feedAgeDays != null && feedAgeDays > 2) {
    root.append(el("div", { class: "warnbar" },
      `Xero feed hasn't synced in ${Math.floor(feedAgeDays)}d — 'serve' ` +
      "may be down, or the token needs a re-auth. Balance evidence is " +
      "aging toward gate RED."));
  }

  /* awaiting payment + stock chips */
  const out = orders.outstanding || {};
  const inv = orders.inventory || {};
  root.append(el("div", { class: "chiprow", style: "margin:0" },
    out.count
      ? pill("warn", `${out.count} order${out.count > 1 ? "s" : ""} awaiting payment — ${fmtR(out.total_rand)}`)
      : pill("ok", "no payments outstanding"),
    el("a", {
      class: "b sm line",
      href: "https://www.aliexpress.com/p/order/index.html",
      target: "_blank", rel: "noopener",
    }, "💳 Pay on AliExpress ↗"),
    inv.rows
      ? el("span", {
          class: "pill ok", style: "cursor:pointer",
          onclick: () => setDesk("stock", { focus: "stock-table" }),
        }, `📥 ${fmtNum(inv.units)} units on hand — ${fmtR(inv.value_rand)} landed (estimate) · Stock desk →`)
      : null,
    feed.configured
      ? (feed.synced_at
          ? pill(feedAgeDays > 2 ? "warn" : "ok",
              `🏦 Xero feed synced ${fmtAgo(feed.synced_at)}` +
              (feed.lines_added ? ` · ${feed.lines_added} new` : ""))
          : pill("warn", feed.connected
              ? "🏦 Xero feed connected — first sync pending"
              : "🏦 Xero app configured — auth pending"))
      : null));

  /* cash-position cards (statement/manual as-of balances + float) */
  root.append(cashStrip(bank));

  /* P&L KPI cards */
  const rev = month.revenue || {};
  const totalSales = (rev.amazon || 0) + (rev.takealot || 0);
  root.append(el("div", { class: "kpis" },
    kpi(`Sales · Amazon`, fmtR(rev.amazon || 0),
      totalSales ? `${Math.round(((rev.amazon || 0) / totalSales) * 100)}% of ${month.month || "this month"}` : month.month || ""),
    kpi(`Sales · Takealot`, fmtR(rev.takealot || 0),
      totalSales ? `${Math.round(((rev.takealot || 0) / totalSales) * 100)}% · second channel` : ""),
    kpi("Total sales", fmtR(totalSales), `${month.month || "this month"} · both channels`),
    kpi("Net · after costs",
      el("span", { class: (month.net ?? 0) >= 0 ? "v ok" : "v hot" }, fmtR(month.net ?? 0)),
      month.estimate_rand ? `${fmtR(month.estimate_rand)} rests on estimates` : "actuals only")));

  /* main grid */
  const left = el("div", { style: "display:flex;flex-direction:column;gap:14px;min-width:0" });
  const right = el("div", { style: "display:flex;flex-direction:column;gap:14px;min-width:0" });
  root.append(el("div", {
    style: "display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:14px;align-items:start",
    class: "bookgrid",
  }, left, right));

  left.append(pnlPanel(acc, pnl));
  left.append(reconPanel(bank));
  left.append(ledgerPanel(acc));
  right.append(gatePanel(bank));
  right.append(taxPanel(acc));
  right.append(docsPanelEl(acc));

  root.append(el("div", { class: "hint" },
    "Bookmarked for a later build: FX & fee-anomaly watch, evidence " +
    "coverage, the SARS export pack and the order-to-cash strip."));
}

/* ---- Cash position: as-of balances per account + the estimated float.
   No SA bank offers an API, so every number carries its age — the chip
   tone follows the gate's staleness rule. 'confirm' stamps the balance
   read off the banking app via the command bus. ---- */

function fmtMoney(amount, currency) {
  if (amount == null) return "—";
  return (currency === "USD" ? "$ " : "R ") + Number(amount)
    .toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ageChip(ageDays, maxDays) {
  if (ageDays == null) return pill("mute", "no evidence");
  const tone = ageDays > maxDays ? "bad"
    : ageDays * 2 > maxDays ? "warn" : "ok";
  return pill(tone, ageDays === 0 ? "fresh today" : `${ageDays}d old`);
}

function confirmBalanceModal(account) {
  withToken(() => {
    const acctInput = account ? null : el("input", {
      type: "text", class: "in wide", style: "margin:10px 0 0",
      placeholder: "account id, e.g. capitec-zar / shyft-usd",
    });
    const input = el("input", {
      type: "number", step: "0.01", class: "in wide",
      style: "margin:10px 0 4px",
      placeholder: "balance as the banking app shows it now",
    });
    const status = statusLine();
    openModal(
      el("h3", {}, account ? `Confirm ${account} balance` : "Confirm a balance"),
      el("p", { class: "meta" },
        "Read the balance off the banking app and stamp it — freshness is " +
        "what the affordability gate trusts. Statements stay the richer source."),
      acctInput, input,
      el("button", {
        class: "b pri wide", style: "margin-top:10px",
        onclick: () => {
          const acct = (account || (acctInput.value || "").trim().toLowerCase());
          const amount = parseFloat(input.value);
          if (!/^[a-z0-9]+(-[a-z0-9]+)*-[a-z]{3}$/.test(acct)) {
            status.textContent = "Account id looks wrong — expected e.g. capitec-zar.";
            return;
          }
          if (!isFinite(amount)) {
            status.textContent = "Enter the balance as a number.";
            return;
          }
          busAct(`confirm ${acct} balance`, (doc) => {
            const bucket = (doc.banking ??= {});
            prunePush(bucket, "balances",
              { account: acct, amount, requested_at: new Date().toISOString() }, 2);
          }, status,
            `✅ ${acct} balance sent — applied within ~30s ('serve' must be up).`);
        },
      }, "Stamp balance"),
      status);
  });
}

function cashStrip(bank) {
  const accounts = bank.accounts || [];
  const gate = bank.gate || {};
  const maxAge = (gate.knobs || {}).max_balance_age_days ?? 7;
  const wrap = el("div", { class: "kpis" });
  for (const acc of accounts) {
    wrap.append(el("div", { class: "kpi" },
      el("div", { class: "l" }, acc.account),
      el("div", { class: "v" }, fmtMoney(acc.balance, acc.currency)),
      el("div", { class: "s", style: "display:flex;gap:6px;align-items:center;flex-wrap:wrap" },
        ageChip(acc.age_days, maxAge),
        el("span", {}, acc.balance != null
          ? `${acc.source} · ${fmtDate(acc.as_of)} · ${fmtNum(acc.lines)} lines`
          : "drop a statement, or"),
        el("a", {
          style: "cursor:pointer;color:var(--acc)",
          onclick: () => confirmBalanceModal(acc.account),
        }, "confirm ✎"))));
  }
  wrap.append(el("div", { class: "kpi" },
    el("div", { class: "l" }, "Float · est. ZAR"),
    el("div", { class: "v" }, gate.cash_zar != null ? fmtR(gate.cash_zar) : "—"),
    el("div", { class: "s", style: "display:flex;gap:6px;align-items:center;flex-wrap:wrap" },
      gate.cash_zar != null
        ? el("span", {}, `incl. $ ${fmtNum(gate.usd)} @ ${gate.fx_rate} · ` +
            `${fmtR(gate.available_rand)} above the floor`)
        : el("span", {}, "no balance evidence yet —"),
      accounts.length ? null : el("a", {
        style: "cursor:pointer;color:var(--acc)",
        onclick: () => confirmBalanceModal(null),
      }, "confirm a balance ✎"))));
  return wrap;
}

/* ---- Affordability gate: the pre-condition for (auto-)ordering.
   GREEN place / AMBER watch / RED hold everything / UNARMED never blocks
   (no cash evidence yet). Knobs are remote-tunable — Save rides the
   command bus and the pipeline mirrors them for the ordering stage. ---- */

const GATE_TONE = { green: "ok", amber: "warn", red: "bad", unarmed: "mute" };
const GATE_WORD = {
  green: "orders may place",
  amber: "placing, but watch it",
  red: "ALL placements held (auto and manual)",
  unarmed: "never blocks — arms on the first balance evidence",
};

function gatePanel(bank) {
  const gate = bank.gate || {};
  const knobs = gate.knobs || {};
  const status = statusLine();
  const p = panelEl("Affordability gate", {
    soft: "— cash says yes before any order places",
    right: pill(GATE_TONE[gate.status] || "mute",
      (gate.status || "?").toUpperCase()),
  });
  p.dataset.focus = "gate";
  p.append(el("div", { class: "hint" }, GATE_WORD[gate.status] || ""));

  const dim = (label, value, bad) => el("div", { class: "kvrow" },
    el("span", { class: "k" }, label),
    el("span", { class: "v", style: bad ? "color:var(--bad);font-weight:650" : "" }, value));
  p.append(
    dim("Cash (est. ZAR) vs floor",
      gate.cash_zar != null
        ? `${fmtR(gate.cash_zar)} / ${fmtR(knobs.cash_floor_rands)}`
        : "no evidence",
      gate.cash_zar != null && gate.available_rand <= 0),
    dim("In-flight exposure vs cap",
      `${fmtR(gate.inflight_rand)} / ${fmtR(knobs.max_inflight_rands)}`,
      (gate.inflight_rand ?? 0) >= (knobs.max_inflight_rands ?? Infinity)),
    dim("Orders today vs cap",
      `${gate.orders_today ?? 0} / ${knobs.max_orders_day ?? "—"}`,
      (gate.orders_today ?? 0) >= (knobs.max_orders_day ?? Infinity)),
    dim("Balance evidence age vs max",
      gate.age_days != null
        ? `${gate.age_days}d / ${knobs.max_balance_age_days}d` : "—",
      gate.age_days != null && gate.age_days > (knobs.max_balance_age_days ?? 7)));

  for (const reason of gate.reasons || []) {
    p.append(el("div", { class: "note warn", style: "margin-top:6px" }, `⛔ ${reason}`));
  }
  for (const note of gate.watch || []) {
    p.append(el("div", { class: "hint" }, `⚠️ ${note}`));
  }

  /* knob editing — writes doc.affordability, the pipeline mirrors it */
  const floorIn = el("input", { type: "number", class: "in", step: "1",
    value: knobs.cash_floor_rands ?? "", style: "width:90px" });
  const inflightIn = el("input", { type: "number", class: "in", step: "1",
    value: knobs.max_inflight_rands ?? "", style: "width:90px" });
  const dayIn = el("input", { type: "number", class: "in", step: "1", min: "0",
    value: knobs.max_orders_day ?? "", style: "width:64px" });
  p.append(el("div", {
    style: "display:flex;gap:8px;align-items:end;flex-wrap:wrap;margin-top:10px;" +
           "padding-top:8px;border-top:1px solid var(--line-soft)",
  },
    el("label", { class: "hint" }, "floor R", floorIn),
    el("label", { class: "hint" }, "in-flight R", inflightIn),
    el("label", { class: "hint" }, "orders/day", dayIn),
    el("button", {
      class: "b sm", onclick: () => {
        const floor = parseFloat(floorIn.value);
        const inflight = parseFloat(inflightIn.value);
        const day = parseInt(dayIn.value, 10);
        if (![floor, inflight, day].every(isFinite) || floor < 0 || inflight < 0 || day < 0) {
          status.textContent = "Knobs must be non-negative numbers.";
          return;
        }
        busAct("set affordability knobs", (doc) => {
          doc.affordability = {
            cash_floor_rands: floor, max_inflight_rands: inflight,
            max_orders_day: day, requested_at: new Date().toISOString(),
          };
        }, status, "✅ Knobs sent — the gate re-judges on the next orders pass.");
      },
    }, "Save knobs")),
    el("div", { class: "hint", style: "margin-top:4px" },
      `knobs from ${gate.knobs_source || "config"} · ` +
      "RED also holds manual dashboard orders — money out is money out"),
    status);
  return p;
}

/* ---- Reconciliation workbench: how much of the statement story the
   ledger explains, and the exceptions a human should look at. Post as
   expense / Dismiss ride the command bus (idempotent per stamp). ---- */

const LINE_ACCOUNTS = [
  ["431", "Bank charges & FX"], ["429", "General expenses"],
  ["412", "Advertising"], ["489", "Subscriptions & software"],
  ["430", "Freight & clearing (local)"],
];

function reconPanel(bank) {
  const recon = bank.recon || {};
  const accounts = recon.accounts || [];
  const status = statusLine();
  const p = panelEl("Reconciliation", {
    soft: "— statement lines ↔ ledger, exceptions only",
    right: recon.unmatched_total
      ? pill("warn", `${recon.unmatched_total} unmatched`)
      : (accounts.length ? pill("ok", "fully explained") : null),
  });
  p.dataset.focus = "recon";
  if (!accounts.length) {
    p.append(emptyLine("no bank lines yet — the Xero feed lands Capitec " +
      "lines automatically once connected; Shyft (or any bank) exports " +
      "drop on the Documents panel and the matcher takes it from there"));
    return p;
  }
  for (const acct of accounts) {
    const pct = Math.round((acct.coverage ?? 0) * 100);
    p.append(el("div", { class: "kvrow" },
      el("span", { class: "k" }, acct.account),
      el("span", { class: "v" }, `${acct.matched}/${acct.lines} explained (${pct}%)` +
        (acct.oldest_unmatched ? ` · oldest ${fmtDate(acct.oldest_unmatched)}` : ""))));
    p.append(el("div", { class: `gauge${acct.unmatched ? "" : " ok"}` },
      el("span", { style: `width:${Math.min(100, pct)}%` })));
  }

  function lineAct(row, id, key, entry, sentWord) {
    busAct(`${sentWord} bank line`, (doc) => {
      const bucket = (doc.banking ??= {});
      prunePush(bucket, key, { id, ...entry, requested_at: new Date().toISOString() }, 2);
    }, status, `✅ ${sentWord} sent — applied within ~30s ('serve' must be up).`);
    row.replaceChildren(el("span", { class: "st ok" }, `✓ ${sentWord} sent`));
  }

  const list = el("div", { style: "margin-top:10px" });
  for (const ex of recon.exceptions || []) {
    const select = el("select", { class: "in", style: "font-size:12px;padding:4px 6px" },
      ...LINE_ACCOUNTS.map(([code, name]) =>
        el("option", { value: code }, `${code} ${name}`)));
    const actions = el("div", { style: "display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px" },
      (ex.amount ?? 0) < 0 ? select : null,
      (ex.amount ?? 0) < 0 ? el("button", {
        class: "b sm pri",
        onclick: (ev) => lineAct(actions, ex.id, "expense_lines",
          { account: select.value }, "post"),
      }, "Post as expense") : null,
      el("button", {
        class: "b sm",
        onclick: () => lineAct(actions, ex.id, "dismiss_lines", {}, "dismiss"),
      }, "Dismiss"));
    list.append(el("div", { class: "doccard", style: "margin-top:8px" },
      el("div", { class: "dh" },
        el("span", { class: "fn" }, (ex.description || "?").slice(0, 70)),
        el("span", { style: "flex:1" }),
        el("span", { class: "hint" }, `${fmtDate(ex.date)} · ${ex.account}`),
        el("span", {
          class: "r",
          style: `font-variant-numeric:tabular-nums;font-weight:650;` +
                 `color:var(--${(ex.amount ?? 0) < 0 ? "bad" : "ok-text"})`,
        }, fmtMoney(ex.amount, ex.currency))),
      actions));
  }
  if (!(recon.exceptions || []).length) {
    list.append(el("div", { class: "hint", style: "margin-top:8px" },
      "no exceptions — every statement line is matched, posted, a transfer " +
      "leg, or dismissed"));
  }
  p.append(list, status,
    el("div", { class: "hint", style: "margin-top:6px" },
      "auto-matching is single-candidate-only: transfers pair by amount, " +
      "Ali orders match goods+freight as one charge (FX-aware for the USD " +
      "card) · wrong match? scripts/accounting_admin.py unmatch-line"));
  return p;
}

function pnlPanel(acc, pnl) {
  const p = panelEl("Monthly P&L", {
    soft: "— per channel, off the transactions ledger",
    right: (acc.finances || {}).events_polled_at
      ? el("span", {}, "finances polled ", agoSpan(acc.finances.events_polled_at))
      : "Amazon Finances not yet polled",
  });
  if (!pnl.length) {
    p.append(emptyLine("no ledger months yet — the first sale or posted " +
      "document starts the P&L"));
    return p;
  }
  const table = el("table", { class: "grid" },
    el("tr", {}, el("th", {}, "Month"), el("th", { class: "r" }, "Amazon"),
      el("th", { class: "r" }, "Takealot"), el("th", { class: "r" }, "Fees"),
      el("th", { class: "r" }, "COGS"), el("th", { class: "r" }, "Expenses"),
      el("th", { class: "r" }, "Net")));
  for (const m of [...pnl].reverse()) {
    table.append(el("tr", {},
      el("td", { class: "t" }, m.month + (m.estimate_rand ? " ~" : "")),
      el("td", { class: "r" }, fmtR((m.revenue || {}).amazon)),
      el("td", { class: "r" }, fmtR((m.revenue || {}).takealot)),
      el("td", { class: "r" }, fmtR(m.fees)),
      el("td", { class: "r" }, fmtR((m.cogs || {}).total)),
      el("td", { class: "r" }, fmtR(m.expenses)),
      el("td", { class: "r", style: `font-weight:650;color:var(--${(m.net ?? 0) >= 0 ? "ok-text" : "bad"})` },
        fmtR(m.net))));
  }
  p.append(el("div", { class: "scroll-x" }, table),
    el("div", { class: "hint", style: "margin-top:6px" },
      "~ = month includes estimated rows (AliExpress supplier costs post as " +
      "order-time ZAR estimates until actuals replace them)"));
  return p;
}

function ledgerPanel(acc) {
  const p = panelEl("Ledger", {
    soft: `— ${fmtNum(acc.ledger_rows || 0)} rows · append-only`,
  });
  if (!(acc.recent || []).length) {
    p.append(emptyLine("no ledger rows yet"));
    return p;
  }
  const table = el("table", { class: "grid" },
    el("tr", {}, el("th", {}, "When"), el("th", {}, "Account"),
      el("th", {}, "Description"), el("th", { class: "r" }, "Amount"),
      el("th", {}, "Basis")));
  for (const r of acc.recent) {
    table.append(el("tr", {},
      el("td", { class: "t", style: "color:var(--muted);font-size:12px" }, fmtDate(r.posted_at)),
      el("td", { class: "t", style: "font-size:12px" },
        `${r.account ?? ""} ${r.account_name ?? ""}`),
      el("td", { class: "t", style: "color:var(--ink2);font-size:12px" }, r.description ?? ""),
      el("td", { class: "r", style: (r.amount ?? 0) > 0 ? "color:var(--ok-text)" : "" },
        (r.amount ?? 0) > 0 ? `+${fmtR(r.amount).slice(2)}` : fmtR(r.amount)),
      el("td", { class: "t" }, el("span", {
        class: `st ${r.basis === "actual" ? "mute" : "warn"}`,
        style: "font-weight:400;font-size:12px",
      }, r.basis ?? ""))));
  }
  p.append(el("div", { class: "scroll-x" }, table),
    el("div", { class: "hint", style: "margin-top:6px" },
      "append-only by design: corrections post a reversing entry plus the " +
      "correction — full history via scripts/accounting_admin.py"));
  return p;
}

function taxPanel(acc) {
  const supplies = acc.supplies_12mo || {};
  const irp6 = acc.irp6 || {};
  const pct = Math.round((supplies.fraction || 0) * 100);
  const p = panelEl("Tax", {
    right: acc.vat_registered ? pill("warn", "VAT REGISTERED") : null,
  });
  p.append(el("div", { class: "kvrow" },
    el("span", { class: "k" }, "VAT registration threshold — rolling 12mo"),
    el("span", { class: "v", style: "font-weight:650" }, `${pct}%`)));
  p.append(el("div", { class: "gauge" },
    el("span", { style: `width:${Math.min(100, pct)}%` })));
  p.append(el("div", { class: "hint", style: "margin-top:4px" },
    `${fmtR(supplies.total_rand)} of ${fmtR(supplies.threshold_rand)}` +
    (pct < 60 ? " — headroom; the alert arms at 60%" : " — nearing the threshold")));
  p.append(el("div", { class: "kvrow", style: "margin-top:8px;padding-top:8px;border-top:1px solid var(--line-soft)" },
    el("span", { class: "k" },
      `${irp6.next_deadline_label || "IRP6"} · tax year ${irp6.tax_year ?? "—"}`),
    el("span", { class: "v", style: "font-weight:650" },
      irp6.days_to_deadline != null ? `in ${irp6.days_to_deadline}d` : "—")));
  p.append(el("div", { class: "kvrow" },
    el("span", { class: "k" }, "YTD profit"),
    el("span", { class: "v" }, fmtR(irp6.ytd_profit_rand))));
  p.append(el("div", { class: "kvrow" },
    el("span", { class: "k" }, "Annualised"),
    el("span", { class: "v" }, fmtR(irp6.annualised_rand))));
  p.append(el("div", { class: "hint", style: "margin-top:4px" },
    "records live in SA for 5 years — the documents panel below is the evidence store"));
  return p;
}

/* Documents: upload → Worker R2 transit → serve drains to the local store →
   Gemini extracts → Post/Ignore here (accounting.post_docs / ignore_docs). */
const DOC_STATUS_TONE = {
  new: "mute", extracted: "warn", posted: "ok",
  ignored: "mute", extract_failed: "hot", ingested: "ok",
};

function docsPanelEl(acc) {
  const status = statusLine();
  const p = panelEl("Documents & evidence", {
    soft: "— upload → Gemini reads → you post",
  });
  p.dataset.focus = "documents";

  const transit = el("div", { class: "hint", style: "margin-top:6px" });
  async function loadTransit() {
    if (!localStorage.getItem(PAT_KEY) || !LIVE_BASE) return;
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
    if (!localStorage.getItem(PAT_KEY)) { withToken(() => upload(files)); return; }
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
      await mutateCommands((doc) => {
        doc.docs = { ...(doc.docs || {}), uploaded_at: new Date().toISOString() };
      }, "Dashboard: documents uploaded");
      status.textContent = `${done} file(s) uploaded — the pipeline drains and ` +
        "extracts within seconds ('serve' must be up).";
    } catch (e) {
      status.textContent = `${done} file(s) uploaded — wake-up stamp failed; ` +
        "the backstop drain picks them up within ~5 min.";
    }
    loadTransit();
  }

  const input = el("input", {
    type: "file", multiple: "", accept: ".pdf,.jpg,.jpeg,.png,.webp,.csv",
    style: "display:none",
    onchange: (ev) => {
      if (ev.target.files?.length) upload([...ev.target.files]);
      ev.target.value = "";
    },
  });
  const drop = el("div", {
    class: "drop", style: "cursor:pointer",
    onclick: () => input.click(),
    ondragover: (ev) => { ev.preventDefault(); drop.classList.add("over"); },
    ondragleave: () => drop.classList.remove("over"),
    ondrop: (ev) => {
      ev.preventDefault();
      drop.classList.remove("over");
      if (ev.dataTransfer?.files?.length) upload([...ev.dataTransfer.files]);
    },
  },
    el("div", { class: "ic" }, "⇪"),
    el("div", { style: "flex:1" },
      el("div", { style: "font-size:12.5px;font-weight:600" },
        "Drop files or ", el("span", { style: "color:var(--acc)" }, "browse")),
      el("div", { class: "hint" },
        "PDF/JPG/PNG/WEBP/CSV up to 25 MB — supplier invoices, SAD 500 / " +
        "clearance, courier invoices, bank statements (Capitec/Shyft " +
        "exports become reconciliation lines)")),
    input);
  p.append(drop, transit,
    el("div", { class: "hint", style: "margin-top:6px" },
      "uploads drain to the local canonical store within seconds (SARS: " +
      "records live in SA) · nothing posts without a click"));

  function decide(id, action) {
    busAct(`${action} document`, (doc) => {
      const bucket = (doc.accounting ??= {});
      const key = action === "post" ? "post_docs" : "ignore_docs";
      const fresh = (bucket[key] || []).filter((e) => e.id !== id &&
        Date.now() - new Date(e.requested_at).getTime() < 48 * 3600 * 1000);
      fresh.push({ id, requested_at: new Date().toISOString() });
      bucket[key] = fresh;
    }, status, `${action} sent — applied within ~30s ('serve' must be up).`);
  }

  const docs = acc.documents || [];
  const cards = el("div", { style: "margin-top:12px" });
  for (const d of docs) {
    const tone = DOC_STATUS_TONE[d.status] || "mute";
    const read = d.bank
      ? `statement → ${d.bank.account} · ${d.bank.lines_added} new line(s)` +
        (d.bank.closing_balance != null
          ? ` · closing ${d.currency ?? ""} ${fmtNum(d.bank.closing_balance)}` : "")
      : d.doc_type
      ? `${d.doc_type} — ${d.supplier ?? "?"}` +
        (d.total_amount != null ? ` · ${d.currency ?? ""} ${fmtNum(d.total_amount)}` : "")
      : (d.error ?? "—");
    const suggested = (d.suggested || [])
      .map((s) => `${s.account}: ${fmtR(s.amount)} — ${s.description ?? ""}`).join("; ");
    cards.append(el("div", { class: "doccard" },
      el("div", { class: "dh" },
        el("span", { class: "fn" }, d.filename ?? d.id),
        el("span", { class: `pill ${tone}`, style: "font-size:11px" }, d.status),
        el("span", { style: "flex:1" }),
        d.confidence != null
          ? el("span", { class: "hint" }, `conf ${Math.round(d.confidence * 100)}%`)
          : (d.drained_at ? el("span", { class: "hint" }, fmtDate(d.drained_at)) : null)),
      el("div", { style: "font-size:12px;color:var(--ink2);margin-top:4px" },
        read, suggested ? el("span", {}, " · suggests ", el("b", {}, suggested)) : null),
      ["extracted", "extract_failed", "new"].includes(d.status)
        ? el("div", { style: "display:flex;gap:8px;margin-top:8px" },
            d.status === "extracted"
              ? el("button", { class: "b sm pri", onclick: () => decide(d.id, "post") },
                  "Post to ledger") : null,
            el("button", { class: "b sm", onclick: () => decide(d.id, "ignore") }, "Ignore"))
        : null));
  }
  if (!docs.length) {
    cards.append(emptyLine("no documents drained yet"));
  }
  p.append(cards, status);
  return p;
}
