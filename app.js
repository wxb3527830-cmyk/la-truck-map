import {
  effectiveOrsKey, GPS_OPTIONS, selectGpsFix,
  BBOX, OVERPASS_FETCH_TIMEOUT_MS, usableOverpassElements, rankPhotonResults, isStandalone, keySaveFeedback, KEY_INSTALL_HINT, refreshFailureStatus,
  OVERPASS_ENDPOINTS,
  buildOverpassQuery,
  overpassTiles,
  fromOverpass,
  relevant,
  label,
  formatHeightImperial,
  formatHeightBadge,
  formatWeightLbs,
  formatWeightShort,
  formatDistanceUS,
  prepareEditFormFields,
  resolveEditLimitSubmission,
  parseDriverDimensionInput,
  parseDriverWeightInput,
  vehicleFromForm,
  migrateVehicleProfile,
  nearLine,
  featureMidpoint,
  bearing,
  approaching,
  distance,
  routeProgress,
  buildRoutePlan,
  validateRouteSafety,
  validEdit,
  validateEditDraft,
  editFeature,
  applyDriverOverrides,
  mergeOverpassTileResults,
  followButtonLabel,
  onMapDrag,
  onFollowClick,
  formatDataStatus,
  decodeTruckOkRoads,
  filterTruckOkRoads,
  truckOkStyleForZoom,
  TRUCK_OK_CLASS_LABELS,
  ORS_DIRECTIONS_URL,
  getRouteUnavailableState,
  plannedRouteStyles,
  formatRouteError,
} from './core.js';
import { read, write, createEditStore } from './storage.js';

const $ = id => document.getElementById(id);
const cfg = window.APP_CONFIG || {};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([34.025, -118.1], 10);
window.__truckMap = map;
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  className: 'muted-basemap-tiles',
  attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
}).addTo(map);

// Dedicated pane below overlayPane (400) so green truck-OK roads NEVER obscure red restricted lines or routes
const truckOkPane = map.createPane('truckOkPane');
truckOkPane.style.zIndex = '380';
const truckOkRenderer = L.canvas({ pane: 'truckOkPane', padding: 0.35 });

// Lift Leaflet's popupPane out of .leaflet-map-pane's z-index:400/transform stacking context
// into a top-level host inside #map (z-index: 1250) mirrored to _mapPane transforms,
// so popups reliably float above .map-top, .legend, .map-actions, and .alert-box on desktop & mobile
// while map tiles and road badges remain underneath external controls.
const mapPane = map.getPane('mapPane');
const popupPane = map.getPane('popupPane');
const popupHost = L.DomUtil.create('div', 'leaflet-popup-top-host', map.getContainer());
const popupSyncLayer = L.DomUtil.create('div', 'leaflet-pane leaflet-popup-sync-pane', popupHost);
popupSyncLayer.appendChild(popupPane);
const syncPopupTransform = () => {
  popupSyncLayer.style.transform = mapPane.style.transform || '';
  popupSyncLayer.style.transition = mapPane.style.transition || '';
  popupSyncLayer.classList.toggle('leaflet-pan-anim', mapPane.classList.contains('leaflet-pan-anim'));
};
syncPopupTransform();
new MutationObserver(syncPopupTransform).observe(mapPane, { attributes: true, attributeFilter: ['style', 'class'] });
map.on('move zoom viewreset popupopen', syncPopupTransform);

const truckOkLayer = L.layerGroup().addTo(map);
const osmLayer = L.layerGroup().addTo(map);
const labelLayer = L.layerGroup().addTo(map);
const editLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);

let rawElements = [];
let rawJunctions = {};
let features = [];
let rawTruckOkRoads = [];
let filteredTruckOkRoads = [];
let lastOsmZoomBucket = -1;
let edits = read('edits', []).filter(validEdit);
const initialProfileMigration = migrateVehicleProfile(read('profile', {}));
let profileRaw = initialProfileMigration.profile;
if (initialProfileMigration.migrated) write('profile', profileRaw);
let vehicle = vehicleFromForm(profileRaw);
let settings = read('settings', { distance: 244, voice: true });

let current = null;
let truck = null;
let accuracyCircle = null;
let watch = null;
let followState = { mode: 'idle', following: false };
let pickMode = null;
let draft = null;
let draftInitialForm = null;

let route = null;
let origin = null;
let destination = null;
let originPin = null;
let destinationPin = null;
let routeBusy = false;
let queuedPlan = false;
let pendingGpsPlan = false;
let gpsPlanTimer = null;
const GPS_PLAN_TIMEOUT_MS = 10000; // WebKit may never deliver either geolocation callback.
let restrictionsReady = false;
let routeEpoch = 0;
let lastReroute = 0;
let offCount = 0;
let navStep = 0;

let lastSearch = 0;
let searchBusy = false;
let lastManualRefresh = 0;
let refreshBusy = false;
let baseDataStatus = '正在读取本地快照…';
let lastGlobalAlert = 0;
let lastSpeech = 0;

let cachedOverrideState = { osmEntries: [], effectiveFeatures: [], matchedEditIds: new Set() };
const alerts = new Map();
const previousDistances = new Map();
const turnSpoken = new Set();
const store = createEditStore(cfg);

const POPUP_OPTS = {
  autoPanPaddingTopLeft: [16, 80],
  autoPanPaddingBottomRight: [16, 100],
  maxWidth: 300,
};

const say = text => {
  if (!settings.voice || !window.speechSynthesis || Date.now() - lastSpeech < 4500) return false;
  lastSpeech = Date.now();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.rate = 0.95;
  speechSynthesis.speak(u);
  return true;
};

function hideAlert() {
  clearTimeout(notify.timer);
  $('alert').hidden = true;
}

function notify(text, opts = {}) {
  const options = typeof opts === 'boolean' ? { voice: opts, level: opts ? 'danger' : 'info' } : opts;
  const level = options.level || (options.voice ? 'danger' : 'info');
  const voice = Boolean(options.voice);
  const sticky = Boolean(options.sticky);
  const box = $('alert');
  box.className = `alert-box alert-${level}`;
  $('alert-text').textContent = text;
  box.hidden = false;
  clearTimeout(notify.timer);
  if (!sticky) {
    notify.timer = setTimeout(() => { box.hidden = true; }, level === 'danger' ? 12000 : 6000);
  }
  if (voice) {
    try { navigator.vibrate?.([220, 120, 220]); } catch {}
    say(text);
  }
}

$('alert-close').onclick = hideAlert;
window.addEventListener('storage-warning', () => notify('浏览器存储不可用或空间不足；请导出标记。', { level: 'warn' }));

function menu(open) {
  $('tools-menu').hidden = !open;
  $('menu-open').setAttribute('aria-expanded', String(open));
  if (open) $('menu-close').focus();
}
$('menu-open').onclick = () => menu(true);
$('menu-close').onclick = () => { menu(false); $('menu-open').focus(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') menu(false); });
function tab(name) {
  document.querySelectorAll('#tools-menu .tab-panel').forEach(p => { p.hidden = p.id !== `tab-${name}`; });
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  menu(name !== 'route');
}
document.querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => tab(b.dataset.tab); });
$('layer-restrictions').onchange = e => [osmLayer, labelLayer].forEach(layer => e.target.checked ? layer.addTo(map) : layer.remove());
$('layer-edits').onchange = e => e.target.checked ? editLayer.addTo(map) : editLayer.remove();
let greenLoaded = false;
$('layer-green').onchange = async e => {
  if (e.target.checked) {
    if (!greenLoaded) { greenLoaded = true; await loadTruckOkRoads(); }
    if (e.target.checked) truckOkLayer.addTo(map);
  } else truckOkLayer.remove();
};
truckOkLayer.remove();

function recomputeOverrides() {
  cachedOverrideState = applyDriverOverrides(features, edits);
  return cachedOverrideState;
}

function allRestrictions() {
  return cachedOverrideState.effectiveFeatures;
}

function setDataStatus(base, suffix = '') {
  if (base != null) baseDataStatus = formatDataStatus(base);
  $('data-status').textContent = formatDataStatus(baseDataStatus, suffix);
}

function buildOsmPopupElement(entry) {
  const { feature: f, overrideType, overriddenBy, effectiveRestrictions } = entry;
  const div = document.createElement('div');
  const title = f.tags.name || f.tags.ref || '未命名道路 / 限行点';
  const origTexts = f.restrictions.map(label);
  const effTexts = effectiveRestrictions.map(label);
  const blocked = effectiveRestrictions.some(r => relevant(r, vehicle));

  let bodyHtml = `<strong>${esc(title)}</strong>`;
  if (overrideType === 'can') {
    bodyHtml += `<br><b style="color:#15803d">✓ 已被司机标记「可以通过」覆盖</b>`;
    if (overriddenBy?.notes) bodyHtml += `<br>司机备注：${esc(overriddenBy.notes)}`;
    bodyHtml += `<br><small>原 OSM：${origTexts.map(esc).join('；')}</small>`;
  } else if (overrideType === 'restriction' || overrideType === 'cannot') {
    bodyHtml += `<br><b style="color:#6d28d9">★ 已应用司机纠偏（覆盖同项 OSM）</b>`;
    bodyHtml += `<br>${effTexts.map(esc).join('<br>')}`;
    if (overriddenBy?.notes) bodyHtml += `<br>司机备注：${esc(overriddenBy.notes)}`;
    bodyHtml += `<br><small>原 OSM：${origTexts.map(esc).join('；')}</small>`;
  } else {
    bodyHtml += `<br>${origTexts.map(esc).join('<br>')}`;
    bodyHtml += `<br><b>${blocked ? '本车可能超限 / 禁入，请避让或核实' : '按已填尺寸可通行（含 3 英寸余量），仍需看路牌'}</b>`;
  }
  bodyHtml += `<br><small>条件、方向、时段及例外未自动判定</small>`;
  bodyHtml += `<br><a target="_blank" rel="noopener" href="https://www.openstreetmap.org/${f.osmType}/${f.osmId}">查看 OSM 原始数据</a>`;
  div.innerHTML = bodyHtml;

  const actions = document.createElement('div');
  actions.className = 'popup-actions';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = overriddenBy ? '编辑此纠偏' : '纠偏 / 覆盖此限行';
  btn.onclick = () => {
    map.closePopup();
    if (overriddenBy) {
      openEdit(overriddenBy);
    } else {
      const mid = featureMidpoint(f.displayCoords || f.coords) || f.coords[0];
      openEdit({
        lat: mid[0],
        lng: mid[1],
        type: 'restriction',
        notes: '',
        osmRef: f.osmRef,
        osmFeatureId: f.id,
        roadName: title,
      });
    }
  };
  actions.append(btn);
  div.append(actions);
  return div;
}

function getBadgeDescriptor(entry) {
  const { feature: f, overrideType, effectiveRestrictions } = entry;
  const drawCoords = f.displayCoords || f.coords;
  const mid = featureMidpoint(drawCoords);
  if (!mid) return null;

  if (overrideType === 'can') {
    return {
      latlng: mid,
      priority: 1,
      width: 118,
      height: 30,
      html: `<div class="override-pill">✓ 司机标可通</div>`,
      entry,
    };
  }

  const rs = effectiveRestrictions;
  const blocked = rs.some(r => relevant(r, vehicle));
  const ban = rs.find(r => r.kind === 'ban');
  const heightRs = rs.filter(r => r.kind === 'height' && r.value != null).sort((a, b) => a.value - b.value);
  const weightRs = rs.filter(r => (r.kind === 'weight' || r.kind === 'axle') && r.value != null).sort((a, b) => a.value - b.value);

  if (heightRs.length) {
    const h = heightRs[0];
    const b = formatHeightBadge(h.value, h.raw);
    const isDriver = Boolean(h.driverOverride);
    const hBlocked = relevant(h, vehicle);
    const cls = isDriver ? 'driver' : (hBlocked ? 'blocked' : 'clear');
    const prefix = isDriver ? '纠偏 ' : '↕ ';
    return {
      latlng: mid,
      priority: isDriver ? 0 : (hBlocked ? 2 : 4),
      width: isDriver ? 112 : 84,
      height: 32,
      html: `<div class="h-pill ${cls}">${prefix}${esc(b.imperial)}</div>`,
      entry,
    };
  }

  if (ban) {
    const isDriver = Boolean(ban.driverOverride);
    const isCond = Boolean(ban.conditional);
    const cls = isDriver ? 'driver' : (isCond ? 'cond' : '');
    const txt = isDriver ? '⊘ 司机禁行' : (isCond ? '⚠ 条件禁行' : '⊘ 禁卡车');
    return {
      latlng: mid,
      priority: isDriver ? 0 : (isCond ? 3 : 1),
      width: 104,
      height: 32,
      html: `<div class="ban-pill ${cls}">${txt}</div>`,
      entry,
    };
  }

  if (weightRs.length) {
    const w = weightRs[0];
    const lbsTxt = formatWeightLbs(w.value, w.raw);
    return {
      latlng: mid,
      priority: blocked ? 4 : 6,
      width: 132,
      height: 30,
      html: `<div class="weight-pill">限重 ${esc(lbsTxt)}</div>`,
      entry,
    };
  }

  return null;
}

function renderLabels() {
  labelLayer.clearLayers();
  const zoom = map.getZoom();
  const bounds = map.getBounds().pad(0.15);
  const candidates = [];

  for (const entry of cachedOverrideState.osmEntries) {
    const desc = getBadgeDescriptor(entry);
    if (!desc) continue;
    if (!bounds.contains(desc.latlng)) continue;
    candidates.push(desc);
  }

  // Sort by priority (driver overrides & no-truck & blocked low bridges first), then lowest clearance
  candidates.sort((a, b) => a.priority - b.priority);

  const placed = [];
  const pad = zoom >= 15 ? 2 : (zoom >= 13 ? 8 : 16);
  const maxBadges = zoom >= 15 ? 160 : (zoom >= 13 ? 80 : 40);
  const maxBanAtFarZoom = zoom < 13 ? Math.floor(maxBadges * 0.5) : maxBadges;
  let banPlaced = 0;

  for (const c of candidates) {
    if (placed.length >= maxBadges) break;
    if (c.priority === 1 && banPlaced >= maxBanAtFarZoom) continue;
    const pt = map.latLngToContainerPoint(c.latlng);
    const halfW = (c.width / 2) + pad;
    const halfH = (c.height / 2) + pad;
    const box = { x1: pt.x - halfW, y1: pt.y - halfH, x2: pt.x + halfW, y2: pt.y + halfH };
    const overlaps = placed.some(b => !(box.x2 < b.x1 || box.x1 > b.x2 || box.y2 < b.y1 || box.y1 > b.y2));
    if (overlaps) continue;
    placed.push(box);
    if (c.priority === 1) banPlaced++;

    const badge = L.marker(c.latlng, {
      icon: L.divIcon({
        className: 'map-badge',
        html: c.html,
        iconSize: [c.width, c.height],
        iconAnchor: [c.width / 2, c.height / 2],
      }),
      zIndexOffset: c.priority <= 1 ? 300 : 200,
    });
    // Open popup independently on map so autoPan -> moveend -> renderLabels() never destroys an open popup.
    badge.on('click', ev => {
      if (ev?.originalEvent) L.DomEvent.stopPropagation(ev.originalEvent);
      L.popup(POPUP_OPTS)
        .setLatLng(c.latlng)
        .setContent(buildOsmPopupElement(c.entry))
        .openOn(map);
    });
    badge.addTo(labelLayer);
  }
}

function osmZoomBucket(z) {
  if (z >= 15) return 3;
  if (z >= 13) return 2;
  if (z >= 11) return 1;
  return 0;
}

function buildTruckOkPopup(r) {
  const div = document.createElement('div');
  const title = r.name || '公共主干道';
  const clsLabel = TRUCK_OK_CLASS_LABELS[r.highway] || r.highway;
  div.innerHTML =
    `<strong>${esc(title)}</strong>` +
    `<br><b style="color:#15803d">✓ 正常通行（公共货车可走参考）</b>` +
    `<br>道路等级：${esc(clsLabel)} (${esc(r.highway)})` +
    `<br><small>基于 OSM 公共主干路网（已剔除已知禁行、限高、限重及内部通道）；不含临时施工或最新限行，请以现场路牌为准。</small>` +
    `<br><a target="_blank" rel="noopener" href="https://www.openstreetmap.org/way/${r.osmId}">查看 OSM 原始数据</a>`;

  const actions = document.createElement('div');
  actions.className = 'popup-actions';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '标记此路禁行 / 限行';
  btn.onclick = () => {
    map.closePopup();
    const mid = featureMidpoint(r.coords) || r.coords[0];
    openEdit({
      lat: mid[0],
      lng: mid[1],
      type: 'cannot',
      notes: '',
      osmRef: r.osmRef,
      osmFeatureId: r.id,
      roadName: title,
    });
  };
  actions.append(btn);
  div.append(actions);
  return div;
}

// Viewport-culled, zoom-tiered renderer for public truck-OK green roads.
// Uses exact OSM way coordinates (`smoothFactor: 0`, `lineCap: 'butt'`) in `truckOkPane` (zIndex 380) beneath restrictions.
function renderTruckOkRoads() {
  truckOkLayer.clearLayers();
  if (!filteredTruckOkRoads.length) return;
  const zoom = map.getZoom();
  if (zoom < 10) return;

  const bounds = map.getBounds().pad(0.2);
  const s = bounds.getSouth(), w = bounds.getWest(), n = bounds.getNorth(), e = bounds.getEast();

  for (const r of filteredTruckOkRoads) {
    if (zoom < r.minZoom) continue;
    const [rs, rw, rn, re] = r.bbox;
    if (rn < s || rs > n || re < w || rw > e) continue;
    const st = truckOkStyleForZoom(r.highway, zoom);
    if (!st.visible) continue;

    if (st.haloWeight > 0) {
      L.polyline(r.coords, {
        color: '#ffffff',
        weight: st.haloWeight,
        opacity: 0.88,
        interactive: false,
        smoothFactor: 0,
        lineCap: 'butt',
        pane: 'truckOkPane',
        renderer: truckOkRenderer,
      }).addTo(truckOkLayer);
    }

    const line = L.polyline(r.coords, {
      color: '#22c55e',
      weight: st.weight,
      opacity: st.opacity,
      smoothFactor: 0,
      lineCap: 'butt',
      pane: 'truckOkPane',
      renderer: truckOkRenderer,
    });
    line.bindPopup(() => buildTruckOkPopup(r), POPUP_OPTS);
    line.addTo(truckOkLayer);
  }
}

function renderOSM() {
  osmLayer.clearLayers();
  const zoom = map.getZoom();
  lastOsmZoomBucket = osmZoomBucket(zoom);
  const { osmEntries } = recomputeOverrides();

  for (const entry of osmEntries) {
    const { feature: f, overrideType, effectiveRestrictions } = entry;
    const drawCoords = f.displayCoords || f.coords;
    const popupFn = () => buildOsmPopupElement(entry);

    if (overrideType === 'can') {
      if (drawCoords.length === 1) {
        const layer = L.circleMarker(drawCoords[0], { radius: 8, color: '#15803d', weight: 2.5, fillOpacity: 0.45 });
        layer.bindPopup(popupFn, POPUP_OPTS);
        layer.addTo(osmLayer);
      } else {
        L.polyline(drawCoords, { color: '#ffffff', weight: 9, opacity: 0.9, interactive: false, smoothFactor: 0, lineCap: 'butt' }).addTo(osmLayer);
        const layer = L.polyline(drawCoords, { color: '#16a34a', weight: 5, opacity: 0.9, dashArray: '7 7', smoothFactor: 0, lineCap: 'butt' });
        layer.bindPopup(popupFn, POPUP_OPTS);
        layer.addTo(osmLayer);
      }
      continue;
    }

    const rs = effectiveRestrictions;
    const blocked = rs.some(r => relevant(r, vehicle));
    const hasHardBan = rs.some(r => r.kind === 'ban' && !r.conditional);
    const hasCondBan = rs.some(r => r.kind === 'ban' && r.conditional);
    const hasHeight = rs.some(r => r.kind === 'height');
    const isDriver = overrideType === 'cannot' || overrideType === 'restriction';

    if (drawCoords.length === 1) {
      const color = hasHardBan ? '#dc2626' : hasHeight ? (blocked ? '#dc2626' : '#0369a1') : '#d97706';
      const dot = L.circleMarker(drawCoords[0], {
        radius: blocked ? 10 : 7,
        color: '#ffffff',
        weight: 2.5,
        fillColor: color,
        fillOpacity: 0.98,
      });
      dot.bindPopup(popupFn, POPUP_OPTS);
      dot.addTo(osmLayer);
      continue;
    }

    // Named public service roads render distinctly thinner than public through-roads (smoothFactor: 0, lineCap: 'butt').
    if (f.isServiceRoad) {
      const color = hasHardBan ? '#be123c' : hasHeight ? '#0369a1' : '#b45309';
      const line = L.polyline(drawCoords, { color, weight: 4.5, opacity: 0.9, dashArray: '5 6', smoothFactor: 0, lineCap: 'butt' });
      line.bindPopup(popupFn, POPUP_OPTS);
      line.addTo(osmLayer);
      continue;
    }

    if (hasHardBan) {
      // Unmistakable high-contrast 3-layer No-Trucks styling: wide white halo + vivid crimson core + yellow warning dashes
      // Uses display-only curb-trimmed `drawCoords` + `lineCap: 'butt'` while canonical `f.coords` stays full for routing/alerts.
      const baseW = zoom >= 15 ? 11 : (zoom >= 13 ? 9.5 : 7);
      L.polyline(drawCoords, { color: '#ffffff', weight: baseW + 6, opacity: 0.98, interactive: false, smoothFactor: 0, lineCap: 'butt' }).addTo(osmLayer);
      const core = L.polyline(drawCoords, { color: isDriver ? '#7e22ce' : '#dc2626', weight: baseW, opacity: 1, smoothFactor: 0, lineCap: 'butt' });
      core.bindPopup(popupFn, POPUP_OPTS);
      core.addTo(osmLayer);
      L.polyline(drawCoords, { color: '#fde047', weight: zoom >= 14 ? 3.5 : 3, dashArray: '9 10', opacity: 0.98, interactive: false, smoothFactor: 0, lineCap: 'butt' }).addTo(osmLayer);
    } else if (hasCondBan) {
      L.polyline(drawCoords, { color: '#ffffff', weight: zoom >= 14 ? 11 : 9, opacity: 0.95, interactive: false, smoothFactor: 0, lineCap: 'butt' }).addTo(osmLayer);
      const line = L.polyline(drawCoords, { color: '#ea580c', weight: zoom >= 14 ? 7 : 5.5, opacity: 0.98, dashArray: '9 6', smoothFactor: 0, lineCap: 'butt' });
      line.bindPopup(popupFn, POPUP_OPTS);
      line.addTo(osmLayer);
    } else if (hasHeight) {
      const color = isDriver ? '#6d28d9' : (blocked ? '#dc2626' : '#0369a1');
      const haloW = blocked || isDriver ? (zoom >= 14 ? 12 : 10) : 8;
      const lineW = blocked || isDriver ? (zoom >= 14 ? 7.5 : 6) : (zoom >= 14 ? 5 : 4);
      L.polyline(drawCoords, { color: '#ffffff', weight: haloW, opacity: 0.92, interactive: false, smoothFactor: 0, lineCap: 'butt' }).addTo(osmLayer);
      const line = L.polyline(drawCoords, { color, weight: lineW, opacity: blocked || isDriver ? 0.98 : 0.9, smoothFactor: 0, lineCap: 'butt' });
      line.bindPopup(popupFn, POPUP_OPTS);
      line.addTo(osmLayer);
    } else {
      const color = isDriver ? '#6d28d9' : '#d97706';
      L.polyline(drawCoords, { color: '#ffffff', weight: blocked ? 11 : 8, opacity: 0.9, interactive: false, smoothFactor: 0, lineCap: 'butt' }).addTo(osmLayer);
      const line = L.polyline(drawCoords, { color, weight: blocked ? 7 : 4.5, opacity: blocked ? 0.96 : 0.88, smoothFactor: 0, lineCap: 'butt' });
      line.bindPopup(popupFn, POPUP_OPTS);
      line.addTo(osmLayer);
    }
  }

  renderLabels();
}

function driverBadgeHtml(e) {
  if (e.type === 'can') return `<div class="driver-dot can">✓ 司机可通</div>`;
  if (e.type === 'cannot') return `<div class="driver-dot cannot">⊘ 司机禁行</div>`;
  if (e.height > 0) {
    const b = formatHeightBadge(e.height, e.heightRaw || '');
    return `<div class="driver-dot">★ ${esc(b.imperial)}</div>`;
  }
  if (e.weight > 0) {
    return `<div class="driver-dot">★ 限重 ${esc(formatWeightLbs(e.weight, e.weightRaw))}</div>`;
  }
  return `<div class="driver-dot">! 司机限行</div>`;
}

function formatEditSummary(e) {
  const parts = [];
  if (e.height > 0) {
    const b = formatHeightBadge(e.height, e.heightRaw || '');
    parts.push(`限高 ${b.imperial}`);
  }
  if (e.weight > 0) {
    parts.push(`限重 ${formatWeightShort(e.weight, e.weightRaw)}`);
  }
  return parts.join(' · ');
}

async function deleteEdit(item) {
  if (!window.confirm('确定删除这条司机标记吗？删除后将恢复该位置原有的 OSM 限行显示与预警。')) return;
  edits = edits.filter(x => x.id !== item.id);
  alerts.delete(`driver/${item.id}`);
  try {
    await store.remove(edits, item.id);
  } catch (err) {
    notify(err.message, { level: 'warn' });
  }
  renderAll();
  invalidateRoute();
  notify('已删除该司机标记。', { level: 'info' });
}

function renderEdits() {
  editLayer.clearLayers();
  $('edit-list').replaceChildren();

  for (const e of edits) {
    const html = driverBadgeHtml(e);
    const marker = L.marker([e.lat, e.lng], {
      icon: L.divIcon({ className: 'map-badge', html, iconSize: [130, 32], iconAnchor: [65, 16] }),
      zIndexOffset: 400,
    }).addTo(editLayer);

    const typeText = { can: '可以通过（覆盖同位置 OSM）', cannot: '不能通过（卡车禁行）', restriction: '新限行点 / 纠偏' }[e.type];
    const limitSummary = formatEditSummary(e);

    const box = document.createElement('div');
    box.innerHTML =
      `<strong>${esc(typeText)}</strong>` +
      (e.roadName ? `<br>${esc(e.roadName)}` : '') +
      (limitSummary ? `<br><b>${esc(limitSummary)}</b>` : '') +
      (e.notes ? `<br>${esc(e.notes)}` : '') +
      `<br><small>司机纠偏 · 本机优先覆盖 OSM · 仍需核实路牌</small>`;

    const popupActions = document.createElement('div');
    popupActions.className = 'popup-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = '编辑此标记';
    editBtn.onclick = () => { map.closePopup(); openEdit(e); };
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'danger-btn';
    delBtn.textContent = '删除';
    delBtn.onclick = () => { map.closePopup(); deleteEdit(e); };
    popupActions.append(editBtn, delBtn);
    box.append(popupActions);
    marker.bindPopup(box, POPUP_OPTS);

    const card = document.createElement('div');
    card.className = 'edit-card';
    card.innerHTML =
      `<strong>${esc(typeText)}</strong>` +
      (limitSummary ? `<br>${esc(limitSummary)}` : '') +
      `<br>${esc(e.notes || '无备注')}` +
      `<br><small>${e.lat.toFixed(5)}, ${e.lng.toFixed(5)}</small>`;

    const cardActions = document.createElement('div');
    cardActions.className = 'edit-card-actions';
    const cardEdit = document.createElement('button');
    cardEdit.type = 'button';
    cardEdit.textContent = '查看 / 编辑';
    cardEdit.onclick = () => {
      map.setView([e.lat, e.lng], 16);
      openEdit(e);
    };
    const cardDel = document.createElement('button');
    cardDel.type = 'button';
    cardDel.className = 'danger-btn';
    cardDel.textContent = '删除';
    cardDel.onclick = () => deleteEdit(e);
    cardActions.append(cardEdit, cardDel);
    card.append(cardActions);
    $('edit-list').append(card);
  }

  if (!edits.length) {
    $('edit-list').textContent = '还没有标记。点击地图限行弹窗「纠偏」或「添加标记」记录现场情况。';
  }
}

function renderAll() {
  filteredTruckOkRoads = filterTruckOkRoads(rawTruckOkRoads, features, edits);
  renderTruckOkRoads();
  renderOSM();
  renderEdits();
}

map.on('moveend zoomend', () => {
  renderTruckOkRoads();
  if (osmZoomBucket(map.getZoom()) !== lastOsmZoomBucket) {
    renderOSM();
  } else {
    renderLabels();
  }
});

function setRouteStatus(text, mode = 'normal', title = '') {
  const el = $('route-status');
  const txt = $('route-status-text');
  const titleEl = el?.querySelector('.route-banner-title');
  el.classList.toggle('route-loading', mode === 'loading');
  el.classList.toggle('route-blocked', mode === 'blocked');
  el.classList.toggle('route-unavailable', mode === 'unavailable');
  if (titleEl) {
    titleEl.textContent = title ? `⚠ ${title}` : '';
    titleEl.hidden = !title;
  }
  if (txt) {
    txt.textContent = text;
  } else {
    el.textContent = title ? `${title}：${text}` : text;
  }
  if ($('goto-ors-settings')) {
    $('goto-ors-settings').hidden = mode !== 'unavailable';
  }
}

function stopNavigation(message = '导航已结束。') {
  queuedPlan = false;
  route = null;
  routeEpoch++;
  routeLayer.clearLayers();
  $('turns').replaceChildren();
  $('stop-nav').hidden = true;
  if (!getKey()) {
    keyStatus();
  } else {
    setRouteStatus(message, 'normal');
  }
  offCount = 0;
  turnSpoken.clear();
}

function invalidateRoute() {
  if (route || routeBusy || routeLayer.getLayers().length) stopNavigation('车辆、标记或限行数据已变化，请重新规划路线。');
}

function showCache(data) {
  const at = data.snapshot?.fetchedAt || data.fetchedAt || data.osm3s?.timestamp_osm_base || '未知';
  const cov = data.snapshot?.coverage ? ` ${data.snapshot.coverage}` : '';
  $('cache-info').textContent = `数据时间：${at}。覆盖范围 33.4–34.85°N / 119–116.8°W。${cov} OSM 数据可能不完整，空白不表示允许通行。`;
}

async function fetchOverpassResilient() {
  const configured = [];
  if (cfg.overpassUrl) configured.push(cfg.overpassUrl);
  if (Array.isArray(cfg.overpassUrls)) {
    for (const u of cfg.overpassUrls) {
      if (u && !configured.includes(u)) configured.push(u);
    }
  }
  const endpoints = configured.length ? configured : OVERPASS_ENDPOINTS;

  // Query 4 chunked tiles (starting from core LA metro) across alternate endpoints with sticky healthy mirror.
  const tiles = overpassTiles(BBOX, 2, 2);
  const tileResults = [];
  const usedEndpoints = new Set();
  let tilesOk = 0;
  let orderedEndpoints = [...endpoints];

  for (let i = 0; i < tiles.length; i++) {
    const bbox = tiles[i];
    const query = buildOverpassQuery(bbox);
    let tileSuccess = false;
    let tileElements = [];
    let preserveExisting = false;
    for (const ep of orderedEndpoints) {
      try {
        const r = await fetch(ep, {
          method: 'POST',
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(OVERPASS_FETCH_TIMEOUT_MS),
        });
        if (!r.ok) throw Error(`HTTP ${r.status}`);
        const data = await r.json();
        tileElements = usableOverpassElements(data);
        preserveExisting = Boolean(data.remark);
        usedEndpoints.add(ep);
        orderedEndpoints = [ep, ...orderedEndpoints.filter(u => u !== ep)];
        tilesOk++;
        tileSuccess = true;
        break;
      } catch {
        // Try next alternate endpoint
      }
    }
    tileResults.push({ bbox, ok: tileSuccess, elements: tileElements, preserveExisting });
    if (!tileSuccess && i === 0) {
      // If core tile failed on all mirrors (e.g. offline), mark remaining tiles failed without hanging.
      for (let j = i + 1; j < tiles.length; j++) {
        tileResults.push({ bbox: tiles[j], ok: false, elements: [] });
      }
      break;
    }
  }

  if (tilesOk === 0) throw Error('Overpass 在线暂不可用');
  return {
    tileResults,
    usedEndpoints: [...usedEndpoints],
    fetchedAt: new Date().toISOString(),
  };
}

async function loadTruckOkRoads() {
  try {
    const r = await fetch('./data/truck-ok-roads.json');
    if (!r.ok) return;
    const data = await r.json();
    rawTruckOkRoads = decodeTruckOkRoads(data);
    filteredTruckOkRoads = filterTruckOkRoads(rawTruckOkRoads, features, edits);
    renderTruckOkRoads();
  } catch {
    // Non-fatal: restriction layer remains fully functional even if optional green road file is unavailable
  }
}

async function loadData() {
  try {
    const snap = await fetch('./data/osm-snapshot.json').then(r => { if (!r.ok) throw Error(); return r.json(); });
    const snapFeatures = fromOverpass(snap);
    const cached = read('osm-cache', null);
    let chosen = snap;
    let chosenFeatures = snapFeatures;
    let labelText = `OSM 内置快照 · ${snapFeatures.length} 段道路限行`;

    if (cached) {
      try {
        const cachedFeatures = fromOverpass(cached);
        const cachedTime = cached.fetchedAt || cached.snapshot?.fetchedAt || '';
        const snapTime = snap.snapshot?.fetchedAt || '';
        const unmergedPartial = Boolean(cached.snapshot?.partial && !cached.snapshot?.mergedWithSnapshot);
        const coveragePreserved = cachedFeatures.length >= Math.floor(snapFeatures.length * 0.5);
        // Prefer cached data only if it is newer, non-empty, and does not represent a truncated partial fetch.
        if (cachedFeatures.length && cachedTime >= snapTime && !unmergedPartial && coveragePreserved) {
          chosen = cached;
          chosenFeatures = cachedFeatures;
          labelText = cached.snapshot?.partial
            ? `本机 OSM 缓存（部分更新+快照合并） · ${cachedFeatures.length} 段道路限行`
            : `本机 OSM 缓存 · ${cachedFeatures.length} 段道路限行`;
        }
      } catch {
        // Ignore stale/invalid cache
      }
    }

    rawElements = Array.isArray(chosen.elements) ? chosen.elements : [];
    rawJunctions = (chosen.junctions && typeof chosen.junctions === 'object') ? chosen.junctions : (snap.junctions || {});
    features = chosenFeatures;
    setDataStatus(labelText);
    showCache(chosen);
    renderAll();
  } catch {
    setDataStatus('快照读取失败，尝试在线获取');
  }
  restrictionsReady = features.length > 0;
  // Auto-refresh on load does NOT consume the 1-minute manual cooldown (m4).
  requestAnimationFrame(() => refreshData({ manual: false }));
}

async function refreshData(arg = {}) {
  const manual = arg instanceof Event ? true : arg.manual !== false;
  if (refreshBusy) return;
  if (manual && Date.now() - lastManualRefresh < 60000) {
    notify('请等待至少一分钟再手动刷新 OSM。', { level: 'info' });
    return;
  }
  refreshBusy = true;
  if (manual) lastManualRefresh = Date.now();
  $('refresh-data').disabled = true;
  setDataStatus(null, '正在更新…');
  try {
    const res = await fetchOverpassResilient();
    const merged = mergeOverpassTileResults(rawElements, res.tileResults);
    if (!merged.changed || merged.tilesOk === 0 || !merged.elements.length) {
      throw Error('无可用在线更新，保留离线数据');
    }
    const mergedPayload = {
      version: 0.6,
      elements: merged.elements,
      junctions: rawJunctions,
      fetchedAt: res.fetchedAt,
      snapshot: {
        fetchedAt: res.fetchedAt,
        source: res.usedEndpoints.join(', '),
        partial: merged.partial,
        mergedWithSnapshot: true,
        tilesOk: merged.tilesOk,
        tilesTotal: merged.tilesTotal,
        coverage: merged.partial
          ? `部分在线更新（${merged.tilesOk}/${merged.tilesTotal} 区块成功；失败区块已保留原离线快照数据，仅保留道路限行）。`
          : `在线分块更新（${merged.tilesOk}/${merged.tilesTotal} 区块全部成功，仅保留道路限行）。`,
      },
    };
    const next = fromOverpass(mergedPayload);
    if (!next.length) throw Error('无完整限行数据');
    rawElements = merged.elements;
    features = next;
    restrictionsReady = true;
    // Compact cache payload and skip localStorage cache if > 2.5 MB to avoid quota warning
    try {
      const compact = {
        version: mergedPayload.version,
        fetchedAt: mergedPayload.fetchedAt,
        snapshot: mergedPayload.snapshot,
        elements: merged.elements.map(({ type, id, lat, lon, tags, geometry, members }) => ({
          type, id, ...(lat != null ? { lat, lon } : {}), tags, ...(geometry ? { geometry } : {}), ...(members ? { members } : {}),
        })),
      };
      const serialized = JSON.stringify(compact);
      if (serialized.length < 2500000) localStorage.setItem('la-truck:osm-cache', serialized);
    } catch {
      // Non-fatal: bundled snapshot remains available offline
    }
    renderAll();
    invalidateRoute();
    showCache(mergedPayload);
    if (merged.partial) {
      setDataStatus(`OSM 部分更新（${merged.tilesOk}/${merged.tilesTotal} 区块，余保留离线） · ${features.length} 段道路限行`);
      if (manual) notify(`已完成部分在线更新（${merged.tilesOk}/${merged.tilesTotal} 区块成功，失败区块保留离线数据），共 ${features.length} 段道路限行。`, { level: 'info' });
    } else {
      setDataStatus(`OSM 在线更新 · ${features.length} 段道路限行`);
      if (manual) notify(`已在线更新 ${features.length} 段道路限行数据。`, { level: 'info' });
    }
  } catch {
    setDataStatus(null, refreshFailureStatus(baseDataStatus));
  } finally {
    refreshBusy = false;
    $('refresh-data').disabled = false;
  }
}

$('refresh-data').onclick = () => refreshData({ manual: true });

// Vehicle profile form (persists and displays US units: ft & lbs)
const vehicleKeys = ['weight', 'height', 'length', 'width', 'axle'];
const defaultUnits = { weight: 'lb', height: 'ft', length: 'ft', width: 'ft', axle: 'lb' };
function syncVehicleFormInputs() {
  for (const key of vehicleKeys) {
    $(key).value = profileRaw[key] || '';
    const sel = $(key + '-unit');
    const desired = profileRaw[key + 'Unit'] || defaultUnits[key];
    const hasOpt = Array.from(sel.options).some(o => o.value === desired);
    sel.value = hasOpt ? desired : defaultUnits[key];
  }
}
syncVehicleFormInputs();

$('vehicle-form').onsubmit = e => {
  e.preventDefault();
  const submitted = {};
  for (const k of vehicleKeys) {
    submitted[k] = $(k).value.trim();
    submitted[k + 'Unit'] = $(k + '-unit').value || defaultUnits[k];
  }
  // Normalize any non-default weight unit (e.g. tons) to lbs on save so persisted/displayed profile stays ft & lbs.
  profileRaw = migrateVehicleProfile(submitted).profile;
  syncVehicleFormInputs();
  vehicle = vehicleFromForm(profileRaw);
  const saved = write('profile', profileRaw);
  alerts.clear();
  renderAll();
  invalidateRoute();
  $('vehicle-status').textContent = saved
    ? '已保存。地图红牌/粗线已按当前车高（含 3 英寸安全余量）与车重刷新。'
    : '存储失败，仅本次会话生效。';
  notify('车辆资料已保存并更新地图限高标记。', { level: 'info' });
};

// Settings
const validDistances = [152, 244, 457, 762];
const initDist = validDistances.reduce((best, v) => Math.abs(v - settings.distance) < Math.abs(best - settings.distance) ? v : best, 244);
settings.distance = initDist;
$('warning-distance').value = String(initDist);
$('voice').checked = settings.voice;
function saveSettings() {
  settings = { distance: Number($('warning-distance').value), voice: $('voice').checked };
  write('settings', settings);
  if (!settings.voice) window.speechSynthesis?.cancel();
}
$('warning-distance').onchange = saveSettings;
$('voice').onchange = saveSettings;
$('test-alert').onclick = () => {
  lastGlobalAlert = 0;
  lastSpeech = 0;
  notify('预警测试：前方低桥限高，请核实路牌。', { level: 'danger', voice: true });
};

// Keep the password field blank: the built-in key is never copied into the UI.
$('ors-key').value = '';
const getKey = () => effectiveOrsKey(read('ors-key', ''), cfg.orsKey);
function keyStatus() {
  const st = getRouteUnavailableState(Boolean(getKey()));
  setRouteStatus(st.message, st.available ? 'normal' : 'unavailable', st.title);
}
keyStatus();
if ($('goto-ors-settings')) {
  $('goto-ors-settings').onclick = () => {
    tab('settings');
    showKeyHint();
    $('ors-key').focus();
  };
}

function showKeyHint() {
  $('key-install-hint').hidden = isStandalone();
  $('key-install-hint').textContent = isStandalone() ? '' : KEY_INSTALL_HINT;
}
$('ors-form').onsubmit = e => {
  e.preventDefault();
  const value = $('ors-key').value.trim();
  const saved = write('ors-key', value);
  const feedback = keySaveFeedback(saved, Boolean(value), isStandalone());
  $('key-feedback').textContent = feedback.message;
  if (saved && !value && getKey()) $('key-feedback').textContent = '已清除本机替换密钥，继续使用内置密钥。';
  $('key-install-hint').textContent = feedback.hint;
  $('key-install-hint').hidden = !feedback.hint;
  if (!saved) return;
  $('ors-key').value = '';
  invalidateRoute();
  keyStatus();
};

// Follow button state machine (M2)
function syncFollowUI() {
  $('follow').textContent = followButtonLabel(followState.mode, followState.following);
}
syncFollowUI();

map.on('dragstart', () => {
  followState = onMapDrag(followState);
  syncFollowUI();
});

function setPosition(coords, heading = null, accuracy = null, isDemo = false, timestamp = null) {
  let next = { coords, heading, accuracy, isDemo, timestamp };
  if (!isDemo) {
    const previous = current?.isDemo ? null : current;
    next = selectGpsFix(previous, next);
    if (!next || next === previous) return;
    accuracy = next.accuracy;
  }
  current = next;
  if (pendingGpsPlan && !isDemo) {
    pendingGpsPlan = false;
    setEndpoint('origin', coords, '当前位置');
    queueMicrotask(() => planRoute());
  }
  if (!truck) {
    truck = L.marker(coords, {
      icon: L.divIcon({
        className: 'truck-icon',
        html: '<div class="truck-pointer">▲</div>',
        iconSize: [42, 42],
        iconAnchor: [21, 21],
      }),
      zIndexOffset: 500,
    }).addTo(map);
    accuracyCircle = L.circle(coords, { radius: accuracy, color: '#2563eb', weight: 1, fillOpacity: 0.08 }).addTo(map);
  }
  truck.setLatLng(coords);
  truck.getElement()?.querySelector('.truck-pointer')?.style.setProperty('transform', `rotate(${heading || 0}deg)`);
  accuracyCircle.setLatLng(coords).setRadius(accuracy || 0);
  const accFt = Math.round((accuracy || 0) * 3.28084);
  truck.bindTooltip(isDemo ? '演示位置（非 GPS）' : `GPS · 精度 ±${accFt} ft`);

  if (followState.following) {
    map.setView(coords, Math.max(map.getZoom(), 15), { animate: true });
  }

  $('location-status').textContent = isDemo
    ? `演示位置 · 不是真实 GPS · ${followState.following ? '正在跟随演示点' : '已暂停跟随（点重新跟随回到演示点）'}`
    : `GPS 已更新 · 精度 ±${accFt} ft${accuracy > 100 ? '，精度较低，预警暂缓' : ''} · ${followState.following ? '正在跟随' : '已暂停跟随'}`;
  $('gps-accuracy-hint').hidden = isDemo || accuracy <= 100;

  if (isDemo || accuracy <= 100) {
    checkAlerts();
    updateNavigation();
  }
}

function setPlanningUi(loading) {
  const button = $('route-btn');
  button.disabled = false; // Repeated taps refresh feedback and queue a new plan.
  button.textContent = loading ? '正在规划…' : '规划卡车路线';
  button.setAttribute('aria-busy', String(loading));
}

function finishGpsWait() {
  clearTimeout(gpsPlanTimer);
  gpsPlanTimer = null;
  $('route-pick-start').hidden = true;
  setPlanningUi(routeBusy);
}

function gpsPlanFailed() {
  clearTimeout(gpsPlanTimer);
  gpsPlanTimer = null;
  // Keep pendingGpsPlan and the watch: a late valid fix can still auto-plan.
  if (!pendingGpsPlan || origin) return;
  setPlanningUi(routeBusy);
  $('route-pick-start').hidden = false;
  setRouteStatus('定位未成功，请允许定位，或点下方按钮在地图上点选起点；也可在「更多」手动填写起点。', 'blocked');
}

function startGpsWatch(requestOnce = false) {
  if (!window.isSecureContext || !navigator.geolocation) {
    followState = { mode: 'idle', following: false };
    syncFollowUI();
    gpsPlanFailed();
    $('location-status').textContent = '此连接不支持定位：请用 localhost 或可信 HTTPS。可用地图点选起点。';
    return;
  }
  followState = { mode: 'gps', following: true };
  syncFollowUI();
  const success = p => setPosition([p.coords.latitude, p.coords.longitude], p.coords.heading, p.coords.accuracy, false, p.timestamp);
  const failure = err => {
    // A transient timeout must not discard a watch that can deliver a late fix.
    if (err.code === 1) {
      if (watch !== null) navigator.geolocation.clearWatch(watch);
      watch = null;
      followState = { mode: 'idle', following: false };
      syncFollowUI();
    }
    gpsPlanFailed();
    $('location-status').textContent = ({
      1: '定位权限被拒绝。请在浏览器设置允许定位，或地图点选起点。',
      2: '暂时无法获取位置，请地图点选起点或稍后重试。',
      3: '定位超时，仍在等待位置；可地图点选起点。',
    })[err.code] || '定位失败，请地图点选起点。';
  };
  try {
    if (watch === null) watch = navigator.geolocation.watchPosition(success, failure, GPS_OPTIONS);
    if (requestOnce) navigator.geolocation.getCurrentPosition?.(success, failure, GPS_OPTIONS);
  } catch {
    failure({ code: 2 });
  }
}

$('follow').onclick = () => {
  const { action, next } = onFollowClick(followState);
  if (action === 'recenter_demo' && current) {
    followState = next;
    syncFollowUI();
    map.setView(current.coords, Math.max(map.getZoom(), 15), { animate: true });
    $('location-status').textContent = '演示位置 · 不是真实 GPS · 正在跟随演示点';
    return;
  }
  if (action === 'recenter_gps' && current && watch !== null) {
    followState = next;
    syncFollowUI();
    map.setView(current.coords, Math.max(map.getZoom(), 15), { animate: true });
    return;
  }
  startGpsWatch();
  if (current && !current.isDemo && followState.following) {
    map.setView(current.coords, Math.max(map.getZoom(), 15), { animate: true });
  }
};

// Pick mode with cancel button & Escape support (M3/M4/m4)
function enterPick(mode) {
  menu(false);
  pickMode = mode;
  document.querySelector('.map-shell')?.classList.add('pick-active');
  $('cancel-pick').hidden = false;
  notify(
    mode === 'edit' ? '请在地图点击要添加标记的位置（按 Esc 或点取消退出）。' : '请在地图点击起点位置（按 Esc 或点取消退出）。',
    { level: 'info', sticky: true }
  );
  if (innerWidth < 800) $('map').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function exitPick(silent = false) {
  if (!pickMode) return;
  pickMode = null;
  document.querySelector('.map-shell')?.classList.remove('pick-active');
  $('cancel-pick').hidden = true;
  if (!silent) hideAlert();
}

$('cancel-pick').onclick = () => exitPick();
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && pickMode) exitPick();
});

$('pick-start').onclick = () => enterPick('start');
$('route-pick-start').onclick = () => enterPick('start');
$('add-marker').onclick = () => enterPick('edit');
$('new-edit').onclick = () => enterPick('edit');

function setEndpoint(type, coords, name) {
  invalidateRoute();
  const isStart = type === 'origin';
  if (isStart) { pendingGpsPlan = false; finishGpsWait(); }
  const icon = L.divIcon({ className: 'endpoint-icon', html: `<div class="endpoint-pin ${isStart ? 'start' : 'end'}">${isStart ? '起' : '终'}</div>`, iconSize: [36, 44], iconAnchor: [18, 44] });
  const pin = L.marker(coords, { icon, draggable: true, zIndexOffset: 600 }).addTo(map).bindTooltip(isStart ? '起点 · 可拖动' : '终点 · 可拖动');
  pin.on('dragstart', () => {
    pendingGpsPlan = false;
    finishGpsWait();
    invalidateRoute();
    setRouteStatus('位置已改变，请点击「规划卡车路线」重新校验。');
  });
  pin.on('dragend', () => {
    const p = pin.getLatLng();
    setEndpoint(type, [p.lat, p.lng], `地图${isStart ? '起点' : '终点'} ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`);
    setRouteStatus('位置已改变，请点击「规划卡车路线」重新校验。');
  });
  if (isStart) {
    origin = coords; $('origin').value = name;
    originPin?.remove(); originPin = pin;
  } else {
    destination = coords; $('destination').value = name;
    destinationPin?.remove(); destinationPin = pin;
  }
}
$('set-manual-start').onclick = () => {
  const p = $('manual-start').value.split(',').map(v => Number(v.trim()));
  if (p.length !== 2 || !p.every(Number.isFinite) || p[0] < BBOX[0] || p[0] > BBOX[2] || p[1] < BBOX[1] || p[1] > BBOX[3]) return notify('请填写大洛杉矶范围内的纬度, 经度。');
  pendingGpsPlan = false;
  setEndpoint('origin', p, '手动起点'); menu(false); map.setView(p, 14);
};

map.on('click', e => {
  if (!pickMode) return;
  const p = [e.latlng.lat, e.latlng.lng];
  if (p[0] < BBOX[0] || p[0] > BBOX[2] || p[1] < BBOX[1] || p[1] > BBOX[3]) {
    notify('请选择大洛杉矶覆盖范围内的位置。', { level: 'warn' });
    return;
  }
  const activeMode = pickMode;
  exitPick();
  if (activeMode === 'edit') {
    openEdit({ lat: p[0], lng: p[1], type: 'cannot', notes: '' });
  } else {
    if (watch !== null) {
      navigator.geolocation.clearWatch(watch);
      watch = null;
    }
    followState = { mode: 'demo', following: false };
    syncFollowUI();
    setPosition(p, null, 0, true);
    setEndpoint('origin', p, `地图起点 ${p.map(n => n.toFixed(5)).join(', ')}`);
    if (destination) planRoute();
  }
});

$('use-gps').onclick = () => {
  menu(false);
  if (current && !current.isDemo) setEndpoint('origin', current.coords, '当前位置');
  else { pendingGpsPlan = true; startGpsWatch(); }
};

$('demo').onclick = () => {
  if (watch !== null) {
    navigator.geolocation.clearWatch(watch);
    watch = null;
  }
  const eff = allRestrictions();
  // Prefer a genuine arterial low-clearance bridge near DTLA (e.g., 12'9" / 13'5") for an informative demo
  const dtla = [34.052, -118.252];
  const f =
    eff.find(x => /^(primary|secondary|tertiary)$/.test(x.tags?.highway || '') && distance(x.coords[0], dtla) < 3500 && x.restrictions.some(r => r.kind === 'height' && relevant(r, vehicle) && r.value != null && r.value < 4.2)) ||
    eff.find(x => x.tags?.highway && x.restrictions.some(r => r.kind === 'height' && relevant(r, vehicle) && r.value != null)) ||
    eff.find(x => x.tags?.highway && x.restrictions.some(r => relevant(r, vehicle))) ||
    eff.find(x => x.restrictions.some(r => relevant(r, vehicle)));
  if (!f) {
    notify('当前条件下没有触发限行的道路数据（或仍在加载）。', { level: 'info' });
    return;
  }
  const target = featureMidpoint(f.coords) || f.coords[0];
  const p = [target[0] - 0.0007, target[1]];
  const hdg = bearing(p, target);
  followState = { mode: 'demo', following: true };
  syncFollowUI();
  alerts.delete(f.id);
  lastGlobalAlert = 0;
  setPosition(p, hdg, 0, true);
  setEndpoint('origin', p, '演示位置（真实 OSM 道路限行附近）');
  map.setView(p, 16);
};

function checkAlerts() {
  if (!current) return;
  const p = current.coords;
  const now = Date.now();
  for (const f of allRestrictions()) {
    const n = nearLine(p, f.coords);
    const prev = previousDistances.get(f.id);
    previousDistances.set(f.id, n.distance);
    const r = f.restrictions.find(r => relevant(r, vehicle));
    if (
      !r ||
      n.distance > settings.distance ||
      !approaching(p, current.heading, f.coords, prev) ||
      now - (alerts.get(f.id) || 0) < 180000 ||
      now - lastGlobalAlert < 10000
    ) {
      continue;
    }
    alerts.set(f.id, now);
    lastGlobalAlert = now;
    const road = f.tags?.name ? `${f.tags.name}：` : '';
    notify(
      `${current.isDemo ? '演示预警：' : '限行预警：'}前方约 ${formatDistanceUS(n.distance)}，${road}${label(r)}。请核实路牌！`,
      { level: 'danger', voice: true }
    );
  }
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
}

function updateEditDialogFields() {
  const type = $('edit-type').value;
  const isRes = type === 'restriction';
  $('edit-limits-group').hidden = !isRes;
  if (type === 'can' && !draft?.osmRef && !draft?.osmFeatureId) {
    $('edit-error').textContent = '提示：未关联具体 OSM 道路的「可以通过」仅记录备注，不会清除邻近道路禁行；如需覆盖 OSM 禁行请先点击该限行线或标牌。';
    $('edit-error').hidden = false;
  } else {
    $('edit-error').hidden = true;
  }
}
$('edit-type').onchange = updateEditDialogFields;

function openEdit(e) {
  draft = { ...e };
  draftInitialForm = prepareEditFormFields(e);
  $('edit-type').value = draftInitialForm.type;
  $('edit-height-unit').value = draftInitialForm.heightUnit;
  $('edit-weight-unit').value = draftInitialForm.weightUnit;
  $('edit-height').value = draftInitialForm.heightInput;
  $('edit-weight').value = draftInitialForm.weightInput;
  $('edit-notes').value = draftInitialForm.notes;
  const roadInfo = e.roadName ? `${e.roadName} · ` : '';
  $('edit-coordinates').textContent = `${roadInfo}${e.lat.toFixed(5)}, ${e.lng.toFixed(5)} · 本机纠偏（优先覆盖同位置 OSM）`;
  $('delete-edit').hidden = !e.id;
  updateEditDialogFields();
  if (!$('edit-dialog').open) $('edit-dialog').showModal();
}

$('cancel-edit').onclick = () => $('edit-dialog').close();
$('delete-edit').onclick = async () => {
  if (!draft?.id) return;
  $('edit-dialog').close();
  await deleteEdit(draft);
};

$('edit-form').onsubmit = async e => {
  e.preventDefault();
  const type = $('edit-type').value;
  const resolved = resolveEditLimitSubmission(
    draft,
    {
      type,
      heightInput: $('edit-height').value,
      heightUnit: $('edit-height-unit').value || 'ft',
      weightInput: $('edit-weight').value,
      weightUnit: $('edit-weight-unit').value || 'lb',
    },
    draftInitialForm
  );
  if (!resolved.ok) {
    $('edit-error').textContent = resolved.error;
    $('edit-error').hidden = false;
    return;
  }

  const item = {
    ...draft,
    id: draft.id || newId(),
    type,
    weight: resolved.weight,
    weightRaw: resolved.weightRaw,
    height: resolved.height,
    heightRaw: resolved.heightRaw,
    notes: $('edit-notes').value.trim(),
    updated_at: new Date().toISOString(),
  };

  const check = validateEditDraft(item);
  if (!check.ok) {
    $('edit-error').textContent = check.error;
    $('edit-error').hidden = false;
    return;
  }

  edits = edits.filter(x => x.id !== item.id).concat(item);
  try {
    await store.save(edits, item);
  } catch (err) {
    notify(err.message, { level: 'warn' });
  }
  alerts.clear();
  renderAll();
  invalidateRoute();
  $('edit-dialog').close();
  tab('edits');
  notify('司机纠偏标记已保存，并已同步应用到地图显示、预警与路线避让。', { level: 'info' });
};

$('storage-mode').textContent = `${store.mode} · 司机纠偏优先覆盖同位置 OSM 显示、预警与路线避让 · 未经官方核实，请以现场路牌为准`;
renderAll();
store.load().then(next => {
  edits = [
    ...new Map(
      [...next.filter(validEdit), ...edits]
        .sort((a, b) => (a.updated_at || '').localeCompare(b.updated_at || ''))
        .map(e => [e.id, e])
    ).values(),
  ];
  renderAll();
  invalidateRoute();
}).catch(err => notify(err.message, { level: 'warn' }));

$('export').onclick = () => {
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), edits }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'la-truck-driver-edits.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

$('import').onchange = async e => {
  try {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 1000000) throw Error('文件不能超过 1 MB');
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.edits) || data.edits.length > 1000 || !data.edits.every(validEdit)) {
      throw Error('标记文件格式无效或超出覆盖范围');
    }
    edits = [...new Map([...edits, ...data.edits].map(x => [x.id, x])).values()];
    await store.save(edits);
    alerts.clear();
    renderAll();
    invalidateRoute();
    notify(`已导入 ${data.edits.length} 条本机标记。`, { level: 'info' });
  } catch (err) {
    notify('导入失败：' + err.message, { level: 'warn' });
  } finally {
    e.target.value = '';
  }
};

// Photon Search
$('search-btn').onclick = async () => {
  const q = $('search').value.trim();
  if (q.length < 2) return notify('请输入至少两个字符的地址。', { level: 'info' });
  if (searchBusy || Date.now() - lastSearch < 1200) return;
  searchBusy = true;
  lastSearch = Date.now();
  $('search-btn').disabled = true;
  $('search-results').textContent = '正在搜索…';
  try {
    const key = q.toLowerCase();
    const cache = read('search-cache-v2', {});
    let results = cache[key];
    if (!results) {
      const url = new URL(cfg.photonUrl || 'https://photon.komoot.io/api/');
      url.search = new URLSearchParams({ q, limit: 10, lat: 34.05, lon: -118.24, bbox: '-119,33.4,-116.8,34.85' });
      const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw Error();
      const data = await r.json();
      results = rankPhotonResults(data.features);
      cache[key] = results;
      write('search-cache-v2', Object.fromEntries(Object.entries(cache).slice(-30)));
    }
    $('search-results').replaceChildren();
    for (const hit of results) {
      const div = document.createElement('div');
      div.className = 'result';
      const name = document.createElement('span');
      name.textContent = hit.name;
      div.append(name);
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = '去这里';
      b.onclick = () => {
        setEndpoint('destination', hit.coords, hit.name);
        $('search').value = hit.name;
        $('search-results').replaceChildren();
        map.setView(hit.coords, 16);
        planRoute();
      };
      div.append(b);
      $('search-results').append(div);
    }
    if (!results.length) $('search-results').textContent = '没有找到结果。试试英文地名，或地图点选起点。';
  } catch {
    $('search-results').textContent = '搜索服务暂不可用。请检查网络，或使用已缓存搜索。';
  } finally {
    searchBusy = false;
    $('search-btn').disabled = false;
  }
};
$('search').onkeydown = e => { if (e.key === 'Enter') $('search-btn').click(); };

function renderTurns(steps) {
  $('turns').replaceChildren();
  steps.forEach((s, i) => {
    const li = document.createElement('li');
    li.textContent = `${s.instruction} · ${formatDistanceUS(s.distance)}`;
    li.id = `turn-${i}`;
    $('turns').append(li);
  });
}

async function requestOrsRoute(body) {
  // Uses current HeiGIT OpenRouteService gateway (ORS_DIRECTIONS_URL) after 2026-11-24 domain migration.
  const r = await fetch(ORS_DIRECTIONS_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json, application/geo+json',
      'Content-Type': 'application/json',
      Authorization: getKey(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) {
    const err = Error(`ORS HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  const data = await r.json();
  const f = data.features?.[0];
  if (!f?.geometry?.coordinates?.length) {
    const err = Error('没有返回可用路线');
    err.status = 404;
    throw err;
  }
  return f;
}

function fitRouteBounds(coords) {
  const rect = $('map').getBoundingClientRect();
  // Measure after route/status rendering: the navigation card grows when turns appear.
  // Leave room above each marker's anchor for its full 44px icon, plus a drag margin.
  let top = 0;
  for (const selector of ['.search-dock', '.map-top', '#alert']) {
    const el = document.querySelector(selector);
    if (el && el.getClientRects().length) top = Math.max(top, el.getBoundingClientRect().bottom - rect.top);
  }
  const card = document.querySelector('.route-card').getBoundingClientRect();
  const bounds = L.latLngBounds([...coords, origin, destination].filter(Boolean));
  const gapTop = Math.max(0, Math.min(top, rect.height));
  const gapBottom = Math.max(gapTop + 1, Math.min(rect.height, card.top - rect.top));
  const gap = gapBottom - gapTop;
  const extraTop = Math.min(68, gap * 0.22);
  const extraBottom = Math.min(24, gap * 0.10);
  map.fitBounds(bounds, {
    paddingTopLeft: [Math.min(44, rect.width * 0.12), gapTop + extraTop],
    paddingBottomRight: [Math.min(44, rect.width * 0.12), rect.height - gapBottom + extraBottom],
    maxZoom: 16,
    animate: false,
  });
}

async function planRoute(auto = false) {
  if (!auto) {
    setPlanningUi(true);
    setRouteStatus('正在规划卡车路线…', 'loading');
  }
  if (routeBusy) { if (!auto) queuedPlan = true; return; }
  if (!destination) { setPlanningUi(false); setRouteStatus('请先在顶部搜索目的地。', 'blocked'); return; }
  if (!origin) {
    if (current && !current.isDemo) setEndpoint('origin', current.coords, '当前位置');
    else {
      pendingGpsPlan = true;
      setPlanningUi(true);
      $('route-pick-start').hidden = false;
      setRouteStatus('正在获取当前位置并规划路线… 可点下方按钮在地图上选择起点。', 'loading');
      // Repeated taps do not extend the deadline indefinitely.
      if (gpsPlanTimer === null) gpsPlanTimer = setTimeout(gpsPlanFailed, GPS_PLAN_TIMEOUT_MS);
      startGpsWatch(true);
      return;
    }
  }
  if (!restrictionsReady) { setPlanningUi(false); setRouteStatus('限行数据仍在加载，请稍后再规划。', 'blocked'); return; }
  if (!getKey()) {
    setPlanningUi(false);
    showKeyHint();
    const st = getRouteUnavailableState(false);
    setRouteStatus(st.message, 'unavailable', st.title);
    if (!auto) notify('规划需要 ORS 密钥，请在「更多 → 设置」填写。' + (isStandalone() ? '' : KEY_INSTALL_HINT), { level: 'info' });
    if (!auto) fitRouteBounds([origin, destination]);
    return;
  }
  const start = auto ? current?.coords : origin;
  if (!start || !destination) {
    setPlanningUi(false);
    setRouteStatus('请先设置起点和终点（搜索结果可选择起终点，或点击「使用当前位置」/「在地图点选起点」）。', 'normal');
    if (!auto) notify('请先设置起点和终点再规划卡车路线。', { level: 'info' });
    return;
  }
  if (current?.isDemo && auto) return;

  const epoch = ++routeEpoch;
  routeBusy = true;
  setPlanningUi(true);
  setRouteStatus(auto ? '偏离路线，正在重新规划…' : '正在请求卡车路线并校验禁行/限高…', 'loading');

  try {
    const eff = allRestrictions();
    let plan = buildRoutePlan(start, destination, vehicle, eff);
    let f = await requestOrsRoute(plan.body);
    if (epoch !== routeEpoch) return;

    let coords = f.geometry.coordinates.map(p => [p[1], p[0]]);
    let steps = (f.properties.segments || []).flatMap(s => s.steps || []);
    let safety = validateRouteSafety(coords, steps, vehicle, eff);

    // If first route hits a known restriction (e.g. outside initial 15 km ORS avoid box), retry focused on that conflict
    if (!safety.safe && safety.blocking.length) {
      setRouteStatus('检测到候选路线经过已知限行，正在尝试重点绕行重算…', 'loading');
      try {
        const retryPlan = buildRoutePlan(start, destination, vehicle, eff, safety.blocking[0].point);
        const retryF = await requestOrsRoute(retryPlan.body);
        if (epoch !== routeEpoch) return;
        const retryCoords = retryF.geometry.coordinates.map(p => [p[1], p[0]]);
        const retrySteps = (retryF.properties.segments || []).flatMap(s => s.steps || []);
        const retrySafety = validateRouteSafety(retryCoords, retrySteps, vehicle, eff);
        if (retrySafety.safe || retrySafety.blocking.length < safety.blocking.length) {
          f = retryF;
          coords = retryCoords;
          steps = retrySteps;
          safety = retrySafety;
        }
      } catch {
        // Keep original validation result and block below
      }
    }

    // HARD BLOCK: refuse to accept or start navigation on a route violating known no-truck / low-clearance limits!
    if (!safety.safe) {
      route = null;
      routeLayer.clearLayers();
      $('turns').replaceChildren();
      $('stop-nav').hidden = true;
      // Show conflict locations in warning red dashed line so the driver sees WHY it was blocked
      L.polyline(coords, { color: '#b91c1c', weight: 5, opacity: 0.78, dashArray: '8 8', smoothFactor: 0 }).addTo(routeLayer);
      for (const b of safety.blocking) {
        L.circleMarker(b.point, { radius: 12, color: '#991b1b', fillColor: '#fef08a', fillOpacity: 0.95, weight: 3 })
          .bindTooltip(`阻断：${b.feature.tags?.name || '限行路段'} (${label(b.restriction)})`)
          .addTo(routeLayer);
      }
      const conflictSummary = safety.blocking
        .slice(0, 3)
        .map(b => `${b.feature.tags?.name || '限行点'}（${label(b.restriction)}）`)
        .join('；');
      const msg = `已拒绝不安全路线：候选路线经过 ${safety.blocking.length} 处已知禁行或超限路段（${conflictSummary}）。未启动导航，请调整起终点或使用专业卡车导航核实。`;
      setRouteStatus(msg, 'blocked');
      notify(msg, { level: 'danger', voice: !auto });
      if (!auto) fitRouteBounds(coords);
      return;
    }

    route = { coords, steps };
    routeLayer.clearLayers();
    const rs = plannedRouteStyles();
    L.polyline(coords, rs.casing).addTo(routeLayer);
    L.polyline(coords, rs.line).addTo(routeLayer);
    renderTurns(steps);
    navStep = steps[0]?.type === 11 ? 1 : 0;
    offCount = 0;
    turnSpoken.clear();
    $('stop-nav').hidden = false;

    const summary = f.properties.summary;
    const notes = [];
    if (safety.warnings.length) notes.push(`沿途有 ${safety.warnings.length} 处有条件/需核实限行，请注意路牌`);
    if (safety.turnaroundWarnings.length) notes.push(safety.turnaroundWarnings.join('；'));
    if (!vehicle.height || !vehicle.weight) notes.push('未填全车高/车重，校验可能不完整');
    const noteStr = notes.length ? ` ⚠ ${notes.join('。')}。` : ' 已通过本地已知限高与禁行校验（仍不能替代现场路牌及商业卡车导航）。';
    setRouteStatus(
      `${(summary.distance / 1609.344).toFixed(1)} mi · 约 ${Math.round(summary.duration / 60)} 分钟（无实时路况）。${noteStr} 转向文字为 ORS 英文。`,
      'normal'
    );
    if (!auto) fitRouteBounds(coords);
  } catch (err) {
    if (epoch === routeEpoch) {
      route = null;
      routeLayer.clearLayers();
      $('turns').replaceChildren();
      $('stop-nav').hidden = true;
      const errMsg = formatRouteError(err);
      setRouteStatus(errMsg, 'blocked');
      if (!auto) notify(errMsg, { level: 'warn' });
    }
  } finally {
    routeBusy = false;
    setPlanningUi(gpsPlanTimer !== null);
    if (queuedPlan) { queuedPlan = false; queueMicrotask(() => planRoute()); }
  }
}

$('route-btn').onclick = () => planRoute();
$('stop-nav').onclick = () => stopNavigation();

const turnNames = {
  0: '左转', 1: '右转', 2: '急左转', 3: '急右转', 4: '稍向左转', 5: '稍向右转',
  6: '直行', 7: '进入环岛', 8: '离开环岛', 9: '掉头', 10: '到达终点', 11: '出发', 12: '靠左', 13: '靠右',
};

function updateNavigation() {
  if (!route || !current) return;
  const { coords, steps } = route;
  const p = current.coords;
  const nearest = nearLine(p, coords);
  if (nearest.distance > 75) {
    offCount++;
    if (offCount >= 3 && Date.now() - lastReroute > 60000 && !routeBusy && !current.isDemo) {
      lastReroute = Date.now();
      planRoute(true);
    }
    return;
  } else {
    offCount = 0;
  }

  const progress = routeProgress(p, coords);
  const cumulative = [0];
  for (let i = 1; i < coords.length; i++) cumulative.push(cumulative[i - 1] + distance(coords[i - 1], coords[i]));
  while (navStep < steps.length - 1 && (cumulative[steps[navStep].way_points?.[0] ?? 0] + 35) < progress) navStep++;
  if (navStep >= steps.length) return;

  const step = steps[navStep];
  const action = coords[step.way_points?.[0]];
  if (!action) return;
  const d = distance(p, action);
  if (d < 250 && !turnSpoken.has(navStep)) {
    if (say(`${formatDistanceUS(d)}后，${turnNames[step.type] || '按路线指示行驶'}${step.name && step.name !== '-' ? '，' + step.name : ''}`)) {
      turnSpoken.add(navStep);
    }
    $('turn-' + navStep)?.style.setProperty('font-weight', 'bold');
  }
  if (d < 35) {
    if (step.type === 10) {
      say('接近目的地，请核实现场停车与掉头条件。');
      stopNavigation('已接近目的地。请核实现场停车与掉头条件。');
    } else {
      navStep++;
    }
  }
}

window.addEventListener('offline', () => notify('已离线：限行缓存和本机标记仍可看，底图 / 搜索 / 路线需要网络。', { level: 'info' }));
let installPrompt;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('install').hidden = false;
});
$('install').onclick = async () => {
  await installPrompt?.prompt();
  installPrompt = null;
  $('install').hidden = true;
};

if ('serviceWorker' in navigator && window.isSecureContext) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    navigator.serviceWorker.register('./sw.js').catch(() => notify('离线缓存注册失败，在线功能仍可用。', { level: 'info' }));
  }));
}

requestAnimationFrame(() => requestAnimationFrame(() => loadData()));
