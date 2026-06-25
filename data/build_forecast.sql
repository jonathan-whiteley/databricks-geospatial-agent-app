-- build_forecast.sql
-- MUST run on SQL warehouse (ai_forecast unsupported on serverless notebook compute)
--
-- Builds gold.store_forecast using ai_forecast over the trailing 56-day window
-- (8 weeks of daily aggregated visits per store, horizon 1).
--
-- Fallback (DOW-seasonal mean) is used when ai_forecast is unavailable:
--   For each store, compute the mean visits by day-of-week over the trailing
--   8 weeks, then pick the DOW matching (max_date + 1) as the forecast_visits.
--   See build_views.py for the try/except that selects between the two SQL blocks.

-- Primary: ai_forecast-based forecast.
CREATE OR REPLACE TABLE clover_spatial_catalog.gold.store_forecast AS
WITH
trailing AS (
    SELECT
        store_id,
        date,
        visits
    FROM clover_spatial_catalog.gold.foot_traffic_daily
),
latest AS (
    SELECT store_id, MAX(date) AS max_date
    FROM trailing
    GROUP BY store_id
),
window_8w AS (
    SELECT
        t.store_id,
        CAST(t.date AS DATE)      AS ds,
        CAST(t.visits AS DOUBLE)  AS y
    FROM trailing t
    JOIN latest l ON t.store_id = l.store_id
    WHERE CAST(t.date AS DATE) > date_sub(CAST(l.max_date AS DATE), 57)
      AND CAST(t.date AS DATE) <= CAST(l.max_date AS DATE)
),
forecasted AS (
    SELECT
        store_id,
        ai_forecast(ds, y, horizon => 1) AS fc
    FROM window_8w
    GROUP BY store_id
),
exploded AS (
    SELECT
        store_id,
        inline(fc)
    FROM forecasted
)
SELECT
    store_id,
    CAST(ROUND(forecast) AS INT) AS forecast_visits
FROM exploded;
