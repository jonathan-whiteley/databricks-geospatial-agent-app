import { useRef, useState, useEffect, useCallback } from 'react';
import { getBootstrap, getLayer } from './api.js';
import { initMap, toggleLayer as mapToggleLayer, selectStore as mapSelectStore, clearStore as mapClearStore, destroyMap } from './map.js';

// ---------- Static layer definitions (UI metadata only) ----------

const LAYER_DEFS = [
  { key: 'stores',      name: 'Store locations',           table: 'locations',                       icon: '📍', iconBg: '#FFEDEA' },
  { key: 'traffic',     name: 'Foot traffic heatmap',      table: 'foot_traffic_daily',               icon: '🔥', iconBg: '#FFF3E6' },
  { key: 'trade',       name: 'Trade areas',               table: 'visitor_origins',                  icon: '🧭', iconBg: '#FFEDEA' },
  { key: 'demo',        name: 'Demographics',              table: 'visitor_demographics - geo_zips',  icon: '🏘️', iconBg: '#E9F1F3' },
  { key: 'competitors', name: 'Competitors',               table: 'nearby_pois',                      icon: '🎯', iconBg: '#F6E4E7' },
  { key: 'pois',        name: 'Nearby POIs',               table: 'nearby_pois',                      icon: '🏬', iconBg: '#EEF1F4' },
  { key: 'cross',       name: 'Cross-shopping',            table: 'cross_shopping',                   icon: '🔗', iconBg: '#EEF1F4' },
];

const GENIE_SEED = [
  { role: 'user', text: "Which stores are understaffed for tomorrow's forecast?" },
  {
    role: 'genie',
    text: "4 stores are projected to run understaffed against tomorrow's foot-traffic forecast (target 165 visits / labor-hour). Ranked by labor gap:",
    sql: "SELECT name, forecast_visits, scheduled_hours, ideal_hours,\n       ideal_hours - scheduled_hours AS add_hours\nFROM clover.retail_analytics.locations\nWHERE staffing_status = 'understaffed'\nORDER BY add_hours DESC\nLIMIT 5;",
    table: {
      h0: 'Store',
      hrest: ['Sched', 'Rec', 'Add'],
      rows: [
        { name: 'Wicker Park',  vals: ['32h', '40h', '+8h'], dot: '#FF3621' },
        { name: 'Logan Square', vals: ['28h', '34h', '+6h'], dot: '#FF3621' },
        { name: 'Pilsen',       vals: ['30h', '35h', '+5h'], dot: '#FF3621' },
        { name: 'Hyde Park',    vals: ['26h', '30h', '+4h'], dot: '#FF3621' },
      ],
    },
    callout: {
      icon: '⚡',
      label: 'Action:',
      text: 'Cover ~23 labor-hours tomorrow. 2 overstaffed stores have ~14h of slack you can reallocate.',
      bg: '#FFF1EE',
      bar: '#FF3621',
    },
  },
];

const CHIPS = [
  { key: 'laborHours', label: 'Suggest labor hours' },
  { key: 'drops',      label: 'Sudden traffic drops' },
  { key: 'peaks',      label: 'Peak-hour gaps' },
  { key: 'vsTraffic',  label: 'Staffing vs. foot traffic' },
];

// ---------- Helpers ----------

function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
function hrs(n) { return (n > 0 ? '+' : '') + n + 'h'; }

function buildSparkline(series) {
  const W = 320, H = 84;
  const s = series && series.length ? series : [0];
  const mn = Math.min(...s), mx = Math.max(...s), rng = (mx - mn) || 1;
  const pts = s.map((v, i) => [
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

function GenieMessage({ msg }) {
  const isGenie = msg.role === 'genie';
  const wrapStyle = { alignSelf: isGenie ? 'stretch' : 'flex-end', maxWidth: isGenie ? '100%' : '88%' };
  const bubbleStyle = isGenie
    ? { background: 'var(--db-oat-light)', border: '1px solid var(--db-line)', borderRadius: '4px 12px 12px 12px', padding: '11px 13px' }
    : { background: 'var(--db-navy)', borderRadius: '12px 12px 4px 12px', padding: '9px 13px' };
  const textColor = isGenie ? 'var(--db-ink)' : '#fff';

  return (
    <div className="cv-msg" style={wrapStyle}>
      {isGenie && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
          <img src="/assets/genie-icon-full-color.svg" style={{ width: 18, height: 18 }} alt="" />
          <span style={{ font: '700 11px var(--font-sans)', color: 'var(--db-navy)' }}>Genie</span>
        </div>
      )}
      <div style={bubbleStyle}>
        <div style={{ font: '400 13px/1.5 var(--font-sans)', color: textColor }}>{msg.text}</div>
        {msg.sql && (
          <div style={{ marginTop: 9, background: 'var(--db-navy)', borderRadius: 8, padding: '9px 11px', overflowX: 'auto' }}>
            <div style={{ font: '600 9px var(--font-sans)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,.4)', marginBottom: 5 }}>Generated SQL</div>
            <pre style={{ margin: 0, font: '400 11px/1.5 var(--font-mono)', color: '#d7e0e2', whiteSpace: 'pre' }}>{msg.sql}</pre>
          </div>
        )}
        {msg.table && (
          <div style={{ marginTop: 9, border: '1px solid var(--db-line)', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ display: 'flex', background: 'var(--db-oat-medium)', padding: '6px 9px', gap: 6 }}>
              <span style={{ flex: 1.5, font: '700 10px var(--font-sans)', color: 'var(--db-ink-soft)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{msg.table.h0}</span>
              {msg.table.hrest.map(h => (
                <span key={h} style={{ flex: 1, textAlign: 'right', font: '700 10px var(--font-sans)', color: 'var(--db-ink-soft)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{h}</span>
              ))}
            </div>
            {msg.table.rows.map((row, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '7px 9px', background: i % 2 ? '#fff' : '#faf9f7' }}>
                <span style={{ flex: 1.5, font: '600 12px var(--font-sans)', color: 'var(--db-navy)', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ flex: '0 0 6px', height: 6, borderRadius: '50%', background: row.dot }}></span>
                  {row.name}
                </span>
                {row.vals.map((v, j) => (
                  <span key={j} style={{ flex: 1, textAlign: 'right', font: '500 12px var(--font-mono)', color: 'var(--db-ink)' }}>{v}</span>
                ))}
              </div>
            ))}
          </div>
        )}
        {msg.callout && (
          <div style={{ marginTop: 9, display: 'flex', gap: 8, padding: '9px 11px', borderRadius: 8, background: msg.callout.bg, borderLeft: `3px solid ${msg.callout.bar}` }}>
            <span style={{ fontSize: 13 }}>{msg.callout.icon}</span>
            <div style={{ font: '500 12px/1.45 var(--font-sans)', color: 'var(--db-ink)' }}>
              <b style={{ color: msg.callout.bar }}>{msg.callout.label} </b>{msg.callout.text}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Main App ----------

export default function App() {
  const mapRef = useRef(null);
  const genieRef = useRef(null);
  const mapInitialized = useRef(false);

  // Bootstrap / loading state
  const [ready, setReady] = useState(false);
  const [meta, setMeta] = useState({ metro: '', date_window: 'Trailing 30 days', refreshed: '' });

  // Layer toggle state (mirrors map module)
  const [layersOn, setLayersOn] = useState({
    stores: true, traffic: true, trade: false, demo: false,
    competitors: false, pois: false, cross: false,
  });

  // In-viewport analytics state
  const [inView, setInView] = useState(null);

  // Selected store for drill-down card
  const [selectedStore, setSelectedStore] = useState(null);

  // Panel visibility
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);

  // Genie chat
  const [genie, setGenie] = useState(GENIE_SEED);
  const [draft, setDraft] = useState('');

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

        // Fetch the five overlay layers in parallel; guard each so one failure does not crash
        return Promise.all([
          getLayer('trade').catch(() => []),
          getLayer('demo').catch(() => []),
          getLayer('competitors').catch(() => []),
          getLayer('pois').catch(() => []),
          getLayer('cross').catch(() => []),
        ]).then(([tradeRows, demoRows, competitorRows, poisRows, crossRows]) => {
          // Merge layer data into the bootstrap payload under the field names map.js builders consume
          const merged = {
            ...data,
            visitor_origins: tradeRows,
            demo_rows: demoRows,
            competitor_rows: competitorRows,
            poi_rows: poisRows,
            cross_rows: crossRows,
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

    return () => { destroyMap(); };
  }, []);

  // Scroll Genie to bottom on new messages
  useEffect(() => {
    if (genieRef.current) {
      setTimeout(() => { genieRef.current.scrollTop = genieRef.current.scrollHeight; }, 50);
    }
  }, [genie]);

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

  // ---------- Genie ----------
  function sendDraft() {
    const t = draft.trim();
    if (!t) return;
    setGenie(prev => [...prev, { role: 'user', text: t }, {
      role: 'genie',
      text: "I'm running in preview mode, so free-form answers aren't wired up yet. Connect the Genie Conversations API to query clover.retail_analytics live - or try one of the suggested labor prompts below.",
    }]);
    setDraft('');
  }

  function sendChip(label) {
    setGenie(prev => [...prev, { role: 'user', text: label }, {
      role: 'genie',
      text: "I'm running in preview mode. Connect the Genie Conversations API to get live answers from clover.retail_analytics.",
    }]);
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
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.15, flexShrink: 0 }}>
          <span style={{ font: '600 10px var(--font-sans)', color: 'rgba(255,255,255,.85)' }}>Live</span>
          <span style={{ font: '400 10px var(--font-mono)', color: 'rgba(255,255,255,.45)' }}>{meta.refreshed}</span>
        </div>
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
        <button onClick={() => setShowLeft(l => !l)} style={leftToggleStyle}>
          {showLeft ? '‹ Hide' : '☰ Layers & data'}
        </button>

        {/* Heat legend - shown when traffic layer is on and map ready */}
        {ready && layersOn.traffic && (
          <div style={{ position: 'absolute', left: 14, bottom: 14, zIndex: 650, background: 'rgba(255,255,255,.92)', backdropFilter: 'blur(6px)', border: '1px solid var(--db-line)', borderRadius: 10, padding: '9px 12px', boxShadow: 'var(--shadow-md)' }}>
            <div style={{ font: '700 10px var(--font-sans)', letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--db-ink-muted)', marginBottom: 6 }}>Foot-traffic density</div>
            <div style={{ width: 150, height: 8, borderRadius: 4, background: 'linear-gradient(90deg,#FFE08A,#FF9E94,#FF5F46,#FF3621)' }}></div>
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
                Tables in <span style={{ fontFamily: 'var(--font-mono)' }}>clover.retail_analytics</span>
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
                    onClick={() => { /* Task 11 will wire Genie ask */ }}
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
            <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, background: '#fff', borderRadius: 14, overflow: 'hidden' }}>

              {/* Genie header */}
              <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--db-line)', background: 'linear-gradient(180deg,#fff,#fbfaf8)' }}>
                <img src="/assets/genie-icon-full-color.svg" style={{ width: 26, height: 26, display: 'block' }} alt="Genie" />
                <div style={{ flex: 1 }}>
                  <div style={{ font: '700 14px var(--font-sans)', color: 'var(--db-navy)' }}>Ask Genie</div>
                  <div style={{ font: '500 11px var(--font-sans)', color: 'var(--db-ink-muted)' }}>Store Operations - <span style={{ color: 'var(--db-coral)' }}>Labor</span></div>
                </div>
                <span style={{ font: '400 10px var(--font-mono)', color: 'var(--db-ink-muted)', border: '1px solid var(--db-line)', borderRadius: 6, padding: '3px 7px' }}>space: store_ops</span>
                <button onClick={() => setShowRight(false)} title="Hide Ask Genie" style={{ border: 'none', background: 'var(--db-oat-medium)', color: 'var(--db-ink-soft)', width: 24, height: 24, borderRadius: 7, cursor: 'pointer', fontSize: 13, lineHeight: 1, flexShrink: 0 }}>&#x2715;</button>
              </div>

              {/* Message area */}
              <div ref={genieRef} className="lf" style={{ flex: 1, minHeight: 120, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
                {genie.map((msg, i) => <GenieMessage key={i} msg={msg} />)}
              </div>

              {/* Input area */}
              <div style={{ padding: '10px 12px', borderTop: '1px solid var(--db-line)', background: 'var(--db-oat-light)' }}>
                <div className="lf" style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 8 }}>
                  {CHIPS.map(c => (
                    <button key={c.key} onClick={() => sendChip(c.label)} style={{ flex: '0 0 auto', whiteSpace: 'nowrap', border: '1px solid var(--db-line)', background: '#fff', color: 'var(--db-navy)', borderRadius: 999, padding: '6px 12px', font: '500 11px var(--font-sans)', cursor: 'pointer' }}>
                      {c.label}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, background: '#fff', border: '1px solid var(--db-gray-300)', borderRadius: 10, padding: '6px 6px 6px 12px' }}>
                  <input
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && sendDraft()}
                    placeholder="Ask about labor, staffing, foot traffic..."
                    style={{ flex: 1, border: 'none', outline: 'none', font: '400 13px var(--font-sans)', color: 'var(--db-ink)', background: 'transparent', height: 28 }}
                  />
                  <button onClick={sendDraft} style={{ flex: '0 0 auto', border: 'none', background: 'var(--db-lava)', color: '#fff', width: 30, height: 30, borderRadius: 8, cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {'↑'}
                  </button>
                </div>
                <div style={{ marginTop: 6, font: '400 10px var(--font-sans)', color: 'var(--db-ink-muted)', textAlign: 'center' }}>
                  Preview UI - connect the Genie Conversations API to enable live answers.
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
