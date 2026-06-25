"""
Layer queries for the Clover Geospatial App.

Reads the clover_spatial_catalog.gold tables and returns data in the exact
field-name shape the frontend expects (porting clover-data.js static data).

Public surface:
    get_bootstrap() -> dict
    get_layer(name: str) -> dict   name in {traffic, trade, demo, competitors, pois, cross}

Field-name contract:
    - All coordinates use lng (not lon) to match the JS convention.
    - v_nearby_pois already exposes distance_mi; no km->mi conversion needed here.
    - v_trade_areas already exposes origin_lat / origin_lng (renamed in the SQL view).
    - v_cross_shopping exposes a_lat, a_lng, b_lat, b_lng (renamed in the SQL view).
    - The traffic layer returns {lat, lng, weight} points combining store centroids
      (weight = recent_visits) and trade-area origins (weight = visitors).
      This matches buildTraffic in the design: a weighted heatmap where the hottest
      points are the stores themselves and the origin spokes provide the catchment
      heat cloud. The frontend renders them together as a single Leaflet.heat layer.
"""
from __future__ import annotations

from data.config import GOLD, METRO_CENTER, METRO_ZOOM
from backend.db import run_sql

# ---------------------------------------------------------------------------
# Layer catalog (left-rail descriptor list)
# ---------------------------------------------------------------------------

_LAYER_CATALOG = [
    {"id": "stores",      "name": "Stores",           "table": f"{GOLD}.store_ops"},
    {"id": "traffic",     "name": "Foot Traffic Heat", "table": f"{GOLD}.store_ops"},
    {"id": "trade",       "name": "Trade Areas",       "table": f"{GOLD}.v_trade_areas"},
    {"id": "demo",        "name": "Demographics",      "table": f"{GOLD}.v_demographics"},
    {"id": "competitors", "name": "Competitors",       "table": f"{GOLD}.v_nearby_pois"},
    {"id": "pois",        "name": "Nearby POIs",       "table": f"{GOLD}.v_nearby_pois"},
    {"id": "cross",       "name": "Cross-Shopping",    "table": f"{GOLD}.v_cross_shopping"},
]

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

_STORE_OPS_COLS = (
    "store_id, name, format, zip, sqft, lat, lon, "
    "recent_visits, base_traffic, forecast_visits, "
    "scheduled_hours, ideal_hours, labor_gap, "
    "staffing_status, traffic_delta_pct, anomaly_driver"
)


def _row_to_location(row: dict) -> dict:
    """
    Map a store_ops row to the frontend location contract.

    Renames lon -> lng; keeps only the 16 contract keys.
    """
    return {
        "store_id":          row["store_id"],
        "name":              row["name"],
        "format":            row["format"],
        "zip":               row["zip"],
        "sqft":              row["sqft"],
        "lat":               row["lat"],
        "lng":               row["lon"],      # rename: gold=lon, contract=lng
        "recent_visits":     row["recent_visits"],
        "base_traffic":      row["base_traffic"],
        "forecast_visits":   row["forecast_visits"],
        "scheduled_hours":   row["scheduled_hours"],
        "ideal_hours":       row["ideal_hours"],
        "labor_gap":         row["labor_gap"],
        "staffing_status":   row["staffing_status"],
        "traffic_delta_pct": row["traffic_delta_pct"],
        "anomaly_driver":    row["anomaly_driver"],
    }


def _row_to_traffic_row(row: dict) -> dict:
    """Map a foot_traffic_daily row to the 5-key contract shape."""
    return {
        "store_id":     row["store_id"],
        "days_ago":     row["days_ago"],
        "visits":       row["visits"],
        "avg_dwell_min": row["avg_dwell_min"],
        "capture_rate": row["capture_rate"],
    }


def _row_to_demo(row: dict) -> dict:
    """
    Map a v_demographics row to the demoById contract shape.

    age bands use the human-readable keys the design expects (18-24, 25-34, etc).
    median_income comes from the view's median_income_proxy column.
    median_age is derived as weighted midpoint of age bands (not in v_demographics).
    pct_with_kids is not in v_demographics; always None.
    """
    # Derive median_age as weighted midpoint of age bands
    # Midpoints: 18-24=21, 25-34=29.5, 35-44=39.5, 45-54=49.5, 55+=62
    age_18_24   = row.get("age_18_24")   or 0
    age_25_34   = row.get("age_25_34")   or 0
    age_35_44   = row.get("age_35_44")   or 0
    age_45_54   = row.get("age_45_54")   or 0
    age_55plus  = row.get("age_55plus")  or 0
    total_age   = age_18_24 + age_25_34 + age_35_44 + age_45_54 + age_55plus
    if total_age > 0:
        median_age = round(
            (age_18_24 * 21 + age_25_34 * 29.5 + age_35_44 * 39.5 +
             age_45_54 * 49.5 + age_55plus * 62) / total_age,
            1,
        )
    else:
        median_age = None

    return {
        "store_id": row["store_id"],
        "age": {
            "18-24": row.get("age_18_24"),
            "25-34": row.get("age_25_34"),
            "35-44": row.get("age_35_44"),
            "45-54": row.get("age_45_54"),
            "55+":   row.get("age_55plus"),
        },
        "median_income":  row.get("median_income_proxy"),
        "median_age":     median_age,     # derived from age bands
        "pct_with_kids":  None,           # not in source data
        # income band breakdown for choropleth
        "income_lt50k":     row.get("income_lt50k"),
        "income_50_100k":   row.get("income_50_100k"),
        "income_100_150k":  row.get("income_100_150k"),
        "income_150_200k":  row.get("income_150_200k"),
        "income_gt200k":    row.get("income_gt200k"),
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_bootstrap(user_token: str | None = None) -> dict:
    """
    Return the full bootstrap payload for GET /api/bootstrap.

    When user_token is provided, all SQL runs on behalf of the viewing user
    (OBO) instead of the app service principal.

    Shape:
        {
            "META": {"center": [lat, lng], "zoom": int},
            "layers": [...layer descriptors...],
            "locations": [...store dicts with lng, not lon...],
            "foot_traffic_daily": [...rows with 5 contract keys...],
            "helpers": {
                "byId":    {store_id: store_dict},
                "demoById": {store_id: demo_dict},
            }
        }
    """
    # -- locations from gold.store_ops --
    store_rows = run_sql(
        f"SELECT {_STORE_OPS_COLS} FROM {GOLD}.store_ops",
        user_token=user_token,
    )
    locations = [_row_to_location(r) for r in store_rows]

    # -- foot traffic (last 30 days, trimmed to contract keys) --
    ft_rows = run_sql(
        f"SELECT store_id, days_ago, visits, avg_dwell_min, capture_rate "
        f"FROM {GOLD}.foot_traffic_daily "
        f"WHERE days_ago <= 29 "
        f"ORDER BY store_id, days_ago",
        user_token=user_token,
    )
    foot_traffic_daily = [_row_to_traffic_row(r) for r in ft_rows]

    # -- demographics from gold.v_demographics --
    demo_rows = run_sql(
        f"SELECT store_id, age_18_24, age_25_34, age_35_44, age_45_54, age_55plus, "
        f"median_income_proxy, "
        f"income_lt50k, income_50_100k, income_100_150k, income_150_200k, income_gt200k "
        f"FROM {GOLD}.v_demographics",
        user_token=user_token,
    )
    demo_by_id: dict[str, dict] = {}
    for row in demo_rows:
        d = _row_to_demo(row)
        demo_by_id[d["store_id"]] = d

    # -- helpers --
    by_id = {s["store_id"]: s for s in locations}

    return {
        "META": {
            "center": list(METRO_CENTER),
            "zoom":   METRO_ZOOM,
        },
        "layers":            _LAYER_CATALOG,
        "locations":         locations,
        "foot_traffic_daily": foot_traffic_daily,
        "helpers": {
            "byId":    by_id,
            "demoById": demo_by_id,
        },
    }


def get_layer(name: str, user_token: str | None = None) -> dict:
    """
    Return layer data for GET /api/layers/{name}.

    All responses are wrapped in {"features": [...]} so the client has a
    consistent envelope regardless of layer type.

    When user_token is provided, all SQL runs on behalf of the viewing user
    (OBO) instead of the app service principal.

    Supported names: traffic, trade, demo, competitors, pois, cross.
    Raises ValueError for unknown names.
    """
    if name == "stores":
        store_rows = run_sql(
            f"SELECT {_STORE_OPS_COLS} FROM {GOLD}.store_ops",
            user_token=user_token,
        )
        features = [_row_to_location(r) for r in store_rows]

    elif name == "trade":
        rows = run_sql(
            f"SELECT store_id, origin_lat, origin_lng, visitors "
            f"FROM {GOLD}.v_trade_areas",
            user_token=user_token,
        )
        features = [
            {
                "store_id":   r["store_id"],
                "origin_lat": r["origin_lat"],
                "origin_lng": r["origin_lng"],
                "visitors":   r["visitors"],
            }
            for r in rows
        ]

    elif name == "demo":
        rows = run_sql(
            f"SELECT d.store_id, d.age_18_24, d.age_25_34, d.age_35_44, d.age_45_54, d.age_55plus, "
            f"d.median_income_proxy, "
            f"d.income_lt50k, d.income_50_100k, d.income_100_150k, d.income_150_200k, d.income_gt200k, "
            f"s.lat, s.lon "
            f"FROM {GOLD}.v_demographics d "
            f"JOIN {GOLD}.store_ops s ON d.store_id = s.store_id",
            user_token=user_token,
        )
        features = []
        for r in rows:
            d = _row_to_demo(r)
            d["lat"] = r["lat"]
            d["lng"] = r["lon"]   # rename lon -> lng
            features.append(d)

    elif name == "competitors":
        rows = run_sql(
            f"SELECT name, category, poi_type, lat, lng, distance_mi "
            f"FROM {GOLD}.v_nearby_pois "
            f"WHERE poi_type = 'competitor'",
            user_token=user_token,
        )
        features = [
            {
                "name":        r["name"],
                "category":    r["category"],
                "lat":         r["lat"],
                "lng":         r["lng"],
                "distance_mi": r["distance_mi"],
            }
            for r in rows
        ]

    elif name == "pois":
        rows = run_sql(
            f"SELECT name, category, poi_type, lat, lng, distance_mi "
            f"FROM {GOLD}.v_nearby_pois "
            f"WHERE poi_type = 'complement'",
            user_token=user_token,
        )
        features = [
            {
                "name":        r["name"],
                "category":    r["category"],
                "lat":         r["lat"],
                "lng":         r["lng"],
                "distance_mi": r["distance_mi"],
            }
            for r in rows
        ]

    elif name == "cross":
        rows = run_sql(
            f"SELECT a_lat, a_lng, b_lat, b_lng, shared_visitors "
            f"FROM {GOLD}.v_cross_shopping",
            user_token=user_token,
        )
        features = [
            {
                "a_lat":           r["a_lat"],
                "a_lng":           r["a_lng"],
                "b_lat":           r["b_lat"],
                "b_lng":           r["b_lng"],
                "shared_visitors": r["shared_visitors"],
            }
            for r in rows
        ]

    elif name == "traffic":
        # Traffic heatmap: combine store centroids (weight=recent_visits) with
        # trade-area origin zips (weight=visitors).
        #
        # Design's buildTraffic consumed store coords + origin spokes to produce
        # the weighted heatmap. Using both sources gives the map both the hot
        # store nodes and the warm catchment cloud, matching the design intent.
        store_rows = run_sql(
            f"SELECT lat, lon, recent_visits FROM {GOLD}.store_ops",
            user_token=user_token,
        )
        origin_rows = run_sql(
            f"SELECT origin_lat, origin_lng, visitors FROM {GOLD}.v_trade_areas",
            user_token=user_token,
        )
        features = []
        for r in store_rows:
            features.append({
                "lat":    r["lat"],
                "lng":    r["lon"],           # rename lon -> lng
                "weight": r["recent_visits"] or 0,
            })
        for r in origin_rows:
            features.append({
                "lat":    r["origin_lat"],
                "lng":    r["origin_lng"],
                "weight": r["visitors"] or 0,
            })

    else:
        raise ValueError(f"Unknown layer name: {name!r}")

    return {"features": features}
