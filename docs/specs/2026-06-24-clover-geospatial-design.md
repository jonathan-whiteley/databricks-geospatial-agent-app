# Clover Geospatial Store Ops — Design Spec

**Date:** 2026-06-24
**Author:** Jonathan Whiteley
**Status:** Approved (brainstorm) — pending spec review

## 1. Purpose

A Databricks App for the mock retailer **Clover** that showcases **geospatial
capabilities on Databricks** for a **Store Operations / Labor** use case:
staff stores to *real* foot traffic, and flag sudden localized drops in foot
traffic so labor hours can be pivoted in near-real-time.

The app is a single-screen cockpit:

- An **interactive Leaflet map** at the center with toggleable data layers.
- A **left rail** with layer on/off controls and an **analytics panel that
  recomputes for whatever is currently in the map viewport** (updates on
  pan/zoom — the behavior from the `hot-n-here` reference app).
- A **right-rail Ask Genie** sidebar wired to a live Genie space that renders
  **generated SQL → a results table → a ⚡Action next-best-action callout**.

Fidelity target: port the approved design
`Clover Geospatial App.dc.html` (claude.ai/design project
`2b886d31-f47b-4fa9-a0da-2709647743dd`) as closely as practical, swapping its
static `clover-data.js` for live Unity Catalog queries.

## 2. Source data (already in the workspace)

Workspace: `fevm-clover-spatial.cloud.databricks.com` (CLI profile
`fe-vm-clover-spatial`). Catalog `clover_spatial_catalog`, schema `bronze`
(owned by `samyuktha.thumala@databricks.com` — **treat as read-only**).

| Table | Key columns | Notes |
|---|---|---|
| `locations` | location_id, name, banner, neighborhood, city, market, lat, lon, h3_cell, sqft, open_date, geom | **3 real stores**, all Greater Boston (2 Standard, 1 Flagship) |
| `foot_traffic_daily` | location_id, date, dow, is_weekend, visits, unique_visitors, repeat_visitors, repeat_rate, avg_dwell_min, visits_morning, visits_afternoon, visits_evening | 2025-01-01 → 2026-06-15, daily per store |
| `visitor_demographics` | location_id, segment_type (`income`/`age`), segment (5 bands each), pct_of_visitors | **long format**; income bands incl. `<50k`; age bands incl. `18-24` |
| `visitor_origins` | location_id, zip, zip_lat, zip_lon, distance_km, visits, visit_share, geom | trade-area spokes |
| `cross_shopping` | location_id, dest_poi_id, dest_name, dest_category, dest_type, dest_lat, dest_lon, distance_km, shared_visitors, affinity_pct, sequence, geom | |
| `nearby_pois` | poi_id, name, category, poi_type (`competitor`/`complement`), anchor_store, lat, lon, h3_cell, distance_km, geom | |
| `geo_zips` | zip, cent_lon, cent_lat, area_sqmi, geom | **no income field** |
| `geo_counties` | statefp, countyfp, name, geom | |
| `geo_state` | statefp, stusps, name, geom | |

**Gaps vs. the design** (the design's `clover-data.js` mocked these):
1. **No labor/staffing data** anywhere (no scheduled hours, targets, forecasts,
   staffing status). The entire labor cockpit must be synthesized.
2. **Only 3 stores**; the design implies a fuller fleet.
3. **No per-ZIP income** (design's income choropleth was mocked); income exists
   only as `visitor_demographics` bands.

## 3. Decisions (confirmed with user)

| # | Decision | Choice |
|---|---|---|
| 1 | Labor layer | **Synthesize a governed gold layer** deriving schedule, target ratio, ideal hours, forecast, staffing status, anomaly flags from real foot traffic. |
| 2 | Store fleet | **Generate ~12 synthetic Greater Boston stores** + the 3 real = ~15 total. |
| 3 | Ask Genie | **Live**: real Genie space + Genie Conversation API for SQL+table; **FM API** for the ⚡Action. |
| 4 | Stack | **Vite + React + Leaflet** frontend, **FastAPI** backend. |
| 5 | Data location | New **`clover_spatial_catalog.gold`** schema (bronze untouched). |
| 6 | FM endpoint | **`databricks-claude-sonnet-6`** serving endpoint for the ⚡Action. |
| 7 | Forecast | **`ai_forecast`** SQL function (DOW-seasonal average fallback). Must run on the **SQL warehouse**. |

## 4. Architecture

```
Databricks App: clover-geospatial-app
├── Frontend  (Vite + React + Leaflet, DuBois design tokens)
│   ├── Top bar:     brand, metro/date selectors, Ask Genie toggle, live clock
│   ├── Left rail:   layer toggles + in-viewport Analytics panel + store drill-down
│   ├── Map column:  Leaflet map, basemap switch, heat legend, panel handles
│   └── Right rail:  Ask Genie (messages, SQL block, results table, ⚡Action, chips, input)
└── Backend  (FastAPI)
    ├── GET  /api/bootstrap        → META (center/zoom), layer catalog, store dims
    ├── GET  /api/layers/{name}    → geojson/points for a layer (stores, traffic, trade, demo, competitors, pois, cross)
    ├── POST /api/analytics        → bbox in → in-view KPIs + trend + weighted demographics
    ├── POST /api/genie/ask        → Genie Conversation API proxy (SQL + result rows)
    └── POST /api/action           → FM API next-best-action on a Genie/analytics payload
```

**Connectivity & auth.** App service principal granted via app resources:
- **SQL warehouse** (serverless) — all gold reads + `ai_forecast` build.
- **Genie space** — Conversation API.
- **Serving endpoint** `databricks-claude-sonnet-6` — ⚡Action generation.
SQL executed via `databricks-sql-connector` (or Statement Execution API) using
the app SP's OAuth token. Local dev uses the `fe-vm-clover-spatial` profile.

**Layer fetch strategy.** Layers are fetched once on load and cached client-side
(static within a session); the **Analytics panel** is the only thing that
re-queries (or recomputes client-side) on map move. To keep pan/zoom smooth, the
in-view recompute runs **client-side** over already-loaded layer data (matching
the design's `recompute()`), with `/api/analytics` available as a server-side
fallback for large result sets.

## 5. Data engineering (the `gold` build)

Delivered as an idempotent build (SQL + a small Python generator for synthetic
rows), runnable as a notebook/job. Bronze is never mutated.

### 5.1 Synthetic fleet
- `gold.locations` = 3 real stores (passthrough) + ~12 generated Greater Boston
  stores: realistic lat/lon within the metro, `h3_cell` via `h3_longlatash3`,
  banner/format mix, sqft, open_date. Deterministic seed for reproducibility.
- For each generated store, synthesize companion rows in the fact tables below
  with seasonally-plausible patterns scaled by a per-store `base_traffic`.

### 5.2 Facts & views
- **`gold.foot_traffic_daily`** — real series for the 3; generated series for the
  12 (weekday/weekend curve, daypart splits, dwell). Inject a **recent localized
  drop** (≈ −12% to −20% WoW) into 1–2 stores to demo anomaly flagging.
- **`gold.labor_schedule`** — synthesized `scheduled_hours` per store/day,
  intentionally mis-aligned for some stores to create over/under-staffing.
- **`gold.store_forecast`** — next-day `forecast_visits` per store via
  `ai_forecast` over the daily series (DOW-seasonal mean fallback). Built on the
  SQL warehouse.
- **`gold.store_ops`** (view) — cockpit spine, one row/store:
  `forecast_visits`, `target_ratio` (≈165 visits/labor-hr, configurable),
  `ideal_hours = round(forecast_visits / target_ratio)`, `scheduled_hours`,
  `labor_gap = ideal_hours − scheduled_hours`,
  `staffing_status` (`understaffed` if gap ≥ +X, `overstaffed` if ≤ −X, else
  `balanced`), `recent_visits`, `traffic_delta_pct` (trailing wk vs prior wk),
  `anomaly_driver`.
- **`gold.v_traffic_anomalies`** — stores with `traffic_delta_pct < −8`, ranked,
  with a human-readable `anomaly_driver`.
- **`gold.v_daypart_coverage`** — demand vs coverage index by daypart
  (open–11a, 11a–2p, 2–5p, 5–8p, 8p–close) with a short-staffed flag.
- **`gold.v_trade_areas`** — `visitor_origins` reshaped (origin lat/lon, visits).
- **`gold.v_demographics`** — `visitor_demographics` pivoted to the bars the
  panel expects (income bands, age bands, weighted income/age proxies); income
  **midpoint proxy** computed from bands for the choropleth.
- **`gold.v_cross_shopping`**, **`gold.v_nearby_pois`** — thin reshapes joining
  back to store coordinates and splitting competitor vs complement.

### 5.3 Frontend data contract
`/api/bootstrap` and `/api/layers/*` return shapes matching the design's
`clover-data.js` field names (e.g. `store_id`, `lat`, `lng`, `recent_visits`,
`staffing_status`, `scheduled_hours`, `ideal_hours`, `forecast_visits`,
`labor_gap`, `traffic_delta_pct`) so the ported component logic changes minimally.

## 6. Map + in-view analytics

- Leaflet, CARTO basemaps (light/voyager/dark), heat via `leaflet.heat`.
- Layers: stores (sized/colored circle markers; pin mode staffing/format/traffic),
  foot-traffic heat, trade-area spokes, demographics choropleth, competitors,
  POIs, cross-shopping — toggled via `addTo`/`removeLayer`, draw order preserved.
- `map.on('moveend')` → recompute in-view store set → update left-rail KPIs
  (trailing-week daily traffic + delta, dwell + delta, capture + delta, visitors,
  traffic-weighted demographics). Empty viewport handled.
- Store click → `flyTo` + highlight + per-store staffing drill-down card with an
  "Ask Genie how to staff this store" action that seeds the Genie panel.

## 7. Ask Genie (live)

1. Chip/free-text → `POST /api/genie/ask` `{conversation_id?, question}`.
2. Backend uses the **Genie Conversation API**: start/continue conversation,
   poll the message to completion, extract the **generated SQL** (`query`
   attachment) and **result rows**; return `{text, sql, columns, rows,
   conversation_id}`.
3. Frontend renders the navy **SQL block** + styled **results table** (design
   markup).
4. Frontend calls `POST /api/action` `{question, sql, rows}` → backend prompts
   **`databricks-claude-sonnet-6`** for a one-line **next-best-action** framed for
   a store-ops manager → rendered as the **⚡Action callout**.
5. Seed message + suggestion chips preserved: *understaffed*, *labor hours*,
   *traffic drops*, *daypart peaks*, *staff this store*.
6. Errors (Genie timeout, no SQL, FM failure) degrade gracefully to a readable
   message; the panel never hard-crashes the app.

## 8. Genie space

Built programmatically (REST/CLI) over the `gold` tables:
- Curated table + column descriptions (esp. `store_ops`, `foot_traffic_daily`,
  `v_traffic_anomalies`, `v_daypart_coverage`).
- General instructions encoding the **165 visits/labor-hour** target and the
  over/under/balanced staffing definitions so generated SQL matches the cockpit.
- ~6 sample queries mirroring the panel's answers (understaffed ranking,
  recommended labor hours, traffic drops, daypart coverage, store drill-down,
  fleet staff-vs-traffic summary).
- Space id captured into app config (app resource + env var).

## 9. Deliverables

1. `gold` schema + idempotent build (SQL + synthetic generator) — committed.
2. Genie space "Clover Store Ops" + its definition/build script.
3. `clover-geospatial-app/` — React+Leaflet frontend, FastAPI backend, `app.yaml`
   with resources (warehouse, Genie, serving endpoint), deploy notes.
4. Deployed Databricks App on `fevm-clover-spatial`.
5. README: data lineage, how to rebuild gold, how to redeploy.

## 10. Out of scope / non-goals

- No write-back / scheduling actions to source systems (read + recommend only).
- No auth beyond the app SP + workspace SSO.
- No mobile-responsive layout (desktop cockpit, matching the design's 1440×900).
- No real-time streaming; "Live" badge reflects daily-grain data + on-demand Genie.

## 11. Risks / watch-items

- **`ai_forecast` requires the SQL warehouse** (not serverless notebook compute);
  the gold build's forecast step must target the warehouse. Fallback:
  DOW-seasonal mean if `ai_forecast` is unavailable/slow.
- **Genie Conversation API latency** (seconds + polling) — show the "Genie is
  analyzing…" typing state; set a sane timeout.
- **Synthetic data realism** — keep generated series plausible (no negative
  visits, sane weekend lift) so demographics/labor math doesn't look fake.
- **`CREATE SCHEMA` permission** on `clover_spatial_catalog` — verify early;
  fallback to a `clover_demo` catalog if denied.
- **Third-party-cookie / embedding** concerns do not apply (standalone app, not
  an embedded dashboard).
