-- build_forecast_fallback.sql
-- DOW-seasonal mean fallback for when ai_forecast is unavailable.
--
-- For each store: compute mean visits by day-of-week over the trailing 8 weeks,
-- then forecast for (max_date + 1) by matching that date's DOW.
-- dayofweek() in Spark SQL: 1=Sunday, 2=Monday, ..., 7=Saturday
-- foot_traffic_daily.dow: 1=Monday, ..., 7=Sunday (isoweekday)
-- Mapping: Spark dayofweek -> iso dow: 1->7, 2->1, 3->2, 4->3, 5->4, 6->5, 7->6

CREATE OR REPLACE TABLE clover_spatial_catalog.gold.store_forecast AS
WITH
latest AS (
    SELECT store_id, MAX(date) AS max_date
    FROM clover_spatial_catalog.gold.foot_traffic_daily
    GROUP BY store_id
),
window_8w AS (
    SELECT
        f.store_id,
        f.dow,
        f.visits
    FROM clover_spatial_catalog.gold.foot_traffic_daily f
    JOIN latest l ON f.store_id = l.store_id
    WHERE CAST(f.date AS DATE) > date_sub(CAST(l.max_date AS DATE), 57)
      AND CAST(f.date AS DATE) <= CAST(l.max_date AS DATE)
),
dow_means AS (
    SELECT
        store_id,
        dow,
        CAST(ROUND(AVG(visits)) AS INT) AS mean_visits
    FROM window_8w
    GROUP BY store_id, dow
),
next_dow AS (
    SELECT
        l.store_id,
        CASE dayofweek(date_add(CAST(l.max_date AS DATE), 1))
            WHEN 1 THEN 7
            WHEN 2 THEN 1
            WHEN 3 THEN 2
            WHEN 4 THEN 3
            WHEN 5 THEN 4
            WHEN 6 THEN 5
            WHEN 7 THEN 6
        END AS next_dow
    FROM latest l
)
SELECT
    d.store_id,
    COALESCE(m.mean_visits, 0) AS forecast_visits
FROM next_dow d
LEFT JOIN dow_means m
    ON d.store_id = m.store_id
   AND d.next_dow = m.dow;
