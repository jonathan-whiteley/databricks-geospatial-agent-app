from data.generate_fleet import make_fleet, make_daily_series, inject_drop, make_schedule

REAL = [{"store_id":"r1","name":"Clover Back Bay","banner":"Flagship","lat":42.35,"lon":-71.08,"sqft":48000,"base_traffic":3800}]

def test_fleet_is_deterministic_and_sized():
    a = make_fleet(REAL, n_synth=12); b = make_fleet(REAL, n_synth=12)
    assert len(a) == 13
    assert [s["store_id"] for s in a] == [s["store_id"] for s in b]   # deterministic
    assert a[0]["store_id"] == "r1"                                    # real passthrough

def test_daily_series_nonneg_and_daypart_sums():
    s = make_fleet(REAL, 12)[5]
    rows = make_daily_series(s, days=60)
    assert len(rows) == 60
    assert all(r["visits"] >= 0 for r in rows)
    # Invariant must hold for ALL rows, not just row[0].
    assert all(
        r["visits_morning"] + r["visits_afternoon"] + r["visits_evening"] == r["visits"]
        for r in rows
    )

def test_inject_drop_lowers_recent():
    s = make_fleet(REAL, 12)[5]; rows = make_daily_series(s, days=30)
    before = sum(x["visits"] for x in rows[-5:])
    inject_drop(rows, s["store_id"], pct=0.2, last_n=5)
    after = sum(x["visits"] for x in rows[-5:])
    assert after < before
    # Daypart sum invariant must still hold after the drop.
    assert all(
        r["visits_morning"] + r["visits_afternoon"] + r["visits_evening"] == r["visits"]
        for r in rows
    )

def test_stores_have_distinct_series():
    """Different synthetic stores must produce different visit shapes (per-store seeding)."""
    fleet = make_fleet(REAL, 12)
    # Pick two different synthetic stores.
    store_a = fleet[1]
    store_b = fleet[2]
    assert store_a["store_id"] != store_b["store_id"]
    rows_a = make_daily_series(store_a, days=60)
    rows_b = make_daily_series(store_b, days=60)
    visits_a = [r["visits"] for r in rows_a]
    visits_b = [r["visits"] for r in rows_b]
    assert visits_a != visits_b, "Different stores must produce different visit sequences"

def test_schedule_creates_gap():
    s = make_fleet(REAL, 12)[2]
    assert make_schedule(s, forecast_visits=3300) > 0
