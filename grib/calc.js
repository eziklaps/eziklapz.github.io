/* calc.js — the two value tracks.
 *
 * Track 1 (down): SARS s11(e) wear-and-tear, periods per BGR 7 (Issue 4).
 * Track 2 (up):   current replacement cost, escalated from retail price.
 *
 * Everything here is a pure function of an asset + a profile + a valuation
 * date, so it can be unit-tested and so an accountant can follow it.
 */

import {
  CAT_BY_ID, SMALL_ITEM_THRESHOLD, VAT_RATE, RESIDUAL_FLOOR, BASES,
  indexRateFor, depreciationRateFor, defaultBasisFor,
} from './bgr7.js';

const MONTH_DAYS = 30.44;

/* ---------- helpers ---------- */

function monthsBetween(from, to) {
  const a = from instanceof Date ? from : new Date(from);
  const b = to instanceof Date ? to : new Date(to);
  if (Number.isNaN(+a) || Number.isNaN(+b)) return 0;
  const months =
    (b.getFullYear() - a.getFullYear()) * 12 +
    (b.getMonth() - a.getMonth()) +
    (b.getDate() - a.getDate()) / MONTH_DAYS;
  return months;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function money(n) {
  const v = Number.isFinite(n) ? n : 0;
  return 'R ' + Math.round(v).toLocaleString('en-ZA');
}

function moneyExact(n) {
  const v = Number.isFinite(n) ? n : 0;
  return 'R ' + v.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ---------- cost base (BGR 7 §4.2.1, s23C(1)) ---------- */

/**
 * The write-off base is the actual cash cost, excluding finance charges, and
 * excluding input VAT if the taxpayer is a registered vendor entitled to
 * deduct it. This is why "the discount price they paid" matters: the discount
 * lowers the base, so it lowers the deduction.
 */
function costBase(asset, profile) {
  const paid = Number(asset.pricePaid) || 0;
  const inclVat = asset.priceInclVat !== false;

  const gross = inclVat ? paid : paid * (1 + VAT_RATE);
  const exVat = inclVat ? paid / (1 + VAT_RATE) : paid;
  const base = profile.vatVendor ? exVat : gross;

  const list = Number(asset.listPrice) || 0;
  const listGross = list ? (inclVat ? list : list * (1 + VAT_RATE)) : 0;
  const discount = listGross > gross ? listGross - gross : 0;

  const smallItem = !asset.partOfSet && base < SMALL_ITEM_THRESHOLD;

  return {
    gross,                       // what was actually paid, VAT-inclusive
    exVat,                       // same, excluding VAT
    base,                        // the s11(e) write-off base
    listGross,                   // retail / RRP, VAT-inclusive
    discount,                    // what the discount saved
    discountPct: listGross ? (discount / listGross) * 100 : 0,
    vatDeducted: profile.vatVendor ? gross - exVat : 0,
    smallItem,
  };
}

/* ---------- write-off period ---------- */

function writeOffPeriod(asset, profile) {
  const cat = CAT_BY_ID[asset.categoryId];
  const annexure = cat ? cat.years : 5;
  const cb = costBase(asset, profile);

  /* An explicit period the user typed wins over everything else: the
   * small-item write-off in §4.3.5 is an election ("may be written off in
   * full"), not a requirement, and a second-hand asset must run over its
   * remaining useful life regardless of the annexure (§4.3.4). */
  if (asset.yearsOverride) {
    const n = Number(asset.yearsOverride);
    return { years: n, source: 'override', annexure,
      why: asset.overrideReason
        || `Period set manually to ${n} year${n === 1 ? '' : 's'}. SARS wants a motivation to go shorter than the annexure's ${annexure}.` };
  }
  if (cb.smallItem) {
    return { years: 1, source: 'small-item', annexure,
      why: `Under R ${SMALL_ITEM_THRESHOLD.toLocaleString('en-ZA')} — writes off in full in the year acquired.` };
  }
  return { years: annexure, source: 'annexure', annexure,
    why: `BGR 7 annexure: ${cat ? cat.label : 'asset'} — ${annexure} year${annexure === 1 ? '' : 's'}.` };
}

/* ---------- track 1: down ---------- */

/**
 * Straight-line or diminishing value, apportioned monthly. BGR 7 §4.3.2
 * allows either method and §4.3.8 requires part-years to be apportioned.
 *
 * Note on diminishing value: at rate 1/n the asset never reaches nil — it
 * retains about 36% after n years. SARS Example 1 handles this by switching
 * to straight line for the remainder. We report the honest residual and flag
 * it rather than silently zeroing.
 */
function accumulatedAt(base, years, method, elapsedMonths) {
  const months = Math.max(0, elapsedMonths);
  if (method === 'dv') {
    const rate = 1 / years;
    return base - base * Math.pow(1 - rate, months / 12);
  }
  return base * clamp(months / (years * 12), 0, 1);
}

function depreciate(asset, profile, asOf = new Date()) {
  const cb = costBase(asset, profile);
  const period = writeOffPeriod(asset, profile);
  const method = asset.method || profile.method || 'sl';

  const elapsedMonths = Math.max(0, monthsBetween(asset.purchaseDate, asOf));
  const elapsedYears = elapsedMonths / 12;
  const totalMonths = period.years * 12;

  const accumulated = accumulatedAt(cb.base, period.years, method, elapsedMonths);
  const book = cb.base - accumulated;
  const residualFlag = method === 'dv' && elapsedYears >= period.years;

  // Allowance falling in the most recent 12 months, for the tax-saving figure.
  const prior = accumulatedAt(cb.base, period.years, method, elapsedMonths - 12);
  const currentYearAllowance = Math.max(0, accumulated - prior);

  return {
    base: cb.base,
    method,
    years: period.years,
    periodSource: period.source,
    periodWhy: period.why,
    elapsedMonths,
    elapsedYears,
    accumulated,
    book: Math.max(0, book),
    currentYearAllowance,
    fullyWritten: method === 'sl' ? elapsedMonths >= totalMonths : residualFlag,
    residualFlag,
    taxValueOfAllowance: currentYearAllowance * (profile.taxRate ?? 0.27),
  };
}

/** Year-by-year schedule, for the per-asset table and chart. */
function schedule(asset, profile, extraYears = 2) {
  const period = writeOffPeriod(asset, profile);
  const start = new Date(asset.purchaseDate);
  const rows = [];
  const n = period.years + extraYears;
  let prevAccum = 0;
  let prevRepl = null;

  for (let y = 0; y <= n; y++) {
    const at = new Date(start);
    at.setFullYear(at.getFullYear() + y);
    const d = depreciate(asset, profile, at);
    const r = replacementValue(asset, profile, at);
    rows.push({
      year: y,
      date: at,
      allowance: d.accumulated - prevAccum,
      book: d.book,
      replacement: r.value,
      gap: r.value - d.book,
      replacementRise: prevRepl === null ? 0 : r.value - prevRepl,
    });
    prevAccum = d.accumulated;
    prevRepl = r.value;
  }
  return rows;
}

/* ---------- track 2: the sum insured ---------- */

/**
 * The sum insured, on one of four bases an insurer will actually recognise:
 *
 *   replacement  new-for-old. Retail price today. The default.
 *   indemnity    replacement less wear and tear. What it's worth now.
 *   agreed       a fixed sum off a valuation certificate. Doesn't index,
 *                and isn't subject to the average clause.
 *   manual       the client's own figure.
 *
 * "Replacement" indexes the RETAIL price, not what was paid — you re-buy at
 * retail, and whatever discount you negotiated once is not repeatable.
 *
 * A VAT vendor can claim the input tax on the replacement, so their sum
 * insured is conventionally set excluding VAT. That's a profile switch.
 */
function insuredValue(asset, profile, asOf = new Date()) {
  const cb = costBase(asset, profile);
  const cat = CAT_BY_ID[asset.categoryId];

  const basis = asset.basis || defaultBasisFor(asset.categoryId);
  const rate = asset.indexOverride != null
    ? Number(asset.indexOverride)
    : indexRateFor(asset.categoryId);
  const depRate = asset.depreciationOverride != null
    ? Number(asset.depreciationOverride)
    : depreciationRateFor(asset.categoryId);

  const retailBase = cb.listGross || cb.gross;
  const years = Math.max(0, monthsBetween(asset.purchaseDate, asOf) / 12);

  /* new-for-old, always computed so the other bases can be compared to it */
  let replacementNew = retailBase * Math.pow(1 + rate, years);
  if (profile.sumInsuredExVat) replacementNew = replacementNew / (1 + VAT_RATE);

  /* indemnity: new-for-old, less wear and tear, floored */
  const wearFactor = Math.max(RESIDUAL_FLOOR, Math.pow(1 - depRate, years));
  const indemnity = replacementNew * wearFactor;

  /* agreed: a flat certified sum, not indexed */
  const agreedSum = Number(asset.agreedValue) || 0;
  const manualSum = Number(asset.replacementOverride) || 0;

  let value, note, incomplete = false;
  switch (basis) {
    case 'indemnity':
      value = indemnity;
      note = `New-for-old ${money(replacementNew)} less ${Math.round((1 - wearFactor) * 100)}% wear and tear.`;
      break;
    case 'agreed':
      value = agreedSum || replacementNew;
      incomplete = !agreedSum;
      note = agreedSum
        ? 'Fixed at the certified sum. Not indexed, and the average clause does not apply.'
        : 'No agreed sum entered yet — showing new-for-old until a valuation is lodged.';
      break;
    case 'manual':
      value = manualSum || replacementNew;
      incomplete = !manualSum;
      note = manualSum
        ? 'Your figure.'
        : 'No figure entered yet — showing new-for-old.';
      break;
    default:
      value = replacementNew;
      note = years < 0.08
        ? 'Bought new, so this is still the retail price.'
        : `Retail price indexed at ${(rate * 100).toFixed(1)}% a year for ${years.toFixed(1)} years.`;
  }

  /* Certificates go stale. Most insurers want jewellery and art revalued
   * every three years, and will discount a claim on an older certificate. */
  const certAgeYears = asset.valuationDate
    ? Math.max(0, monthsBetween(asset.valuationDate, asOf) / 12)
    : null;

  return {
    value,
    basis,
    basisLabel: BASES[basis] ? BASES[basis].label : basis,
    basisShort: BASES[basis] ? BASES[basis].short : basis,
    note,
    incomplete,
    replacementNew,
    indemnity,
    agreedSum,
    manualSum,
    wearFactor,
    depRate,
    rate,
    retailBase,
    years,
    risenBy: replacementNew - retailBase,
    /* what the basis choice costs or saves against new-for-old */
    vsReplacement: value - replacementNew,
    needsValuation: Boolean(cat && cat.valuation),
    hasValuation: Boolean(asset.valuationCert),
    certAgeYears,
    certStale: certAgeYears != null && certAgeYears > 3,
    /* agreed-value items sit outside the average clause */
    averaged: basis !== 'agreed',
  };
}

/* Kept as the old name so nothing downstream has to care. */
const replacementValue = insuredValue;

/* ---------- the two-number view of one asset ---------- */

function assetView(asset, profile, asOf = new Date()) {
  const cb = costBase(asset, profile);
  const dep = depreciate(asset, profile, asOf);
  const rep = replacementValue(asset, profile, asOf);
  return {
    asset, cost: cb, dep, rep,
    gap: rep.value - dep.book,
    /* If you insured at cost and never moved it, this is your shortfall. */
    staleShortfall: Math.max(0, rep.value - cb.gross),
    staleAdequacy: rep.value > 0 ? cb.gross / rep.value : 1,
  };
}

/* ---------- portfolio ---------- */

function portfolio(assets, profile, asOf = new Date()) {
  let cost = 0, base = 0, book = 0, replacement = 0, allowance = 0, taxValue = 0;
  let agreed = 0, averaged = 0, incompleteBasis = 0, staleCerts = 0;
  let missingPhoto = 0, missingSerial = 0, needsValuation = 0, fullyWritten = 0;

  for (const a of assets) {
    const v = assetView(a, profile, asOf);
    cost += v.cost.gross;
    base += v.cost.base;
    book += v.dep.book;
    replacement += v.rep.value;
    if (v.rep.averaged) averaged += v.rep.value; else agreed += v.rep.value;
    if (v.rep.incomplete) incompleteBasis++;
    if (v.rep.certStale) staleCerts++;
    allowance += v.dep.currentYearAllowance;
    taxValue += v.dep.taxValueOfAllowance;
    if (!a.photoCount) missingPhoto++;
    if (!a.serial) missingSerial++;
    if (v.rep.needsValuation && !v.rep.hasValuation) needsValuation++;
    if (v.dep.fullyWritten) fullyWritten++;
  }

  return {
    count: assets.length,
    cost, base, book, replacement, allowance, taxValue,
    agreed, averaged, incompleteBasis, staleCerts,
    gap: replacement - book,
    missingPhoto, missingSerial, needsValuation, fullyWritten,
    completeness: assets.length
      ? Math.round(((assets.length - missingPhoto) / assets.length) * 100)
      : 0,
  };
}

/* ---------- the average clause ---------- */

/**
 * payout = sum insured ÷ replacement value × the loss.
 * A total loss is capped at the sum insured instead of being averaged, which
 * is why partial losses are where clients get hurt without noticing.
 */
function averageClause(policySumInsured, replacementTotal, loss) {
  const sum = Number(policySumInsured) || 0;
  const repl = Number(replacementTotal) || 0;
  const adequacy = repl > 0 ? sum / repl : 1;
  const applied = clamp(adequacy, 0, 1);
  const lossAmt = Math.min(Number(loss) || 0, repl || Infinity);

  return {
    adequacy,
    applied,
    underPct: Math.max(0, (1 - applied) * 100),
    isUnder: adequacy < 0.995,
    isOver: adequacy > 1.005,
    loss: lossAmt,
    payout: lossAmt * applied,
    shortfall: lossAmt - lossAmt * applied,
    /* Total loss: capped at the sum insured, no averaging. */
    totalLossPayout: Math.min(sum, repl),
    totalLossShortfall: Math.max(0, repl - sum),
  };
}

export {
  monthsBetween, money, moneyExact, clamp,
  costBase, writeOffPeriod, depreciate, schedule,
  insuredValue, replacementValue,
  assetView, portfolio, averageClause,
};
