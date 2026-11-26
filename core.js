// Pure OSM/unit/geometry/override/routing helpers shared by the app and tests.
export const BBOX = [33.4, -119, 34.85, -116.8];

export const OVERPASS_ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export const HEIGHT_MARGIN_M = 0.08; // ~3 inches safety clearance margin
export const OVERRIDE_RADIUS_M = 60; // legacy constant kept for compatibility
export const SPATIAL_OVERRIDE_RADIUS_M = 20; // tight spatial match radius for unlinked driver overrides
export const SPATIAL_AMBIGUITY_GAP_M = 15; // refuse spatial override when a competing nearby road is within this margin

const NON_ROAD_HIGHWAYS = new Set([
  'footway', 'cycleway', 'path', 'steps', 'pedestrian', 'bridleway',
  'corridor', 'elevator', 'escalator', 'platform', 'proposed', 'construction',
  'abandoned', 'razed', 'raceway', 'track',
]);

const NON_PUBLIC_SERVICES = new Set([
  'parking_aisle', 'driveway', 'drive-through', 'emergency_access', 'alley', 'parking',
]);
const NON_PUBLIC_ACCESS = new Set(['private', 'no', 'customers']);
const ALONG_ROAD_MAX_ANGLE_DEG = 20; // tight heading alignment (<= 20 deg) required for along-road travel
const ALONG_ROAD_MAX_LATERAL_M = 18; // tight lateral proximity (~1 roadway width) for along-road overlap
const ALONG_ROAD_MIN_OVERLAP_M = 8; // minimum shared longitudinal overlap unless shorter segment is >=50% overlapped
export const JUNCTION_CURB_SETBACK_M = 11; // legacy reference constant
export const MIN_DISPLAY_LENGTH_M = 6; // minimum visible display length preserved when trimming both ends
const MIN_TRIM_WAY_LENGTH_M = 35; // never trim short spans (e.g. underpasses/aprons)
const SHARED_VERTEX_EPS_DEG = 5e-7; // ~0.055 m exact 6-decimal OSM shared-node tolerance (rejects 1 m near-misses)
const FREEWAY_HIGHWAYS = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link']);

const NON_ROAD_POI_KEYS = ['aeroway', 'amenity', 'building', 'shop', 'tourism', 'leisure', 'parking', 'power'];
const IGNORED_LIMIT_VALUES = new Set(['default', 'none', 'no', 'unlimited', 'unsigned']);

export function buildOverpassQuery(bbox = BBOX) {
  const b = bbox.join(',');
  return (
    `[out:json][timeout:25];` +
    `(` +
    `way["highway"]["hgv"="no"](${b});` +
    `way["highway"]["hgv"="private"](${b});` +
    `way["highway"]["hgv"="destination"](${b});` +
    `way["highway"]["hgv"="delivery"](${b});` +
    `way["highway"]["goods"="no"](${b});` +
    `way["highway"]["hgv:conditional"](${b});` +
    `way["highway"]["motor_vehicle:conditional"](${b});` +
    `way["highway"]["maxheight"](${b});` +
    `way["highway"]["maxheight:physical"](${b});` +
    `way["highway"]["maxweight"](${b});` +
    `way["highway"]["maxweightrating"](${b});` +
    `way["highway"]["maxaxleload"](${b});` +
    `way["highway"]["maxlength"](${b});` +
    `way["highway"]["maxwidth"](${b});` +
    `node["highway"]["maxheight"](${b});` +
    `node["barrier"]["maxheight"](${b});` +
    `node["traffic_sign"]["maxheight"](${b});` +
    `);out geom;`
  );
}

export const QUERY = buildOverpassQuery(BBOX);

export function overpassTiles(bbox = BBOX, latSteps = 2, lonSteps = 2) {
  const [s, w, n, e] = bbox;
  const dlat = (n - s) / latSteps;
  const dlon = (e - w) / lonSteps;
  const tiles = [];
  for (let r = 0; r < latSteps; r++) {
    for (let c = 0; c < lonSteps; c++) {
      const tb = [
        Number((s + r * dlat).toFixed(4)),
        Number((w + c * dlon).toFixed(4)),
        Number((s + (r + 1) * dlat).toFixed(4)),
        Number((w + (c + 1) * dlon).toFixed(4)),
      ];
      const clat = (tb[0] + tb[2]) / 2;
      const clon = (tb[1] + tb[3]) / 2;
      const dist = (clat - 34.05) ** 2 + (clon + 118.24) ** 2;
      tiles.push({ dist, bbox: tb });
    }
  }
  tiles.sort((a, b) => a.dist - b.dist);
  return tiles.map(t => t.bbox);
}

export function isTruckRoadElement(e) {
  const tags = e?.tags || {};
  if (tags.aeroway || tags.location === 'roof' || tags.indoor === 'yes') return false;
  const hw = tags.highway;
  if (e?.type === 'way') {
    if (!hw || NON_ROAD_HIGHWAYS.has(hw)) return false;
    if (hw === 'service') {
      // Filter parking aisles, driveways, private/customer site roads, and unnamed parking-lot circulation lanes
      // so off-road/lot service ways are never rendered as public through-road truck bans.
      if (NON_PUBLIC_SERVICES.has(tags.service || '')) return false;
      if (NON_PUBLIC_ACCESS.has(tags.access || '') || tags.motor_vehicle === 'no') return false;
      if (!tags.name || !String(tags.name).trim()) return false;
    }
    return true;
  }
  if (e?.type === 'node') {
    if (hw && NON_ROAD_HIGHWAYS.has(hw)) return false;
    if (!hw && NON_ROAD_POI_KEYS.some(k => tags[k])) return false;
    return true;
  }
  if (e?.type === 'relation') {
    if (NON_ROAD_POI_KEYS.some(k => tags[k])) return false;
    return true;
  }
  return false;
}

export function parseLimit(raw, kind) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s || IGNORED_LIMIT_VALUES.has(s)) return null;
  if (!/^\d/.test(s) || /[;@<>]/.test(s)) return null;
  const v = parseFloat(s);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (kind === 'weight') {
    if (/^\d+(\.\d+)?\s*(lbs?|pounds?)$/.test(s)) return v * 0.00045359237;
    if (/^\d+(\.\d+)?\s*(st|short_tons?|us\s*tons?|tons?)$/.test(s)) return v * 0.90718474;
    if (/^\d+(\.\d+)?\s*kg$/.test(s)) return v / 1000;
    if (/^\d+(\.\d+)?\s*(t|tonnes?)?$/.test(s)) return v;
  } else {
    const feet = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|''|in)?)?$/);
    if (feet) return Number(feet[1]) * 0.3048 + Number(feet[2] || 0) * 0.0254;
    const inchesOnly = s.match(/^(\d+(?:\.\d+)?)\s*(?:"|''|in)$/);
    if (inchesOnly) return Number(inchesOnly[1]) * 0.0254;
    if (/^\d+(\.\d+)?\s*(ft|feet)$/.test(s)) return v * 0.3048;
    if (/^\d+(\.\d+)?\s*(m|meters?|metres?)?$/.test(s)) return v;
  }
  return null;
}

// Format meters by flooring to 2 decimal places so clearance is NEVER rounded UP.
export function formatMetersFloor(meters) {
  if (!Number.isFinite(meters) || meters <= 0) return '';
  const floored = Math.floor(meters * 100 + 1e-9) / 100;
  return floored.toFixed(2);
}

// Convert meters to feet/inches without ever rounding clearance UP.
export function formatHeightImperial(meters, raw = '') {
  if (raw) {
    const m = String(raw).trim().match(/^(\d+)\s*'\s*(?:(\d+)\s*(?:"|''|in)?)?$/i);
    if (m) return `${Number(m[1])}'${Number(m[2] || 0)}"`;
  }
  if (!Number.isFinite(meters) || meters <= 0) return '';
  const totalInches = Math.floor(meters / 0.0254 + 1e-6);
  const ft = Math.floor(totalInches / 12);
  const inch = totalInches % 12;
  return `${ft}'${inch}"`;
}

export function formatHeightBadge(meters, raw = '') {
  const imp = formatHeightImperial(meters, raw);
  return { imperial: imp, short: imp };
}

// Return integer pounds floored down (never rounds allowed weight UP).
export function formatWeightLbsNumber(tonnes, raw = '') {
  if (raw) {
    const m = String(raw).trim().match(/^(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)$/i);
    if (m) {
      const exactLbs = Math.floor(Number(m[1]) + 1e-6);
      if (exactLbs > 0) return exactLbs;
    }
  }
  if (!Number.isFinite(tonnes) || tonnes <= 0) return null;
  const lbs = Math.floor(tonnes * 2204.62262185 + 1e-6);
  return lbs > 0 ? lbs : null;
}

// Convert metric tonnes to pounds (lbs) without ever rounding allowed weight UP.
export function formatWeightLbs(tonnes, raw = '') {
  const lbs = formatWeightLbsNumber(tonnes, raw);
  return lbs != null ? `${lbs.toLocaleString('en-US')} lbs` : '';
}

export function formatWeightShort(tonnes, raw = '') {
  return formatWeightLbs(tonnes, raw);
}

// Prepare edit dialog input values using consistent flooring (never Math.round UP) and snapshot initial values
// so re-saving without changing a numeric field preserves the exact canonical stored value.
export function prepareEditFormFields(e = {}) {
  let heightInput = '';
  if (e.height > 0) {
    const savedFtMatch = typeof e.heightRaw === 'string' && e.heightRaw.match(/\(\s*(\d+(?:\.\d+)?)\s*ft\s*\)$/i);
    if (savedFtMatch) {
      heightInput = savedFtMatch[1];
    } else if (e.heightRaw && /^\d+\s*'\s*(?:\d+\s*(?:"|''|in)?)?$/i.test(String(e.heightRaw).trim())) {
      heightInput = String(e.heightRaw).trim();
    } else {
      heightInput = formatHeightImperial(e.height);
    }
  }
  let weightInput = '';
  if (e.weight > 0) {
    const flooredLbs = formatWeightLbsNumber(e.weight, e.weightRaw);
    if (flooredLbs != null) weightInput = String(flooredLbs);
  }
  return {
    type: e.type || 'cannot',
    heightInput,
    heightUnit: 'ft',
    weightInput,
    weightUnit: 'lb',
    notes: e.notes || '',
  };
}

// Resolve edit dialog submission: if the driver did not modify a limit's text/unit, keep the canonical value
// untouched so re-saving (e.g. editing notes only) can never inflate or drift height/weight limits.
export function resolveEditLimitSubmission(draft = {}, form = {}, initial = null) {
  const type = form.type || 'cannot';
  if (type !== 'restriction') {
    return { ok: true, height: null, heightRaw: undefined, weight: null, weightRaw: undefined };
  }
  const init = initial || prepareEditFormFields(draft);
  const rawH = String(form.heightInput ?? '').trim();
  const unitH = form.heightUnit || 'ft';
  const rawW = String(form.weightInput ?? '').trim();
  const unitW = form.weightUnit || 'lb';

  let height = null;
  let heightRaw;
  if (rawH) {
    if (rawH === init.heightInput && unitH === init.heightUnit && draft.height > 0) {
      height = draft.height;
      heightRaw = draft.heightRaw || undefined;
    } else {
      const parsedH = parseDriverDimensionInput(rawH, unitH);
      if (!parsedH) return { ok: false, error: '限高格式无效。请输入如 13\'5" 或 13.5（英尺 ft）。' };
      height = parsedH.value;
      heightRaw = parsedH.raw;
    }
  }

  let weight = null;
  let weightRaw;
  if (rawW) {
    if (rawW === init.weightInput && unitW === init.weightUnit && draft.weight > 0) {
      weight = draft.weight;
      weightRaw = draft.weightRaw || undefined;
    } else {
      const parsedW = parseDriverWeightInput(rawW, unitW);
      if (!parsedW) return { ok: false, error: '限重数值无效，请输入大于 0 的数字。' };
      weight = parsedW.value;
      weightRaw = parsedW.raw;
    }
  }

  return { ok: true, height, heightRaw, weight, weightRaw };
}

// Format a distance in meters for US driver display (ft / mi), never showing meters.
export function formatDistanceUS(meters) {
  if (!Number.isFinite(meters) || meters < 0) return '';
  const feet = Math.round(meters * 3.280839895);
  if (feet >= 1000) {
    const miles = meters / 1609.344;
    return `${miles.toFixed(miles >= 10 ? 1 : 2)} mi`;
  }
  const roundedFt = feet >= 100 ? Math.round(feet / 10) * 10 : Math.max(10, feet);
  return `${roundedFt} ft`;
}

export function parseDriverDimensionInput(raw, unit) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Support round-trip of saved decimal-feet labels such as `13'6" (13.5 ft)`
  const savedFt = s.match(/^\d+\s*'\s*(?:\d+\s*(?:"|''|in)?)?\s*\(\s*(\d+(?:\.\d+)?)\s*ft\s*\)$/i);
  if (savedFt) {
    const n = Number(savedFt[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    const meters = n * 0.3048;
    return { value: meters, raw: `${formatHeightImperial(meters)} (${n} ft)` };
  }
  if (/'/.test(s)) {
    const m = parseLimit(s, 'height');
    return m ? { value: m, raw: s } : null;
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (unit === 'ft') {
    const meters = n * 0.3048;
    return { value: meters, raw: `${formatHeightImperial(meters)} (${n} ft)` };
  }
  return { value: n, raw: `${n} m` };
}

export function parseDriverWeightInput(raw, unit) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (unit === 'lb') return { value: n * 0.00045359237, raw: `${n} lb` };
  if (unit === 'short_ton') return { value: n * 0.90718474, raw: `${n} short ton` };
  return { value: n, raw: `${n} t` };
}

export function vehicleFromForm(v = {}) {
  const toTonnes = (val, unit) => {
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0) return null;
    const u = unit || 'lb';
    return n * (u === 'lb' ? 0.00045359237 : u === 'short_ton' ? 0.90718474 : 1);
  };
  const toMeters = (val, unit) => {
    if (val == null || String(val).trim() === '') return null;
    if (typeof val === 'string' && /'/.test(val)) return parseLimit(val, 'height');
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0) return null;
    const u = unit || 'ft';
    return n * (u === 'm' ? 1 : 0.3048);
  };
  return {
    weight: toTonnes(v.weight, v.weightUnit),
    height: toMeters(v.height, v.heightUnit),
    length: toMeters(v.length, v.lengthUnit),
    width: toMeters(v.width, v.widthUnit),
    axle: toTonnes(v.axle, v.axleUnit),
  };
}

// Migrate legacy metric/ton vehicle profiles to US units (ft / lb) while preserving actual physical size.
// Rounds vehicle dimensions/weights conservatively UP by minimal step so a truck is never under-reported for clearance/weight checks.
export function migrateVehicleProfile(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const profile = {};
  let migrated = false;

  for (const k of ['height', 'length', 'width']) {
    const valStr = String(src[k] ?? '').trim();
    const rawUnit = src[k + 'Unit'];
    if (!valStr) {
      profile[k] = '';
      profile[k + 'Unit'] = 'ft';
      if (rawUnit && rawUnit !== 'ft') migrated = true;
      continue;
    }
    if (rawUnit === 'm' && !/'/.test(valStr)) {
      const meters = Number(valStr);
      if (Number.isFinite(meters) && meters > 0) {
        // 4-decimal feet ceiling preserves meter precision to <0.02 mm and never shrinks vehicle size.
        const ft = Math.ceil((meters / 0.3048) * 10000 - 1e-9) / 10000;
        profile[k] = String(ft);
        profile[k + 'Unit'] = 'ft';
        migrated = true;
        continue;
      }
    }
    profile[k] = valStr;
    profile[k + 'Unit'] = 'ft';
    if (rawUnit !== 'ft') migrated = true;
  }

  for (const k of ['weight', 'axle']) {
    const valStr = String(src[k] ?? '').trim();
    const rawUnit = src[k + 'Unit'];
    if (!valStr) {
      profile[k] = '';
      profile[k + 'Unit'] = 'lb';
      if (rawUnit && rawUnit !== 'lb') migrated = true;
      continue;
    }
    if (rawUnit === 't' || rawUnit === 'short_ton') {
      const n = Number(valStr);
      if (Number.isFinite(n) && n > 0) {
        const tonnes = rawUnit === 'short_ton' ? n * 0.90718474 : n;
        const lbs = Math.ceil(tonnes * 2204.62262185 - 1e-6);
        profile[k] = String(lbs);
        profile[k + 'Unit'] = 'lb';
        migrated = true;
        continue;
      }
    }
    profile[k] = valStr;
    profile[k + 'Unit'] = 'lb';
    if (rawUnit !== 'lb') migrated = true;
  }

  return { profile, migrated };
}

export function restrictions(tags = {}) {
  const out = [];
  if (/^(no|private|destination|delivery)$/.test(tags.hgv || '')) {
    out.push({ kind: 'ban', raw: tags.hgv, value: null, conditional: tags.hgv !== 'no' });
  }
  if (tags.goods === 'no') {
    out.push({ kind: 'ban', raw: 'goods=no', value: null, conditional: false });
  }
  for (const key of ['hgv:conditional', 'motor_vehicle:conditional']) {
    if (tags[key]) out.push({ kind: 'ban', raw: tags[key], value: null, conditional: true });
  }
  const fields = [
    ['maxheight', 'height'],
    ['maxheight:physical', 'height'],
    ['maxweight', 'weight'],
    ['maxweightrating', 'weight'],
    ['maxaxleload', 'axle'],
    ['maxlength', 'length'],
    ['maxwidth', 'width'],
  ];
  for (const [key, kind] of fields) {
    const raw = tags[key];
    if (raw == null) continue;
    const norm = String(raw).trim().toLowerCase();
    if (!norm || IGNORED_LIMIT_VALUES.has(norm)) continue;
    out.push({
      kind,
      raw: String(raw).trim(),
      value: parseLimit(raw, kind === 'axle' ? 'weight' : kind),
      key,
    });
  }
  return out;
}

export function relevant(r, v = {}) {
  if (r.kind === 'ban' || r.key === 'maxweightrating' || r.value == null) return true;
  if (r.kind === 'axle') return !v.axle || v.axle > r.value;
  if (r.kind === 'height') return !v.height || (v.height + HEIGHT_MARGIN_M) >= r.value;
  if (r.kind === 'width') return !v.width || v.width >= r.value;
  return !v[r.kind] || v[r.kind] > r.value;
}

function formatComplexUnparsedLimit(raw, kind) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const isConditional = s.includes('@');
  const valuePortion = isConditional ? s.split('@')[0].trim() : s;
  if (!valuePortion) return null;
  const parts = valuePortion.split(';').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const parseKind = kind === 'axle' ? 'weight' : kind;
  const formatted = [];
  for (const part of parts) {
    const parsed = parseLimit(part, parseKind);
    if (parsed == null) return null;
    const text = (kind === 'weight' || kind === 'axle')
      ? formatWeightLbs(parsed, part)
      : formatHeightImperial(parsed, part);
    if (!text) return null;
    if (!formatted.includes(text)) formatted.push(text);
  }
  if (!formatted.length) return null;
  return { text: formatted.join(' / '), isConditional };
}

function formatConditionalBanLabel(raw) {
  const s = String(raw || '').trim();
  const low = s.toLowerCase();
  if (low === 'private') return '有条件限行：仅限私路车辆（需核实）';
  if (low === 'destination') return '有条件限行：仅限目的地通行（需核实）';
  if (low === 'delivery') return '有条件限行：仅限送货通行（需核实）';
  // Never leak raw metric/ton numeric expressions such as `no @ (weight>3)` or `designated @ (weight<7st)`.
  if (/\b(?:max)?(?:weight|height|length|width|axle)\b/i.test(s) || /\d\s*(?:m|cm|mm|kg|t|st|tons?|tonnes?)\b/i.test(s)) {
    return '有条件限行（限制值需核实）';
  }
  return s ? `有条件限行：${s}` : '有条件限行（需核实）';
}

export function label(r) {
  if (r.kind === 'ban') {
    if (r.driverOverride) return r.conditional ? `司机限行：${r.raw}` : `司机禁行（${r.raw}）`;
    return r.conditional ? formatConditionalBanLabel(r.raw) : '卡车禁行 (No Trucks)';
  }
  const name = { weight: '限重', axle: '轴重', height: '限高', length: '限长', width: '限宽' }[r.kind] || '限行';
  const prefix = r.driverOverride ? '司机纠偏' : '';
  if (r.value == null) {
    const complex = formatComplexUnparsedLimit(r.raw, r.kind);
    if (complex) {
      const suffix = complex.isConditional ? '（条件限行，需核实）' : '（需核实）';
      return `${prefix}${name} ${complex.text}${suffix}`;
    }
    // Never output raw metric/ton or unparseable numeric strings to drivers.
    return `${prefix}${name} 限制值需核实`;
  }
  let unit;
  if (r.kind === 'weight' || r.kind === 'axle') {
    unit = formatWeightLbs(r.value, r.raw);
  } else {
    unit = formatHeightImperial(r.value, r.raw);
  }
  return `${prefix}${name} ${unit}${r.key === 'maxweightrating' ? '（额定总重，需核实）' : ''}`;
}

export function polylineLength(coords = []) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += distance(coords[i - 1], coords[i]);
  return total;
}

function trimFromStart(coords, trimM) {
  if (trimM <= 0 || coords.length < 2) return coords;
  let remaining = trimM;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const segLen = distance(a, b);
    if (segLen <= 0) continue;
    if (remaining < segLen) {
      const t = remaining / segLen;
      const pt = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      return [pt, ...coords.slice(i + 1)];
    }
    remaining -= segLen;
  }
  return coords;
}

// Trim start and/or end of a polyline along its own exact segments without inventing off-way geometry or altering node order.
// Unified with trimTerminalOverhangs: preserves at least `minRemainingM` of visible display length by proportional scaling
// instead of reverting to untrimmed coordinates.
export function trimPolylineEnds(coords = [], trimStartM = 0, trimEndM = 0, minRemainingM = MIN_DISPLAY_LENGTH_M) {
  if (!Array.isArray(coords) || coords.length < 2) return coords;
  const total = polylineLength(coords);
  const maxTotalTrim = Math.max(0, total - minRemainingM);
  if (total <= minRemainingM || maxTotalTrim <= 0) return coords;
  let sTrim = Math.max(0, trimStartM);
  let eTrim = Math.max(0, trimEndM);
  if (sTrim <= 0 && eTrim <= 0) return coords;
  if (sTrim + eTrim > maxTotalTrim) {
    const scale = maxTotalTrim / (sTrim + eTrim);
    sTrim *= scale;
    eTrim *= scale;
  }
  let next = sTrim > 0 ? trimFromStart(coords, sTrim) : coords;
  if (eTrim > 0) {
    next = trimFromStart([...next].reverse(), eTrim).reverse();
  }
  return next;
}

const ROAD_HALF_WIDTH_BY_HIGHWAY_M = {
  motorway: 12,
  trunk: 12,
  primary: 10.5,
  secondary: 9,
  tertiary: 7.5,
  unclassified: 6,
  residential: 6,
  service: 4.5,
};

// Estimate half-width (centerline to curb, meters) of a crossing road from genuine OSM width / lanes / highway tags.
export function estimateRoadHalfWidthMeters(tags = {}) {
  if (tags.width != null && String(tags.width).trim() !== '') {
    const w = parseLimit(String(tags.width).split(';')[0].trim(), 'width');
    if (Number.isFinite(w) && w > 0) {
      return Math.max(3, Math.min(25, w / 2));
    }
  }
  if (tags.lanes != null && String(tags.lanes).trim() !== '') {
    const n = Number(String(tags.lanes).split(';')[0].trim());
    if (Number.isFinite(n) && n > 0) {
      return Math.max(4, Math.min(22, (n * 3.5) / 2 + 1.5));
    }
  }
  const baseHw = String(tags.highway || '').replace(/_link$/, '');
  return ROAD_HALF_WIDTH_BY_HIGHWAY_M[baseHw] ?? 7;
}

function isEligibleForJunctionTrim(f) {
  if (!f || f.osmType !== 'way' || !Array.isArray(f.coords) || f.coords.length < 2) return false;
  const tags = f.tags || {};
  if (FREEWAY_HIGHWAYS.has(tags.highway || '')) return false;
  if (tags.bridge === 'yes' || tags.bridge === 'viaduct' || tags.tunnel === 'yes' || tags.tunnel === 'building_passage') return false;
  // Trim surface road bans and weight/axle/length/width segments; leave maxheight-only underpass spans untouched.
  const hasRoadwayRestriction = (f.restrictions || []).some(r => r.kind !== 'height');
  if (!hasRoadwayRestriction) return false;
  return polylineLength(f.coords) >= MIN_TRIM_WAY_LENGTH_M;
}

function restrictionContinuityKey(f) {
  return (f.restrictions || [])
    .map(r => `${r.kind}:${r.conditional ? 'c' : 'h'}:${r.value != null ? r.value.toFixed(2) : ''}`)
    .sort()
    .join('|');
}

function endpointOutwardBearing(coords, isStart) {
  if (isStart) {
    for (let i = 1; i < coords.length; i++) {
      if (distance(coords[0], coords[i]) >= 0.5) return bearing(coords[i], coords[0]);
    }
    return bearing(coords[1], coords[0]);
  }
  const last = coords.length - 1;
  for (let i = last - 1; i >= 0; i--) {
    if (distance(coords[last], coords[i]) >= 0.5) return bearing(coords[i], coords[last]);
  }
  return bearing(coords[last - 1], coords[last]);
}

function buildWayGrid(ways) {
  const grid = new Map();
  const cellKey = (lat, lon) => `${Math.floor(lat * 1000)},${Math.floor(lon * 1000)}`;
  for (const w of ways) {
    const seen = new Set();
    for (const p of w.coords) {
      const k = cellKey(p[0], p[1]);
      if (!seen.has(k)) {
        seen.add(k);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(w);
      }
    }
  }
  return grid;
}

function getNearbyWays(grid, pt, selfId) {
  const r = Math.floor(pt[0] * 1000);
  const c = Math.floor(pt[1] * 1000);
  const out = new Map();
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const list = grid.get(`${r + dr},${c + dc}`);
      if (!list) continue;
      for (const o of list) {
        if (o.id !== selfId) out.set(o.id, o);
      }
    }
  }
  return [...out.values()];
}

// Verify an EXACT shared node between `w`'s terminal endpoint and `o` — never 2 m spatial proximity.
// Uses explicit OSM node IDs when present on both ways; otherwise requires exact shared vertex coordinate (<= 5e-7 deg / ~5.5 cm).
function findSharedNodeContact(w, isStart, o) {
  const pt = isStart ? w.coords[0] : w.coords[w.coords.length - 1];
  const wNodes = Array.isArray(w.nodes) && w.nodes.length === w.coords.length ? w.nodes : null;
  const oNodes = Array.isArray(o.nodes) && o.nodes.length === o.coords.length ? o.nodes : null;
  let matchIdx = -1;
  let sharedNodeId = null;

  if (wNodes && oNodes) {
    const srcNodeId = isStart ? wNodes[0] : wNodes[wNodes.length - 1];
    matchIdx = oNodes.indexOf(srcNodeId);
    if (matchIdx === -1) return null;
    sharedNodeId = srcNodeId;
  } else {
    for (let i = 0; i < o.coords.length; i++) {
      if (
        Math.abs(pt[0] - o.coords[i][0]) <= SHARED_VERTEX_EPS_DEG &&
        Math.abs(pt[1] - o.coords[i][1]) <= SHARED_VERTEX_EPS_DEG
      ) {
        matchIdx = i;
        break;
      }
    }
    if (matchIdx === -1) return null;
  }

  const last = o.coords.length - 1;
  const isEndpoint = matchIdx === 0 || matchIdx === last;
  const bearings = [];
  if (matchIdx === 0) {
    bearings.push(endpointOutwardBearing(o.coords, true));
  } else if (matchIdx === last) {
    bearings.push(endpointOutwardBearing(o.coords, false));
  } else {
    if (distance(o.coords[matchIdx - 1], o.coords[matchIdx]) >= 0.5) {
      bearings.push(bearing(o.coords[matchIdx - 1], o.coords[matchIdx]));
    }
    if (distance(o.coords[matchIdx], o.coords[matchIdx + 1]) >= 0.5) {
      bearings.push(bearing(o.coords[matchIdx], o.coords[matchIdx + 1]));
    }
    if (!bearings.length) bearings.push(bearing(o.coords[0], o.coords[last]));
  }
  return { matchIdx, isEndpoint, bearings, sharedNodeId };
}

function acuteAngleDiff(b1, b2) {
  const diff = Math.abs(b1 - b2) % 180;
  return Math.min(diff, 180 - diff);
}

// Classify one endpoint of way `w` using ONLY verified shared-node topology (in-dataset shared vertex/node ID
// or verified OSM `sharedNodeId` in `junctionMap`) — never 2 m proximity alone:
// - 'continuation': same-street (or collinear unnamed same-restriction) end-to-end shared node -> NEVER trim (0 m gap)
// - 'junction': T-junction or crossing street sharing this terminal node -> trim displayCoords by cross-street half-width
// - 'open': no verified shared-node junction (dead end, noexit=yes, near-miss, restriction terminus) -> NEVER trim
export function classifyWayEndpoint(w, isStart, nearbyWays, junctionMap = {}) {
  const bW = endpointOutwardBearing(w.coords, isStart);
  const wName = normalizeRoadName(w.tags?.name);
  const wSig = restrictionContinuityKey(w);

  let bestCrossing = null;

  for (const o of nearbyWays) {
    const contact = findSharedNodeContact(w, isStart, o);
    if (!contact) continue;
    const ang = Math.max(...contact.bearings.map(bO => acuteAngleDiff(bW, bO)));
    const oName = normalizeRoadName(o.tags?.name);
    const oSig = restrictionContinuityKey(o);

    // Same-street continuation requires endpoint-to-endpoint shared node + collinear heading (<= 35 deg)
    // + either same street name OR both unnamed with identical restriction continuity.
    if (contact.isEndpoint && ang <= 35) {
      const sameNamed = Boolean(wName && oName && wName === oName);
      const sameUnnamed = Boolean(!wName && !oName && wSig === oSig);
      if (sameNamed || sameUnnamed) {
        return { kind: 'continuation', trimM: 0, evidence: { source: 'dataset', otherId: o.id, sharedNodeId: contact.sharedNodeId } };
      }
    }

    // Crossing / T-junction sharing this exact node: hits interior of `o`, or meets at crossing angle > 35 deg,
    // or different-named street meeting at > 25 deg.
    const isCrossing = !contact.isEndpoint || ang > 35 || (wName && oName && wName !== oName && ang > 25);
    if (isCrossing) {
      const halfW = estimateRoadHalfWidthMeters(o.tags || {});
      if (!bestCrossing || halfW > bestCrossing.trimM) {
        bestCrossing = {
          kind: 'junction',
          trimM: halfW,
          evidence: {
            source: 'dataset',
            crossRef: o.osmRef,
            sharedNodeId: contact.sharedNodeId,
            highway: o.tags?.highway,
            name: o.tags?.name,
            lanes: o.tags?.lanes,
            width: o.tags?.width,
            angle: Number(ang.toFixed(1)),
          },
        };
      }
    }
  }

  if (bestCrossing) return bestCrossing;

  // Check verified real OSM shared-node junction evidence (requires explicit `sharedNodeId`)
  const jRec = junctionMap?.[w.osmRef]?.[isStart ? 'start' : 'end'];
  if (jRec && jRec.sharedNodeId != null && (jRec.highway || jRec.width || jRec.lanes)) {
    return {
      kind: 'junction',
      trimM: estimateRoadHalfWidthMeters(jRec),
      evidence: { source: 'osm_junction', ...jRec },
    };
  }

  return { kind: 'open', trimM: 0, evidence: null };
}

// Compute display-only curb-trimmed geometry (`displayCoords`) without EVER altering canonical `coords`
// used for routing, alerts, and override matching.
// Only trims endpoints with verified shared-node crossing/T-junction evidence; dead ends & near-misses stay full length.
export function trimTerminalOverhangs(features = [], junctionMap = {}) {
  const ways = features.filter(f => f && f.osmType === 'way' && Array.isArray(f.coords) && f.coords.length >= 2);
  if (!ways.length) return features;
  const grid = buildWayGrid(ways);

  return features.map(f => {
    if (!isEligibleForJunctionTrim(f)) {
      return { ...f, displayCoords: f.coords, junctionTrim: null };
    }
    const totalLen = polylineLength(f.coords);
    const startInfo = classifyWayEndpoint(f, true, getNearbyWays(grid, f.coords[0], f.id), junctionMap);
    const endInfo = classifyWayEndpoint(f, false, getNearbyWays(grid, f.coords[f.coords.length - 1], f.id), junctionMap);

    let trimStart = startInfo.kind === 'junction' ? startInfo.trimM : 0;
    let trimEnd = endInfo.kind === 'junction' ? endInfo.trimM : 0;

    // Unified trim cap: preserve at least MIN_DISPLAY_LENGTH_M (6 m) visible display line
    const maxTotalTrim = Math.max(0, totalLen - MIN_DISPLAY_LENGTH_M);
    if (trimStart + trimEnd > maxTotalTrim) {
      const scale = (trimStart + trimEnd) > 0 ? maxTotalTrim / (trimStart + trimEnd) : 0;
      trimStart *= scale;
      trimEnd *= scale;
    }

    if (trimStart <= 0 && trimEnd <= 0) {
      return { ...f, displayCoords: f.coords, junctionTrim: null };
    }
    const displayCoords = trimPolylineEnds(f.coords, trimStart, trimEnd, MIN_DISPLAY_LENGTH_M);
    return {
      ...f,
      // Canonical `coords` remains 100% UNTRIMMED for routing, alerts, and overrides!
      displayCoords,
      junctionTrim: {
        startM: trimStart,
        endM: trimEnd,
        startEvidence: startInfo.evidence,
        endEvidence: endInfo.evidence,
      },
    };
  });
}

export function fromOverpass(data) {
  if (!Array.isArray(data?.elements) || data.remark) throw Error('OSM 数据为空或不完整');
  const out = [];
  for (const e of data.elements) {
    if (!isTruckRoadElement(e)) continue;
    const rs = restrictions(e.tags || {});
    if (!rs.length) continue;
    const geoms = e.geometry
      ? [e.geometry]
      : e.type === 'node'
        ? [[{ lat: e.lat, lon: e.lon }]]
        : (e.members || []).filter(m => m.geometry).map(m => m.geometry);
    geoms.forEach((g, i) => {
      const coords = g
        .filter(p => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
        .map(p => [p.lat, p.lon]);
      if (coords.length) {
        out.push({
          id: `${e.type}/${e.id}/${i}`,
          osmRef: `${e.type}/${e.id}`,
          osmType: e.type,
          osmId: e.id,
          ...(Array.isArray(e.nodes) && e.nodes.length === coords.length ? { nodes: e.nodes } : {}),
          isServiceRoad: e.tags?.highway === 'service',
          tags: e.tags || {},
          coords,
          displayCoords: coords,
          restrictions: rs,
        });
      }
    });
  }
  return trimTerminalOverhangs(out, data.junctions || {});
}

export function distance(a, b) {
  const r = Math.PI / 180;
  const dl = (b[0] - a[0]) * r;
  const dn = (b[1] - a[1]) * r;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dn / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function nearLine(p, coords) {
  let best = Infinity;
  let closest = coords[0];
  const kx = 111320 * Math.cos(p[0] * Math.PI / 180);
  const ky = 111320;
  if (coords.length === 1) return { distance: distance(p, coords[0]), point: coords[0] };
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky;
    const bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) {
      best = d;
      closest = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    }
  }
  return { distance: best, point: closest };
}

function pointToSeg2D(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return { dist: Math.hypot(px - cx, py - cy), t };
}

// Shortest distance (meters) between two segments [a1, a2] and [b1, b2], returning closest point on segment A.
export function segmentDistance(a1, a2, b1, b2) {
  const refLat = (a1[0] + a2[0] + b1[0] + b2[0]) / 4;
  const kx = 111320 * Math.cos(refLat * Math.PI / 180);
  const ky = 111320;
  const rx = (a2[1] - a1[1]) * kx, ry = (a2[0] - a1[0]) * ky;
  const q1x = (b1[1] - a1[1]) * kx, q1y = (b1[0] - a1[0]) * ky;
  const q2x = (b2[1] - a1[1]) * kx, q2y = (b2[0] - a1[0]) * ky;
  const sx = q2x - q1x, sy = q2y - q1y;

  // Proper intersection test: p1 + t*r = q1 + u*s
  const rxs = rx * sy - ry * sx;
  if (Math.abs(rxs) > 1e-9) {
    const t = (q1x * sy - q1y * sx) / rxs;
    const u = (q1x * ry - q1y * rx) / rxs;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      return { distance: 0, point: [a1[0] + t * (a2[0] - a1[0]), a1[1] + t * (a2[1] - a1[1])] };
    }
  }

  // Non-intersecting (including collinear/parallel overlap): min of 4 endpoint-to-segment distances.
  let bestDist = Infinity;
  let bestPoint = a1;

  const c1 = pointToSeg2D(0, 0, q1x, q1y, q2x, q2y);
  if (c1.dist < bestDist) { bestDist = c1.dist; bestPoint = a1; }

  const c2 = pointToSeg2D(rx, ry, q1x, q1y, q2x, q2y);
  if (c2.dist < bestDist) { bestDist = c2.dist; bestPoint = a2; }

  const c3 = pointToSeg2D(q1x, q1y, 0, 0, rx, ry);
  if (c3.dist < bestDist) {
    bestDist = c3.dist;
    bestPoint = [a1[0] + c3.t * (a2[0] - a1[0]), a1[1] + c3.t * (a2[1] - a1[1])];
  }

  const c4 = pointToSeg2D(q2x, q2y, 0, 0, rx, ry);
  if (c4.dist < bestDist) {
    bestDist = c4.dist;
    bestPoint = [a1[0] + c4.t * (a2[0] - a1[0]), a1[1] + c4.t * (a2[1] - a1[1])];
  }

  return { distance: bestDist, point: bestPoint };
}

function coordsBbox(coords) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const p of coords) {
    if (p[0] < s) s = p[0];
    if (p[0] > n) n = p[0];
    if (p[1] < w) w = p[1];
    if (p[1] > e) e = p[1];
  }
  return [s, w, n, e];
}

// Shortest distance (meters) between two polylines (or point & polyline), returning closest point on coordsA.
export function polylineDistance(coordsA, coordsB) {
  if (!coordsA?.length || !coordsB?.length) return { distance: Infinity, point: null };
  if (coordsA.length === 1) {
    const n = nearLine(coordsA[0], coordsB);
    return { distance: n.distance, point: coordsA[0] };
  }
  if (coordsB.length === 1) {
    return nearLine(coordsB[0], coordsA);
  }
  let bestDist = Infinity;
  let bestPoint = coordsA[0];
  for (let i = 1; i < coordsA.length; i++) {
    const a1 = coordsA[i - 1], a2 = coordsA[i];
    for (let j = 1; j < coordsB.length; j++) {
      const res = segmentDistance(a1, a2, coordsB[j - 1], coordsB[j]);
      if (res.distance < bestDist) {
        bestDist = res.distance;
        bestPoint = res.point;
        if (bestDist === 0) return { distance: 0, point: bestPoint };
      }
    }
  }
  return { distance: bestDist, point: bestPoint };
}

export function featureMidpoint(coords) {
  if (!coords?.length) return null;
  if (coords.length === 1) return coords[0];
  let total = 0;
  const segs = [];
  for (let i = 1; i < coords.length; i++) {
    const len = distance(coords[i - 1], coords[i]);
    segs.push(len);
    total += len;
  }
  if (total === 0) return coords[0];
  let half = total / 2;
  for (let i = 0; i < segs.length; i++) {
    if (half <= segs[i]) {
      const t = segs[i] ? half / segs[i] : 0;
      const a = coords[i], b = coords[i + 1];
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    }
    half -= segs[i];
  }
  return coords[Math.floor(coords.length / 2)];
}

export function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
  const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

export function approaching(p, heading, line, previous) {
  const n = nearLine(p, line);
  if (n.distance < 25) return true;
  if (previous != null && n.distance > previous + 10) return false;
  if (heading == null || !Number.isFinite(heading)) return previous != null && n.distance < previous - 2;
  const diff = Math.abs(((bearing(p, n.point) - heading + 540) % 360) - 180);
  return diff < 85;
}

export function validEdit(e) {
  return Boolean(
    e &&
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    e.id.length < 100 &&
    ['can', 'cannot', 'restriction'].includes(e.type) &&
    Number.isFinite(e.lat) &&
    e.lat >= BBOX[0] &&
    e.lat <= BBOX[2] &&
    Number.isFinite(e.lng) &&
    e.lng >= BBOX[1] &&
    e.lng <= BBOX[3] &&
    typeof e.notes === 'string' &&
    e.notes.length <= 500 &&
    ['weight', 'height'].every(k => e[k] == null || (Number.isFinite(e[k]) && e[k] > 0 && e[k] < 100000))
  );
}

export function validateEditDraft(item) {
  if (!validEdit(item)) return { ok: false, error: '标记格式、数值或坐标无效（需在大洛杉矶范围内）。' };
  if (item.type === 'restriction' && !(item.weight > 0) && !(item.height > 0)) {
    return { ok: false, error: '「新限行点」请至少填写一项限高或限重数值；若仅标记禁行请选择「不能通过」。' };
  }
  return { ok: true };
}

export function editFeature(e) {
  let rs = [];
  if (e.type === 'cannot') {
    rs = [{ kind: 'ban', raw: e.notes ? e.notes.slice(0, 40) : '司机报告禁行', value: null, conditional: false, driverOverride: true }];
  } else if (e.type === 'restriction') {
    if (e.height > 0) {
      rs.push({ kind: 'height', raw: e.heightRaw || formatHeightImperial(e.height), value: e.height, driverOverride: true });
    }
    if (e.weight > 0) {
      rs.push({ kind: 'weight', raw: e.weightRaw || formatWeightLbs(e.weight), value: e.weight, driverOverride: true });
    }
    if (!rs.length) {
      // Defense in depth: never silently ignore a saved restriction marker with empty numeric fields.
      rs.push({ kind: 'ban', raw: e.notes ? e.notes.slice(0, 40) : '司机限行点（需核实）', value: null, conditional: true, driverOverride: true });
    }
  }
  return {
    id: `driver/${e.id}`,
    driverEditId: e.id,
    isDriverEdit: true,
    coords: [[e.lat, e.lng]],
    tags: { name: e.roadName || '司机标记（本地纠偏）', notes: e.notes || '' },
    restrictions: rs,
  };
}

// Driver corrections override underlying OSM restrictions in display, alerts, and routing.
// Matching rules (safety-first):
// - Explicit target (osmFeatureId / osmRef): applies ONLY to that exact OSM feature; never falls through spatially.
// - Unlinked edits (no osmFeatureId and no osmRef):
//   - "can" (can-pass) NEVER spatially suppresses a nearby OSM restriction, because unrestricted roads are absent
//     from the restriction dataset and a point on a legal road 11 m away must never un-ban its neighbor.
//   - "cannot" / "restriction" become standalone driver features at their exact location so they still warn/block
//     without accidentally weakening or corrupting a neighboring OSM road.
// Composition rules:
// - Multiple edits matching the same feature fold chronologically by restriction kind (height/weight/ban),
//   so adding a height correction preserves an existing weight correction (and vice versa).
export function applyDriverOverrides(osmFeatures = [], driverEdits = []) {
  const sortedEdits = [...driverEdits].sort((a, b) => (a.updated_at || '').localeCompare(b.updated_at || ''));
  const featureMatches = new Map();
  const matchedEditIds = new Set();

  for (const e of sortedEdits) {
    const hasExplicitTarget = Boolean(e.osmFeatureId || e.osmRef);
    if (!hasExplicitTarget) {
      // Unlinked edits never spatially overwrite/suppress OSM features.
      // ("can" remains an informational driver pin; "cannot"/"restriction" become standalone active restrictions below.)
      continue;
    }
    let matchedAny = false;
    for (const f of osmFeatures) {
      const isMatch = e.osmFeatureId ? f.id === e.osmFeatureId : f.osmRef === e.osmRef;
      if (isMatch) {
        if (!featureMatches.has(f.id)) featureMatches.set(f.id, []);
        featureMatches.get(f.id).push(e);
        matchedAny = true;
      }
    }
    if (matchedAny) matchedEditIds.add(e.id);
  }

  const osmEntries = [];
  const effectiveFeatures = [];

  for (const f of osmFeatures) {
    const matches = featureMatches.get(f.id) || [];
    if (!matches.length) {
      osmEntries.push({
        feature: f,
        overrideType: null,
        overriddenBy: null,
        appliedEdits: [],
        effectiveRestrictions: f.restrictions,
      });
      effectiveFeatures.push(f);
      continue;
    }

    // Chronologically compose all matching edits by restriction kind.
    let currentRs = [...f.restrictions];
    let suppressed = false;
    let overrideType = null;
    let overriddenBy = null;

    for (const edit of matches) {
      overriddenBy = edit;
      if (edit.type === 'can') {
        suppressed = true;
        currentRs = [];
        overrideType = 'can';
        continue;
      }
      if (edit.type === 'cannot') {
        suppressed = false;
        const driverBan = editFeature(edit).restrictions[0];
        currentRs = [driverBan, ...currentRs.filter(r => r.kind !== 'ban')];
        overrideType = 'cannot';
        continue;
      }
      // type === 'restriction': update only matching kinds (height / weight / fallback ban), preserving others.
      suppressed = false;
      const driverRs = editFeature(edit).restrictions;
      const hasDriverHeight = driverRs.some(r => r.kind === 'height');
      const hasDriverWeight = driverRs.some(r => r.kind === 'weight');
      const hasDriverBan = driverRs.some(r => r.kind === 'ban');
      currentRs = currentRs.filter(r => {
        if (hasDriverHeight && r.kind === 'height') return false;
        if (hasDriverWeight && r.kind === 'weight') return false;
        if (hasDriverBan && r.kind === 'ban') return false;
        return true;
      });
      currentRs = [...driverRs, ...currentRs];
      overrideType = currentRs.some(r => r.driverOverride && r.kind === 'ban') ? 'cannot' : 'restriction';
    }

    if (suppressed) {
      osmEntries.push({
        feature: f,
        overrideType: 'can',
        overriddenBy,
        appliedEdits: matches,
        effectiveRestrictions: [],
      });
      // Suppressed: do NOT push to effectiveFeatures (no alerts, no route blocking).
      continue;
    }

    const eff = { ...f, restrictions: currentRs, overriddenBy, appliedEdits: matches };
    osmEntries.push({
      feature: f,
      overrideType,
      overriddenBy,
      appliedEdits: matches,
      effectiveRestrictions: currentRs,
    });
    effectiveFeatures.push(eff);
  }

  // Add standalone driver edits (cannot / restriction) that did not merge onto an OSM feature.
  for (const e of sortedEdits) {
    if (matchedEditIds.has(e.id)) continue;
    const df = editFeature(e);
    if (df.restrictions.length) effectiveFeatures.push(df);
  }

  return { osmEntries, effectiveFeatures, matchedEditIds };
}

function restrictionPriority(f, vehicle) {
  const rel = f.restrictions.filter(r => relevant(r, vehicle));
  if (rel.some(r => r.driverOverride && r.kind === 'ban')) return 0;
  if (rel.some(r => r.kind === 'ban' && !r.conditional)) return 1;
  if (rel.some(r => r.kind === 'height' && r.value != null)) return 2;
  if (rel.some(r => r.driverOverride)) return 2;
  if (rel.some(r => r.kind === 'height')) return 3;
  if (rel.some(r => r.kind === 'weight' || r.kind === 'axle' || r.kind === 'length' || r.kind === 'width')) return 4;
  return 5;
}

function featureDistanceToSegment(coords, segment) {
  return polylineDistance(coords, segment).distance;
}

// Build ORS driving-hgv request with prioritized corridor avoidance (respecting ORS 20 km avoid_polygons extent).
export function buildRoutePlan(origin, destination, vehicle = {}, features = [], focusPoint = null) {
  const restrictionsObj = {};
  for (const k of ['weight', 'height', 'length', 'width']) {
    if (vehicle[k] > 0) restrictionsObj[k] = vehicle[k];
  }
  if (vehicle.axle > 0) restrictionsObj.axleload = vehicle.axle;

  const options = { profile_params: { restrictions: restrictionsObj } };
  const tripDist = distance(origin, destination);
  const corridorWidth = Math.min(6000, Math.max(3000, tripDist * 0.2));

  const candidates = features
    .filter(f => f.restrictions.some(r => relevant(r, vehicle)))
    .map(f => {
      const mid = featureMidpoint(f.coords) || f.coords[0];
      const corridorDist = featureDistanceToSegment(f.coords, [origin, destination]);
      const destDist = Math.min(distance(mid, origin), distance(mid, destination));
      const focusDist = focusPoint ? distance(mid, focusPoint) : corridorDist;
      return {
        f,
        priority: restrictionPriority(f, vehicle),
        corridorDist,
        destDist,
        focusDist,
      };
    })
    .filter(item => item.corridorDist < corridorWidth || (focusPoint && item.focusDist < 4000));

  // Prioritize: if focusPoint is set (retry targeting a violated segment), closest to focusPoint first;
  // otherwise severity tier (hgv=no & height before weight/conditional), then closest to route corridor / endpoints.
  candidates.sort((a, b) => {
    if (focusPoint) {
      const fa = a.focusDist < 3000 ? 0 : 1;
      const fb = b.focusDist < 3000 ? 0 : 1;
      if (fa !== fb) return fa - fb;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.focusDist - b.focusDist;
    }
    if (a.priority !== b.priority) return a.priority - b.priority;
    return Math.min(a.corridorDist, a.destDist) - Math.min(b.corridorDist, b.destDist);
  });

  const polygons = [];
  let allPts = [];
  const includedIds = new Set();
  const omitted = [];

  for (const { f } of candidates) {
    let addedForFeature = false;
    let blockedByCap = false;
    for (let i = 0; i < f.coords.length; i += 8) {
      if (polygons.length >= 80) {
        blockedByCap = true;
        break;
      }
      const section = f.coords.slice(i, i + 9);
      const lats = section.map(p => p[0]);
      const lons = section.map(p => p[1]);
      const s = Math.min(...lats) - 0.00015;
      const n = Math.max(...lats) + 0.00015;
      const w = Math.min(...lons) - 0.00018;
      const e = Math.max(...lons) + 0.00018;
      // Only skip if literally touching origin/destination pin (< 20 m) so ORS can still snap endpoints.
      if (nearLine(origin, [[s, w], [n, e]]).distance < 20 || nearLine(destination, [[s, w], [n, e]]).distance < 20) {
        continue;
      }
      const candidatePts = [...allPts, [s, w], [n, e]];
      const minLat = Math.min(...candidatePts.map(p => p[0]));
      const maxLat = Math.max(...candidatePts.map(p => p[0]));
      const minLon = Math.min(...candidatePts.map(p => p[1]));
      const maxLon = Math.max(...candidatePts.map(p => p[1]));
      if (distance([minLat, minLon], [maxLat, maxLon]) > 15000) {
        blockedByCap = true;
        continue;
      }
      polygons.push([[[w, s], [e, s], [e, n], [w, n], [w, s]]]);
      allPts = candidatePts;
      addedForFeature = true;
    }
    if (addedForFeature) includedIds.add(f.id);
    else if (blockedByCap) omitted.push(f);
  }

  if (polygons.length) {
    options.avoid_polygons = { type: 'MultiPolygon', coordinates: polygons };
  }

  return {
    body: {
      coordinates: [origin.slice().reverse(), destination.slice().reverse()],
      instructions: true,
      language: 'en',
      units: 'm',
      options,
    },
    includedCount: includedIds.size,
    omitted,
  };
}

export function routeRequest(origin, destination, vehicle, features) {
  return buildRoutePlan(origin, destination, vehicle, features).body;
}

// Parse effective vertical layer from OSM tags (explicit layer tag, else bridge=yes -> 1, tunnel=yes -> -1, else 0).
export function parseOsmLayer(tags = {}) {
  if (tags.layer != null && String(tags.layer).trim() !== '') {
    const n = Number(tags.layer);
    if (Number.isFinite(n)) return n;
  }
  if (tags.bridge === 'yes' || tags.bridge === 'viaduct') return 1;
  if (tags.tunnel === 'yes' || tags.tunnel === 'building_passage') return -1;
  return 0;
}

function hasExplicitVerticalTag(tags = {}) {
  return (
    (tags.layer != null && String(tags.layer).trim() !== '') ||
    tags.bridge === 'yes' ||
    tags.bridge === 'viaduct' ||
    tags.tunnel === 'yes' ||
    tags.tunnel === 'building_passage'
  );
}

// Undirected acute angle difference (0..90 deg) between two segments [a1,a2] and [b1,b2].
function segmentAcuteAngle(a1, a2, b1, b2) {
  const ba = bearing(a1, a2);
  const bb = bearing(b1, b2);
  const diff = Math.abs(ba - bb) % 180;
  return Math.min(diff, 180 - diff);
}

// Remove consecutive duplicate / zero-length (< 0.5 m) coordinates while retaining original route segment indices.
export function deduplicateCoordsWithIndices(coords = [], minStepM = 0.5) {
  if (!Array.isArray(coords) || !coords.length) return [];
  const out = [{ coord: coords[0], index: 0 }];
  for (let i = 1; i < coords.length; i++) {
    const prev = out[out.length - 1].coord;
    if (distance(prev, coords[i]) >= minStepM) {
      out.push({ coord: coords[i], index: i });
    }
  }
  return out;
}

// Compute longitudinal overlap (meters) along the shared axis of two nearly parallel segments [a1,a2] and [b1,b2]
// within lateral distance maxLateralM. Distinguishes actual along-road travel from single-point oblique crossings.
function longitudinalOverlapMeters(a1, a2, b1, b2, maxLateralM = ALONG_ROAD_MAX_LATERAL_M) {
  const refLat = (a1[0] + a2[0] + b1[0] + b2[0]) / 4;
  const kx = 111320 * Math.cos(refLat * Math.PI / 180);
  const ky = 111320;
  const ax = (a2[1] - a1[1]) * kx, ay = (a2[0] - a1[0]) * ky;
  const lenA = Math.hypot(ax, ay);
  if (lenA < 0.5) return 0;
  const ux = ax / lenA, uy = ay / lenA; // unit vector along segment A
  const nx = -uy, ny = ux; // perpendicular unit normal

  const p1x = (b1[1] - a1[1]) * kx, p1y = (b1[0] - a1[0]) * ky;
  const p2x = (b2[1] - a1[1]) * kx, p2y = (b2[0] - a1[0]) * ky;
  // Project B endpoints onto A's longitudinal (s) and lateral (d) axes
  const s1 = p1x * ux + p1y * uy, d1 = p1x * nx + p1y * ny;
  const s2 = p2x * ux + p2y * uy, d2 = p2x * nx + p2y * ny;

  // Find parameter interval t in [0, 1] along B where |d(t)| <= maxLateralM
  let tLow = 0, tHigh = 1;
  const dd = d2 - d1;
  if (Math.abs(dd) < 1e-9) {
    if (Math.abs(d1) > maxLateralM) return 0;
  } else {
    const tA = (-maxLateralM - d1) / dd;
    const tB = (maxLateralM - d1) / dd;
    tLow = Math.max(0, Math.min(tA, tB));
    tHigh = Math.min(1, Math.max(tA, tB));
    if (tLow >= tHigh) return 0;
  }

  // Clamp longitudinal interval [s(tLow), s(tHigh)] against segment A [0, lenA]
  const sa = s1 + tLow * (s2 - s1);
  const sb = s1 + tHigh * (s2 - s1);
  const lo = Math.max(0, Math.min(sa, sb));
  const hi = Math.min(lenA, Math.max(sa, sb));
  return Math.max(0, hi - lo);
}

function normalizeRoadName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(north|south|east|west|n|s|e|w)\b/g, '')
    .replace(/\b(street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr|parkway|pkwy|freeway|fwy|highway|hwy|lane|ln|way|place|pl|court|ct)\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

// Extract non-zero-length route segments while mapping each segment to its EXACT original raw index span [startIndex, endIndex].
// Duplicate/zero-length consecutive points advance startIdx so a duplicate at a layer boundary NEVER attributes the
// preceding layer to the following ground segment.
export function extractRouteSegments(coords = [], minStepM = 0.5) {
  if (!Array.isArray(coords) || coords.length < 2) return [];
  const segs = [];
  let startIdx = 0;
  for (let i = 1; i < coords.length; i++) {
    if (distance(coords[startIdx], coords[i]) < minStepM) {
      startIdx = i;
      continue;
    }
    segs.push({ a: coords[startIdx], b: coords[i], startIndex: startIdx, endIndex: i });
    startIdx = i;
  }
  return segs;
}

// Resolve per-segment metadata (layer/bridge/tunnel/osmRef/name) ONLY when metadata fully covers the actual
// non-zero-length segment [segStartIdx, segEndIdx]. Never applies whole-route layer or start-index-only layer
// across a layer boundary.
function getRouteSegmentMeta(routeContext, steps, segStartIdx, segEndIdx) {
  let layer = null;
  let osmRef = null;
  let name = null;

  if (routeContext) {
    if (Array.isArray(routeContext.segments)) {
      const seg = routeContext.segments.find(s =>
        s && s.startIndex <= segStartIdx && s.endIndex >= segEndIdx
      );
      if (seg) {
        const segTags = seg.tags || seg;
        if (hasExplicitVerticalTag(segTags)) layer = parseOsmLayer(segTags);
        if (seg.osmRef) osmRef = seg.osmRef;
        if (seg.name || segTags.name) name = seg.name || segTags.name;
      }
    } else if (Array.isArray(routeContext.segmentTags)) {
      // Every raw edge inside [segStartIdx, segEndIdx) must agree on the same explicit layer.
      let sharedLayer = undefined;
      for (let k = segStartIdx; k < segEndIdx; k++) {
        const segTags = routeContext.segmentTags[k];
        if (!segTags || !hasExplicitVerticalTag(segTags)) {
          sharedLayer = null;
          break;
        }
        const l = parseOsmLayer(segTags);
        if (sharedLayer === undefined) sharedLayer = l;
        else if (sharedLayer !== l) {
          sharedLayer = null;
          break;
        }
      }
      if (sharedLayer != null) layer = sharedLayer;
      const firstTags = routeContext.segmentTags[segStartIdx];
      if (firstTags) {
        if (firstTags.osmRef) osmRef = firstTags.osmRef;
        if (firstTags.name) name = firstTags.name;
      }
    }
  }

  if (!name && Array.isArray(steps) && steps.length) {
    const step = steps.find(s =>
      Array.isArray(s?.way_points) &&
      s.way_points.length >= 2 &&
      segStartIdx >= s.way_points[0] &&
      segEndIdx <= s.way_points[1] &&
      s.name &&
      s.name !== '-'
    );
    if (step) name = step.name;
  }

  return { layer, osmRef, name };
}

// Classify how a candidate route interacts with a restriction feature polyline:
// - Extracts non-zero-length segments with exact raw index spans so duplicates at layer boundaries never waive ground segments.
// - Applies per-segment layer/grade context strictly when metadata fully covers the non-zero-length segment.
// - Requires actual along-road evidence (tight angle <= 20 deg + longitudinal corridor overlap, OR explicit road-name/osmRef match on that segment)
//   rather than treating oblique (~30 deg) crossings as along-road travel.
export function classifyRouteFeatureOverlap(featureCoords, routeCoords, thresholdM = 25, options = {}) {
  if (!featureCoords?.length || !routeCoords?.length) {
    return { relation: 'none', distance: Infinity, point: null, crossingAngle: null };
  }

  const featSegs = extractRouteSegments(featureCoords);
  const routeSegs = extractRouteSegments(routeCoords);
  const featureTags = options.featureTags || {};
  const featureOsmRef = options.featureOsmRef || null;
  const featureLayer = parseOsmLayer(featureTags);
  const featureNormName = normalizeRoadName(featureTags.name);
  const routeContext = options.routeContext || null;
  const steps = options.steps || [];

  // Single-point feature or single-point route (after skipping duplicate/zero-length steps)
  if (!featSegs.length || !routeSegs.length) {
    if (!featSegs.length && routeSegs.length) {
      const pt = featureCoords[0];
      let best = { distance: Infinity, point: pt };
      for (const rs of routeSegs) {
        const meta = getRouteSegmentMeta(routeContext, steps, rs.startIndex, rs.endIndex);
        if (meta.layer !== null && (!meta.osmRef || meta.osmRef !== featureOsmRef) && meta.layer !== featureLayer) {
          continue;
        }
        const d = nearLine(pt, [rs.a, rs.b]).distance;
        if (d < best.distance) best = { distance: d, point: pt };
      }
      return best.distance < thresholdM
        ? { relation: 'point', distance: best.distance, point: best.point, crossingAngle: null }
        : { relation: 'none', distance: best.distance, point: best.point, crossingAngle: null };
    }
    const res = polylineDistance(featureCoords, routeCoords);
    return res.distance < thresholdM
      ? { relation: 'point', distance: res.distance, point: res.point, crossingAngle: null }
      : { relation: 'none', distance: res.distance, point: res.point, crossingAngle: null };
  }

  let bestAligned = { distance: Infinity, point: null, angle: null, overlapM: 0 };
  let bestCrossing = { distance: Infinity, point: null, angle: null };

  for (const rSeg of routeSegs) {
    const b1 = rSeg.a;
    const b2 = rSeg.b;
    const segMeta = getRouteSegmentMeta(routeContext, steps, rSeg.startIndex, rSeg.endIndex);

    // Per-segment vertical separation: skip ONLY this route segment if its full-coverage explicit layer differs from featureLayer.
    if (segMeta.layer !== null && (!segMeta.osmRef || segMeta.osmRef !== featureOsmRef) && segMeta.layer !== featureLayer) {
      continue;
    }

    const segLenB = distance(b1, b2);
    const segNormName = normalizeRoadName(segMeta.name);
    const sameIdentity = Boolean(
      (segMeta.osmRef && featureOsmRef && segMeta.osmRef === featureOsmRef) ||
      (segNormName && featureNormName && segNormName === featureNormName)
    );

    for (const fSeg of featSegs) {
      const a1 = fSeg.a;
      const a2 = fSeg.b;
      const res = segmentDistance(a1, a2, b1, b2);
      if (res.distance >= thresholdM) continue;

      const segLenA = distance(a1, a2);
      const ang = segmentAcuteAngle(a1, a2, b1, b2);
      const minSegLen = Math.min(segLenA, segLenB);
      const overlapM = ang <= ALONG_ROAD_MAX_ANGLE_DEG ? longitudinalOverlapMeters(a1, a2, b1, b2) : 0;
      const hasAlongOverlap =
        ang <= ALONG_ROAD_MAX_ANGLE_DEG &&
        res.distance < ALONG_ROAD_MAX_LATERAL_M &&
        (overlapM >= ALONG_ROAD_MIN_OVERLAP_M || (minSegLen > 0 && overlapM >= minSegLen * 0.5));

      if (sameIdentity || hasAlongOverlap) {
        if (res.distance < bestAligned.distance) {
          bestAligned = { distance: res.distance, point: res.point, angle: ang, overlapM };
        }
      } else if (res.distance < bestCrossing.distance) {
        bestCrossing = { distance: res.distance, point: res.point, angle: ang };
      }
    }
  }

  if (bestAligned.distance < thresholdM) {
    return {
      relation: 'along',
      distance: bestAligned.distance,
      point: bestAligned.point,
      crossingAngle: bestAligned.angle,
      overlapMeters: bestAligned.overlapM,
    };
  }
  if (bestCrossing.distance < thresholdM) {
    return {
      relation: 'crossing',
      distance: bestCrossing.distance,
      point: bestCrossing.point,
      crossingAngle: bestCrossing.angle,
      overlapMeters: 0,
    };
  }
  return { relation: 'none', distance: Infinity, point: null, crossingAngle: null, overlapMeters: 0 };
}

// Validate a proposed route against ALL effective restrictions (no 15 km cap) + dead-end/U-turn traps.
// Uses segment-to-segment polyline geometry so traveling along the middle of a long restriction way is always caught,
// while distinguishing same-road travel from grade-separated/oblique 2D crossings and applying layer context per-segment only.
export function validateRouteSafety(routeCoords, steps = [], vehicle = {}, features = [], routeContext = null) {
  const blocking = [];
  const warnings = [];
  const turnaroundWarnings = [];
  const routeBox = routeCoords?.length ? coordsBbox(routeCoords) : null;
  const boxPad = 0.001; // ~111 m generous pre-filter margin around route bbox

  for (const f of features) {
    const rel = f.restrictions.filter(r => relevant(r, vehicle));
    if (!rel.length || !routeBox || !f.coords?.length) continue;
    const [fs, fw, fn, fe] = coordsBbox(f.coords);
    if (fn < routeBox[0] - boxPad || fs > routeBox[2] + boxPad || fe < routeBox[1] - boxPad || fw > routeBox[3] + boxPad) {
      continue;
    }

    const overlap = classifyRouteFeatureOverlap(f.coords, routeCoords, 25, {
      featureTags: f.tags || {},
      featureOsmRef: f.osmRef || null,
      routeContext,
      steps,
    });
    if (overlap.relation === 'none' || overlap.relation === 'crossing') continue;

    const minD = overlap.distance;
    const hard = rel.find(r =>
      (r.kind === 'ban' && !r.conditional) ||
      (r.kind === 'height' && r.value != null && (!vehicle.height || (vehicle.height + HEIGHT_MARGIN_M) >= r.value)) ||
      (r.kind === 'weight' && r.value != null && vehicle.weight > r.value) ||
      (r.kind === 'axle' && r.value != null && vehicle.axle > r.value) ||
      (r.kind === 'length' && r.value != null && vehicle.length > r.value) ||
      (r.kind === 'width' && r.value != null && vehicle.width >= r.value)
    );

    const conflictPoint = overlap.point || featureMidpoint(f.coords) || f.coords[0];
    if (hard) {
      blocking.push({ feature: f, restriction: hard, distance: minD, point: conflictPoint });
    } else {
      warnings.push({ feature: f, restriction: rel[0], distance: minD, point: conflictPoint });
    }
  }

  // Check for U-turn maneuvers in ORS steps
  for (const s of steps) {
    if (s.type === 9) {
      turnaroundWarnings.push(`路线包含掉头动作（${s.instruction || 'U-turn'}），大车可能缺少掉头空间`);
    }
  }

  // Check geometry for sharp >155° reversals over short segments (dead-end / cul-de-sac trap)
  for (let i = 1; i < routeCoords.length - 1; i++) {
    const d1 = distance(routeCoords[i - 1], routeCoords[i]);
    const d2 = distance(routeCoords[i], routeCoords[i + 1]);
    if (d1 < 8 || d2 < 8 || d1 > 200 || d2 > 200) continue;
    const b1 = bearing(routeCoords[i - 1], routeCoords[i]);
    const b2 = bearing(routeCoords[i], routeCoords[i + 1]);
    const delta = Math.abs(((b2 - b1 + 540) % 360) - 180);
    if (delta >= 155) {
      turnaroundWarnings.push('检测到急转折返/疑似断头路掉头路段，请确认大车转弯半径与掉头空间');
      break;
    }
  }

  // Check driver notes near route for dead-end / no-turn-around reports (advisory warnings; do not affect safe)
  for (const f of features) {
    const noteText = `${f.tags?.notes || ''} ${f.tags?.noexit || ''}`.toLowerCase();
    if (/断头路|死胡同|无法掉头|不能掉头|dead\s*end|cul-de-sac|no\s*turn|yes/.test(noteText) &&
        (f.tags?.noexit === 'yes' || /断头路|死胡同|无法掉头|不能掉头|dead\s*end|cul-de-sac|no\s*turn/.test(noteText))) {
      if (!routeBox || !f.coords?.length) continue;
      const minD = polylineDistance(f.coords, routeCoords).distance;
      if (minD < 30) {
        turnaroundWarnings.push(`路线经过已知断头路/无掉头空间标记（${f.tags?.name || '附近路段'}）`);
      }
    }
  }

  return {
    safe: blocking.length === 0,
    blocking,
    warnings,
    turnaroundWarnings: [...new Set(turnaroundWarnings)],
  };
}

// Automated systemic geometry audit (independent of junctionTrim self-flags):
// - Verifies canonical `coords` stay 1:1 identical to source OSM element geometry (untrimmed for routing/alerts).
// - Verifies `displayCoords` stay strictly on the source OSM way in monotonic forward order with badge anchors on the way.
// - Independently inspects T-junctions, continuations, and open endpoints to flag:
//   * untrimmed T-junction/cross-street overhangs still reaching cross-street centerlines
//   * unintended gaps at collinear same-street / unnamed same-limit continuations
//   * open endpoints (e.g. noexit=yes / dead ends) trimmed without real junction evidence
//   * leaked non-public service/track ways or >2,500 m teleport jumps.
export function auditSnapshotGeometry(snapshotData, precomputedFeatures = null) {
  const issues = [];
  const elementsById = new Map();
  for (const el of snapshotData?.elements || []) {
    elementsById.set(`${el.type}/${el.id}`, el);
  }
  const features = precomputedFeatures || fromOverpass(snapshotData);
  const junctionMap = snapshotData?.junctions || {};
  const [minLat, minLon, maxLat, maxLon] = BBOX;
  const ways = features.filter(f => f.osmType === 'way' && Array.isArray(f.coords) && f.coords.length >= 2);
  const grid = buildWayGrid(ways);

  for (const f of features) {
    const src = elementsById.get(f.osmRef);
    if (!src) {
      issues.push({ id: f.id, reason: 'missing_source_element' });
      continue;
    }
    const hw = f.tags?.highway;
    if (hw === 'track') {
      issues.push({ id: f.id, reason: 'leaked_track_way' });
    }
    if (hw === 'service') {
      if (NON_PUBLIC_SERVICES.has(f.tags.service || '') || NON_PUBLIC_ACCESS.has(f.tags.access || '') || !f.tags.name) {
        issues.push({ id: f.id, reason: 'leaked_non_public_service_way', tags: f.tags });
      }
    }
    const display = f.displayCoords || f.coords;
    if (f.osmType === 'way') {
      const srcCoords = (src.geometry || []).map(p => [p.lat, p.lon]);
      // 1. Canonical routing/alert `coords` must remain 1:1 untrimmed OSM way geometry
      if (f.coords.length !== srcCoords.length || f.coords.length < 2) {
        issues.push({ id: f.id, reason: 'canonical_coord_count_mismatch', drawn: f.coords.length, osm: srcCoords.length });
      } else {
        for (let i = 0; i < f.coords.length; i++) {
          if (f.coords[i][0] !== srcCoords[i][0] || f.coords[i][1] !== srcCoords[i][1]) {
            issues.push({ id: f.id, reason: 'canonical_coords_modified', index: i });
            break;
          }
        }
      }
      // 2. Display geometry must remain strictly on the source way in monotonic forward order
      if (display.length < 2 || srcCoords.length < 2) {
        issues.push({ id: f.id, reason: 'display_coord_count_mismatch', drawn: display.length, osm: srcCoords.length });
      } else {
        let prevProg = -1;
        const isClosedLoop = distance(srcCoords[0], srcCoords[srcCoords.length - 1]) < 1;
        for (let i = 0; i < display.length; i++) {
          const [lat, lon] = display[i];
          if (lat < minLat - 0.15 || lat > maxLat + 0.15 || lon < minLon - 0.15 || lon > maxLon + 0.15) {
            issues.push({ id: f.id, reason: 'coord_out_of_region', index: i });
            break;
          }
          const offWayM = nearLine([lat, lon], srcCoords).distance;
          if (offWayM > 0.25) {
            issues.push({ id: f.id, reason: 'coord_off_source_way', index: i, offWayMeters: offWayM });
            break;
          }
          if (!isClosedLoop) {
            const prog = routeProgress([lat, lon], srcCoords);
            if (prog + 0.5 < prevProg) {
              issues.push({ id: f.id, reason: 'coord_order_reversed', index: i, prevProg, prog });
              break;
            }
            prevProg = prog;
          }
        }
        // Flag suspicious single-segment jumps (> 2,500 m)
        for (let i = 1; i < f.coords.length; i++) {
          const stepM = distance(f.coords[i - 1], f.coords[i]);
          if (stepM > 2500) {
            issues.push({ id: f.id, reason: 'teleport_segment_jump', stepMeters: Math.round(stepM), index: i });
            break;
          }
        }
        // 3. Independently verify junction trim vs continuation vs unattached open ends
        if (isEligibleForJunctionTrim(f)) {
          for (const isStart of [true, false]) {
            const rawEnd = isStart ? srcCoords[0] : srcCoords[srcCoords.length - 1];
            const dispEnd = isStart ? display[0] : display[display.length - 1];
            const setback = distance(dispEnd, rawEnd);
            const epInfo = classifyWayEndpoint(f, isStart, getNearbyWays(grid, rawEnd, f.id), junctionMap);
            if (epInfo.kind === 'junction' && setback < 2) {
              issues.push({
                id: f.id,
                reason: 'untrimmed_tjunction_overhang',
                end: isStart ? 'start' : 'end',
                setbackMeters: Number(setback.toFixed(2)),
                evidence: epInfo.evidence,
              });
            } else if (epInfo.kind === 'continuation' && setback > 0.5) {
              issues.push({
                id: f.id,
                reason: 'continuation_gap',
                end: isStart ? 'start' : 'end',
                gapMeters: Number(setback.toFixed(2)),
              });
            } else if (epInfo.kind === 'open' && setback > 0.5) {
              issues.push({
                id: f.id,
                reason: 'trimmed_without_junction_evidence',
                end: isStart ? 'start' : 'end',
                trimmedMeters: Number(setback.toFixed(2)),
              });
            }
          }
        }
      }
    }
    // Verify the badge anchor lies strictly ON the visible display polyline
    const mid = featureMidpoint(display);
    if (!mid || nearLine(mid, display).distance > 0.05) {
      issues.push({ id: f.id, reason: 'badge_anchor_off_way', offsetMeters: mid ? nearLine(mid, display).distance : null });
    }
  }

  return {
    ok: issues.length === 0,
    checkedCount: features.length,
    issues,
  };
}

function elementPoints(el) {
  if (!el) return [];
  if (el.type === 'node' && Number.isFinite(el.lat) && Number.isFinite(el.lon)) {
    return [[el.lat, el.lon]];
  }
  const pts = [];
  if (Array.isArray(el.geometry)) {
    for (const p of el.geometry) {
      if (Number.isFinite(p?.lat) && Number.isFinite(p?.lon)) pts.push([p.lat, p.lon]);
    }
  }
  if (Array.isArray(el.members)) {
    for (const m of el.members) {
      if (!Array.isArray(m?.geometry)) continue;
      for (const p of m.geometry) {
        if (Number.isFinite(p?.lat) && Number.isFinite(p?.lon)) pts.push([p.lat, p.lon]);
      }
    }
  }
  return pts;
}

function pointInBbox(pt, bbox) {
  return pt[0] >= bbox[0] && pt[0] <= bbox[2] && pt[1] >= bbox[1] && pt[1] <= bbox[3];
}

// Merge partial or full tiled Overpass fetch results into existing snapshot/cache elements.
// Only replaces elements whose geometry lies strictly inside succeeded tiles (and not in any failed tile).
// Failed tiles ALWAYS preserve their previous elements; if zero tiles succeeded, keeps existing elements intact.
export function mergeOverpassTileResults(existingElements = [], tileResults = []) {
  const succeededTiles = tileResults.filter(t => t && t.ok && Array.isArray(t.elements));
  const failedTiles = tileResults.filter(t => !t || !t.ok);
  const tilesTotal = tileResults.length;
  const tilesOk = succeededTiles.length;

  if (tilesOk === 0) {
    return {
      elements: [...existingElements],
      tilesOk: 0,
      tilesTotal,
      partial: true,
      changed: false,
    };
  }

  const succeededBboxes = succeededTiles.map(t => t.bbox).filter(Boolean);
  const failedBboxes = [...failedTiles, ...succeededTiles.filter(t => t.preserveExisting)].map(t => t.bbox).filter(Boolean);
  const merged = new Map();

  for (const el of existingElements) {
    if (!el || !el.type || el.id == null) continue;
    const pts = elementPoints(el);
    const inFailed = pts.some(pt => failedBboxes.some(b => pointInBbox(pt, b)));
    const fullyInSucceeded = pts.length > 0 && pts.every(pt => succeededBboxes.some(b => pointInBbox(pt, b)));
    // Keep existing element if it belongs to (or touches) any failed tile, or lies outside succeeded tiles.
    if (inFailed || !fullyInSucceeded) {
      merged.set(`${el.type}/${el.id}`, el);
    }
  }

  for (const t of succeededTiles) {
    for (const el of t.elements) {
      if (!el || !el.type || el.id == null) continue;
      merged.set(`${el.type}/${el.id}`, el);
    }
  }

  const elements = [...merged.values()];
  // Defense in depth: never replace a non-empty snapshot with an empty result set.
  if (existingElements.length > 0 && elements.length === 0) {
    return {
      elements: [...existingElements],
      tilesOk: 0,
      tilesTotal,
      partial: true,
      changed: false,
    };
  }

  return {
    elements,
    tilesOk,
    tilesTotal,
    partial: failedTiles.length > 0 || succeededTiles.some(t => t.preserveExisting),
    changed: true,
  };
}

// Follow-button state machine (pure & unit-testable)
export function followButtonLabel(mode, following) {
  if (mode === 'idle') return '◎ 开启定位';
  return following ? '◎ 正在跟随' : '◎ 重新跟随';
}

export function onMapDrag(state) {
  if (state.mode === 'idle') return { ...state };
  return { ...state, following: false };
}

export function onFollowClick(state) {
  if (state.mode === 'demo' && !state.following) {
    return { action: 'recenter_demo', next: { mode: 'demo', following: true } };
  }
  if (state.mode === 'gps') {
    return { action: 'recenter_gps', next: { mode: 'gps', following: true } };
  }
  return { action: 'start_gps', next: { mode: 'gps', following: true } };
}

// Deduplicated status bar formatter (never appends repeated failure suffixes)
export function formatDataStatus(baseText, suffix = '') {
  const cleanBase = String(baseText || '').split(' · 正在更新')[0].split(' · 在线暂不可用')[0].trim();
  return suffix ? `${cleanBase} · ${suffix}` : cleanBase;
}

// Distance along nearest route edge, including fractional progress beyond a maneuver.
export function routeProgress(p, coords) {
  let total = 0;
  let best = Infinity;
  let progress = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const n = nearLine(p, [a, b]);
    const len = distance(a, b);
    if (n.distance < best) {
      best = n.distance;
      progress = total + Math.min(len, distance(a, n.point));
    }
    total += len;
  }
  return progress;
}

// Public truck-OK through-road classes (excludes residential, service, track, footway, etc.)
export const TRUCK_OK_CLASSES = [
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
];

export const TRUCK_OK_MIN_ZOOM = {
  motorway: 10,
  trunk: 10,
  primary: 11,
  motorway_link: 12,
  trunk_link: 12,
  secondary: 12,
  primary_link: 13,
  secondary_link: 13,
  tertiary: 14,
  tertiary_link: 14,
};

export const TRUCK_OK_CLASS_LABELS = {
  motorway: '高速公路',
  motorway_link: '高速匝道',
  trunk: '快速干道',
  trunk_link: '快速路匝道',
  primary: '主要干道',
  primary_link: '主干道连接线',
  secondary: '次要干道',
  secondary_link: '次干道连接线',
  tertiary: '区域支干道',
  tertiary_link: '支干道连接线',
};

// Decode compact delta-encoded 1e-6 deg exact OSM way geometry from data/truck-ok-roads.json.
// Preserves exact vertex sequence without smoothing or merging.
export function decodeTruckOkRoads(data) {
  if (!data || !Array.isArray(data.ways)) return [];
  const classes = Array.isArray(data.classes) && data.classes.length ? data.classes : TRUCK_OK_CLASSES;
  const names = Array.isArray(data.names) ? data.names : [];
  const out = [];
  for (const row of data.ways) {
    if (!Array.isArray(row) || row.length < 4) continue;
    const [osmId, clsIdx, nameRef, dcoords] = row;
    const highway = classes[clsIdx];
    if (!highway || !TRUCK_OK_MIN_ZOOM[highway]) continue;
    if (!Array.isArray(dcoords) || dcoords.length < 4 || dcoords.length % 2 !== 0) continue;
    const coords = [];
    let latI = 0;
    let lonI = 0;
    let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
    for (let i = 0; i < dcoords.length; i += 2) {
      if (i === 0) {
        latI = dcoords[0];
        lonI = dcoords[1];
      } else {
        latI += dcoords[i];
        lonI += dcoords[i + 1];
      }
      const lat = latI / 1e6;
      const lon = lonI / 1e6;
      coords.push([lat, lon]);
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
    if (coords.length < 2) continue;
    const name = typeof nameRef === 'number' ? (names[nameRef] || '') : String(nameRef || '');
    out.push({
      id: `way/${osmId}`,
      osmRef: `way/${osmId}`,
      osmId,
      highway,
      name,
      coords,
      bbox: [minLat, minLon, maxLat, maxLon],
      minZoom: TRUCK_OK_MIN_ZOOM[highway],
    });
  }
  return out;
}

export const UNLINKED_GREEN_SUPPRESS_RADIUS_M = 12;

// Normalize supported OSM way ID fields (`osmRef`, `osmFeatureId`, `wayRef`, `id`, `osmType`/`osmId`) to `way/<id>`.
export function extractWayRef(item) {
  if (!item || typeof item !== 'object') return null;
  for (const raw of [item.osmRef, item.osmFeatureId, item.wayRef]) {
    if (typeof raw !== 'string') continue;
    const m = raw.trim().match(/^(way\/\d+)(?:\/\d+)?$/);
    if (m) return m[1];
  }
  if (item.osmType === 'way' && item.osmId != null) return `way/${item.osmId}`;
  if (typeof item.id === 'string') {
    const m = item.id.trim().match(/^(way\/\d+)(?:\/\d+)?$/);
    if (m) return m[1];
  }
  return null;
}

// Subtract EVERY way ID that exists in the restriction dataset or driver non-can edits (`osmRef` / `osmFeatureId` / `wayRef`),
// AND conservatively suppress green ways overlapping an unlinked driver `cannot` / `restriction` mark (<= 12 m on-road),
// so green NEVER claims "正常通行" on a road with a restriction while leaving unrelated parallel roads untouched.
// Unlinked `can` (can-pass) edits are ignored here and still never clear nearby restricted roads in `applyDriverOverrides()`.
export function filterTruckOkRoads(okRoads = [], restrictedFeatures = [], driverEdits = []) {
  const excludedRefs = new Set();
  for (const f of restrictedFeatures || []) {
    const ref = extractWayRef(f);
    if (ref) excludedRefs.add(ref);
  }
  const unlinkedRestrictPts = [];
  for (const e of driverEdits || []) {
    if (!e || e.type === 'can') continue;
    const ref = extractWayRef(e);
    if (ref) {
      excludedRefs.add(ref);
    } else if (Number.isFinite(e.lat) && Number.isFinite(e.lng)) {
      unlinkedRestrictPts.push([e.lat, e.lng]);
    }
  }
  const bboxPadDeg = 0.00022; // ~24 m fast prefilter around tight 12 m on-road suppression radius
  return (okRoads || []).filter(r => {
    const wayRef = extractWayRef(r);
    if (!r || !wayRef || TRUCK_OK_MIN_ZOOM[r.highway] == null || excludedRefs.has(wayRef)) return false;
    if (!Array.isArray(r.coords) || r.coords.length < 2) return false;
    if (unlinkedRestrictPts.length) {
      const box = Array.isArray(r.bbox) && r.bbox.length === 4 ? r.bbox : coordsBbox(r.coords);
      for (const pt of unlinkedRestrictPts) {
        if (
          pt[0] < box[0] - bboxPadDeg ||
          pt[0] > box[2] + bboxPadDeg ||
          pt[1] < box[1] - bboxPadDeg ||
          pt[1] > box[3] + bboxPadDeg
        ) {
          continue;
        }
        if (nearLine(pt, r.coords).distance <= UNLINKED_GREEN_SUPPRESS_RADIUS_M) {
          return false;
        }
      }
    }
    return true;
  });
}

// Zoom-scaled thickness for public truck-OK green lines: bold & readable on phones without spilling off road centerlines.
export function truckOkStyleForZoom(highway, zoom) {
  const minZ = TRUCK_OK_MIN_ZOOM[highway];
  if (minZ == null || zoom < 10 || zoom < minZ) {
    return { visible: false, weight: 0, haloWeight: 0, opacity: 0 };
  }
  const isMajor = highway === 'motorway' || highway === 'trunk';
  const isPrimary = highway === 'primary';
  const isSecondary = highway === 'secondary';
  const isLink = highway.endsWith('_link');

  let weight;
  if (isMajor) {
    weight = zoom >= 16 ? 7.5 : (zoom >= 14 ? 6.5 : (zoom >= 12 ? 5 : 3.8));
  } else if (isPrimary) {
    weight = zoom >= 16 ? 6.5 : (zoom >= 14 ? 5.5 : (zoom >= 12 ? 4.2 : 3));
  } else if (isSecondary) {
    weight = zoom >= 16 ? 5.5 : (zoom >= 14 ? 4.5 : 3.2);
  } else if (isLink) {
    weight = zoom >= 16 ? 4 : (zoom >= 14 ? 3.2 : 2.5);
  } else {
    // tertiary
    weight = zoom >= 16 ? 4.5 : 3.5;
  }

  return {
    visible: true,
    weight,
    haloWeight: 0,
    opacity: zoom >= 13 ? 0.84 : 0.78,
  };
}

// Bundled green-road dataset consistency check (NOT a full upstream OSM raw-geometry or tag-level verification,
// because the compact `delta-1e6` bundle quantizes vertices to 1e-6 deg ≈ 0.11 m and omits raw OSM tags):
// Verifies (1) zero way-ID intersection with `data/osm-snapshot.json`, (2) allowed through-road classes only,
// and (3) coordinates within Greater LA bbox without suspicious >5 km freeway / >2.5 km arterial segment jumps.
export function validateTruckOkBundle(okData, snapshotData) {
  const issues = [];
  const restrictedWayIds = new Set(
    (snapshotData?.elements || [])
      .filter(el => el?.type === 'way' && el?.id != null)
      .map(el => el.id)
  );
  const decoded = decodeTruckOkRoads(okData);
  const [minLat, minLon, maxLat, maxLon] = BBOX;

  for (const r of decoded) {
    if (restrictedWayIds.has(r.osmId)) {
      issues.push({ id: r.osmRef, reason: 'overlap_with_restricted_way' });
    }
    if (!TRUCK_OK_MIN_ZOOM[r.highway]) {
      issues.push({ id: r.osmRef, reason: 'disallowed_highway_class', highway: r.highway });
    }
    for (let i = 0; i < r.coords.length; i++) {
      const [lat, lon] = r.coords[i];
      if (lat < minLat - 0.15 || lat > maxLat + 0.15 || lon < minLon - 0.15 || lon > maxLon + 0.15) {
        issues.push({ id: r.osmRef, reason: 'coord_out_of_region', index: i });
        break;
      }
      const maxStepM = (r.highway === 'motorway' || r.highway === 'trunk') ? 5000 : 2500;
      if (i > 0 && distance(r.coords[i - 1], r.coords[i]) > maxStepM) {
        issues.push({ id: r.osmRef, reason: 'teleport_segment_jump', index: i });
        break;
      }
    }
  }

  return {
    ok: issues.length === 0,
    checkedCount: decoded.length,
    issues,
  };
}

export const auditTruckOkRoads = validateTruckOkBundle;

// OpenRouteService migrated off the removed api.openrouteservice.org domain to HeiGIT's unified API gateway (2026-11-24).
export const ORS_DIRECTIONS_URL = 'https://api.heigit.org/openrouteservice/v2/directions/driving-hgv/geojson';

export const ROUTE_UNAVAILABLE_TITLE = '卡车路线功能暂未开通';

export function getRouteUnavailableState(hasKey) {
  if (!hasKey) {
    return {
      available: false,
      title: ROUTE_UNAVAILABLE_TITLE,
      message: `${ROUTE_UNAVAILABLE_TITLE}：需先在「设置」粘贴免费的 OpenRouteService (HeiGIT) API Key 才能规划卡车路线（密钥仅保存在本机浏览器）。地图限高、禁行、绿色可通行干道、地点搜索、定位预警与司机纠偏均可正常使用。`,
    };
  }
  return {
    available: true,
    title: '',
    message: 'ORS 密钥已在本机配置。请选择起终点规划卡车路线（路线将校验已知禁行与限高，但仍仅供参考）。',
  };
}

// High-contrast royal blue + crisp white casing for planned truck routes:
// unmistakable on phones and clearly distinct from green OK roads (#22c55e), dashed driver-can-pass (#16a34a), and red/yellow restrictions (#dc2626).
export function plannedRouteStyles() {
  return {
    casing: { color: '#ffffff', weight: 13, opacity: 0.96, lineCap: 'round', lineJoin: 'round', smoothFactor: 0 },
    line: { color: '#2563eb', weight: 7.5, opacity: 0.98, lineCap: 'round', lineJoin: 'round', smoothFactor: 0 },
    startPin: { radius: 11, color: '#ffffff', weight: 3, fillColor: '#1d4ed8', fillOpacity: 1 },
    endPin: { radius: 11, color: '#ffffff', weight: 3, fillColor: '#dc2626', fillOpacity: 1 },
  };
}

export function formatRouteError(err) {
  const status = err?.status;
  const raw = String(err?.message || err || '');
  if (status === 401 || status === 403 || /\b(401|403)\b/.test(raw)) {
    return '路线请求被拒绝（HTTP 401/403）：请检查「设置」中的 OpenRouteService (HeiGIT) API Key 是否有效。';
  }
  if (status === 404 || /404|could not find|no route|没有返回可用路线/i.test(raw)) {
    return '未找到可通行的卡车路线：请检查起终点是否位于禁行路段或无路区域，并适当调整起终点重试。';
  }
  if (status === 429 || /\b429\b/.test(raw)) {
    return 'ORS 路线请求过于频繁或免费额度已用完（HTTP 429），请稍后再试。';
  }
  if (status >= 500 || /\b5\d\d\b/.test(raw)) {
    return `ORS 路线服务暂时不可用（HTTP ${status || '5xx'}），请稍后重试。`;
  }
  if (/timeout|abort/i.test(raw) || err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return '请求卡车路线超时，请检查网络连接后重试。';
  }
  if (/failed to fetch|network|load failed/i.test(raw)) {
    return '网络连接失败，无法连接 HeiGIT / OpenRouteService 路线服务，请检查网络后重试。';
  }
  return raw ? `路线规划失败：${raw}` : '路线规划失败，请稍后重试。';
}


// Browser deadline includes the server's 25-second query plus download time.
export const OVERPASS_FETCH_TIMEOUT_MS = 30000;
export function usableOverpassElements(data) {
  if (!Array.isArray(data?.elements)) throw Error('Overpass payload missing elements');
  const elements = data.elements.filter(e => e?.type && e.id != null && elementPoints(e).length);
  if (!elements.length) throw Error('Overpass payload has no usable geometry');
  return elements; // A remark may accompany usable partial data; retain it.
}
export const KEY_INSTALL_HINT = '从聊天或微信内置浏览器打开时，密钥常常记不住。请用 Safari 打开，选择「添加到主屏幕」，以后从主屏幕图标打开。';
export function isStandalone(nav = globalThis.navigator, match = globalThis.matchMedia) {
  return Boolean(nav?.standalone || match?.('(display-mode: standalone)').matches);
}
export function keySaveFeedback(saved, hasKey, standalone) {
  return { message: !saved ? '保存失败：浏览器存储不可用，请重试。' : hasKey ? '密钥已保存至本机（未联网验证）。' : '已清除本机密钥。', hint: saved && hasKey && !standalone ? KEY_INSTALL_HINT : '' };
}
export function rankPhotonResults(features = []) {
  return features.filter(f => f?.geometry?.type === 'Point' && f.geometry.coordinates?.length >= 2 && f.geometry.coordinates.slice(0, 2).every(Number.isFinite))
    .map(f => {
      const p = f.properties || {};
      const poi = p.osm_key && !['highway', 'place', 'boundary'].includes(p.osm_key);
      const street = p.osm_key === 'highway' || ['street', 'city', 'district', 'locality', 'state', 'country'].includes(p.type);
      return { coords: [f.geometry.coordinates[1], f.geometry.coordinates[0]], name: [p.name, p.housenumber, p.street, p.city, p.state].filter(Boolean).join(', '), precision: p.housenumber ? 100 : poi ? 80 : !street && p.osm_type === 'N' ? 60 : street ? 0 : 20 };
    }).sort((a, b) => b.precision - a.precision);
}
export function refreshFailureStatus(base) {
  return /内置快照/.test(base) ? '限行数据用的是内置快照，在线更新没成功' : /缓存/.test(base) ? '限行数据用的是本机缓存，在线更新没成功' : '限行数据更新没成功，请核实现场路牌';
}
