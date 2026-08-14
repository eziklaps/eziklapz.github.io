/* Shared: API access with bearer auth, nav, table + chart helpers. */
const API = location.hostname === "localhost" || location.hostname === "127.0.0.1"
  ? "http://127.0.0.1:8200"
  : "https://raincheck-api.andrewwalsh.co.za";

function token() { return localStorage.getItem("rc_token") || ""; }

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token() ? { Authorization: "Bearer " + token() } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) { showLogin(); throw new Error("unauthorized"); }
  if (!res.ok) {
    let d = ""; try { d = (await res.json()).detail; } catch (e) {}
    throw new Error(d || res.status + " " + res.statusText);
  }
  return res.json();
}

function showLogin() {
  if (document.getElementById("login")) return;
  const div = document.createElement("div");
  div.id = "login";
  div.innerHTML = `<form>
    <h1>Rain<span style="color:var(--accent)">Check</span> ops</h1>
    <input type="password" id="pw" placeholder="passphrase" autocomplete="current-password">
    <button class="primary">Unlock</button>
    <div class="err" id="loginerr"></div>
  </form>`;
  document.body.appendChild(div);
  div.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const r = await fetch(API + "/v1/auth", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase: div.querySelector("#pw").value }),
      });
      if (!r.ok) throw new Error("bad passphrase");
      localStorage.setItem("rc_token", (await r.json()).token);
      location.reload();
    } catch (err) {
      div.querySelector("#loginerr").textContent = err.message;
    }
  });
  div.querySelector("#pw").focus();
}

function nav(active) {
  const pages = [["index", "Dashboard"], ["explorer", "Explorer"],
                 ["quotes", "Quotes"], ["policies", "Policies"],
                 ["backtest", "Backtest"]];
  const el = document.createElement("nav");
  el.innerHTML = `<div class="brand">Rain<span>Check</span> ops</div>` +
    pages.map(([p, label]) =>
      `<a href="${p}.html" class="${p === active ? "active" : ""}">${label}</a>`).join("") +
    `<a class="logout" title="forget token">lock</a>`;
  document.body.prepend(el);
  el.querySelector(".logout").addEventListener("click", () => {
    localStorage.removeItem("rc_token"); location.reload();
  });
}

/* ---------- rendering helpers ---------- */
const fmtR = (v) => v == null ? "—" : "R" + Number(v).toLocaleString("en-ZA",
  { maximumFractionDigits: 0 });
const fmtP = (v) => v == null ? "—" : (100 * v).toFixed(2) + "%";
const esc = (s) => String(s ?? "—").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function renderTable(el, rows, cols) {
  if (!rows.length) { el.innerHTML = `<p class="sub" style="padding:12px">Nothing recorded yet.</p>`; return; }
  el.innerHTML = `<table><thead><tr>` +
    cols.map((c) => `<th>${c.label}</th>`).join("") +
    `</tr></thead><tbody>` +
    rows.map((r) => `<tr>` + cols.map((c) => {
      const v = c.get ? c.get(r) : r[c.key];
      return `<td class="${c.num ? "num" : ""}">${c.html ? v : esc(v)}</td>`;
    }).join("") + `</tr>`).join("") + `</tbody></table>`;
}

/* Minimal line chart: series = [{label, color, points: [[x,y],...]}] */
function lineChart(canvas, series, { yFmt = (v) => v, xLabels = null, yMax = null } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight || 260;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const pad = { l: 52, r: 14, t: 14, b: 26 };
  const all = series.flatMap((s) => s.points);
  if (!all.length) return;
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y1 = yMax ?? (Math.max(...ys) * 1.15 || 1);
  const X = (x) => pad.l + ((x - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const Y = (y) => H - pad.b - (y / y1) * (H - pad.t - pad.b);
  ctx.strokeStyle = "#24314F"; ctx.fillStyle = "#7C8BA5";
  ctx.font = "11px Consolas, monospace"; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (y1 * i) / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, Y(y)); ctx.lineTo(W - pad.r, Y(y)); ctx.stroke();
    ctx.fillText(yFmt(y), 6, Y(y) + 4);
  }
  if (xLabels) xLabels.forEach(([x, label]) => ctx.fillText(label, X(x) - 8, H - 8));
  for (const s of series) {
    ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.6;
    ctx.beginPath();
    s.points.forEach(([x, y], i) => i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)));
    ctx.stroke();
  }
  return { X, Y, ctx, y1 };
}

const MONTH_TICKS = [[0, "Jan"], [8.7, "Mar"], [17.4, "May"], [26.1, "Jul"],
                     [34.8, "Sep"], [43.5, "Nov"]];
