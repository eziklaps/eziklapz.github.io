/* store.js — everything stays on the device.
 *
 * Mockup persistence: IndexedDB, three stores (clients, assets, photos).
 * Photos are held as Blobs, not data URIs, so a register with a hundred
 * photographs doesn't blow up localStorage.
 *
 * In stage 2 this module is the only thing that changes: the same function
 * signatures move to fetch() against the FastAPI service on the VPS.
 */

const DB_NAME = 'grib-asset-register';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('clients')) {
        db.createObjectStore('clients', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('assets')) {
        const s = db.createObjectStore('assets', { keyPath: 'id' });
        s.createIndex('byClient', 'clientId');
      }
      if (!db.objectStoreNames.contains('photos')) {
        const p = db.createObjectStore('photos', { keyPath: 'id' });
        p.createIndex('byAsset', 'assetId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try { result = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const wrap = (req) => ({ __req: req });

const uid = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/* ---------- clients ---------- */

const DEFAULT_PROFILE = {
  vatVendor: true,
  sumInsuredExVat: false,
  method: 'sl',
  taxRate: 0.27,
  policySumInsured: 0,
  financialYearEnd: '02-28',
};

async function listClients() {
  const all = await tx('clients', 'readonly', (s) => wrap(s.getAll()));
  return (all || []).sort((a, b) => a.name.localeCompare(b.name));
}

async function getClient(id) {
  const c = await tx('clients', 'readonly', (s) => wrap(s.get(id)));
  return c ? { ...DEFAULT_PROFILE, ...c } : null;
}

async function putClient(client) {
  const rec = { ...DEFAULT_PROFILE, ...client, id: client.id || uid('cl') };
  await tx('clients', 'readwrite', (s) => s.put(rec));
  return rec;
}

async function deleteClient(id) {
  const assets = await listAssets(id);
  for (const a of assets) await deleteAsset(a.id);
  await tx('clients', 'readwrite', (s) => s.delete(id));
}

/* ---------- assets ---------- */

async function listAssets(clientId) {
  const all = await tx('assets', 'readonly', (s) =>
    wrap(clientId ? s.index('byClient').getAll(clientId) : s.getAll()));
  return (all || []).sort((a, b) =>
    String(b.purchaseDate).localeCompare(String(a.purchaseDate)));
}

async function getAsset(id) {
  return tx('assets', 'readonly', (s) => wrap(s.get(id)));
}

async function putAsset(asset) {
  const rec = {
    priceInclVat: true,
    partOfSet: false,
    photoCount: 0,
    createdAt: new Date().toISOString(),
    ...asset,
    id: asset.id || uid('as'),
    updatedAt: new Date().toISOString(),
  };
  await tx('assets', 'readwrite', (s) => s.put(rec));
  return rec;
}

async function deleteAsset(id) {
  const shots = await listPhotos(id);
  for (const p of shots) await tx('photos', 'readwrite', (s) => s.delete(p.id));
  await tx('assets', 'readwrite', (s) => s.delete(id));
}

/* ---------- photos ---------- */

/** Downscale on the device: 1600px long edge, JPEG q0.82. */
function shrink(file, maxEdge = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (blob) => (blob ? resolve({ blob, width: w, height: h }) : reject(new Error('Could not read that image.'))),
        'image/jpeg',
        quality,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file is not an image we can read.'));
    };
    img.src = url;
  });
}

async function addPhoto(assetId, file) {
  const { blob, width, height } = await shrink(file);
  const rec = {
    id: uid('ph'),
    assetId,
    blob,
    width,
    height,
    bytes: blob.size,
    takenAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
    addedAt: new Date().toISOString(),
  };
  await tx('photos', 'readwrite', (s) => s.put(rec));
  const asset = await getAsset(assetId);
  if (asset) {
    const shots = await listPhotos(assetId);
    await putAsset({ ...asset, photoCount: shots.length });
  }
  return rec;
}

async function listPhotos(assetId) {
  const all = await tx('photos', 'readonly', (s) =>
    wrap(s.index('byAsset').getAll(assetId)));
  return all || [];
}

async function deletePhoto(id) {
  const rec = await tx('photos', 'readonly', (s) => wrap(s.get(id)));
  await tx('photos', 'readwrite', (s) => s.delete(id));
  if (rec) {
    const asset = await getAsset(rec.assetId);
    if (asset) {
      const shots = await listPhotos(rec.assetId);
      await putAsset({ ...asset, photoCount: shots.length });
    }
  }
}

/* Object URLs are revoked when the view that made them is torn down. */
const liveUrls = new Set();

function photoUrl(rec) {
  const url = URL.createObjectURL(rec.blob);
  liveUrls.add(url);
  return url;
}

function releasePhotoUrls() {
  for (const u of liveUrls) URL.revokeObjectURL(u);
  liveUrls.clear();
}

/* ---------- seed ---------- */

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/* Three demo clients drawn from GRIB's actual book: hospitality, construction,
 * and a private-wealth household. Values are plausible, not real. */
const SEED_CLIENTS = [
  {
    id: 'cl_thesalt',
    name: 'The Salt Room Restaurant',
    kind: 'business',
    contact: 'Nadia Fourie',
    town: 'Knysna',
    sector: 'Hospitality',
    vatVendor: true,
    policySumInsured: 780000,
    brokerNote: 'Renewal 1 October. Last register update was a 2023 spreadsheet.',
  },
  {
    id: 'cl_rheenendal',
    name: 'Rheenendal Build & Civils',
    kind: 'business',
    contact: 'Pieter Malan',
    town: 'Rheenendal',
    sector: 'Construction',
    vatVendor: true,
    policySumInsured: 1450000,
    brokerNote: 'Plant moves between sites — check the all-risk section covers off-premises.',
  },
  {
    id: 'cl_leisureisle',
    name: 'Van der Merwe household',
    kind: 'household',
    contact: 'Annelise van der Merwe',
    town: 'Leisure Isle, Knysna',
    sector: 'Private wealth',
    vatVendor: false,
    policySumInsured: 420000,
    brokerNote: 'Specified all-risk. Two valuation certificates outstanding.',
  },
];

const SEED_ASSETS = [
  // --- The Salt Room: hospitality kitchen, mostly 6-year items ---
  { clientId: 'cl_thesalt', name: 'Rational combi oven SCC 101', categoryId: 'oven',
    serial: 'RAT-101-88214', listPrice: 289000, pricePaid: 262000, purchaseDate: daysAgo(1490), room: 'Kitchen' },
  { clientId: 'cl_thesalt', name: 'Walk-in cold room', categoryId: 'fridge_eq',
    serial: 'CR-2019-KNY', listPrice: 178000, pricePaid: 178000, purchaseDate: daysAgo(2210), room: 'Kitchen' },
  { clientId: 'cl_thesalt', name: 'Stainless prep counters ×4', categoryId: 'kitchen_eq',
    serial: '', listPrice: 62000, pricePaid: 54500, purchaseDate: daysAgo(1120), room: 'Kitchen', partOfSet: true },
  { clientId: 'cl_thesalt', name: 'Dining chairs ×36 and tables ×12', categoryId: 'furniture',
    serial: '', listPrice: 148000, pricePaid: 131000, purchaseDate: daysAgo(1680), room: 'Front of house', partOfSet: true },
  { clientId: 'cl_thesalt', name: 'Yealink POS terminal & printer', categoryId: 'till',
    serial: 'POS-44192', listPrice: 24800, pricePaid: 22300, purchaseDate: daysAgo(640), room: 'Front of house' },
  { clientId: 'cl_thesalt', name: 'Office laptop — Dell Latitude 5540', categoryId: 'pc',
    serial: 'DL5540-7F2K91', listPrice: 31500, pricePaid: 27900, purchaseDate: daysAgo(1240), room: 'Office' },
  { clientId: 'cl_thesalt', name: '12kVA standby generator', categoryId: 'gen_standby',
    serial: 'GEN-12K-3381', listPrice: 214000, pricePaid: 198000, purchaseDate: daysAgo(980), room: 'Yard' },
  { clientId: 'cl_thesalt', name: 'Espresso machine — La Marzocco Linea', categoryId: 'kitchen_eq',
    serial: 'LM-LIN-20714', listPrice: 168000, pricePaid: 152000, purchaseDate: daysAgo(820), room: 'Bar' },
  { clientId: 'cl_thesalt', name: 'Knife rolls, mandolines, small tools', categoryId: 'looseTools',
    serial: '', listPrice: 6400, pricePaid: 5900, purchaseDate: daysAgo(410), room: 'Kitchen' },

  // --- Rheenendal Build & Civils: plant, 3–4 year write-offs ---
  { clientId: 'cl_rheenendal', name: 'Bobcat E35 mini excavator', categoryId: 'excavator',
    serial: 'BC-E35-B4T119', listPrice: 895000, pricePaid: 848000, purchaseDate: daysAgo(1310), room: 'Plant yard' },
  { clientId: 'cl_rheenendal', name: 'Toyota Hilux 2.4 GD-6 single cab', categoryId: 'delivery',
    serial: 'AHTKB3CD40K221', listPrice: 512000, pricePaid: 489000, purchaseDate: daysAgo(1580), room: 'Fleet' },
  { clientId: 'cl_rheenendal', name: 'Site container office 6m', categoryId: 'container',
    serial: 'CNT-6M-0912', listPrice: 74000, pricePaid: 68000, purchaseDate: daysAgo(2010), room: 'Site' },
  { clientId: 'cl_rheenendal', name: 'Wacker Neuson plate compactor', categoryId: 'compressor',
    serial: 'WN-DPU-6655', listPrice: 88000, pricePaid: 79500, purchaseDate: daysAgo(760), room: 'Plant yard' },
  { clientId: 'cl_rheenendal', name: 'Makita cordless tool fleet', categoryId: 'powertool',
    serial: '', listPrice: 46000, pricePaid: 41200, purchaseDate: daysAgo(520), room: 'Plant yard', partOfSet: true },
  { clientId: 'cl_rheenendal', name: 'Leica total station TS07', categoryId: 'survey_inst',
    serial: 'LTS07-33812', listPrice: 268000, pricePaid: 249000, purchaseDate: daysAgo(1150), room: 'Site' },
  { clientId: 'cl_rheenendal', name: 'Concrete transit mixer', categoryId: 'mixer_transit',
    serial: 'CTM-7742', listPrice: 640000, pricePaid: 612000, purchaseDate: daysAgo(1720), room: 'Fleet' },
  { clientId: 'cl_rheenendal', name: 'Site laptops ×3 — Lenovo ThinkPad', categoryId: 'pc',
    serial: 'LTP-MULTI-3', listPrice: 84000, pricePaid: 74400, purchaseDate: daysAgo(890), room: 'Site office', partOfSet: true },

  // --- Van der Merwe household: specified all-risk ---
  /* Agreed value, fresh certificate — the textbook case. */
  { clientId: 'cl_leisureisle', name: 'Diamond solitaire ring, 1.2ct', categoryId: 'jewellery',
    serial: 'CERT-GIA-2188410', listPrice: 148000, pricePaid: 148000, purchaseDate: daysAgo(2920), room: 'Safe',
    basis: 'agreed', agreedValue: 265000, valuationDate: daysAgo(400), valuationCert: 'GIA 2188410' },
  /* Agreed value, but the certificate has gone stale — insurers want three-yearly. */
  { clientId: 'cl_leisureisle', name: 'Rolex Datejust 41', categoryId: 'watch',
    serial: 'RLX-DJ41-8827K', listPrice: 212000, pricePaid: 212000, purchaseDate: daysAgo(1830), room: 'Safe',
    basis: 'agreed', agreedValue: 298000, valuationDate: daysAgo(1640), valuationCert: 'JCSA 44120' },
  /* Wants agreed value but nothing lodged yet — falls back to new-for-old. */
  { clientId: 'cl_leisureisle', name: 'Vladimir Tretchikoff oil, framed', categoryId: 'painting',
    serial: 'ART-TRT-004', listPrice: 340000, pricePaid: 295000, purchaseDate: daysAgo(3650), room: 'Lounge',
    basis: 'agreed' },
  /* Insured on indemnity — the client chose the cheaper basis knowingly. */
  { clientId: 'cl_leisureisle', name: 'Specialized Turbo Levo SL e-bike', categoryId: 'bicycle',
    serial: 'SPZ-TLSL-99214', listPrice: 168000, pricePaid: 149000, purchaseDate: daysAgo(680), room: 'Garage',
    basis: 'indemnity' },
  { clientId: 'cl_leisureisle', name: 'Canon R5 body and two L lenses', categoryId: 'camera',
    serial: 'CAN-R5-441820', listPrice: 118000, pricePaid: 106000, purchaseDate: daysAgo(1090), room: 'Study' },
  { clientId: 'cl_leisureisle', name: 'MacBook Pro 16" M3 Max', categoryId: 'pc',
    serial: 'C02XK9LTQ6NV', listPrice: 78000, pricePaid: 71500, purchaseDate: daysAgo(430), room: 'Study' },
  { clientId: 'cl_leisureisle', name: 'Steinway Model B grand piano', categoryId: 'instrument',
    serial: 'STW-B-118422', listPrice: 1450000, pricePaid: 1450000, purchaseDate: daysAgo(4380), room: 'Lounge' },
];

async function seedIfEmpty() {
  const existing = await listClients();
  if (existing.length) return existing;
  for (const c of SEED_CLIENTS) await putClient(c);
  for (const a of SEED_ASSETS) await putAsset(a);
  return listClients();
}

async function resetAll() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const t = db.transaction(['clients', 'assets', 'photos'], 'readwrite');
    t.objectStore('clients').clear();
    t.objectStore('assets').clear();
    t.objectStore('photos').clear();
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
  releasePhotoUrls();
  return seedIfEmpty();
}

export {
  DEFAULT_PROFILE,
  listClients, getClient, putClient, deleteClient,
  listAssets, getAsset, putAsset, deleteAsset,
  addPhoto, listPhotos, deletePhoto, photoUrl, releasePhotoUrls,
  seedIfEmpty, resetAll, uid,
};
