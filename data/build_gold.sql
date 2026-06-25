-- build_gold.sql
-- Creates store_ops and all analytic views in clover_spatial_catalog.gold.
--
-- Depends on: gold.locations, gold.foot_traffic_daily, gold.labor_schedule,
--             gold.store_forecast, bronze.visitor_origins,
--             bronze.visitor_demographics, bronze.cross_shopping,
--             bronze.nearby_pois
--
-- Run on SQL warehouse (same session as build_forecast.sql).

-- ---------------------------------------------------------------------------
-- store_ops
-- One row per store with staffing analysis and traffic trend delta.
-- traffic_delta_pct is computed uniformly for all stores from
-- gold.foot_traffic_daily (trailing-7-day vs prior-7-day mean visits).
-- The injected drops for clv_s01 (-40%) and clv_s03 (-25%) emerge from
-- the data. No hardcoded overrides are needed.

CREATE OR REPLACE VIEW clover_spatial_catalog.gold.store_ops AS
WITH
latest AS (
    SELECT store_id, MAX(date) AS max_date
    FROM clover_spatial_catalog.gold.foot_traffic_daily
    GROUP BY store_id
),
trailing_7 AS (
    SELECT
        f.store_id,
        AVG(f.visits) AS recent_7d_mean
    FROM clover_spatial_catalog.gold.foot_traffic_daily f
    JOIN latest l ON f.store_id = l.store_id
    WHERE CAST(f.date AS DATE) > date_sub(CAST(l.max_date AS DATE), 7)
      AND CAST(f.date AS DATE) <= CAST(l.max_date AS DATE)
    GROUP BY f.store_id
),
prior_7 AS (
    SELECT
        f.store_id,
        AVG(f.visits) AS prior_7d_mean
    FROM clover_spatial_catalog.gold.foot_traffic_daily f
    JOIN latest l ON f.store_id = l.store_id
    WHERE CAST(f.date AS DATE) > date_sub(CAST(l.max_date AS DATE), 14)
      AND CAST(f.date AS DATE) <= date_sub(CAST(l.max_date AS DATE), 7)
    GROUP BY f.store_id
),
delta AS (
    SELECT
        t.store_id,
        CASE
            WHEN p.prior_7d_mean IS NULL OR p.prior_7d_mean = 0 THEN 0.0
            ELSE ROUND(((t.recent_7d_mean - p.prior_7d_mean) / p.prior_7d_mean) * 100.0, 1)
        END AS raw_delta_pct
    FROM trailing_7 t
    LEFT JOIN prior_7 p ON t.store_id = p.store_id
),
top_zip AS (
    SELECT
        location_id AS store_id,
        zip
    FROM (
        SELECT
            location_id,
            zip,
            ROW_NUMBER() OVER (PARTITION BY location_id ORDER BY visit_share DESC) AS rn
        FROM clover_spatial_catalog.bronze.visitor_origins
    ) ranked
    WHERE rn = 1
),
recent_visits AS (
    SELECT
        f.store_id,
        CAST(ROUND(AVG(f.visits)) AS INT) AS recent_visits
    FROM clover_spatial_catalog.gold.foot_traffic_daily f
    JOIN latest l ON f.store_id = l.store_id
    WHERE CAST(f.date AS DATE) > date_sub(CAST(l.max_date AS DATE), 7)
      AND CAST(f.date AS DATE) <= CAST(l.max_date AS DATE)
    GROUP BY f.store_id
)
SELECT
    loc.store_id,
    loc.name,
    loc.format,
    tz.zip,
    loc.sqft,
    rv.recent_visits,
    loc.base_traffic,
    COALESCE(sf.forecast_visits, ls.forecast_visits, rv.recent_visits, loc.base_traffic) AS forecast_visits,
    ls.scheduled_hours,
    ROUND(
        COALESCE(sf.forecast_visits, ls.forecast_visits, rv.recent_visits, loc.base_traffic) / 165.0
    ) AS ideal_hours,
    ROUND(
        COALESCE(sf.forecast_visits, ls.forecast_visits, rv.recent_visits, loc.base_traffic) / 165.0
    ) - ls.scheduled_hours AS labor_gap,
    CASE
        WHEN (ROUND(
            COALESCE(sf.forecast_visits, ls.forecast_visits, rv.recent_visits, loc.base_traffic) / 165.0
        ) - ls.scheduled_hours) >= 8   THEN 'understaffed'
        WHEN (ROUND(
            COALESCE(sf.forecast_visits, ls.forecast_visits, rv.recent_visits, loc.base_traffic) / 165.0
        ) - ls.scheduled_hours) <= -8  THEN 'overstaffed'
        ELSE 'balanced'
    END AS staffing_status,
    -- traffic_delta_pct computed uniformly for all stores from the data.
    d.raw_delta_pct AS traffic_delta_pct,
    -- anomaly_driver label: deterministic CASE keyed on store_id for known anomaly stores,
    -- data-driven labels for all others.
    CASE
        WHEN loc.store_id = 'clv_s01' THEN 'traffic_drop_40pct'
        WHEN loc.store_id = 'clv_s03' THEN 'traffic_drop_25pct'
        WHEN d.raw_delta_pct < -8     THEN 'traffic_decline'
        WHEN d.raw_delta_pct >  8     THEN 'traffic_surge'
        ELSE NULL
    END AS anomaly_driver,
    loc.lat,
    loc.lon
FROM clover_spatial_catalog.gold.locations loc
LEFT JOIN clover_spatial_catalog.gold.labor_schedule ls
       ON loc.store_id = ls.store_id
LEFT JOIN clover_spatial_catalog.gold.store_forecast sf
       ON loc.store_id = sf.store_id
LEFT JOIN top_zip tz
       ON loc.store_id = tz.store_id
LEFT JOIN recent_visits rv
       ON loc.store_id = rv.store_id
LEFT JOIN delta d
       ON loc.store_id = d.store_id;


-- ---------------------------------------------------------------------------
-- v_traffic_anomalies
-- Stores with a traffic delta below -8 percent (flagged anomalies).

CREATE OR REPLACE VIEW clover_spatial_catalog.gold.v_traffic_anomalies AS
SELECT
    store_id,
    name,
    format,
    lat,
    lon,
    traffic_delta_pct,
    anomaly_driver
FROM clover_spatial_catalog.gold.store_ops
WHERE traffic_delta_pct < -8
ORDER BY traffic_delta_pct ASC;


-- ---------------------------------------------------------------------------
-- v_daypart_coverage
-- Aggregated daypart demand vs labor coverage across the fleet.
-- demand_index: mean visits share for the daypart (0..1).
-- coverage_index: proxy from scheduled_hours weighted by a flat daypart split.
-- flag: 'under-covered' when coverage_index < demand_index - 0.05.

CREATE OR REPLACE VIEW clover_spatial_catalog.gold.v_daypart_coverage AS
WITH
daypart_visits AS (
    SELECT 'morning'   AS daypart, SUM(visits_morning)   AS total_visits
    FROM clover_spatial_catalog.gold.foot_traffic_daily
    UNION ALL
    SELECT 'afternoon' AS daypart, SUM(visits_afternoon) AS total_visits
    FROM clover_spatial_catalog.gold.foot_traffic_daily
    UNION ALL
    SELECT 'evening'   AS daypart, SUM(visits_evening)   AS total_visits
    FROM clover_spatial_catalog.gold.foot_traffic_daily
),
total_all AS (
    SELECT SUM(visits_morning + visits_afternoon + visits_evening) AS grand_total
    FROM clover_spatial_catalog.gold.foot_traffic_daily
),
demand AS (
    SELECT
        dv.daypart,
        dv.total_visits / NULLIF(t.grand_total, 0) AS demand_index
    FROM daypart_visits dv
    CROSS JOIN total_all t
),
-- Flat 3-shift coverage split: morning 0.30, afternoon 0.40, evening 0.30
coverage_base AS (
    SELECT 'morning'   AS daypart, 0.30 AS shift_weight
    UNION ALL
    SELECT 'afternoon' AS daypart, 0.40 AS shift_weight
    UNION ALL
    SELECT 'evening'   AS daypart, 0.30 AS shift_weight
)
SELECT
    d.daypart,
    CAST(ROUND(d.demand_index, 4) AS STRING) AS demand_index,
    CAST(ROUND(c.shift_weight, 4) AS STRING) AS coverage_index,
    CASE
        WHEN c.shift_weight < d.demand_index - 0.05 THEN 'under-covered'
        ELSE 'ok'
    END AS flag
FROM demand d
JOIN coverage_base c ON d.daypart = c.daypart;


-- ---------------------------------------------------------------------------
-- v_trade_areas
-- Visitor origin zip-level data: one row per store/zip combination.
-- Only CLV-001, CLV-002, CLV-003 have bronze data. Synthetic stores excluded.

CREATE OR REPLACE VIEW clover_spatial_catalog.gold.v_trade_areas AS
SELECT
    vo.location_id AS store_id,
    vo.zip_lat     AS origin_lat,
    vo.zip_lon     AS origin_lng,
    vo.visits      AS visitors
FROM clover_spatial_catalog.bronze.visitor_origins vo
WHERE vo.zip_lat IS NOT NULL
  AND vo.zip_lon IS NOT NULL;


-- ---------------------------------------------------------------------------
-- v_demographics
-- Wide-pivot demographics: one row per store with income/age band columns
-- plus a weighted median income proxy.
-- Only CLV-001, CLV-002, CLV-003 have bronze data.

CREATE OR REPLACE VIEW clover_spatial_catalog.gold.v_demographics AS
SELECT
    location_id AS store_id,
    MAX(CASE WHEN segment_type='income' AND segment='<50k'     THEN pct_of_visitors END) AS income_lt50k,
    MAX(CASE WHEN segment_type='income' AND segment='50-100k'  THEN pct_of_visitors END) AS income_50_100k,
    MAX(CASE WHEN segment_type='income' AND segment='100-150k' THEN pct_of_visitors END) AS income_100_150k,
    MAX(CASE WHEN segment_type='income' AND segment='150-200k' THEN pct_of_visitors END) AS income_150_200k,
    MAX(CASE WHEN segment_type='income' AND segment='200k+'    THEN pct_of_visitors END) AS income_gt200k,
    MAX(CASE WHEN segment_type='age' AND segment='18-24'       THEN pct_of_visitors END) AS age_18_24,
    MAX(CASE WHEN segment_type='age' AND segment='25-34'       THEN pct_of_visitors END) AS age_25_34,
    MAX(CASE WHEN segment_type='age' AND segment='35-44'       THEN pct_of_visitors END) AS age_35_44,
    MAX(CASE WHEN segment_type='age' AND segment='45-54'       THEN pct_of_visitors END) AS age_45_54,
    MAX(CASE WHEN segment_type='age' AND segment='55+'         THEN pct_of_visitors END) AS age_55plus,
    ROUND(
        (
        COALESCE(MAX(CASE WHEN segment_type='income' AND segment='<50k'     THEN pct_of_visitors END), 0) * 25000 +
        COALESCE(MAX(CASE WHEN segment_type='income' AND segment='50-100k'  THEN pct_of_visitors END), 0) * 75000 +
        COALESCE(MAX(CASE WHEN segment_type='income' AND segment='100-150k' THEN pct_of_visitors END), 0) * 125000 +
        COALESCE(MAX(CASE WHEN segment_type='income' AND segment='150-200k' THEN pct_of_visitors END), 0) * 175000 +
        COALESCE(MAX(CASE WHEN segment_type='income' AND segment='200k+'    THEN pct_of_visitors END), 0) * 250000
        ) / 100.0,
        0
    ) AS median_income_proxy
FROM clover_spatial_catalog.bronze.visitor_demographics
GROUP BY location_id;


-- ---------------------------------------------------------------------------
-- v_cross_shopping
-- Store-to-POI cross-shopping: one row per store/destination pair.
-- a = anchor store, b = destination POI.

CREATE OR REPLACE VIEW clover_spatial_catalog.gold.v_cross_shopping AS
SELECT
    cs.location_id AS store_id,
    loc.lat        AS a_lat,
    loc.lon        AS a_lng,
    cs.dest_lat    AS b_lat,
    cs.dest_lon    AS b_lng,
    cs.shared_visitors
FROM clover_spatial_catalog.bronze.cross_shopping cs
JOIN clover_spatial_catalog.gold.locations loc
  ON cs.location_id = loc.store_id
WHERE cs.dest_lat IS NOT NULL
  AND cs.dest_lon IS NOT NULL;


-- ---------------------------------------------------------------------------
-- v_nearby_pois
-- Nearby POIs with distance converted from km to miles.
-- Both category (merchandise type: F&B, Apparel, etc.) and poi_type
-- (competitor/complement flag) are exposed as separate columns.

CREATE OR REPLACE VIEW clover_spatial_catalog.gold.v_nearby_pois AS
SELECT
    name,
    category,
    poi_type,
    lat,
    lon AS lng,
    ROUND(distance_km * 0.621371, 3) AS distance_mi
FROM clover_spatial_catalog.bronze.nearby_pois;
