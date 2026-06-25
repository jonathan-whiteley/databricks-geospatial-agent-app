"""
Contract tests for backend/layers.py.

These tests monkeypatch backend.layers.run_sql to return canned gold rows
and assert that get_bootstrap() and get_layer() produce dicts whose keys
exactly match the frontend data contract (clover-data.js field names).

No network calls are made.
"""
from __future__ import annotations

import pytest

# ---------------------------------------------------------------------------
# Canned gold rows (minimal, but with all contract-relevant columns)
# ---------------------------------------------------------------------------

_STORE_OPS_ROWS = [
    {
        "store_id": "clv_s01",
        "name": "Clover Harvard Square",
        "format": "Standard",
        "zip": "02138",
        "sqft": 2400,
        "recent_visits": 820,
        "base_traffic": 900,
        "forecast_visits": 950,
        "scheduled_hours": 48,
        "ideal_hours": 56,
        "labor_gap": 8,
        "staffing_status": "understaffed",
        "traffic_delta_pct": -41.0,
        "anomaly_driver": "traffic_drop_40pct",
        "lat": 42.3736,
        "lon": -71.1190,
    },
    {
        "store_id": "clv_s02",
        "name": "Clover Kendall",
        "format": "Flagship",
        "zip": "02142",
        "sqft": 3800,
        "recent_visits": 1200,
        "base_traffic": 1200,
        "forecast_visits": 1220,
        "scheduled_hours": 80,
        "ideal_hours": 78,
        "labor_gap": -2,
        "staffing_status": "balanced",
        "traffic_delta_pct": 2.1,
        "anomaly_driver": None,
        "lat": 42.3625,
        "lon": -71.0843,
    },
]

_FOOT_TRAFFIC_ROWS = [
    {
        "store_id": "clv_s01",
        "date": "2026-06-24",
        "days_ago": 0,
        "visits": 820,
        "unique_visitors": 700,
        "avg_dwell_min": 22,
        "capture_rate": 0.31,
        "visits_morning": 300,
        "visits_afternoon": 380,
        "visits_evening": 140,
    },
    {
        "store_id": "clv_s01",
        "date": "2026-06-23",
        "days_ago": 1,
        "visits": 810,
        "unique_visitors": 690,
        "avg_dwell_min": 21,
        "capture_rate": 0.30,
        "visits_morning": 295,
        "visits_afternoon": 375,
        "visits_evening": 140,
    },
    {
        "store_id": "clv_s02",
        "date": "2026-06-24",
        "days_ago": 0,
        "visits": 1200,
        "unique_visitors": 1100,
        "avg_dwell_min": 18,
        "capture_rate": 0.28,
        "visits_morning": 400,
        "visits_afternoon": 550,
        "visits_evening": 250,
    },
]

_DEMO_ROWS = [
    {
        "store_id": "clv_s01",
        "income_lt50k": 0.15,
        "income_50_100k": 0.35,
        "income_100_150k": 0.28,
        "income_150_200k": 0.14,
        "income_gt200k": 0.08,
        "age_18_24": 0.18,
        "age_25_34": 0.32,
        "age_35_44": 0.25,
        "age_45_54": 0.14,
        "age_55plus": 0.11,
        "median_income_proxy": 95000.0,
    },
]

_TRADE_AREA_ROWS = [
    {"store_id": "clv_s01", "origin_lat": 42.380, "origin_lng": -71.105, "visitors": 40},
    {"store_id": "clv_s01", "origin_lat": 42.360, "origin_lng": -71.130, "visitors": 25},
    {"store_id": "clv_s02", "origin_lat": 42.370, "origin_lng": -71.090, "visitors": 55},
]

_NEARBY_POIS_ROWS = [
    {"name": "Chipotle", "category": "competitor", "lat": 42.374, "lng": -71.118, "distance_mi": 0.2},
    {"name": "Whole Foods", "category": "grocery", "lat": 42.376, "lng": -71.120, "distance_mi": 0.4},
    {"name": "Starbucks", "category": "coffee", "lat": 42.372, "lng": -71.115, "distance_mi": 0.3},
]

_COMPETITOR_POI_ROWS = [
    {"name": "Chipotle", "category": "competitor", "lat": 42.374, "lng": -71.118, "distance_mi": 0.2},
]

_NON_COMPETITOR_POI_ROWS = [
    {"name": "Whole Foods", "category": "grocery", "lat": 42.376, "lng": -71.120, "distance_mi": 0.4},
    {"name": "Starbucks", "category": "coffee", "lat": 42.372, "lng": -71.115, "distance_mi": 0.3},
]

_CROSS_SHOPPING_ROWS = [
    {
        "store_id": "clv_s01",
        "a_lat": 42.3736,
        "a_lng": -71.1190,
        "b_lat": 42.374,
        "b_lng": -71.118,
        "shared_visitors": 30,
    },
    {
        "store_id": "clv_s02",
        "a_lat": 42.3625,
        "a_lng": -71.0843,
        "b_lat": 42.363,
        "b_lng": -71.085,
        "shared_visitors": 20,
    },
]


# ---------------------------------------------------------------------------
# Fixtures: monkeypatch run_sql in the layers module
# ---------------------------------------------------------------------------

def _make_run_sql_stub(table_map: dict):
    """
    Return a callable that stubs run_sql based on which gold table the SQL
    references. Matches by substring on the SQL statement.

    Special case: v_nearby_pois with a competitor WHERE predicate returns
    only competitor rows; with != competitor returns non-competitor rows.
    The table_map key 'v_nearby_pois' is used only when neither predicate
    matches (e.g. a bare select).
    """
    def _stub(sql: str, **kwargs) -> list[dict]:
        sql_lower = sql.lower()
        # Non-competitor POI query (check != before = to avoid false substring match)
        if "v_nearby_pois" in sql_lower and "!= 'competitor'" in sql_lower:
            return table_map.get("v_nearby_pois_non_competitor", [])
        # Competitor-filtered POI query
        if "v_nearby_pois" in sql_lower and "= 'competitor'" in sql_lower:
            return table_map.get("v_nearby_pois_competitor", [])
        for key, rows in table_map.items():
            if key in sql_lower:
                return rows
        return []
    return _stub


# ---------------------------------------------------------------------------
# get_bootstrap() tests
# ---------------------------------------------------------------------------

class TestBootstrapContract:

    @pytest.fixture(autouse=True)
    def patch_run_sql(self, monkeypatch):
        from backend import layers
        stub = _make_run_sql_stub({
            "store_ops": _STORE_OPS_ROWS,
            "foot_traffic_daily": _FOOT_TRAFFIC_ROWS,
            "v_demographics": _DEMO_ROWS,
        })
        monkeypatch.setattr(layers, "run_sql", stub)

    def test_bootstrap_top_level_keys(self):
        from backend.layers import get_bootstrap
        result = get_bootstrap()
        assert "META" in result
        assert "layers" in result
        assert "locations" in result
        assert "foot_traffic_daily" in result
        assert "helpers" in result

    def test_meta_shape(self):
        from backend.layers import get_bootstrap
        result = get_bootstrap()
        meta = result["META"]
        assert "center" in meta
        assert "zoom" in meta
        assert len(meta["center"]) == 2
        assert isinstance(meta["zoom"], int)

    def test_meta_values_from_config(self):
        from backend.layers import get_bootstrap
        from data.config import METRO_CENTER, METRO_ZOOM
        result = get_bootstrap()
        meta = result["META"]
        assert meta["center"] == list(METRO_CENTER)
        assert meta["zoom"] == METRO_ZOOM

    def test_layers_list_ids(self):
        """Left-rail layer descriptors must include all 7 required ids."""
        from backend.layers import get_bootstrap
        result = get_bootstrap()
        layer_ids = {lay["id"] for lay in result["layers"]}
        expected = {"stores", "traffic", "trade", "demo", "competitors", "pois", "cross"}
        assert expected.issubset(layer_ids)

    def test_locations_store_keys(self):
        """Each store dict must use lng (not lon) and have all contract fields."""
        from backend.layers import get_bootstrap
        result = get_bootstrap()
        locations = result["locations"]
        assert len(locations) == 2

        required_keys = {
            "store_id", "name", "format", "zip", "sqft",
            "lat", "lng",
            "recent_visits", "base_traffic", "forecast_visits",
            "scheduled_hours", "ideal_hours", "labor_gap",
            "staffing_status", "traffic_delta_pct", "anomaly_driver",
        }
        for store in locations:
            assert required_keys == set(store.keys()), (
                f"store {store.get('store_id')}: keys mismatch.\n"
                f"  got:      {sorted(store.keys())}\n"
                f"  expected: {sorted(required_keys)}"
            )

    def test_locations_no_lon_key(self):
        """Gold source uses lon; contract must rename to lng."""
        from backend.layers import get_bootstrap
        result = get_bootstrap()
        for store in result["locations"]:
            assert "lon" not in store, "store dict must use 'lng' not 'lon'"
            assert "lng" in store

    def test_locations_lng_value(self):
        """lng value must equal the original lon from gold."""
        from backend.layers import get_bootstrap
        result = get_bootstrap()
        by_id = {s["store_id"]: s for s in result["locations"]}
        assert by_id["clv_s01"]["lng"] == pytest.approx(-71.1190)
        assert by_id["clv_s02"]["lng"] == pytest.approx(-71.0843)

    def test_foot_traffic_daily_keys(self):
        """foot_traffic_daily rows must have exactly the contract keys."""
        from backend.layers import get_bootstrap
        result = get_bootstrap()
        rows = result["foot_traffic_daily"]
        assert len(rows) > 0
        required_keys = {"store_id", "days_ago", "visits", "avg_dwell_min", "capture_rate"}
        for row in rows:
            assert required_keys == set(row.keys()), (
                f"foot_traffic_daily row keys mismatch.\n"
                f"  got:      {sorted(row.keys())}\n"
                f"  expected: {sorted(required_keys)}"
            )

    def test_helpers_structure(self):
        """helpers must have byId and demoById dicts keyed by store_id."""
        from backend.layers import get_bootstrap
        result = get_bootstrap()
        helpers = result["helpers"]
        assert "byId" in helpers
        assert "demoById" in helpers
        assert isinstance(helpers["byId"], dict)
        assert isinstance(helpers["demoById"], dict)

    def test_helpers_byid_keyed_by_store_id(self):
        from backend.layers import get_bootstrap
        result = get_bootstrap()
        by_id = result["helpers"]["byId"]
        assert "clv_s01" in by_id
        assert "clv_s02" in by_id
        # Value should be a store dict with lng
        assert by_id["clv_s01"]["lng"] == pytest.approx(-71.1190)

    def test_helpers_demobyid_shape(self):
        """demoById must contain age bands dict, median_income, median_age, pct_with_kids."""
        from backend.layers import get_bootstrap
        result = get_bootstrap()
        demo_by_id = result["helpers"]["demoById"]
        assert "clv_s01" in demo_by_id
        demo = demo_by_id["clv_s01"]
        assert "age" in demo
        assert isinstance(demo["age"], dict)
        assert "median_income" in demo

    def test_helpers_demobyid_age_bands_present(self):
        from backend.layers import get_bootstrap
        result = get_bootstrap()
        demo = result["helpers"]["demoById"]["clv_s01"]
        age = demo["age"]
        # Must have the 5 age bands from v_demographics
        for band in ("18-24", "25-34", "35-44", "45-54", "55+"):
            assert band in age, f"age band '{band}' missing from demoById"

    def test_helpers_demobyid_income_proxy(self):
        from backend.layers import get_bootstrap
        result = get_bootstrap()
        demo = result["helpers"]["demoById"]["clv_s01"]
        # median_income should come from median_income_proxy in v_demographics
        assert demo["median_income"] == pytest.approx(95000.0)


# ---------------------------------------------------------------------------
# get_layer() tests
# ---------------------------------------------------------------------------

class TestLayerContract:

    @pytest.fixture(autouse=True)
    def patch_run_sql(self, monkeypatch):
        from backend import layers
        stub = _make_run_sql_stub({
            "v_trade_areas": _TRADE_AREA_ROWS,
            "v_demographics": _DEMO_ROWS,
            "v_nearby_pois": _NEARBY_POIS_ROWS,
            "v_nearby_pois_competitor": _COMPETITOR_POI_ROWS,
            "v_nearby_pois_non_competitor": _NON_COMPETITOR_POI_ROWS,
            "v_cross_shopping": _CROSS_SHOPPING_ROWS,
            "store_ops": _STORE_OPS_ROWS,
        })
        monkeypatch.setattr(layers, "run_sql", stub)

    # --- trade layer ---

    def test_trade_layer_keys(self):
        from backend.layers import get_layer
        result = get_layer("trade")
        assert "features" in result
        rows = result["features"]
        assert len(rows) > 0
        required = {"store_id", "origin_lat", "origin_lng", "visitors"}
        for row in rows:
            assert required == set(row.keys()), (
                f"trade row keys mismatch: {sorted(row.keys())}"
            )

    def test_trade_layer_origin_lng_not_lon(self):
        from backend.layers import get_layer
        result = get_layer("trade")
        for row in result["features"]:
            assert "origin_lon" not in row
            assert "origin_lng" in row

    # --- demo layer ---

    def test_demo_layer_keys(self):
        from backend.layers import get_layer
        result = get_layer("demo")
        assert "features" in result
        rows = result["features"]
        assert len(rows) > 0
        expected_keys = {
            "store_id",
            "age",
            "median_income",
            "median_age",
            "pct_with_kids",
            "income_lt50k",
            "income_50_100k",
            "income_100_150k",
            "income_150_200k",
            "income_gt200k",
        }
        for row in rows:
            assert set(row.keys()) == expected_keys, (
                f"demo row keys mismatch.\n"
                f"  got:      {sorted(row.keys())}\n"
                f"  expected: {sorted(expected_keys)}"
            )

    # --- competitors layer ---

    def test_competitors_layer_keys(self):
        from backend.layers import get_layer
        result = get_layer("competitors")
        assert "features" in result
        rows = result["features"]
        required = {"name", "category", "lat", "lng", "distance_mi"}
        for row in rows:
            assert required == set(row.keys()), (
                f"competitor row keys mismatch: {sorted(row.keys())}"
            )

    def test_competitors_are_competitor_category(self):
        from backend.layers import get_layer
        result = get_layer("competitors")
        for row in result["features"]:
            assert row["category"] == "competitor"

    # --- pois layer ---

    def test_pois_layer_keys(self):
        from backend.layers import get_layer
        result = get_layer("pois")
        assert "features" in result
        rows = result["features"]
        required = {"name", "category", "lat", "lng", "distance_mi"}
        for row in rows:
            assert required == set(row.keys()), (
                f"poi row keys mismatch: {sorted(row.keys())}"
            )

    def test_pois_exclude_competitors(self):
        from backend.layers import get_layer
        result = get_layer("pois")
        for row in result["features"]:
            assert row["category"] != "competitor"

    # --- cross layer ---

    def test_cross_layer_keys(self):
        from backend.layers import get_layer
        result = get_layer("cross")
        assert "features" in result
        rows = result["features"]
        assert len(rows) > 0
        required = {"a_lat", "a_lng", "b_lat", "b_lng", "shared_visitors"}
        for row in rows:
            assert required == set(row.keys()), (
                f"cross row keys mismatch: {sorted(row.keys())}"
            )

    # --- traffic layer ---

    def test_traffic_layer_keys(self):
        """Traffic layer returns list of {lat, lng, weight} for heatmap."""
        from backend.layers import get_layer
        result = get_layer("traffic")
        assert "features" in result
        rows = result["features"]
        assert len(rows) > 0
        required = {"lat", "lng", "weight"}
        for row in rows:
            assert required == set(row.keys()), (
                f"traffic row keys mismatch: {sorted(row.keys())}"
            )

    def test_traffic_weights_positive(self):
        from backend.layers import get_layer
        result = get_layer("traffic")
        for row in result["features"]:
            assert row["weight"] > 0

    # --- stores layer ---

    def test_stores_layer_keys(self):
        """Stores layer features must have exactly the location contract key set (lng not lon)."""
        from backend.layers import get_layer
        result = get_layer("stores")
        assert "features" in result
        rows = result["features"]
        assert len(rows) > 0
        expected_keys = {
            "store_id", "name", "format", "zip", "sqft",
            "lat", "lng",
            "recent_visits", "base_traffic", "forecast_visits",
            "scheduled_hours", "ideal_hours", "labor_gap",
            "staffing_status", "traffic_delta_pct", "anomaly_driver",
        }
        for row in rows:
            assert set(row.keys()) == expected_keys, (
                f"stores feature keys mismatch.\n"
                f"  got:      {sorted(row.keys())}\n"
                f"  expected: {sorted(expected_keys)}"
            )

    def test_stores_layer_no_lon_key(self):
        """Stores layer must expose lng not lon."""
        from backend.layers import get_layer
        result = get_layer("stores")
        for row in result["features"]:
            assert "lon" not in row, "stores feature must use 'lng' not 'lon'"
            assert "lng" in row

    # --- unknown layer raises ---

    def test_unknown_layer_raises(self):
        from backend.layers import get_layer
        with pytest.raises((ValueError, KeyError)):
            get_layer("nonexistent")
