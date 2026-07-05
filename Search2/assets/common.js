/* Shared helpers for the Search2 dashboard pages.
   Data lives on the site repo's orphan 'data' branch, served CORS-open by
   raw.githubusercontent.com. ?dataBase=http://localhost:8000 overrides for
   local testing against a static file server. */

const DATA_BASE =
  new URLSearchParams(location.search).get("dataBase") ||
  "https://raw.githubusercontent.com/eziklaps/eziklapz.github.io/data/Search2/data";

async function fetchJson(name) {
  const resp = await fetch(`${DATA_BASE}/${name}?t=${Date.now()}`, { cache: "no-store" });
  if (!resp.ok) throw new Error(`${name}: HTTP ${resp.status}`);
  return resp.json();
}

function fmtR(value) {
  if (value === null || value === undefined || value === "") return "—";
  return "R " + Number(value).toLocaleString("en-ZA", { maximumFractionDigits: 2 });
}

function fmtNum(value) {
  if (value === null || value === undefined || value === "") return "—";
  return Number(value).toLocaleString("en-ZA");
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

/* ---- GitHub command bus (admin page only) ----
   commands.json lives on the data branch; the admin page edits it through
   the contents API with a fine-grained PAT (contents R/W on the site repo
   only) the user pastes once. The pipeline polls the file and obeys. */

const GH = { owner: "eziklaps", repo: "eziklapz.github.io", branch: "data" };
const GH_COMMANDS_PATH = "Search2/data/commands.json";
const PAT_KEY = "s2pat";

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

/* Read-modify-write with one retry on a sha conflict (409/422). */
async function mutateCommands(mutate, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
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
