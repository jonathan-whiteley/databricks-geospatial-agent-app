"""
build_views.py: Execute build_forecast.sql and build_gold.sql on the warehouse.

Run from project root:
    python -m data.build_views

Steps:
    1. Attempt build_forecast.sql (ai_forecast).
       If it fails (ai_forecast unavailable), fall back to build_forecast_fallback.sql
       (DOW-seasonal mean).
    2. Execute build_gold.sql (store_ops view and all analytic views).

The warehouse ID and profile are read from backend.db defaults:
    profile: fe-vm-clover-spatial (or DATABRICKS_CONFIG_PROFILE env var)
    warehouse: f8b3878560d8debf   (or DATABRICKS_WAREHOUSE_ID env var)
"""

from __future__ import annotations

import sys
from pathlib import Path

from backend.db import exec_sql

# Root of the data/ directory (sibling to this file).
_HERE = Path(__file__).parent


def _load_sql(filename: str) -> str:
    """Read a SQL file from the data/ directory and return its contents."""
    return (_HERE / filename).read_text(encoding="utf-8")


def _run_statements(sql: str, label: str) -> None:
    """
    Split sql on semicolons, strip whitespace, and execute each non-empty statement.

    Skips blocks that contain only comments (no actual SQL keywords).
    Prints a status line per statement.
    """
    chunks = [s.strip() for s in sql.split(";") if s.strip()]
    # Filter out comment-only blocks (no non-comment, non-blank lines).
    statements = []
    for chunk in chunks:
        non_comment_lines = [
            ln for ln in chunk.splitlines()
            if ln.strip() and not ln.strip().startswith("--")
        ]
        if non_comment_lines:
            statements.append(chunk)

    for i, stmt in enumerate(statements, 1):
        non_comment_lines = [ln.strip() for ln in stmt.splitlines() if ln.strip() and not ln.strip().startswith("--")]
        desc = non_comment_lines[0][:80] if non_comment_lines else "<empty>"
        print(f"  [{label} {i}/{len(statements)}] {desc} ...")
        exec_sql(stmt)
        print(f"  [{label} {i}/{len(statements)}] done.")


def build_forecast() -> None:
    """Run ai_forecast SQL; fall back to DOW-seasonal mean on failure."""
    primary_sql = _load_sql("build_forecast.sql")
    try:
        print("[build_views] Running build_forecast.sql (ai_forecast) ...")
        _run_statements(primary_sql, "forecast")
        print("[build_views] store_forecast built via ai_forecast.")
    except Exception as exc:
        print(f"[build_views] ai_forecast failed: {exc}")
        print("[build_views] Falling back to build_forecast_fallback.sql (DOW-seasonal mean) ...")
        fallback_sql = _load_sql("build_forecast_fallback.sql")
        _run_statements(fallback_sql, "forecast-fallback")
        print("[build_views] store_forecast built via DOW-seasonal fallback.")


def build_gold() -> None:
    """Run build_gold.sql to create store_ops and all analytic views."""
    gold_sql = _load_sql("build_gold.sql")
    print("[build_views] Running build_gold.sql (store_ops + analytic views) ...")
    _run_statements(gold_sql, "gold")
    print("[build_views] All gold views created.")


def main() -> None:
    print("=== build_views: Clover Gold Views ===")
    build_forecast()
    build_gold()
    print("=== Done ===")


if __name__ == "__main__":
    main()
