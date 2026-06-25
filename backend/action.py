"""
Foundation-Model next-best-action generator.

Calls the Databricks-hosted Claude Sonnet serving endpoint via the
SDK's OpenAI-compatible client to generate a single store-ops
next-best-action sentence from a question and its query result rows.

Environment variables:
    DATABRICKS_CONFIG_PROFILE  default profile name (fallback: fe-vm-clover-spatial)
    DATABRICKS_HOST / DATABRICKS_TOKEN  injected inside a Databricks App
    SERVING_ENDPOINT           model serving endpoint name (default: data.config value)
"""

from __future__ import annotations

import logging
import os
import re
import sys
from typing import Any

log = logging.getLogger(__name__)

# ---- constants ---------------------------------------------------------------

_FALLBACK_ACTION = (
    "Reallocate labor hours from overstaffed stores to the understaffed locations "
    "flagged above, then recheck at midday."
)
_MAX_ROWS_PREVIEW = 10
_MAX_TOKENS = 80

_SYSTEM_PROMPT = (
    "You are a retail store-ops advisor. "
    "Given a question and its query result, reply with ONE concise next-best-action "
    "sentence for a store-ops manager. No dashes."
)


def _serving_endpoint() -> str:
    ep = os.getenv("SERVING_ENDPOINT", "").strip()
    if ep:
        return ep
    try:
        from data.config import SERVING_ENDPOINT as _EP  # noqa: PLC0415
        return _EP
    except Exception:
        return "databricks-claude-sonnet-4-6"


def _client():
    """Return a WorkspaceClient using the same auth logic as backend/db.py."""
    from databricks.sdk import WorkspaceClient  # noqa: PLC0415
    host = os.getenv("DATABRICKS_HOST")
    token = os.getenv("DATABRICKS_TOKEN")
    if host and token:
        return WorkspaceClient()
    profile = os.getenv("DATABRICKS_CONFIG_PROFILE", "fe-vm-clover-spatial")
    return WorkspaceClient(profile=profile)


def _rows_to_text(rows: list[Any], columns: list[str] | None = None) -> str:
    """Render up to _MAX_ROWS_PREVIEW rows as a compact text table."""
    sample = rows[:_MAX_ROWS_PREVIEW]
    if not sample:
        return "(no rows)"

    lines: list[str] = []
    if columns:
        lines.append(" | ".join(str(c) for c in columns))
        lines.append("-" * max(len(lines[0]), 10))

    for row in sample:
        if isinstance(row, (list, tuple)):
            lines.append(" | ".join(str(v) for v in row))
        elif isinstance(row, dict):
            lines.append(" | ".join(str(v) for v in row.values()))
        else:
            lines.append(str(row))

    if len(rows) > _MAX_ROWS_PREVIEW:
        lines.append(f"... ({len(rows) - _MAX_ROWS_PREVIEW} more rows)")

    return "\n".join(lines)


def _strip_dashes(text: str) -> str:
    """
    Remove em dashes and en dashes; replace space-dash-space with a semicolon.
    """
    # Replace en dash and em dash surrounded by spaces with semicolon.
    text = re.sub(r"\s+[--]\s+", "; ", text)
    # Remove any remaining em/en dashes.
    text = text.replace("—", "").replace("–", "")
    return text.strip()


def next_best_action(
    question: str,
    sql: str | None,
    rows: list,
    columns: list[str] | None = None,
) -> str:
    """
    Generate a single next-best-action sentence for a store-ops manager.

    Parameters
    ----------
    question:
        The natural-language question that was asked.
    sql:
        The generated SQL (included for context; may be None).
    rows:
        Result rows (list of lists or list of dicts).
    columns:
        Optional column names for the rows.

    Returns
    -------
    A single stripped sentence. Never raises.
    """
    endpoint = _serving_endpoint()

    rows_text = _rows_to_text(rows, columns)
    user_content = (
        f"Question: {question}\n\n"
        f"Query result:\n{rows_text}"
    )
    if sql:
        user_content = f"SQL: {sql}\n\n" + user_content

    try:
        from databricks.sdk.service.serving import ChatMessage, ChatMessageRole  # noqa: PLC0415
        w = _client()
        response = w.serving_endpoints.query(
            name=endpoint,
            messages=[
                ChatMessage(role=ChatMessageRole.SYSTEM, content=_SYSTEM_PROMPT),
                ChatMessage(role=ChatMessageRole.USER, content=user_content),
            ],
            max_tokens=_MAX_TOKENS,
        )
        choices = getattr(response, "choices", None) or []
        if choices:
            choice_msg = getattr(choices[0], "message", None)
            raw = (getattr(choice_msg, "content", None) or "") if choice_msg else ""
        else:
            raw = ""
        sentence = _strip_dashes(raw.strip())
        if sentence:
            return sentence
        return _FALLBACK_ACTION
    except Exception as exc:
        log.error("next_best_action: FM call failed: %s", exc)
        return _FALLBACK_ACTION


# ---- smoke test --------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)

    question = "Which stores are understaffed for tomorrow?"
    sql = "SELECT store_id, store_name, staffing_gap FROM clover_spatial_catalog.gold.staffing_forecast WHERE date = CURRENT_DATE + 1 AND staffing_gap > 0 ORDER BY staffing_gap DESC"
    rows = [
        ["S042", "Clover Harvard Sq", 12],
        ["S017", "Clover Kendall", 9],
        ["S031", "Clover Back Bay", 7],
    ]
    columns = ["store_id", "store_name", "staffing_gap"]

    print("Calling next_best_action...", flush=True)
    result = next_best_action(question, sql, rows, columns)
    print(result)
