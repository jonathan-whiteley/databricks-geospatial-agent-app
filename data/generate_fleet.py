"""
Deterministic synthetic data generator for the Clover store fleet.

All functions are pure and deterministic given CLOVER_SEED.
No Databricks, network, or file I/O occurs here.
"""

import random
import math
from datetime import date, timedelta
from data.config import CLOVER_SEED, TARGET_VISITS_PER_HOUR, ANCHOR_DATE

# Fixed reference date used as the "today" anchor for all date calculations.
# Never use datetime.now() or wall-clock time; keep the generator deterministic.
REFERENCE_DATE = date(2026, 6, 24)

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
        open_date = (REFERENCE_DATE - timedelta(days=days_ago)).isoformat()

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
    store_id = store["store_id"]
    # Seed is store-specific so different stores produce different visit shapes,
    # but repeated calls for the same store always produce identical output.
    rng = random.Random(CLOVER_SEED + sum(ord(c) for c in store_id))
    base = store.get("base_traffic", 1000)

    # Anchor the series end to ANCHOR_DATE so the most recent row is always
    # ANCHOR_DATE regardless of wall-clock time (determinism preserved).
    rows = []
    for i in range(days):
        d = ANCHOR_DATE - timedelta(days=(days - 1 - i))
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
        # Scale visits and unique_visitors independently.
        row["visits"] = max(0, int(row["visits"] * (1.0 - pct)))
        row["unique_visitors"] = max(0, int(row["unique_visitors"] * (1.0 - pct)))
        # Recompute daypart split from the new visits count using the same
        # split logic as make_daily_series so morning+afternoon+evening==visits.
        v = row["visits"]
        morning = int(v * _DAYPART_WEIGHTS[0])
        evening = int(v * _DAYPART_WEIGHTS[2])
        afternoon = v - morning - evening
        row["visits_morning"] = morning
        row["visits_afternoon"] = afternoon
        row["visits_evening"] = evening


def make_demographics(store: dict) -> dict:
    """
    Return deterministic income-band and age-band percentages for a store.

    Uses a store-specific seed derived from CLOVER_SEED + char-sum + 7
    (offset from make_daily_series so the sequences differ).

    Returns a dict with keys:
        store_id,
        income_lt50k, income_50_100k, income_100_150k, income_150_200k, income_gt200k
            (floats, each band set sums to exactly 100.0)
        age_18_24, age_25_34, age_35_44, age_45_54, age_55plus
            (floats, each band set sums to exactly 100.0)

    Flagship or larger-sqft stores skew toward higher income brackets.
    The fleet is heterogeneous: each store gets a distinct profile.
    """
    store_id = store["store_id"]
    rng = random.Random(CLOVER_SEED + sum(ord(c) for c in store_id) + 7)

    # Flagship / large-sqft stores tilt toward higher income.
    sqft = store.get("sqft", 2000)
    is_flagship = store.get("format", "").lower() == "flagship" or store.get("banner", "").lower() == "flagship"
    sqft_score = min(1.0, sqft / 6000.0)  # 0..1
    income_bias = 0.3 if is_flagship else (sqft_score * 0.2)

    # Raw weights for 5 income bands: <50k, 50-100k, 100-150k, 150-200k, 200k+
    # Base profile: roughly middle-class Boston area; bias shifts weight toward upper bands.
    w_inc = [
        rng.uniform(0.05, 0.20) * (1.0 - income_bias),   # <50k
        rng.uniform(0.20, 0.35),                           # 50-100k
        rng.uniform(0.20, 0.35) * (1.0 + income_bias),    # 100-150k
        rng.uniform(0.10, 0.25) * (1.0 + income_bias),    # 150-200k
        rng.uniform(0.05, 0.15) * (1.0 + income_bias),    # 200k+
    ]
    # Normalize to exactly 100.0; assign remainder to largest band.
    total_inc = sum(w_inc)
    pcts_inc = [round(w / total_inc * 100.0, 1) for w in w_inc]
    remainder_inc = round(100.0 - sum(pcts_inc), 1)
    max_idx_inc = pcts_inc.index(max(pcts_inc))
    pcts_inc[max_idx_inc] = round(pcts_inc[max_idx_inc] + remainder_inc, 1)

    # Raw weights for 5 age bands: 18-24, 25-34, 35-44, 45-54, 55+
    w_age = [
        rng.uniform(0.08, 0.18),   # 18-24
        rng.uniform(0.20, 0.35),   # 25-34 (core urban café demo)
        rng.uniform(0.20, 0.30),   # 35-44
        rng.uniform(0.12, 0.22),   # 45-54
        rng.uniform(0.08, 0.18),   # 55+
    ]
    total_age = sum(w_age)
    pcts_age = [round(w / total_age * 100.0, 1) for w in w_age]
    remainder_age = round(100.0 - sum(pcts_age), 1)
    max_idx_age = pcts_age.index(max(pcts_age))
    pcts_age[max_idx_age] = round(pcts_age[max_idx_age] + remainder_age, 1)

    return {
        "store_id":          store_id,
        "income_lt50k":      pcts_inc[0],
        "income_50_100k":    pcts_inc[1],
        "income_100_150k":   pcts_inc[2],
        "income_150_200k":   pcts_inc[3],
        "income_gt200k":     pcts_inc[4],
        "age_18_24":         pcts_age[0],
        "age_25_34":         pcts_age[1],
        "age_35_44":         pcts_age[2],
        "age_45_54":         pcts_age[3],
        "age_55plus":        pcts_age[4],
    }


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
