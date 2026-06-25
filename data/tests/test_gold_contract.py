import pytest
from backend.db import run_sql
from data.config import GOLD

pytestmark = pytest.mark.integration


def test_locations_count_and_columns():
    rows = run_sql(f"SELECT * FROM {GOLD}.locations")
    assert len(rows) >= 13
    need = {"store_id", "name", "format", "lat", "lon", "sqft", "base_traffic"}
    assert need.issubset(rows[0].keys())


def test_daily_has_all_stores():
    n = run_sql(f"SELECT count(distinct store_id) c FROM {GOLD}.foot_traffic_daily")[0]["c"]
    assert n >= 13


def test_store_ops_invariants():
    rows = run_sql(f"SELECT * FROM {GOLD}.store_ops")
    assert len(rows) >= 13
    assert {"staffing_status", "labor_gap", "forecast_visits", "traffic_delta_pct"}.issubset(rows[0].keys())
    assert all(r["staffing_status"] in ("understaffed", "overstaffed", "balanced") for r in rows)
    assert any(r["staffing_status"] == "understaffed" for r in rows)   # fleet has a mix


def test_anomalies_present():
    rows = run_sql(f"SELECT * FROM {GOLD}.v_traffic_anomalies")
    assert any(r["traffic_delta_pct"] < -8 for r in rows)            # injected drop shows up
