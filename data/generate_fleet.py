"""
Deterministic synthetic data generator for the Clover store fleet.

All functions are pure and deterministic given CLOVER_SEED.
No Databricks, network, or file I/O occurs here.
"""

import random
import math
from datetime import date, timedelta
from data.config import CLOVER_SEED, TARGET_VISITS_PER_HOUR

# Greater Boston neighborhoods with approximate lat/lon centers.
_NEIGHBORHOODS = [
    ("Back Bay",       "Boston",     "Greater Boston",  42.3503, -71.0810),
    ("South End",      "Boston",     "Greater Boston",  42.3424, -71.0722),
    ("Fenway",         "Boston",     "Greater Boston",  42.3467, -71.0972),
    ("Kendall Square", "Cambridge",  "Greater Boston",  42.3626, -71.0843),
    ("Harvard Square", "Cambridge",  "Greater Boston",  42.3736, -71.1190),
    ("Porter Square",  "Cambridge",  "Greater Boston",  42.3884, -71.1191),
    ("Davis Square",   "Somerville", "Greater Boston",  42.3965, -71.1224),
    ("Inman Square",   "Cambridge",  "Greater Boston",  42.3731, -71.1031),
    ("Jamaica Plain",  "Boston",     "Greater Boston",  42.3099, -71.1142),
    ("Coolidge Corner","Brookline",  "Greater Boston",  42.3316, -71.1213),
    ("Roslindale",     "Boston",     "Greater Boston",  42.2838, -71.1271),
    ("Hyde Square",    "Boston",     "Greater Boston",  42.3113, -71.1012),
]

# Deterministic per-index staffing bias offsets (hours).
_STAFFING_BIASES = [-12, -6, 0, 6, 10]

# Daypart weights: morning, afternoon, evening.
_DAYPART_WEIGHTS = (0.30, 0.40, 0.30)

# Weekend lift multiplier.
_WEEKEND_LIFT = 1.25

# Formats and banners for synthetic stores.
_FORMATS = ["Full-Service", "Fast-Casual", "Counter", "Kiosk"]
_BANNERS = ["Clover Food Lab", "Clover Express", "Clover Market"]


def make_fleet(real_stores: list[dict], n_synth: int = 12) -> list[dict]:
    """
    Return a list of store dicts: real stores first, then n_synth synthetic stores.

    Synthetic store ids are clv_s01, clv_s02, ...
    Real stores pass through unchanged (all keys preserved).
    The result is deterministic: two calls with the same args produce the same store_ids.
    """
    rng = random.Random(CLOVER_SEED)
    fleet = list(real_stores)  # passthrough; do not mutate originals

    for i in range(n_synth):
        idx = i % len(_NEIGHBORHOODS)
        nbhd, city, market, base_lat, base_lon = _NEIGHBORHOODS[idx]

        # Jitter lat/lon slightly so stores in the same neighborhood differ.
        lat = base_lat + rng.uniform(-0.005, 0.005)
        lon = base_lon + rng.uniform(-0.005, 0.005)

        sqft = rng.randint(1200, 6000)
        base_traffic = rng.randint(800, 5000)

        # Open date: 1-8 years ago, deterministic.
        days_ago = rng.randint(365, 365 * 8)
        open_date = (date(2026, 6, 24) - timedelta(days=days_ago)).isoformat()

        store = {
            "store_id":      f"clv_s{i + 1:02d}",
            "name":          f"Clover {nbhd}",
            "banner":        rng.choice(_BANNERS),
            "format":        rng.choice(_FORMATS),
            "neighborhood":  nbhd,
            "city":          city,
            "market":        market,
            "lat":           round(lat, 6),
            "lon":           round(lon, 6),
            "sqft":          sqft,
            "open_date":     open_date,
            "base_traffic":  base_traffic,
        }
        fleet.append(store)

    return fleet


def make_daily_series(store: dict, days: int = 540) -> list[dict]:
    """
    Generate a daily visit series for a store.

    Each row contains:
        store_id, date, dow, is_weekend, visits, unique_visitors,
        avg_dwell_min, visits_morning, visits_afternoon, visits_evening

    Weekend days receive a ~1.25x lift. Daypart splits sum exactly to visits.
    No negative values.
    """
    rng = random.Random(CLOVER_SEED)
    base = store.get("base_traffic", 1000)
    store_id = store["store_id"]

    # Anchor to a fixed start date for determinism (independent of wall clock).
    start = date(2024, 12, 1)

    rows = []
    for i in range(days):
        d = start + timedelta(days=i)
        dow = d.isoweekday()  # 1=Mon, 7=Sun
        is_weekend = dow >= 6

        lift = _WEEKEND_LIFT if is_weekend else 1.0
        noise = rng.uniform(0.80, 1.20)
        visits = max(0, int(base * lift * noise))

        unique_visitors = max(0, int(visits * rng.uniform(0.70, 0.90)))
        avg_dwell_min = round(rng.uniform(12.0, 45.0), 1)

        # Daypart split: assign remainder to afternoon so the sum is exact.
        morning = int(visits * _DAYPART_WEIGHTS[0])
        evening = int(visits * _DAYPART_WEIGHTS[2])
        afternoon = visits - morning - evening  # captures any rounding remainder

        rows.append({
            "store_id":           store_id,
            "date":               d.isoformat(),
            "dow":                dow,
            "is_weekend":         is_weekend,
            "visits":             visits,
            "unique_visitors":    unique_visitors,
            "avg_dwell_min":      avg_dwell_min,
            "visits_morning":     morning,
            "visits_afternoon":   afternoon,
            "visits_evening":     evening,
        })

    return rows


def inject_drop(rows: list[dict], store_id: str, pct: float, last_n: int = 5) -> None:
    """
    Mutate the last last_n rows for store_id: reduce visits and all sub-counts by pct.

    Operates in-place; returns None.
    """
    target = [r for r in rows if r["store_id"] == store_id]
    affected = target[-last_n:]
    for row in affected:
        for key in ("visits", "unique_visitors", "visits_morning", "visits_afternoon", "visits_evening"):
            row[key] = max(0, int(row[key] * (1.0 - pct)))


def make_schedule(store: dict, forecast_visits: float) -> int:
    """
    Return scheduled_hours for a store given a forecast visit count.

    Base: round(forecast_visits / TARGET_VISITS_PER_HOUR).
    Adjusted by a deterministic per-store-index bias chosen from
    {-12, -6, 0, +6, +10} so the fleet shows a mix of staffing states.
    Result is always >= 1.
    """
    # Derive a stable index from the store_id string for determinism.
    store_id = store.get("store_id", "")
    index = sum(ord(c) for c in store_id)

    base_hours = round(forecast_visits / TARGET_VISITS_PER_HOUR)
    bias = _STAFFING_BIASES[index % len(_STAFFING_BIASES)]
    return max(1, base_hours + bias)
