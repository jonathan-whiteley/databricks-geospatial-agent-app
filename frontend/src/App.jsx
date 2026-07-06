import { useRef, useState, useEffect, useCallback } from 'react';
import { getBootstrap, getLayer } from './api.js';
import { initMap, toggleLayer as mapToggleLayer, selectStore as mapSelectStore, clearStore as mapClearStore, destroyMap } from './map.js';
import GeniePanel from './geniePanel.jsx';
import ArchitecturePanel from './ArchitecturePanel.jsx';

// ---------- Static layer definitions (UI metadata only) ----------

const LAYER_DEFS = [
  { key: 'stores',        name: 'Store locations',           table: 'locations',                       icon: '📍', iconBg: '#FFEDEA' },
  { key: 'traffic',       name: 'Foot traffic heatmap',      table: 'foot_traffic_daily',               icon: '🔥', iconBg: '#FFF3E6' },
  { key: 'trade_areas',   name: 'Trade areas',               table: 'ST_Buffer · locations',            icon: '📐', iconBg: '#EDE7F6' },
  { key: 'zip_choropleth',name: 'Visitors by ZIP',           table: 'geo_zips · ST_Contains',           icon: '🗺️', iconBg: '#E9F1F3' },
  { key: 'competitors',   name: 'Competitors',               table: 'nearby_pois',                      icon: '🎯', iconBg: '#F6E4E7' },
  { key: 'pois',          name: 'Nearby POIs',               table: 'nearby_pois',                      icon: '🏬', iconBg: '#EEF1F4' },
  { key: 'cross',         name: 'Cross-shopping',            table: 'cross_shopping',                   icon: '🔗', iconBg: '#EEF1F4' },
];


// ---------- Helpers ----------

function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
function hrs(n) { return (n > 0 ? '+' : '') + n + 'h'; }

function buildSparkline(series) {
  const W = 320, H = 84;
  const s = series && series.length ? series : [0];
  const mn = Math.min(...s), mx = Math.max(...s), rng = (mx - mn) || 1;
  // Guard against a single-point series: duplicate it so we always have at
  // least 2 points and avoid dividing by (s.length - 1) === 0.
  const pts = s.length < 2
    ? [[0, (H - ((s[0] - mn) / rng) * (H - 8) - 2).toFixed(1)], [W, (H - ((s[0] - mn) / rng) * (H - 8) - 2).toFixed(1)]]
    : s.map((v, i) => [
        ((i / (s.length - 1)) * W).toFixed(1),
        (H - ((v - mn) / rng) * (H - 8) - 2).toFixed(1),
      ]);
  const line = 'M' + pts.map(p => p[0] + ',' + p[1]).join(' L');
  const area = line + ` L${W},${H} L0,${H} Z`;
  return { line, area };
}

// ---------- Sub-components ----------

function LayerRow({ def, active, onToggle }) {
  const rowStyle = {
    display: 'flex', alignItems: 'center', gap: 11, padding: '9px 10px',
    borderRadius: 9, cursor: 'pointer', transition: 'background .12s',
    background: active ? 'var(--db-oat-light)' : 'transparent',
  };
  const trackStyle = {
    flex: '0 0 34px', width: 34, height: 20, borderRadius: 999, padding: 2,
    display: 'flex',
    background: active ? 'var(--db-lava)' : 'var(--db-gray-300)',
    justifyContent: active ? 'flex-end' : 'flex-start',
    transition: 'all .15s',
  };
  const knobStyle = {
    width: 16, height: 16, borderRadius: '50%', background: '#fff',
    boxShadow: '0 1px 2px rgba(0,0,0,.25)',
  };
  return (
    <div>
      <div style={rowStyle} onClick={onToggle}>
        <div style={{ flex: '0 0 30px', height: 30, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', background: def.iconBg, fontSize: 15 }}>
          {def.icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ font: '600 13px var(--font-sans)', color: 'var(--db-navy)' }}>{def.name}</div>
          <div style={{ font: '400 11px var(--font-mono)', color: 'var(--db-ink-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{def.table}</div>
        </div>
        <div style={trackStyle}><div style={knobStyle}></div></div>
      </div>
      {active && def.key === 'stores' && (
        <div style={{ padding: '2px 10px 9px 48px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '7px 12px' }}>
            {[{ color: '#FF3621', label: 'Understaffed' }, { color: '#FFAB00', label: 'Overstaffed' }, { color: '#00A972', label: 'Balanced' }].map(sw => (
              <span key={sw.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '500 10px var(--font-sans)', color: 'var(--db-ink-muted)' }}>
                <i style={{ width: 8, height: 8, borderRadius: '50%', background: sw.color, display: 'inline-block' }}></i>
                {sw.label}
              </span>
            ))}
          </div>
        </div>
      )}
      {active && def.key === 'demo' && (
        <div style={{ padding: '2px 10px 9px 48px' }}>
          <div style={{ height: 7, borderRadius: 4, background: 'linear-gradient(90deg,#E3EAEC,#7BA3AD,#1B5162)' }}></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', font: '400 9px var(--font-mono)', color: 'var(--db-ink-muted)', marginTop: 2 }}>
            <span>lower income</span><span>higher</span>
          </div>
        </div>
      )}
      {active && def.key === 'zip_choropleth' && (
        <div style={{ padding: '2px 10px 9px 48px' }}>
          <div style={{ height: 7, borderRadius: 4, background: 'linear-gradient(90deg,#E3EAEC,#7BA3AD,#1B5162)' }}></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', font: '400 9px var(--font-mono)', color: 'var(--db-ink-muted)', marginTop: 2 }}>
            <span>fewer visitors</span><span>more visitors</span>
          </div>
        </div>
      )}
      {active && def.key === 'trade_areas' && (
        <div style={{ padding: '2px 10px 9px 48px' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '500 10px var(--font-sans)', color: 'var(--db-ink-muted)' }}>
            <i style={{ width: 12, height: 12, borderRadius: 2, border: '1.5px solid #7E3FA8', background: 'rgba(126,63,168,0.06)', display: 'inline-block', flexShrink: 0 }}></i>
            ~1 mile trade area (ST_Buffer)
          </div>
        </div>
      )}
    </div>
  );
}

function KpiTile({ kpi }) {
  return (
    <div style={{ background: '#fff', border: '1px solid var(--db-line)', borderRadius: 11, padding: '11px 12px' }}>
      <div style={{ font: '400 10px var(--font-sans)', color: 'var(--db-ink-muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{kpi.label}</div>
      <div style={{ font: '700 22px var(--font-sans)', color: 'var(--db-navy)', letterSpacing: '-.01em', marginTop: 3, lineHeight: 1 }}>{kpi.value}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6, font: '600 11px var(--font-mono)', color: kpi.deltaColor }}>
        <span>{kpi.arrow}</span>
        <span>{kpi.delta}</span>
        <span style={{ color: 'var(--db-ink-muted)', fontWeight: 400 }}>{kpi.deltaNote}</span>
      </div>
    </div>
  );
}

// ---------- Main App ----------

export default function App() {
  const mapRef = useRef(null);
  const mapInitialized = useRef(false);

  // Bootstrap / loading state
  const [ready, setReady] = useState(false);
  const [meta, setMeta] = useState({ metro: '', date_window: 'Trailing 30 days', refreshed: '' });

  // Layer toggle state (mirrors map module)
  const [layersOn, setLayersOn] = useState({
    stores: true, traffic: true,
    trade_areas: false, zip_choropleth: false,
    competitors: false, pois: false, cross: false,
  });

  // In-viewport analytics state
  const [inView, setInView] = useState(null);

  // Selected store for drill-down card
  const [selectedStore, setSelectedStore] = useState(null);

  // Panel visibility
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);

  // Architecture panel toggle
  const [showArch, setShowArch] = useState(false);

  // Genie seed question from store drill-down; wrapped in object so same store re-click still fires
  const [genieSeedQuestion, setGenieSeedQuestion] = useState(null);

  const activeCount = LAYER_DEFS.filter(d => layersOn[d.key]).length;

  // ---------- Bootstrap on mount ----------
  useEffect(() => {
    if (mapInitialized.current) return;
    mapInitialized.current = true;

    getBootstrap()
      .then(data => {
        // Populate top-bar pills from live META
        const m = data.META || {};
        setMeta({
          metro: m.metro || 'Greater Boston Metro',
          date_window: m.date_window || 'Trailing 30 days',
          refreshed: m.refreshed || new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
        });

        // Fetch the overlay layers in parallel; guard each so one failure does not crash.
        // 'trade' (visitor_origins) is still fetched because the foot-traffic heatmap uses it.
        return Promise.all([
          getLayer('trade').catch(() => []),
          getLayer('competitors').catch(() => []),
          getLayer('pois').catch(() => []),
          getLayer('cross').catch(() => []),
          getLayer('trade_areas').catch(() => []),
          getLayer('zip_choropleth').catch(() => []),
        ]).then(([tradeRows, competitorRows, poisRows, crossRows, tradeAreaRows, zipChoroplethRows]) => {
          // Merge layer data into the bootstrap payload under the field names map.js builders consume
          const merged = {
            ...data,
            visitor_origins: tradeRows,
            competitor_rows: competitorRows,
            poi_rows: poisRows,
            cross_rows: crossRows,
            trade_area_rows: tradeAreaRows,
            zip_choropleth_rows: zipChoroplethRows,
          };

          // Init Leaflet map with merged data
          if (mapRef.current) {
            initMap(mapRef.current, merged, {
              onRecompute: (iv) => setInView(iv),
              onStoreSelect: (store) => setSelectedStore(store),
            });
          }

          setReady(true);
        });
      })
      .catch(err => {
        console.error('Bootstrap failed:', err);
        // Show map container without data so app is not blank
        setReady(true);
      });

    return () => {
      destroyMap();
      // Reset the guard so a StrictMode re-mount (or future real remount)
      // reinitializes the map instead of leaving a blank container.
      mapInitialized.current = false;
    };
  }, []);


  // ---------- Layer toggle ----------
  const toggleLayer = useCallback((key) => {
    const newState = mapToggleLayer(key);
    setLayersOn({ ...newState });
  }, []);

  // ---------- Store drill-down ----------
  function handleStoreClick(id) {
    mapSelectStore(id);
  }

  function handleClearStore() {
    mapClearStore();
    setSelectedStore(null);
  }

  // ---------- KPI derivation ----------
  let kpis = [];
  let trendLine = '', trendArea = '';
  let demoBars = [];
  let demoIncome = null, demoAge = null, demoKids = null;
  let inViewLabel = 'Pan or zoom the map';

  if (inView && inView.n > 0) {
    inViewLabel = `${inView.n} store${inView.n > 1 ? 's' : ''} in view`;
    const arrow = d => (d > 0.5 ? '▲' : d < -0.5 ? '▼' : '—');
    const col = (d, good) => Math.abs(d) < 0.5
      ? 'var(--db-ink-muted)'
      : (good ? (d > 0 ? 'var(--db-green)' : 'var(--db-lava)') : (d > 0 ? 'var(--db-lava)' : 'var(--db-green)'));

    kpis = [
      { label: 'Daily foot traffic',  value: fmt(inView.dailyTraffic), arrow: arrow(inView.trafficDelta), delta: Math.abs(inView.trafficDelta).toFixed(1) + '%', deltaNote: 'vs last wk', deltaColor: col(inView.trafficDelta, true) },
      { label: 'Trade-area visitors', value: fmt(inView.visitors),     arrow: arrow(inView.trafficDelta), delta: Math.abs(inView.trafficDelta * 0.8).toFixed(1) + '%', deltaNote: 'reach', deltaColor: col(inView.trafficDelta, true) },
      { label: 'Avg dwell',           value: inView.dwell.toFixed(0) + 'm', arrow: arrow(inView.dwellDelta),   delta: Math.abs(inView.dwellDelta).toFixed(1) + '%',   deltaNote: '', deltaColor: col(inView.dwellDelta, true) },
      { label: 'Capture rate',        value: inView.cap.toFixed(1) + '%',   arrow: arrow(inView.capDelta),    delta: Math.abs(inView.capDelta).toFixed(1) + '%',    deltaNote: '', deltaColor: col(inView.capDelta, true) },
    ];

    const spark = buildSparkline(inView.series);
    trendLine = spark.line;
    trendArea = spark.area;

    demoBars = (inView.bands || []).map((band, i) => ({
      band,
      pct: (inView.ageAgg[i] || 0).toFixed(0) + '%',
      width: Math.min(100, (inView.ageAgg[i] || 0) * 3.4).toFixed(0) + '%',
    }));

    // median_income_proxy is a raw estimate; format sensibly
    const inc = inView.incAgg;
    demoIncome = inc > 0
      ? (inc >= 1000000 ? '$' + (inc / 1000000).toFixed(1) + 'M' : '$' + (inc / 1000).toFixed(0) + 'k')
      : null;
    demoAge = inView.ageMed > 0 ? inView.ageMed.toFixed(0) : null;
    demoKids = inView.kidsAgg > 0 ? inView.kidsAgg.toFixed(0) + '%' : null;
  } else if (inView && inView.n === 0) {
    inViewLabel = 'No stores in view - zoom out';
  }

  // ---------- Selected store card ----------
  const sel = selectedStore;
  let selStatusColor = 'var(--db-ink-muted)';
  if (sel) {
    selStatusColor = sel.staffing_status === 'understaffed' ? 'var(--db-lava)'
      : sel.staffing_status === 'overstaffed' ? 'var(--db-amber)'
      : 'var(--db-green)';
  }

  // ---------- Styles ----------
  const leftPanelStyle = {
    position: 'absolute', top: 14, bottom: 14, left: 14, width: 336,
    background: 'rgba(255,255,255,.93)',
    backdropFilter: 'blur(10px)',
    border: '1px solid rgba(255,255,255,.7)',
    borderRadius: 14,
    boxShadow: 'var(--shadow-lg)',
    display: 'flex', flexDirection: 'column',
    overflowY: 'auto',
    zIndex: 600,
  };

  const rightPanelStyle = {
    position: 'absolute', top: 14, bottom: 14, right: 14, width: 384,
    background: 'rgba(255,255,255,.93)',
    backdropFilter: 'blur(10px)',
    border: '1px solid rgba(255,255,255,.7)',
    borderRadius: 14,
    boxShadow: 'var(--shadow-lg)',
    display: 'flex', flexDirection: 'column',
    zIndex: 600,
  };

  const handleBase = {
    position: 'absolute', top: 14, zIndex: 701,
    display: 'inline-flex', alignItems: 'center', gap: 7, height: 34,
    whiteSpace: 'nowrap', borderRadius: 9,
    background: 'rgba(255,255,255,.96)', backdropFilter: 'blur(8px)',
    border: '1px solid var(--db-line)', boxShadow: 'var(--shadow-md)',
    color: 'var(--db-navy)', font: '600 12px var(--font-sans)', cursor: 'pointer',
  };

  const leftToggleStyle = { ...handleBase, left: showLeft ? 360 : 14, padding: showLeft ? '0 12px' : '0 13px' };

  const genieBtnStyle = {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    height: 32, padding: '0 13px', borderRadius: 8,
    font: '700 12px var(--font-sans)', cursor: 'pointer',
    whiteSpace: 'nowrap', flexShrink: 0,
    background: showRight ? 'var(--db-lava)' : 'transparent',
    color: '#fff',
    border: '1px solid var(--db-lava)',
  };

  // ---------- Render ----------
  return (
    <div style={{ height: '100vh', width: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'var(--font-sans)', color: 'var(--db-ink)' }}>

      {/* TOP BAR */}
      <div style={{ flex: '0 0 56px', display: 'flex', alignItems: 'center', gap: 12, padding: '0 16px', background: 'var(--db-navy)', color: '#fff', zIndex: 1200, boxShadow: '0 1px 0 rgba(0,0,0,.2)', flexWrap: 'nowrap', overflow: 'hidden' }}>
        <img src="/assets/databricks-logo-white.svg" style={{ height: 19, display: 'block' }} alt="Databricks" />
        <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,.18)' }}></div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexShrink: 0 }}>
          <span style={{ font: '700 16px var(--font-sans)', letterSpacing: '-.01em' }}>Clover</span>
          <span style={{ font: '700 10px var(--font-sans)', letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--db-coral)' }}>Geospatial&nbsp;Store&nbsp;Ops</span>
        </div>
        <div style={{ display: 'flex', gap: 7, marginLeft: 6, flexShrink: 0 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 11px', borderRadius: 7, background: 'rgba(255,255,255,.09)', font: '500 12px var(--font-sans)', whiteSpace: 'nowrap' }}>
            {'📍'} {meta.metro || 'Greater Boston Metro'} <span style={{ opacity: .5 }}>{'▾'}</span>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 11px', borderRadius: 7, background: 'rgba(255,255,255,.09)', font: '500 12px var(--font-sans)', whiteSpace: 'nowrap' }}>
            {meta.date_window} <span style={{ opacity: .5 }}>{'▾'}</span>
          </span>
        </div>
        <div style={{ flex: 1, minWidth: 8 }}></div>
        <button onClick={() => setShowRight(r => !r)} style={genieBtnStyle}>
          <img src="/assets/genie-icon-full-color.svg" style={{ width: 15, height: 15, display: 'block' }} alt="" />
          Ask Genie
        </button>
        <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,.18)', flexShrink: 0 }}></div>
        <button
          onClick={() => setShowArch(a => !a)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            height: 32, padding: '0 13px', borderRadius: 8,
            font: '600 12px var(--font-sans)', cursor: 'pointer',
            whiteSpace: 'nowrap', flexShrink: 0,
            background: showArch ? 'rgba(255,255,255,.18)' : 'transparent',
            color: showArch ? '#fff' : 'rgba(255,255,255,.75)',
            border: showArch ? '1px solid rgba(255,255,255,.4)' : '1px solid rgba(255,255,255,.22)',
            transition: 'all .15s',
          }}
          title={showArch ? 'Back to map' : 'View architecture diagram'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/>
            <line x1="8.5" y1="6" x2="15.5" y2="6"/><line x1="6" y1="8.5" x2="6" y2="15.5"/>
            <line x1="8.5" y1="18" x2="15.5" y2="18"/><line x1="18" y1="8.5" x2="18" y2="15.5"/>
          </svg>
          {showArch ? '← Map' : 'Architecture'}
        </button>
      </div>

      {/* STAGE */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', background: 'var(--db-oat-medium)' }}>

        {/* MAP (full-bleed, behind glass panels) */}
        <div style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          <div
            ref={mapRef}
            id="map"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', background: '#E7E4DE' }}
          >
            {/* Loading veil - shown until ready */}
            {!ready && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--db-oat-medium)', zIndex: 700 }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
                  <div style={{ width: 34, height: 34, border: '3px solid var(--db-gray-300)', borderTopColor: 'var(--db-lava)', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
                  <span style={{ font: '500 13px var(--font-sans)', color: 'var(--db-ink-muted)' }}>Loading geospatial layers...</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Left panel toggle handle */}
        <button
          onClick={() => setShowLeft(l => !l)}
          style={{ ...leftToggleStyle, padding: '0 9px' }}
          title={showLeft ? 'Hide layers panel' : 'Show layers panel'}
          aria-label={showLeft ? 'Hide layers panel' : 'Show layers panel'}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
            {showLeft && <rect x="3.5" y="3.5" width="5.5" height="17" rx="1.5" fill="currentColor" stroke="none" opacity="0.18" />}
          </svg>
        </button>

        {/* Heat legend - shown when traffic layer is on and map ready */}
        {ready && layersOn.traffic && (
          <div style={{ position: 'absolute', left: 14, bottom: 14, zIndex: 650, background: 'rgba(255,255,255,.92)', backdropFilter: 'blur(6px)', border: '1px solid var(--db-line)', borderRadius: 10, padding: '9px 12px', boxShadow: 'var(--shadow-md)' }}>
            <div style={{ font: '700 10px var(--font-sans)', letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--db-ink-muted)', marginBottom: 6 }}>Foot-traffic density</div>
            <div style={{ width: 150, height: 8, borderRadius: 4, background: 'linear-gradient(90deg,#F2E9F7,#B07CD1,#7E3FA8,#4A1D6E)' }}></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3, font: '400 10px var(--font-mono)', color: 'var(--db-ink-muted)' }}>
              <span>low</span><span>high</span>
            </div>
          </div>
        )}

        {/* LEFT RAIL: layers + analytics */}
        {showLeft && (
          <div className="lf" style={leftPanelStyle}>

            {/* Layers header */}
            <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid var(--db-line)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ font: '700 13px var(--font-sans)', letterSpacing: '.02em', color: 'var(--db-navy)', textTransform: 'uppercase' }}>Layers</span>
                <span style={{ font: '600 11px var(--font-sans)', color: 'var(--db-ink-muted)' }}>{activeCount} on</span>
              </div>
              <div style={{ marginTop: 3, font: '400 11px var(--font-sans)', color: 'var(--db-ink-muted)' }}>
                Tables in <span style={{ fontFamily: 'var(--font-mono)' }}>clover_spatial_catalog.gold</span>
              </div>
            </div>

            {/* Layer toggle rows */}
            <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {LAYER_DEFS.map(def => (
                <LayerRow
                  key={def.key}
                  def={def}
                  active={layersOn[def.key]}
                  onToggle={() => toggleLayer(def.key)}
                />
              ))}
            </div>

            {/* Analytics section */}
            <div style={{ display: 'flex', flexDirection: 'column', flex: '0 0 auto', borderTop: '1px solid var(--db-line)', background: 'var(--db-oat-light)' }}>
              <div style={{ padding: '14px 16px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'sticky', top: 0, background: 'var(--db-oat-light)', zIndex: 2 }}>
                <div>
                  <div style={{ font: '700 13px var(--font-sans)', letterSpacing: '.02em', textTransform: 'uppercase', color: 'var(--db-navy)' }}>Analytics</div>
                  <div style={{ font: '400 11px var(--font-sans)', color: 'var(--db-ink-muted)', marginTop: 2 }}>{inViewLabel}</div>
                </div>
                <span style={{ fontSize: 15, opacity: .5 }}>{'🛰️'}</span>
              </div>

              {/* Selected store drill-down card */}
              {sel && (
                <div style={{ margin: '0 12px 10px', border: '1px solid var(--db-line)', borderRadius: 12, background: '#fff', overflow: 'hidden', boxShadow: 'var(--shadow-sm)' }}>
                  <div style={{ padding: '11px 13px', display: 'flex', alignItems: 'flex-start', gap: 10, borderBottom: '1px solid var(--db-line)' }}>
                    <div style={{ flex: '0 0 8px', height: 8, borderRadius: '50%', marginTop: 5, background: selStatusColor }}></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ font: '700 14px var(--font-sans)', color: 'var(--db-navy)' }}>{sel.name}</div>
                      <div style={{ font: '400 11px var(--font-sans)', color: 'var(--db-ink-muted)' }}>{sel.format} - {sel.zip} - {fmt(sel.sqft)} sq ft</div>
                    </div>
                    <button onClick={handleClearStore} style={{ border: 'none', background: 'var(--db-oat-medium)', color: 'var(--db-ink-soft)', width: 22, height: 22, borderRadius: 6, cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>&#x2715;</button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1px', background: 'var(--db-line)' }}>
                    <div style={{ background: '#fff', padding: '9px 13px' }}>
                      <div style={{ font: '400 10px var(--font-sans)', color: 'var(--db-ink-muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Staffing</div>
                      <div style={{ font: '700 13px var(--font-sans)', color: selStatusColor, textTransform: 'capitalize' }}>{sel.staffing_status}</div>
                    </div>
                    <div style={{ background: '#fff', padding: '9px 13px' }}>
                      <div style={{ font: '400 10px var(--font-sans)', color: 'var(--db-ink-muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Labor gap</div>
                      <div style={{ font: '700 13px var(--font-mono)', color: selStatusColor }}>{hrs(sel.labor_gap)}</div>
                    </div>
                    <div style={{ background: '#fff', padding: '9px 13px' }}>
                      <div style={{ font: '400 10px var(--font-sans)', color: 'var(--db-ink-muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>3-day traffic</div>
                      <div style={{ font: '700 13px var(--font-mono)', color: sel.traffic_delta_pct < 0 ? 'var(--db-lava)' : 'var(--db-green)' }}>
                        {(sel.traffic_delta_pct > 0 ? '+' : '') + sel.traffic_delta_pct + '%'}
                      </div>
                    </div>
                    <div style={{ background: '#fff', padding: '9px 13px' }}>
                      <div style={{ font: '400 10px var(--font-sans)', color: 'var(--db-ink-muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Recommend</div>
                      <div style={{ font: '700 13px var(--font-mono)', color: 'var(--db-navy)' }}>{sel.ideal_hours}h</div>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setGenieSeedQuestion({ q: `How should I staff ${sel.name}?`, ts: Date.now() });
                      setShowRight(true);
                    }}
                    style={{ width: '100%', border: 'none', borderTop: '1px solid var(--db-line)', background: '#fff', color: 'var(--db-lava)', padding: 9, cursor: 'pointer', font: '600 12px var(--font-sans)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  >
                    {'✨'} Ask Genie how to staff this store
                  </button>
                </div>
              )}

              {/* KPI tiles */}
              {kpis.length > 0 ? (
                <div style={{ padding: '0 12px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {kpis.map(kpi => <KpiTile key={kpi.label} kpi={kpi} />)}
                </div>
              ) : (
                <div style={{ padding: '0 12px 4px' }}>
                  <div style={{ background: '#fff', border: '1px solid var(--db-line)', borderRadius: 11, padding: '18px 14px', textAlign: 'center', color: 'var(--db-ink-muted)', font: '400 12px var(--font-sans)' }}>
                    {inView && inView.n === 0 ? 'Zoom out to see store analytics' : 'Pan or zoom to load store analytics'}
                  </div>
                </div>
              )}

              {/* Trend sparkline */}
              <div style={{ padding: 12 }}>
                <div style={{ background: '#fff', border: '1px solid var(--db-line)', borderRadius: 11, padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ font: '600 12px var(--font-sans)', color: 'var(--db-navy)' }}>Foot traffic - trailing 30 days</span>
                    <span style={{ font: '400 10px var(--font-mono)', color: 'var(--db-ink-muted)' }}>foot_traffic_daily</span>
                  </div>
                  <svg viewBox="0 0 320 96" style={{ width: '100%', height: 84, display: 'block', overflow: 'visible' }}>
                    <defs>
                      <linearGradient id="cvgrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#FF5F46" stopOpacity="0.28" />
                        <stop offset="100%" stopColor="#FF5F46" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <line x1="0" y1="84" x2="320" y2="84" stroke="var(--db-line)" strokeWidth="1" />
                    {trendArea && <path d={trendArea} fill="url(#cvgrad)" />}
                    {trendLine && <path d={trendLine} fill="none" stroke="var(--db-lava)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
                  </svg>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, font: '400 10px var(--font-mono)', color: 'var(--db-ink-muted)' }}>
                    <span>30d ago</span><span>today</span>
                  </div>
                </div>
              </div>

              {/* Demographics */}
              <div style={{ padding: '0 12px 14px' }}>
                <div style={{ background: '#fff', border: '1px solid var(--db-line)', borderRadius: 11, padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <span style={{ font: '600 12px var(--font-sans)', color: 'var(--db-navy)' }}>Visitor demographics</span>
                    <span style={{ font: '400 10px var(--font-mono)', color: 'var(--db-ink-muted)' }}>visitor_demographics</span>
                  </div>
                  <div style={{ display: 'flex', gap: 14, marginBottom: 12 }}>
                    {demoIncome && (
                      <>
                        <div>
                          <div style={{ font: '700 18px var(--font-sans)', color: 'var(--db-navy)', lineHeight: 1 }}>{demoIncome}</div>
                          <div style={{ font: '400 10px var(--font-sans)', color: 'var(--db-ink-muted)', marginTop: 3 }}>income index</div>
                        </div>
                        <div style={{ width: 1, background: 'var(--db-line)' }}></div>
                      </>
                    )}
                    {demoAge && (
                      <>
                        <div>
                          <div style={{ font: '700 18px var(--font-sans)', color: 'var(--db-navy)', lineHeight: 1 }}>{demoAge}</div>
                          <div style={{ font: '400 10px var(--font-sans)', color: 'var(--db-ink-muted)', marginTop: 3 }}>median age</div>
                        </div>
                        <div style={{ width: 1, background: 'var(--db-line)' }}></div>
                      </>
                    )}
                    {demoKids && (
                      <div>
                        <div style={{ font: '700 18px var(--font-sans)', color: 'var(--db-navy)', lineHeight: 1 }}>{demoKids}</div>
                        <div style={{ font: '400 10px var(--font-sans)', color: 'var(--db-ink-muted)', marginTop: 3 }}>hh w/ kids</div>
                      </div>
                    )}
                    {!demoIncome && !demoAge && !demoKids && (
                      <div style={{ font: '400 12px var(--font-sans)', color: 'var(--db-ink-muted)' }}>Pan map to load demographics</div>
                    )}
                  </div>
                  {demoBars.map(b => (
                    <div key={b.band} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ flex: '0 0 42px', font: '500 11px var(--font-mono)', color: 'var(--db-ink-soft)', textAlign: 'right' }}>{b.band}</span>
                      <div style={{ flex: 1, height: 9, background: 'var(--db-oat-medium)', borderRadius: 5, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: b.width, background: 'var(--db-slate)', borderRadius: 5 }}></div>
                      </div>
                      <span style={{ flex: '0 0 34px', font: '500 11px var(--font-mono)', color: 'var(--db-ink-muted)' }}>{b.pct}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* UC governance footer */}
            <div style={{ padding: '12px 16px', borderTop: '1px solid var(--db-line)', display: 'flex', alignItems: 'center', gap: 8, background: '#fff' }}>
              <span style={{ fontSize: 13 }}>{'🔒'}</span>
              <span style={{ font: '400 11px var(--font-sans)', color: 'var(--db-ink-muted)', lineHeight: 1.4 }}>
                Governed by <b style={{ color: 'var(--db-ink-soft)' }}>Unity Catalog</b> - every layer is a live table.
              </span>
            </div>
          </div>
        )}

        {/* RIGHT RAIL: Ask Genie */}
        {showRight && (
          <div style={rightPanelStyle}>
            <GeniePanel
              onClose={() => setShowRight(false)}
              seedQuestion={genieSeedQuestion}
            />
          </div>
        )}

        {/* ARCHITECTURE OVERLAY: absolute, covers stage, map stays mounted */}
        {showArch && <ArchitecturePanel onClose={() => setShowArch(false)} />}
      </div>
    </div>
  );
}
