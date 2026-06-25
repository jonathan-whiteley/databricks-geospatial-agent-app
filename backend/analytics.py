"""
Pure in-viewport analytics computation.
Mirrors the design's client-side recompute() logic.
No network, no file I/O, no wall-clock.
"""
from __future__ import annotations

from typing import Any


def in_bbox(lat: float, lng: float, bbox: tuple[float, float, float, float]) -> bool:
    """Return True when (lat, lng) falls within bbox = (south, west, north, east)."""
    south, west, north, east = bbox
    return south <= lat <= north and west <= lng <= east


def _trailing7_mean(series: list[float]) -> float:
    """Mean of the last 7 values in series."""
    tail = series[-7:]
    if not tail:
        return 0.0
    return sum(tail) / len(tail)


def _prior7_mean(series: list[float]) -> float:
    """Mean of series[-14:-7]."""
    segment = series[-14:-7]
    if not segment:
        return 0.0
    return sum(segment) / len(segment)


def _pct_delta(current: float, prior: float) -> float:
    """Percent change from prior to current. Returns 0 when prior is zero."""
    if prior == 0.0:
        return 0.0
    return round((current - prior) / prior * 100, 2)


def compute_in_view(
    stores: list[dict[str, Any]],
    daily: list[dict[str, Any]],
    demographics: dict[str, dict[str, Any]],
    bbox: tuple[float, float, float, float],
) -> dict[str, Any]:
    """
    Compute left-rail KPIs for stores whose (lat, lon) fall within bbox.

    Parameters
    ----------
    stores:
        List of store dicts: {store_id, lat, lon, base_traffic, ...}
    daily:
        List of daily rows: {store_id, days_ago, visits, avg_dwell_min, capture_rate}
        days_ago ranges 0..29 where 0 = today.
    demographics:
        Keyed by store_id: {age: {band: pct}, median_income, median_age, pct_with_kids}
    bbox:
        (south, west, north, east)

    Returns
    -------
    {"n": 0} when no stores are in viewport, otherwise full KPI dict.
    """
    # Filter stores to those inside the viewport
    in_view = [s for s in stores if in_bbox(s["lat"], s["lon"], bbox)]

    if not in_view:
        return {"n": 0}

    in_view_ids = {s["store_id"] for s in in_view}

    # Build per-store daily lookup: store_id -> {days_ago: row}
    store_daily: dict[str, dict[int, dict[str, Any]]] = {}
    for row in daily:
        sid = row["store_id"]
        if sid not in in_view_ids:
            continue
        store_daily.setdefault(sid, {})[row["days_ago"]] = row

    # Build series: index 0 = 29 days ago, index 29 = today
    # series[i] = total visits across all in-view stores for days_ago = 29-i
    series: list[float] = []
    for i in range(30):
        days_ago = 29 - i
        total_visits = 0.0
        for s in in_view:
            sid = s["store_id"]
            row = store_daily.get(sid, {}).get(days_ago)
            if row is not None:
                total_visits += row["visits"]
        series.append(total_visits)

    # Traffic KPIs
    trailing7_traffic = _trailing7_mean(series)
    prior7_traffic = _prior7_mean(series)
    daily_traffic = round(trailing7_traffic, 2)
    traffic_delta = _pct_delta(trailing7_traffic, prior7_traffic)

    # Dwell KPIs: average avg_dwell_min across in-view stores for the relevant days
    def _store_series_for_metric(metric: str) -> list[float]:
        """Return a 30-element series of the mean metric across in-view stores per day."""
        result = []
        for i in range(30):
            days_ago = 29 - i
            values = []
            for s in in_view:
                sid = s["store_id"]
                row = store_daily.get(sid, {}).get(days_ago)
                if row is not None:
                    values.append(row[metric])
            if values:
                result.append(sum(values) / len(values))
            else:
                result.append(0.0)
        return result

    dwell_series = _store_series_for_metric("avg_dwell_min")
    trailing7_dwell = _trailing7_mean(dwell_series)
    prior7_dwell = _prior7_mean(dwell_series)
    dwell = round(trailing7_dwell, 2)
    dwell_delta = _pct_delta(trailing7_dwell, prior7_dwell)

    cap_series = _store_series_for_metric("capture_rate")
    trailing7_cap = _trailing7_mean(cap_series)
    prior7_cap = _prior7_mean(cap_series)
    cap = round(trailing7_cap * 100, 2)  # express as percentage
    cap_delta = _pct_delta(trailing7_cap, prior7_cap)

    # Visitors: sum of base_traffic across in-view stores
    visitors = sum(s["base_traffic"] for s in in_view)

    # Demographics: weighted by each store's base_traffic
    total_weight = sum(s["base_traffic"] for s in in_view if s["store_id"] in demographics)

    # Collect age band keys (preserve order from first store's demographics)
    bands: list[str] = []
    for s in in_view:
        sid = s["store_id"]
        if sid in demographics and "age" in demographics[sid]:
            bands = list(demographics[sid]["age"].keys())
            break

    if total_weight == 0.0 or not bands:
        age_agg = {b: 0.0 for b in bands}
        inc_agg = 0.0
        age_med = 0.0
        kids_agg = 0.0
    else:
        # Weighted sum of each age band percentage
        age_agg_sum = {b: 0.0 for b in bands}
        inc_sum = 0.0
        age_med_sum = 0.0
        kids_sum = 0.0
        weight_used = 0.0

        for s in in_view:
            sid = s["store_id"]
            w = s["base_traffic"]
            if sid not in demographics:
                continue
            demo = demographics[sid]
            weight_used += w
            for b in bands:
                age_agg_sum[b] += demo["age"].get(b, 0.0) * w
            inc_sum += demo.get("median_income", 0.0) * w
            age_med_sum += demo.get("median_age", 0.0) * w
            kids_sum += demo.get("pct_with_kids", 0.0) * w

        if weight_used == 0.0:
            age_agg = {b: 0.0 for b in bands}
            inc_agg = 0.0
            age_med = 0.0
            kids_agg = 0.0
        else:
            age_agg = {b: round(age_agg_sum[b] / weight_used, 2) for b in bands}
            inc_agg = round(inc_sum / weight_used, 2)
            age_med = round(age_med_sum / weight_used, 2)
            kids_agg = round(kids_sum / weight_used, 2)

    return {
        "n": len(in_view),
        "series": series,
        "dailyTraffic": daily_traffic,
        "trafficDelta": traffic_delta,
        "visitors": visitors,
        "dwell": dwell,
        "dwellDelta": dwell_delta,
        "cap": cap,
        "capDelta": cap_delta,
        "bands": bands,
        "ageAgg": age_agg,
        "incAgg": inc_agg,
        "ageMed": age_med,
        "kidsAgg": kids_agg,
    }
