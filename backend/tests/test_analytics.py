from backend.analytics import compute_in_view, in_bbox

def test_in_bbox():
    assert in_bbox(42.36,-71.06,(42.0,-71.5,42.7,-70.5))
    assert not in_bbox(40.0,-71.06,(42.0,-71.5,42.7,-70.5))

def _fixture():
    stores=[{"store_id":"a","lat":42.36,"lon":-71.06,"base_traffic":3000},
            {"store_id":"b","lat":42.40,"lon":-71.10,"base_traffic":2000}]
    daily=[{"store_id":"a","days_ago":d,"visits":100,"avg_dwell_min":20,"capture_rate":0.3} for d in range(30)]
    demo={"a":{"age":{"18-24":10,"25-34":30,"35-44":25,"45-54":15,"55-64":12,"65+":8},
               "median_income":85000,"median_age":36,"pct_with_kids":40}}
    return stores,daily,demo

def test_empty_viewport():
    stores,daily,demo=_fixture()
    out=compute_in_view(stores,daily,demo,(10.0,10.0,11.0,11.0))
    assert out["n"]==0

def test_in_view_aggregates():
    stores,daily,demo=_fixture()
    out=compute_in_view(stores,daily,demo,(42.0,-71.5,42.7,-70.5))
    assert out["n"]==2
    assert len(out["series"])==30
    assert out["dailyTraffic"]>0
