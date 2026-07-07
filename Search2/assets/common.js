/* Shared helpers for the Search2 dashboard pages.
   Data lives on the site repo's orphan 'data' branch, served CORS-open by
   raw.githubusercontent.com. ?dataBase=http://localhost:8000 overrides for
   local testing against a static file server. */

const DATA_BASE =
  new URLSearchParams(location.search).get("dataBase") ||
  "https://raw.githubusercontent.com/eziklaps/eziklapz.github.io/data/Search2/data";

/* ---- Cloudflare live layer (web/edge) ----
   When S2_LIVE_BASE points at the deployed search2-live Worker, data is
   fetched from /api/latest (no CDN staleness) and liveConnect() pushes
   version stamps over a WebSocket so pages refresh within seconds of a
   publish. Empty = everything below falls back to the legacy
   raw.githubusercontent + polling behavior. ?liveBase=http://127.0.0.1:8787
   overrides for local testing against `wrangler dev`. */
const S2_LIVE_BASE = "https://search2-live.eziklapz.workers.dev"; // → the domain once /api/* is routed
const LIVE_BASE =
  new URLSearchParams(location.search).get("liveBase") || S2_LIVE_BASE;

/* "no-cache" (not "no-store") on the CDN path: raw.githubusercontent serves
   max-age=300 with a strong ETag through a Fastly edge in Cape Town, so a
   revalidation is a cheap 304 from the edge. A ?t= cache-buster would force
   a unique URL every load — a guaranteed edge miss — so never add one here.
   The live path is no-store: the Worker read is the freshness guarantee. */
async function fetchText(name) {
  if (LIVE_BASE) {
    try {
      const resp = await fetch(
        `${LIVE_BASE}/api/latest/${encodeURIComponent(name)}`,
        { cache: "no-store" });
      if (resp.ok) return resp.text();
    } catch (e) { /* live layer unreachable — the CDN copy still exists */ }
  }
  const resp = await fetch(`${DATA_BASE}/${name}`, { cache: "no-cache" });
  if (!resp.ok) throw new Error(`${name}: HTTP ${resp.status}`);
  return resp.text();
}

async function fetchJson(name) {
  return JSON.parse(await fetchText(name));
}

/* Live socket: onDirty(name) fires when the pipeline publishes fresh data.
   Reconnects with capped jittered backoff; a 25s "ping" keeps NAT paths
   open (auto-answered server-side without waking the hub). No-op when the
   live layer is off, so pages can call this unconditionally. */
function liveConnect(onDirty) {
  if (!LIVE_BASE || typeof WebSocket === "undefined") return;
  let delay = 1000;
  const connect = () => {
    let pingTimer = null;
    const ws = new WebSocket(LIVE_BASE.replace(/^http/, "ws") + "/api/live");
    ws.addEventListener("open", () => {
      delay = 1000;
      pingTimer = setInterval(() => {
        try { ws.send("ping"); } catch (e) { /* mid-close race */ }
      }, 25_000);
    });
    ws.addEventListener("message", (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { return; } // "pong"
      if (msg.type === "data") onDirty(msg.name);
    });
    ws.addEventListener("close", () => {
      clearInterval(pingTimer);
      setTimeout(connect, delay + Math.random() * 1000);
      delay = Math.min(delay * 2, 60_000);
    });
    ws.addEventListener("error", () => { try { ws.close(); } catch (e) {} });
  };
  connect();
}

/* Stale-while-revalidate: paint instantly from the last-seen copy in
   localStorage (first call per page load only), then fetch fresh and hand it
   to onData again. onData(data, fromCache) must tolerate being called twice
   and decide for itself whether a repaint is needed. localStorage failures
   (private browsing, quota) degrade to plain network fetch. */
const _swrPainted = new Set();

async function fetchJsonCached(name, onData) {
  const cacheKey = `s2cache:${name}`;
  if (!_swrPainted.has(name)) {
    _swrPainted.add(name);
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) onData(JSON.parse(cached), true);
    } catch (e) { /* corrupt cache or storage unavailable — skip the fast paint */ }
  }
  const body = await fetchText(name);
  try { localStorage.setItem(cacheKey, body); } catch (e) { /* storage full/blocked */ }
  onData(JSON.parse(body), false);
}

/* ---- passphrase-protected payloads (user.enc + admin.enc) ----
   Envelope produced by funnel/publisher.py: PBKDF2-HMAC-SHA256 key
   derivation + AES-256-GCM. A wrong passphrase fails GCM auth with an
   OperationError. Both pages share the same passphrase (and the same
   remembered value). */

const PASS_KEY = "s2pass";

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

function fmtR(value) {
  if (value === null || value === undefined || value === "") return "—";
  return "R " + Number(value).toLocaleString("en-ZA", { maximumFractionDigits: 2 });
}

function fmtNum(value) {
  if (value === null || value === undefined || value === "") return "—";
  return Number(value).toLocaleString("en-ZA");
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-ZA",
    { day: "numeric", month: "short" });
}

function fmtAgo(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms)) return "—";
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  if (min < 48 * 60) return `${Math.floor(min / 60)}h ${min % 60}m ago`;
  return `${Math.floor(min / 1440)}d ago`;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/* ---- Command bus ----
   Live mode (LIVE_BASE set): the doc lives in the Worker's Durable Object;
   reads/writes are token-gated (ADMIN_TOKEN) with a version-CAS, and the
   pipeline long-polls it — commands land in seconds. Legacy mode:
   commands.json on the data branch, edited through the GitHub contents API
   with a fine-grained PAT. Either secret occupies the same stored slot —
   at cutover the user just pastes the admin token into the same prompt. */

const GH = { owner: "eziklaps", repo: "eziklapz.github.io", branch: "data" };
const GH_COMMANDS_PATH = "Search2/data/commands.json";
const PAT_KEY = "s2pat";

/* Prompt copy for whichever secret the current mode needs. */
function tokenPromptCopy() {
  return LIVE_BASE
    ? { title: "needs the dashboard admin token",
        hint: "Paste the live layer's ADMIN_TOKEN (set via wrangler secret). " +
              "Stored in this browser only." }
    : { title: "needs the GitHub token",
        hint: "Paste the fine-grained token (contents read/write on the " +
              "site repo only). Stored in this browser only." };
}

/* The live store starts empty; the first mutation builds the doc from the
   same skeleton scripts/bootstrap_data_branch.py seeds. */
function emptyCommandsDoc() {
  return { version: 1, updated_at: null,
           run: { desired: "running", start_requested_at: null,
                  budget_minutes: null },
           lanes: {}, orders: [] };
}

function liveHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem(PAT_KEY)}` };
}

async function liveGetCommands() {
  const resp = await fetch(`${LIVE_BASE}/api/commands`,
                           { headers: liveHeaders(), cache: "no-store" });
  if (!resp.ok) throw new Error(`commands GET ${resp.status}`);
  const body = await resp.json();
  return { doc: body.doc || emptyCommandsDoc(), version: body.version || 0 };
}

async function livePutCommands(doc, baseVersion) {
  const resp = await fetch(`${LIVE_BASE}/api/commands`, {
    method: "PUT",
    headers: { ...liveHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ doc, baseVersion }),
  });
  if (!resp.ok) throw new Error(`commands PUT ${resp.status}`);
}

function ghHeaders() {
  return {
    Authorization: `Bearer ${localStorage.getItem(PAT_KEY)}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function ghGetCommands() {
  const resp = await fetch(
    `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${GH_COMMANDS_PATH}?ref=${GH.branch}`,
    { headers: ghHeaders(), cache: "no-store" });
  if (!resp.ok) throw new Error(`GitHub GET ${resp.status}`);
  const meta = await resp.json();
  const text = new TextDecoder().decode(
    Uint8Array.from(atob(meta.content.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
  return { doc: JSON.parse(text), sha: meta.sha };
}

async function ghPutCommands(doc, sha, message) {
  const body = JSON.stringify(doc, null, 1);
  const content = btoa(String.fromCharCode(...new TextEncoder().encode(body)));
  const resp = await fetch(
    `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${GH_COMMANDS_PATH}`,
    { method: "PUT", headers: ghHeaders(),
      body: JSON.stringify({ message, content, sha, branch: GH.branch }) });
  if (!resp.ok) throw new Error(`GitHub PUT ${resp.status}`);
}

/* Read-modify-write with one retry on a CAS conflict (409, or GitHub's
   422 sha race in legacy mode). Callers' 401/403 token-reset checks work
   in both modes — the thrown messages carry the status code either way. */
async function mutateCommands(mutate, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (LIVE_BASE) {
      const { doc, version } = await liveGetCommands();
      mutate(doc);
      doc.updated_at = new Date().toISOString();
      try {
        await livePutCommands(doc, version);
        return doc;
      } catch (e) {
        if (attempt === 1 || !/409/.test(e.message)) throw e;
      }
    } else {
      const { doc, sha } = await ghGetCommands();
      mutate(doc);
      doc.updated_at = new Date().toISOString();
      try {
        await ghPutCommands(doc, sha, message);
        return doc;
      } catch (e) {
        if (attempt === 1 || !/409|422/.test(e.message)) throw e;
      }
    }
  }
}

/* Staleness banner: warn when the published snapshot is old. */
function updateStaleness(bannerEl, generatedAt, warnMinutes = 20) {
  const ageMin = (Date.now() - new Date(generatedAt).getTime()) / 60000;
  if (ageMin > warnMinutes) {
    bannerEl.textContent =
      `⚠ Data last published ${fmtAgo(generatedAt)} — the pipeline may not be running.`;
    bannerEl.classList.add("show");
  } else {
    bannerEl.classList.remove("show");
  }
}
