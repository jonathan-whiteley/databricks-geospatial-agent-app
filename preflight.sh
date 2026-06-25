#!/usr/bin/env bash
set -euo pipefail
P=fe-vm-clover-spatial
echo "== identity =="; databricks current-user me --profile=$P -o json | python3 -c "import sys,json;print(json.load(sys.stdin)['userName'])"
echo "== warehouse =="; databricks warehouses list --profile=$P | head -5
echo "== CREATE SCHEMA test =="
WID=$(databricks warehouses list --profile=$P -o json | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
echo "warehouse_id=$WID"
databricks api post /api/2.0/sql/statements --profile=$P --json "{\"warehouse_id\":\"$WID\",\"statement\":\"CREATE SCHEMA IF NOT EXISTS clover_spatial_catalog.gold\",\"wait_timeout\":\"30s\"}" -o json | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['status'].get('state'))"
echo "== serving endpoint =="; databricks serving-endpoints get databricks-claude-sonnet-4-6 --profile=$P -o json | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['name'],d.get('state'))" || echo "MISSING databricks-claude-sonnet-4-6"
echo "== genie create capability (list) =="; databricks api get /api/2.0/genie/spaces --profile=$P -o json | head -c 300 || echo "genie list not available"
