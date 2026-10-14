// Public reliability numbers: per tool, over the last 24 hours, the number
// of calls, the success rate and the p50/p95 latency, from agent_telemetry.
// Shown on /status, in get_usage_status (service_status) and used by the
// hourly error-rate alert (api/flags/monitor.mjs).
//
// Privacy: only tool_name, status, latency_ms and created_at are read; no
// caller hash, endpoint client or requested name ever leaves this module,
// and only names on the public tool list are reported.
//
// Success rate counts the calls the tool itself answered (ok) against the
// ones it failed (upstream_error, tool_error, server_error,
// settlement_failed). Caller-side outcomes (invalid input, rate limits,
// payment required) are neither.

export const STATUS_WINDOW_HOURS = 24;
export const ALERT_WINDOW_HOURS = 1;
export const ALERT_ERROR_RATE = 0.05;
export const ALERT_MIN_CALLS = 20;
export const STATUS_CACHE_MS = 60000;
const FAILURE_STATUSES = new Set(['upstream_error', 'tool_error', 'server_error', 'settlement_failed']);
const SUCCESS_STATUSES = new Set(['ok']);

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// rows: [{ tool_name, status, latency_ms }]; tools: the public tool names.
export function computeToolMetrics(rows, tools) {
  const allowed = new Set(tools);
  const by = new Map(tools.map((t) => [t, { ok: 0, failed: 0, latencies: [] }]));
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !allowed.has(r.tool_name)) continue;
    const m = by.get(r.tool_name);
    if (SUCCESS_STATUSES.has(r.status)) m.ok++;
    else if (FAILURE_STATUSES.has(r.status)) m.failed++;
    else continue;
    const ms = Number(r.latency_ms);
    if (Number.isFinite(ms) && ms >= 0 && SUCCESS_STATUSES.has(r.status)) m.latencies.push(ms);
  }
  return tools.map((tool) => {
    const m = by.get(tool);
    const calls = m.ok + m.failed;
    const lat = m.latencies.sort((a, b) => a - b);
    return { tool, calls, success_rate: calls ? Math.round((m.ok / calls) * 10000) / 10000 : null, p50_ms: percentile(lat, 50), p95_ms: percentile(lat, 95) };
  });
}

export function errorRateBreaches(metrics, { threshold = ALERT_ERROR_RATE, minCalls = ALERT_MIN_CALLS } = {}) {
  return metrics.filter((m) => m.calls >= minCalls && m.success_rate != null && Math.round((1 - m.success_rate) * 10000) / 10000 > threshold);
}

export async function readToolRows({ supUrl, supKey, fetchImpl = globalThis.fetch, sinceIso, timeoutMs = 4000 }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${supUrl}/rest/v1/agent_telemetry?select=tool_name,status,latency_ms&event_type=eq.tool_call&is_fixture=eq.false&created_at=gte.${encodeURIComponent(sinceIso)}&limit=50000`, { headers: { apikey: supKey, Authorization: `Bearer ${supKey}` }, signal: controller.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`telemetry ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

let cache = null;
export function __clearStatusCache() {
  cache = null;
}

// The public snapshot, cached for a minute. Never throws: { available: false }.
export async function serviceStatus({ supUrl, supKey, tools, fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = 4000 }) {
  if (cache && cache.expires > now) return cache.value;
  let value;
  try {
    if (!supUrl || !supKey) throw new Error('not configured');
    const rows = await readToolRows({ supUrl, supKey, fetchImpl, timeoutMs, sinceIso: new Date(now - STATUS_WINDOW_HOURS * 3600000).toISOString() });
    value = { available: true, window_hours: STATUS_WINDOW_HOURS, generated_at: new Date(now).toISOString(), tools: computeToolMetrics(rows, tools) };
  } catch (e) {
    value = { available: false, window_hours: STATUS_WINDOW_HOURS, generated_at: new Date(now).toISOString(), tools: [] };
  }
  cache = { value, expires: now + STATUS_CACHE_MS };
  return value;
}

// The hourly alert: one operator notice per tool whose error rate over the
// last hour passes 5% (at least ALERT_MIN_CALLS calls).
export async function monitorErrorRates({ supUrl, supKey, tools, fetchImpl = globalThis.fetch, now = Date.now(), notify }) {
  const rows = await readToolRows({ supUrl, supKey, fetchImpl, sinceIso: new Date(now - ALERT_WINDOW_HOURS * 3600000).toISOString() });
  const breaches = errorRateBreaches(computeToolMetrics(rows, tools));
  for (const b of breaches) {
    await notify({ supUrl, supKey, route: '/status', reason: 'tool_error_rate', message: `${b.tool}: ${Math.round((1 - b.success_rate) * 1000) / 10}% of ${b.calls} calls failed in the last hour (threshold ${ALERT_ERROR_RATE * 100}%).` });
  }
  return breaches;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function statusPageHtml(status, { signing = false } = {}) {
  const rows = status.tools.map((t) => `<tr><td><code>${esc(t.tool)}</code></td><td>${t.calls}</td><td>${t.success_rate == null ? '-' : `${(t.success_rate * 100).toFixed(1)}%`}</td><td>${t.p50_ms == null ? '-' : `${t.p50_ms} ms`}</td><td>${t.p95_ms == null ? '-' : `${t.p95_ms} ms`}</td></tr>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PG1 Status</title>
<style>:root{--bg:#fff;--fg:#111;--mut:#555;--line:#ddd}@media (prefers-color-scheme:dark){:root{--bg:#0d0f12;--fg:#e8e8e8;--mut:#9aa;--line:#2a2f36}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;max-width:880px;margin-inline:auto}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
th{color:var(--mut);font-weight:600}.mut{color:var(--mut)}.wrap{overflow-x:auto}</style></head>
<body><h1>PG1 status</h1>
<p class="mut">Last ${status.window_hours} hours, generated ${esc(status.generated_at)}. Success rate counts calls the tool answered against calls it failed; invalid input, rate limits and payment challenges are left out. Latency is for successful calls. Updated every minute.</p>
${status.available ? `<div class="wrap"><table><thead><tr><th>Tool</th><th>Calls</th><th>Success</th><th>p50</th><th>p95</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p>Metrics are temporarily unavailable.</p>'}
<p class="mut">Result signing: ${signing ? 'on' : 'off'} (keys at <a href="/.well-known/pg1-signing-key">/.well-known/pg1-signing-key</a>). JSON: <a href="/status?format=json">/status?format=json</a>.</p>
</body></html>`;
}
