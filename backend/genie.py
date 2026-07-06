"""
Genie Conversation API proxy.

Wraps the Databricks Genie Conversation API (start conversation / create message,
poll until COMPLETED, extract SQL + result rows) into a single callable function.

Authentication mirrors backend/db.py: profile-based locally, injected env vars
when running as a Databricks App.

Environment variables:
    DATABRICKS_CONFIG_PROFILE  default profile name (fallback: fe-vm-clover-spatial)
    DATABRICKS_HOST / DATABRICKS_TOKEN  injected inside a Databricks App
    GENIE_SPACE_ID             Genie space to query (fallback: reads genie/.space_id)
    GENIE_TIMEOUT_S            poll timeout in seconds (default: 45)
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path

from databricks.sdk.service.dashboards import MessageStatus

from backend.db import get_workspace_client

log = logging.getLogger(__name__)

# ---- constants ---------------------------------------------------------------

_SPACE_ID_FILE = Path(__file__).parent.parent / "genie" / ".space_id"
_FALLBACK_SPACE_ID = "01f170a989e81c3b9d492d6e298adf8b"
_POLL_SLEEP = 2.0  # seconds between status polls
_TERMINAL_OK = {MessageStatus.COMPLETED}
_TERMINAL_BAD = {MessageStatus.FAILED, MessageStatus.CANCELLED, MessageStatus.QUERY_RESULT_EXPIRED}

# Directive sent as a follow-up when Genie returns a text-only answer (no SQL).
_FORCE_SQL_DIRECTIVE = (
    "Answer the previous question by generating and running a SQL query over the gold tables"
    " and returning the result as a table. Respond with the SQL query and its result table only."
    " Do not reply with prose only and do not ask a clarifying question."
)


def _space_id() -> str:
    """Resolve the Genie space ID from env, file, or hardcoded fallback."""
    sid = os.getenv("GENIE_SPACE_ID", "").strip()
    if sid:
        return sid
    if _SPACE_ID_FILE.exists():
        sid = _SPACE_ID_FILE.read_text(encoding="utf-8").strip()
        if sid:
            return sid
    return _FALLBACK_SPACE_ID


def _timeout() -> float:
    try:
        return float(os.getenv("GENIE_TIMEOUT_S", "45"))
    except ValueError:
        return 45.0


def _empty_result(text: str, conversation_id: str = "") -> dict:
    return {
        "text": text,
        "sql": None,
        "columns": [],
        "rows": [],
        "conversation_id": conversation_id,
    }


# ---- polling and parsing helpers ---------------------------------------------

def _poll_message(w, space_id: str, conv_id: str, msg_id: str, timeout_s: float):
    """
    Poll a Genie message until it reaches a terminal status or timeout.

    Returns the final message object on COMPLETED, or a dict with key 'error'
    on failure/timeout (so callers can return gracefully without raising).
    """
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            msg = w.genie.get_message(
                space_id=space_id, conversation_id=conv_id, message_id=msg_id
            )
        except Exception as exc:
            log.error("Genie: get_message poll failed: %s", exc)
            return {"error": f"Genie poll error: {exc}"}

        status = getattr(msg, "status", None)
        if status in _TERMINAL_OK:
            return msg
        if status in _TERMINAL_BAD:
            err_obj = getattr(msg, "error", None)
            err_msg = getattr(err_obj, "message", str(err_obj)) if err_obj else str(status)
            log.warning("Genie: message ended with status %s: %s", status, err_msg)
            return {"error": f"Genie could not answer that question ({status})."}

        if time.monotonic() >= deadline:
            log.warning("Genie: timed out after %.0f s", timeout_s)
            return {"error": "Genie did not respond in time. Please try again."}

        time.sleep(_POLL_SLEEP)


def _parse_attachments(msg) -> tuple[str, str | None, str | None]:
    """
    Extract (combined_text, sql_query, query_attachment_id) from a message's attachments.
    """
    attachments = getattr(msg, "attachments", None) or []
    text_parts: list[str] = []
    sql_query: str | None = None
    query_attachment_id: str | None = None

    for att in attachments:
        text_att = getattr(att, "text", None)
        if text_att is not None:
            content = getattr(text_att, "content", None) or ""
            if content:
                text_parts.append(content)

        query_att = getattr(att, "query", None)
        if query_att is not None:
            sql_query = getattr(query_att, "query", None)
            query_attachment_id = (
                getattr(att, "attachment_id", None) or getattr(query_att, "id", None)
            )

    return "\n\n".join(text_parts).strip(), sql_query, query_attachment_id


# ---- public API --------------------------------------------------------------

def ask_genie(
    question: str,
    conversation_id: str | None = None,
    user_token: str | None = None,
) -> dict:
    """
    Ask Genie a question and return the structured response.

    Parameters
    ----------
    question:
        Natural-language question to send.
    conversation_id:
        If provided, add a message to the existing conversation.
        If None, start a new conversation.
    user_token:
        If provided, run the Genie conversation on behalf of the viewing user
        (OBO) instead of the app service principal.

    Returns
    -------
    dict with keys: text, sql, columns, rows, conversation_id.
    Never raises; returns a graceful error payload on any failure.
    """
    space_id = _space_id()
    timeout_s = _timeout()

    try:
        w = get_workspace_client(user_token=user_token)
    except Exception as exc:
        log.error("Genie: failed to build WorkspaceClient: %s", exc)
        return _empty_result(f"Could not connect to Databricks: {exc}")

    # Start or continue conversation (returns a Wait[GenieMessage] but we
    # use the underlying message_id and then poll manually so we control the
    # timeout precisely).
    try:
        if conversation_id is None:
            wait_obj = w.genie.start_conversation(space_id=space_id, content=question)
        else:
            wait_obj = w.genie.create_message(
                space_id=space_id, conversation_id=conversation_id, content=question
            )
        # The SDK Wait object exposes the initial response as .response
        msg = wait_obj.response if hasattr(wait_obj, "response") else wait_obj
    except Exception as exc:
        log.error("Genie: start/create message failed: %s", exc)
        return _empty_result(f"Genie request failed: {exc}")

    conv_id: str = getattr(msg, "conversation_id", "") or ""
    msg_id: str = getattr(msg, "message_id", "") or getattr(msg, "id", "") or ""

    if not conv_id or not msg_id:
        log.error("Genie: missing conversation_id or message_id in response: %s", msg)
        return _empty_result("Genie returned an unexpected response.", conv_id)

    # Poll until terminal status or timeout.
    msg = _poll_message(w, space_id, conv_id, msg_id, timeout_s)
    if isinstance(msg, dict) and "error" in msg:
        return _empty_result(msg["error"], conv_id)

    # Extract text and SQL from attachments.
    combined_text, sql_query, query_attachment_id = _parse_attachments(msg)

    # Diagnostic: what did Genie attach under this identity/token? (WARNING so it surfaces in app logs)
    attachments = getattr(msg, "attachments", None) or []
    log.warning(
        "DIAG Genie attachments: count=%d kinds=%s sql_found=%s attach_id=%s obo=%s text_preview=%r",
        len(attachments),
        [("query" if getattr(a, "query", None) else "text" if getattr(a, "text", None) else "other") for a in attachments],
        bool(sql_query),
        bool(query_attachment_id),
        bool(user_token),
        combined_text[:80],
    )

    # One-shot forcing retry: if Genie returned text only (no SQL), send a
    # follow-up directive in the same conversation to demand a SQL + table answer.
    if sql_query is None or query_attachment_id is None:
        log.warning(
            "DIAG Genie retry: first answer was text-only - sending _FORCE_SQL_DIRECTIVE"
        )
        first_text = combined_text  # preserve for potential use below

        try:
            retry_wait = w.genie.create_message(
                space_id=space_id, conversation_id=conv_id, content=_FORCE_SQL_DIRECTIVE
            )
            retry_msg_init = (
                retry_wait.response if hasattr(retry_wait, "response") else retry_wait
            )
            retry_msg_id: str = (
                getattr(retry_msg_init, "message_id", "")
                or getattr(retry_msg_init, "id", "")
                or ""
            )
        except Exception as exc:
            log.error("Genie: retry create_message failed: %s", exc)
            # Fall through to text-only return below
            retry_msg_id = ""

        if retry_msg_id:
            retry_msg = _poll_message(w, space_id, conv_id, retry_msg_id, timeout_s)
            if not (isinstance(retry_msg, dict) and "error" in retry_msg):
                retry_text, retry_sql, retry_attach_id = _parse_attachments(retry_msg)
                log.warning(
                    "DIAG Genie retry result: sql_found=%s attach_id=%s",
                    bool(retry_sql),
                    bool(retry_attach_id),
                )
                if retry_sql is not None and retry_attach_id is not None:
                    # Retry produced SQL: use it. Prefer first answer's text if non-empty.
                    effective_text = first_text if first_text else retry_text
                    sql_query = retry_sql
                    query_attachment_id = retry_attach_id
                    msg_id = retry_msg_id
                    combined_text = effective_text

    if sql_query is None or query_attachment_id is None:
        # Text-only answer after retry (or retry not attempted/failed).
        return {
            "text": combined_text,
            "sql": None,
            "columns": [],
            "rows": [],
            "conversation_id": conv_id,
        }

    # Fetch query result rows.
    columns: list[str] = []
    rows: list[list] = []
    try:
        result_resp = w.genie.get_message_attachment_query_result(
            space_id=space_id,
            conversation_id=conv_id,
            message_id=msg_id,
            attachment_id=query_attachment_id,
        )
        stmt_resp = getattr(result_resp, "statement_response", None)
        if stmt_resp is not None:
            manifest = getattr(stmt_resp, "manifest", None)
            result = getattr(stmt_resp, "result", None)
            if manifest and result:
                schema = getattr(manifest, "schema", None)
                schema_cols = getattr(schema, "columns", None) or []
                columns = [getattr(c, "name", str(i)) for i, c in enumerate(schema_cols)]
                data_array = getattr(result, "data_array", None) or []
                rows = [list(row) for row in data_array]
    except Exception as exc:
        log.warning("Genie: could not fetch query result rows: %s", exc)
        # Return what we have without rows.

    return {
        "text": combined_text,
        "sql": sql_query,
        "columns": columns,
        "rows": rows,
        "conversation_id": conv_id,
    }


# ---- smoke test --------------------------------------------------------------

if __name__ == "__main__":
    import json
    import sys

    logging.basicConfig(level=logging.INFO, stream=sys.stderr)

    question = "Which stores are understaffed for tomorrow?"
    print(f"Asking Genie: {question!r}", flush=True)
    result = ask_genie(question)
    print(json.dumps(result, indent=2, default=str))
