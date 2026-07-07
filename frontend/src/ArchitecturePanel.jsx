// ArchitecturePanel.jsx
// Static architecture diagram for the Clover Geospatial App.
// Renders as an absolute overlay over the stage so the Leaflet map stays mounted.

const LAYER_COLORS = {
  source:     '#618794', // --db-slate
  uc:         '#FF3621', // --db-lava
  warehouse:  '#4E7C8A',
  genie:      '#C975B0',
  fm:         '#7E3FA8',
  app:        '#00A972', // --db-green
};

function NodeCard({ icon, title, mono, color }) {
  return (
    <div style={{
      background: '#fff',
      border: '1px solid var(--db-line)',
      borderRadius: 10,
      padding: '10px 12px',
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      boxShadow: '0 1px 3px rgba(0,0,0,.06)',
    }}>
      <div style={{
        flex: '0 0 30px',
        height: 30,
        borderRadius: 7,
        background: color + '1A', // 10% opacity tint
        border: '1px solid ' + color + '40',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 15,
        flexShrink: 0,
      }}>
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ font: '600 13px var(--font-sans)', color: 'var(--db-navy)', lineHeight: 1.3 }}>{title}</div>
        <div style={{ font: '400 11px var(--font-mono)', color: 'var(--db-ink-muted)', marginTop: 2, wordBreak: 'break-word', lineHeight: 1.4 }}>{mono}</div>
      </div>
    </div>
  );
}

function Column({ header, subLabel, nodes, color }) {
  return (
    <div style={{
      flex: '1 1 180px',
      minWidth: 160,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      {/* Column header */}
      <div style={{ marginBottom: 4 }}>
        <div style={{
          font: '700 10px var(--font-sans)',
          letterSpacing: '.12em',
          textTransform: 'uppercase',
          color: color,
          marginBottom: 2,
        }}>
          {header}
        </div>
        {subLabel && (
          <div style={{ font: '400 10px var(--font-mono)', color: 'var(--db-ink-muted)' }}>
            {subLabel}
          </div>
        )}
      </div>
      {/* Node cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {nodes.map((n, i) => (
          <NodeCard key={i} icon={n.icon} title={n.title} mono={n.mono} color={color} />
        ))}
      </div>
    </div>
  );
}

// Simple SVG arrow connector rendered between columns
function Arrow() {
  return (
    <div style={{
      flex: '0 0 auto',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: 30, // align with node area after header
      color: 'var(--db-ink-muted)',
      fontSize: 18,
      opacity: 0.5,
    }}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="4" y1="12" x2="18" y2="12" strokeDasharray="3 2" />
        <polyline points="14 8 18 12 14 16" />
      </svg>
    </div>
  );
}

export default function ArchitecturePanel({ onClose }) {
  const columns = [
    {
      header: 'Source',
      subLabel: 'clover_spatial_catalog.bronze',
      color: LAYER_COLORS.source,
      nodes: [
        { icon: '📍', title: 'Store Locations',       mono: 'Clover store master' },
        { icon: '🚶', title: 'Foot Traffic',          mono: 'SafeGraph mobility' },
        { icon: '👥', title: 'Visitor Demographics',  mono: 'US Census · ACS' },
        { icon: '🎯', title: 'Competitors & POIs',    mono: 'OpenStreetMap' },
        { icon: '🗺️', title: 'Geo Boundaries',        mono: 'US Census · TIGER' },
      ],
    },
    {
      header: 'Lakehouse · Unity Catalog',
      subLabel: 'clover_spatial_catalog.gold',
      color: LAYER_COLORS.uc,
      nodes: [
        { icon: '📦', title: 'Unity Catalog',               mono: 'gold · store_ops, forecast, v_* views' },
        { icon: '✨', title: 'Governed Spatial Functions',   mono: 'distance_to · in_trade_area · competitor_impact · impact_level' },
        { icon: '🔒', title: 'Governance',                  mono: 'on-behalf-of-user (OBO) reads' },
      ],
    },
    {
      header: 'Compute · Serve',
      subLabel: null,
      color: LAYER_COLORS.warehouse,
      nodes: [
        { icon: '🖥️', title: 'SQL Warehouse',     mono: 'serverless · ST_ / H3 spatial SQL · ai_forecast',        color: LAYER_COLORS.warehouse },
        { icon: '💬', title: 'Genie Space',        mono: 'Clover Store Ops · NL to SQL + functions',               color: LAYER_COLORS.genie },
        { icon: '🤖', title: 'Foundation Model',   mono: 'databricks-claude-sonnet-4-6 · next-best-action',        color: LAYER_COLORS.fm },
      ],
    },
    {
      header: 'Delivery',
      subLabel: null,
      color: LAYER_COLORS.app,
      nodes: [
        { icon: '🌐', title: 'Databricks App', mono: 'React + Leaflet + FastAPI · 5 API routes' },
      ],
    },
  ];

  // For column 3, each node has its own accent color
  const col3Colors = [LAYER_COLORS.warehouse, LAYER_COLORS.genie, LAYER_COLORS.fm];

  const legendItems = [
    { color: LAYER_COLORS.source,    label: 'Sources' },
    { color: LAYER_COLORS.uc,        label: 'Unity Catalog' },
    { color: LAYER_COLORS.warehouse, label: 'SQL Warehouse' },
    { color: LAYER_COLORS.genie,     label: 'Genie' },
    { color: LAYER_COLORS.fm,        label: 'Foundation Model' },
    { color: LAYER_COLORS.app,       label: 'Databricks App' },
  ];

  const capabilityChips = [
    'Spatial SQL · ST_ / H3',
    'Genie Conversation API',
    'Foundation Model API',
    'Unity Catalog · governance',
    'Governed UC functions',
    'Databricks Apps · hosting',
  ];

  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      zIndex: 900,
      overflow: 'auto',
      background: 'var(--db-oat-light)',
    }}>
      {/* Inner content container */}
      <div style={{
        minWidth: 640,
        maxWidth: 1100,
        margin: '0 auto',
        padding: '28px 24px 40px',
      }}>

        {/* Header row */}
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          marginBottom: 28,
          gap: 16,
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: 'var(--db-navy)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/>
                  <line x1="9" y1="6" x2="15" y2="6"/><line x1="6" y1="9" x2="6" y2="15"/>
                  <line x1="9" y1="18" x2="15" y2="18"/><line x1="18" y1="9" x2="18" y2="15"/>
                </svg>
              </div>
              <h1 style={{ font: '700 22px var(--font-sans)', color: 'var(--db-navy)', margin: 0, letterSpacing: '-.01em' }}>
                Architecture
              </h1>
            </div>
            <p style={{ font: '400 13px var(--font-sans)', color: 'var(--db-ink-muted)', margin: '6px 0 0 0', lineHeight: 1.5, maxWidth: 560 }}>
              How Clover wires Unity Catalog, spatial SQL, Genie, and Foundation Models behind one Databricks App.
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              flex: '0 0 auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 32,
              padding: '0 13px',
              borderRadius: 8,
              font: '600 12px var(--font-sans)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              background: 'transparent',
              color: 'var(--db-ink-soft)',
              border: '1px solid var(--db-line)',
              boxShadow: 'var(--shadow-md)',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            Back to map
          </button>
        </div>

        {/* Diagram columns */}
        <div style={{
          background: '#fff',
          border: '1px solid var(--db-line)',
          borderRadius: 14,
          padding: '24px 20px',
          boxShadow: 'var(--shadow-md)',
          marginBottom: 16,
        }}>
          <div style={{
            display: 'flex',
            gap: 0,
            alignItems: 'flex-start',
            overflowX: 'auto',
          }}>
            {columns.map((col, ci) => {
              const isComputeCol = ci === 2;
              return (
                <div key={ci} style={{ display: 'flex', gap: 0, flex: ci === 3 ? '0 0 auto' : '1 1 180px', minWidth: 0 }}>
                  {/* Column itself */}
                  <div style={{ flex: '1 1 0', minWidth: 160, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {/* Header */}
                    <div style={{ marginBottom: 4 }}>
                      <div style={{
                        font: '700 10px var(--font-sans)',
                        letterSpacing: '.12em',
                        textTransform: 'uppercase',
                        color: col.color,
                        marginBottom: 2,
                      }}>
                        {col.header}
                      </div>
                      {col.subLabel && (
                        <div style={{ font: '400 10px var(--font-mono)', color: 'var(--db-ink-muted)' }}>
                          {col.subLabel}
                        </div>
                      )}
                    </div>
                    {/* Nodes */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                      {col.nodes.map((n, ni) => {
                        const nodeColor = isComputeCol ? col3Colors[ni] : col.color;
                        return (
                          <div key={ni} style={{
                            background: '#fff',
                            border: '1px solid var(--db-line)',
                            borderLeft: '3px solid ' + nodeColor,
                            borderRadius: 10,
                            padding: '10px 12px',
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 10,
                            boxShadow: '0 1px 3px rgba(0,0,0,.05)',
                          }}>
                            <div style={{
                              flex: '0 0 28px',
                              height: 28,
                              borderRadius: 6,
                              background: nodeColor + '18',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: 14,
                              flexShrink: 0,
                            }}>
                              {n.icon}
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ font: '600 12px var(--font-sans)', color: 'var(--db-navy)', lineHeight: 1.3 }}>{n.title}</div>
                              <div style={{ font: '400 10px var(--font-mono)', color: 'var(--db-ink-muted)', marginTop: 2, lineHeight: 1.4 }}>{n.mono}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  {/* Arrow after each column except the last */}
                  {ci < columns.length - 1 && (
                    <div style={{
                      flex: '0 0 28px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      paddingTop: 30,
                      color: 'var(--db-ink-muted)',
                      opacity: 0.45,
                    }}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="4" y1="12" x2="17" y2="12" strokeDasharray="3 2.5" />
                        <polyline points="13 8 17 12 13 16" />
                      </svg>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Legend + capability chips */}
        <div style={{
          background: '#fff',
          border: '1px solid var(--db-line)',
          borderRadius: 12,
          padding: '16px 20px',
          boxShadow: 'var(--shadow-md)',
        }}>
          {/* LAYERS legend */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ font: '700 10px var(--font-sans)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--db-ink-muted)', marginBottom: 10 }}>
              Layers
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px' }}>
              {legendItems.map(item => (
                <span key={item.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '500 12px var(--font-sans)', color: 'var(--db-ink-soft)' }}>
                  <i style={{ width: 10, height: 10, borderRadius: '50%', background: item.color, display: 'inline-block', flexShrink: 0 }}></i>
                  {item.label}
                </span>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: 'var(--db-line)', marginBottom: 14 }}></div>

          {/* Capability chips */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {capabilityChips.map(chip => (
              <span key={chip} style={{
                display: 'inline-flex',
                alignItems: 'center',
                height: 24,
                padding: '0 10px',
                borderRadius: 6,
                background: 'var(--db-oat-medium)',
                border: '1px solid var(--db-line)',
                font: '500 11px var(--font-mono)',
                color: 'var(--db-ink-soft)',
                whiteSpace: 'nowrap',
              }}>
                {chip}
              </span>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
