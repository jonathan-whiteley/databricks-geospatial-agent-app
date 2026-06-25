/**
 * api.js - fetch wrappers for the Clover Geospatial App backend.
 *
 * All paths hit /api/... which resolves to:
 *   - localhost:8000 in dev (via Vite proxy configured in vite.config.js)
 *   - same-origin in prod (Databricks App static hosting)
 */

const BASE = '/api';

async function _json(res) {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * GET /api/bootstrap
 * Returns the full bootstrap payload:
 *   { META, layers, locations, foot_traffic_daily, helpers: { byId, demoById } }
 */
export async function getBootstrap() {
  return _json(await fetch(`${BASE}/bootstrap`));
}

/**
 * GET /api/layers/{name}
 * name in: stores, traffic, trade, demo, competitors, pois, cross
 * Returns { features: [...] }
 */
export async function getLayer(name) {
  return _json(await fetch(`${BASE}/layers/${encodeURIComponent(name)}`));
}

/**
 * POST /api/analytics
 * body: { bbox: [south, west, north, east] }
 * Returns in-viewport KPI aggregates.
 */
export async function postAnalytics(bbox) {
  return _json(await fetch(`${BASE}/analytics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bbox }),
  }));
}

/**
 * POST /api/genie/ask
 * body: { question, conversation_id? }
 * Returns Genie conversation response (Task 11).
 */
export async function postGenieAsk(question, conversationId) {
  return _json(await fetch(`${BASE}/genie/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, conversation_id: conversationId || null }),
  }));
}

/**
 * POST /api/action
 * body: { question, sql, rows }
 * Returns next-best-action summary (Task 11).
 */
export async function postAction(question, sql, rows) {
  return _json(await fetch(`${BASE}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, sql, rows }),
  }));
}
