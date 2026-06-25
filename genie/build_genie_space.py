#!/usr/bin/env python3
"""
build_genie_space.py

Create or update the "Clover Store Ops" Genie space over the gold tables.

Usage (from project root):
    python -m genie.build_genie_space

Environment / CLI profile:
    DATABRICKS_CONFIG_PROFILE  (default: fe-vm-clover-spatial)
    GENIE_SPACE_ID             optional: if set, patch that space instead of creating

Outputs:
    genie/.space_id   written with the returned space_id
    stdout            space_id is printed on success
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# ---- paths ----------------------------------------------------------------

HERE = Path(__file__).parent
SPACE_DEF_PATH = HERE / "genie_space.json"
SPACE_ID_PATH = HERE / ".space_id"
BUILDER_DIR = Path.home() / ".vibe/marketplace/plugins/fe-internal-tools/skills/genie-rooms/resources"

# ---- config ---------------------------------------------------------------

PROFILE = os.environ.get("DATABRICKS_CONFIG_PROFILE", "fe-vm-clover-spatial")
WAREHOUSE_ID = os.environ.get("GENIE_WAREHOUSE_ID", "f8b3878560d8debf")
PARENT_PATH = os.environ.get(
    "GENIE_PARENT_PATH",
    "/Workspace/Users/jonathan.whiteley@databricks.com",
)


# ---- helpers ---------------------------------------------------------------

def _run_api(method: str, path: str, payload: dict | None = None) -> dict:
    """Thin wrapper around `databricks api <method> <path> --profile ...`."""
    cmd = ["databricks", "api", method, path, "--profile", PROFILE, "--output", "json"]
    if payload is not None:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as tmp:
            json.dump(payload, tmp)
            tmp_path = tmp.name
        cmd += ["--json", f"@{tmp_path}"]
    else:
        tmp_path = None

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    if result.returncode != 0:
        raise RuntimeError(
            f"databricks api {method} {path} failed (exit {result.returncode}):\n"
            f"  stdout: {result.stdout.strip()}\n"
            f"  stderr: {result.stderr.strip()}"
        )

    raw = result.stdout.strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Could not parse API response as JSON: {exc}\nRaw: {raw[:500]}") from exc


def _build_serialized_space() -> str:
    """Build the serialized_space JSON string using GenieSpaceBuilder."""
    sys.path.insert(0, str(BUILDER_DIR))
    from genie_space_builder import GenieSpaceBuilder  # noqa: PLC0415

    defn = json.loads(SPACE_DEF_PATH.read_text(encoding="utf-8"))

    space = GenieSpaceBuilder(
        title=defn["title"],
        description=defn["description"],
        warehouse_id=WAREHOUSE_ID,
    )

    space.set_instructions(defn["general_instructions"])

    for tbl in defn["tables"]:
        space.add_table(tbl)

    for query in defn["sample_queries"]:
        space.add_example_sql(title=query["title"], sql=query["sql"])

    space.validate()

    # The Genie API requires example_question_sqls to be sorted by id.
    # to_dict() does not guarantee this order, so sort in-place here.
    space_dict = space.to_dict()
    example_sqls = (
        space_dict.get("instructions", {}).get("example_question_sqls", [])
    )
    if isinstance(example_sqls, list):
        example_sqls.sort(key=lambda e: e.get("id", ""))
    import json as _json
    return _json.dumps(space_dict, indent=2)


def _create_space(serialized_space: str) -> str:
    """POST to create a new Genie space; return the space_id."""
    payload = {
        "title": json.loads(SPACE_DEF_PATH.read_text(encoding="utf-8"))["title"],
        "description": json.loads(SPACE_DEF_PATH.read_text(encoding="utf-8"))["description"],
        "parent_path": PARENT_PATH,
        "warehouse_id": WAREHOUSE_ID,
        "serialized_space": serialized_space,
    }
    response = _run_api("post", "/api/2.0/genie/spaces", payload)
    space_id = response.get("space_id") or response.get("id")
    if not space_id:
        raise RuntimeError(f"create did not return a space_id. Response: {response}")
    return space_id


def _update_space(space_id: str, serialized_space: str) -> str:
    """PATCH an existing Genie space; return the space_id."""
    defn = json.loads(SPACE_DEF_PATH.read_text(encoding="utf-8"))
    payload = {
        "title": defn["title"],
        "description": defn["description"],
        "warehouse_id": WAREHOUSE_ID,
        "serialized_space": serialized_space,
    }
    response = _run_api("patch", f"/api/2.0/genie/spaces/{space_id}", payload)
    return response.get("space_id") or response.get("id") or space_id


def main() -> None:
    print(f"[build_genie_space] profile={PROFILE}  warehouse={WAREHOUSE_ID}")

    # check for an existing space_id to update (env var takes precedence, then file)
    existing_space_id = os.environ.get("GENIE_SPACE_ID", "").strip()
    if not existing_space_id and SPACE_ID_PATH.exists():
        existing_space_id = SPACE_ID_PATH.read_text(encoding="utf-8").strip()

    print("[build_genie_space] building serialized_space ...")
    serialized_space = _build_serialized_space()
    print(f"[build_genie_space] serialized_space length: {len(serialized_space)} chars")

    if existing_space_id:
        print(f"[build_genie_space] updating existing space: {existing_space_id}")
        space_id = _update_space(existing_space_id, serialized_space)
        print(f"[build_genie_space] updated space_id: {space_id}")
    else:
        print("[build_genie_space] creating new space ...")
        space_id = _create_space(serialized_space)
        print(f"[build_genie_space] created space_id: {space_id}")

    SPACE_ID_PATH.write_text(space_id, encoding="utf-8")
    print(f"[build_genie_space] space_id written to {SPACE_ID_PATH}")
    print(f"\nSPACE_ID={space_id}")


if __name__ == "__main__":
    main()
