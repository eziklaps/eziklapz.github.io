/* app.js — UI wiring for the GRIB asset register mockup. */

import {
  CATEGORIES, CAT_BY_ID, GROUP_LABELS, GROUP_INDEX, GROUP_DEPRECIATION,
  BASES, WEALTH_CATEGORY_IDS, SMALL_ITEM_THRESHOLD,
  categoriesByGroup, defaultBasisFor,
} from './bgr7.js';
import {
  money, costBase, writeOffPeriod, depreciate, schedule, replacementValue,
  assetView, portfolio, averageClause,
} from './calc.js';
import * as store from './store.js';

/* ---------------- state ---------------- */

const state = {
  tab: 'register',
  clientId: null,
  client: null,
  assets: [],
  search: '',
  loss: 250000,
  editing: null,        // asset id or null
  editPhotos: [],       // photo records for the open drawer
  capturedBy: null,
  quick: [],            // free-tab items
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const todayISO = () => new Date().toISOString().slice(0, 10);

function pct(n, dp = 0) { return `${(n).toFixed(dp)}%`; }

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ---------------- category selects ---------------- */

function fillCategorySelect(sel, onlyIds = null) {
  sel.innerHTML = '';
  const groups = categoriesByGroup();
  for (const [key, cats] of groups) {
    const list = onlyIds ? cats.filter((c) => onlyIds.includes(c.id)) : cats;
    if (!list.length) continue;
    const og = document.createElement('optgroup');
    og.label = GROUP_LABELS[key];
    for (const c of list) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = `${c.label} — ${c.years} yr`;
      og.append(o);
    }
    sel.append(og);
  }
}

/* ---------------- boot ---------------- */

async function boot() {
  const clients = await store.seedIfEmpty();
  state.clientId = clients[0].id;

  fillCategorySelect($('#fCat'));
  fillCategorySelect($('#qaCat'));
  $('#fBasis').innerHTML = Object.entries(BASES)
    .map(([k, b]) => `<option value="${k}">${esc(b.label)}</option>`).join('');
  $('#qaDate').value = todayISO();
  $('#lossRange').value = String(state.loss);

  buildRateInputs();
  wireEvents();
  await loadClient();
  renderTabs();
}

async function loadClient() {
  state.client = await store.getClient(state.clientId);
  state.assets = await store.listAssets(state.clientId);
  await renderClientSelect();
  renderAll();
}

async function renderClientSelect() {
  const clients = await store.listClients();
  for (const sel of [$('#clientSelect'), $('#onBehalfClient')]) {
    sel.innerHTML = clients.map((c) =>
      `<option value="${esc(c.id)}"${c.id === state.clientId ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  }
}

/* ---------------- render: dispatch ---------------- */

function renderAll() {
  renderRegister();
  renderBroker();
  renderValuables();
}

function renderTabs() {
  for (const btn of $$('.tab')) {
    const on = btn.dataset.tab === state.tab;
    btn.setAttribute('aria-selected', String(on));
  }
  for (const v of $$('.view')) v.hidden = v.dataset.view !== state.tab;
}

/* ================================================================= */
/* TAB 1 — MY REGISTER                                               */
/* ================================================================= */

/* The stat strip. Split out of renderRegister because the policy-sum field
 * edits one of these figures live, and re-running the whole register (asset
 * table + photo hydration) on every keystroke to refresh one number is waste. */
function renderStrip(c, p) {
  /* The number that actually decides a claim: what the schedule says against
   * what it costs to replace. Book-vs-replacement is the story; this is the
   * diagnostic, so it leads. Agreed-value items sit outside the average
   * clause, so this runs against the averaged pool only. */
  const adq = averageClause(c.policySumInsured, p.averaged, 0);
  const onPolicy = Number(c.policySumInsured) > 0;

  const stats = [
    onPolicy
      ? { lab: 'Policy vs replacement', val: pct(adq.adequacy * 100, 0),
          sub: `${money(c.policySumInsured)} against ${money(p.averaged)}`,
          cls: adq.adequacy < 0.75 ? 'crit' : (adq.isUnder || adq.isOver) ? 'warn' : 'ok' }
      : { lab: 'Policy vs replacement', val: '—',
          sub: 'Add your sum insured below', cls: 'warn' },
    { lab: 'Total paid', val: money(p.cost), sub: 'Historic cost, VAT included', cls: '' },
    { lab: "This year's write-off", val: money(p.allowance),
      sub: c.taxRate ? `Worth ${money(p.taxValue)} at ${Math.round(c.taxRate * 100)}%` : 'Deduction claimable', cls: 'accent' },
    { lab: 'Photographed', val: pct(p.completeness), sub: `${p.missingPhoto} still need a photo`,
      cls: p.completeness === 100 ? 'ok' : p.missingPhoto > p.count / 2 ? 'crit' : 'warn' },
    { lab: 'Serials captured', val: `${p.count - p.missingSerial}/${p.count}`,
      sub: p.missingSerial ? `${p.missingSerial} missing` : 'Complete',
      cls: p.missingSerial ? 'warn' : 'ok' },
  ];
  if (p.needsValuation) {
    stats.push({ lab: 'Valuations needed', val: String(p.needsValuation),
      sub: 'Jewellery, watches, art', cls: 'warn' });
  }
  $('#statStrip').innerHTML = stats.map((s) => `
    <div class="stat ${s.cls}">
      <p class="stat-lab">${esc(s.lab)}</p>
      <p class="stat-val">${esc(s.val)}</p>
      <p class="stat-sub">${esc(s.sub)}</p>
    </div>`).join('');
}

function renderRegister() {
  const c = state.client;
  if (!c) return;
  const p = portfolio(state.assets, c);

  $('#regTitle').textContent = c.name;
  $('#regSub').textContent =
    `${p.count} asset${p.count === 1 ? '' : 's'} · ${c.sector || '—'}${c.town ? ' · ' + c.town : ''}`;

  $('#sumBook').textContent = money(p.book);
  $('#sumInsured').textContent = money(p.replacement);
  $('#sumBookFoot').textContent =
    `SARS s11(e) book value. ${p.fullyWritten} of ${p.count} already fully written off.`;
  $('#sumInsuredFoot').textContent = c.sumInsuredExVat
    ? 'Cost to replace today, excluding VAT.'
    : 'Cost to replace today, VAT included.';

  renderStrip(c, p);

  /* average clause */
  $('#policySum').value = c.policySumInsured || 0;
  renderAverage(p);

  /* table */
  const q = state.search.trim().toLowerCase();
  const rows = state.assets.filter((a) => !q ||
    [a.name, a.serial, a.room, CAT_BY_ID[a.categoryId]?.label]
      .some((f) => String(f ?? '').toLowerCase().includes(q)));

  $('#regEmpty').hidden = rows.length > 0;
  $('#regBody').innerHTML = rows.map((a) => {
    const v = assetView(a, c);
    const cat = CAT_BY_ID[a.categoryId];
    const tags = [];
    if (v.dep.periodSource === 'small-item') tags.push('<span class="tag small">1 yr · small item</span>');
    if (v.dep.fullyWritten) tags.push('<span class="tag done">written off</span>');
    if (v.rep.needsValuation && !v.rep.hasValuation) tags.push('<span class="tag cert">no certificate</span>');
    if (v.rep.basis !== 'replacement') tags.push(`<span class="tag basis">${esc(v.rep.basisShort)}</span>`);
    if (v.rep.certStale) tags.push('<span class="tag cert">certificate over 3 yrs old</span>');
    return `
      <tr data-id="${esc(a.id)}">
        <td>
          <div class="rowlead">
            ${a.photoCount
              ? `<span class="thumb nothumb" data-photo="${esc(a.id)}">▣</span>`
              : '<span class="thumb nothumb" title="No photograph">○</span>'}
            <span class="aname">
              <b>${esc(a.name)}</b>
              <i>${esc(a.serial || 'no serial')}${a.room ? ' · ' + esc(a.room) : ''}</i>
              ${tags.length ? `<span class="vcard-tags">${tags.join('')}</span>` : ''}
            </span>
          </div>
        </td>
        <td>${esc(cat ? cat.label : '—')}</td>
        <td class="num">${money(v.cost.gross)}</td>
        <td class="num">${v.dep.years} yr</td>
        <td class="num v-book">${money(v.dep.book)}</td>
        <td class="num v-ins">${money(v.rep.value)}</td>
        <td class="num v-spread">${money(v.spread)}</td>
        <td class="chev" aria-hidden="true">›</td>
      </tr>`;
  }).join('');

  hydrateThumbs();
}

async function hydrateThumbs() {
  for (const el of $$('[data-photo]')) {
    const shots = await store.listPhotos(el.dataset.photo);
    if (!shots.length) continue;
    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';
    img.src = store.photoUrl(shots[0]);
    el.replaceWith(img);
  }
}

function renderAverage(p) {
  const c = state.client;
  /* Agreed-value items are separately scheduled and are not averaged, so the
   * adequacy test runs against the averaged pool only. */
  const a = averageClause(c.policySumInsured, p.averaged, state.loss);

  $('#lossOut').textContent = money(state.loss);

  const cls = !a.isUnder ? 'ok' : a.underPct > 25 ? 'crit' : 'warn';
  const pill = $('#avgPill');
  pill.className = `pill ${cls}`;
  pill.textContent = a.isOver
    ? `Over-insured by ${pct(a.adequacy * 100 - 100, 0)}`
    : !a.isUnder ? 'Adequately insured'
    : `Underinsured by ${pct(a.underPct, 0)}`;

  const paidPct = Math.round(a.applied * 100);
  $('#avgOut').innerHTML = `
    <div class="avg-bar">
      <div class="avg-track">
        <div class="avg-paid" style="width:${paidPct}%">${paidPct >= 18 ? `<span>Paid ${money(a.payout)}</span>` : ''}</div>
        ${a.shortfall > 0 ? `<div class="avg-short" style="width:${100 - paidPct}%">${100 - paidPct >= 18 ? `<span>You carry ${money(a.shortfall)}</span>` : ''}</div>` : ''}
      </div>
    </div>
    ${p.agreed > 0 ? `<p class="avg-split">${money(p.agreed)} of this register is on <b>agreed value</b> and is scheduled separately, so it is not averaged. The test below runs against the remaining <b>${money(p.averaged)}</b>.</p>` : ''}
    <div class="avg-lines">
      <div class="avg-line"><span>Register says you should be insured for</span><b>${money(p.averaged)}</b></div>
      <div class="avg-line"><span>Your policy says</span><b>${money(c.policySumInsured)}</b></div>
      <div class="avg-line"><span>So the average clause applies at</span><b>${pct(a.applied * 100, 1)}</b></div>
      <div class="avg-line big"><span>On a ${money(a.loss)} partial loss you'd receive</span><b>${money(a.payout)}</b></div>
    </div>
    <p class="avg-say">${
      a.isUnder
        ? `You are <b>${pct(a.underPct, 1)} underinsured</b>. On a partial loss the insurer pays ${pct(a.applied * 100, 1)} of it, so a ${money(a.loss)} claim leaves you carrying <b>${money(a.shortfall)}</b> yourself. On a total loss the payout caps at the sum insured instead — <b>${money(a.totalLossPayout)}</b> against ${money(p.replacement)} of assets, a <b>${money(a.totalLossShortfall)}</b> shortfall.`
        : a.isOver
        ? `You're insured for more than the register supports. You aren't buying extra cover — the insurer still only pays what it costs to replace — so there may be <b>${money(c.policySumInsured - p.replacement)}</b> of premium here worth reviewing.`
        : `Your sum insured matches the register. Keep it that way by updating this before each renewal — replacement values move every year even when nothing is bought.`
    }</p>`;
}

/* ================================================================= */
/* TAB 2 — BROKER CONSOLE                                            */
/* ================================================================= */

async function renderBroker() {
  const clients = await store.listClients();
  const rows = [];
  let totBook = 0, totRepl = 0, totPolicy = 0, chases = 0;

  for (const c of clients) {
    const assets = await store.listAssets(c.id);
    const p = portfolio(assets, c);
    const a = averageClause(c.policySumInsured, p.replacement, 0);
    totBook += p.book; totRepl += p.replacement; totPolicy += c.policySumInsured || 0;

    const chase = [];
    if (p.missingPhoto) chase.push(`${p.missingPhoto} photo${p.missingPhoto === 1 ? '' : 's'} missing`);
    if (p.missingSerial) chase.push(`${p.missingSerial} serial${p.missingSerial === 1 ? '' : 's'} missing`);
    if (p.needsValuation) chase.push(`${p.needsValuation} valuation${p.needsValuation === 1 ? '' : 's'} outstanding`);
    if (chase.length) chases++;

    const cls = !a.isUnder ? 'ok' : a.underPct > 25 ? 'crit' : 'warn';
    rows.push(`
      <tr data-client="${esc(c.id)}">
        <td><span class="aname"><b>${esc(c.name)}</b><i>${esc(c.contact || '')}${c.town ? ' · ' + esc(c.town) : ''}</i></span></td>
        <td>${esc(c.sector || '—')}</td>
        <td class="num">${p.count}</td>
        <td class="num v-book">${money(p.book)}</td>
        <td class="num v-ins">${money(p.replacement)}</td>
        <td class="num">${money(c.policySumInsured)}</td>
        <td>
          <div class="meter">
            <div class="meter-track"><div class="meter-fill ${cls}" style="width:${Math.min(100, Math.round(a.applied * 100))}%"></div></div>
            <span class="meter-pct">${pct(a.adequacy * 100, 0)}</span>
          </div>
        </td>
        <td>${chase.length ? `<span class="tag cert">${esc(chase.join(', '))}</span>` : '<span class="tag done">clear</span>'}</td>
        <td class="chev" aria-hidden="true">›</td>
      </tr>`);
  }

  $('#brokerBody').innerHTML = rows.join('');

  const groupAdequacy = totRepl > 0 ? totPolicy / totRepl : 1;
  $('#brokerStrip').innerHTML = [
    { lab: 'Registers', val: String(clients.length), sub: 'On the book', cls: '' },
    { lab: 'Replacement value held', val: money(totRepl), sub: 'Across all registers', cls: 'accent' },
    { lab: 'On policy', val: money(totPolicy), sub: `${pct(groupAdequacy * 100, 0)} of replacement`,
      cls: groupAdequacy < 0.75 ? 'crit' : groupAdequacy < 0.98 ? 'warn' : 'ok' },
    { lab: 'Book value', val: money(totBook), sub: 'What the accountants carry', cls: '' },
    { lab: 'Need chasing', val: String(chases), sub: 'Items still outstanding', cls: chases ? 'warn' : 'ok' },
  ].map((s) => `
    <div class="stat ${s.cls}">
      <p class="stat-lab">${esc(s.lab)}</p>
      <p class="stat-val">${esc(s.val)}</p>
      <p class="stat-sub">${esc(s.sub)}</p>
    </div>`).join('');
}

/* ================================================================= */
/* TAB 3 — VALUABLES                                                 */
/* ================================================================= */

function renderValuables() {
  const c = state.client;
  if (!c) return;
  const items = state.assets.filter((a) => WEALTH_CATEGORY_IDS.includes(a.categoryId));

  $('#valEmpty').hidden = items.length > 0;

  const views = items.map((a) => assetView(a, c));
  const totalIns = views.reduce((s, v) => s + v.rep.value, 0);
  const noCert = views.filter((v) => v.rep.needsValuation && !v.rep.hasValuation);
  const noPhoto = items.filter((a) => !a.photoCount).length;

  $('#valStrip').innerHTML = [
    { lab: 'Items specified', val: String(items.length), sub: 'On the all-risk section', cls: '' },
    { lab: 'Total sum insured', val: money(totalIns), sub: 'Sum of the items below', cls: 'accent' },
    { lab: 'Certificates outstanding', val: String(noCert.length),
      sub: noCert.length ? 'Claim risk' : 'All lodged', cls: noCert.length ? 'warn' : 'ok' },
    { lab: 'Unphotographed', val: String(noPhoto), sub: noPhoto ? 'Add a photo' : 'All photographed',
      cls: noPhoto ? 'warn' : 'ok' },
  ].map((s) => `
    <div class="stat ${s.cls}">
      <p class="stat-lab">${esc(s.lab)}</p>
      <p class="stat-val">${esc(s.val)}</p>
      <p class="stat-sub">${esc(s.sub)}</p>
    </div>`).join('');

  $('#valWarn').hidden = noCert.length === 0;
  $('#certList').innerHTML = noCert.map((v) => `
    <li><span>${esc(v.asset.name)} <span class="vcard-meta">${esc(CAT_BY_ID[v.asset.categoryId]?.label || '')}</span></span>
        <b>${money(v.rep.value)}</b></li>`).join('');

  $('#valCards').innerHTML = views.map((v) => {
    const a = v.asset;
    const needs = v.rep.needsValuation && !v.rep.hasValuation;
    return `
      <button type="button" class="vcard ${needs ? 'needscert' : ''}" data-id="${esc(a.id)}">
        <span class="vcard-img" data-vphoto="${esc(a.id)}"><span class="ph" aria-hidden="true">▣</span></span>
        <span class="vcard-body">
          <h3>${esc(a.name)}</h3>
          <span class="vcard-meta">${esc(a.serial || 'no serial')}${a.room ? ' · ' + esc(a.room) : ''}</span>
          <span class="vcard-tags">
            <span class="tag">${esc(CAT_BY_ID[a.categoryId]?.label || '')}</span>
            ${needs ? '<span class="tag cert">valuation needed</span>'
                    : v.rep.hasValuation ? '<span class="tag done">certificate lodged</span>' : ''}
          </span>
          <span class="vcard-nums">
            <span><span>Paid</span><b class="v-book">${money(v.cost.gross)}</b></span>
            <span class="right"><span>Insure for</span><b class="v-ins">${money(v.rep.value)}</b></span>
          </span>
        </span>
      </button>`;
  }).join('');

  hydrateVCards();
}

async function hydrateVCards() {
  for (const el of $$('[data-vphoto]')) {
    const shots = await store.listPhotos(el.dataset.vphoto);
    if (!shots.length) continue;
    const img = document.createElement('img');
    img.alt = '';
    img.src = store.photoUrl(shots[0]);
    el.innerHTML = '';
    el.append(img);
  }
}

/* ================================================================= */
/* TAB 4 — FREE REGISTER                                             */
/* ================================================================= */

const FREE_PROFILE = { vatVendor: true, sumInsuredExVat: false, method: 'sl', taxRate: 0.27 };

function renderFree() {
  const list = $('#qaList');
  list.innerHTML = state.quick.map((a, i) => {
    const v = assetView(a, FREE_PROFILE);
    return `<li>
      <span class="qn">${esc(a.name)}</span>
      <span class="qc">${esc(CAT_BY_ID[a.categoryId]?.label || '')} · ${v.dep.years} yr</span>
      <span class="qv">${money(v.cost.gross)}</span>
      <button type="button" class="linkbtn" data-action="qa-del" data-i="${i}">remove</button>
    </li>`;
  }).join('');

  const has = state.quick.length > 0;
  $('#freeResult').hidden = !has;
  if (!has) return;

  const p = portfolio(state.quick, FREE_PROFILE);
  $('#freeBook').textContent = money(p.book);
  $('#freeInsured').textContent = money(p.replacement);
  const many = p.count !== 1;
  $('#freeSay').innerHTML =
    `You paid <b>${money(p.cost)}</b> for ${many ? `these ${p.count} items` : 'this item'}. ` +
    `Your books now carry ${many ? 'them' : 'it'} at <b>${money(p.book)}</b>, and SARS lets you deduct ` +
    `<b>${money(p.allowance)}</b> this year — worth about <b>${money(p.taxValue)}</b> in tax at 27%. ` +
    `But replacing them today costs <b>${money(p.replacement)}</b>. ` +
    `If your policy still carries the ${money(p.cost)} you paid, you're ` +
    `<b>${pct(Math.max(0, (1 - p.cost / p.replacement) * 100), 1)} short</b> before you've added anything else.`;
}

/* ================================================================= */
/* DRAWER — add / edit an asset                                      */
/* ================================================================= */

function openDrawer(assetId = null, forceWealth = false) {
  state.editing = assetId;
  state.editPhotos = [];
  const f = $('#assetForm');
  f.reset();

  fillCategorySelect($('#fCat'), forceWealth ? WEALTH_CATEGORY_IDS : null);

  if (assetId) {
    const a = state.assets.find((x) => x.id === assetId);
    if (!a) return;
    $('#drawerKind').textContent = CAT_BY_ID[a.categoryId]?.label || 'Asset';
    $('#drawerTitle').textContent = a.name;
    $('#fId').value = a.id;
    $('#fName').value = a.name || '';
    $('#fCat').value = a.categoryId || '';
    $('#fRoom').value = a.room || '';
    $('#fSerial').value = a.serial || '';
    $('#fList').value = a.listPrice || '';
    $('#fPaid').value = a.pricePaid || '';
    $('#fDate').value = (a.purchaseDate || '').slice(0, 10);
    $('#fMethod').value = a.method || '';
    $('#fInclVat').checked = a.priceInclVat !== false;
    $('#fSet').checked = Boolean(a.partOfSet);
    $('#fYears').value = a.yearsOverride || '';
    $('#fBasis').value = a.basis || defaultBasisFor(a.categoryId);
    $('#fAgreed').value = a.agreedValue || '';
    $('#fValDate').value = (a.valuationDate || '').slice(0, 10);
    $('#fRepl').value = a.replacementOverride || '';
    $('#fIndex').value = a.indexOverride != null ? (a.indexOverride * 100).toFixed(1) : '';
    $('#fDep').value = a.depreciationOverride != null ? (a.depreciationOverride * 100).toFixed(0) : '';
    $('#fCert').value = a.valuationCert || '';
    $('#delBtn').hidden = false;
    $('#saveBtn').textContent = 'Save changes';
    loadShots(a.id);
  } else {
    $('#drawerKind').textContent = 'New asset';
    $('#drawerTitle').textContent = forceWealth ? 'Add a valuable' : 'Add an asset';
    $('#fDate').value = todayISO();
    $('#fInclVat').checked = true;
    $('#fBasis').value = defaultBasisFor($('#fCat').value);
    $('#delBtn').hidden = true;
    $('#saveBtn').textContent = 'Save asset';
    $('#shots').innerHTML = '';
  }

  $('#formErr').hidden = true;
  $('#scrim').hidden = false;
  $('#drawer').hidden = false;
  document.body.style.overflow = 'hidden';
  renderLive();
  setTimeout(() => $('#fName').focus(), 60);
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#scrim').hidden = true;
  document.body.style.overflow = '';
  state.editing = null;
  state.editPhotos = [];
}

async function loadShots(assetId) {
  state.editPhotos = await store.listPhotos(assetId);
  renderShots();
}

function renderShots() {
  $('#shots').innerHTML = state.editPhotos.map((p) => `
    <div class="shot">
      <img src="${store.photoUrl(p)}" alt="">
      <button type="button" data-action="rm-photo" data-id="${esc(p.id)}" aria-label="Remove photograph">&times;</button>
    </div>`).join('');
}

/** Draft asset built from the live form, for the reveal panel. */
function draftFromForm() {
  return {
    name: $('#fName').value.trim(),
    categoryId: $('#fCat').value,
    room: $('#fRoom').value.trim(),
    serial: $('#fSerial').value.trim(),
    listPrice: Number($('#fList').value) || 0,
    pricePaid: Number($('#fPaid').value) || 0,
    purchaseDate: $('#fDate').value,
    method: $('#fMethod').value || '',
    priceInclVat: $('#fInclVat').checked,
    partOfSet: $('#fSet').checked,
    yearsOverride: Number($('#fYears').value) || 0,
    basis: $('#fBasis').value || undefined,
    agreedValue: Number($('#fAgreed').value) || 0,
    valuationDate: $('#fValDate').value || '',
    replacementOverride: Number($('#fRepl').value) || 0,
    indexOverride: $('#fIndex').value === '' ? null : Number($('#fIndex').value) / 100,
    depreciationOverride: $('#fDep').value === '' ? null : Number($('#fDep').value) / 100,
    valuationCert: $('#fCert').value.trim(),
  };
}

function renderBasisControls(d) {
  const basis = d.basis || defaultBasisFor(d.categoryId);
  $('#basisBlurb').textContent = BASES[basis] ? BASES[basis].blurb : '';
  $('#agreedRow').hidden = basis !== 'agreed';
  $('#manualRow').hidden = basis !== 'manual';

  const box = $('#basisCompare');
  if (!d.pricePaid || !d.purchaseDate || !d.categoryId) { box.innerHTML = ''; return; }

  const profile = state.client || FREE_PROFILE;
  const opts = ['replacement', 'indemnity', 'agreed', 'manual'].map((b) => {
    const r = replacementValue({ ...d, basis: b }, profile);
    return { key: b, label: BASES[b].label, value: r.value, incomplete: r.incomplete };
  });

  box.innerHTML = `
    <p class="comparelab">What each basis would put on the schedule</p>
    <div class="comparerow">
      ${opts.map((o) => `
        <button type="button" class="compareopt ${o.key === basis ? 'on' : ''}" data-basis="${o.key}">
          <span>${esc(o.label)}</span>
          <b>${o.incomplete ? 'not set' : money(o.value)}</b>
        </button>`).join('')}
    </div>`;
}

function renderLive() {
  const d = draftFromForm();
  const out = $('#liveOut');
  renderBasisControls(d);

  /* discount note */
  const cb = costBase(d, state.client || FREE_PROFILE);
  const dn = $('#discountNote');
  if (cb.discount > 0) {
    dn.hidden = false;
    dn.innerHTML = `You saved <b>${money(cb.discount)}</b> (${pct(cb.discountPct, 1)}). ` +
      `That lowers your SARS write-off base to <b>${money(cb.base)}</b> — but the insurance value still ` +
      `tracks the ${money(cb.listGross)} retail price, because that's what a replacement costs.`;
  } else {
    dn.hidden = true;
  }

  if (!d.pricePaid || !d.purchaseDate || !d.categoryId) { out.hidden = true; return; }
  out.hidden = false;

  const profile = state.client || FREE_PROFILE;
  const dep = depreciate(d, profile);
  const rep = replacementValue(d, profile);
  const rows = schedule(d, profile, 2);
  const cat = CAT_BY_ID[d.categoryId];

  out.innerHTML = `
    <div class="lo-head">Both numbers, as at today</div>
    <div class="lo-pair">
      <div class="lo-cell b">
        <span>Book value</span>
        <b>${money(dep.book)}</b>
        <em>${dep.fullyWritten ? 'Fully written off' : `${money(dep.accumulated)} claimed so far`}</em>
      </div>
      <div class="lo-cell i">
        <span>Insure it for</span>
        <b>${money(rep.value)}</b>
        <em>${esc(rep.basisLabel.toLowerCase())}</em>
      </div>
    </div>
    ${chartSvg(rows)}
    <div class="lo-why">
      <div><span>Write-off base ${profile.vatVendor ? '(excl. VAT)' : '(incl. VAT)'}</span><b>${money(cb.base)}</b></div>
      <div><span>Period</span><b>${dep.years} year${dep.years === 1 ? '' : 's'} · ${dep.method === 'dv' ? 'diminishing value' : 'straight line'}</b></div>
      <div><span>Deduction in the next 12 months</span><b>${money(dep.currentYearAllowance)}</b></div>
      ${profile.taxRate ? `<div><span>Worth in tax at ${Math.round(profile.taxRate * 100)}%</span><b>${money(dep.taxValueOfAllowance)}</b></div>` : ''}
      <div><span>New-for-old today</span><b>${money(rep.replacementNew)}</b></div>
      ${rep.basis !== 'replacement' ? `<div><span>This basis vs new-for-old</span><b>${rep.vsReplacement >= 0 ? '+' : ''}${money(rep.vsReplacement)}</b></div>` : ''}
      ${rep.basis === 'indemnity' ? `<div><span>Wear and tear applied</span><b>${pct((1 - rep.wearFactor) * 100, 0)} at ${pct(rep.depRate * 100, 0)} a year</b></div>` : ''}
    </div>
    <div class="lo-flag lo-basis">${esc(rep.note)}</div>
    ${!rep.averaged ? '<div class="lo-flag lo-good">Agreed value: this item sits outside the average clause. Underinsurance elsewhere on the policy cannot cut its payout.</div>' : ''}
    ${rep.certStale ? `<div class="lo-flag">The valuation is ${rep.certAgeYears.toFixed(1)} years old. Most insurers want jewellery and art revalued every three years, and will argue about anything older.</div>` : ''}
    <div class="lo-flag" style="background:var(--teal-wash);color:var(--teal-deep)">${esc(dep.periodWhy)}</div>
    ${dep.residualFlag ? `<div class="lo-flag">Diminishing value never reaches nil — ${money(dep.book)} residual remains after ${dep.years} years. SARS lets you switch to straight line to write off the rest.</div>` : ''}
    ${rep.needsValuation && !d.valuationCert ? `<div class="lo-flag">${esc(cat.label)} — your insurer will want a professional valuation certificate. Add its reference above.</div>` : ''}
    ${cat && cat.note ? `<div class="lo-flag">${esc(cat.note)}</div>` : ''}`;
}

/** Small two-line chart of the divergence, drawn from the real schedule. */
function chartSvg(rows) {
  if (rows.length < 2) return '';
  const W = 480, H = 132, L = 8, R = 8, T = 12, B = 20;
  const max = Math.max(...rows.map((r) => Math.max(r.book, r.replacement))) * 1.08 || 1;
  const x = (i) => L + (i * (W - L - R)) / (rows.length - 1);
  const y = (v) => T + (1 - v / max) * (H - T - B);

  const book = rows.map((r, i) => `${x(i).toFixed(1)},${y(r.book).toFixed(1)}`).join(' ');
  const repl = rows.map((r, i) => `${x(i).toFixed(1)},${y(r.replacement).toFixed(1)}`).join(' ');
  const area = `${repl} ${rows.map((r, i) => `${x(rows.length - 1 - i).toFixed(1)},${y(rows[rows.length - 1 - i].book).toFixed(1)}`).join(' ')}`;
  const last = rows.length - 1;

  return `<div class="lo-chart">
    <svg viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Book value falls to zero while replacement value rises over ${last} years.">
      <polygon points="${area}" fill="var(--insured)" opacity="0.10"></polygon>
      <line x1="${L}" y1="${y(0)}" x2="${W - R}" y2="${y(0)}" stroke="var(--rule)" stroke-width="1"></line>
      <polyline points="${book}" fill="none" stroke="var(--book)" stroke-width="2" stroke-linejoin="round"></polyline>
      <polyline points="${repl}" fill="none" stroke="var(--insured)" stroke-width="2" stroke-linejoin="round"></polyline>
      <circle cx="${x(last).toFixed(1)}" cy="${y(rows[last].replacement).toFixed(1)}" r="3.2" fill="var(--insured)"></circle>
      <circle cx="${x(last).toFixed(1)}" cy="${y(rows[last].book).toFixed(1)}" r="3.2" fill="var(--book)"></circle>
      <text x="${L}" y="${H - 5}" font-size="9.5" fill="var(--ink-3)">bought</text>
      <text x="${W - R}" y="${H - 5}" font-size="9.5" fill="var(--ink-3)" text-anchor="end">year ${last}</text>
    </svg>
  </div>`;
}

async function saveAsset(e) {
  e.preventDefault();
  const d = draftFromForm();
  const err = $('#formErr');

  if (!d.name) { err.textContent = 'Give the asset a description so it can be identified on a claim.'; err.hidden = false; return; }
  if (!d.categoryId) { err.textContent = 'Choose a category — it sets the SARS write-off period.'; err.hidden = false; return; }
  if (!d.pricePaid) { err.textContent = 'Enter what you paid. Without it there is nothing to write off or insure.'; err.hidden = false; return; }
  if (!d.purchaseDate) { err.textContent = 'Enter the purchase date so the write-off can be apportioned.'; err.hidden = false; return; }
  if (new Date(d.purchaseDate) > new Date()) { err.textContent = 'The purchase date is in the future.'; err.hidden = false; return; }
  err.hidden = true;

  const existing = state.editing ? state.assets.find((a) => a.id === state.editing) : null;
  const rec = await store.putAsset({
    ...(existing || {}),
    ...d,
    id: state.editing || undefined,
    clientId: state.clientId,
    capturedBy: state.capturedBy || (existing && existing.capturedBy) || null,
    photoCount: state.editPhotos.length,
  });

  /* photos captured before the asset had an id get re-pointed at it */
  for (const p of state.editPhotos) {
    if (p.assetId !== rec.id) {
      await store.deletePhoto(p.id);
      await store.addPhoto(rec.id, p.blob);
    }
  }
  const shots = await store.listPhotos(rec.id);
  await store.putAsset({ ...rec, photoCount: shots.length });

  closeDrawer();
  state.assets = await store.listAssets(state.clientId);
  renderAll();
  toast(state.editing ? 'Asset updated.' : `${rec.name} added.`);
}

/* ================================================================= */
/* SETTINGS                                                          */
/* ================================================================= */

function buildRateInputs() {
  $('#rates').innerHTML = Object.entries(GROUP_LABELS).map(([k, label]) => `
    <div class="rate">
      <label for="rate_${k}">${esc(label)}</label>
      <input type="number" id="rate_${k}" data-rate="${k}" min="-20" max="40" step="0.5"
             value="${(GROUP_INDEX[k] * 100).toFixed(1)}">
    </div>`).join('');
  $('#depRates').innerHTML = Object.entries(GROUP_LABELS).map(([k, label]) => `
    <div class="rate">
      <label for="dep_${k}">${esc(label)}</label>
      <input type="number" id="dep_${k}" data-dep="${k}" min="0" max="60" step="1"
             value="${(GROUP_DEPRECIATION[k] * 100).toFixed(0)}">
    </div>`).join('');
}

function openSettings() {
  const c = state.client;
  $('#sName').value = c.name || '';
  $('#sSector').value = c.sector || '';
  $('#sTown').value = c.town || '';
  $('#sPolicy').value = c.policySumInsured || 0;
  $('#sVat').checked = Boolean(c.vatVendor);
  $('#sSumExVat').checked = Boolean(c.sumInsuredExVat);
  $('#sMethod').value = c.method || 'sl';
  $('#sTax').value = String(c.taxRate ?? 0.27);
  $('#scrim').hidden = false;
  $('#settings').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeSettings() {
  $('#settings').hidden = true;
  $('#scrim').hidden = true;
  document.body.style.overflow = '';
}

async function saveSettings() {
  for (const input of $$('[data-rate]')) {
    GROUP_INDEX[input.dataset.rate] = (Number(input.value) || 0) / 100;
  }
  for (const input of $$('[data-dep]')) {
    GROUP_DEPRECIATION[input.dataset.dep] = (Number(input.value) || 0) / 100;
  }
  await store.putClient({
    ...state.client,
    name: $('#sName').value.trim() || state.client.name,
    sector: $('#sSector').value.trim(),
    town: $('#sTown').value.trim(),
    policySumInsured: Number($('#sPolicy').value) || 0,
    vatVendor: $('#sVat').checked,
    sumInsuredExVat: $('#sSumExVat').checked,
    method: $('#sMethod').value,
    taxRate: Number($('#sTax').value),
  });
  closeSettings();
  await loadClient();
  toast('Assumptions applied.');
}

/* ================================================================= */
/* EXPORT                                                            */
/* ================================================================= */

function csv(rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

function download(name, text) {
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function exportAccountant() {
  const c = state.client;
  const rows = [[
    'Description', 'Category', 'Serial', 'Purchase date', 'Paid (incl VAT)',
    `Write-off base (${c.vatVendor ? 'excl' : 'incl'} VAT)`, 'Method', 'BGR 7 period (years)',
    'Allowance next 12 months', 'Accumulated allowance', 'Book value', 'Basis',
  ]];
  for (const a of state.assets) {
    const v = assetView(a, c);
    rows.push([
      a.name, CAT_BY_ID[a.categoryId]?.label || '', a.serial || '',
      (a.purchaseDate || '').slice(0, 10),
      v.cost.gross.toFixed(2), v.cost.base.toFixed(2),
      v.dep.method === 'dv' ? 'Diminishing value' : 'Straight line',
      v.dep.years, v.dep.currentYearAllowance.toFixed(2),
      v.dep.accumulated.toFixed(2), v.dep.book.toFixed(2), v.dep.periodWhy,
    ]);
  }
  const p = portfolio(state.assets, c);
  rows.push([]);
  rows.push(['TOTAL', '', '', '', p.cost.toFixed(2), p.base.toFixed(2), '', '',
    p.allowance.toFixed(2), (p.base - p.book).toFixed(2), p.book.toFixed(2), '']);
  rows.push([]);
  rows.push(['Prepared from the GRIB asset register. Estimates based on SARS Binding General Ruling 7 (Issue 4). Not a tax opinion.']);
  download(`${slug(c.name)}-accountant-${todayISO()}.csv`, csv(rows));
  toast('Accountant CSV downloaded.');
}

function exportInsurer() {
  const c = state.client;
  const rows = [[
    'Description', 'Category', 'Serial / IMEI / VIN', 'Location', 'Purchase date',
    'Sum insured', 'Basis', 'How it was arrived at', 'New-for-old today',
    'Subject to average', 'Photographs', 'Valuation certificate', 'Valued on',
  ]];
  for (const a of state.assets) {
    const v = assetView(a, c);
    rows.push([
      a.name, CAT_BY_ID[a.categoryId]?.label || '', a.serial || '', a.room || '',
      (a.purchaseDate || '').slice(0, 10),
      v.rep.value.toFixed(2),
      v.rep.basisLabel,
      v.rep.note,
      v.rep.replacementNew.toFixed(2),
      v.rep.averaged ? 'Yes' : 'No - agreed value',
      a.photoCount || 0,
      a.valuationCert || (v.rep.needsValuation ? 'OUTSTANDING' : 'n/a'),
      (a.valuationDate || '').slice(0, 10),
    ]);
  }
  const p = portfolio(state.assets, c);
  rows.push([]);
  const t = (label, val) => [label, '', '', '', '', val, '', '', '', '', '', ''];
  rows.push(t('TOTAL SUM INSURED REQUIRED', p.replacement.toFixed(2)));
  rows.push(t('  of which subject to the average clause', p.averaged.toFixed(2)));
  rows.push(t('  of which on agreed value', p.agreed.toFixed(2)));
  rows.push(t('Currently on policy', (c.policySumInsured || 0).toFixed(2)));
  const a = averageClause(c.policySumInsured, p.averaged, 0);
  rows.push(t('Adequacy against the averaged portion', `${(a.adequacy * 100).toFixed(1)}%`));
  rows.push([]);
  rows.push([`Values ${c.sumInsuredExVat ? 'exclude' : 'include'} VAT. Indications for discussion with Garden Route Insurance Brokers (FSP 15438) — not a quotation or professional valuation.`]);
  download(`${slug(c.name)}-insurer-schedule-${todayISO()}.csv`, csv(rows));
  toast('Insurer schedule downloaded.');
}

/* ================================================================= */
/* EVENTS                                                            */
/* ================================================================= */

function wireEvents() {
  /* tabs */
  for (const btn of $$('.tab')) {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      renderTabs();
      if (state.tab === 'broker') renderBroker();
      if (state.tab === 'free') renderFree();
    });
  }

  /* client switch */
  $('#clientSelect').addEventListener('change', async (e) => {
    state.clientId = e.target.value;
    state.capturedBy = null;
    $('#capturedNote').textContent = '';
    await loadClient();
  });

  /* delegated actions */
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const act = t.dataset.action;

    if (act === 'add') { e.preventDefault(); openDrawer(null, false); }
    if (act === 'add-valuable') { e.preventDefault(); openDrawer(null, true); }
    if (act === 'close-drawer') closeDrawer();
    if (act === 'settings') openSettings();
    if (act === 'close-settings') closeSettings();
    if (act === 'save-settings') saveSettings();
    if (act === 'export-menu') { $('#scrim').hidden = false; $('#exportSheet').hidden = false; }
    if (act === 'close-export') { $('#exportSheet').hidden = true; $('#scrim').hidden = true; }
    if (act === 'csv-accountant') exportAccountant();
    if (act === 'csv-insurer') exportInsurer();
    if (act === 'print') { $('#exportSheet').hidden = true; $('#scrim').hidden = true; setTimeout(() => window.print(), 120); }

    if (act === 'reset') {
      if (!confirm('Clear everything you have entered and restore the three demo registers?')) return;
      const clients = await store.resetAll();
      state.clientId = clients[0].id;
      state.quick = [];
      await loadClient();
      renderFree();
      toast('Demo data restored.');
    }

    if (act === 'rm-photo') {
      await store.deletePhoto(t.dataset.id);
      state.editPhotos = state.editPhotos.filter((p) => p.id !== t.dataset.id);
      renderShots();
    }

    if (act === 'delete-asset') {
      if (!state.editing) return;
      const a = state.assets.find((x) => x.id === state.editing);
      if (!confirm(`Remove "${a ? a.name : 'this asset'}" from the register?`)) return;
      await store.deleteAsset(state.editing);
      closeDrawer();
      state.assets = await store.listAssets(state.clientId);
      renderAll();
      toast('Asset removed.');
    }

    if (act === 'new-client') {
      const name = prompt('Client or register name');
      if (!name) return;
      const c = await store.putClient({ name: name.trim(), kind: 'business', sector: '', town: 'Knysna' });
      state.clientId = c.id;
      await loadClient();
      renderBroker();
      state.tab = 'register';
      renderTabs();
      toast(`${c.name} created.`);
    }

    if (act === 'capture-start') {
      state.capturedBy = $('#capturedBy').value;
      state.clientId = $('#onBehalfClient').value;
      await loadClient();
      $('#capturedNote').textContent =
        `Capturing as ${state.capturedBy}. Every asset you add will be stamped with your name and the date.`;
      state.tab = 'register';
      renderTabs();
      toast(`Now capturing for ${state.client.name}.`);
    }

    if (act === 'qa-add') {
      const name = $('#qaName').value.trim();
      const paid = Number($('#qaPaid').value) || 0;
      if (!name || !paid) { toast('Give it a name and what you paid.'); return; }
      state.quick.push({
        id: `q${state.quick.length}`, name, categoryId: $('#qaCat').value,
        pricePaid: paid, listPrice: 0, purchaseDate: $('#qaDate').value || todayISO(),
        priceInclVat: true, photoCount: 0,
      });
      $('#qaName').value = ''; $('#qaPaid').value = '';
      renderFree();
      $('#qaName').focus();
    }

    if (act === 'qa-del') {
      state.quick.splice(Number(t.dataset.i), 1);
      renderFree();
    }

    if (act === 'popia') {
      e.preventDefault();
      alert(
        'In the real thing this links to GRIB\'s POPIA notice.\n\n'
        + 'What it would have to say: what we collect (photographs, serial numbers, values), '
        + 'why (to advise you on your sums insured), how long we keep it, who can see it, '
        + 'and how to ask us to delete it.\n\n'
        + 'In this mockup nothing leaves your browser.');
    }
  });

  /* row clicks */
  $('#regBody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) openDrawer(tr.dataset.id);
  });
  $('#brokerBody').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-client]');
    if (!tr) return;
    state.clientId = tr.dataset.client;
    await loadClient();
    state.tab = 'register';
    renderTabs();
  });
  $('#valCards').addEventListener('click', (e) => {
    const card = e.target.closest('.vcard[data-id]');
    if (card) openDrawer(card.dataset.id, true);
  });

  /* basis quick-switch from the comparison row */
  $('#basisCompare').addEventListener('click', (e) => {
    const b = e.target.closest('[data-basis]');
    if (!b) return;
    $('#fBasis').value = b.dataset.basis;
    renderLive();
  });

  /* picking a category re-suggests a basis, but never overrides an edit */
  $('#fCat').addEventListener('change', () => {
    if (!state.editing) $('#fBasis').value = defaultBasisFor($('#fCat').value);
    renderLive();
  });

  /* form */
  $('#assetForm').addEventListener('submit', saveAsset);
  $('#assetForm').addEventListener('input', renderLive);
  $('#assetForm').addEventListener('change', renderLive);

  $('#fPhoto').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    const assetId = state.editing || 'pending';
    for (const file of files) {
      try {
        const rec = await store.addPhoto(assetId, file);
        state.editPhotos.push(rec);
      } catch (err) {
        toast(err.message || 'Could not add that photograph.');
      }
    }
    renderShots();
  });

  /* search + slider */
  $('#regSearch').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderRegister();
  });
  $('#lossRange').addEventListener('input', (e) => {
    state.loss = Number(e.target.value);
    renderAverage(portfolio(state.assets, state.client));
  });
  $('#policySum').addEventListener('input', async (e) => {
    state.client = { ...state.client, policySumInsured: Number(e.target.value) || 0 };
    const p = portfolio(state.assets, state.client);
    renderStrip(state.client, p);
    renderAverage(p);
  });
  $('#policySum').addEventListener('change', async () => {
    await store.putClient(state.client);
    renderBroker();
  });

  /* lead form */
  $('#leadForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#leadErr');
    if (!$('#leadName').value.trim()) { err.textContent = 'We need a name to know who to call.'; err.hidden = false; return; }
    if (!$('#leadContact').value.trim()) { err.textContent = 'Add an email address or mobile number.'; err.hidden = false; return; }
    if (!$('#leadConsent').checked) { err.textContent = 'Tick the consent box so we may contact you.'; err.hidden = false; return; }
    err.hidden = true;
    toast('In the real thing this lands in GRIB\'s workflow with the register attached.');
  });

  /* scrim + escape */
  $('#scrim').addEventListener('click', () => { closeDrawer(); closeSettings(); $('#exportSheet').hidden = true; $('#scrim').hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeDrawer(); closeSettings();
    $('#exportSheet').hidden = true; $('#scrim').hidden = true;
  });

  window.addEventListener('pagehide', () => store.releasePhotoUrls());
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin',
    `<div class="mockbanner" style="background:#AC3626">Could not start: ${esc(err.message)}. This page needs to be served over http:// — open it with a local server, not as a file.</div>`);
});
