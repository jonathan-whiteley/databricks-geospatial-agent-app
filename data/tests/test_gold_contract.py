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
