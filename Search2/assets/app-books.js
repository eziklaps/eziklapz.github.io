/* Books desk — money: four figures (cash, float above the floor, sales,
   net), the affordability gate + knobs, the reconciliation workbench
   (bank statements ↔ ledger), monthly P&L off the transactions ledger,
   tax, the newest ledger rows, and the documents flow (upload → drain →
   Gemini-extract → you post; nothing posts unreviewed). Bookmarked for a
   later build: FX/fee-anomaly watch, evidence coverage, SARS export pack,
   order-to-cash strip. */

function renderBooksDesk(root) {
  const a = S.admin || {};
  const acc = a.accounting || {};
  const bank = a.banking || {};
  const orders = a.orders || {};
  const pnl = acc.pnl || [];
  const month = pnl[pnl.length - 1] || {};
  const out = orders.outstanding || {};

  /* Xero feed pulse: auth failure / errors / staleness. Ages are
     computed here at render time — the payload carries timestamps only.
     Freshness is RECONCILIATION freshness: the balance's as_of is the
     newest coded line, so a lazy week in Xero ages toward gate RED. */
  const feed = bank.feed || {};
  const feedAgeDays = feed.synced_at
    ? (Date.now() - new Date(feed.synced_at).getTime()) / 86400e3 : null;

  root.append(deskHead("Books", [
    feed.configured
      ? (feed.synced_at
          ? { text: "Xero synced", ago: feed.synced_at,
              tone: feedAgeDays > 2 ? "warn" : "ok",
              title: "the feed only sees lines coded in Xero — reconciling " +
                     "there is what keeps balances fresh" +
                     (feed.lines_added ? ` · ${feed.lines_added} new lines` : "") }
          : { text: feed.connected ? "Xero connected · first sync pending"
                                   : "Xero auth pending", tone: "warn" })
      : null,
    out.count
      ? { text: `${out.count} order${out.count > 1 ? "s" : ""} unpaid · ${fmtR(out.total_rand)}`,
          tone: "warn",
          node: el("a", { href: ALI_ORDERS_URL, target: "_blank", rel: "noopener" }, "pay ↗") }
      : { text: "nothing awaiting payment", plain: true },
    { text: "updated", ago: a.generated_at, plain: true },
  ]));

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

  /* the four figures: cash (largest account, others folded), float above
     the floor (what the gate lets you spend), sales, net */
  const accounts = bank.accounts || [];
  const gate = bank.gate || {};
  const knobs = gate.knobs || {};
  const maxAge = knobs.max_balance_age_days ?? 7;
  const primary = [...accounts].filter((x) => x.balance != null)
    .sort((x, y) => (y.balance || 0) - (x.balance || 0))[0] || accounts[0] || null;
  const others = accounts.filter((x) => x !== primary && x.balance != null);
  const othersTotal = others.reduce((s, x) => s + (x.currency === "USD"
    ? (x.balance || 0) * (gate.fx_rate || 18) : (x.balance || 0)), 0);
  const rev = month.revenue || {};
  const totalSales = (rev.amazon || 0) + (rev.takealot || 0);
  root.append(el("div", { class: "kpis" },
    kpi(primary ? `Cash · ${primary.bank || primary.account}` : "Cash",
      primary ? fmtMoney(primary.balance, primary.currency) : "—",
      el("span", { style: "display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap" },
        primary ? ageChip(primary.age_days, maxAge) : null,
        primary && primary.as_of
          ? el("span", { title: `${primary.source} · ${fmtNum(primary.lines)} lines` },
              fmtDate(primary.as_of)) : null,
        others.length
          ? el("span", { title: others.map((o) =>
              `${o.account} ${fmtMoney(o.balance, o.currency)}`).join(" · ") },
              `+ ${fmtR(othersTotal)} in ${others.length} other`) : null,
        el("a", {
          onclick: () => confirmBalanceModal(primary ? primary.account : null),
        }, "confirm ✎"))),
    kpi("Above the floor",
      gate.available_rand != null
        ? el("span", { class: gate.available_rand > 0 ? "v" : "v bad" }, fmtR(gate.available_rand))
        : "—",
      el("span", { style: "display:inline-flex;gap:6px;align-items:center" },
        pill(GATE_TONE[gate.status] || "mute", (gate.status || "unarmed").toUpperCase()),
        `floor ${fmtR(knobs.cash_floor_rands ?? 0)}`)),
    kpi(`Sales · ${month.month || "this month"}`, fmtR(totalSales),
      `Amazon ${fmtR(rev.amazon || 0)} · Takealot ${fmtR(rev.takealot || 0)}`),
    kpi("Net · after costs",
      el("span", { class: (month.net ?? 0) >= 0 ? "v ok" : "v hot" }, fmtR(month.net ?? 0)),
      month.estimate_rand ? `${fmtR(month.estimate_rand)} rests on estimates` : "actuals only")));

  /* main grid */
  const left = el("div", { style: "display:flex;flex-direction:column;gap:16px;min-width:0" });
  const right = el("div", { style: "display:flex;flex-direction:column;gap:16px;min-width:0" });
  root.append(el("div", {
    style: "display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:16px;align-items:start",
    class: "bookgrid",
  }, left, right));

  left.append(reconPanel(bank));
  left.append(pnlPanel(acc, pnl));
  left.append(ledgerPanel(acc));
  right.append(gatePanel(bank));
  right.append(docsPanelEl(acc));
  right.append(taxPanel(acc));
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
            `${acct} balance sent — applied within ~30s ('serve' must be up).`);
        },
      }, "Stamp balance"),
      status);
  });
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
    right: el("span", {},
      pill(GATE_TONE[gate.status] || "mute", (gate.status || "?").toUpperCase()),
      el("span", { class: "hint", style: "margin-left:8px" }, GATE_WORD[gate.status] || "")),
  });
  p.dataset.focus = "gate";

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
    // The binding freshness = last verifiable bank sighting (Xero poll /
    // statement / confirm). Movement age is informational — quiet books
    // are healthy books, the amber watch narrates it. Old payloads only
    // carry age_days; fall back so the row never lies blank.
    dim("Bank last seen vs max",
      (gate.verified_age_days ?? gate.age_days) != null
        ? `${gate.verified_age_days ?? gate.age_days}d / ${knobs.max_balance_age_days}d` : "—",
      (gate.verified_age_days ?? gate.age_days) != null
        && (gate.verified_age_days ?? gate.age_days) > (knobs.max_balance_age_days ?? 7)),
    dim("Newest coded movement",
      gate.movement_age_days != null ? `${gate.movement_age_days}d ago` : "—",
      false));

  /* Every reason carries its fix. Confirm pre-targets the stalest account
     (oldest evidence gains the most from a fresh sighting); reconciling
     in Xero IS the feed, so that link is the other lever. */
  const stalest = (bank.accounts || [])
    .filter((a) => a.balance != null)
    .sort((x, y) => (y.age_days ?? 9e9) - (x.age_days ?? 9e9))[0];
  const fixFor = (text) => {
    if (/balance evidence|no balance|bank last seen|no bank movement/.test(text)) {
      return [
        el("button", {
          class: "b sm pri",
          onclick: () => confirmBalanceModal((stalest || {}).account || null),
        }, "Confirm balance now"),
        el("a", {
          class: "b sm line", target: "_blank", rel: "noopener",
          href: "https://go.xero.com/Bank/BankAccounts.aspx",
          title: "coding the newest lines in Xero refreshes the feed's as-of date",
        }, "Reconcile in Xero ↗"),
      ];
    }
    if (/floor/.test(text)) {
      return [el("span", { class: "hint" },
        "fix: money in, or lower the floor knob below")];
    }
    if (/in-flight/.test(text)) {
      return [el("span", { class: "hint" },
        "clears as orders arrive (Mark received on Buy) — or raise the cap below")];
    }
    if (/\/day cap|order left today/.test(text)) {
      return [el("span", { class: "hint" },
        "resets at midnight UTC — or raise orders/day below")];
    }
    return [];
  };
  for (const reason of gate.reasons || []) {
    p.append(el("div", { class: "note warn", style: "margin-top:6px" },
      el("div", {}, reason),
      el("div", {
        style: "display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;align-items:center",
      }, ...fixFor(reason))));
  }
  for (const note of gate.watch || []) {
    const fixes = fixFor(note);
    p.append(el("div", {
      class: "note", style: "margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap",
    }, note,
      // Watch-stage balance aging gets the one-click fix too — cheaper to
      // confirm at amber than to unstick a red gate later.
      ...(/balance evidence|bank last seen/.test(note) ? fixes.slice(0, 1) : [])));
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
           "padding-top:10px;border-top:1px solid var(--line-soft)",
  },
    el("label", { class: "hint" }, "floor R", floorIn),
    el("label", { class: "hint" }, "in-flight R", inflightIn),
    el("label", { class: "hint" }, "orders/day", dayIn),
    el("button", {
      class: "b sm",
      title: `knobs from ${gate.knobs_source || "config"} · RED also holds ` +
             "manual dashboard orders — money out is money out",
      onclick: () => {
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
        }, status, "Knobs sent — the gate re-judges on the next orders pass.");
      },
    }, "Save knobs")),
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
    right: recon.unmatched_total
      ? el("span", {
          title: "auto-matching is single-candidate-only: transfers pair by " +
                 "amount, Ali orders match goods+freight as one charge · " +
                 "wrong match? scripts/accounting_admin.py unmatch-line",
        }, pill("warn", `${recon.unmatched_total} unmatched`))
      : (accounts.length ? pill("ok", "fully explained") : null),
  });
  p.dataset.focus = "recon";
  if (!accounts.length) {
    p.append(emptyLine("No bank lines yet — the Xero feed lands Capitec " +
      "lines automatically once connected; bank exports drop on the " +
      "Documents panel and the matcher takes it from there."));
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
    }, status, `${sentWord} sent — applied within ~30s ('serve' must be up).`);
    row.replaceChildren(el("span", { class: "st ok" }, `${sentWord} sent`));
  }

  // What's already riding the bus for these lines. Without this chip the
  // repaint from a not-yet-updated payload resurrected the buttons and
  // presses looked ignored (rows "reappearing" — 2026-07-15). Buttons stay
  // live: the sink applies the NEWEST press per line, so pressing again
  // with a different account is a correction, never a duplicate.
  const queued = {};
  const bankBus = (S.commands || {}).banking || {};
  for (const [key, kind] of [["expense_lines", "post"],
                             ["dismiss_lines", "dismiss"]]) {
    for (const e of bankBus[key] || []) {
      if (!e.id || !e.requested_at) continue;
      const age = Date.now() - new Date(e.requested_at).getTime();
      if (!(age > -600e3 && age < 48 * 3600e3)) continue;
      const held = queued[e.id];
      if (!held || e.requested_at > held.at) {
        queued[e.id] = { kind, account: e.account, at: e.requested_at };
      }
    }
  }

  const exceptions = recon.exceptions || [];
  const CAP = 8;
  const shown = S.booksReconAll ? exceptions : exceptions.slice(0, CAP);
  const list = el("div", { style: "margin-top:10px" });
  for (const ex of shown) {
    const select = el("select", { class: "in", style: "font-size:12px;padding:4px 6px" },
      ...LINE_ACCOUNTS.map(([code, name]) =>
        el("option", { value: code }, `${code} ${name}`)));
    const q = queued[ex.id];
    if (q && q.account
        && LINE_ACCOUNTS.some(([code]) => code === q.account)) {
      select.value = q.account;
    }
    const actions = el("div", { class: "ra" },
      el("span", {
        class: "amt",
        style: `color:var(--${(ex.amount ?? 0) < 0 ? "bad" : "ok-text"})`,
      }, fmtMoney(ex.amount, ex.currency)),
      q ? el("span", {
        class: "st warn",
        title: "already committed to the command bus — serve applies it " +
               "within ~30s and the line then leaves this list; pressing " +
               "again just changes the target account (newest press wins)",
      }, `${q.kind}${q.account ? ` → ${q.account}` : ""} queued`) : null,
      (ex.amount ?? 0) < 0 ? select : null,
      (ex.amount ?? 0) < 0 ? el("button", {
        class: "b sm pri",
        onclick: () => lineAct(actions, ex.id, "expense_lines",
          { account: select.value }, "post"),
      }, "Post as expense") : null,
      el("button", {
        class: "b sm",
        onclick: () => lineAct(actions, ex.id, "dismiss_lines", {}, "dismiss"),
      }, "Dismiss"));
    list.append(el("div", { class: "reconrow" },
      el("div", {},
        el("div", { class: "rd" }, (ex.description || "?").slice(0, 70)),
        el("div", { class: "rs" }, `${fmtDate(ex.date)} · ${ex.account}`)),
      actions));
  }
  if (!exceptions.length) {
    list.append(el("div", { class: "hint", style: "margin-top:8px" },
      "No exceptions — every statement line is matched, posted, a transfer " +
      "leg, or dismissed."));
  }
  p.append(list);
  if (exceptions.length > CAP) {
    p.append(el("div", { class: "disclose", style: "margin-top:8px" },
      el("a", {
        onclick: () => { S.booksReconAll = !S.booksReconAll; renderDesk(); },
      }, S.booksReconAll ? "Show the first 8 ▴" : `Show all ${exceptions.length} ▾`)));
  }
  p.append(status);
  return p;
}

function pnlPanel(acc, pnl) {
  const p = panelEl("Monthly P&L", {
    right: (acc.finances || {}).events_polled_at
      ? el("span", {}, "finances polled ", agoSpan(acc.finances.events_polled_at))
      : "Amazon Finances not yet polled",
  });
  if (!pnl.length) {
    p.append(emptyLine("No ledger months yet — the first sale or posted " +
      "document starts the P&L."));
    return p;
  }
  const table = el("table", { class: "grid" },
    el("tr", {}, el("th", {}, "Month"), el("th", { class: "r" }, "Amazon"),
      el("th", { class: "r" }, "Takealot"), el("th", { class: "r" }, "Fees"),
      el("th", { class: "r" }, "COGS"), el("th", { class: "r" }, "Expenses"),
      el("th", { class: "r" }, "Net")));
  for (const m of [...pnl].reverse().slice(0, 6)) {
    table.append(el("tr", {},
      el("td", { class: "t", title: m.estimate_rand
        ? `${fmtR(m.estimate_rand)} of this month rests on order-time estimates ` +
          "until supplier actuals replace them" : "" },
        m.month + (m.estimate_rand ? " ~" : "")),
      el("td", { class: "r" }, fmtR((m.revenue || {}).amazon)),
      el("td", { class: "r" }, fmtR((m.revenue || {}).takealot)),
      el("td", { class: "r" }, fmtR(m.fees)),
      el("td", { class: "r" }, fmtR((m.cogs || {}).total)),
      el("td", { class: "r" }, fmtR(m.expenses)),
      el("td", { class: "r", style: `font-weight:650;color:var(--${(m.net ?? 0) >= 0 ? "ok-text" : "bad"})` },
        fmtR(m.net))));
  }
  p.append(el("div", { class: "scroll-x" }, table));
  return p;
}

function ledgerPanel(acc) {
  const tkf = acc.takealot_finances || {};
  const p = panelEl("Ledger", {
    right: el("span", { title: "append-only by design: corrections post a " +
      "reversing entry plus the correction — full history via " +
      "scripts/accounting_admin.py" },
      `${fmtNum(acc.ledger_rows || 0)} rows · append-only`),
  });
  if (tkf.balances) {
    p.append(el("div", { class: "kvrow", style: "padding-top:0" },
      el("span", { class: "k" }, "Parked at Takealot"),
      el("span", { class: "v", title: `${fmtNum(tkf.transactions_mirrored || 0)} transactions mirrored` },
        `R ${fmtNum(tkf.balances.current)} · available R ${fmtNum(tkf.balances.available)}` +
        ` · held back R ${fmtNum(tkf.balances.held_back)}`)));
  }
  const rows = acc.recent || [];
  if (!rows.length) {
    p.append(emptyLine("No ledger rows yet."));
    return p;
  }
  const CAP = 8;
  const table = el("table", { class: "grid" },
    el("tr", {}, el("th", {}, "When"), el("th", {}, "Account"),
      el("th", {}, "Description"), el("th", { class: "r" }, "Amount"),
      el("th", {}, "Basis")));
  for (const r of (S.booksLedgerAll ? rows : rows.slice(0, CAP))) {
    table.append(el("tr", {},
      el("td", { class: "t", style: "color:var(--muted);font-size:12px;white-space:nowrap" }, fmtDate(r.posted_at)),
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
  p.append(el("div", { class: "scroll-x" }, table));
  if (rows.length > CAP) {
    p.append(el("div", { class: "disclose", style: "margin-top:8px" },
      el("a", {
        onclick: () => { S.booksLedgerAll = !S.booksLedgerAll; renderDesk(); },
      }, S.booksLedgerAll ? "Show the newest 8 ▴" : `Show all ${rows.length} ▾`)));
  }
  return p;
}

function taxPanel(acc) {
  const supplies = acc.supplies_12mo || {};
  const irp6 = acc.irp6 || {};
  const pct = Math.round((supplies.fraction || 0) * 100);
  const p = panelEl("Tax", {
    right: acc.vat_registered ? pill("warn", "VAT REGISTERED") : el("span", {
      title: "records live in SA for 5 years — the documents panel is the evidence store",
    }, "not VAT registered"),
  });
  p.append(el("div", { class: "kvrow" },
    el("span", { class: "k" }, "VAT threshold · rolling 12mo"),
    el("span", { class: "v", style: "font-weight:650" },
      `${pct}%`,
      el("span", { class: "hint", style: "margin-left:6px" },
        `${fmtR(supplies.total_rand)} of ${fmtR(supplies.threshold_rand)}`))));
  p.append(el("div", { class: "gauge" },
    el("span", { style: `width:${Math.min(100, pct)}%` })));
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
  const docs = acc.documents || [];
  const awaiting = docs.filter((d) => d.status === "extracted").length;
  const p = panelEl("Documents", {
    right: el("span", {
      title: "uploads drain to the local canonical store within seconds " +
             "(SARS: records live in SA) · Gemini reads them · nothing " +
             "posts without a click",
    }, awaiting ? el("span", { class: "st warn" }, `${awaiting} awaiting your post`)
                : "upload → read → you post"),
  });
  p.dataset.focus = "documents";

  const transit = el("div", { class: "hint", style: "margin-top:6px" });
  async function loadTransit() {
    if (!localStorage.getItem(PAT_KEY) || !LIVE_BASE) return;
    try {
      const resp = await fetch(`${LIVE_BASE}/api/docs`,
        { headers: liveHeaders(), cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const list = (await resp.json()).docs || [];
      transit.textContent = list.length
        ? `in transit, awaiting drain: ${list.map((d) => d.name).join(", ")}`
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
      el("div", { style: "font-size:13px;font-weight:600" },
        "Drop files or ", el("span", { style: "color:var(--acc)" }, "browse")),
      el("div", { class: "hint" },
        "supplier invoices, customs clearance, courier invoices, bank " +
        "statements · PDF/JPG/PNG/WEBP/CSV up to 25 MB")),
    input);
  p.append(drop, transit);

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
      el("div", { style: "font-size:12.5px;color:var(--ink2);margin-top:4px" },
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
    cards.append(emptyLine("No documents yet — drop the first invoice above."));
  }
  p.append(cards, status);
  return p;
}
