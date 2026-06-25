import { useRef, useState } from 'react';

// ---------- Static placeholder data ----------

const META = {
  metro: 'Chicago, IL Metro',
  date_window: 'Trailing 30 days',
  refreshed: '2026-06-23 06:00 CT',
};

const LAYER_DEFS = [
  { key: 'stores',      name: 'Store locations',       table: 'locations',                           icon: '📍', iconBg: '#FFEDEA' },
  { key: 'traffic',     name: 'Foot traffic heatmap',  table: 'foot_traffic_daily',                  icon: '🔥', iconBg: '#FFF3E6' },
  { key: 'trade',       name: 'Trade areas',           table: 'visitor_origins',                     icon: '🧭', iconBg: '#FFEDEA' },
  { key: 'demo',        name: 'Demographics',          table: 'visitor_demographics · geo_zips',     icon: '🏘️', iconBg: '#E9F1F3' },
  { key: 'competitors', name: 'Competitors',           table: 'nearby_pois',                         icon: '🎯', iconBg: '#F6E4E7' },
  { key: 'pois',        name: 'Nearby POIs',           table: 'nearby_pois',                         icon: '🏬', iconBg: '#EEF1F4' },
  { key: 'cross',       name: 'Cross-shopping',        table: 'cross_shopping',                      icon: '🔗', iconBg: '#EEF1F4' },
];

const SAMPLE_KPIS = [
  { label: 'Daily foot traffic', value: '2,841',  arrow: '▲', delta: '3.2%', deltaNote: 'vs last wk', deltaColor: 'var(--db-green)' },
  { label: 'Trade-area visitors', value: '18,530', arrow: '▲', delta: '2.6%', deltaNote: 'reach',      deltaColor: 'var(--db-green)' },
  { label: 'Avg dwell',          value: '24m',    arrow: '▼', delta: '1.1%', deltaNote: '',            deltaColor: 'var(--db-lava)'  },
  { label: 'Capture rate',       value: '14.3%',  arrow: '▲', delta: '0.4%', deltaNote: '',            deltaColor: 'var(--db-green)' },
];

const SAMPLE_DEMO_BARS = [
  { band: '18-24', pct: '9%',  width: '31%'  },
  { band: '25-34', pct: '22%', width: '75%'  },
  { band: '35-44', pct: '24%', width: '82%'  },
  { band: '45-54', pct: '19%', width: '65%'  },
  { band: '55-64', pct: '14%', width: '48%'  },
  { band: '65+',   pct: '12%', width: '41%'  },
];

// A simple 30-point sparkline path for the placeholder trend chart
function buildSparkline() {
  const raw = [2400,2350,2500,2480,2600,2550,2700,2650,2800,2750,2900,2820,2780,2950,3000,2880,2820,2780,2900,2950,3100,3050,2980,3200,3150,3080,3100,3200,3180,2841];
  const W = 320, H = 84;
  const mn = Math.min(...raw), mx = Math.max(...raw), rng = (mx - mn) || 1;
  const pts = raw.map((v, i) => [
    ((i / (raw.length - 1)) * W).toFixed(1),
    (H - ((v - mn) / rng) * (H - 8) - 2).toFixed(1),
  ]);
  const line = 'M' + pts.map(p => p[0] + ',' + p[1]).join(' L');
  const area = line + ` L${W},${H} L0,${H} Z`;
  return { line, area };
}
const SPARKLINE = buildSparkline();

const GENIE_SEED = [
  {
    role: 'user',
    text: "Which stores are understaffed for tomorrow's forecast?",
  },
  {
    role: 'genie',
    text: '4 stores are projected to run understaffed against tomorrow\'s foot-traffic forecast (target 165 visits / labor-hour). Ranked by labor gap:',
    sql: "SELECT name, forecast_visits, scheduled_hours, ideal_hours,\n       ideal_hours - scheduled_hours AS add_hours\nFROM clover.retail_analytics.locations\nWHERE staffing_status = 'understaffed'\nORDER BY add_hours DESC\nLIMIT 5;",
    table: {
      h0: 'Store',
      hrest: ['Sched', 'Rec', 'Add'],
      rows: [
        { name: 'Wicker Park',    vals: ['32h', '40h', '+8h'],  dot: '#FF3621' },
        { name: 'Logan Square',   vals: ['28h', '34h', '+6h'],  dot: '#FF3621' },
        { name: 'Pilsen',         vals: ['30h', '35h', '+5h'],  dot: '#FF3621' },
        { name: 'Hyde Park',      vals: ['26h', '30h', '+4h'],  dot: '#FF3621' },
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
  { key: 'laborHours', label: 'Suggest labor hours'      },
  { key: 'drops',      label: 'Sudden traffic drops'     },
  { key: 'peaks',      label: 'Peak-hour gaps'           },
  { key: 'vsTraffic',  label: 'Staffing vs. foot traffic' },
];

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
  const wrapStyle = {
    alignSelf: isGenie ? 'stretch' : 'flex-end',
    maxWidth: isGenie ? '100%' : '88%',
  };
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

  const [layersOn, setLayersOn] = useState({ stores: true, traffic: true, trade: false, demo: false, competitors: false, pois: false, cross: false });
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [genie, setGenie] = useState(GENIE_SEED);
  const [draft, setDraft] = useState('');

  const activeCount = LAYER_DEFS.filter(d => layersOn[d.key]).length;

  function toggleLayer(key) {
    setLayersOn(prev => ({ ...prev, [key]: !prev[key] }));
  }

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

  // Styles that mirror the DC design's glass overlay layout
  const glass = 'position:absolute;top:14px;bottom:14px;background:rgba(255,255,255,.93);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.7);border-radius:14px;box-shadow:var(--shadow-lg);';

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

  const leftToggleStyle = {
    ...handleBase,
    left: showLeft ? 360 : 14,
    padding: showLeft ? '0 12px' : '0 13px',
  };

  const genieBtnStyle = {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    height: 32, padding: '0 13px', borderRadius: 8,
    font: '700 12px var(--font-sans)', cursor: 'pointer',
    whiteSpace: 'nowrap', flexShrink: 0,
    background: showRight ? 'var(--db-lava)' : 'transparent',
    color: '#fff',
    border: '1px solid var(--db-lava)',
  };

  return (
    <div style={{ height: '100vh', width: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'var(--font-sans)', color: 'var(--db-ink)' }}>

      {/* ============ TOP BAR ============ */}
      <div style={{ flex: '0 0 56px', display: 'flex', alignItems: 'center', gap: 12, padding: '0 16px', background: 'var(--db-navy)', color: '#fff', zIndex: 1200, boxShadow: '0 1px 0 rgba(0,0,0,.2)', flexWrap: 'nowrap', overflow: 'hidden' }}>
        <img src="/assets/databricks-logo-white.svg" style={{ height: 19, display: 'block' }} alt="Databricks" />
        <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,.18)' }}></div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexShrink: 0 }}>
          <span style={{ font: '700 16px var(--font-sans)', letterSpacing: '-.01em' }}>Clover</span>
          <span style={{ font: '700 10px var(--font-sans)', letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--db-coral)' }}>Geospatial&nbsp;Store&nbsp;Ops</span>
        </div>
        <div style={{ display: 'flex', gap: 7, marginLeft: 6, flexShrink: 0 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 11px', borderRadius: 7, background: 'rgba(255,255,255,.09)', font: '500 12px var(--font-sans)', whiteSpace: 'nowrap' }}>
            {'📍'} {META.metro} <span style={{ opacity: .5 }}>{'▾'}</span>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 11px', borderRadius: 7, background: 'rgba(255,255,255,.09)', font: '500 12px var(--font-sans)', whiteSpace: 'nowrap' }}>
            {META.date_window} <span style={{ opacity: .5 }}>{'▾'}</span>
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
          <span style={{ font: '400 10px var(--font-mono)', color: 'rgba(255,255,255,.45)' }}>{META.refreshed}</span>
        </div>
      </div>

      {/* ============ STAGE ============ */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', background: 'var(--db-oat-medium)' }}>

        {/* ---- MAP COLUMN (full bleed behind glass panels) ---- */}
        <div style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          {/* Map mount point - Task 10 will initialise Leaflet here */}
          <div
            ref={mapRef}
            id="map"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', background: '#E7E4DE' }}
          >
            {/* Placeholder loading state until Leaflet mounts */}
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--db-oat-medium)', zIndex: 1 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
                <div style={{ width: 34, height: 34, border: '3px solid var(--db-gray-300)', borderTopColor: 'var(--db-lava)', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
                <span style={{ font: '500 13px var(--font-sans)', color: 'var(--db-ink-muted)' }}>Loading geospatial layers...</span>
              </div>
            </div>
          </div>
        </div>

        {/* Left panel toggle handle */}
        <button onClick={() => setShowLeft(l => !l)} style={leftToggleStyle}>
          {showLeft ? '‹ Hide' : '☰ Layers & data'}
        </button>

        {/* Heat legend (shown when traffic layer is on) */}
        {layersOn.traffic && (
          <div style={{ position: 'absolute', left: 14, bottom: 14, zIndex: 650, background: 'rgba(255,255,255,.92)', backdropFilter: 'blur(6px)', border: '1px solid var(--db-line)', borderRadius: 10, padding: '9px 12px', boxShadow: 'var(--shadow-md)' }}>
            <div style={{ font: '700 10px var(--font-sans)', letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--db-ink-muted)', marginBottom: 6 }}>Foot-traffic density</div>
            <div style={{ width: 150, height: 8, borderRadius: 4, background: 'linear-gradient(90deg,#FFE08A,#FF9E94,#FF5F46,#FF3621)' }}></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3, font: '400 10px var(--font-mono)', color: 'var(--db-ink-muted)' }}>
              <span>low</span><span>high</span>
            </div>
          </div>
        )}

        {/* ---- LEFT RAIL : LAYERS + ANALYTICS ---- */}
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
                  <div style={{ font: '400 11px var(--font-sans)', color: 'var(--db-ink-muted)', marginTop: 2 }}>12 stores in view</div>
                </div>
                <span style={{ fontSize: 15, opacity: .5 }}>{'🛰️'}</span>
              </div>

              {/* KPI tiles */}
              <div style={{ padding: '0 12px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {SAMPLE_KPIS.map(kpi => (
                  <KpiTile key={kpi.label} kpi={kpi} />
                ))}
              </div>

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
                    <path d={SPARKLINE.area} fill="url(#cvgrad)" />
                    <path d={SPARKLINE.line} fill="none" stroke="var(--db-lava)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
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
                    <div>
                      <div style={{ font: '700 18px var(--font-sans)', color: 'var(--db-navy)', lineHeight: 1 }}>$54k</div>
                      <div style={{ font: '400 10px var(--font-sans)', color: 'var(--db-ink-muted)', marginTop: 3 }}>median income</div>
                    </div>
                    <div style={{ width: 1, background: 'var(--db-line)' }}></div>
                    <div>
                      <div style={{ font: '700 18px var(--font-sans)', color: 'var(--db-navy)', lineHeight: 1 }}>37</div>
                      <div style={{ font: '400 10px var(--font-sans)', color: 'var(--db-ink-muted)', marginTop: 3 }}>median age</div>
                    </div>
                    <div style={{ width: 1, background: 'var(--db-line)' }}></div>
                    <div>
                      <div style={{ font: '700 18px var(--font-sans)', color: 'var(--db-navy)', lineHeight: 1 }}>41%</div>
                      <div style={{ font: '400 10px var(--font-sans)', color: 'var(--db-ink-muted)', marginTop: 3 }}>hh w/ kids</div>
                    </div>
                  </div>
                  {SAMPLE_DEMO_BARS.map(b => (
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

            {/* Unity Catalog governance footer */}
            <div style={{ padding: '12px 16px', borderTop: '1px solid var(--db-line)', display: 'flex', alignItems: 'center', gap: 8, background: '#fff' }}>
              <span style={{ fontSize: 13 }}>{'🔒'}</span>
              <span style={{ font: '400 11px var(--font-sans)', color: 'var(--db-ink-muted)', lineHeight: 1.4 }}>
                Governed by <b style={{ color: 'var(--db-ink-soft)' }}>Unity Catalog</b> - every layer is a live table.
              </span>
            </div>
          </div>
        )}

        {/* ---- RIGHT RAIL : ASK GENIE ---- */}
        {showRight && (
          <div style={rightPanelStyle}>
            <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, background: '#fff', borderRadius: 14, overflow: 'hidden' }}>

              {/* Genie header */}
              <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--db-line)', background: 'linear-gradient(180deg,#fff,#fbfaf8)' }}>
                <img src="/assets/genie-icon-full-color.svg" style={{ width: 26, height: 26, display: 'block' }} alt="Genie" />
                <div style={{ flex: 1 }}>
                  <div style={{ font: '700 14px var(--font-sans)', color: 'var(--db-navy)' }}>Ask Genie</div>
                  <div style={{ font: '500 11px var(--font-sans)', color: 'var(--db-ink-muted)' }}>Store Operations · <span style={{ color: 'var(--db-coral)' }}>Labor</span></div>
                </div>
                <span style={{ font: '400 10px var(--font-mono)', color: 'var(--db-ink-muted)', border: '1px solid var(--db-line)', borderRadius: 6, padding: '3px 7px' }}>space: store_ops</span>
                <button onClick={() => setShowRight(false)} title="Hide Ask Genie" style={{ border: 'none', background: 'var(--db-oat-medium)', color: 'var(--db-ink-soft)', width: 24, height: 24, borderRadius: 7, cursor: 'pointer', fontSize: 13, lineHeight: 1, flexShrink: 0 }}>&#x2715;</button>
              </div>

              {/* Message area */}
              <div ref={genieRef} className="lf" style={{ flex: 1, minHeight: 120, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
                {genie.map((msg, i) => (
                  <GenieMessage key={i} msg={msg} />
                ))}
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
