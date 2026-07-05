/* Admin dashboard: fetch admin.enc, decrypt with WebCrypto (PBKDF2 +
   AES-256-GCM — envelope produced by funnel/publisher.py), render. The
   passphrase is remembered in localStorage; a wrong one fails GCM auth,
   clears the stored value and re-prompts. */

const PASS_KEY = "s2pass";
const REFRESH_MS = 60_000;

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function decryptEnvelope(envelope, passphrase) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: b64(envelope.salt),
      iterations: envelope.iterations },
    keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64(envelope.nonce) }, key, b64(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(plain));
}

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
    tiles.append(tile("Paced work left", `~${fmtDur(data.work_eta_seconds)}`,
                      "SP-API + AliExpress pacing; Gemini batches excluded"));
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
  for (const market of ["amazon", "aliexpress"]) {
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

/* Remote control: pause/resume lanes, stop/start the run — every action is
   a commit to commands.json; the pipeline polls it within ~30s. The ack
   block shows what the pipeline last applied. */
const CONTROL_LANES = ["intake", "spapi", "gemini", "aliexpress", "local", "publisher"];

function controlsPanel(data) {
  const body = el("div", {});
  const status = el("div", { class: "hint", style: "margin-top:8px" });

  if (!localStorage.getItem(PAT_KEY)) {
    const input = el("input", {
      type: "password", placeholder: "Fine-grained GitHub token (contents R/W)",
      style: "width:100%;max-width:420px;padding:8px 10px;margin-right:8px;" +
             "border:1px solid var(--hairline);border-radius:8px;" +
             "background:var(--surface);color:var(--ink);",
    });
    body.append(
      el("p", { class: "hint" },
        "Paste a fine-grained GitHub token (contents read/write on the site repo " +
        "only) to control the pipeline from here. Stored in this browser only."),
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
            doc.run = { desired: "running",
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
    el("div", { class: "scroll-x", style: "margin-top:10px" }, table),
    status);
  return panel("Remote control", body);
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
