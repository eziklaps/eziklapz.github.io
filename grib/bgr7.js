/* bgr7.js — SARS write-off schedule as pickable asset categories.
 *
 * Source of truth: Binding General Ruling (Income Tax) 7 (Issue 4), 9 Feb 2021,
 * being the reproduced Annexure of Interpretation Note 47 (Issue 5). Applies to
 * any asset brought into use on or after 24 March 2020. `years` below is the
 * "proposed write-off period" SARS accepts without motivation.
 *
 * `index` is NOT from SARS. It is our assumed annual replacement-cost inflation
 * for the group, used to escalate a purchase price into a current sum insured.
 * Every one of these is an editable assumption to be agreed with GRIB.
 */

const SMALL_ITEM_THRESHOLD = 7000;   // BGR 7 §4.3.5 — per item, not per set
const VAT_RATE = 0.15;

/* Replacement-cost inflation assumptions, by group. */
const GROUP_INDEX = {
  it:        0.07,   // imported, rand-exposed
  furniture: 0.06,
  kitchen:   0.07,
  plant:     0.07,
  vehicles:  0.08,
  construct: 0.08,
  marine:    0.08,
  medical:   0.07,
  retail:    0.06,
  building:  0.06,
  agri:      0.07,
  valuables: 0.05,   // flagged for professional valuation instead
  leisure:   0.06,
};

/* Annual depreciation applied on an INDEMNITY basis — "what it's worth now",
 * i.e. replacement value less wear and tear. This is not SARS depreciation and
 * has nothing to do with it: SARS writes an asset to nil, an insurer does not.
 * Floored by RESIDUAL_FLOOR because an item still in use is never worth nothing. */
const GROUP_DEPRECIATION = {
  it:        0.25,   // electronics lose resale value fast
  furniture: 0.10,
  kitchen:   0.12,
  plant:     0.12,
  vehicles:  0.15,
  construct: 0.13,
  marine:    0.10,
  medical:   0.12,
  retail:    0.12,
  building:  0.08,
  agri:      0.12,
  valuables: 0.00,   // jewellery and art don't depreciate — put them on agreed value
  leisure:   0.15,
};

const RESIDUAL_FLOOR = 0.20;

/* How the sum insured is arrived at. Insurers use all four in practice. */
const BASES = {
  replacement: {
    label: 'New replacement value',
    short: 'new-for-old',
    blurb: 'What it costs to buy the same thing new today. The default for household contents and most all-risk sections.',
  },
  indemnity: {
    label: 'Indemnity value',
    short: 'indemnity',
    blurb: 'Replacement value less wear and tear — what it is worth now, second-hand. Cheaper to insure, and what you get paid.',
  },
  agreed: {
    label: 'Agreed value',
    short: 'agreed',
    blurb: 'A fixed sum agreed up front off a valuation certificate. Does not index and is not subject to the average clause. Standard for jewellery, watches and art.',
  },
  manual: {
    label: 'Your own figure',
    short: 'own figure',
    blurb: 'You set the number. Use this when you know the real cost better than any index does.',
  },
};

const GROUP_LABELS = {
  it:        'IT, office & communications',
  furniture: 'Furniture & fittings',
  kitchen:   'Kitchen & catering',
  plant:     'Plant, tools & workshop',
  vehicles:  'Vehicles & transport',
  construct: 'Construction & earthmoving',
  marine:    'Marine & aviation',
  medical:   'Medical & professional',
  retail:    'Retail & hospitality',
  building:  'Security & building services',
  agri:      'Agriculture',
  valuables: 'Valuables, art & collectables',
  leisure:   'Sport & leisure',
};

/* years: BGR 7 Annexure. valuation: true = insurer will want a certificate. */
const CATEGORIES = [
  // ---------- IT, office & communications ----------
  { id: 'pc',            label: 'Computer — desktop or laptop',        years: 3,  group: 'it' },
  { id: 'server',        label: 'Server or mainframe',                 years: 5,  group: 'it' },
  { id: 'tablet',        label: 'Tablet or similar device',            years: 2,  group: 'it' },
  { id: 'cellphone',     label: 'Cellular telephone',                  years: 2,  group: 'it' },
  { id: 'sw_pc',         label: 'Software — personal computer',         years: 2,  group: 'it' },
  { id: 'sw_mf',         label: 'Software — mainframe, purchased',      years: 3,  group: 'it' },
  { id: 'office_elec',   label: 'Office equipment — electronic',        years: 3,  group: 'it' },
  { id: 'office_mech',   label: 'Office equipment — mechanical',        years: 5,  group: 'it' },
  { id: 'fax',           label: 'Fax machine',                         years: 3,  group: 'it' },
  { id: 'copier_photo',  label: 'Photocopying equipment',              years: 5,  group: 'it' },
  { id: 'copier_static', label: 'Electrostatic copier',                years: 6,  group: 'it' },
  { id: 'phone_eq',      label: 'Telephone equipment',                 years: 5,  group: 'it' },
  { id: 'comms',         label: 'Communication system',                years: 5,  group: 'it' },
  { id: 'radio',         label: 'Radio communication equipment',       years: 5,  group: 'it' },
  { id: 'pa',            label: 'Public address system',               years: 5,  group: 'it' },
  { id: 'antenna',       label: 'Cell phone antenna',                  years: 6,  group: 'it' },
  { id: 'mast',          label: 'Cell phone mast',                     years: 10, group: 'it' },
  { id: 'textbook',      label: 'Textbooks',                           years: 3,  group: 'it' },
  { id: 'lawreports',    label: 'Law reports — sets',                  years: 5,  group: 'it' },

  // ---------- Furniture & fittings ----------
  { id: 'furniture',     label: 'Furniture and fittings',              years: 6,  group: 'furniture' },
  { id: 'carpets',       label: 'Fitted carpets',                      years: 6,  group: 'furniture' },
  { id: 'curtains',      label: 'Curtains and blinds',                 years: 5,  group: 'furniture' },
  { id: 'partitions',    label: 'Demountable partitions',              years: 6,  group: 'furniture' },
  { id: 'shopfit',       label: 'Shop fittings',                       years: 6,  group: 'retail' },
  { id: 'safe',          label: 'Portable safe',                       years: 25, group: 'furniture' },

  // ---------- Kitchen & catering ----------
  { id: 'kitchen_eq',    label: 'Kitchen equipment',                   years: 6,  group: 'kitchen' },
  { id: 'oven',          label: 'Oven or heating device',              years: 6,  group: 'kitchen' },
  { id: 'fridge_eq',     label: 'Refrigeration equipment',             years: 6,  group: 'kitchen' },
  { id: 'fridge',        label: 'Refrigerator or freezer',             years: 6,  group: 'kitchen' },
  { id: 'fridge_mobile', label: 'Mobile refrigeration unit',           years: 4,  group: 'kitchen' },
  { id: 'cold_disp',     label: 'Cold drink dispenser',                years: 6,  group: 'kitchen' },
  { id: 'gas_cooker',    label: 'Gas heater or cooker',                years: 6,  group: 'kitchen' },
  { id: 'foodconvey',    label: 'Food-conveying system',               years: 4,  group: 'kitchen' },
  { id: 'foodbin',       label: 'Food bins',                           years: 4,  group: 'kitchen' },
  { id: 'dishwash',      label: 'Washing machine',                     years: 5,  group: 'kitchen' },
  { id: 'spindryer',     label: 'Spin dryer',                          years: 6,  group: 'kitchen' },
  { id: 'ironing',       label: 'Ironing and pressing equipment',      years: 6,  group: 'kitchen' },
  { id: 'laundromat',    label: 'Laundromat equipment',                years: 5,  group: 'kitchen' },
  { id: 'vending',       label: 'Vending machine',                     years: 6,  group: 'retail' },
  { id: 'till',          label: 'Cash register or POS',                years: 5,  group: 'retail' },

  // ---------- Plant, tools & workshop ----------
  { id: 'powertool',     label: 'Power tool — hand-operated',          years: 5,  group: 'plant' },
  { id: 'drill',         label: 'Drill',                               years: 6,  group: 'plant' },
  { id: 'saw_elec',      label: 'Electric saw',                        years: 6,  group: 'plant' },
  { id: 'chainsaw',      label: 'Motorised chainsaw',                  years: 4,  group: 'plant' },
  { id: 'sander',        label: 'Sander',                              years: 6,  group: 'plant' },
  { id: 'planer',        label: 'Planer',                              years: 6,  group: 'plant' },
  { id: 'lathe',         label: 'Lathe',                               years: 6,  group: 'plant' },
  { id: 'mill',          label: 'Milling machine',                     years: 6,  group: 'plant' },
  { id: 'grinder',       label: 'Grinding machine',                    years: 6,  group: 'plant' },
  { id: 'weld_arc',      label: 'Arc welding equipment',               years: 6,  group: 'plant' },
  { id: 'weld_spot',     label: 'Spot welding equipment',              years: 6,  group: 'plant' },
  { id: 'gascut',        label: 'Gas cutting equipment',               years: 6,  group: 'plant' },
  { id: 'compressor',    label: 'Compressor',                          years: 4,  group: 'plant' },
  { id: 'pump',          label: 'Pump',                                years: 4,  group: 'plant' },
  { id: 'motor',         label: 'Motor',                               years: 4,  group: 'plant' },
  { id: 'gearbox',       label: 'Gearbox',                             years: 4,  group: 'plant' },
  { id: 'boiler',        label: 'Boiler',                              years: 4,  group: 'plant' },
  { id: 'workshop',      label: 'Workshop equipment',                  years: 5,  group: 'plant' },
  { id: 'gen_port',      label: 'Generator — portable',                years: 5,  group: 'plant' },
  { id: 'gen_standby',   label: 'Generator — standby',                 years: 15, group: 'plant' },
  { id: 'solar',         label: 'Solar energy unit',                   years: 5,  group: 'plant' },
  { id: 'battery',       label: 'Battery charger or inverter',         years: 5,  group: 'plant' },
  { id: 'scales',        label: 'Scales',                             years: 5,  group: 'plant' },
  { id: 'pallet',        label: 'Pallets',                             years: 4,  group: 'plant' },
  { id: 'racking',       label: 'Warehouse racking',                   years: 10, group: 'plant' },
  { id: 'container',     label: 'Freight container',                   years: 10, group: 'plant' },
  { id: 'packaging',     label: 'Packaging and related equipment',     years: 4,  group: 'plant' },
  { id: 'patterns',      label: 'Patterns, tooling and dies',          years: 3,  group: 'plant' },
  { id: 'trolley',       label: 'Trolleys',                            years: 3,  group: 'plant' },
  { id: 'watertank',     label: 'Water tank',                          years: 6,  group: 'plant' },
  { id: 'looseTools',    label: 'Loose tools & small equipment',       years: 1,  group: 'plant',
    note: 'Under R7 000 each, these write off in full in the year acquired.' },

  // ---------- Vehicles & transport ----------
  { id: 'car',           label: 'Passenger car',                       years: 5,  group: 'vehicles' },
  { id: 'delivery',      label: 'Delivery vehicle / LDV',              years: 4,  group: 'vehicles' },
  { id: 'truck_heavy',   label: 'Truck — heavy duty',                  years: 3,  group: 'vehicles' },
  { id: 'truck_other',   label: 'Truck — other',                       years: 4,  group: 'vehicles' },
  { id: 'trailer',       label: 'Trailer',                             years: 5,  group: 'vehicles' },
  { id: 'motorcycle',    label: 'Motorcycle',                          years: 4,  group: 'vehicles' },
  { id: 'bicycle',       label: 'Bicycle',                             years: 4,  group: 'vehicles' },
  { id: 'forklift',      label: 'Fork-lift truck',                     years: 4,  group: 'vehicles' },
  { id: 'watertanker',   label: 'Water tanker',                        years: 4,  group: 'vehicles' },
  { id: 'caravan',       label: 'Mobile caravan',                      years: 5,  group: 'vehicles' },
  { id: 'nav',           label: 'Navigation system',                   years: 10, group: 'vehicles' },

  // ---------- Construction & earthmoving ----------
  { id: 'excavator',     label: 'Excavator',                           years: 4,  group: 'construct' },
  { id: 'bulldozer',     label: 'Bulldozer',                           years: 3,  group: 'construct' },
  { id: 'grader',        label: 'Grader',                              years: 4,  group: 'construct' },
  { id: 'loader',        label: 'Front-end loader',                    years: 4,  group: 'construct' },
  { id: 'traxcavator',   label: 'Traxcavator',                         years: 4,  group: 'construct' },
  { id: 'crane_mobile',  label: 'Mobile crane',                        years: 4,  group: 'construct' },
  { id: 'crane_truck',   label: 'Truck-mounted crane',                 years: 4,  group: 'construct' },
  { id: 'crane_gantry',  label: 'Gantry crane',                        years: 6,  group: 'construct' },
  { id: 'mixer_port',    label: 'Concrete mixer — portable',           years: 4,  group: 'construct' },
  { id: 'mixer_transit', label: 'Concrete transit mixer',              years: 3,  group: 'construct' },
  { id: 'drill_water',   label: 'Drilling equipment — water',          years: 5,  group: 'construct' },
  { id: 'survey_inst',   label: "Surveyor's instruments",              years: 10, group: 'construct' },
  { id: 'survey_field',  label: "Surveyor's field equipment",          years: 5,  group: 'construct' },
  { id: 'weighbridge',   label: 'Weighbridge — movable parts',         years: 10, group: 'construct' },

  // ---------- Marine & aviation ----------
  { id: 'pleasurecraft', label: 'Pleasure craft',                      years: 12, group: 'marine' },
  { id: 'fishingvessel', label: 'Fishing vessel',                      years: 12, group: 'marine' },
  { id: 'aircraft',      label: 'Light aircraft / commercial helicopter', years: 4, group: 'marine' },
  { id: 'radar',         label: 'Radar system',                        years: 5,  group: 'marine' },
  { id: 'runway',        label: 'Runway lights',                       years: 5,  group: 'marine' },

  // ---------- Medical & professional ----------
  { id: 'dental',        label: 'Dental or doctors equipment',         years: 5,  group: 'medical' },
  { id: 'theatre',       label: 'Medical theatre equipment',           years: 6,  group: 'medical' },
  { id: 'xray',          label: 'X-ray equipment',                     years: 5,  group: 'medical' },
  { id: 'mri',           label: 'MRI scanner',                         years: 5,  group: 'medical' },
  { id: 'oxygen',        label: 'Oxygen concentrator',                 years: 3,  group: 'medical' },
  { id: 'lab',           label: 'Laboratory research equipment',       years: 5,  group: 'medical' },
  { id: 'incubator',     label: 'Incubator',                           years: 6,  group: 'medical' },
  { id: 'hairdress',     label: "Hairdresser's equipment",             years: 5,  group: 'medical' },
  { id: 'engraving',     label: 'Engraving equipment',                 years: 5,  group: 'medical' },
  { id: 'training',      label: 'Staff training equipment',            years: 5,  group: 'medical' },

  // ---------- Security & building services ----------
  { id: 'security',      label: 'Security system — removable',         years: 5,  group: 'building' },
  { id: 'firedetect',    label: 'Fire detection system',               years: 3,  group: 'building' },
  { id: 'fireext',       label: 'Fire extinguisher — loose unit',      years: 5,  group: 'building' },
  { id: 'ac_mobile',     label: 'Air conditioner — mobile',            years: 5,  group: 'building' },
  { id: 'ac_window',     label: 'Air conditioner — window type',       years: 6,  group: 'building' },
  { id: 'ac_room',       label: 'Air conditioner — room unit',         years: 10, group: 'building' },
  { id: 'ahu',           label: 'Air handling unit',                   years: 20, group: 'building' },
  { id: 'coolingtower',  label: 'Cooling tower',                       years: 15, group: 'building' },
  { id: 'condensing',    label: 'Condensing set',                      years: 15, group: 'building' },
  { id: 'chiller_cent',  label: 'Chiller — centrifugal',               years: 20, group: 'building' },
  { id: 'chiller_abs',   label: 'Chiller — absorption',                years: 25, group: 'building' },
  { id: 'lift',          label: 'Lift installation',                   years: 12, group: 'building' },
  { id: 'escalator',     label: 'Escalator',                           years: 20, group: 'building' },
  { id: 'geyser',        label: 'Hot water system / geyser',           years: 5,  group: 'building' },
  { id: 'heating',       label: 'Heating equipment',                   years: 6,  group: 'building' },
  { id: 'neon',          label: 'Neon sign or advertising board',      years: 10, group: 'building' },
  { id: 'carport',       label: 'Carport',                             years: 5,  group: 'building' },
  { id: 'waterplant',    label: 'Water distillation / purification plant', years: 12, group: 'building' },
  { id: 'powersupply',   label: 'Power supply / UPS',                  years: 5,  group: 'building' },

  // ---------- Agriculture ----------
  { id: 'tractor',       label: 'Tractor',                             years: 4,  group: 'agri' },
  { id: 'harvester',     label: 'Harvester',                           years: 6,  group: 'agri' },
  { id: 'plough',        label: 'Plough',                              years: 6,  group: 'agri' },
  { id: 'baler',         label: 'Baler',                               years: 6,  group: 'agri' },
  { id: 'cropsprayer',   label: 'Crop sprayer',                        years: 6,  group: 'agri' },
  { id: 'fertspreader',  label: 'Fertiliser spreader',                 years: 6,  group: 'agri' },
  { id: 'seedsep',       label: 'Seed separator',                      years: 6,  group: 'agri' },
  { id: 'irrigation',    label: 'Garden irrigation — movable',         years: 5,  group: 'agri' },
  { id: 'mower',         label: 'Motor mower',                         years: 5,  group: 'agri' },
  { id: 'milktanker',    label: 'Refrigerated milk-tanker',            years: 4,  group: 'agri' },
  { id: 'heatdryer',     label: 'Heat dryer',                          years: 6,  group: 'agri' },
  { id: 'racehorse',     label: 'Race horse',                          years: 4,  group: 'agri' },

  // ---------- Valuables, art & collectables ----------
  { id: 'painting',      label: 'Painting — valuable',                 years: 25, group: 'valuables', valuation: true },
  { id: 'artefact',      label: 'Artefact or antique',                 years: 25, group: 'valuables', valuation: true },
  { id: 'jewellery',     label: 'Jewellery',                           years: 6,  group: 'valuables', valuation: true,
    note: 'Not in the BGR 7 annexure — treated as furniture and fittings. Insurers want a valuation certificate.' },
  { id: 'watch',         label: 'Watch',                               years: 6,  group: 'valuables', valuation: true,
    note: 'Not in the BGR 7 annexure — treated as furniture and fittings. Insurers want a valuation certificate.' },
  { id: 'firearm',       label: 'Firearm',                             years: 6,  group: 'valuables' },
  { id: 'instrument',    label: 'Musical instrument',                  years: 5,  group: 'valuables' },
  { id: 'camera',        label: 'Photographic equipment',              years: 6,  group: 'valuables' },
  { id: 'tv',            label: 'Television, video or decoder',        years: 6,  group: 'leisure' },
  { id: 'sewing',        label: 'Sewing machine',                      years: 6,  group: 'furniture' },
  { id: 'knitting',      label: 'Knitting machine',                    years: 6,  group: 'plant' },

  // ---------- Sport & leisure ----------
  { id: 'gym_cardio',    label: 'Gym — cardiovascular equipment',      years: 2,  group: 'leisure' },
  { id: 'gym_weights',   label: 'Gym — weights & strength equipment',  years: 4,  group: 'leisure' },
  { id: 'gym_spin',      label: 'Gym — spinning equipment',            years: 1,  group: 'leisure' },
  { id: 'gym_health',    label: 'Gym — health testing equipment',      years: 5,  group: 'leisure' },
  { id: 'gym_other',     label: 'Gym — other equipment',               years: 10, group: 'leisure' },
  { id: 'cinema',        label: 'Cinema equipment',                    years: 5,  group: 'leisure' },
];

/* --- lookups --- */
const CAT_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

function categoriesByGroup() {
  const out = new Map();
  for (const key of Object.keys(GROUP_LABELS)) out.set(key, []);
  for (const c of CATEGORIES) out.get(c.group).push(c);
  for (const [k, v] of out) if (!v.length) out.delete(k);
  return out;
}

function indexRateFor(catId) {
  const c = CAT_BY_ID[catId];
  return (c && GROUP_INDEX[c.group]) ?? 0.06;
}

function depreciationRateFor(catId) {
  const c = CAT_BY_ID[catId];
  return (c && GROUP_DEPRECIATION[c.group]) ?? 0.12;
}

/* Items an insurer will normally insist go on agreed value with a certificate. */
function defaultBasisFor(catId) {
  const c = CAT_BY_ID[catId];
  return c && c.valuation ? 'agreed' : 'replacement';
}

/* Categories a household is likely to specify on an all-risk section. */
const WEALTH_CATEGORY_IDS = [
  'jewellery', 'watch', 'painting', 'artefact', 'camera', 'instrument',
  'bicycle', 'firearm', 'pc', 'tablet', 'cellphone', 'tv', 'pleasurecraft',
  'furniture', 'safe',
];

export {
  CATEGORIES, CAT_BY_ID, GROUP_LABELS, GROUP_INDEX, GROUP_DEPRECIATION,
  BASES, RESIDUAL_FLOOR, WEALTH_CATEGORY_IDS,
  SMALL_ITEM_THRESHOLD, VAT_RATE,
  categoriesByGroup, indexRateFor, depreciationRateFor, defaultBasisFor,
};
