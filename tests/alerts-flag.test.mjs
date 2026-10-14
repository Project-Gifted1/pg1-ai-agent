/**
 * subscribe_alerts is off until alert delivery exists (PG1_ALERTS, default
 * off): it is not listed in tools/list, the A2A agent card, the docs or the
 * pricing, and a call gets a "not available" result before any licence
 * check, payment or free-tier count. With PG1_ALERTS=true the unchanged
 * tool is back.
 *
 * Run with: node --test tests/alerts-flag.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const mcp = await import('../api/mcp.mjs');
const { default: mcpHandler, TOOLS, TOOL_DEFINITIONS, listedTools, alertsEnabled, ALERTS_NOT_AVAILABLE_MESSAGE } = mcp;
const { A2A_SKILL_TOOLS } = await import('../api/a2a.mjs');
const { WATCH_ITEM_PRICE_USD, WATCH_PERIOD_DAYS } = await import('../lib/watchlists.mjs');

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
let ip = 0;

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; }
  };
}
async function rpc(method, params, headers = {}) {
  const res = makeRes();
  await mcpHandler({ method: 'POST', headers: { 'x-forwarded-for': `198.51.100.${++ip % 250}`, ...headers }, body: { jsonrpc: '2.0', id: 1, method, params } }, res);
  return res;
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  delete process.env.PG1_ALERTS;
  // Telemetry inserts land after the response; keep them off the network.
  globalThis.fetch = async () => new Response('[]');
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

test('the pointer names the watchlist price the code charges', () => {
  assert.deepEqual([mcp.ALERTS_ALTERNATIVE.price_usd_per_item, mcp.ALERTS_ALTERNATIVE.period_days], [WATCH_ITEM_PRICE_USD, WATCH_PERIOD_DAYS]);
});

test('PG1_ALERTS is off unless explicitly turned on', () => {
  assert.equal(alertsEnabled({}), false);
  for (const v of ['', 'false', '0', 'off', 'no']) assert.equal(alertsEnabled({ PG1_ALERTS: v }), false, v);
  for (const v of ['true', 'TRUE', '1', 'on', 'yes']) assert.equal(alertsEnabled({ PG1_ALERTS: v }), true, v);
});

test('off: subscribe_alerts is not listed anywhere an agent looks; its definition is kept', async () => {
  assert.ok(!TOOLS.some((t) => t.name === 'subscribe_alerts'));
  assert.ok(TOOL_DEFINITIONS.some((t) => t.name === 'subscribe_alerts'), 'kept behind the flag');
  const list = await rpc('tools/list', {});
  assert.ok(!list.body.result.tools.some((t) => t.name === 'subscribe_alerts'));
  assert.ok(!A2A_SKILL_TOOLS.some((t) => t.name === 'subscribe_alerts'));
  // README keeps one entry: not available, use a watchlist.
  const readmeMentions = read('README.md').split('\n').filter((l) => /subscribe_alerts/.test(l));
  assert.equal(readmeMentions.length, 1);
  assert.match(readmeMentions[0], /Not available.*POST \/api\/watchlists.*0\.05 USD per item for 30 days/);
  for (const file of ['public/llms.txt', 'public/.well-known/agent-card.json', 'public/openapi.json', 'public/docs/agents/index.html', 'public/docs/testing/index.html', 'server.json', 'lib/pricing.mjs']) {
    assert.doesNotMatch(read(file), /subscribe_alerts|alert subscription/i, file);
  }
});

test('on: tools/list includes the unchanged definition', async () => {
  const on = listedTools({ PG1_ALERTS: 'true' });
  assert.equal(on, TOOL_DEFINITIONS);
  process.env.PG1_ALERTS = 'true';
  const list = await rpc('tools/list', {});
  assert.ok(list.body.result.tools.some((t) => t.name === 'subscribe_alerts'));
});

test('off: a call is answered "not available" with no licence check, payment, free-tier count or write', async () => {
  const fetched = [];
  globalThis.fetch = async (url) => { fetched.push(String(url)); return new Response('[]'); };
  for (const headers of [{}, { 'x-api-key': ['any', 'licence'].join('-') }, { 'x-free-tier': '1' }, { 'x-payment': 'e30=' }]) {
    const res = await rpc('tools/call', { name: 'subscribe_alerts', arguments: { webhook_url: 'https://hooks.example.com/pg1' } }, headers);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.result.isError, true);
    const body = JSON.parse(res.body.result.content[0].text);
    assert.equal(body.code, 'not_available');
    assert.equal(body.message, ALERTS_NOT_AVAILABLE_MESSAGE);
    assert.match(body.message, /\/api\/watchlists/);
    assert.deepEqual(body.use_instead, { endpoint: 'POST https://pg1-ai-agent.vercel.app/api/watchlists', price_usd_per_item: 0.05, period_days: 30, payment: 'x402' });
    assert.equal(body.charged, false);
    assert.equal(body.free_tier_used, false);
    assert.equal(res.headers['payment-required'], undefined);
  }
  const touched = fetched.filter((u) => !u.includes('/rest/v1/agent_telemetry'));
  assert.deepEqual(touched, [], 'only the telemetry row is written: no Gumroad, no free tier, no facilitator, no alert_subscriptions');
});

test('on: the tool runs as before (licence checked, subscription written)', async () => {
  process.env.PG1_ALERTS = 'true';
  const writes = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.gumroad.com/')) return new Response(JSON.stringify({ success: true, purchase: {} }));
    if (u.includes('/rest/v1/alert_subscriptions')) { writes.push(u); return new Response(JSON.stringify([{ id: 3, created_at: '2026-10-14T00:00:00Z' }]), { status: 201 }); }
    return new Response('[]');
  };
  const res = await rpc('tools/call', { name: 'subscribe_alerts', arguments: { webhook_url: 'https://hooks.example.com/pg1' } }, { 'x-api-key': ['valid', 'licence'].join('-') });
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(res.body.result.content[0].text).subscription_id, 3);
});
