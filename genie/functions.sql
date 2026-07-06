-- Governed, deterministic Unity Catalog functions for the Clover Store Ops
-- Genie space. These encode business rules (thresholds, gravity model) once,
-- as human-owned code, so Genie composes them in a fixed order rather than
-- inventing the math. Coordinates use x = longitude, y = latitude.
--
-- Idempotent: safe to re-run. Create in dependency order.

-- 1. distance_to: precise geodesic distance (meters) from a store to a point.
CREATE OR REPLACE FUNCTION clover_spatial_catalog.gold.distance_to(x DOUBLE, y DOUBLE, store_id STRING)
RETURNS DOUBLE
COMMENT 'Call this to calculate the precise distance between a store and a specific location, such as a competitor or landmark. x is longitude, y is latitude. Returns distance in meters.'
RETURN ST_DistanceSphere(
  ST_Point(
    (SELECT MAX(l.lon) FROM clover_spatial_catalog.gold.locations l WHERE l.store_id = distance_to.store_id),
    (SELECT MAX(l.lat) FROM clover_spatial_catalog.gold.locations l WHERE l.store_id = distance_to.store_id)
  ),
  ST_Point(distance_to.x, distance_to.y)
);

-- 2. in_trade_area: is a point inside / on the border of / outside a store trade area.
CREATE OR REPLACE FUNCTION clover_spatial_catalog.gold.in_trade_area(x DOUBLE, y DOUBLE, store_id STRING)
RETURNS STRING
COMMENT 'Call this to determine whether a specific location (e.g. a competitor or candidate site) falls inside, on the border of, or outside a store''s defined trade area. x is longitude, y is latitude. Returns inside, borderline, or outside.'
RETURN CASE
  WHEN clover_spatial_catalog.gold.distance_to(in_trade_area.x, in_trade_area.y, in_trade_area.store_id) <= 1609.34 THEN 'inside'
  WHEN clover_spatial_catalog.gold.distance_to(in_trade_area.x, in_trade_area.y, in_trade_area.store_id) <= 3218.69 THEN 'borderline'
  ELSE 'outside'
END;

-- 3. competitor_impact: 0..1 probability of diverted sales (distance + store pull).
CREATE OR REPLACE FUNCTION clover_spatial_catalog.gold.competitor_impact(x DOUBLE, y DOUBLE, store_id STRING)
RETURNS DOUBLE
COMMENT 'Call this when a user asks whether a competitor at a specific location is affecting, or likely to affect, a store''s sales. x is longitude, y is latitude. Combines distance and store attractiveness to estimate the probability of diverted sales. Returns a value from 0 (no impact) to 1 (high impact).'
RETURN ROUND(
  LEAST(1.0, GREATEST(0.0,
    EXP(- (clover_spatial_catalog.gold.distance_to(competitor_impact.x, competitor_impact.y, competitor_impact.store_id) / 1000.0) / 0.6)
    * (0.55 + 0.45 * (
        (SELECT MAX(o.recent_visits) FROM clover_spatial_catalog.gold.store_ops o WHERE o.store_id = competitor_impact.store_id)
        / (SELECT MAX(recent_visits) FROM clover_spatial_catalog.gold.store_ops)
      ))
  )), 4);

-- 4. impact_level: qualitative bucket for a 0..1 impact score.
CREATE OR REPLACE FUNCTION clover_spatial_catalog.gold.impact_level(effect_score DOUBLE)
RETURNS STRING
COMMENT 'Call this after computing a competitor impact score, a value from 0 to 1, to translate it into a qualitative impact level for store operators. Returns low, moderate, or high.'
RETURN CASE
  WHEN effect_score < 0.3 THEN 'low'
  WHEN effect_score < 0.6 THEN 'moderate'
  ELSE 'high'
END;

-- 5. distance_impact: qualitative bucket for a raw distance in miles.
CREATE OR REPLACE FUNCTION clover_spatial_catalog.gold.distance_impact(distance_miles DOUBLE)
RETURNS STRING
COMMENT 'Call this after computing distance to a competitor, to translate raw distance into a qualitative impact level for store operators. Returns large, moderate, or minimal.'
RETURN CASE
  WHEN distance_miles < 0.5 THEN 'large'
  WHEN distance_miles < 1.5 THEN 'moderate'
  ELSE 'minimal'
END;

-- 6. assess_competitor_impact: one composite call, human-fixed order.
--    Runs in_trade_area -> distance_to -> competitor_impact -> impact_level.
CREATE OR REPLACE FUNCTION clover_spatial_catalog.gold.assess_competitor_impact(x DOUBLE, y DOUBLE, store_id STRING)
RETURNS STRUCT<trade_area STRING, distance_m DOUBLE, distance_mi DOUBLE, impact_score DOUBLE, impact_level STRING>
COMMENT 'Call this to assess a competitor at a specific location against a store in one step. x is longitude, y is latitude. Runs the trade-area check, distance, impact score, and impact level in a fixed order. Returns a struct with trade_area, distance_m, distance_mi, impact_score, and impact_level.'
RETURN named_struct(
  'trade_area', clover_spatial_catalog.gold.in_trade_area(assess_competitor_impact.x, assess_competitor_impact.y, assess_competitor_impact.store_id),
  'distance_m', ROUND(clover_spatial_catalog.gold.distance_to(assess_competitor_impact.x, assess_competitor_impact.y, assess_competitor_impact.store_id), 1),
  'distance_mi', ROUND(clover_spatial_catalog.gold.distance_to(assess_competitor_impact.x, assess_competitor_impact.y, assess_competitor_impact.store_id) / 1609.34, 2),
  'impact_score', clover_spatial_catalog.gold.competitor_impact(assess_competitor_impact.x, assess_competitor_impact.y, assess_competitor_impact.store_id),
  'impact_level', clover_spatial_catalog.gold.impact_level(clover_spatial_catalog.gold.competitor_impact(assess_competitor_impact.x, assess_competitor_impact.y, assess_competitor_impact.store_id))
);
