# Task 2 Report: Gold Base Tables

**Status:** COMPLETE

## Files Created

- `backend/db.py` - Shared SQL helper using Databricks SDK Statement Execution API
- `data/load_gold.py` - Gold layer loader (idempotent, CREATE OR REPLACE TABLE)
- `data/tests/test_gold_contract.py` - Integration test (2 assertions)
- `pytest.ini` - Registers `integration` marker

## Failing Test Output (before loader ran)

```
============================= test session starts ==============================
platform darwin -- Python 3.11.11, pytest-9.0.2, pluggy-1.6.0
configfile: pytest.ini
collected 2 items

data/tests/test_gold_contract.py::test_locations_count_and_columns FAILED [ 50%]
data/tests/test_gold_contract.py::test_daily_has_all_stores FAILED       [100%]

FAILED - RuntimeError: SQL statement failed: [TABLE_OR_VIEW_NOT_FOUND]
The table or view `clover_spatial_catalog`.`gold`.`locations` cannot be found.

FAILED - RuntimeError: SQL statement failed: [TABLE_OR_VIEW_NOT_FOUND]
The table or view `clover_spatial_catalog`.`gold`.`foot_traffic_daily` cannot be found.

2 failed in 7.42s
```

## Loader Output (python -m data.load_gold)

```
=== Clover Gold Loader ===
[schema] clover_spatial_catalog.gold ready
[bronze] loaded 3 real stores with base_traffic: CLV-001=1117, CLV-002=468, CLV-003=634
[fleet] 15 stores total (3 real, 12 synthetic)
[gold.locations] 15 rows written
[inject_drop] anomalies injected into clv_s01 and clv_s03
[gold.foot_traffic_daily] 8073 rows written (1593 real + 6480 synthetic)
[gold.labor_schedule] 15 rows written
=== Done ===
```

## Passing Test Output

```
============================= test session starts ==============================
platform darwin -- Python 3.11.11, pytest-9.0.2, pluggy-1.6.0
configfile: pytest.ini
collected 2 items

data/tests/test_gold_contract.py::test_locations_count_and_columns PASSED [ 50%]
data/tests/test_gold_contract.py::test_daily_has_all_stores PASSED       [100%]

2 passed in 6.84s
```

## Row Counts

| Table | Rows |
|---|---|
| gold.locations | 15 (3 real + 12 synthetic) |
| gold.foot_traffic_daily | 8073 (1593 real + 6480 synthetic) |
| gold.labor_schedule | 15 (one row per store, anchored to REFERENCE_DATE) |

## Commit

- SHA: `cccbbc7`
- Message: `feat(data): load gold.locations, foot_traffic_daily, labor_schedule`

## Implementation Notes

- `backend/db.py` uses the Statement Execution API exclusively (no sql-connector). Auth: profile-based locally via `DATABRICKS_CONFIG_PROFILE` env var (default `fe-vm-clover-spatial`); falls back to default credential chain (injected env vars) when `DATABRICKS_HOST` + `DATABRICKS_TOKEN` are both present (Databricks App runtime).
- `_TYPE_CASTERS` maps manifest column type names to Python types so numeric columns are returned as int/float, not strings.
- Real store `days_ago` and `capture_rate` are computed inside the bronze SQL query using `datediff(current_date(), CAST(date AS DATE))` and `unique_visitors / NULLIF(visits, 0)`. Synthetic rows compute `days_ago` using `REFERENCE_DATE - row_date` (deterministic, no wall clock).
- Anomaly injection targets `clv_s01` (40% drop) and `clv_s03` (25% drop) - deterministic choice by index.
- `gold.labor_schedule` contains one row per store anchored to REFERENCE_DATE (2026-06-24), using the store's final synthetic daily visit count as the forecast input.
- All table DDL uses `CREATE OR REPLACE TABLE` for full idempotency.

## Concerns

None. All operations succeeded on first run against the live workspace.

---

# Task 2 Review Fix Report

**Status:** COMPLETE

## Changes Made

### backend/db.py

- `_client()`: Added `profile: str | None = None` parameter. When profile is supplied, returns `WorkspaceClient(profile=profile)` immediately (takes precedence over env). Otherwise falls back to existing env-var logic (host+token check, then `DATABRICKS_CONFIG_PROFILE`).
- `run_sql(statement, profile=None)`: Added optional `profile` parameter; threads it through to `_client(profile)`.
- `exec_sql(statement, profile=None)`: Same. Both default to `None` so existing call sites are unaffected.

### data/load_gold.py

- Removed dead function `_build_gold_ftd_row` (was never called; rows are built inline in `write_foot_traffic`).
- Removed dead variable `real_id_map` (identity mapping `{s["store_id"]: s["store_id"]}` that was never read).
- `write_labor_schedule`: Replaced fragile append-order `latest_visits` accumulation with explicit `max(rows, key=lambda r: r["date"])["visits"]` grouped by store. Existing `base_traffic` fallback preserved.
- Hoisted `from datetime import date as _date` out of the loop body in `write_foot_traffic` up to module-level imports (was inside the `for store in synth_stores` loop). The alias `_date` is used consistently throughout.

## Loader Output (python -m data.load_gold)

```
=== Clover Gold Loader ===
[schema] clover_spatial_catalog.gold ready
[bronze] loaded 3 real stores with base_traffic: CLV-001=1117, CLV-002=468, CLV-003=634
[fleet] 15 stores total (3 real, 12 synthetic)
[gold.locations] 15 rows written
[inject_drop] anomalies injected into clv_s01 and clv_s03
[gold.foot_traffic_daily] 8073 rows written (1593 real + 6480 synthetic)
[gold.labor_schedule] 15 rows written
=== Done ===
```

## Test Output

Command: `python -m pytest data/tests/test_gold_contract.py -v -m integration`

```
============================= test session starts ==============================
platform darwin -- Python 3.11.11, pytest-9.0.2, pluggy-1.6.0 -- /Users/jonathan.whiteley/bin/python
cachedir: .pytest_cache
rootdir: /Users/jonathan.whiteley/Desktop/Projects/clover-geospatial-app
configfile: pytest.ini
plugins: anyio-4.10.0, dash-2.18.2, pluggy-1.6.0
collecting ... collected 2 items

data/tests/test_gold_contract.py::test_locations_count_and_columns PASSED [ 50%]
data/tests/test_gold_contract.py::test_daily_has_all_stores PASSED       [100%]

============================== 2 passed in 6.56s ===============================
```

## Row Counts (unchanged)

| Table | Rows |
|---|---|
| gold.locations | 15 (3 real + 12 synthetic) |
| gold.foot_traffic_daily | 8073 (1593 real + 6480 synthetic) |
| gold.labor_schedule | 15 (one row per store) |

## Concerns

None.
