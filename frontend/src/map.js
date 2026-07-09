/**
 * map.js - Leaflet map logic for the Clover Geospatial App.
 *
 * Ported from the design's `class Component extends DCLogic` methods:
 * initMap, tileUrl, pinColor, buildStores, buildTraffic, buildTrade,
 * buildDemo, buildCompetitors, buildPois, buildCross, applyLayers,
 * toggleLayer, selectStore, highlight, recompute.
 *
 * Public surface:
 *   initMap(container, data, { onRecompute, onStoreSelect })
 *   toggleLayer(key)
 *   selectStore(id)
 *   clearStore()
 *   getLayersState()   -- returns { [key]: boolean } current visibility
 *
 * The map module owns mutable Leaflet state internally. React state is
 * updated only through the callbacks passed to initMap.
 */

import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { latLngToCell, cellToBoundary, gridDisk, gridDistance } from 'h3-js';

// Fix Leaflet default icon path broken by bundlers
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: new URL('leaflet/dist/images/marker-icon-2x.png', import.meta.url).href,
  iconUrl: new URL('leaflet/dist/images/marker-icon.png', import.meta.url).href,
  shadowUrl: new URL('leaflet/dist/images/marker-shadow.png', import.meta.url).href,
});

// ---------------------------------------------------------------------------
// Module-level mutable state (one map per page)
// ---------------------------------------------------------------------------

let _map = null;
let _tile = null;
let _lg = {};               // layer groups keyed by layer name
let _storeMarkers = {};     // { store_id: circleMarker }
let _data = null;           // bootstrap payload
let _layersOn = {};         // { key: boolean }
let _selectedId = null;
let _onRecompute = null;
let _onStoreSelect = null;
const _PIN_MODE = 'staffing'; // fixed; could be exposed as prop in a future task

// ---------------------------------------------------------------------------
// Tile / basemap
// ---------------------------------------------------------------------------

function tileUrl(basemap = 'light') {
  if (basemap === 'dark')    return 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
  if (basemap === 'voyager') return 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
  return 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
}

// ---------------------------------------------------------------------------
// Pin colour helper
// ---------------------------------------------------------------------------

function pinColor(s) {
  if (_PIN_MODE === 'format') {
    if (s.format === 'Supercenter')  return '#1B5162';
    if (s.format === 'Neighborhood') return '#FF5F46';
    return '#618794';
  }
  if (_PIN_MODE === 'traffic') {
    const max = Math.max(..._data.locations.map(x => x.recent_visits));
    const t = s.recent_visits / max;
    const stops = [[255,224,138],[255,158,148],[255,95,70],[255,54,33]];
    const i = Math.min(stops.length - 1, Math.floor(t * (stops.length - 1)));
    const c = stops[i];
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  // staffing (default)
  if (s.staffing_status === 'understaffed') return '#FF3621';
  if (s.staffing_status === 'overstaffed')  return '#FFAB00';
  return '#00A972';
}

// ---------------------------------------------------------------------------
// Layer builders
// ---------------------------------------------------------------------------

function buildStores() {
  const grp = L.layerGroup();
  _storeMarkers = {};
  for (const s of _data.locations) {
    const r = 9; // uniform marker size; color encodes staffing status
    const m = L.circleMarker([s.lat, s.lng], {
      radius: r,
      fillColor: pinColor(s),
      color: '#fff',
      weight: 2,
      fillOpacity: 0.92,
    });
    m.bindTooltip(`${s.name} - ${s.staffing_status}`, {
      className: 'cv-tt',
      direction: 'top',
      offset: [0, -4],
    });
    m.on('click', () => selectStore(s.store_id));
    m._baseR = r;
    grp.addLayer(m);
    _storeMarkers[s.store_id] = m;
  }
  _lg.stores = grp;
}

const H3_RES = 9;
const H3_KRING = 2; // spread radius in cells

// light -> dark purple ramp; darker = more traffic
function _purpleRamp(t) {
  // t in [0,1]; interpolate across stops
  const stops = [
    [0.00, [242, 233, 247]], // #F2E9F7 light lavender
    [0.35, [176, 124, 209]], // #B07CD1
    [0.70, [126,  63, 168]], // #7E3FA8
    [1.00, [ 74,  29, 110]], // #4A1D6E deep purple
  ];
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      const f = (x - t0) / (t1 - t0 || 1);
      const c = c0.map((v, k) => Math.round(v + (c1[k] - v) * f));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  const last = stops[stops.length - 1][1];
  return `rgb(${last[0]},${last[1]},${last[2]})`;
}

function buildTraffic() {
  const cellWeights = {}; // h3index -> summed weight
  const addPoint = (lat, lng, weight) => {
    if (lat == null || lng == null || !weight) return;
    const origin = latLngToCell(lat, lng, H3_RES);
    for (const c of gridDisk(origin, H3_KRING)) {
      const d = gridDistance(origin, c);      // 0..H3_KRING
      const falloff = 1 / (1 + d * d);         // gaussian-ish decay
      cellWeights[c] = (cellWeights[c] || 0) + weight * falloff;
    }
  };
  for (const s of _data.locations) addPoint(s.lat, s.lng, s.recent_visits || 0);
  for (const o of (_data.visitor_origins || [])) addPoint(o.origin_lat, o.origin_lng, o.visitors || 0);

  const cells = Object.keys(cellWeights);
  const grp = L.layerGroup();
  if (cells.length) {
    const max = Math.max(...cells.map(c => cellWeights[c])) || 1;
    for (const c of cells) {
      const t = cellWeights[c] / max;                 // 0..1
      const boundary = cellToBoundary(c);             // [[lat,lng],...] (default latlng order)
      grp.addLayer(L.polygon(boundary, {
        stroke: true, color: '#4A1D6E', weight: 0.5, opacity: 0.22,
        fillColor: _purpleRamp(t),
        fillOpacity: 0.12 + 0.72 * Math.pow(t, 0.6),  // darker/more opaque = more traffic
      }));
    }
  }
  _lg.traffic = grp;
}

function buildTrade() {
  const grp = L.layerGroup();
  const origins = _data.visitor_origins || [];
  const byStore = {};
  for (const o of origins) {
    (byStore[o.store_id] = byStore[o.store_id] || []).push(o);
  }
  for (const s of _data.locations) {
    const os = (byStore[s.store_id] || []).sort((a, b) => b.visitors - a.visitors).slice(0, 5);
    for (const o of os) {
      grp.addLayer(L.polyline(
        [[s.lat, s.lng], [o.origin_lat, o.origin_lng]],
        { color: '#FF5F46', weight: 1 + (o.visitors / 120), opacity: 0.35 }
      ));
      grp.addLayer(L.circleMarker([o.origin_lat, o.origin_lng], {
        radius: 3, fillColor: '#FF5F46', color: '#fff', weight: 1, fillOpacity: 0.7,
      }));
    }
  }
  _lg.trade = grp;
}

function buildDemo() {
  const grp = L.layerGroup();
  const demoRows = (_data.demo_rows || []).filter(r => r.lat != null && r.lng != null && r.median_income != null);
  if (demoRows.length === 0) { _lg.demo = grp; return; }
  const incomes = demoRows.map(r => r.median_income);
  const lo = Math.min(...incomes);
  const hi = Math.max(...incomes);
  const scale = ['#E3EAEC', '#A9C2C9', '#7BA3AD', '#4E7C8A', '#1B5162'];
  for (const r of demoRows) {
    const t = (r.median_income - lo) / (hi - lo || 1);
    const col = scale[Math.min(scale.length - 1, Math.floor(t * scale.length))];
    grp.addLayer(
      L.circle([r.lat, r.lng], {
        radius: 2400, fillColor: col, color: col, weight: 1, fillOpacity: 0.45,
      }).bindTooltip(
        `Store ${r.store_id} - $${(r.median_income / 1000).toFixed(0)}k median income`,
        { className: 'cv-tt' }
      )
    );
  }
  _lg.demo = grp;
}

function buildCompetitors() {
  const grp = L.layerGroup();
  const rows = _data.competitor_rows || [];
  for (const p of rows) {
    const icon = L.divIcon({
      className: '',
      iconSize: [16, 16],
      html: '<div style="width:12px;height:12px;background:#98102A;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4);transform:rotate(45deg);"></div>',
    });
    grp.addLayer(
      L.marker([p.lat, p.lng], { icon })
        .bindTooltip(`${p.name} - competitor - ${p.distance_mi} mi`, { className: 'cv-tt' })
    );
  }
  _lg.competitors = grp;
}

function buildPois() {
  const grp = L.layerGroup();
  const rows = _data.poi_rows || [];
  // Keyed on actual backend category values from nearby_pois.
  // DuBois-palette colors; competitors are handled separately in buildCompetitors.
  const col = {
    'F&B':      '#FF5F46', // lava / warm coral
    'Grocery':  '#00A972', // green
    'Apparel':  '#7BA3AD', // slate-blue
    'Fitness':  '#FFAB00', // amber
    'Beauty':   '#C975B0', // plum
    'Leisure':  '#618794', // slate (default range)
  };
  for (const p of rows) {
    const c = col[p.category] || '#94A3B8'; // fallback slate for unlisted categories
    const icon = L.divIcon({
      className: '',
      iconSize: [12, 12],
      html: `<div style="width:10px;height:10px;border-radius:3px;background:${c};border:1.5px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,.3);"></div>`,
    });
    grp.addLayer(
      L.marker([p.lat, p.lng], { icon })
        .bindTooltip(`${p.name} - ${p.category}`, { className: 'cv-tt' })
    );
  }
  _lg.pois = grp;
}

function buildCross() {
  const grp = L.layerGroup();
  const cross = _data.cross_rows || [];
  if (cross.length === 0) { _lg.cross = grp; return; }
  const max = Math.max(...cross.map(c => c.shared_visitors));
  for (const c of cross) {
    grp.addLayer(
      L.polyline([[c.a_lat, c.a_lng], [c.b_lat, c.b_lng]], {
        color: '#618794',
        weight: 1 + (c.shared_visitors / max) * 4,
        opacity: 0.5,
        dashArray: '4 4',
      }).bindTooltip(`${c.shared_visitors} shared visitors`, { className: 'cv-tt' })
    );
  }
  _lg.cross = grp;
}

// ---------------------------------------------------------------------------
// Layer management
// ---------------------------------------------------------------------------

function applyLayers() {
  if (!_map) return;
  // bottom to top draw order
  const ORDER = ['cross', 'traffic', 'competitors', 'pois', 'stores'];
  for (const k of ORDER) {
    const on = _layersOn[k];
    const grp = _lg[k];
    if (!grp) continue;
    const present = _map.hasLayer(grp);
    if (on && !present) grp.addTo(_map);
    if (!on && present) _map.removeLayer(grp);
  }
  // keep store markers above heatmap/choropleth
  if (_layersOn.stores) {
    Object.values(_storeMarkers).forEach(m => {
      if (m.bringToFront) m.bringToFront();
    });
  }
}

// ---------------------------------------------------------------------------
// Analytics recompute (client-side, mirrors design's recompute())
// ---------------------------------------------------------------------------

function recompute() {
  if (!_map || !_data) return;
  const b = _map.getBounds();
  const inv = _data.locations.filter(s => b.contains([s.lat, s.lng]));
  const ids = new Set(inv.map(s => s.store_id));

  if (inv.length === 0) {
    if (_onRecompute) _onRecompute({ n: 0 });
    return;
  }

  const rows = (_data.foot_traffic_daily || []).filter(r => ids.has(r.store_id));

  // Build 30-day series (days_ago 29..0)
  const series = [];
  const dwellSeries = [];
  const capSeries = [];
  for (let d = 29; d >= 0; d--) {
    const day = rows.filter(r => r.days_ago === d);
    series.push(day.reduce((a, r) => a + r.visits, 0));
    dwellSeries.push(day.length
      ? day.reduce((a, r) => a + r.avg_dwell_min, 0) / day.length
      : 0);
    capSeries.push(day.length
      ? day.reduce((a, r) => a + r.capture_rate, 0) / day.length
      : 0);
  }

  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const last7 = arr => avg(arr.slice(-7));
  const prev7 = arr => avg(arr.slice(-14, -7));
  const dpct = (a, p) => p ? ((a - p) / p) * 100 : 0;

  const dailyTraffic = last7(series);
  const trafficDelta = dpct(last7(series), prev7(series));
  const origins = _data.visitor_origins || [];
  const visitors = origins.filter(o => ids.has(o.store_id)).reduce((a, o) => a + o.visitors, 0);
  const dwell = last7(dwellSeries);
  const dwellDelta = dpct(last7(dwellSeries), prev7(dwellSeries));
  const cap = last7(capSeries) * 100;
  const capDelta = dpct(last7(capSeries), prev7(capSeries));

  // Weighted demographics - single pass; each metric accumulates its own
  // numerator and denominator so only stores WITH that field contribute weight.
  const demoById = (_data.helpers || {}).demoById || {};
  const BANDS = ['18-24', '25-34', '35-44', '45-54', '55+'];
  const demRows = inv.map(s => demoById[s.store_id] || null);

  let wInc = 0, incNum = 0;
  let wAge = 0, ageNum = 0;
  let wKids = 0, kidsNum = 0;
  let wBands = 0;
  const bandNum = {};
  demRows.forEach((d, i) => {
    if (!d) return;
    const w = inv[i].base_traffic || 0;
    if (d.median_income != null) { incNum += d.median_income * w; wInc += w; }
    if (d.median_age != null)    { ageNum += d.median_age * w;    wAge += w; }
    if (d.pct_with_kids != null) { kidsNum += d.pct_with_kids * w; wKids += w; }
    if (d.age) {
      // track band weight only for stores that have an age object
      wBands += w;
      BANDS.forEach(b => {
        if (d.age[b] != null) bandNum[b] = (bandNum[b] || 0) + d.age[b] * w;
      });
    }
  });

  const incAgg  = wInc   > 0 ? incNum  / wInc   : 0;
  const ageMed  = wAge   > 0 ? ageNum  / wAge   : 0;
  const kidsAgg = wKids  > 0 ? kidsNum / wKids  : 0;
  // Each band value is a fraction (e.g. 0.22 = 22%); divide by wBands so bands
  // still sum to ~100% across the weighted in-view stores with demographics.
  const ageAgg = BANDS.map(b => wBands > 0 ? (bandNum[b] || 0) / wBands : 0);

  if (_onRecompute) {
    _onRecompute({
      n: inv.length,
      series, dailyTraffic, trafficDelta,
      visitors, dwell, dwellDelta, cap, capDelta,
      bands: BANDS, ageAgg, incAgg, ageMed, kidsAgg,
    });
  }
}

// ---------------------------------------------------------------------------
// Store highlight / selection
// ---------------------------------------------------------------------------

function highlight(id) {
  for (const [k, m] of Object.entries(_storeMarkers)) {
    if (k === id) {
      m.setStyle({ weight: 4, color: '#1B3139' }).setRadius(m._baseR + 3);
    } else {
      m.setStyle({ weight: 2, color: '#fff' }).setRadius(m._baseR);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise the Leaflet map.
 *
 * @param {HTMLElement} container  - DOM node (the mapRef.current div)
 * @param {object}      data       - bootstrap payload from getBootstrap()
 * @param {object}      opts
 * @param {function}    opts.onRecompute    - called with inView stats on every moveend + init
 * @param {function}    opts.onStoreSelect  - called with store object when a pin is clicked
 */
export function initMap(container, data, { onRecompute, onStoreSelect } = {}) {
  // Destroy any previous instance (hot-reload safety)
  if (_map) {
    _map.remove();
    _map = null;
  }

  _data = data;
  _onRecompute = onRecompute || null;
  _onStoreSelect = onStoreSelect || null;
  _layersOn = { stores: true, traffic: true, competitors: false, pois: false, cross: false };

  const map = L.map(container, {
    zoomControl: true,
    attributionControl: true,
    preferCanvas: true,
  }).setView(data.META.center, data.META.zoom);
  _map = map;

  _tile = L.tileLayer(tileUrl('light'), {
    subdomains: 'abcd',
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap &copy; CARTO',
  }).addTo(map);

  map.zoomControl.setPosition('bottomright');

  // Build all layer groups.
  // buildTraffic consumes visitor_origins for the heatmap.
  buildStores();
  buildTraffic();
  buildCompetitors();
  buildPois();
  buildCross();

  // Apply initial visibility
  applyLayers();

  // Fit bounds to store markers
  const markerArr = Object.values(_storeMarkers);
  if (markerArr.length) {
    const grp = L.featureGroup(markerArr);
    map.fitBounds(grp.getBounds().pad(0.12));
  }

  // Pan/zoom triggers KPI recompute
  map.on('moveend', () => recompute());

  // Initial KPI compute (after a short tick so bounds settle)
  setTimeout(() => recompute(), 300);
}

/**
 * Toggle a named layer on/off and return the new visibility state.
 * If the map is not yet initialized, return the current state unchanged
 * so the 7-key layersOn object in React is never replaced with a 1-key object.
 */
export function toggleLayer(key) {
  if (!_map) return { ..._layersOn };
  _layersOn[key] = !_layersOn[key];
  applyLayers();
  return { ..._layersOn };
}

/**
 * Fly to a store pin, highlight it, and call onStoreSelect.
 */
export function selectStore(id) {
  _selectedId = id;
  const s = (_data.helpers || {}).byId ? _data.helpers.byId[id] : null;
  if (!s || !_map) return;
  _map.flyTo([s.lat, s.lng], Math.max(_map.getZoom(), 12), { duration: 0.6 });
  highlight(id);
  if (_onStoreSelect) _onStoreSelect(s);
}

/**
 * Deselect the current store and reset all pin highlights.
 */
export function clearStore() {
  _selectedId = null;
  for (const [, m] of Object.entries(_storeMarkers)) {
    m.setStyle({ weight: 2, color: '#fff' }).setRadius(m._baseR);
  }
  if (_onStoreSelect) _onStoreSelect(null);
}

/**
 * Return a copy of the current layer visibility map.
 */
export function getLayersState() {
  return { ..._layersOn };
}

/**
 * Tear down the map (useful for React StrictMode double-mount).
 */
export function destroyMap() {
  if (_map) { _map.remove(); _map = null; }
  _lg = {};
  _storeMarkers = {};
  _data = null;
  _layersOn = {};
  _selectedId = null;
}
