/**
 * Paid-response licensing gate (lib/sourcePolicy.mjs): every response that
 * reads threat_ioc_telemetry - the /api/ioc STIX bundle (free tier, licence
 * and x402), the paid get_threat_indicators / get_ioc_context /
 * get_ioc_batch MCP tools, the REST /api/ioc/context mirror, the chat tools
 * and the diagnostics endpoint - carries only sources PG1 may resell.
 *
 *   - abuse.ch (every feed), AlienVault OTX, AbuseIPDB and unattributed rows
 *     (no label, or the legacy "Sovereign-Engine-*" label) are LOCKED off:
 *     no environment variable can serve them.
 *   - NVD (public domain) is served.
 *   - Blocklist.de, PG1-Swarm, ScamSniffer and any other label are off by
 *     default, each behind its own switch.
 *
 * Supabase is mocked twice over: once returning every seeded row whatever
 * the query says (so the row filter alone must hold), once applying the
 * PostgREST source conditions the query sends (so `limit` counts servable
 * rows only).
 *
 * Run with: node --test tests/source-policy.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function baseEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SOURCE_')) delete process.env[key];
  }
  process.env.ENABLE_REST_IOC_CONTEXT = 'true';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.SUPABASE_SERVICE_KEY = 'test-service-role-key';
  process.env.GUMROAD_PRODUCT_ID = 'test-product';
  delete process.env.X402_PAY_TO_ADDRESS;
}
baseEnv();

// Route modules read some env at import time, so import after setting it.
const { default: chatHandler } = await import('../api/chat.mjs');
// Definition drift is checked on TOOL_DEFINITIONS (every defined tool, switched
// off or not): a tool hidden by a flag (PG1_ALERTS) keeps its definition.
const { default: mcpHandler, TOOL_DEFINITIONS: TOOLS } = await import('../api/mcp.mjs');
const { default: restContextHandler } = await import('../api/ioc/context.js');
const { default: diagnosticsHandler } = await import('../api/diagnostics/system-status-check.js');
const { A2A_SKILL_TOOLS } = await import('../api/a2a.mjs');
const { PLAYGROUND_TOOLS } = await import('../lib/playground.mjs');
const { createToolExecutor } = await import('../lib/chatTools.mjs');
const policy = await import('../lib/sourcePolicy.mjs');

beforeEach(() => baseEnv());
after(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = ORIGINAL_FETCH;
});

const row = (verification_source, value, indicator_type) => ({
  verification_source, value, indicator_type, confidence_score: 90,
  last_seen: '2026-10-01T00:00:00Z', ingested_at: '2026-10-01T00:00:00Z',
  malware_family: `family of ${value} via ${verification_source}`, tags: [`tag-${value}-${verification_source}`], stix_pattern: null
});

// One indicator reported by abuse.ch and OTX (both locked), and one CVE
// reported by abuse.ch and NVD (only the NVD row may be served).
const MIXED_LOCKED = '198.51.100.50';
const MIXED_CVE = 'CVE-2026-0003';

// Locked off: no switch can serve these.
const LOCKED_ROWS = {
  abusech: [
    row('abuse.ch ThreatFox', '203.0.113.10', 'IPv4'),
    row('abuse.ch URLhaus', 'http://203.0.113.11/payload.exe', 'URL'),
    row('URLhaus-Fallback', 'http://203.0.113.12/drop.bin', 'URL'),
    row('abuse.ch MalwareBazaar', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'FileHash-SHA256'),
    row('abuse.ch Feodo Tracker', '203.0.113.13', 'IPv4'),
    row('abuse.ch SSLBL', '203.0.113.14', 'IPv4'),
    row('abuse.ch ThreatFox', 'tf-only.example', 'domain'),
    row('abuse.ch ThreatFox', MIXED_LOCKED, 'IPv4'),
    row('abuse.ch ThreatFox', MIXED_CVE, 'CVE')
  ],
  otx: [
    row('AlienVault-OTX', '198.51.100.61', 'IPv4'),
    row('AlienVault-OTX', MIXED_LOCKED, 'IPv4'),
    row('LevelBlue OTX', 'levelblue.example', 'domain')
  ],
  abuseipdb: [row('AbuseIPDB', '198.51.100.3', 'IPv4')],
  unattributed: [
    row('Sovereign-Engine-v3.2-Cobalt Strike', 'legacy.example', 'domain'),
    row(null, 'nolabel.example', 'domain'),
    row('', 'emptylabel.example', 'domain')
  ]
};
// Off by default, each behind its own switch.
const SWITCHED_ROWS = {
  blocklist_de: [row('Blocklist.de', '198.51.100.2', 'IPv4')],
  pg1_swarm: [row('PG1-Swarm-w1-tee', 'swarm.example', 'domain')],
  scamsniffer: [row('ScamSniffer', 'drainer.example', 'domain')],
  other: [row('test-source', 'other.example', 'domain')]
};
// Served.
const NVD_ROWS = [
  row('NVD', 'CVE-2026-0001', 'CVE'),
  row('NVD-CVE-v2.0-Gateway', 'CVE-2026-0002', 'CVE'),
  row('NVD', MIXED_CVE, 'CVE')
];

const ALL_LOCKED = Object.values(LOCKED_ROWS).flat();
const ALL_SWITCHED = Object.values(SWITCHED_ROWS).flat();
const ALL_ROWS = [...ALL_LOCKED, ...ALL_SWITCHED, ...NVD_ROWS];
const SERVED_VALUES = [...new Set(NVD_ROWS.map((r) => r.value))];
// Indicator values only an unservable row knows about.
const HIDDEN_VALUES = [...new Set([...ALL_LOCKED, ...ALL_SWITCHED].map((r) => r.value))].filter((v) => !SERVED_VALUES.includes(v));
const LOCKED_LABELS = ['ThreatFox', 'URLhaus', 'abuse.ch', 'MalwareBazaar', 'Feodo', 'SSLBL', 'AlienVault', 'LevelBlue', 'AbuseIPDB', 'Sovereign-Engine'];
const SWITCHED_LABELS = ['Blocklist.de', 'PG1-Swarm', 'ScamSniffer', 'test-source'];

// Strings only a served row of `rows` could put in a response.
function markersOf(rows) {
  return rows.flatMap((r) => [SERVED_VALUES.includes(r.value) ? null : r.value, r.malware_family, r.tags[0]]).filter(Boolean);
}

// Applies the subset of PostgREST the source filter uses: and=(or(ilike...),
// not.ilike...), and=(not.ilike...), and the match-nothing condition.
function applySourceConditions(rows, searchParams) {
  const raw = searchParams.get('and') || searchParams.get('or');
  if (!raw) return rows;
  if (raw === '(verification_source.is.null,verification_source.not.is.null)') return [];
  const toRe = (p) => new RegExp('^' + p.split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  const deny = [...raw.matchAll(/verification_source\.not\.ilike\.([^,)]+)/g)].map((m) => toRe(m[1]));
  const group = raw.match(/or\(([^)]*)\)/);
  const allow = group ? [...group[1].matchAll(/verification_source\.ilike\.([^,)]+)/g)].map((m) => toRe(m[1])) : null;
  return rows.filter((r) => {
    if (r.verification_source == null) return false;
    if (allow && !allow.some((re) => re.test(r.verification_source))) return false;
    return deny.every((re) => !re.test(r.verification_source));
  });
}

function installFetch({ honorSourceFilter = false } = {}) {
  const telemetryUrls = [];
  global.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    if (u.hostname === 'api.gumroad.com') {
      return { ok: true, status: 200, json: async () => ({ success: true, purchase: {} }) };
    }
    if (u.pathname === '/rest/v1/threat_ioc_telemetry') {
      telemetryUrls.push(String(url));
      let rows = ALL_ROWS;
      const eq = u.searchParams.get('value');
      if (eq && eq.startsWith('eq.')) rows = rows.filter((r) => r.value === eq.slice(3));
      if (honorSourceFilter) rows = applySourceConditions(rows, u.searchParams);
      const limit = parseInt(u.searchParams.get('limit') || '0', 10);
      if (limit) rows = rows.slice(0, limit);
      return { ok: true, status: 200, json: async () => rows.map((r) => ({ ...r })) };
    }
    if (u.pathname === '/rest/v1/free_tier_usage') {
      return { ok: true, status: 200, json: async () => [] };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  return telemetryUrls;
}

function makeRes() {
  return {
    statusCode: null, body: null, rawBody: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end(payload) {
      this.rawBody = payload;
      if (typeof payload === 'string') { try { this.body = JSON.parse(payload); } catch {} }
      return this;
    }
  };
}

let ipCounter = 0;
async function getIocBundle(headers) {
  const res = makeRes();
  await chatHandler({ method: 'GET', url: '/api/ioc?limit=1000', headers, socket: { remoteAddress: `10.9.0.${++ipCounter % 250}` } }, res);
  return res;
}

async function callMcp(name, args) {
  const res = makeRes();
  await mcpHandler({
    method: 'POST',
    headers: { 'x-api-key': 'valid-license' },
    socket: { remoteAddress: `10.8.0.${++ipCounter % 250}` },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.result.isError, undefined, JSON.stringify(res.body));
  return JSON.parse(res.body.result.content[0].text);
}

async function callRestContext(value) {
  const res = makeRes();
  await restContextHandler({ method: 'GET', url: `/api/ioc/context?value=${encodeURIComponent(value)}`, query: { value }, headers: { 'x-api-key': 'valid-license' } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body;
}

async function callChatTool(name, args) {
  const execute = createToolExecutor({ role: 'operator', log: () => {}, record: () => {}, fixtures: () => null });
  const out = await execute({ id: 'c1', name, args });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out;
}

// `asked` are indicator values the caller sent: a lookup echoes them back
// ({ indicator, found: false }), which is the caller's input, not our data.
function scrub(payload, asked) {
  let text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const value of asked) text = text.split(JSON.stringify(value)).join('"<asked>"');
  return text;
}

// No locked source (abuse.ch, OTX, AbuseIPDB, unattributed) and, with the
// default switches, no unconfirmed source either.
function assertOnlyLicensed(label, payload, asked = [], { allowSwitched = [] } = {}) {
  const text = scrub(payload, asked);
  for (const marker of [...markersOf(ALL_LOCKED), ...LOCKED_LABELS]) {
    assert.ok(!text.includes(marker), `${label}: locked-source data "${marker}" leaked`);
  }
  for (const [id, rows] of Object.entries(SWITCHED_ROWS)) {
    if (allowSwitched.includes(id)) continue;
    for (const marker of markersOf(rows)) assert.ok(!text.includes(marker), `${label}: ${id} data "${marker}" leaked`);
  }
  for (const name of SWITCHED_LABELS.filter((n) => !allowSwitched.some((id) => SWITCHED_ROWS[id][0].verification_source.startsWith(n)))) {
    assert.ok(!text.includes(name), `${label}: source label ${name} leaked`);
  }
}

function assertNvdPresent(label, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const value of SERVED_VALUES) assert.ok(text.includes(value), `${label}: NVD record ${value} is missing`);
}

// ---------------------------------------------------------------------
// Every route, default switches
// ---------------------------------------------------------------------

for (const honorSourceFilter of [false, true]) {
  const mode = honorSourceFilter ? 'database applies the source filter' : 'database ignores the source filter';

  test(`/api/ioc free tier STIX bundle: only NVD rows (${mode})`, async () => {
    installFetch({ honorSourceFilter });
    const res = await getIocBundle({ 'x-free-tier': '1' });
    assert.equal(res.statusCode, 200);
    assertOnlyLicensed('/api/ioc free tier', res.rawBody);
    assertNvdPresent('/api/ioc free tier', res.rawBody);
  });

  test(`/api/ioc licensed (paid) STIX bundle: only NVD rows (${mode})`, async () => {
    installFetch({ honorSourceFilter });
    const res = await getIocBundle({ 'x-api-key': 'valid-license' });
    assert.equal(res.statusCode, 200);
    assertOnlyLicensed('/api/ioc licence', res.rawBody);
    assertNvdPresent('/api/ioc licence', res.rawBody);
  });

  test(`MCP get_threat_indicators (paid): only NVD rows (${mode})`, async () => {
    installFetch({ honorSourceFilter });
    const bundle = await callMcp('get_threat_indicators', { limit: 1000 });
    assertOnlyLicensed('get_threat_indicators', bundle);
    assertNvdPresent('get_threat_indicators', bundle);
  });

  test(`MCP get_ioc_context (paid when found): unlicensed-only indicators are found:false; a shared one shows only NVD (${mode})`, async () => {
    installFetch({ honorSourceFilter });
    for (const value of HIDDEN_VALUES) {
      const out = await callMcp('get_ioc_context', { value });
      assert.equal(out.found, false, value);
      assertOnlyLicensed(`get_ioc_context ${value}`, out, [value]);
    }
    const mixed = await callMcp('get_ioc_context', { value: MIXED_CVE });
    assert.equal(mixed.found, true);
    assert.deepEqual(mixed.provenance.sources, ['NVD']);
    assert.equal(mixed.provenance.observation_count, 1);
    assertOnlyLicensed('get_ioc_context mixed', mixed, [MIXED_CVE]);
    for (const value of SERVED_VALUES) assert.equal((await callMcp('get_ioc_context', { value })).found, true, value);
  });

  test(`MCP get_ioc_batch (paid when found): only NVD rows (${mode})`, async () => {
    installFetch({ honorSourceFilter });
    const out = await callMcp('get_ioc_batch', { values: [...HIDDEN_VALUES.slice(0, 15), MIXED_CVE, 'CVE-2026-0001'] });
    assertOnlyLicensed('get_ioc_batch', out, [...HIDDEN_VALUES, MIXED_CVE, 'CVE-2026-0001']);
    for (const value of HIDDEN_VALUES.slice(0, 15)) assert.equal(out.results.find((r) => r.indicator === value).found, false, value);
    assert.equal(out.total_found, 2);
  });

  test(`REST /api/ioc/context (paid when found): only NVD rows (${mode})`, async () => {
    installFetch({ honorSourceFilter });
    for (const value of HIDDEN_VALUES) {
      const out = await callRestContext(value);
      assert.equal(out.found, false, value);
      assertOnlyLicensed(`/api/ioc/context ${value}`, out, [value]);
    }
    const mixed = await callRestContext(MIXED_CVE);
    assert.deepEqual(mixed.provenance.sources, ['NVD']);
  });

  test(`chat tools get_ioc_context / get_ioc_batch: only NVD rows (${mode})`, async () => {
    installFetch({ honorSourceFilter });
    for (const value of [...HIDDEN_VALUES, MIXED_CVE]) {
      assertOnlyLicensed(`chat get_ioc_context ${value}`, await callChatTool('get_ioc_context', { value }), [value]);
    }
    const batch = await callChatTool('get_ioc_batch', { values: [...HIDDEN_VALUES.slice(0, 15), MIXED_CVE] });
    assertOnlyLicensed('chat get_ioc_batch', batch, [...HIDDEN_VALUES, MIXED_CVE]);
  });
}

test('the query itself is an allowlist of licensed sources, so limit counts servable rows', async () => {
  const urls = installFetch({ honorSourceFilter: true });
  await callMcp('get_threat_indicators', { limit: 2 });
  assert.equal(urls.length, 1);
  const tree = new URL(urls[0]).searchParams.get('and');
  assert.ok(tree.startsWith('(or(verification_source.ilike.NVD*)'), tree);
  for (const p of ['*abuse.ch*', '*threatfox*', '*urlhaus*', '*feodo*', '*alienvault*', '*otx*', '*abuseipdb*', 'Sovereign-Engine-*', '*blocklist.de*', '*scamsniffer*', 'PG1-Swarm-*']) {
    assert.ok(tree.includes(`verification_source.not.ilike.${p}`), p);
  }
  const bundle = await callMcp('get_threat_indicators', { limit: 2 });
  assert.equal(bundle.objects.length, 2);
  assertOnlyLicensed('limited bundle', bundle);
});

test('diagnostics endpoint withholds indicator-table rows from unlicensed sources', async () => {
  installFetch();
  const seeded = ALL_ROWS.map((r) => ({ ...r }));
  const plain = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes('/rest/v1/threat_indicators')) {
      return new Response(JSON.stringify(seeded), { status: 200, headers: { 'content-type': 'application/json', 'content-range': `0-${seeded.length - 1}/${seeded.length}` } });
    }
    return plain(url, options);
  };
  const res = makeRes();
  // The endpoint is operator-only (tests/diagnostics-auth.test.mjs).
  process.env.USER_API_KEY = 'policy-operator';
  process.env.USER_API_PASS = 'policy-pass';
  const authorization = 'Basic ' + Buffer.from('policy-operator:policy-pass').toString('base64');
  await diagnosticsHandler({ method: 'GET', headers: { authorization }, query: { table: 'threat_indicators', metric: 'records', limit: '100' } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assertOnlyLicensed('diagnostics records', res.body.records);
  assertNvdPresent('diagnostics records', res.body.records);
  assert.equal('ABUSEIPDB_API_Configured' in res.body.environment, false, 'the diagnostics report no longer reads an AbuseIPDB env key');
});

test('playground and A2A expose no indicator tool at all', () => {
  for (const name of ['get_threat_indicators', 'get_ioc_context', 'get_ioc_batch']) {
    assert.ok(!PLAYGROUND_TOOLS.includes(name), `playground ${name}`);
    assert.ok(!A2A_SKILL_TOOLS.some((t) => t.name === name), `a2a ${name}`);
  }
});

// ---------------------------------------------------------------------
// Locked sources: no environment variable can serve them
// ---------------------------------------------------------------------

const EVERY_SWITCH_ON = Object.fromEntries([...policy.THREAT_SOURCES, policy.OTHER_SOURCE].map((s) => [s.env, 'true']));

test('every switch set to true: abuse.ch, OTX, AbuseIPDB and unattributed rows are still never served, on any paid route', async () => {
  Object.assign(process.env, EVERY_SWITCH_ON);
  const allSwitched = Object.keys(SWITCHED_ROWS);
  for (const honorSourceFilter of [false, true]) {
    installFetch({ honorSourceFilter });
    const res = await getIocBundle({ 'x-api-key': 'valid-license' });
    assertOnlyLicensed('/api/ioc all on', res.rawBody, [], { allowSwitched: allSwitched });
    const bundle = await callMcp('get_threat_indicators', { limit: 1000 });
    assertOnlyLicensed('get_threat_indicators all on', bundle, [], { allowSwitched: allSwitched });
    for (const value of [...new Set(ALL_LOCKED.map((r) => r.value))].filter((v) => v !== MIXED_CVE)) {
      const ctx = await callMcp('get_ioc_context', { value });
      assert.equal(ctx.found, false, value);
      assert.equal((await callRestContext(value)).found, false, value);
    }
    const batch = await callMcp('get_ioc_batch', { values: [MIXED_LOCKED, '198.51.100.3', 'legacy.example', MIXED_CVE] });
    assertOnlyLicensed('get_ioc_batch all on', batch, [MIXED_LOCKED, '198.51.100.3', 'legacy.example', MIXED_CVE], { allowSwitched: allSwitched });
    assert.equal(batch.total_found, 1);
  }
});

test('isSourceEnabled: locked sources ignore their switch whatever its value', () => {
  assert.deepEqual([...policy.LOCKED_SOURCE_IDS].sort(), ['abusech', 'abuseipdb', 'otx', 'unattributed']);
  for (const id of policy.LOCKED_SOURCE_IDS) {
    const source = policy.THREAT_SOURCES.find((s) => s.id === id);
    for (const on of [undefined, 'true', 'TRUE', '1', 'yes', 'on']) {
      assert.equal(policy.isSourceEnabled(id, on === undefined ? {} : { [source.env]: on }), false, `${id} ${on}`);
    }
  }
  // Every switch on: only the locked sources are filtered out, as a denylist.
  const [param] = policy.disabledSourceQueryParams(EVERY_SWITCH_ON);
  const tree = decodeURIComponent(param);
  assert.ok(tree.startsWith('and=('), tree);
  assert.ok(!tree.includes('verification_source.is.null'), 'NULL labels never pass');
  for (const id of policy.LOCKED_SOURCE_IDS) {
    for (const p of policy.THREAT_SOURCES.find((s) => s.id === id).patterns) assert.ok(tree.includes(`verification_source.not.ilike.${p}`), p);
  }
  // An empty-string label passes not.ilike (in PostgREST too); the row filter
  // in fetchThreatTelemetry, checked on every route above, removes it.
  const kept = applySourceConditions(ALL_ROWS, new URLSearchParams(param));
  assert.equal(kept.some((r) => String(r.verification_source ?? '').trim() && policy.LOCKED_SOURCE_IDS.includes(policy.classifySource(r.verification_source))), false);
  assert.equal(policy.filterServableRows(kept, EVERY_SWITCH_ON).some((r) => policy.LOCKED_SOURCE_IDS.includes(policy.classifySource(r.verification_source))), false);
});

// ---------------------------------------------------------------------
// Unconfirmed sources: off by default, each behind its own switch
// ---------------------------------------------------------------------

for (const [id, rows] of Object.entries(SWITCHED_ROWS)) {
  const env = id === 'other' ? 'SOURCE_OTHER_ENABLED' : policy.THREAT_SOURCES.find((s) => s.id === id).env;
  test(`${env}=true serves ${id} rows; locked and other unconfirmed sources stay hidden`, async () => {
    process.env[env] = 'true';
    for (const honorSourceFilter of [false, true]) {
      installFetch({ honorSourceFilter });
      const bundle = await callMcp('get_threat_indicators', { limit: 1000 });
      for (const r of rows) assert.ok(JSON.stringify(bundle).includes(r.value), `${id} ${r.value}`);
      assertOnlyLicensed(`${id} on`, bundle, [], { allowSwitched: [id] });
      assertNvdPresent(`${id} on`, bundle);
    }
  });
}

test('SOURCE_NVD_ENABLED=false: nothing is servable, and the query asks for nothing', async () => {
  process.env.SOURCE_NVD_ENABLED = 'false';
  const [param] = policy.disabledSourceQueryParams();
  assert.equal(decodeURIComponent(param), 'and=(verification_source.is.null,verification_source.not.is.null)');
  for (const honorSourceFilter of [false, true]) {
    installFetch({ honorSourceFilter });
    const bundle = await callMcp('get_threat_indicators', { limit: 1000 });
    assert.equal(bundle.objects.length, 0);
  }
});

test('classifySource: every label the pipeline has written maps to the right source', () => {
  const cases = {
    'abuse.ch ThreatFox': 'abusech', 'abuse.ch URLhaus': 'abusech', 'URLhaus-Fallback': 'abusech',
    'ThreatFox': 'abusech', 'abuse.ch MalwareBazaar': 'abusech', 'ABUSE.CH': 'abusech', 'Feodo Tracker': 'abusech',
    'SSLBL': 'abusech', 'YARAify': 'abusech',
    'Sovereign-Engine-v3.2-Cobalt Strike': 'unattributed', 'Sovereign-Engine-v3.2-OTX pulse': 'unattributed',
    '': 'unattributed', '   ': 'unattributed',
    'AlienVault-OTX': 'otx', 'LevelBlue OTX': 'otx', 'NVD': 'nvd', 'NVD-CVE-v2.0-Gateway': 'nvd', 'Blocklist.de': 'blocklist_de',
    'Blocklist.de-Fallback': 'blocklist_de', 'AbuseIPDB': 'abuseipdb', 'PG1-Swarm-w1-tee': 'pg1_swarm',
    'ScamSniffer': 'scamsniffer', 'test-source': 'other'
  };
  for (const [label, id] of Object.entries(cases)) assert.equal(policy.classifySource(label), id, label);
  assert.equal(policy.classifySource(null), 'unattributed');
  assert.equal(policy.classifySource(undefined), 'unattributed');
});

test('switch values: defaults, explicit on/off, unknown values keep the default', () => {
  const defaults = { nvd: true, blocklist_de: false, pg1_swarm: false, scamsniffer: false, other: false, abusech: false, otx: false, abuseipdb: false, unattributed: false };
  for (const [id, on] of Object.entries(defaults)) assert.equal(policy.isSourceEnabled(id, {}), on, id);
  for (const on of ['true', 'TRUE', '1', 'yes', 'on', ' true ']) assert.equal(policy.isSourceEnabled('scamsniffer', { SOURCE_SCAMSNIFFER_ENABLED: on }), true, on);
  for (const keep of ['', 'maybe', 'enabled']) assert.equal(policy.isSourceEnabled('scamsniffer', { SOURCE_SCAMSNIFFER_ENABLED: keep }), false, keep);
  for (const off of ['false', '0', 'no', 'off']) assert.equal(policy.isSourceEnabled('nvd', { SOURCE_NVD_ENABLED: off }), false, off);
  assert.equal(policy.isSourceEnabled('no-such-source', {}), false);
});

test('a failed query is reported, never served as an empty result', async () => {
  const result = await policy.fetchThreatTelemetry('https://example.supabase.co', 'k', ['select=*'], {
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ALL_ROWS })
  });
  assert.deepEqual(result, { ok: false, status: 503, rows: [] });
});

// ---------------------------------------------------------------------
// Public wording
// ---------------------------------------------------------------------

// [tool, text at the 1.14.0 release, text now]
const DESCRIPTION_EDITS = [
  ['get_threat_indicators', 'sourced from ThreatFox, URLhaus, OTX and NVD.', 'sourced from NVD; only sources PG1 may redistribute commercially are served.'],
  ['get_ioc_context', 'Returns aggregated provenance from ThreatFox, URLhaus, and OTX — reporting', "Returns aggregated provenance from PG1's commercially licensed sources (currently NVD) — reporting"],
  ['get_ioc_batch', 'aggregated provenance as get_ioc_context from ThreatFox, URLhaus, and OTX.', "aggregated provenance as get_ioc_context from PG1's commercially licensed sources (currently NVD)."]
];

// Phase 2: the feed holds only NVD CVE records since the licensing gate, so
// the indicator tools stop describing it as an IP / domain / URL / hash feed.
// Applied before DESCRIPTION_EDITS when reverting (they edit the same text).
const FEED_DESCRIPTION_EDITS = [
  ["get_threat_indicators", "returns a STIX 2.1 bundle of verified threat indicators (IPs, domains, URLs, file hashes) sourced from NVD; only sources PG1 may redistribute commercially are served.", "returns a STIX 2.1 bundle of CVE records from NIST NVD, the only source PG1 may currently redistribute commercially. Today it contains no IP, domain, URL or file-hash indicators: every object is a STIX vulnerability with the CVE id and an NVD reference, without scores (use get_cve_details for CVSS and known-exploited status)."],
  ["get_ioc_context", "Returns aggregated provenance from PG1's commercially licensed sources (currently NVD) — reporting", "PG1's commercially licensed records currently hold only CVE identifiers from NVD, so an IP, domain, URL or hash returns found: false (free) until other licensed sources are added. A match returns aggregated provenance — reporting"],
  ["get_ioc_batch", "aggregated provenance as get_ioc_context from PG1's commercially licensed sources (currently NVD).", "aggregated provenance as get_ioc_context from PG1's commercially licensed records, which currently hold only CVE identifiers from NVD (IPs, domains, URLs and hashes return found: false)."]
];

// Phase 2: EPSS left out of paid responses until FIRST confirms resale
// (PG1_SOURCE_EPSS_PAID), so the CVE descriptions stop promising it.
const EPSS_DESCRIPTION_EDITS = [
  ["get_cve_details", "enriched CVE lookup combining NVD (description, CVSS score/vector), FIRST.org EPSS (exploit-probability score and percentile), and the CISA Known Exploited Vulnerabilities catalog (active wild exploitation status).", "enriched CVE lookup combining NVD (description, CVSS score/vector) and the CISA Known Exploited Vulnerabilities catalog (active wild exploitation status). The epss field (FIRST.org EPSS exploit-probability score and percentile) is present only when this server serves EPSS in paid responses."],
  ["get_cve_batch", "each enriched with NVD description/CVSS, FIRST.org EPSS score, and CISA KEV status — same enrichment as get_cve_details, batched.", "each enriched with NVD description/CVSS and CISA KEV status (plus the FIRST.org EPSS score when this server serves EPSS in paid responses) — same enrichment as get_cve_details, batched."],
  ["get_cve_by_product", "enriched with CVSS, EPSS, and CISA KEV status, sorted by exploitation risk.", "enriched with CVSS and CISA KEV status (plus EPSS when this server serves EPSS in paid responses), sorted by exploitation risk."]
];

// Follow-up: the feed is FREE while it holds no current data (PG1_FEED_PAID
// off, the default), so get_threat_indicators drops its payment sentences.
// Two edits on the same tool, so two lists; applied first when reverting.
const PAYMENT_SENTENCE = 'Payment required: $0.01 via x402, sent in params._meta["x402/payment"] (the PAYMENT-SIGNATURE header is also accepted), or a valid Gumroad license key (X-API-KEY header). ';
const FREE_FEED_EDITS = [
  ['get_threat_indicators', PAYMENT_SENTENCE, 'FREE while this feed holds no current data: no payment, no licence key, and it does not use the 5 free calls a day. ']
];
const FREE_FEED_BEHAVIOR_EDITS = [
  ['get_threat_indicators', 'Pagination is handled via the limit parameter (max 1000). If payment is missing or fails, returns a normal tool result with isError: true, the x402 v2 PaymentRequired object in structuredContent and the same JSON in content[0].text; on success the settlement receipt is in result._meta["x402/payment-response"].', 'Pagination is handled via the limit parameter (max 1000).']
];

test('tool definitions differ from 1.14.0 only by the listed description edits (licensing gate, feed description, EPSS switch, free feed)', () => {
  // check_ip_abuse (1.16.0) and check_package (1.17.0) are the additions; the 14 tools
  // before them are pinned.
  const reverted = TOOLS.filter((tool) => tool.name !== 'check_ip_abuse' && tool.name !== 'check_package' && !['preflight_check', 'check_x402_endpoint', 'check_agent_card', 'verify_result', 'hosting_advisor'].includes(tool.name)).map((tool) => {
    let description = tool.description;
    for (const edits of [FREE_FEED_EDITS, FREE_FEED_BEHAVIOR_EDITS, FEED_DESCRIPTION_EDITS, DESCRIPTION_EDITS, EPSS_DESCRIPTION_EDITS]) {
      const edit = edits.find(([name]) => name === tool.name);
      if (!edit) continue;
      assert.ok(description.includes(edit[2]), tool.name);
      description = description.replace(edit[2], edit[1]);
    }
    return { ...tool, description };
  });
  // SHA-256 of JSON.stringify(TOOLS) at the 1.14.0 release.
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(reverted)).digest('hex'), '47dde1cff3ff1f64f1020b8d06813321f51c8db2142390bad0096616c8767acc');
});

test('no paid tool description or x402 resource text names an unlicensed source', () => {
  const UNLICENSED = /abuse\.?ch|threatfox|urlhaus|alienvault|\botx\b|levelblue|abuseipdb|blocklist\.de|scamsniffer/i;
  for (const name of ['get_threat_indicators', 'get_ioc_context', 'get_ioc_batch', 'get_cve_details', 'get_cve_batch', 'get_cve_by_product', 'get_threat_actor_profile']) {
    assert.doesNotMatch(TOOLS.find((t) => t.name === name).description, UNLICENSED, name);
  }
  const mcp = fs.readFileSync(path.join(ROOT, 'api/mcp.mjs'), 'utf8');
  assert.doesNotMatch(mcp.match(/const X402_RESOURCE_DESCRIPTION = '[^']*'/)[0], UNLICENSED);
  const chat = fs.readFileSync(path.join(ROOT, 'api/chat.mjs'), 'utf8');
  const iocRoute = chat.slice(chat.indexOf('var iocX402RouteConfig'), chat.indexOf('x402Middleware = paymentMiddleware('));
  assert.doesNotMatch(iocRoute, UNLICENSED, '/api/ioc 402 description and Bazaar example');
});

test('no public surface claims abuse.ch / ThreatFox / URLhaus data any more', () => {
  const NAMES = /abuse\.?ch|threatfox|urlhaus/i;
  assert.doesNotMatch(JSON.stringify(TOOLS), NAMES);
  const files = [
    'server.json', 'public/llms.txt', 'public/about/index.html', 'public/openapi.json',
    'public/.well-known/agent-card.json', 'public/.well-known/x402', 'public/index.html',
    'public/playground/index.html', 'public/playground/playground.js', 'README.md',
    ...fs.readdirSync(path.join(ROOT, 'public/docs'), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => `public/docs/${d.name}/index.html`)
  ];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (rel === 'README.md') {
      // README documents the switch itself; it must not list these as sources.
      assert.doesNotMatch(text.replace(/^.*SOURCE_ABUSECH_ENABLED.*$/m, ''), /\|[^|\n]*(ThreatFox|URLhaus)[^|\n]*\|/, rel);
      continue;
    }
    assert.doesNotMatch(text, NAMES, rel);
  }
  // The /api/ioc 402 description, Bazaar example and chat replies.
  const chat = fs.readFileSync(path.join(ROOT, 'api/chat.mjs'), 'utf8');
  assert.doesNotMatch(chat, NAMES);
});

test('one version bump: 1.17.0 (the current release) everywhere the server version is published', async () => {
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  assert.equal(read('server.json').version, '1.20.0');
  assert.equal(read('public/.well-known/agent-card.json').version, '1.20.0');
  assert.equal(read('public/openapi.json').info.version, '1.20.0');
  const res = makeRes();
  await mcpHandler({ method: 'POST', headers: {}, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } }, res);
  assert.equal(res.body.result.serverInfo.version, '1.20.0');
  const get = makeRes();
  await mcpHandler({ method: 'GET', headers: {} }, get);
  assert.equal(get.body.version, '1.20.0');
});

test('paid CVE and ATT&CK responses carry the notices their sources ask for', async () => {
  global.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === 'api.gumroad.com') return { ok: true, status: 200, json: async () => ({ success: true, purchase: {} }) };
    if (u.hostname === 'services.nvd.nist.gov') {
      return { ok: true, status: 200, json: async () => ({ vulnerabilities: [{ cve: { id: 'CVE-2021-44228', published: '2021-12-10T00:00:00Z', descriptions: [{ lang: 'en', value: 'Log4Shell' }], metrics: {} } }] }) };
    }
    if (u.hostname === 'api.first.org') return { ok: true, status: 200, json: async () => ({ data: [{ epss: '0.9', percentile: '0.99' }] }) };
    if (u.hostname === 'www.cisa.gov') return { ok: true, status: 200, json: async () => ({ vulnerabilities: [] }) };
    if (u.hostname === 'raw.githubusercontent.com') {
      return { ok: true, status: 200, json: async () => ({ objects: [{ type: 'intrusion-set', id: 'intrusion-set--1', name: 'APT29', aliases: ['Cozy Bear'], external_references: [{ source_name: 'mitre-attack', external_id: 'G0016' }] }] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  for (const [name, args] of [['get_cve_details', { cve_id: 'CVE-2021-44228' }], ['get_cve_batch', { cve_ids: ['CVE-2021-44228'] }], ['get_cve_by_product', { vendor: 'apache', product: 'log4j' }]]) {
    const out = await callMcp(name, args);
    assert.match(out.attribution, /This product uses data from the NVD API but is not endorsed or certified by the NVD\./, name);
    // Phase 2: paid responses carry no EPSS (PG1_SOURCE_EPSS_PAID off), so
    // no EPSS credit either; KEV is still credited.
    assert.doesNotMatch(out.attribution, /EPSS/, name);
    assert.match(out.attribution, /CISA Known Exploited Vulnerabilities Catalog/, name);
  }
  process.env.PG1_SOURCE_EPSS_PAID = 'true';
  try {
    const withEpss = await callMcp('get_cve_details', { cve_id: 'CVE-2021-44228' });
    assert.match(withEpss.attribution, /EPSS by FIRST/);
  } finally {
    delete process.env.PG1_SOURCE_EPSS_PAID;
  }
  const actor = await callMcp('get_threat_actor_profile', { actor_name: 'APT29' });
  assert.match(actor.attribution, /^© \d{4} The MITRE Corporation\. This work is reproduced and distributed with the permission of The MITRE Corporation\./);
});
