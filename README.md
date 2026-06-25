# Clover Geospatial App

A Databricks App providing geospatial store analytics for Clover Restaurant Group. It combines a FastAPI backend with a React/Leaflet frontend, served as a single deployable unit on the Databricks Apps platform.

## What the App Does

- Displays all 15 Clover store locations on an interactive Leaflet map (Boston metro area).
- Layers: store pins, trade areas, foot-traffic heatmap, competitor locations, nearby POIs, cross-shopping flow lines, visitor origin heatmap, visitor demographics.
- In-viewport KPI panel recalculates on every pan/zoom: total visits, avg dwell time, capture rate, staffing gap, labor opportunity.
- Per-store drill-down: demographics breakdown, forecast vs. actual traffic, labor gap table, schedule vs. ideal hours.
- Genie panel: natural-language analytics against the gold schema via the Databricks Genie API; responses include the generated SQL, a result table, and an AI-generated next-best action sentence.

## Architecture

```
frontend/src/      React + Leaflet (Vite build)
frontend/dist/     Compiled static bundle (gitignored; must be built before deploy)
backend/           FastAPI application
  main.py          App entry point; mounts frontend/dist as static files
  layers.py        /api/bootstrap and /api/layers/* (gold SQL queries)
  analytics.py     /api/analytics (in-viewport KPI computation)
  genie.py         /api/genie/ask (Databricks Genie proxy)
  action.py        /api/action (next-best-action via Foundation Model)
  db.py            Databricks SQL connector pool
data/
  config.py        Catalog/schema constants, env var overrides
  load_gold.py     Loads bronze CSVs into Delta bronze tables
  build_views.py   Creates gold views on top of bronze tables
  build_gold.sql   Gold materialized table DDL (alternative to views)
  build_forecast.sql  Forecast table DDL
```

## Data Lineage

```
Bronze (CSV load)                  Gold (views over bronze)
-----------------------------------------
clover_spatial_catalog.bronze      clover_spatial_catalog.gold
  locations                 -->      locations_v
  foot_traffic_daily        -->      foot_traffic_daily_v
  visitor_origins           -->      visitor_origins_v
  visitor_demographics      -->      visitor_demographics_v
  cross_shopping            -->      cross_shopping_v
  nearby_pois               -->      nearby_pois_v
  competitors               -->      competitors_v
  forecast                  -->      forecast_v
```

Gold views are owned by `jonathan.whiteley@databricks.com` and select from bronze tables in the same catalog. Unity Catalog ownership chaining means the app service principal only needs `SELECT` on the gold views, not on bronze directly.

## How to Rebuild Gold

### Step 1: Load bronze tables from CSV data

```bash
# From the project root, with fe-vm-clover-spatial profile configured
python -m data.load_gold
```

This creates `clover_spatial_catalog.bronze.*` tables from the synthetic CSV data in `data/`.

### Step 2: Build gold views

```bash
python -m data.build_views
```

This creates or replaces all views in `clover_spatial_catalog.gold.*`.

### Step 3: (Optional) Build forecast table

Run the SQL in `data/build_forecast.sql` against the warehouse, or fall back to `data/build_forecast_fallback.sql` if the AI forecasting endpoint is unavailable.

## How to Rebuild the Genie Space

1. In the Databricks workspace (`fevm-clover-spatial.cloud.databricks.com`), open AI/BI Genie.
2. Create a new space named "Clover Store Analytics".
3. Add all tables/views from `clover_spatial_catalog.gold` as data sources.
4. Add the sample questions from `genie/sample_questions.md` (or `genie/` directory).
5. Update `GENIE_SPACE_ID` in `app.yaml` and redeploy.

Current Genie space ID: `01f170a989e81c3b9d492d6e298adf8b`

## How to Build and Redeploy

### Build the frontend

```bash
cd frontend
npm install --prefer-offline --legacy-peer-deps
npm run build
cd ..
```

This produces `frontend/dist/` with a hashed JS bundle (e.g. `index-Cm9_Hi00.js`).

### IMPORTANT: dist must land in the workspace

`frontend/dist/` is in `.gitignore`. If you use `databricks sync`, the dist directory will be silently skipped. You MUST use `databricks workspace import-dir` from a staging directory that has no `.gitignore` excluding dist.

### Stage and push to workspace

```bash
# Create a clean staging directory (no .gitignore)
STAGE=$(mktemp -d)
cp app.yaml "$STAGE/"
cp requirements.txt "$STAGE/"
rsync -a --exclude='__pycache__' --exclude='*.pyc' --exclude='tests/' backend/ "$STAGE/backend/"
rsync -a --exclude='__pycache__' --exclude='*.pyc' --exclude='tests/' data/ "$STAGE/data/"
rsync -a frontend/dist/ "$STAGE/frontend/dist/"

WORKSPACE_PATH="/Workspace/Users/jonathan.whiteley@databricks.com/clover-geospatial"
databricks workspace import-dir "$STAGE" "$WORKSPACE_PATH" --overwrite --profile=fe-vm-clover-spatial

# Verify dist landed (check the JS hash matches your build output)
databricks workspace list "$WORKSPACE_PATH/frontend/dist/assets" --profile=fe-vm-clover-spatial
```

Do NOT include `frontend/node_modules`, `frontend/package.json`, or `frontend/src` in the deployed bundle. The Databricks Apps build container auto-detects `package.json` and runs `npm install`, timing out the 10-minute start deadline.

### Attach resources and deploy

Resources must be applied via `apps update` BEFORE deploying; `apps deploy` does not apply the `resources:` block in `app.yaml`.

```bash
# Attach resources (grants SP access to warehouse and serving endpoint)
databricks apps update clover-geospatial \
  --json "@resources.json" \
  --profile=fe-vm-clover-spatial

# Deploy from workspace path
databricks apps deploy clover-geospatial \
  --source-code-path "$WORKSPACE_PATH" \
  --profile=fe-vm-clover-spatial
```

### Grant Unity Catalog access (required once, or after SP changes)

The app service principal needs SELECT on gold views. Run via SQL warehouse:

```sql
GRANT USE CATALOG ON CATALOG clover_spatial_catalog
  TO `<app-sp-client-id>`;

GRANT USE SCHEMA ON SCHEMA clover_spatial_catalog.gold
  TO `<app-sp-client-id>`;

GRANT SELECT ON ALL TABLES IN SCHEMA clover_spatial_catalog.gold
  TO `<app-sp-client-id>`;
```

The current app SP client ID is `dd2d2435-1f48-45a5-9dac-399848bd4d3a`.

NOTE: These grants require either metastore admin rights or ownership of `clover_spatial_catalog`. The catalog is currently owned by SP `aec5be3d-de3c-404c-8e60-feed0f265fd3`. A workspace/metastore admin must run these grants.

## Environment Variables

| Variable | Value | Source |
|---|---|---|
| `DATABRICKS_WAREHOUSE_ID` | `f8b3878560d8debf` | app.yaml static value |
| `GENIE_SPACE_ID` | `01f170a989e81c3b9d492d6e298adf8b` | app.yaml static value |
| `SERVING_ENDPOINT` | `databricks-claude-sonnet-4-6` | app.yaml static value |
| `GOLD_SCHEMA` | `gold` | app.yaml static value |
| `DATABRICKS_HOST` | auto-injected | Databricks Apps runtime |
| `DATABRICKS_CLIENT_ID` | auto-injected | Databricks Apps runtime |
| `DATABRICKS_CLIENT_SECRET` | auto-injected | Databricks Apps runtime |

## App URL

`https://clover-geospatial-7474649060313829.aws.databricksapps.com`
