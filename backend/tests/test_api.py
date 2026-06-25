"""
Tests for FastAPI routes in backend/main.py.

All network calls are monkeypatched so these tests run without a live
Databricks workspace.

Monkeypatch symbol paths used (the patch target depends on how main.py
imports each module):

    backend.layers.get_bootstrap      -- via `from backend import layers`
    backend.layers.get_layer          -- via `from backend import layers`
    backend.analytics.compute_in_view -- via `from backend import analytics`
    backend.genie.ask_genie           -- via `from backend import genie`
    backend.action.next_best_action   -- via `from backend import action`
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Fixtures: canned bootstrap payload used by analytics tests
# ---------------------------------------------------------------------------

_STORES_IN_BBOX = [
    {
        "store_id": "S001",
        "name": "Clover Harvard Sq",
        "format": "full",
        "zip": "02139",
        "sqft": 2000,
        "lat": 42.36,
        "lng": -71.06,
        "recent_visits": 500,
        "base_traffic": 3000,
        "forecast_visits": 520,
        "scheduled_hours": 40,
        "ideal_hours": 45,
        "labor_gap": 5,
        "staffing_status": "understaffed",
        "traffic_delta_pct": 2.5,
        "anomaly_driver": None,
    },
]

_STORES_OUT_BBOX = [
    {
        "store_id": "S099",
        "name": "Clover Faraway",
        "format": "kiosk",
        "zip": "99999",
        "sqft": 500,
        "lat": 40.0,
        "lng": -70.0,
        "recent_visits": 100,
        "base_traffic": 1000,
        "forecast_visits": 105,
        "scheduled_hours": 20,
        "ideal_hours": 20,
        "labor_gap": 0,
        "staffing_status": "staffed",
        "traffic_delta_pct": 0.0,
        "anomaly_driver": None,
    },
]

_DAILY_ROWS = [
    {
        "store_id": "S001",
        "days_ago": d,
        "visits": 100,
        "avg_dwell_min": 20.0,
        "capture_rate": 0.30,
    }
    for d in range(30)
]

_DEMO_BY_ID = {
    "S001": {
        "store_id": "S001",
        "age": {"18-24": 10.0, "25-34": 30.0, "35-44": 25.0, "45-54": 15.0, "55+": 20.0},
        "median_income": 85000.0,
        "median_age": 35.0,
        "pct_with_kids": 0.3,
    }
}

_BOOTSTRAP_PAYLOAD = {
    "META": {"center": [42.36, -71.06], "zoom": 13},
    "layers": [{"id": "stores", "name": "Stores", "table": "gold.store_ops"}],
    "locations": _STORES_IN_BBOX + _STORES_OUT_BBOX,
    "foot_traffic_daily": _DAILY_ROWS,
    "helpers": {
        "byId": {"S001": _STORES_IN_BBOX[0]},
        "demoById": _DEMO_BY_ID,
    },
}


# ---------------------------------------------------------------------------
# Helper: build TestClient with patches applied
# ---------------------------------------------------------------------------

def _make_client(monkeypatch, *, bootstrap=None, layer=None, layer_raise=None,
                 genie_result=None, action_result=None, analytics_result=None):
    """
    Import backend.main AFTER patching so the app picks up the patches.
    Because the app module is already imported after the first call, we patch
    the underlying module attributes directly (main imports `from backend import
    layers` etc., so we patch backend.layers.get_bootstrap and so on).
    """
    import backend.layers as _layers
    import backend.genie as _genie
    import backend.action as _action
    import backend.analytics as _analytics

    if bootstrap is not None:
        monkeypatch.setattr(_layers, "get_bootstrap", lambda: bootstrap)

    if layer is not None:
        monkeypatch.setattr(_layers, "get_layer", lambda name: layer)

    if layer_raise is not None:
        def _raise(name):
            raise layer_raise
        monkeypatch.setattr(_layers, "get_layer", _raise)

    if genie_result is not None:
        monkeypatch.setattr(_genie, "ask_genie",
                            lambda q, cid=None: genie_result)

    if action_result is not None:
        monkeypatch.setattr(_action, "next_best_action",
                            lambda q, sql, rows, columns=None: action_result)

    if analytics_result is not None:
        monkeypatch.setattr(_analytics, "compute_in_view",
                            lambda stores, daily, demo, bbox: analytics_result)

    from backend.main import app
    return TestClient(app)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestHealthz:
    def test_returns_ok(self, monkeypatch):
        client = _make_client(monkeypatch)
        resp = client.get("/healthz")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


class TestBootstrap:
    def test_returns_payload(self, monkeypatch):
        client = _make_client(monkeypatch, bootstrap=_BOOTSTRAP_PAYLOAD)
        resp = client.get("/api/bootstrap")
        assert resp.status_code == 200
        body = resp.json()
        assert "locations" in body
        assert "layers" in body
        assert "META" in body


class TestGetLayer:
    def test_known_layer_returns_200(self, monkeypatch):
        layer_data = {"features": [{"lat": 42.36, "lng": -71.06, "weight": 500}]}
        client = _make_client(monkeypatch, layer=layer_data)
        resp = client.get("/api/layers/traffic")
        assert resp.status_code == 200
        body = resp.json()
        assert "features" in body

    def test_unknown_layer_returns_404(self, monkeypatch):
        client = _make_client(monkeypatch, layer_raise=ValueError("Unknown layer name: 'bogus'"))
        resp = client.get("/api/layers/bogus")
        assert resp.status_code == 404
        body = resp.json()
        assert "detail" in body


class TestAnalytics:
    def test_returns_n_for_bbox_with_stores_in_view(self, monkeypatch):
        # Patch bootstrap so get_bootstrap returns stores, daily, demo.
        # Patch compute_in_view to verify it returns n > 0.
        expected = {
            "n": 1,
            "series": [100.0] * 30,
            "dailyTraffic": 100.0,
            "trafficDelta": 0.0,
            "visitors": 3000,
            "dwell": 20.0,
            "dwellDelta": 0.0,
            "cap": 30.0,
            "capDelta": 0.0,
            "bands": ["18-24", "25-34", "35-44", "45-54", "55+"],
            "ageAgg": {"18-24": 10.0, "25-34": 30.0, "35-44": 25.0, "45-54": 15.0, "55+": 20.0},
            "incAgg": 85000.0,
            "ageMed": 35.0,
            "kidsAgg": 0.3,
        }
        client = _make_client(monkeypatch, bootstrap=_BOOTSTRAP_PAYLOAD, analytics_result=expected)
        resp = client.post("/api/analytics", json={"bbox": [42.0, -71.5, 42.7, -70.5]})
        assert resp.status_code == 200
        body = resp.json()
        assert "n" in body
        assert body["n"] == 1

    def test_returns_n_zero_for_empty_view(self, monkeypatch):
        client = _make_client(monkeypatch, bootstrap=_BOOTSTRAP_PAYLOAD, analytics_result={"n": 0})
        resp = client.post("/api/analytics", json={"bbox": [10.0, 10.0, 11.0, 11.0]})
        assert resp.status_code == 200
        assert resp.json()["n"] == 0

    def test_invalid_body_returns_422(self, monkeypatch):
        client = _make_client(monkeypatch, bootstrap=_BOOTSTRAP_PAYLOAD, analytics_result={"n": 0})
        resp = client.post("/api/analytics", json={"bbox": "not-a-list"})
        assert resp.status_code == 422

    def test_bbox_wrong_length_returns_422(self, monkeypatch):
        # bbox with fewer than 4 elements must be rejected at validation time (422),
        # not reach the route handler at all.
        client = _make_client(monkeypatch, bootstrap=_BOOTSTRAP_PAYLOAD)
        resp = client.post("/api/analytics", json={"bbox": [1.0]})
        assert resp.status_code == 422

    def test_lng_to_lon_remap_end_to_end(self, monkeypatch):
        """
        Exercises the lng->lon remap in the /api/analytics route end-to-end.

        Only backend.layers.get_bootstrap is patched; compute_in_view runs for
        real. The bootstrap payload has stores with key "lng" (the JS contract).
        The route remaps them to add "lon" before passing to compute_in_view,
        which reads s["lon"] at line:
            in_view = [s for s in stores if in_bbox(s["lat"], s["lon"], bbox)]

        If the remap were removed, compute_in_view would raise KeyError("lon")
        and the route would return 500 instead of 200.

        The bbox (42.0, -71.5, 42.7, -70.5) contains S001 at (42.36, -71.06)
        but not S099 at (40.0, -70.0), so n >= 1 confirms the store was found.
        """
        import backend.layers as _layers

        monkeypatch.setattr(_layers, "get_bootstrap", lambda: _BOOTSTRAP_PAYLOAD)

        from backend.main import app
        client = TestClient(app)

        resp = client.post("/api/analytics", json={"bbox": [42.0, -71.5, 42.7, -70.5]})
        assert resp.status_code == 200, f"expected 200, got {resp.status_code}: {resp.text}"
        body = resp.json()
        assert body["n"] >= 1, f"expected at least 1 store in view, got n={body['n']}"


class TestGenieAsk:
    def test_returns_sql_and_rows(self, monkeypatch):
        genie_resp = {
            "text": "Here are the understaffed stores.",
            "sql": "SELECT store_id FROM gold.store_ops WHERE staffing_status='understaffed'",
            "columns": ["store_id"],
            "rows": [["S001"], ["S017"]],
            "conversation_id": "conv-abc",
        }
        client = _make_client(monkeypatch, genie_result=genie_resp)
        resp = client.post("/api/genie/ask", json={"question": "Which stores are understaffed?"})
        assert resp.status_code == 200
        body = resp.json()
        assert "sql" in body
        assert "rows" in body
        assert body["sql"] is not None

    def test_with_conversation_id(self, monkeypatch):
        genie_resp = {
            "text": "Follow-up answer.",
            "sql": None,
            "columns": [],
            "rows": [],
            "conversation_id": "conv-abc",
        }
        client = _make_client(monkeypatch, genie_result=genie_resp)
        resp = client.post(
            "/api/genie/ask",
            json={"question": "Tell me more", "conversation_id": "conv-abc"},
        )
        assert resp.status_code == 200

    def test_missing_question_returns_422(self, monkeypatch):
        client = _make_client(monkeypatch)
        resp = client.post("/api/genie/ask", json={"conversation_id": "conv-abc"})
        assert resp.status_code == 422


class TestAction:
    def test_returns_action_string(self, monkeypatch):
        action_sentence = "Reallocate staff from Store S099 to Store S001 immediately."
        client = _make_client(monkeypatch, action_result=action_sentence)
        resp = client.post(
            "/api/action",
            json={"question": "What should I do?", "sql": "SELECT 1", "rows": []},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert "action" in body
        assert body["action"] == action_sentence

    def test_null_sql_is_allowed(self, monkeypatch):
        client = _make_client(monkeypatch, action_result="Take action.")
        resp = client.post(
            "/api/action",
            json={"question": "What should I do?", "sql": None, "rows": []},
        )
        assert resp.status_code == 200

    def test_missing_question_returns_422(self, monkeypatch):
        client = _make_client(monkeypatch, action_result="noop")
        resp = client.post("/api/action", json={"sql": None, "rows": []})
        assert resp.status_code == 422
