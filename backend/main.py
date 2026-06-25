"""
FastAPI application for the Clover Geospatial App.

Routes
------
GET  /healthz                   -- liveness probe
GET  /api/bootstrap             -- full bootstrap payload (layers, locations, daily, demo)
GET  /api/layers/{name}         -- single layer feature collection
POST /api/analytics             -- in-viewport KPI computation
POST /api/genie/ask             -- Genie conversation proxy
POST /api/action                -- next-best-action generator

Static hosting
--------------
If frontend/dist exists at startup, it is served as a StaticFiles mount at
the root so the React SPA is reachable from the app. The guard prevents a
crash when the frontend has not been built yet.

CORS
----
Permissive localhost origins are added for local dev. In production the
Databricks App runtime does not need them (same-origin), but they do not
hurt when present.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator

from backend import action, analytics, genie, layers

# ---------------------------------------------------------------------------
# App instance
# ---------------------------------------------------------------------------

app = FastAPI(title="Clover Geospatial App", version="1.0.0")

# ---------------------------------------------------------------------------
# CORS (local dev)
# ---------------------------------------------------------------------------

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
        "http://localhost:8000",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class AnalyticsRequest(BaseModel):
    bbox: list[float]  # [south, west, north, east]

    @field_validator("bbox")
    @classmethod
    def bbox_must_have_four_elements(cls, v: list[float]) -> list[float]:
        if len(v) != 4:
            raise ValueError(f"bbox must have exactly 4 elements, got {len(v)}")
        return v


class GenieAskRequest(BaseModel):
    question: str
    conversation_id: str | None = None


class ActionRequest(BaseModel):
    question: str
    sql: str | None = None
    rows: list[Any] = []


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/bootstrap")
def api_bootstrap() -> dict[str, Any]:
    return layers.get_bootstrap()


@app.get("/api/layers/{name}")
def api_get_layer(name: str) -> dict[str, Any]:
    try:
        return layers.get_layer(name)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/analytics")
def api_analytics(req: AnalyticsRequest) -> dict[str, Any]:
    """
    Compute in-viewport KPIs.

    Calls get_bootstrap() to obtain locations, daily traffic, and the
    demoById helper, then passes the filtered data to compute_in_view.
    Reusing bootstrap avoids duplicate SQL queries.

    compute_in_view expects:
        stores      list[dict]  -- lat/lng/base_traffic (uses key "lon" internally)
        daily       list[dict]  -- store_id/days_ago/visits/avg_dwell_min/capture_rate
        demographics dict       -- store_id -> demo dict
        bbox        tuple[float, float, float, float]
    """
    bootstrap = layers.get_bootstrap()

    # bootstrap["locations"] uses "lng" (JS contract); analytics.compute_in_view
    # expects "lon". Remap here so analytics stays clean.
    raw_locations = bootstrap.get("locations", [])
    stores_for_analytics = [
        {**s, "lon": s["lng"]} for s in raw_locations
    ]

    daily = bootstrap.get("foot_traffic_daily", [])
    demo_by_id = bootstrap.get("helpers", {}).get("demoById", {})

    bbox_list = req.bbox
    bbox = (bbox_list[0], bbox_list[1], bbox_list[2], bbox_list[3])

    return analytics.compute_in_view(stores_for_analytics, daily, demo_by_id, bbox)


@app.post("/api/genie/ask")
def api_genie_ask(req: GenieAskRequest) -> dict[str, Any]:
    return genie.ask_genie(req.question, req.conversation_id)


@app.post("/api/action")
def api_action(req: ActionRequest) -> dict[str, str]:
    sentence = action.next_best_action(req.question, req.sql, req.rows)
    return {"action": sentence}


# ---------------------------------------------------------------------------
# Static files: serve built frontend from frontend/dist if it exists
# ---------------------------------------------------------------------------

_DIST = Path(__file__).parent.parent / "frontend" / "dist"
if _DIST.exists():
    app.mount("/", StaticFiles(directory=str(_DIST), html=True), name="static")
