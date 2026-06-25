from datetime import date

PROFILE = "fe-vm-clover-spatial"
CATALOG = "clover_spatial_catalog"
GOLD_SCHEMA = "gold"
BRONZE = "clover_spatial_catalog.bronze"
GOLD = "clover_spatial_catalog.gold"
CLOVER_SEED = 42
TARGET_VISITS_PER_HOUR = 165
STAFFING_GAP_THRESHOLD = 8
METRO_CENTER = (42.3601, -71.0589)
METRO_ZOOM = 11
SERVING_ENDPOINT = "databricks-claude-sonnet-4-6"

# The bronze foot_traffic_daily max date. Synthetic series end here and all
# days_ago are relative to this, so real and synthetic stores share an aligned
# recent window.
ANCHOR_DATE = date(2026, 6, 15)
