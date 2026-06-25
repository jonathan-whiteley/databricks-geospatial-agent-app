# Clover Geospatial - SDD progress ledger
Plan: docs/plans/2026-06-24-clover-geospatial.md
Branch: build
Task 0: complete (commits e23e364..47c4736, review clean)
Task 1: complete (commits 47c4736..88f2083, review clean after 1 fix)
  minor-followups: name _SERIES_START_DATE; test_schedule_creates_gap only asserts >0
Task 2: complete (commits 88f2083..5a58cda, review clean after 1 fix)
  minor-followup: run_sql/exec_sql share polling logic (dedup candidate)
Task 3: complete (commits 5a58cda..c0f5984, review clean after 2 fix rounds)
  minor-followup: hardcoded traffic_delta_pct overrides for clv_s01/clv_s03 (inject_drop not reflected in gold.foot_traffic_daily - technical debt if data regenerated)
Task 3: complete (commits 5a58cda..a3a4576, review clean, no blockers)
  minor-followups (for final review): dedup staffing expr via CTE; anomaly_driver has store_id hardcoded labels (flavor only); real-store labor_schedule.forecast_visits uses base_traffic fallback; build_views.py no explicit sys.exit(1); lon vs lng naming differs across views (backend maps lon->lng)
Task 4: complete (commits a3a4576..28eb87f, review clean - spec all PASS)
  GENIE_SPACE_ID=01f170a989e81c3b9d492d6e298adf8b (for app.yaml/env in Task 12)
  minor-followups (final review): build_genie_space.py reads genie_space.json 3x; orphan 'import json as _json'; .space_id missing trailing newline; hardcoded vibe marketplace path
Task 5: complete (commits 28eb87f..44c0f1e, review clean - all constraints PASS)
  minor-followups (final review): test_empty_viewport should assert out=={'n':0}; add zero-guard + 2-store weighting tests; AnalyticsResponse extra='allow' could be 'forbid'
Task 6: complete (commits 44c0f1e..dafa8d4, review clean after 1 fix - 26 tests)
  note for Task 10/11: demo contract has age(dict),median_income,median_age,pct_with_kids,5 income bands; median_age & pct_with_kids are None (absent in bronze) - frontend must render gracefully or derive median_age from age bands
Task 7: complete (commits dafa8d4..e16da77, review clean after 1 fix - 1 Critical dash-regex fixed, client shared)
  backend/db.py now exposes get_workspace_client(profile=None) - reuse in routes
Task 8: complete (commits e16da77..a5a7a35, review clean after 1 fix - backend done, 48 tests)
Task 9: complete (commit 394b9c4..095b5e1, build OK, visual verify PASS - shell faithful to design)
  note for Task 10/11: App.jsx static shell uses design's CHICAGO placeholder copy (metro pill, store names); replace with live /api/bootstrap (Boston) data. Minor a11y: Genie input needs id/name.
Task bugfix (data-contract): complete (commits 85be87d..46e0dd0, review clean after 1 fix round)
  fix: expose poi_type for competitor split; reconcile demographics to real gold columns
  competitors layer was returning 0 rows (COALESCE erased poi_type); demo layer was crashing (nonexistent columns)
  median_age now derived from age bands (weighted midpoint); pct_with_kids=None
  test count assertions tightened for competitor(==1) and pois(==2) stub rows
Task 10: complete (commits 095b5e1..12a3982, MANY fixes + live browser verify PASS)
  fixes: layer-endpoint wiring, data freshness anchor (ANCHOR_DATE 2026-06-15), median_income_proxy /100, synth demographics for all 15 stores, lightning emoji, demographics weighting alignment, StrictMode/sparkline/toggle/POI-color guards
  KNOWN LIMITATION (polish/README): trade-areas, competitors, cross-shopping, nearby_pois come from bronze and only cover the 3 REAL stores; synthetic stores lack these auxiliary layers (sparse when panning to synth stores). Not blocking.
Task 11: complete (commits 12a3982..178b499, live curl verify PASS + review clean after 1 fix - threading/concurrency fixed)
