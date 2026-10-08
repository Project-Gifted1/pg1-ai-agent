/**
 * Per-source serving switches (lib/sourcePolicy.mjs), 1.15.0 licensing
 * release: with SOURCE_ABUSECH_ENABLED off (the default), no abuse.ch
 * ThreatFox / URLhaus row reaches any response that reads
 * threat_ioc_telemetry - the /api/ioc STIX bundle (free tier and licence),
 * the get_threat_indicators / get_ioc_context / get_ioc_batch MCP tools, the
 * REST /api/ioc/context mirror, the chat tools and the diagnostics endpoint -
 * while every other source is served as before. The playground and A2A don't
 * expose any indicator tool at all, which is pinned here too.
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
const { default: mcpHandler, TOOLS } = await import('../api/mcp.mjs');
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

// One row per source label the pipeline has ever written, plus the legacy
// and unlabelled cases. MIXED is one indicator reported by two sources.
const MIXED = '198.51.100.50';
const row = (verification_source, value, indicator_type) => ({
  verification_source, value, indicator_type, confidence_score: 90,
  last_seen: '2026-10-01T00:00:00Z', ingested_at: '2026-10-01T00:00:00Z',
  malware_family: `family of ${value} via ${verification_source}`, tags: [`tag-${value}-${verification_source}`], stix_pattern: null
});
const ABUSECH_ROWS = [
  row('abuse.ch ThreatFox', '203.0.113.10', 'IPv4'),
  row('abuse.ch URLhaus', 'http://203.0.113.11/payload.exe', 'URL'),
  row('URLhaus-Fallback', 'http://203.0.113.12/drop.bin', 'URL'),
  row('abuse.ch ThreatFox', 'tf-only.example', 'domain'),
  row('abuse.ch ThreatFox', MIXED, 'IPv4')
];
const UNATTRIBUTED_ROWS = [
  row('Sovereign-Engine-v3.2-Cobalt Strike', 'legacy.example', 'domain'),
  row(null, 'nolabel.example', 'domain')
];
const OTHER_SOURCE_ROWS = [
  row('AlienVault-OTX', '198.51.100.61', 'IPv4'),
  row('AlienVault-OTX', MIXED, 'IPv4'),
  row('NVD', 'CVE-2026-0001', 'CVE'),
  row('NVD-CVE-v2.0-Gateway', 'CVE-2026-0002', 'CVE'),
  row('Blocklist.de', '198.51.100.2', 'IPv4'),
  row('PG1-Swarm-w1-tee', 'swarm.example', 'domain'),
  row('ScamSniffer', 'drainer.example', 'domain'),
  row('test-source', 'other.example', 'domain')
];
// AbuseIPDB rows are never served (1.16.0): the source is locked off,
// because AbuseIPDB results may only go to the customer whose own key fetched
// them (check_ip_abuse), never into a shared feed.
const ABUSEIPDB_ROWS = [row('AbuseIPDB', '198.51.100.3', 'IPv4')];
const ALL_ROWS = [...ABUSECH_ROWS, ...UNATTRIBUTED_ROWS, ...ABUSEIPDB_ROWS, ...OTHER_SOURCE_ROWS];
const ABUSECH_ONLY_VALUES = ABUSECH_ROWS.map((r) => r.value).filter((v) => v !== MIXED);
const HIDDEN_VALUES = [...ABUSECH_ONLY_VALUES, ...UNATTRIBUTED_ROWS.map((r) => r.value), ...ABUSEIPDB_ROWS.map((r) => r.value)];
// Strings that only a served abuse.ch row could put in a response.
const ABUSECH_MARKERS = [...ABUSECH_ONLY_VALUES, ...ABUSECH_ROWS.flatMap((r) => [r.malware_family, r.tags[0]]), 'ThreatFox', 'URLhaus', 'abuse.ch'];
const UNIQUE_OTHER_VALUES = OTHER_SOURCE_ROWS.map((r) => r.value).filter((v) => v !== MIXED);

// Applies the subset of PostgREST the source filter uses: and=(...) and
// or=(verification_source.is.null,and(...)) of verification_source.not.ilike.
function applySourceConditions(rows, searchParams) {
  const raw = searchParams.get('and') || searchParams.get('or');
  if (!raw) return rows;
  const patterns = [...raw.matchAll(/verification_source\.not\.ilike\.([^,)]+)/g)].map((m) =>
    new RegExp('^' + m[1].split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i'));
  const nullAllowed = searchParams.has('or') && raw.startsWith('(verification_source.is.null');
  return rows.filter((r) => {
    if (r.verification_source == null) return nullAllowed;
    return patterns.every((re) => !re.test(r.verification_source));
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
  await chatHandler({ method: 'GET', url: '/api/ioc?limit=1000', headers, socket: { remoteAddress: `10.9.0.${++ipCounter}` } }, res);
  return res;
}

async function callMcp(name, args) {
  const res = makeRes();
  await mcpHandler({
    method: 'POST',
    headers: { 'x-api-key': 'valid-license' },
    socket: { remoteAddress: `10.8.0.${++ipCounter}` },
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
function assertNoAbusech(label, payload, asked = []) {
  let text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const value of asked) text = text.split(JSON.stringify(value)).join('"<asked>"');
  for (const marker of ABUSECH_MARKERS) {
    assert.ok(!text.includes(marker), `${label}: abuse.ch data "${marker}" leaked`);
  }
  for (const value of UNATTRIBUTED_ROWS.flatMap((r) => [r.value, r.malware_family])) {
    assert.ok(!text.includes(value), `${label}: unattributed row "${value}" leaked`);
  }
}

function assertOtherSourcesPresent(label, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const value of UNIQUE_OTHER_VALUES) {
    assert.ok(text.includes(value), `${label}: ${value} (another source) is missing`);
  }
}

// ---------------------------------------------------------------------
// Every route, switch at its default (off)
// ---------------------------------------------------------------------

for (const honorSourceFilter of [false, true]) {
  const mode = honorSourceFilter ? 'database applies the source filter' : 'database ignores the source filter';

  test(`/api/ioc free tier STIX bundle: no abuse.ch rows, other sources intact (${mode})`, async () => {
    installFetch({ honorSourceFilter });
    const res = await getIocBundle({ 'x-free-tier': '1' });
    assert.equal(res.statusCode, 200);
    assertNoAbusech('/api/ioc free tier', res.rawBody);
    assertOtherSourcesPresent('/api/ioc free tier', res.rawBody);
    assert.ok(res.rawBody.includes(MIXED), 'the OTX row for the shared indicator is still served');
  });

  test(`/api/ioc licensed (paid) STIX bundle: no abuse.ch rows, other sources intact (${mode})`, async () => {
    installFetch({ honorSourceFilter });
    const res = await getIocBundle({ 'x-api-key': 'valid-license' });
    assert.equal(res.statusCode, 200);
    assertNoAbusech('/api/ioc licence', res.rawBody);
    assertOtherSourcesPresent('/api/ioc licence', res.rawBody);
  });

  test(`MCP get_threat_indicators (paid): no abuse.ch rows, other sources intact (${mode})`, async () => {
    installFetch({ honorSourceFilter });
    const bundle = await callMcp('get_threat_indicators', { limit: 1000 });
    assertNoAbusech('get_threat_indicators', bundle);
    assertOtherSourcesPresent('get_threat_indicators', bundle);
  });

  test(`MCP get_ioc_context: abuse.ch-only indicators are found:false; shared ones show only the other source (${mode})`, async () => {
    installFetch({ honorSourceFilter });
    for (const value of HIDDEN_VALUES) {
      const out = await callMcp('get_ioc_context', { value });
      assert.equal(out.found, false, value);
      assertNoAbusech(`get_ioc_context ${value}`, out, [value]);
    }
    const mixed = await callMcp('get_ioc_context', { value: MIXED });
    assert.equal(mixed.found, true);
    assert.deepEqual(mixed.provenance.sources, ['AlienVault-OTX']);
    assert.equal(mixed.provenance.observation_count, 1);
    assertNoAbusech('get_ioc_context mixed', mixed);
    for (const value of UNIQUE_OTHER_VALUES) {
      const out = await callMcp('get_ioc_context', { value });
      assert.equal(out.found, true, value);
    }
  });

  test(`MCP get_ioc_batch: no abuse.ch rows (${mode})`, async () => {
    installFetch({ honorSourceFilter });
    const out = await callMcp('get_ioc_batch', { values: [...HIDDEN_VALUES, MIXED, '198.51.100.61'] });
    assertNoAbusech('get_ioc_batch', out, HIDDEN_VALUES);
    for (const value of HIDDEN_VALUES) assert.equal(out.results.find((r) => r.indicator === value).found, false, value);
    assert.ok(JSON.stringify(out).includes('198.51.100.61'));
    assert.ok(JSON.stringify(out).includes('AlienVault-OTX'));
  });

  test(`REST /api/ioc/context: no abuse.ch rows (${mode})`, async () => {
    installFetch({ honorSourceFilter });
    for (const value of HIDDEN_VALUES) {
      const out = await callRestContext(value);
      assert.equal(out.found, false, value);
      assertNoAbusech(`/api/ioc/context ${value}`, out, [value]);
    }
    const mixed = await callRestContext(MIXED);
    assert.deepEqual(mixed.provenance.sources, ['AlienVault-OTX']);
    assertNoAbusech('/api/ioc/context', mixed);
  });

  test(`chat tools get_ioc_context / get_ioc_batch: no abuse.ch rows (${mode})`, async () => {
    installFetch({ honorSourceFilter });
    for (const value of [...HIDDEN_VALUES, MIXED]) {
      assertNoAbusech(`chat get_ioc_context ${value}`, await callChatTool('get_ioc_context', { value }), [value]);
    }
    const batch = await callChatTool('get_ioc_batch', { values: [...HIDDEN_VALUES, MIXED, '198.51.100.61'] });
    assertNoAbusech('chat get_ioc_batch', batch, HIDDEN_VALUES);
    assert.ok(JSON.stringify(batch).includes('198.51.100.61'));
  });
}

test('the query itself excludes abuse.ch and unattributed rows, so limit counts servable rows', async () => {
  const urls = installFetch({ honorSourceFilter: true });
  await callMcp('get_threat_indicators', { limit: 5 });
  assert.equal(urls.length, 1);
  const params = new URL(urls[0]).searchParams;
  for (const p of ['*abuse.ch*', '*threatfox*', '*urlhaus*', 'Sovereign-Engine-*']) {
    assert.ok(params.get('and').includes(`verification_source.not.ilike.${p}`), p);
  }
  const bundle = await callMcp('get_threat_indicators', { limit: 5 });
  assert.equal(bundle.objects.length, 5);
  assertNoAbusech('limited bundle', bundle);
});

test('diagnostics endpoint withholds indicator-table rows from abuse.ch or with no source', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  assert.equal(typeof createClient, 'function');
  installFetch();
  // The supabase-js client goes through global fetch; answer its table read
  // with the seeded rows whatever table was asked for.
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
  assertNoAbusech('diagnostics records', res.body.records);
  assertOtherSourcesPresent('diagnostics records', res.body.records);
});

test('playground and A2A expose no indicator tool at all', () => {
  for (const name of ['get_threat_indicators', 'get_ioc_context', 'get_ioc_batch']) {
    assert.ok(!PLAYGROUND_TOOLS.includes(name), `playground ${name}`);
    assert.ok(!A2A_SKILL_TOOLS.some((t) => t.name === name), `a2a ${name}`);
  }
});

// ---------------------------------------------------------------------
// The switches
// ---------------------------------------------------------------------

test('SOURCE_ABUSECH_ENABLED=true serves abuse.ch rows again (the switch is what hides them)', async () => {
  process.env.SOURCE_ABUSECH_ENABLED = 'true';
  installFetch({ honorSourceFilter: true });
  const res = await getIocBundle({ 'x-api-key': 'valid-license' });
  for (const value of ABUSECH_ONLY_VALUES) assert.ok(res.rawBody.includes(value), value);
  const mixed = await callMcp('get_ioc_context', { value: MIXED });
  assert.deepEqual(mixed.provenance.sources.sort(), ['AlienVault-OTX', 'abuse.ch ThreatFox']);
  // Unattributed rows stay hidden: they have their own switch.
  assert.ok(!res.rawBody.includes('legacy.example'));
});

test('the mechanism is generic: SOURCE_OTX_ENABLED=false hides OTX the same way, nothing else moves', async () => {
  process.env.SOURCE_OTX_ENABLED = 'false';
  for (const honorSourceFilter of [false, true]) {
    installFetch({ honorSourceFilter });
    const bundle = await callMcp('get_threat_indicators', { limit: 1000 });
    const text = JSON.stringify(bundle);
    assert.ok(!text.includes('198.51.100.61'), 'OTX row hidden');
    assert.ok(!text.includes(MIXED), 'both rows of the shared indicator hidden (abuse.ch off, OTX off)');
    for (const value of UNIQUE_OTHER_VALUES.filter((v) => v !== '198.51.100.61')) assert.ok(text.includes(value), value);
    assertNoAbusech('OTX off', bundle);
  }
});

test('SOURCE_SCAMSNIFFER_ENABLED=false hides ScamSniffer rows', async () => {
  process.env.SOURCE_SCAMSNIFFER_ENABLED = 'false';
  installFetch();
  const res = await getIocBundle({ 'x-api-key': 'valid-license' });
  assert.ok(!res.rawBody.includes('drainer.example'));
  assert.ok(res.rawBody.includes('198.51.100.61'));
});

test('classifySource: every label the pipeline has written maps to the right source', () => {
  const cases = {
    'abuse.ch ThreatFox': 'abusech', 'abuse.ch URLhaus': 'abusech', 'URLhaus-Fallback': 'abusech',
    'ThreatFox': 'abusech', 'abuse.ch MalwareBazaar': 'abusech', 'ABUSE.CH': 'abusech',
    'Sovereign-Engine-v3.2-Cobalt Strike': 'unattributed', 'Sovereign-Engine-v3.2-OTX pulse': 'unattributed',
    '': 'unattributed', '   ': 'unattributed',
    'AlienVault-OTX': 'otx', 'NVD': 'nvd', 'NVD-CVE-v2.0-Gateway': 'nvd', 'Blocklist.de': 'blocklist_de',
    'Blocklist.de-Fallback': 'blocklist_de', 'AbuseIPDB': 'abuseipdb', 'PG1-Swarm-w1-tee': 'pg1_swarm',
    'ScamSniffer': 'scamsniffer', 'test-source': 'other'
  };
  for (const [label, id] of Object.entries(cases)) assert.equal(policy.classifySource(label), id, label);
  assert.equal(policy.classifySource(null), 'unattributed');
  assert.equal(policy.classifySource(undefined), 'unattributed');
});

test('switch values: defaults, explicit on/off, unknown values keep the default', () => {
  assert.equal(policy.isSourceEnabled('abusech', {}), false);
  assert.equal(policy.isSourceEnabled('unattributed', {}), false);
  assert.equal(policy.isSourceEnabled('otx', {}), true);
  assert.equal(policy.isSourceEnabled('other', {}), true);
  for (const on of ['true', 'TRUE', '1', 'yes', 'on', ' true ']) assert.equal(policy.isSourceEnabled('abusech', { SOURCE_ABUSECH_ENABLED: on }), true, on);
  for (const keep of ['', 'maybe', 'enabled']) assert.equal(policy.isSourceEnabled('abusech', { SOURCE_ABUSECH_ENABLED: keep }), false, keep);
  for (const off of ['false', '0', 'no', 'off']) assert.equal(policy.isSourceEnabled('otx', { SOURCE_OTX_ENABLED: off }), false, off);
  assert.equal(policy.isSourceEnabled('no-such-source', {}), false);
  // Every switch on: only the locked AbuseIPDB source is still filtered out.
  const [param] = policy.disabledSourceQueryParams(Object.fromEntries(
    [...policy.THREAT_SOURCES, policy.OTHER_SOURCE].map((s) => [s.env, 'true'])));
  assert.equal(decodeURIComponent(param), 'or=(verification_source.is.null,and(verification_source.not.ilike.*abuseipdb*))');
});

test('AbuseIPDB rows are never served: the source is locked off and SOURCE_ABUSEIPDB_ENABLED cannot turn it on', async () => {
  for (const on of [undefined, 'true', '1', 'yes', 'on']) {
    const env = on === undefined ? {} : { SOURCE_ABUSEIPDB_ENABLED: on };
    assert.equal(policy.isSourceEnabled('abuseipdb', env), false, String(on));
  }
  process.env.SOURCE_ABUSEIPDB_ENABLED = 'true';
  try {
    for (const honorSourceFilter of [false, true]) {
      installFetch({ honorSourceFilter });
      const bundle = await callMcp('get_threat_indicators', { limit: 1000 });
      assert.doesNotMatch(JSON.stringify(bundle), /198\.51\.100\.3\b|AbuseIPDB/i);
      const ctx = await callMcp('get_ioc_context', { value: '198.51.100.3' });
      assert.equal(ctx.found, false);
      const res = await getIocBundle({ 'x-api-key': 'valid-license' });
      assert.ok(!res.rawBody.includes('198.51.100.3'));
    }
  } finally {
    delete process.env.SOURCE_ABUSEIPDB_ENABLED;
  }
});

test('with unattributed rows switched on, NULL labels pass the query filter but abuse.ch still does not', () => {
  const env = { SOURCE_UNATTRIBUTED_ENABLED: 'true' };
  const [param] = policy.disabledSourceQueryParams(env);
  assert.match(param, /^or=/);
  const kept = applySourceConditions(ALL_ROWS, new URLSearchParams(param));
  assert.ok(kept.some((r) => r.verification_source == null));
  assert.ok(kept.some((r) => r.value === 'legacy.example'));
  assert.ok(!kept.some((r) => policy.classifySource(r.verification_source) === 'abusech'));
});

test('a failed query is reported, never served as an empty result', async () => {
  const result = await policy.fetchThreatTelemetry('https://example.supabase.co', 'k', ['select=*'], {
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ALL_ROWS })
  });
  assert.deepEqual(result, { ok: false, status: 503, rows: [] });
});

// ---------------------------------------------------------------------
// Public wording (one version bump, three description edits)
// ---------------------------------------------------------------------

const DESCRIPTION_EDITS = [
  ['get_threat_indicators', 'sourced from ThreatFox, URLhaus, OTX and NVD.', 'sourced from OTX and NVD.'],
  ['get_ioc_context', 'Returns aggregated provenance from ThreatFox, URLhaus, and OTX — reporting', 'Returns aggregated provenance from OTX — reporting'],
  ['get_ioc_batch', 'aggregated provenance as get_ioc_context from ThreatFox, URLhaus, and OTX.', 'aggregated provenance as get_ioc_context from OTX.']
];

test('tool definitions differ from 1.14.0 only by the three listed description edits', () => {
  // check_ip_abuse (1.16.0) and check_package (1.17.0) are the additions; the 14 tools
  // before them are pinned.
  const reverted = TOOLS.filter((tool) => tool.name !== 'check_ip_abuse' && tool.name !== 'check_package').map((tool) => {
    const edit = DESCRIPTION_EDITS.find(([name]) => name === tool.name);
    if (!edit) return tool;
    assert.ok(tool.description.includes(edit[2]), tool.name);
    return { ...tool, description: tool.description.replace(edit[2], edit[1]) };
  });
  // SHA-256 of JSON.stringify(TOOLS) at the 1.14.0 release.
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(reverted)).digest('hex'), '47dde1cff3ff1f64f1020b8d06813321f51c8db2142390bad0096616c8767acc');
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
  assert.equal(read('server.json').version, '1.17.0');
  assert.equal(read('public/.well-known/agent-card.json').version, '1.17.0');
  assert.equal(read('public/openapi.json').info.version, '1.17.0');
  const res = makeRes();
  await mcpHandler({ method: 'POST', headers: {}, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } }, res);
  assert.equal(res.body.result.serverInfo.version, '1.17.0');
  const get = makeRes();
  await mcpHandler({ method: 'GET', headers: {} }, get);
  assert.equal(get.body.version, '1.17.0');
});
