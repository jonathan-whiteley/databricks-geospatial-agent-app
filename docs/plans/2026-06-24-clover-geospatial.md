# Clover Geospatial Store Ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Databricks App for mock retailer Clover with an interactive Leaflet map, layer toggles, an in-viewport analytics panel, and a live Ask-Genie sidebar (SQL → results table → ⚡Action), backed by a synthesized labor/foot-traffic gold layer over `clover_spatial_catalog`.

**Architecture:** A medallion `gold` schema (built from read-only `bronze` plus a deterministic synthetic generator) feeds both a Genie space and a FastAPI backend. The backend serves layer/analytics data from the SQL warehouse and proxies the Genie Conversation API + a `databricks-claude-sonnet-4-6` next-best-action call. A Vite + React + Leaflet frontend ports the approved `Clover Geospatial App.dc.html` design near-verbatim, swapping its static `clover-data.js` for backend calls.

**Tech Stack:** Python 3.11 / FastAPI / `databricks-sdk` / `databricks-sql-connector`; Vite + React 18 + Leaflet 1.9.4 + leaflet.heat; Databricks Apps; Unity Catalog; Genie Conversation API; Foundation Model serving endpoint `databricks-claude-sonnet-4-6`.

## Global Constraints

- Workspace/profile: **`fe-vm-clover-spatial`** (`https://fevm-clover-spatial.cloud.databricks.com`). All CLI calls pass `--profile=fe-vm-clover-spatial`.
- Catalog **`clover_spatial_catalog`**; **`bronze` is READ-ONLY** (owned by `samyuktha.thumala@databricks.com`) — never write to it. All new objects go in **`gold`** (fallback catalog `clover_demo` only if `CREATE SCHEMA` is denied).
- FM endpoint for ⚡Action: **`databricks-claude-sonnet-4-6`** (no other model).
- Forecast uses **`ai_forecast`**, which **must execute on the SQL warehouse** (not serverless notebook compute). DOW-seasonal mean is the only permitted fallback.
- Target labor ratio: **165 visits per labor-hour** (config constant `TARGET_VISITS_PER_HOUR`). Staffing: `understaffed` if `labor_gap >= +8h`, `overstaffed` if `<= -8h`, else `balanced` (config `STAFFING_GAP_THRESHOLD = 8`).
- Synthetic generation is **deterministic** (fixed seed `CLOVER_SEED = 42`); no `random` without the seed, no wall-clock in generation.
- Writing style: no em/en dashes in code comments, docs, or UI copy (hyphens for ranges only).
- Frontend data contract field names must match the design's `clover-data.js` (`store_id`, `lat`, `lng`, `recent_visits`, `staffing_status`, `scheduled_hours`, `ideal_hours`, `forecast_visits`, `labor_gap`, `traffic_delta_pct`, `anomaly_driver`, etc.) so the ported component logic changes minimally.
- Frontend never hardcodes secrets; backend reads `DATABRICKS_WAREHOUSE_ID`, `GENIE_SPACE_ID`, `SERVING_ENDPOINT`, `GOLD_SCHEMA` from env (app resources locally via the profile).

---

## File Structure

```
clover-geospatial-app/
├── app.yaml                         # Databricks App config + resources
├── requirements.txt                 # backend deps
├── README.md                        # data lineage, rebuild, redeploy
├── data/
│   ├── config.py                    # constants (seed, target ratio, thresholds, catalog/schema)
│   ├── generate_fleet.py            # synthetic store + fact generator -> writes gold via SQL warehouse
│   ├── build_gold.sql               # gold tables/views (store_ops, anomalies, daypart, trade, demo, cross, pois)
│   ├── build_forecast.sql           # ai_forecast -> gold.store_forecast (warehouse only)
│   └── tests/
│       ├── test_generate_fleet.py   # unit tests on the generator (pure functions)
│       └── test_gold_contract.py    # integration: query gold, assert shape/invariants
├── genie/
│   ├── build_genie_space.py         # create/update the Genie space over gold
│   └── genie_space.json             # space definition (descriptions, instructions, sample SQL)
├── backend/
│   ├── main.py                      # FastAPI app + routes
│   ├── db.py                        # SQL warehouse connection + query helpers
│   ├── layers.py                    # layer queries -> design data contract
│   ├── analytics.py                 # in-view KPI computation (pure, unit-tested)
│   ├── genie.py                     # Genie Conversation API client
│   ├── action.py                    # FM API next-best-action
│   ├── models.py                    # pydantic response models
│   └── tests/
│       ├── test_analytics.py        # pure-function unit tests (no network)
│       ├── test_layers_contract.py  # field-name contract tests (mocked rows)
│       └── test_api.py              # FastAPI TestClient route tests (mocked db/genie/fm)
└── frontend/
    ├── index.html
    ├── package.json
    ├── vite.config.js               # proxy /api -> backend in dev
    └── src/
        ├── main.jsx
        ├── App.jsx                  # ported design shell (top bar, rails, stage)
        ├── api.js                   # fetch wrappers for /api/*
        ├── map.js                   # Leaflet build/layer/recompute logic (ported)
        ├── geniePanel.jsx           # Ask Genie panel (messages, SQL, table, action, chips)
        ├── analyticsPanel.jsx       # left-rail layers + in-view KPIs + store drill-down
        └── styles/dubois.css        # DuBois tokens copied from design _ds colors_and_type
```

---

## Phase 0 — Scaffold and preflight

### Task 0: Project scaffold + workspace preflight

**Files:**
- Create: `clover-geospatial-app/requirements.txt`, `clover-geospatial-app/data/config.py`, `clover-geospatial-app/.gitignore` (exists), `clover-geospatial-app/preflight.sh`
- Create: `clover-geospatial-app/data/__init__.py`, `backend/__init__.py`

**Interfaces:**
- Produces: `data/config.py` constants consumed by every later task — `PROFILE="fe-vm-clover-spatial"`, `CATALOG="clover_spatial_catalog"`, `GOLD_SCHEMA="gold"`, `BRONZE="clover_spatial_catalog.bronze"`, `GOLD="clover_spatial_catalog.gold"`, `CLOVER_SEED=42`, `TARGET_VISITS_PER_HOUR=165`, `STAFFING_GAP_THRESHOLD=8`, `METRO_CENTER=(42.3601,-71.0589)`, `METRO_ZOOM=11`, `SERVING_ENDPOINT="databricks-claude-sonnet-4-6"`.

- [ ] **Step 1: Write `requirements.txt`**

```
fastapi==0.115.*
uvicorn[standard]==0.32.*
databricks-sdk==0.39.*
databricks-sql-connector==3.6.*
pydantic==2.*
httpx==0.27.*
pytest==8.*
```

- [ ] **Step 2: Write `data/config.py`** with the constants listed in Interfaces (plain module-level constants; no logic).

- [ ] **Step 3: Write `preflight.sh`** to verify access before building anything:

```bash
#!/usr/bin/env bash
set -euo pipefail
P=fe-vm-clover-spatial
echo "== identity =="; databricks current-user me --profile=$P -o json | python3 -c "import sys,json;print(json.load(sys.stdin)['userName'])"
echo "== warehouse =="; databricks warehouses list --profile=$P | head -5
echo "== CREATE SCHEMA test =="
WID=$(databricks warehouses list --profile=$P -o json | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
echo "warehouse_id=$WID"
databricks api post /api/2.0/sql/statements --profile=$P --json "{\"warehouse_id\":\"$WID\",\"statement\":\"CREATE SCHEMA IF NOT EXISTS clover_spatial_catalog.gold\",\"wait_timeout\":\"30s\"}" -o json | python3 -c "import sys,json;print(json.load(sys.stdin)['status']['state'])"
echo "== serving endpoint =="; databricks serving-endpoints get databricks-claude-sonnet-4-6 --profile=$P -o json | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['name'],d['state'])" || echo "MISSING databricks-claude-sonnet-4-6"
echo "== genie create capability (list) =="; databricks api get /api/2.0/genie/spaces --profile=$P -o json | head -c 300 || echo "genie list not available"
```

- [ ] **Step 4: Run preflight**

Run: `bash clover-geospatial-app/preflight.sh`
Expected: prints your username, a warehouse id, `CREATE SCHEMA` state `SUCCEEDED`, the serving endpoint name + state, and a Genie spaces response. If `CREATE SCHEMA` fails, switch `GOLD_SCHEMA`/`GOLD` in `config.py` to catalog `clover_demo` and re-run. If `databricks-claude-sonnet-4-6` is MISSING, STOP and report to the user before proceeding.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Projects/clover-geospatial-app
git add requirements.txt data/config.py data/__init__.py backend/__init__.py preflight.sh
git commit -m "chore: scaffold project, config constants, workspace preflight"
```

---

## Phase 1 — Gold data layer

> Bronze field reference (verified): `locations(location_id,name,banner,neighborhood,city,market,lat,lon,h3_cell,sqft,open_date,geom)`; `foot_traffic_daily(location_id,date,dow,is_weekend,visits,unique_visitors,repeat_visitors,repeat_rate,avg_dwell_min,visits_morning,visits_afternoon,visits_evening)`; `visitor_demographics(location_id,segment_type,segment,pct_of_visitors)`; `visitor_origins(location_id,zip,zip_lat,zip_lon,distance_km,visits,visit_share)`; `cross_shopping(location_id,dest_poi_id,dest_name,dest_category,dest_type,dest_lat,dest_lon,distance_km,shared_visitors,affinity_pct,sequence)`; `nearby_pois(poi_id,name,category,poi_type,anchor_store,lat,lon,h3_cell,distance_km)`; `geo_zips(zip,cent_lon,cent_lat,area_sqmi)`.

### Task 1: Synthetic generator (pure functions)

**Files:**
- Create: `data/generate_fleet.py`
- Test: `data/tests/test_generate_fleet.py`

**Interfaces:**
- Produces (all pure, deterministic given `CLOVER_SEED`):
  - `make_fleet(real_stores: list[dict], n_synth: int = 12) -> list[dict]` — returns ~15 store dicts with keys `store_id, name, banner, format, neighborhood, city, market, lat, lon, sqft, open_date, base_traffic`. Real stores passthrough with their real ids; synthetic ids `clv_s01..`.
  - `make_daily_series(store: dict, days: int = 540) -> list[dict]` — rows `{store_id, date, dow, is_weekend, visits, unique_visitors, avg_dwell_min, visits_morning, visits_afternoon, visits_evening}`; weekend lift, daypart split summing to `visits`, no negatives.
  - `inject_drop(rows: list[dict], store_id: str, pct: float, last_n: int = 5) -> None` — mutates the last `last_n` days of `store_id` down by `pct`.
  - `make_schedule(store: dict, forecast_visits: float) -> int` — `scheduled_hours`, intentionally mis-aligned for some stores (deterministic by store index) to create over/under staffing.

- [ ] **Step 1: Write failing tests** `data/tests/test_generate_fleet.py`

```python
from data.generate_fleet import make_fleet, make_daily_series, inject_drop, make_schedule

REAL = [{"store_id":"r1","name":"Clover Back Bay","banner":"Flagship","lat":42.35,"lon":-71.08,"sqft":48000,"base_traffic":3800}]

def test_fleet_is_deterministic_and_sized():
    a = make_fleet(REAL, n_synth=12); b = make_fleet(REAL, n_synth=12)
    assert len(a) == 13
    assert [s["store_id"] for s in a] == [s["store_id"] for s in b]   # deterministic
    assert a[0]["store_id"] == "r1"                                    # real passthrough

def test_daily_series_nonneg_and_daypart_sums():
    s = make_fleet(REAL, 12)[5]
    rows = make_daily_series(s, days=60)
    assert len(rows) == 60
    assert all(r["visits"] >= 0 for r in rows)
    r = rows[0]
    assert r["visits_morning"] + r["visits_afternoon"] + r["visits_evening"] == r["visits"]

def test_inject_drop_lowers_recent():
    s = make_fleet(REAL, 12)[5]; rows = make_daily_series(s, days=30)
    before = sum(x["visits"] for x in rows[-5:])
    inject_drop(rows, s["store_id"], pct=0.2, last_n=5)
    after = sum(x["visits"] for x in rows[-5:])
    assert after < before

def test_schedule_creates_gap():
    s = make_fleet(REAL, 12)[2]
    assert make_schedule(s, forecast_visits=3300) > 0
```

- [ ] **Step 2: Run tests, verify fail** — Run: `cd ~/Desktop/Projects/clover-geospatial-app && python -m pytest data/tests/test_generate_fleet.py -v` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `data/generate_fleet.py`** using `random.Random(CLOVER_SEED)` seeded locally (never global), Greater Boston neighborhood lat/lon jitter, weekend lift factor ~1.25, daypart weights `(0.30,0.40,0.30)` with integer remainder assigned to afternoon so the split sums exactly to `visits`. `make_schedule` returns `round(forecast_visits/TARGET_VISITS_PER_HOUR)` adjusted by a deterministic per-index bias in `{-12,-6,0,+6,+10}` so the fleet shows a mix of staffing states.

- [ ] **Step 4: Run tests, verify pass** — Run: same pytest command — Expected: 4 passed.

- [ ] **Step 5: Commit** — `git add data/generate_fleet.py data/tests/test_generate_fleet.py && git commit -m "feat(data): deterministic synthetic fleet + daily series generator"`

### Task 2: Load synthetic rows + build gold base tables

**Files:**
- Create: `data/load_gold.py` (orchestrator: reads bronze real stores via warehouse, generates synth, writes `gold.locations`, `gold.foot_traffic_daily`, `gold.labor_schedule`), `backend/db.py` (shared query helper)
- Test: `data/tests/test_gold_contract.py` (integration)

**Interfaces:**
- Produces: `backend/db.py` → `run_sql(statement: str, profile: str | None = None) -> list[dict]` (uses `databricks-sql-connector` with warehouse from `DATABRICKS_WAREHOUSE_ID` or first available via SDK; returns list of row dicts) and `exec_sql(statement: str)` (no result). Consumed by all later DB tasks.
- Produces gold tables: `gold.locations`, `gold.foot_traffic_daily`, `gold.labor_schedule`.

- [ ] **Step 1: Write `backend/db.py`** with `run_sql`/`exec_sql` using `databricks.sdk.WorkspaceClient` to resolve the warehouse and `databricks-sql-connector` for execution; connection params from env with profile fallback for local runs.

- [ ] **Step 2: Write failing integration test** `data/tests/test_gold_contract.py`

```python
import pytest
from backend.db import run_sql
from data.config import GOLD

pytestmark = pytest.mark.integration

def test_locations_count_and_columns():
    rows = run_sql(f"SELECT * FROM {GOLD}.locations")
    assert len(rows) >= 13
    need = {"store_id","name","format","lat","lon","sqft","base_traffic"}
    assert need.issubset(rows[0].keys())

def test_daily_has_all_stores():
    n = run_sql(f"SELECT count(distinct store_id) c FROM {GOLD}.foot_traffic_daily")[0]["c"]
    assert n >= 13
```

- [ ] **Step 3: Run, verify fail** — Run: `python -m pytest data/tests/test_gold_contract.py -v -m integration` — Expected: FAIL (table not found).

- [ ] **Step 4: Implement `data/load_gold.py`** — `CREATE SCHEMA IF NOT EXISTS gold`; pull the 3 real stores from `bronze.locations` (map `location_id->store_id`, `lon->lon`, derive `format` from `banner`, set `base_traffic` from recent `foot_traffic_daily` avg); call generator; write tables via `CREATE OR REPLACE TABLE ... AS SELECT * FROM VALUES (...)` batched, or stage a temp view and insert. Map real foot-traffic from `bronze.foot_traffic_daily` into `gold.foot_traffic_daily` and append generated rows for synth stores. Add `days_ago = datediff(current_date(), date)` and `capture_rate` (= `unique_visitors/nullif(visits,0)`) columns to match the design contract.

- [ ] **Step 5: Run loader** — Run: `python -m data.load_gold` — Expected: prints row counts written.

- [ ] **Step 6: Run integration test, verify pass** — Run: `python -m pytest data/tests/test_gold_contract.py -v -m integration` — Expected: 2 passed.

- [ ] **Step 7: Commit** — `git add backend/db.py data/load_gold.py data/tests/test_gold_contract.py && git commit -m "feat(data): load gold.locations, foot_traffic_daily, labor_schedule"`

### Task 3: Forecast + store_ops + analytic views

**Files:**
- Create: `data/build_forecast.sql`, `data/build_gold.sql`, `data/build_views.py` (runs both on the warehouse)
- Test: extend `data/tests/test_gold_contract.py`

**Interfaces:**
- Produces views/tables consumed by Genie + backend: `gold.store_forecast(store_id, forecast_visits)`, `gold.store_ops(store_id,name,format,zip,sqft,recent_visits,base_traffic,forecast_visits,scheduled_hours,ideal_hours,labor_gap,staffing_status,traffic_delta_pct,anomaly_driver,lat,lon)`, `gold.v_traffic_anomalies`, `gold.v_daypart_coverage(daypart,demand_index,coverage_index,flag)`, `gold.v_trade_areas(store_id,origin_lat,origin_lng,visitors)`, `gold.v_demographics`, `gold.v_cross_shopping(store_id,a_lat,a_lng,b_lat,b_lng,shared_visitors)`, `gold.v_nearby_pois(name,category,lat,lng,distance_mi)`.

- [ ] **Step 1: Write `data/build_forecast.sql`** using `ai_forecast` over `gold.foot_traffic_daily` aggregated to store/day, horizon 1, producing `gold.store_forecast`. Include a header comment: `-- MUST run on SQL warehouse (ai_forecast unsupported on serverless notebook compute)`.

- [ ] **Step 2: Write `data/build_gold.sql`** creating `store_ops` and the analytic views. `ideal_hours = round(forecast_visits / 165.0)`; `labor_gap = ideal_hours - scheduled_hours`; `staffing_status = CASE WHEN labor_gap >= 8 THEN 'understaffed' WHEN labor_gap <= -8 THEN 'overstaffed' ELSE 'balanced' END`; `traffic_delta_pct` = trailing-7-day mean vs prior-7-day mean from `foot_traffic_daily`; `anomaly_driver` a CASE label. `v_demographics` pivots `bronze.visitor_demographics` income/age bands and computes an income midpoint proxy; `v_nearby_pois` converts `distance_km` to `distance_mi` and maps `poi_type`.

- [ ] **Step 3: Write `data/build_views.py`** to execute both SQL files on the warehouse via `exec_sql` (split on `;`).

- [ ] **Step 4: Add failing tests** to `test_gold_contract.py`:

```python
def test_store_ops_invariants():
    rows = run_sql(f"SELECT * FROM {GOLD}.store_ops")
    assert len(rows) >= 13
    assert {"staffing_status","labor_gap","forecast_visits","traffic_delta_pct"}.issubset(rows[0].keys())
    assert all(r["staffing_status"] in ("understaffed","overstaffed","balanced") for r in rows)
    assert any(r["staffing_status"]=="understaffed" for r in rows)   # fleet has a mix

def test_anomalies_present():
    rows = run_sql(f"SELECT * FROM {GOLD}.v_traffic_anomalies")
    assert any(r["traffic_delta_pct"] < -8 for r in rows)            # injected drop shows up
```

- [ ] **Step 5: Run build then tests** — Run: `python -m data.build_views && python -m pytest data/tests/test_gold_contract.py -v -m integration` — Expected: all passed. If `ai_forecast` errors, the loader logs it and falls back to the DOW-seasonal mean view (documented in build_forecast.sql comment); tests still pass.

- [ ] **Step 6: Commit** — `git add data/build_*.sql data/build_views.py data/tests/test_gold_contract.py && git commit -m "feat(data): store_forecast (ai_forecast), store_ops + analytic views"`

---

## Phase 2 — Genie space

### Task 4: Build the Clover Store Ops Genie space

**Files:**
- Create: `genie/genie_space.json`, `genie/build_genie_space.py`

**Interfaces:**
- Produces: a Genie space id, written to `genie/.space_id` and echoed for `app.yaml`/env (`GENIE_SPACE_ID`).

- [ ] **Step 1: Write `genie/genie_space.json`** — title "Clover Store Ops", description, table list (`gold.store_ops`, `gold.foot_traffic_daily`, `gold.v_traffic_anomalies`, `gold.v_daypart_coverage`, `gold.locations`), general instructions encoding the 165 visits/labor-hour target and over/under/balanced definitions, and 6 sample SQL queries (understaffed ranking, recommended labor hours, traffic drops, daypart coverage, store drill-down, fleet staff-vs-traffic).

- [ ] **Step 2: Write `genie/build_genie_space.py`** to create-or-update the space via the Genie/Data Rooms REST API (`databricks api post`/SDK), attaching the warehouse and tables, then write the returned id to `genie/.space_id`.

- [ ] **Step 3: Run it** — Run: `python -m genie.build_genie_space` — Expected: prints the space id; `genie/.space_id` written.

- [ ] **Step 4: Smoke-test the space via Conversation API** — start a conversation asking "Which stores are understaffed for tomorrow?" and confirm a non-empty SQL attachment returns.

Run:
```bash
SID=$(cat genie/.space_id)
databricks api post /api/2.0/genie/spaces/$SID/start-conversation --profile=fe-vm-clover-spatial --json '{"content":"Which stores are understaffed for tomorrow?"}' -o json | head -c 400
```
Expected: JSON with `conversation_id` and `message_id`.

- [ ] **Step 5: Commit** — `git add genie/ && git commit -m "feat(genie): build Clover Store Ops Genie space over gold"` (do not commit `.space_id` if it should stay local; add to `.gitignore` if so — here we keep it for reproducibility).

---

## Phase 3 — Backend (FastAPI)

### Task 5: In-view analytics (pure functions)

**Files:**
- Create: `backend/analytics.py`, `backend/models.py`
- Test: `backend/tests/test_analytics.py`

**Interfaces:**
- Produces: `compute_in_view(stores, daily, demographics, bbox) -> dict` returning `{n, series[30], dailyTraffic, trafficDelta, visitors, dwell, dwellDelta, cap, capDelta, bands, ageAgg, incAgg, ageMed, kidsAgg}` (mirrors the design's `recompute()`); `in_bbox(lat,lng,bbox)->bool`. Pure, no network. `bbox = (south, west, north, east)`.

- [ ] **Step 1: Write failing tests** `backend/tests/test_analytics.py`

```python
from backend.analytics import compute_in_view, in_bbox

def test_in_bbox():
    assert in_bbox(42.36,-71.06,(42.0,-71.5,42.7,-70.5))
    assert not in_bbox(40.0,-71.06,(42.0,-71.5,42.7,-70.5))

def _fixture():
    stores=[{"store_id":"a","lat":42.36,"lon":-71.06,"base_traffic":3000},
            {"store_id":"b","lat":42.40,"lon":-71.10,"base_traffic":2000}]
    daily=[{"store_id":"a","days_ago":d,"visits":100,"avg_dwell_min":20,"capture_rate":0.3} for d in range(30)]
    demo={"a":{"age":{"18-24":10,"25-34":30,"35-44":25,"45-54":15,"55-64":12,"65+":8},
               "median_income":85000,"median_age":36,"pct_with_kids":40}}
    return stores,daily,demo

def test_empty_viewport():
    stores,daily,demo=_fixture()
    out=compute_in_view(stores,daily,demo,(10.0,10.0,11.0,11.0))
    assert out["n"]==0

def test_in_view_aggregates():
    stores,daily,demo=_fixture()
    out=compute_in_view(stores,daily,demo,(42.0,-71.5,42.7,-70.5))
    assert out["n"]==2
    assert len(out["series"])==30
    assert out["dailyTraffic"]>0
```

- [ ] **Step 2: Run, verify fail** — Run: `python -m pytest backend/tests/test_analytics.py -v` — Expected: FAIL.

- [ ] **Step 3: Implement `backend/analytics.py`** porting the design's `recompute()` math (trailing-7 vs prior-7 deltas, traffic-weighted demographics) and `backend/models.py` pydantic models for API responses.

- [ ] **Step 4: Run, verify pass** — Expected: 4 passed.

- [ ] **Step 5: Commit** — `git add backend/analytics.py backend/models.py backend/tests/test_analytics.py && git commit -m "feat(api): pure in-view analytics computation"`

### Task 6: Layer queries + data contract

**Files:**
- Create: `backend/layers.py`
- Test: `backend/tests/test_layers_contract.py`

**Interfaces:**
- Consumes: `backend/db.run_sql`.
- Produces: `get_bootstrap()->dict` (`{META:{center,zoom}, layers:[...], locations:[...store_ops rows as design contract...], helpers:{byId,demoById}}`), `get_layer(name)->dict` for `name in {traffic,trade,demo,competitors,pois,cross}`. Field names match `clover-data.js` (`lng` not `lon`, `origin_lat/origin_lng`, `median_income`, `distance_mi`, etc.).

- [ ] **Step 1: Write failing contract tests** `backend/tests/test_layers_contract.py` using monkeypatched `run_sql` returning canned gold rows; assert output keys equal the design contract (e.g. store dict has `store_id,lat,lng,recent_visits,staffing_status,scheduled_hours,ideal_hours,forecast_visits,labor_gap,traffic_delta_pct`; trade rows have `origin_lat,origin_lng,visitors`).

- [ ] **Step 2: Run, verify fail** — Expected: FAIL.

- [ ] **Step 3: Implement `backend/layers.py`** — SQL against `gold.*`, rename `lon->lng`, build `helpers.byId`/`helpers.demoById`, convert km->mi where the contract expects miles.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit** — `git commit -am "feat(api): layer queries mapped to frontend data contract"`

### Task 7: Genie proxy + FM Action

**Files:**
- Create: `backend/genie.py`, `backend/action.py`
- Test: extend `backend/tests/test_api.py` (added in Task 8) with mocked clients

**Interfaces:**
- Produces: `ask_genie(question:str, conversation_id:str|None)->dict` (`{text, sql, columns, rows, conversation_id}`) using start-conversation / create-message + poll until status COMPLETED, extracting the `query` attachment text and reading its result rows (Genie returns `attachment.query.query` + a `statement_id`/result). `next_best_action(question, sql, rows)->str` calling `databricks-claude-sonnet-4-6` via the SDK serving client (OpenAI-compatible `chat.completions`), one short sentence framed for a store-ops manager, no em dashes.

- [ ] **Step 1: Implement `backend/genie.py`** — polling loop with timeout (config `GENIE_TIMEOUT_S=45`), graceful messages on timeout/no-SQL.

- [ ] **Step 2: Implement `backend/action.py`** — system prompt: "You are a retail store-ops advisor. Given a question and query result, reply with ONE concise next-best-action sentence. No dashes."; `max_tokens` small; on failure return a templated fallback line.

- [ ] **Step 3: Quick live smoke (manual)** — a `if __name__=='__main__'` block in each that runs one real call and prints the result.

Run: `python -m backend.genie` and `python -m backend.action` — Expected: prints a SQL+rows payload and a one-line action.

- [ ] **Step 4: Commit** — `git add backend/genie.py backend/action.py && git commit -m "feat(api): Genie conversation proxy + FM next-best-action"`

### Task 8: FastAPI routes

**Files:**
- Create: `backend/main.py`
- Test: `backend/tests/test_api.py`

**Interfaces:**
- Routes: `GET /api/bootstrap`, `GET /api/layers/{name}`, `POST /api/analytics` (body `{bbox:[s,w,n,e]}`), `POST /api/genie/ask` (`{question, conversation_id?}`), `POST /api/action` (`{question, sql, rows}`), `GET /healthz`. Serves built frontend from `frontend/dist` at `/`.

- [ ] **Step 1: Write failing route tests** `backend/tests/test_api.py` with `fastapi.testclient.TestClient`, monkeypatching `layers`, `analytics`, `genie`, `action`. Assert 200 + response shape for each route; `/api/analytics` returns `n` for a bbox; `/api/genie/ask` returns `sql`+`rows`.

- [ ] **Step 2: Run, verify fail** — Expected: FAIL (no app).

- [ ] **Step 3: Implement `backend/main.py`** wiring routes to the modules; mount static `frontend/dist`; CORS for local dev.

- [ ] **Step 4: Run, verify pass** — Run: `python -m pytest backend/tests -v` — Expected: all passed.

- [ ] **Step 5: Run server locally + curl** — Run: `uvicorn backend.main:app --reload --port 8000` then `curl -s localhost:8000/api/bootstrap | head -c 300` and `curl -s -XPOST localhost:8000/api/analytics -d '{"bbox":[42.0,-71.5,42.7,-70.5]}' -H 'content-type: application/json'`. Expected: JSON with stores / `n>0`.

- [ ] **Step 6: Commit** — `git add backend/main.py backend/tests/test_api.py && git commit -m "feat(api): FastAPI routes + static hosting"`

---

## Phase 4 — Frontend (React + Leaflet port)

> Source of truth for markup/styles: the approved `Clover Geospatial App.dc.html` (design project `2b886d31-...`, files `Clover Geospatial App.dc.html`, `support.js`, `_ds/.../colors_and_type.css`, `assets/*.svg`). Port its DOM/styles verbatim; replace `clover-data.js` + `DCLogic` runtime with React state + `/api` calls. Frontend validation is by build + dev-server + browser checks (via the `fe-specialized-agents:web-devloop-tester` agent), not unit tests.

### Task 9: Vite scaffold + DuBois styles + static shell

**Files:**
- Create: `frontend/package.json`, `frontend/vite.config.js`, `frontend/index.html`, `frontend/src/main.jsx`, `frontend/src/App.jsx`, `frontend/src/styles/dubois.css`
- Pull: copy `colors_and_type.css` tokens and the 3 SVG assets from the design project into `frontend/public/assets/`.

- [ ] **Step 1: `npm create vite@latest` (React, JS)** structure; add Leaflet + leaflet.heat deps; `vite.config.js` proxies `/api -> http://localhost:8000`.
- [ ] **Step 2: Copy DuBois tokens** into `dubois.css`; copy `databricks-logo-white.svg`, `genie-icon-full-color.svg` into `public/assets/`.
- [ ] **Step 3: Port the static shell** (top bar, left rail, map column, right rail) into `App.jsx` from the design DOM, with placeholder data.
- [ ] **Step 4: Verify render** — Run: `cd frontend && npm install && npm run dev`; use web-devloop-tester to confirm the shell renders with no console errors at 1440x900.
- [ ] **Step 5: Commit** — `git add frontend && git commit -m "feat(ui): vite scaffold, DuBois styles, static cockpit shell"`

### Task 10: Map + layers + in-view recompute

**Files:**
- Create: `frontend/src/map.js`, `frontend/src/api.js`
- Modify: `frontend/src/App.jsx`

**Interfaces:**
- Consumes: `GET /api/bootstrap`, `GET /api/layers/{name}`.
- Produces: `initMap`, `buildStores/Traffic/Trade/Demo/Competitors/Pois/Cross`, `applyLayers`, `recompute` ported from the design; pin color modes staffing/format/traffic; `map.on('moveend', recompute)` updates the left-rail KPIs.

- [ ] **Step 1: `api.js`** fetch wrappers for bootstrap/layers/analytics/genie/action.
- [ ] **Step 2: Port `map.js`** from the design's component methods, sourcing data from `api.js` instead of `clover-data.js`. Recompute runs client-side over loaded layer data.
- [ ] **Step 3: Wire layer toggles + analytics panel** in `App.jsx` to map state.
- [ ] **Step 4: Verify** — web-devloop-tester: toggle each layer, pan/zoom and confirm KPI tiles + demographics update to the in-view set; click a store and confirm fly-to + drill-down card. No console errors.
- [ ] **Step 5: Commit** — `git commit -am "feat(ui): leaflet map, layer toggles, in-view analytics recompute"`

### Task 11: Ask Genie panel (live)

**Files:**
- Create: `frontend/src/geniePanel.jsx`
- Modify: `frontend/src/App.jsx`

**Interfaces:**
- Consumes: `POST /api/genie/ask`, `POST /api/action`.
- Produces: message list rendering text → navy SQL block → results table → ⚡Action callout; suggestion chips; input box; "Genie is analyzing…" typing state; conversation_id threaded across turns; "Ask Genie how to staff this store" from the drill-down seeds a question.

- [ ] **Step 1: Port the panel markup** from the design (`g.hasSql`/`g.hasTable`/`g.hasCallout` branches) into `geniePanel.jsx`.
- [ ] **Step 2: Wire send/chip** → `ask_genie` then `next_best_action`; render real SQL + rows; render the returned action line in the callout.
- [ ] **Step 3: Verify** — web-devloop-tester: ask "Which stores are understaffed for tomorrow?" and a chip; confirm SQL block, table, and ⚡Action render from live calls; confirm graceful message on a nonsense free-text question.
- [ ] **Step 4: Commit** — `git commit -am "feat(ui): live Ask Genie panel with SQL, table, FM action"`

---

## Phase 5 — Package and deploy

### Task 12: app.yaml + resources + deploy

**Files:**
- Create: `app.yaml`, `README.md`
- Modify: `backend/main.py` (serve `frontend/dist`)

**Interfaces:**
- Produces: a deployed Databricks App on `fe-vm-clover-spatial`.

- [ ] **Step 1: Build frontend** — Run: `cd frontend && npm run build` — Expected: `frontend/dist` created.
- [ ] **Step 2: Write `app.yaml`** — command `uvicorn backend.main:app --host 0.0.0.0 --port 8000`; `env` for `GOLD_SCHEMA`, `GENIE_SPACE_ID`, `SERVING_ENDPOINT`, `DATABRICKS_WAREHOUSE_ID`; `resources` block requesting the SQL warehouse, the Genie space, and the `databricks-claude-sonnet-4-6` serving endpoint (CAN_QUERY) for the app service principal. (Per memory: grant resources via `apps update --json` then redeploy if `apps deploy` ignores the block.)
- [ ] **Step 3: Create + deploy app** — `databricks apps create clover-geospatial --profile=fe-vm-clover-spatial`; sync source (note: push `frontend/dist`; do NOT sync `node_modules`); `databricks apps deploy clover-geospatial --profile=fe-vm-clover-spatial`.
- [ ] **Step 4: Grant gold + bronze SELECT and Genie/endpoint access** to the app service principal; verify `/healthz` and `/api/bootstrap` on the app URL.
- [ ] **Step 5: Smoke-test deployed app** — web-devloop-tester against the app URL: map loads, layers toggle, KPIs recompute on zoom, Genie answers with SQL+table+Action.
- [ ] **Step 6: Write `README.md`** — data lineage (bronze → gold), how to rebuild gold (`python -m data.load_gold && python -m data.build_views`), how to rebuild Genie, how to redeploy.
- [ ] **Step 7: Commit** — `git add app.yaml README.md backend/main.py && git commit -m "feat: app.yaml resources, deploy, README"`

---

## Self-Review

**Spec coverage:** §1 purpose → Tasks 9-11 UI; §2 source data → Phase 1 reference block; §3 decisions → all phases; §4 architecture → Tasks 5-8,12; §5 data engineering → Tasks 1-3; §6 map/in-view → Tasks 5,10; §7 Ask Genie → Tasks 7,11; §8 Genie space → Task 4; §9 deliverables → Tasks 4,12; §11 risks → Task 0 preflight (CREATE SCHEMA, endpoint), Task 3 (ai_forecast warehouse + fallback), Task 7 (Genie latency). No gaps.

**Placeholder scan:** No TBD/TODO; each code step has concrete code or a concrete command. Frontend port references the design file as verbatim source (acceptable: pasting 55KB of markup per step would be noise; the file is committed in the design project and named explicitly).

**Type consistency:** `run_sql`/`exec_sql` (Task 2) used consistently in Tasks 3,6,7. `compute_in_view`/`in_bbox` (Task 5) used in Task 8. `ask_genie`/`next_best_action` (Task 7) used in Tasks 8,11. Data-contract field names (`store_id,lat,lng,recent_visits,staffing_status,scheduled_hours,ideal_hours,forecast_visits,labor_gap,traffic_delta_pct`) consistent across Tasks 2,3,6 and the design contract.
