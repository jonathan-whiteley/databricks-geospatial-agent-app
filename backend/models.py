"""
Pydantic v2 response models for the Clover Geospatial App API.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, model_validator


class AnalyticsResponse(BaseModel):
    """
    Response model for compute_in_view output.

    When the viewport is empty only n=0 is present; all other fields are
    optional so that validation passes for both the empty and populated cases.
    """

    n: int

    # 30-element time series: index 0 = 29 days ago, index 29 = today
    series: list[float] | None = None

    # Traffic KPIs
    dailyTraffic: float | None = None
    trafficDelta: float | None = None
    visitors: int | None = None

    # Dwell KPIs
    dwell: float | None = None
    dwellDelta: float | None = None

    # Capture-rate KPIs (expressed as percentage)
    cap: float | None = None
    capDelta: float | None = None

    # Demographics
    bands: list[str] | None = None
    ageAgg: dict[str, float] | None = None
    incAgg: float | None = None
    ageMed: float | None = None
    kidsAgg: float | None = None

    @model_validator(mode="after")
    def series_length(self) -> "AnalyticsResponse":
        if self.series is not None and len(self.series) != 30:
            raise ValueError(f"series must have 30 elements, got {len(self.series)}")
        return self

    model_config = {"extra": "allow"}


class StoreFeature(BaseModel):
    """GeoJSON Feature for a single store location."""

    type: str = "Feature"
    geometry: dict[str, Any]
    properties: dict[str, Any]


class StoreFeatureCollection(BaseModel):
    """GeoJSON FeatureCollection of store locations."""

    type: str = "FeatureCollection"
    features: list[StoreFeature]


class HealthResponse(BaseModel):
    """API health-check response."""

    status: str
    version: str = "1.0.0"
