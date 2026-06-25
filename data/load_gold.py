"""
Gold layer loader for the Clover geospatial app.

Reads the 3 real store records from bronze, calls the synthetic fleet generator,
and writes gold.locations, gold.foot_traffic_daily, and gold.labor_schedule.

All CREATE OR REPLACE TABLE statements make this loader fully idempotent.

Run from project root:
    python -m data.load_gold
"""

from __future__ import annotations

import sys

from data.config import CATALOG, BRONZE, GOLD, GOLD_SCHEMA
from data.generate_fleet import (
    make_fleet,
    make_daily_series,
    make_schedule,
    inject_drop,
    REFERENCE_DATE,
)
from backend.db import run_sql, exec_sql


# ── helpers ────────────────────────────────────────────────────────────────────

def _esc(v: object) -> str:
    """Escape a Python value to a SQL literal."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return repr(v)
    # String: escape single quotes and wrap.
    return "'" + str(v).replace("'", "''") + "'"


def _batch_insert(table: str, rows: list[dict], batch_size: int = 400) -> None:
    """
    INSERT rows into table in batches of batch_size rows per statement.

    Assumes the table already exists and its column order matches the dict keys
    in the first row.
    """
    if not rows:
        return
    cols = list(rows[0].keys())
    col_list = ", ".join(cols)

    for start in range(0, len(rows), batch_size):
        chunk = rows[start : start + batch_size]
        value_tuples = []
        for row in chunk:
            vals = ", ".join(_esc(row[col]) for col in cols)
            value_tuples.append(f"({vals})")
        values_sql = ",\n  ".join(value_tuples)
        exec_sql(f"INSERT INTO {table} ({col_list}) VALUES\n  {values_sql}")


# ── Step 1: ensure gold schema exists ─────────────────────────────────────────

def ensure_schema() -> None:
    exec_sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{GOLD_SCHEMA}")
    print(f"[schema] {CATALOG}.{GOLD_SCHEMA} ready")


# ── Step 2: read real stores from bronze ──────────────────────────────────────

def load_real_stores() -> list[dict]:
    """
    Pull the 3 real stores from bronze.locations and enrich with base_traffic
    (mean daily visits over the most recent 90 days from bronze.foot_traffic_daily).

    Returns a list of dicts with the keys expected by make_fleet:
        store_id, name, banner, format, neighborhood, city, market,
        lat, lon, sqft, open_date, base_traffic
    """
    # Derive format from banner: "Flagship" banner -> "Flagship", everything else "Standard".
    loc_rows = run_sql(f"""
        SELECT
            location_id,
            name,
            banner,
            CASE WHEN banner = 'Flagship' THEN 'Flagship' ELSE 'Standard' END AS format,
            neighborhood,
            city,
            market,
            lat,
            lon,
            sqft,
            open_date
        FROM {BRONZE}.locations
        ORDER BY location_id
    """)

    traffic_rows = run_sql(f"""
        SELECT
            location_id,
            CAST(ROUND(AVG(visits)) AS INT) AS base_traffic
        FROM {BRONZE}.foot_traffic_daily
        WHERE date >= date_sub(current_date(), 90)
        GROUP BY location_id
    """)

    traffic_map = {r["location_id"]: r["base_traffic"] for r in traffic_rows}

    stores = []
    for r in loc_rows:
        stores.append({
            "store_id":     r["location_id"],
            "name":         r["name"],
            "banner":       r["banner"],
            "format":       r["format"],
            "neighborhood": r["neighborhood"],
            "city":         r["city"],
            "market":       r["market"],
            "lat":          r["lat"],
            "lon":          r["lon"],
            "sqft":         r["sqft"],
            "open_date":    r["open_date"],
            "base_traffic": traffic_map.get(r["location_id"], 0),
        })

    print(f"[bronze] loaded {len(stores)} real stores with base_traffic: "
          + ", ".join(f"{s['store_id']}={s['base_traffic']}" for s in stores))
    return stores


# ── Step 3: build and write gold.locations ─────────────────────────────────────

def write_locations(fleet: list[dict]) -> None:
    exec_sql(f"""
        CREATE OR REPLACE TABLE {GOLD}.locations (
            store_id      STRING  NOT NULL,
            name          STRING,
            banner        STRING,
            format        STRING,
            neighborhood  STRING,
            city          STRING,
            market        STRING,
            lat           DOUBLE,
            lon           DOUBLE,
            sqft          INT,
            open_date     STRING,
            base_traffic  INT
        )
    """)

    rows = [
        {
            "store_id":     s["store_id"],
            "name":         s["name"],
            "banner":       s["banner"],
            "format":       s["format"],
            "neighborhood": s["neighborhood"],
            "city":         s["city"],
            "market":       s["market"],
            "lat":          s["lat"],
            "lon":          s["lon"],
            "sqft":         int(s["sqft"]),
            "open_date":    s["open_date"],
            "base_traffic": int(s["base_traffic"]),
        }
        for s in fleet
    ]

    _batch_insert(f"{GOLD}.locations", rows)
    count = run_sql(f"SELECT COUNT(*) c FROM {GOLD}.locations")[0]["c"]
    print(f"[gold.locations] {count} rows written")


# ── Step 4: read real bronze FTD rows and generate synthetic rows ──────────────

def _build_gold_ftd_row(store_id: str, r: dict) -> dict:
    """Convert a bronze or generated daily row into a gold foot_traffic_daily row."""
    visits = r.get("visits", 0) or 0
    unique_visitors = r.get("unique_visitors", 0) or 0
    capture_rate = (unique_visitors / visits) if visits else None
    return {
        "store_id":         store_id,
        "date":             r["date"],
        "dow":              int(r["dow"]),
        "is_weekend":       bool(r["is_weekend"]),
        "visits":           int(visits),
        "unique_visitors":  int(unique_visitors),
        "avg_dwell_min":    float(r["avg_dwell_min"]),
        "visits_morning":   int(r.get("visits_morning", 0) or 0),
        "visits_afternoon": int(r.get("visits_afternoon", 0) or 0),
        "visits_evening":   int(r.get("visits_evening", 0) or 0),
        "capture_rate":     round(capture_rate, 4) if capture_rate is not None else None,
    }


def write_foot_traffic(real_stores: list[dict], synth_stores: list[dict]) -> None:
    exec_sql(f"""
        CREATE OR REPLACE TABLE {GOLD}.foot_traffic_daily (
            store_id         STRING  NOT NULL,
            date             STRING  NOT NULL,
            dow              INT,
            is_weekend       BOOLEAN,
            visits           INT,
            unique_visitors  INT,
            avg_dwell_min    DOUBLE,
            visits_morning   INT,
            visits_afternoon INT,
            visits_evening   INT,
            days_ago         INT,
            capture_rate     DOUBLE
        )
    """)

    # Real store rows: copy from bronze (map location_id to store_id).
    real_id_map = {s["store_id"]: s["store_id"] for s in real_stores}
    # store_id in real_stores == location_id from bronze (we mapped it in load_real_stores).
    real_ids_sql = ", ".join(_esc(s["store_id"]) for s in real_stores)

    bronze_rows = run_sql(f"""
        SELECT
            location_id AS store_id,
            date,
            dow,
            is_weekend,
            visits,
            unique_visitors,
            avg_dwell_min,
            visits_morning,
            visits_afternoon,
            visits_evening,
            datediff(current_date(), CAST(date AS DATE)) AS days_ago,
            unique_visitors / NULLIF(visits, 0) AS capture_rate
        FROM {BRONZE}.foot_traffic_daily
        WHERE location_id IN ({real_ids_sql})
        ORDER BY location_id, date
    """)

    # Build real gold rows from the enriched bronze query (days_ago and capture_rate already computed).
    real_gold_rows = []
    for r in bronze_rows:
        real_gold_rows.append({
            "store_id":         r["store_id"],
            "date":             r["date"],
            "dow":              int(r["dow"]),
            "is_weekend":       bool(r["is_weekend"]),
            "visits":           int(r["visits"]) if r["visits"] is not None else 0,
            "unique_visitors":  int(r["unique_visitors"]) if r["unique_visitors"] is not None else 0,
            "avg_dwell_min":    float(r["avg_dwell_min"]) if r["avg_dwell_min"] is not None else 0.0,
            "visits_morning":   int(r["visits_morning"]) if r["visits_morning"] is not None else 0,
            "visits_afternoon": int(r["visits_afternoon"]) if r["visits_afternoon"] is not None else 0,
            "visits_evening":   int(r["visits_evening"]) if r["visits_evening"] is not None else 0,
            "days_ago":         int(r["days_ago"]) if r["days_ago"] is not None else None,
            "capture_rate":     float(r["capture_rate"]) if r["capture_rate"] is not None else None,
        })

    # Synthetic store rows: generate via make_daily_series and compute days_ago.
    synth_gold_rows = []
    for store in synth_stores:
        daily = make_daily_series(store)
        for r in daily:
            visits = r["visits"] or 0
            unique_visitors = r["unique_visitors"] or 0
            capture_rate = (unique_visitors / visits) if visits else None
            from datetime import date as _date
            row_date = _date.fromisoformat(r["date"])
            days_ago_val = (REFERENCE_DATE - row_date).days
            synth_gold_rows.append({
                "store_id":         r["store_id"],
                "date":             r["date"],
                "dow":              int(r["dow"]),
                "is_weekend":       bool(r["is_weekend"]),
                "visits":           int(visits),
                "unique_visitors":  int(unique_visitors),
                "avg_dwell_min":    float(r["avg_dwell_min"]),
                "visits_morning":   int(r["visits_morning"]),
                "visits_afternoon": int(r["visits_afternoon"]),
                "visits_evening":   int(r["visits_evening"]),
                "days_ago":         days_ago_val,
                "capture_rate":     round(capture_rate, 4) if capture_rate is not None else None,
            })

    all_rows = real_gold_rows + synth_gold_rows
    _batch_insert(f"{GOLD}.foot_traffic_daily", all_rows)

    count = run_sql(f"SELECT COUNT(*) c FROM {GOLD}.foot_traffic_daily")[0]["c"]
    print(f"[gold.foot_traffic_daily] {count} rows written "
          f"({len(real_gold_rows)} real + {len(synth_gold_rows)} synthetic)")


# ── Step 5: write gold.labor_schedule ─────────────────────────────────────────

def write_labor_schedule(fleet: list[dict], daily_all: list[dict]) -> None:
    """
    Build a daily labor schedule for each store using make_schedule.

    forecast_visits is the store's most recent visit count in the daily series.
    """
    exec_sql(f"""
        CREATE OR REPLACE TABLE {GOLD}.labor_schedule (
            store_id          STRING  NOT NULL,
            date              STRING  NOT NULL,
            forecast_visits   INT,
            scheduled_hours   INT
        )
    """)

    # Build a lookup: store_id -> most recent visits for scheduling.
    latest_visits: dict[str, int] = {}
    for row in daily_all:
        sid = row["store_id"]
        if sid not in latest_visits:
            latest_visits[sid] = row["visits"]
        else:
            # Keep largest date by relying on append order (latest appended last).
            latest_visits[sid] = row["visits"]

    store_map = {s["store_id"]: s for s in fleet}

    schedule_rows = []
    for sid, store in store_map.items():
        forecast = latest_visits.get(sid, store.get("base_traffic", 1000))
        hours = make_schedule(store, forecast)
        schedule_rows.append({
            "store_id":        sid,
            "date":            REFERENCE_DATE.isoformat(),
            "forecast_visits": int(forecast),
            "scheduled_hours": int(hours),
        })

    _batch_insert(f"{GOLD}.labor_schedule", schedule_rows)
    count = run_sql(f"SELECT COUNT(*) c FROM {GOLD}.labor_schedule")[0]["c"]
    print(f"[gold.labor_schedule] {count} rows written")


# ── Entrypoint ──────────────────────────────────────────────────────────────────

def main() -> None:
    print("=== Clover Gold Loader ===")

    # Ensure schema.
    ensure_schema()

    # Load real stores.
    real_stores = load_real_stores()

    # Build full fleet (3 real + 12 synthetic).
    fleet = make_fleet(real_stores, n_synth=12)
    real_fleet = fleet[:3]
    synth_fleet = fleet[3:]
    print(f"[fleet] {len(fleet)} stores total ({len(real_fleet)} real, {len(synth_fleet)} synthetic)")

    # Write locations.
    write_locations(fleet)

    # Generate synthetic daily series and inject anomalies into 2 stores.
    synth_daily: list[dict] = []
    for store in synth_fleet:
        synth_daily.extend(make_daily_series(store))

    # Deterministic anomaly injection: always inject into synthetic stores at index 0 and 2.
    inject_drop(synth_daily, synth_fleet[0]["store_id"], pct=0.40, last_n=5)
    inject_drop(synth_daily, synth_fleet[2]["store_id"], pct=0.25, last_n=5)
    print(f"[inject_drop] anomalies injected into {synth_fleet[0]['store_id']} and {synth_fleet[2]['store_id']}")

    # Write foot traffic (real + synthetic).
    write_foot_traffic(real_stores, synth_fleet)

    # Build combined daily list for schedule (real from bronze + synthetic generated).
    # For scheduling, use only synthetic daily (real stores use bronze rows from the DB).
    # We feed all_daily to write_labor_schedule for latest-visits lookup.
    write_labor_schedule(fleet, synth_daily)

    print("=== Done ===")


if __name__ == "__main__":
    main()
