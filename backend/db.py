"""
Shared SQL helper using the Databricks SDK Statement Execution API.

Authentication: profile-based locally (DATABRICKS_CONFIG_PROFILE env var or
hardcoded fallback), default credential chain when deployed as a Databricks App.
"""

import os
import time

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.sql import StatementState


_TYPE_CASTERS = {
    "INT": int,
    "INTEGER": int,
    "LONG": int,
    "BIGINT": int,
    "SHORT": int,
    "SMALLINT": int,
    "TINYINT": int,
    "BYTE": int,
    "FLOAT": float,
    "DOUBLE": float,
    "DECIMAL": float,
    "NUMERIC": float,
    "BOOLEAN": lambda v: v if isinstance(v, bool) else (v.lower() == "true" if isinstance(v, str) else bool(v)),
}

_POLL_INTERVAL = 1.0  # seconds between polls when statement is PENDING/RUNNING


def _client(profile: str | None = None, user_token: str | None = None) -> WorkspaceClient:
    """
    Return a WorkspaceClient.

    When user_token is supplied it always takes top priority: the client is
    built against DATABRICKS_HOST with that token so calls run on behalf of the
    viewing user (OBO authentication via the X-Forwarded-Access-Token header).

    When a profile is explicitly supplied it takes precedence over env defaults.
    Otherwise: uses explicit profile when DATABRICKS_CONFIG_PROFILE is set or
    when DATABRICKS_HOST / DATABRICKS_TOKEN are absent (i.e., not running as a
    Databricks App with injected credentials).
    """
    if user_token is not None:
        # On-behalf-of-user: run as the viewing user, not the app SP.
        # In Databricks Apps DATABRICKS_HOST may be a bare hostname (no scheme);
        # the SDK needs a full https:// URL, so normalize it.
        host = os.environ["DATABRICKS_HOST"]
        if not host.startswith("http"):
            host = f"https://{host}"
        # The Apps runtime also injects DATABRICKS_CLIENT_ID/SECRET (the app SP
        # OAuth creds). If we only pass token=, the SDK auto-detects those env
        # vars too and errors with "more than one authorization method
        # configured: oauth and pat". Force PAT-only auth so the user token wins.
        return WorkspaceClient(host=host, token=user_token, auth_type="pat")

    if profile is not None:
        return WorkspaceClient(profile=profile)

    host = os.getenv("DATABRICKS_HOST")
    token = os.getenv("DATABRICKS_TOKEN")
    env_profile = os.getenv("DATABRICKS_CONFIG_PROFILE", "fe-vm-clover-spatial")

    if host and token:
        # Running inside Databricks App - use injected env vars directly.
        return WorkspaceClient()
    return WorkspaceClient(profile=env_profile)


def get_workspace_client(profile: str | None = None, user_token: str | None = None) -> WorkspaceClient:
    """Public wrapper around _client(); returns a WorkspaceClient."""
    return _client(profile, user_token=user_token)


def _warehouse_id() -> str:
    return os.getenv("DATABRICKS_WAREHOUSE_ID", "f8b3878560d8debf")


def run_sql(statement: str, profile: str | None = None, user_token: str | None = None) -> list[dict]:
    """
    Execute a SQL statement and return a list of row dicts.

    When user_token is provided, runs the statement on behalf of the viewing
    user (OBO). When profile is provided, constructs the WorkspaceClient with
    that profile (overriding any env/default). When both are None, uses the
    default credential chain.

    Waits up to ~50 s for the statement to complete (wait_timeout="50s").
    Falls back to polling if the warehouse responds PENDING or RUNNING.
    Raises RuntimeError on FAILED or CANCELLED.
    Returns an empty list for statements that produce no rows.
    """
    w = _client(profile, user_token=user_token)
    wh_id = _warehouse_id()

    resp = w.statement_execution.execute_statement(
        warehouse_id=wh_id,
        statement=statement,
        wait_timeout="50s",
    )

    # Poll until terminal state.
    while resp.status.state in (StatementState.PENDING, StatementState.RUNNING):
        time.sleep(_POLL_INTERVAL)
        resp = w.statement_execution.get_statement(resp.statement_id)

    if resp.status.state in (StatementState.FAILED, StatementState.CANCELED):
        err = (resp.status.error.message if resp.status.error else "unknown error")
        raise RuntimeError(f"SQL statement failed: {err}\nSQL: {statement[:500]}")

    # No result set (DDL / DML with no SELECT).
    if resp.result is None or resp.result.data_array is None:
        return []

    manifest = resp.manifest
    columns = manifest.schema.columns if manifest and manifest.schema else []
    col_names = [c.name for c in columns]
    col_types = [c.type_name.value if c.type_name else None for c in columns]

    rows = []
    for raw_row in resp.result.data_array:
        row = {}
        for name, type_name, value in zip(col_names, col_types, raw_row):
            if value is None:
                row[name] = None
            elif type_name and type_name.upper() in _TYPE_CASTERS:
                try:
                    row[name] = _TYPE_CASTERS[type_name.upper()](value)
                except (ValueError, TypeError):
                    row[name] = value
            else:
                row[name] = value
        rows.append(row)

    return rows


def exec_sql(statement: str, profile: str | None = None, user_token: str | None = None) -> None:
    """
    Execute a SQL statement and discard results.

    When user_token is provided, runs the statement on behalf of the viewing
    user (OBO). When profile is provided, constructs the WorkspaceClient with
    that profile (overriding any env/default). When both are None, uses the
    default credential chain.

    Useful for DDL (CREATE TABLE, DROP TABLE, etc.) and DML (INSERT, MERGE).
    """
    w = _client(profile, user_token=user_token)
    wh_id = _warehouse_id()

    resp = w.statement_execution.execute_statement(
        warehouse_id=wh_id,
        statement=statement,
        wait_timeout="50s",
    )

    while resp.status.state in (StatementState.PENDING, StatementState.RUNNING):
        time.sleep(_POLL_INTERVAL)
        resp = w.statement_execution.get_statement(resp.statement_id)

    if resp.status.state in (StatementState.FAILED, StatementState.CANCELED):
        err = (resp.status.error.message if resp.status.error else "unknown error")
        raise RuntimeError(f"SQL statement failed: {err}\nSQL: {statement[:500]}")
