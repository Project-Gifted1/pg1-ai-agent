/**
 * check_package (1.17.0): the free pre-install check of one npm or PyPI
 * package, over MCP, A2A, the chat tools and the playground.
 *
 * Every registry and OSV answer here is synthetic and mocked through
 * global fetch; nothing reaches the network. Covers: each signal (exists,
 * publish dates, reported malicious, vulnerabilities, look-alike, npm
 * deprecation and install scripts) on mocked registries and OSV; the status
 * rules, including "unknown" on a partial failure and never "safe" or
 * "clean"; the licence allow-list of advisory sources; caching; fixtures;
 * the 60/hour limit and licence exemption; telemetry and error logs that
 * never carry the package; the /docs/attributions page and its links; and
 * that no AI client is imported on this path.
 *
 * Run with: node --test tests/check-package.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const mcp = await import('../api/mcp.mjs');
const { default: mcpHandler, TOOLS, handleCheckPackage, logPackageCheckFailures } = mcp;
const { default: a2aHandler, A2A_SKILL_TOOLS } = await import('../api/a2a.mjs');
const pkg = await import('../lib/packageCheck.mjs');
const { REASON_CODES, INFORMATIONAL_REASON_CODES } = await import('../lib/reasonCodes.mjs');
const { TEST_FIXTURES, FIXTURE_VALUES } = await import('../lib/fixtures.mjs');
const { chatToolsForRole, createToolExecutor, summarizeOutcome, GEMINI_SCHEMA_KEYS } = await import('../lib/chatTools.mjs');
const { PLAYGROUND_TOOLS, PLAYGROUND_TOOL_LIMITS, validatePlaygroundRequest, toolArgs, MESSAGES } = await import('../lib/playground.mjs');
const { createPlaygroundHandler } = await import('../api/playground.mjs');
const { DOC_PAGES, buildPage } = await import('../scripts/build-docs.mjs');
const { OSV_ADVISORY_SOURCES, PACKAGE_REGISTRIES, ALLOWED_OSV_ID_PREFIXES, ATTRIBUTIONS_URL } = await import('../lib/attributions.mjs');
const { PACKAGE_CHECK_RATE_LIMIT_MAX } = await import('../lib/x402Config.mjs');

const tool = TOOLS.find((t) => t.name === 'check_package');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
const NEVER = /\bsafe\b|\bclean\b/i;

beforeEach(() => pkg.__clearPackageCachesForTests());

// ---------------------------------------------------------------------------
// Synthetic upstream documents

function npmDoc({ name = 'pg1-synthetic', created = '2015-01-01T00:00:00.000Z', versions = { '1.0.0': {}, '2.0.0': {} }, latest = '2.0.0', times = {} } = {}) {
  const time = { created, modified: '2026-01-01T00:00:00.000Z' };
  let i = 0;
  for (const v of Object.keys(versions)) time[v] = times[v] || new Date(Date.parse(created) + (i++) * DAY).toISOString();
  return {
    name,
    'dist-tags': { latest },
    time,
    versions: Object.fromEntries(Object.entries(versions).map(([v, meta]) => [v, { name, version: v, scripts: { test: 'node test' }, ...meta }])),
    readme: 'synthetic upstream-only-marker readme'
  };
}

function pypiDoc({ name = 'pg1-synthetic', latest = '2.31.0', releases = null } = {}) {
  const rel = releases || {
    '1.0.0': [{ upload_time_iso_8601: '2012-02-14T12:00:00.000000Z' }],
    '2.31.0': [{ upload_time_iso_8601: '2023-05-22T15:12:00.000000Z' }, { upload_time_iso_8601: '2023-05-22T15:13:00.000000Z' }]
  };
  return { info: { name, version: latest, summary: 'synthetic upstream-only-marker summary' }, releases: rel, urls: rel[latest] || [] };
}

function osvVuln(id, extra = {}) {
  return { id, summary: 'upstream-only-marker summary', details: 'upstream-only-marker details', aliases: ['CVE-0000-9999'], affected: [], ...extra };
}

// One global fetch spy: registries, OSV, Gumroad, Supabase (telemetry and
// the error log). `routes.npm(name)`, `routes.pypi(name)` and
// `routes.osv(body)` return { status, body } | { throw } for their host.
function spyFetch(t, routes = {}) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, opts });
    const respond = (r) => {
      if (!r) return new Response('{"error":"Not found"}', { status: 404 });
      if (r.throw) throw r.throw;
      return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    };
    if (u.startsWith('https://registry.npmjs.org/')) {
      return respond(routes.npm ? await routes.npm(decodeURIComponent(u.slice('https://registry.npmjs.org/'.length))) : null);
    }
    if (u.startsWith('https://pypi.org/pypi/')) {
      return respond(routes.pypi ? await routes.pypi(decodeURIComponent(u.slice('https://pypi.org/pypi/'.length).replace(/\/json$/, ''))) : null);
    }
    if (u === 'https://api.osv.dev/v1/query') {
      return respond(routes.osv ? await routes.osv(JSON.parse(opts.body)) : { status: 200, body: {} });
    }
    if (u.includes('api.gumroad.com')) {
      const key = new URLSearchParams(opts.body).get('license_key');
      return new Response(JSON.stringify(key === 'valid-test-licence' ? { success: true, purchase: {} } : { success: false }), { status: 200 });
    }
    if (u.includes('/rest/v1/pg1_errors') && !opts.method) return new Response('[]', { status: 200 });
    return new Response('', { status: 201 });
  };
  t.after(() => { global.fetch = original; });
  return {
    calls,
    upstream: () => calls.filter((c) => /registry\.npmjs\.org|pypi\.org|api\.osv\.dev/.test(c.url)),
    osv: () => calls.filter((c) => c.url === 'https://api.osv.dev/v1/query').map((c) => JSON.parse(c.opts.body)),
    supabase: (table) => calls.filter((c) => c.url.includes(`/rest/v1/${table}`) && c.opts.method === 'POST' && c.opts.body).map((c) => JSON.parse(c.opts.body))
  };
}

function withEnv(t, vars) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

const withSupabase = (t) => withEnv(t, { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key', GUMROAD_PRODUCT_ID: 'test-product' });

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; }
  };
}

let ipCounter = 0;
const freshIp = () => { ipCounter += 1; return `100.64.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`; };

async function callMcp(args, { ip = freshIp(), headers = {} } = {}) {
  const res = makeRes();
  await mcpHandler({ method: 'POST', headers: { 'x-forwarded-for': ip, ...headers }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_package', arguments: args } } }, res);
  return res;
}

async function callA2a(args, { ip = freshIp() } = {}) {
  const res = makeRes();
  await a2aHandler({ method: 'POST', headers: { 'x-forwarded-for': ip }, query: {}, body: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: 'm1', parts: [{ kind: 'data', data: { skill: 'check_package', arguments: args } }] } } } }, res);
  return res;
}

const mcpPayload = (res) => JSON.parse(res.body.result.content[0].text);
const codes = (r) => r.reasons.map((x) => x.code);
const settle = () => new Promise((r) => setTimeout(r, 20));
const check = (r, source) => r.checks.find((c) => c.source === source);

// ---------------------------------------------------------------------------
// Definition and registration

test('definition: one package per call; ecosystem npm|pypi and name required, version optional; Gemini-safe schemas', () => {
  assert.ok(tool, 'check_package is an MCP tool');
  assert.equal(TOOLS[TOOLS.length - 1], tool, 'added at the end of the list');
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['ecosystem', 'name', 'version']);
  assert.deepEqual(tool.inputSchema.required, ['ecosystem', 'name']);
  assert.deepEqual(tool.inputSchema.properties.ecosystem.enum, ['npm', 'pypi']);
  const keywords = new Set();
  (function walk(s) {
    if (!s || typeof s !== 'object') return;
    if (Array.isArray(s)) return s.forEach(walk);
    for (const [k, v] of Object.entries(s)) {
      keywords.add(k);
      if (k === 'properties') Object.values(v).forEach(walk); else walk(v);
    }
  })({ i: tool.inputSchema, o: tool.outputSchema });
  for (const k of ['i', 'o']) keywords.delete(k);
  for (const name of Object.keys(tool.outputSchema.properties)) keywords.delete(name);
  for (const name of Object.keys(tool.inputSchema.properties)) keywords.delete(name);
  for (const name of ['text', 'url', 'id', 'severity', 'cvss_vector', 'code', 'message', 'source', 'result', 'checked_at', 'data_as_of']) keywords.delete(name);
  assert.deepEqual([...keywords].filter((k) => !GEMINI_SCHEMA_KEYS.has(k)), []);
});

test('description: free, no AI model, the status rules, never safe/clean wording as a verdict, and links /docs/attributions', () => {
  const d = tool.description;
  assert.match(d, /always free/);
  assert.match(d, /no AI model/);
  assert.match(d, /reported malicious/);
  assert.match(d, /PACKAGE_REPORTED_MALICIOUS/);
  assert.match(d, /PACKAGE_NOT_FOUND/);
  assert.match(d, /PACKAGE_NEW_LOOKALIKE/);
  assert.match(d, /never returns "safe" or "clean"/);
  assert.match(d, /60 calls\/hour/);
  assert.ok(d.includes(ATTRIBUTIONS_URL), 'tool description links the attributions page');
});

test('registered everywhere a free check is: A2A skill, agent card, chat (operator and guest), playground', () => {
  assert.equal(A2A_SKILL_TOOLS.find((t) => t.name === 'check_package'), tool, 'A2A reuses the MCP definition');
  const card = JSON.parse(read('public/.well-known/agent-card.json'));
  const skill = card.skills.find((s) => s.id === 'check_package');
  assert.ok(skill);
  assert.equal(skill.security, undefined, 'no key needed');
  assert.ok(skill.description.includes(ATTRIBUTIONS_URL));
  assert.equal(card.version, '1.17.0');
  assert.ok(chatToolsForRole('operator').some((t) => t === tool));
  assert.ok(chatToolsForRole('guest').some((t) => t === tool), 'guest set too');
  assert.ok(PLAYGROUND_TOOLS.includes('check_package'));
  assert.equal(PLAYGROUND_TOOL_LIMITS.check_package, 60);
  assert.equal(PACKAGE_CHECK_RATE_LIMIT_MAX, 60);
});

test('new reason codes are in lib/reasonCodes.mjs, worded "reported malicious", never "safe", never a vendor', () => {
  for (const code of ['PACKAGE_REPORTED_MALICIOUS', 'PACKAGE_NOT_FOUND', 'PACKAGE_VERSION_NOT_FOUND', 'PACKAGE_NEW_LOOKALIKE', 'PACKAGE_LOOKALIKE', 'PACKAGE_NEWLY_PUBLISHED', 'PACKAGE_KNOWN_VULNERABILITIES', 'PACKAGE_DEPRECATED', 'PACKAGE_INSTALL_SCRIPTS']) {
    assert.ok(code in REASON_CODES, code);
    assert.doesNotMatch(REASON_CODES[code], NEVER, code);
    assert.doesNotMatch(REASON_CODES[code], /osv|openssf|github|npm|pypi/i, code);
  }
  assert.match(REASON_CODES.PACKAGE_REPORTED_MALICIOUS, /reported malicious/);
  assert.match(REASON_CODES.PACKAGE_REPORTED_MALICIOUS, /false positives/);
  for (const flagging of ['PACKAGE_REPORTED_MALICIOUS', 'PACKAGE_NOT_FOUND', 'PACKAGE_VERSION_NOT_FOUND', 'PACKAGE_NEW_LOOKALIKE']) assert.ok(!INFORMATIONAL_REASON_CODES.includes(flagging), flagging);
});

// ---------------------------------------------------------------------------
// Input validation

test('invalid input is an isError tool result with a fix-it message, never echoes the input, and makes no request', async (t) => {
  const spy = spyFetch(t);
  const cases = [
    [{ name: 'lodash' }, 'invalid_ecosystem'],
    [{ ecosystem: 'maven', name: 'lodash' }, 'invalid_ecosystem'],
    [{ ecosystem: 'npm' }, 'invalid_package_name'],
    [{ ecosystem: 'npm', name: 'lodash react' }, 'invalid_package_name'],
    [{ ecosystem: 'npm', name: '.hidden-marker' }, 'invalid_package_name'],
    [{ ecosystem: 'npm', name: 'a'.repeat(215) }, 'invalid_package_name'],
    [{ ecosystem: 'pypi', name: '-bad-marker-' }, 'invalid_package_name'],
    [{ ecosystem: 'npm', name: 'lodash', version: '^4.0.0' }, 'invalid_version'],
    [{ ecosystem: 'npm', name: 'lodash', version: 'latest marker' }, 'invalid_version'],
    [{ ecosystem: 'npm', name: 'lodash', version: 4 }, 'invalid_version']
  ];
  for (const [args, code] of cases) {
    const res = await callMcp(args);
    assert.equal(res.body.result.isError, true, JSON.stringify(args));
    const body = mcpPayload(res);
    assert.equal(body.code, code, JSON.stringify(args));
    assert.equal(body.status, 'unknown');
    assert.match(body.message, /Expected: .*Example: .*request_id: /);
    assert.doesNotMatch(body.message, /marker|\^4\.0\.0/);
  }
  assert.deepEqual(spy.upstream(), [], 'no registry or OSV request for invalid input');
});

test('normalisation: scoped npm names, legacy capitals kept for npm; PyPI PEP 503', () => {
  assert.deepEqual(pkg.normalizePackageName('npm', ' @types/node '), { name: '@types/node', lookupName: '@types/node' });
  assert.deepEqual(pkg.normalizePackageName('npm', 'JSONStream'), { name: 'JSONStream', lookupName: 'JSONStream' });
  assert.deepEqual(pkg.normalizePackageName('pypi', 'Python_DateUtil'), { name: 'Python_DateUtil', lookupName: 'python-dateutil' });
  assert.equal(pkg.normalizeEcosystem(' PyPI '), 'pypi');
  assert.equal(pkg.normalizePackageVersion(''), null);
  assert.equal(pkg.normalizePackageVersion('1.0.0-rc.1+build.5'), '1.0.0-rc.1+build.5');
});

// ---------------------------------------------------------------------------
// Signals

test('npm: exists, first and latest publish dates, version checked defaults to latest; identifying User-Agent; scoped URL', async (t) => {
  const spy = spyFetch(t, {
    npm: (name) => ({ status: 200, body: npmDoc({ name, created: '2016-03-01T00:00:00.000Z', times: { '2.0.0': '2024-02-02T00:00:00.000Z' } }) }),
    osv: () => ({ status: 200, body: {} })
  });
  const r = await handleCheckPackage({ ecosystem: 'npm', name: '@pg1-synthetic/thing' }, 'tester', null, { licensed: true });
  assert.equal(r.exists, true);
  assert.equal(r.version_requested, null);
  assert.equal(r.version_checked, '2.0.0');
  assert.equal(r.version_exists, true);
  assert.equal(r.first_published, '2016-03-01T00:00:00.000Z');
  assert.equal(r.latest_version, '2.0.0');
  assert.equal(r.latest_published, '2024-02-02T00:00:00.000Z');
  assert.ok(r.age_days > 3000);
  assert.equal(r.reported_malicious, false);
  assert.deepEqual(r.vulnerabilities, []);
  assert.equal(r.status, 'no_flags');
  assert.deepEqual(r.reasons, []);
  const [regCall] = spy.upstream();
  assert.equal(regCall.url, 'https://registry.npmjs.org/@pg1-synthetic%2Fthing');
  assert.match(regCall.opts.headers['User-Agent'], /^pg1-threat-intel\/1\.17\.0 .*docs\/attributions/);
  assert.deepEqual(spy.osv(), [{ package: { name: '@pg1-synthetic/thing', ecosystem: 'npm' }, version: '2.0.0' }], 'OSV is asked about the latest version');
  assert.deepEqual(r.checks.map((c) => [c.source, c.result]), [['package registry', 'ok'], ['malicious package reports', 'ok'], ['vulnerability database', 'ok'], ['popular package names', 'ok']]);
  assert.doesNotMatch(JSON.stringify(r), /upstream-only-marker/, 'nothing from the readme is passed on');
});

test('npm only: deprecated flag and message, install scripts (explicit hooks and the implicit node-gyp install)', async (t) => {
  spyFetch(t, {
    npm: (name) => ({
      status: 200,
      body: npmDoc({
        name,
        versions: {
          '1.0.0': { deprecated: 'Use pg1-other instead.\u0007', scripts: { preinstall: 'node a.js', postinstall: 'node b.js', test: 'x' } },
          '2.0.0': { gypfile: true, scripts: { postinstall: 'node c.js' } },
          '3.0.0': {}
        },
        latest: '3.0.0'
      })
    })
  });
  const v1 = await handleCheckPackage({ ecosystem: 'npm', name: 'pg1-synthetic', version: '1.0.0' }, 'tester', null, { licensed: true });
  assert.equal(v1.deprecated, true);
  assert.equal(v1.deprecation_message, 'Use pg1-other instead.');
  assert.deepEqual(v1.install_scripts, ['preinstall', 'postinstall']);
  assert.deepEqual(codes(v1), ['PACKAGE_DEPRECATED', 'PACKAGE_INSTALL_SCRIPTS']);
  assert.equal(v1.status, 'no_flags', 'deprecation and install scripts are informational');

  const v2 = await handleCheckPackage({ ecosystem: 'npm', name: 'pg1-synthetic', version: '2.0.0' }, 'tester', null, { licensed: true });
  assert.deepEqual(v2.install_scripts, ['install', 'postinstall'], 'binding.gyp means npm runs an install script');
  assert.equal(v2.deprecated, false);

  const v3 = await handleCheckPackage({ ecosystem: 'npm', name: 'pg1-synthetic' }, 'tester', null, { licensed: true });
  assert.deepEqual(v3.install_scripts, []);
  assert.equal(v3.deprecated, false);
  assert.deepEqual(codes(v3), []);
});

test('PyPI: exists, first publish across all files, latest publish, PEP 440 version match; npm-only fields are null', async (t) => {
  const spy = spyFetch(t, { pypi: () => ({ status: 200, body: pypiDoc({ name: 'Pg1-Synthetic' }) }), osv: () => ({ status: 200, body: {} }) });
  const r = await handleCheckPackage({ ecosystem: 'pypi', name: 'pg1_synthetic', version: '2.31' }, 'tester', null, { licensed: true });
  assert.equal(r.exists, true);
  assert.equal(r.canonical_name, 'Pg1-Synthetic');
  assert.equal(r.version_checked, '2.31.0', 'the published spelling of the requested version');
  assert.equal(r.version_exists, true);
  assert.equal(r.first_published, '2012-02-14T12:00:00.000Z');
  assert.equal(r.latest_published, '2023-05-22T15:12:00.000Z');
  assert.equal(r.deprecated, null);
  assert.equal(r.install_scripts, null);
  assert.equal(r.status, 'no_flags');
  assert.equal(spy.upstream()[0].url, 'https://pypi.org/pypi/pg1-synthetic/json');
  assert.deepEqual(spy.osv()[0], { package: { name: 'pg1-synthetic', ecosystem: 'PyPI' }, version: '2.31' });
});

test('missing package: exists false, flagged PACKAGE_NOT_FOUND; a package-level OSV query still reports malicious reports', async (t) => {
  const spy = spyFetch(t, {
    pypi: () => ({ status: 404, body: { message: 'Not Found' } }),
    osv: (body) => ({ status: 200, body: body.version ? {} : { vulns: [osvVuln('MAL-2026-1234')] } })
  });
  const r = await handleCheckPackage({ ecosystem: 'pypi', name: 'pg1-hallucinated-pkg' }, 'tester', null, { licensed: true });
  assert.equal(r.exists, false);
  assert.equal(r.version_checked, null);
  assert.equal(r.status, 'flagged');
  assert.deepEqual(codes(r), ['PACKAGE_REPORTED_MALICIOUS', 'PACKAGE_NOT_FOUND']);
  assert.match(r.reasons[0].message, /reported malicious/);
  assert.deepEqual(r.malicious_reports, ['MAL-2026-1234']);
  assert.equal(r.vulnerabilities, null, 'no version to check vulnerabilities for');
  assert.equal(check(r, 'vulnerability database').result, 'skipped');
  assert.deepEqual(spy.osv(), [{ package: { name: 'pg1-hallucinated-pkg', ecosystem: 'PyPI' } }], 'package-level query, no version');
});

test('an npm package with no versions (fully unpublished) does not exist', async (t) => {
  spyFetch(t, { npm: () => ({ status: 200, body: { name: 'pg1-gone', time: { unpublished: { time: '2020-01-01T00:00:00.000Z' } } } }) });
  const r = await handleCheckPackage({ ecosystem: 'npm', name: 'pg1-gone' }, 'tester', null, { licensed: true });
  assert.equal(r.exists, false);
  assert.equal(r.status, 'flagged');
  assert.ok(codes(r).includes('PACKAGE_NOT_FOUND'));
});

test('missing version: flagged PACKAGE_VERSION_NOT_FOUND; registry and OSV run in parallel when a version is given', async (t) => {
  const spy = spyFetch(t, { npm: (name) => ({ status: 200, body: npmDoc({ name }) }), osv: () => ({ status: 200, body: {} }) });
  const r = await handleCheckPackage({ ecosystem: 'npm', name: 'pg1-synthetic', version: '9.9.9' }, 'tester', null, { licensed: true });
  assert.equal(r.exists, true);
  assert.equal(r.version_checked, '9.9.9');
  assert.equal(r.version_exists, false);
  assert.equal(r.deprecated, null);
  assert.equal(r.install_scripts, null);
  assert.deepEqual(codes(r), ['PACKAGE_VERSION_NOT_FOUND']);
  assert.equal(r.status, 'flagged');
  assert.deepEqual(spy.osv(), [{ package: { name: 'pg1-synthetic', ecosystem: 'npm' }, version: '9.9.9' }]);
});

test('reported malicious: an OSV MAL- advisory for the version flags, worded "reported malicious"', async (t) => {
  spyFetch(t, {
    npm: (name) => ({ status: 200, body: npmDoc({ name }) }),
    osv: () => ({ status: 200, body: { vulns: [osvVuln('MAL-2025-0002'), osvVuln('MAL-2025-0001')] } })
  });
  const r = await handleCheckPackage({ ecosystem: 'npm', name: 'pg1-synthetic' }, 'tester', null, { licensed: true });
  assert.equal(r.reported_malicious, true);
  assert.deepEqual(r.malicious_reports, ['MAL-2025-0001', 'MAL-2025-0002']);
  assert.deepEqual(r.vulnerabilities, [], 'MAL- reports are not vulnerabilities');
  assert.equal(r.status, 'flagged');
  assert.equal(r.reasons[0].code, 'PACKAGE_REPORTED_MALICIOUS');
  assert.match(r.reasons[0].message, /reported malicious .*false positives/);
  assert.match(r.note, /Reported malicious" means a public report exists/);
});

test('vulnerabilities: ids and severity only, allow-listed sources only, others counted as omitted; informational', async (t) => {
  spyFetch(t, {
    npm: (name) => ({ status: 200, body: npmDoc({ name }) }),
    osv: () => ({
      status: 200,
      body: {
        vulns: [
          osvVuln('GHSA-aaaa-bbbb-cccc', { database_specific: { severity: 'HIGH' }, severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] }),
          osvVuln('PYSEC-2026-1', { database_specific: { severity: 'bogus' } }),
          osvVuln('UBUNTU-CVE-2026-0001'),
          osvVuln('DEBIAN-CVE-2026-0002'),
          osvVuln('CVE-2026-0003'),
          osvVuln('GHSA-aaaa-bbbb-cccc')
        ]
      }
    })
  });
  const r = await handleCheckPackage({ ecosystem: 'npm', name: 'pg1-synthetic' }, 'tester', null, { licensed: true });
  assert.deepEqual(r.vulnerabilities, [
    { id: 'GHSA-aaaa-bbbb-cccc', severity: 'HIGH', cvss_vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
    { id: 'PYSEC-2026-1', severity: null, cvss_vector: null }
  ]);
  assert.equal(r.vulnerabilities_omitted, 3);
  assert.deepEqual(codes(r), ['PACKAGE_KNOWN_VULNERABILITIES']);
  assert.match(r.reasons[0].message, /2 known vulnerabilities/);
  assert.equal(r.status, 'no_flags', 'known vulnerabilities never flag on their own');
  const text = JSON.stringify(r);
  assert.doesNotMatch(text, /upstream-only-marker|CVE-0000-9999|UBUNTU|DEBIAN/, 'no advisory text, aliases or excluded sources');
});

test('look-alike: separator, confusable, affix and typo patterns; a popular name is never its own look-alike', () => {
  assert.deepEqual(pkg.findLookalike('npm', 'react_dom'), { lookalike_of: 'react-dom', pattern: 'separator' });
  assert.deepEqual(pkg.findLookalike('npm', 'crossenv'), { lookalike_of: 'cross-env', pattern: 'separator' });
  assert.deepEqual(pkg.findLookalike('npm', 'l0dash'), { lookalike_of: 'lodash', pattern: 'confusable' });
  assert.deepEqual(pkg.findLookalike('pypi', 'djang0'), { lookalike_of: 'django', pattern: 'confusable' });
  assert.deepEqual(pkg.findLookalike('npm', 'axios-js'), { lookalike_of: 'axios', pattern: 'affix' });
  assert.deepEqual(pkg.findLookalike('pypi', 'python-requests'), { lookalike_of: 'requests', pattern: 'affix' });
  assert.deepEqual(pkg.findLookalike('npm', 'expresss'), { lookalike_of: 'express', pattern: 'edit_distance' });
  assert.deepEqual(pkg.findLookalike('pypi', 'reqeusts'), { lookalike_of: 'requests', pattern: 'edit_distance' });
  for (const [eco, name] of [['npm', 'lodash'], ['npm', 'react-dom'], ['pypi', 'requests'], ['npm', 'my-own-thing'], ['pypi', 'flask-restful'], ['npm', 'reaction']]) {
    assert.equal(pkg.findLookalike(eco, name), null, `${eco}:${name}`);
  }
  assert.equal(pkg.editDistance('lodash', 'lodahs'), 1, 'an adjacent swap is one edit');
});

test('look-alike alone and new alone are informational; new + look-alike is flagged PACKAGE_NEW_LOOKALIKE', async (t) => {
  const created = { old: '2019-01-01T00:00:00.000Z', fresh: daysAgo(5) };
  spyFetch(t, {
    npm: (name) => ({ status: 200, body: npmDoc({ name, created: name.endsWith('old') ? created.old : created.fresh, versions: { '1.0.0': {} }, latest: '1.0.0' }) }),
    pypi: (name) => ({ status: 200, body: pypiDoc({ name, latest: '0.1.0', releases: { '0.1.0': [{ upload_time_iso_8601: name === 'reqeusts' ? daysAgo(2) : '2019-01-01T00:00:00Z' }] } }) }),
    osv: () => ({ status: 200, body: {} })
  });
  // npm names that end in "old" are old; the rest are 5 days old.
  const oldLookalike = await handleCheckPackage({ ecosystem: 'npm', name: 'expresss-old' }, 'tester', null, { licensed: true });
  assert.equal(oldLookalike.lookalike_of, null, 'not close enough to anything');

  const lookalikeOld = await handleCheckPackage({ ecosystem: 'pypi', name: 'numpi' }, 'tester', null, { licensed: true });
  assert.equal(lookalikeOld.lookalike_of, 'numpy');
  assert.deepEqual(codes(lookalikeOld), ['PACKAGE_LOOKALIKE']);
  assert.equal(lookalikeOld.status, 'no_flags');

  const newOnly = await handleCheckPackage({ ecosystem: 'npm', name: 'pg1-brand-new' }, 'tester', null, { licensed: true });
  assert.deepEqual(codes(newOnly), ['PACKAGE_NEWLY_PUBLISHED']);
  assert.equal(newOnly.age_days, 5);
  assert.equal(newOnly.status, 'no_flags');

  const newLookalike = await handleCheckPackage({ ecosystem: 'pypi', name: 'reqeusts' }, 'tester', null, { licensed: true });
  assert.deepEqual(codes(newLookalike), ['PACKAGE_NEW_LOOKALIKE']);
  assert.match(newLookalike.reasons[0].message, /2 day\(s\) ago .*"requests"/);
  assert.equal(newLookalike.status, 'flagged');
});

// ---------------------------------------------------------------------------
// Status rules on failures

test('registry timeout: exists null (never false), status unknown; OSV still answers when a version is given', async (t) => {
  spyFetch(t, {
    npm: () => ({ throw: Object.assign(new Error('aborted'), { name: 'AbortError' }) }),
    osv: () => ({ status: 200, body: {} })
  });
  const r = await handleCheckPackage({ ecosystem: 'npm', name: 'pg1-synthetic', version: '1.0.0' }, 'tester', null, { licensed: true });
  assert.equal(r.exists, null);
  assert.equal(r.version_exists, null);
  assert.equal(r.first_published, null);
  assert.equal(r.reported_malicious, false);
  assert.equal(check(r, 'package registry').result, 'timeout');
  assert.equal(r.status, 'unknown');
  assert.ok(!codes(r).includes('PACKAGE_NOT_FOUND'), 'an outage never reads as "does not exist"');
});

test('registry 5xx with no version: package-level OSV query; vulnerabilities skipped; unknown', async (t) => {
  const spy = spyFetch(t, { npm: () => ({ status: 503, body: 'upstream-only-marker' }), osv: () => ({ status: 200, body: {} }) });
  const r = await handleCheckPackage({ ecosystem: 'npm', name: 'pg1-synthetic' }, 'tester', null, { licensed: true });
  assert.equal(r.exists, null);
  assert.equal(check(r, 'package registry').result, 'error');
  assert.equal(check(r, 'vulnerability database').result, 'skipped');
  assert.equal(r.reported_malicious, false);
  assert.equal(r.status, 'unknown');
  assert.deepEqual(spy.osv(), [{ package: { name: 'pg1-synthetic', ecosystem: 'npm' } }]);
});

test('OSV failure (partial): reported_malicious and vulnerabilities null, status unknown even though the registry answered', async (t) => {
  spyFetch(t, { pypi: () => ({ status: 200, body: pypiDoc() }), osv: () => ({ status: 500, body: {} }) });
  const r = await handleCheckPackage({ ecosystem: 'pypi', name: 'pg1-synthetic' }, 'tester', null, { licensed: true });
  assert.equal(r.exists, true);
  assert.equal(r.reported_malicious, null);
  assert.equal(r.malicious_reports, null);
  assert.equal(r.vulnerabilities, null);
  assert.equal(check(r, 'malicious package reports').result, 'error');
  assert.equal(check(r, 'vulnerability database').result, 'error');
  assert.equal(r.status, 'unknown');
});

test('a flag still flags when another lookup failed (PG1 status rules)', async (t) => {
  spyFetch(t, { npm: () => ({ throw: new Error('ECONNRESET') }), osv: () => ({ status: 200, body: { vulns: [osvVuln('MAL-2026-0001')] } }) });
  const r = await handleCheckPackage({ ecosystem: 'npm', name: 'pg1-synthetic', version: '1.0.0' }, 'tester', null, { licensed: true });
  assert.equal(check(r, 'package registry').result, 'error');
  assert.equal(r.status, 'flagged');
});

test('status precedence: any flag wins over a failed lookup; unknown only when nothing flagged and a lookup did not complete', async (t) => {
  const osvDown = () => ({ status: 503, body: {} });
  const cases = [
    // [label, routes, args, expected status, expected codes]
    ['reported malicious + registry down', { npm: () => ({ status: 500 }), osv: () => ({ status: 200, body: { vulns: [osvVuln('MAL-2026-0042')] } }) }, { ecosystem: 'npm', name: 'pg1-synthetic', version: '1.0.0' }, 'flagged', ['PACKAGE_REPORTED_MALICIOUS']],
    ['missing package + OSV down', { npm: () => ({ status: 404 }), osv: osvDown }, { ecosystem: 'npm', name: 'pg1-synthetic' }, 'flagged', ['PACKAGE_NOT_FOUND']],
    ['missing version + OSV down', { npm: (name) => ({ status: 200, body: npmDoc({ name }) }), osv: osvDown }, { ecosystem: 'npm', name: 'pg1-synthetic', version: '9.9.9' }, 'flagged', ['PACKAGE_VERSION_NOT_FOUND']],
    ['new + look-alike + OSV down', { npm: (name) => ({ status: 200, body: npmDoc({ name, created: daysAgo(4) }) }), osv: osvDown }, { ecosystem: 'npm', name: 'expresss' }, 'flagged', ['PACKAGE_NEW_LOOKALIKE']],
    ['informational only + OSV down', { npm: (name) => ({ status: 200, body: npmDoc({ name }) }), osv: osvDown }, { ecosystem: 'npm', name: 'expresss' }, 'unknown', ['PACKAGE_LOOKALIKE']],
    ['nothing at all + registry down', { npm: () => ({ throw: new Error('ECONNRESET') }), osv: () => ({ status: 200, body: {} }) }, { ecosystem: 'npm', name: 'pg1-synthetic' }, 'unknown', []]
  ];
  for (const [label, routes, args, status, expectedCodes] of cases) {
    pkg.__clearPackageCachesForTests();
    spyFetch(t, routes);
    const r = await handleCheckPackage(args, 'tester', null, { licensed: true });
    assert.ok(r.checks.some((c) => c.result !== 'ok'), `${label}: a lookup did not complete`);
    assert.equal(r.status, status, label);
    assert.deepEqual(codes(r), expectedCodes, label);
  }
});

test('a missing version of a real package has its own code, distinct from a package that does not exist', async (t) => {
  spyFetch(t, { npm: (name) => ({ status: name === 'pg1-synthetic' ? 200 : 404, body: npmDoc({ name }) }), osv: () => ({ status: 200, body: {} }) });
  const wrongVersion = await handleCheckPackage({ ecosystem: 'npm', name: 'pg1-synthetic', version: '9.9.9' }, 'tester', null, { licensed: true });
  const noPackage = await handleCheckPackage({ ecosystem: 'npm', name: 'pg1-invented-name', version: '9.9.9' }, 'tester', null, { licensed: true });
  assert.deepEqual([wrongVersion.exists, wrongVersion.version_exists, codes(wrongVersion)], [true, false, ['PACKAGE_VERSION_NOT_FOUND']]);
  assert.deepEqual([noPackage.exists, noPackage.version_exists, codes(noPackage)], [false, false, ['PACKAGE_NOT_FOUND']]);
  assert.notEqual(REASON_CODES.PACKAGE_VERSION_NOT_FOUND, REASON_CODES.PACKAGE_NOT_FOUND);
  assert.doesNotMatch(REASON_CODES.PACKAGE_VERSION_NOT_FOUND, /invented|attacker/i, 'not worded like a fake package');
});

test('OSV pagination is followed up to the page cap; past it the answer is incomplete', async (t) => {
  let pages = 0;
  spyFetch(t, {
    npm: (name) => ({ status: 200, body: npmDoc({ name }) }),
    osv: (body) => { pages++; return { status: 200, body: { vulns: [osvVuln(`GHSA-page-${pages}-x`)], next_page_token: body.page_token === 't2' ? '' : (body.page_token ? 't2' : 't1') } }; }
  });
  const r = await handleCheckPackage({ ecosystem: 'npm', name: 'pg1-synthetic' }, 'tester', null, { licensed: true });
  assert.equal(pages, 3);
  assert.equal(r.vulnerabilities.length, 3);
  assert.equal(r.status, 'no_flags');

  pkg.__clearPackageCachesForTests();
  const spy2 = spyFetch(t, { npm: (name) => ({ status: 200, body: npmDoc({ name }) }), osv: () => ({ status: 200, body: { vulns: [], next_page_token: 'more' } }) });
  const r2 = await handleCheckPackage({ ecosystem: 'npm', name: 'pg1-synthetic' }, 'tester', null, { licensed: true });
  assert.equal(spy2.osv().length, pkg.PACKAGE_OSV_MAX_PAGES);
  assert.equal(r2.reported_malicious, null);
  assert.equal(r2.status, 'unknown');
});

test('malformed upstream JSON and oversized bodies are failed lookups, not answers', async (t) => {
  spyFetch(t, { npm: () => ({ status: 200, body: 'not json' }), osv: () => ({ status: 200, body: { vulns: 'nope' } }) });
  const r = await handleCheckPackage({ ecosystem: 'npm', name: 'pg1-synthetic', version: '1.0.0' }, 'tester', null, { licensed: true });
  assert.equal(check(r, 'package registry').result, 'error');
  assert.equal(check(r, 'malicious package reports').result, 'error');
  assert.equal(r.status, 'unknown');
});

test('never "safe" or "clean", in any outcome', async (t) => {
  const scenarios = [
    { npm: (name) => ({ status: 200, body: npmDoc({ name }) }) },
    { npm: () => ({ status: 404 }) },
    { npm: () => ({ throw: new Error('x') }), osv: () => ({ status: 500 }) },
    { npm: (name) => ({ status: 200, body: npmDoc({ name, created: daysAgo(1) }) }), osv: () => ({ status: 200, body: { vulns: [osvVuln('MAL-2026-1'), osvVuln('GHSA-x')] } }) }
  ];
  for (const routes of scenarios) {
    pkg.__clearPackageCachesForTests();
    spyFetch(t, routes);
    for (const name of ['pg1-synthetic', 'expresss']) {
      const r = await handleCheckPackage({ ecosystem: 'npm', name }, 'tester', null, { licensed: true });
      assert.doesNotMatch(JSON.stringify(r), NEVER);
      assert.ok(['flagged', 'no_flags', 'unknown'].includes(r.status));
    }
  }
});

// ---------------------------------------------------------------------------
// Caching

test('caching: registry answers for 1 hour, OSV (malicious status) for 15 minutes, failures never', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T00:00:00Z') });
  const spy = spyFetch(t, { npm: (name) => ({ status: 200, body: npmDoc({ name }) }), osv: () => ({ status: 200, body: {} }) });
  const args = { ecosystem: 'npm', name: 'pg1-synthetic', version: '1.0.0' };
  const count = (host) => spy.calls.filter((c) => c.url.includes(host)).length;

  await handleCheckPackage(args, 'tester', null, { licensed: true });
  const second = await handleCheckPackage(args, 'tester', null, { licensed: true });
  assert.equal(second.cached, true);
  assert.equal(count('registry.npmjs.org'), 1);
  assert.equal(count('api.osv.dev'), 1);

  t.mock.timers.tick(16 * 60 * 1000);
  await handleCheckPackage(args, 'tester', null, { licensed: true });
  assert.equal(count('registry.npmjs.org'), 1, 'registry still cached at 16 minutes');
  assert.equal(count('api.osv.dev'), 2, 'malicious status refreshed after 15 minutes');

  t.mock.timers.tick(45 * 60 * 1000);
  await handleCheckPackage(args, 'tester', null, { licensed: true });
  assert.equal(count('registry.npmjs.org'), 2, 'registry refreshed after 1 hour');

  pkg.__clearPackageCachesForTests();
  const failing = spyFetch(t, { npm: () => ({ status: 500 }), osv: () => ({ status: 500 }) });
  await handleCheckPackage(args, 'tester', null, { licensed: true });
  await handleCheckPackage(args, 'tester', null, { licensed: true });
  assert.equal(failing.upstream().length, 4, 'a failure is retried on the next call, never cached');
  assert.deepEqual(pkg.__packageCacheSizesForTests(), { registry: 0, osv: 0 });
});

// ---------------------------------------------------------------------------
// MCP / A2A dispatch, limits, telemetry, logs

test('MCP: structuredContent mirrors the text result; request_id matches X-Request-Id; attribution present', async (t) => {
  spyFetch(t, { npm: (name) => ({ status: 200, body: npmDoc({ name }) }) });
  const res = await callMcp({ ecosystem: 'npm', name: 'pg1-synthetic' });
  assert.equal(res.statusCode, 200);
  const body = mcpPayload(res);
  assert.deepEqual(res.body.result.structuredContent, body);
  assert.equal(body.request_id, res.headers['X-Request-Id']);
  assert.deepEqual(body.attribution, { text: body.attribution.text, url: ATTRIBUTIONS_URL });
  assert.match(body.attribution.text, /OpenSSF Malicious Packages \(Apache-2\.0\)/);
  for (const key of tool.outputSchema.required) assert.ok(key in body, `required output field ${key}`);
});

test('A2A: the skill returns a completed task with the same result shape', async (t) => {
  spyFetch(t, { pypi: () => ({ status: 404 }) });
  const res = await callA2a({ ecosystem: 'pypi', name: 'pg1-hallucinated-pkg' });
  assert.equal(res.statusCode, 200);
  const data = res.body.result.artifacts[0].parts[0].data;
  assert.equal(data.exists, false);
  assert.equal(data.status, 'flagged');
  assert.equal(data.request_id, res.headers['X-Request-Id']);
});

test('60 calls/hour per caller without a licence key (cached calls count); another caller and a licence key are unaffected', async (t) => {
  withSupabase(t);
  spyFetch(t, { npm: (name) => ({ status: 200, body: npmDoc({ name }) }) });
  const ip = freshIp();
  for (let i = 0; i < PACKAGE_CHECK_RATE_LIMIT_MAX; i++) {
    const res = await callMcp({ ecosystem: 'npm', name: 'pg1-synthetic' }, { ip });
    assert.equal(res.body.result.isError, undefined, `call ${i + 1}`);
  }
  const limited = await callMcp({ ecosystem: 'npm', name: 'pg1-synthetic' }, { ip });
  assert.equal(limited.body.result.isError, true);
  assert.equal(mcpPayload(limited).code, 'rate_limited');
  assert.match(mcpPayload(limited).message, /check_package is limited to 60 calls\/hour/);

  const other = await callMcp({ ecosystem: 'npm', name: 'pg1-synthetic' });
  assert.equal(other.body.result.isError, undefined, 'another caller has its own budget');
  const licensed = await callMcp({ ecosystem: 'npm', name: 'pg1-synthetic' }, { ip, headers: { 'x-api-key': 'valid-test-licence' } });
  assert.equal(licensed.body.result.isError, undefined, 'a licence key exempts the limit');

  const a2aLimited = await callA2a({ ecosystem: 'npm', name: 'pg1-synthetic' }, { ip });
  assert.equal(a2aLimited.body.error.data.code, 'rate_limited', 'one counter shared by MCP and A2A');

  // Invalid input never uses up the budget.
  const ip2 = freshIp();
  for (let i = 0; i < 70; i++) await callMcp({ ecosystem: 'npm', name: 'bad name' }, { ip: ip2 });
  assert.equal((await callMcp({ ecosystem: 'npm', name: 'pg1-synthetic' }, { ip: ip2 })).body.result.isError, undefined);
});

test('telemetry: one tool_call row named check_package, never the package or version; error log rows carry fixed reasons only', async (t) => {
  withSupabase(t);
  const spy = spyFetch(t, { npm: () => ({ throw: Object.assign(new Error('aborted'), { name: 'AbortError' }) }), osv: () => ({ status: 502 }) });
  const res = await callMcp({ ecosystem: 'npm', name: 'pg1-telemetry-marker', version: '7.7.7' });
  await settle();
  const rows = spy.supabase('agent_telemetry');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool_name, 'check_package');
  assert.equal(rows[0].endpoint, '/api/mcp');
  assert.equal(rows[0].is_fixture, false);
  const errors = spy.supabase('pg1_errors');
  assert.deepEqual(errors.map((e) => [e.route, e.reason, e.category]).sort(), [
    ['/api/mcp:check_package', 'check_package_osv_upstream_unavailable', 'upstream'],
    ['/api/mcp:check_package', 'check_package_registry_timeout', 'timeout']
  ]);
  assert.ok(errors.every((e) => e.request_id === res.headers['X-Request-Id']));
  const written = JSON.stringify([...rows, ...errors]);
  assert.doesNotMatch(written, /pg1-telemetry-marker|7\.7\.7/, 'inputs are never stored');
});

test('logPackageCheckFailures logs nothing for a complete answer', () => {
  const seen = [];
  logPackageCheckFailures('/api/x', { checks: [{ source: 'package registry', result: 'ok' }, { source: 'vulnerability database', result: 'skipped' }] }, 'rid', (...a) => seen.push(a));
  assert.deepEqual(seen, []);
});

// ---------------------------------------------------------------------------
// Fixtures

test('fixtures: FLAGGED/CLEAN/UNKNOWN names that npm and PyPI both reject, answered with no request, over MCP and A2A, for either ecosystem', async (t) => {
  const spy = spyFetch(t);
  const fixtures = TEST_FIXTURES.filter((f) => f.tool === 'check_package');
  assert.deepEqual(fixtures.map((f) => f.kind), ['FLAGGED', 'CLEAN', 'UNKNOWN']);
  for (const f of fixtures) {
    assert.throws(() => pkg.normalizePackageName('npm', f.arguments.name), /./, 'npm rejects it');
    assert.throws(() => pkg.normalizePackageName('pypi', f.arguments.name), /./, 'PyPI rejects it');
    for (const ecosystem of ['npm', 'pypi']) {
      for (const via of ['mcp', 'a2a']) {
        const res = via === 'mcp' ? await callMcp({ ecosystem, name: f.arguments.name }) : await callA2a({ ecosystem, name: f.arguments.name });
        const body = via === 'mcp' ? mcpPayload(res) : res.body.result.artifacts[0].parts[0].data;
        const label = `${f.kind}/${ecosystem}/${via}`;
        assert.equal(body.test_fixture, true, label);
        assert.equal(body.ecosystem, ecosystem, label);
        assert.equal(body.status, f.expected.status, label);
        assert.deepEqual(codes(body), f.expected.reason_codes, label);
        assert.ok(body.checks.every((c) => c.source === 'fixture'), label);
        assert.match(body.attribution.text, /synthetic data/);
        // The CLEAN fixture's own name contains "clean"; nothing else may.
        assert.doesNotMatch(JSON.stringify({ ...body, name: null, canonical_name: null }), NEVER);
      }
    }
  }
  assert.deepEqual(spy.upstream(), [], 'fixtures never reach a registry or OSV');
  const flagged = mcpPayload(await callMcp({ ecosystem: 'npm', name: FIXTURE_VALUES.package.FLAGGED, version: '3.1.4' }));
  assert.equal(flagged.version_checked, '3.1.4', 'version is echoed');
  assert.deepEqual(flagged.malicious_reports, ['MAL-0000-0001']);
  const unknown = mcpPayload(await callMcp({ ecosystem: 'npm', name: FIXTURE_VALUES.package.UNKNOWN }));
  assert.equal(unknown.reported_malicious, null);
  assert.equal(unknown.exists, true);
});

test('fixtures do not count against the rate limit; with an invalid version a fixture name is a normal (invalid) input', async (t) => {
  spyFetch(t);
  const ip = freshIp();
  for (let i = 0; i < PACKAGE_CHECK_RATE_LIMIT_MAX + 5; i++) {
    assert.equal(mcpPayload(await callMcp({ ecosystem: 'npm', name: FIXTURE_VALUES.package.CLEAN }, { ip })).test_fixture, true);
  }
  const bad = await callMcp({ ecosystem: 'npm', name: FIXTURE_VALUES.package.CLEAN, version: '>=1' }, { ip });
  assert.equal(bad.body.result.isError, true);
  assert.equal(mcpPayload(bad).code, 'invalid_package_name', 'not a fixture, so the live validator rejects the name');
  assert.equal(mcpPayload(bad).test_fixture, undefined);
});

// ---------------------------------------------------------------------------
// Chat and playground

test('chat: the shared executor runs check_package for a guest under the anonymous limit, with a result card', async (t) => {
  spyFetch(t, { npm: (name) => ({ status: 200, body: npmDoc({ name, versions: { '1.0.0': { scripts: { postinstall: 'x' } } }, latest: '1.0.0' }) }) });
  const records = [];
  const execute = createToolExecutor({ role: 'guest', identifier: 'chat-guest', log: () => {}, record: (...a) => records.push(a) });
  const outcome = await execute({ id: 'c1', name: 'check_package', args: { ecosystem: 'npm', name: 'pg1-synthetic' } });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 'no_flags');
  const card = summarizeOutcome(outcome);
  assert.equal(card.title, 'Package');
  assert.equal(card.subject, 'npm:pg1-synthetic');
  const fields = Object.fromEntries(card.fields.map((f) => [f.label, f.value]));
  assert.equal(fields.Exists, 'yes');
  assert.equal(fields['Install scripts'], 'postinstall');
  assert.equal(fields['Reported malicious'], 'no');
  assert.deepEqual(records, []);

  pkg.__clearPackageCachesForTests();
  spyFetch(t, { npm: () => ({ status: 500 }) });
  const partial = await execute({ id: 'c2', name: 'check_package', args: { ecosystem: 'npm', name: 'pg1-synthetic' } });
  assert.equal(partial.status, 'unknown');
  assert.deepEqual(records.map((r) => [r[0], r[2]]), [['/api/chat:check_package', 'check_package_registry_upstream_unavailable']]);
});

test('playground: package requests are validated (ecosystem, name, version), fixtures accepted, other tools refuse the new keys', () => {
  assert.deepEqual(validatePlaygroundRequest({ tool: 'check_package', input: ' lodash ', ecosystem: 'npm' }), { ok: true, tool: 'check_package', value: 'lodash', kind: 'package', ecosystem: 'npm' });
  const withVersion = validatePlaygroundRequest({ tool: 'check_package', input: 'requests', ecosystem: 'pypi', version: '2.31.0' });
  assert.deepEqual(toolArgs(withVersion), { ecosystem: 'pypi', name: 'requests', version: '2.31.0' });
  assert.deepEqual(toolArgs(validatePlaygroundRequest({ tool: 'check_package', input: 'lodash', ecosystem: 'npm', version: '' })), { ecosystem: 'npm', name: 'lodash' });
  assert.equal(validatePlaygroundRequest({ tool: 'check_package', input: FIXTURE_VALUES.package.FLAGGED, ecosystem: 'pypi' }).ok, true);
  assert.equal(validatePlaygroundRequest({ tool: 'check_package', input: 'lodash' }).message, MESSAGES.ecosystem);
  assert.equal(validatePlaygroundRequest({ tool: 'check_package', input: 'lodash', ecosystem: 'maven' }).message, MESSAGES.ecosystem);
  assert.equal(validatePlaygroundRequest({ tool: 'check_package', input: 'two names', ecosystem: 'npm' }).message, MESSAGES.package);
  assert.equal(validatePlaygroundRequest({ tool: 'check_package', input: 'lodash', ecosystem: 'npm', version: '^1' }).message, MESSAGES.version);
  assert.equal(validatePlaygroundRequest({ tool: 'check_domain_age', input: 'example.com', ecosystem: 'npm' }).message, MESSAGES.bad_request);
  assert.equal(validatePlaygroundRequest({ tool: 'check_domain_age', input: 'example.com', version: '1' }).message, MESSAGES.bad_request);
});

test('playground: a package check runs through the handler with telemetry that never carries the input', async (t) => {
  const rows = [];
  spyFetch(t, { npm: () => ({ status: 404 }), osv: () => ({ status: 200, body: {} }) });
  const handler = createPlaygroundHandler({ record: () => {}, telemetry: (row) => rows.push(row), executorOptions: { log: () => {} } });
  const res = makeRes();
  await handler({ method: 'POST', headers: { 'x-forwarded-for': freshIp() }, socket: {}, body: { tool: 'check_package', input: 'pg1-playground-marker', ecosystem: 'npm' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.card.status, 'flagged');
  assert.deepEqual(res.body.card.reasons.map((r) => r.code), ['PACKAGE_NOT_FOUND']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].toolName, 'check_package');
  assert.doesNotMatch(JSON.stringify(rows), /pg1-playground-marker/);
  const html = read('public/playground/index.html');
  assert.match(html, /<input type="radio" name="tool" value="check_package">/);
  assert.match(html, /<select id="pg-ecosystem" name="ecosystem">/);
  assert.match(html, /href="\/docs\/attributions"/);
});

// ---------------------------------------------------------------------------
// Attribution page and licensing

test('/docs/attributions is generated like the other docs pages, routed, in the sitemap, and up to date', () => {
  const page = DOC_PAGES.find((p) => p.route === '/docs/attributions');
  assert.ok(page, 'scripts/build-docs.mjs publishes /docs/attributions');
  assert.equal(page.source, 'lib/attributions.mjs');
  assert.equal(page.output, 'public/docs/attributions/index.html');
  assert.equal(read(page.output), buildPage(page), 'stale: run npm run docs:build');
  const vercel = JSON.parse(read('vercel.json'));
  assert.ok(vercel.rewrites.some((r) => r.source === '/docs/attributions' && r.destination === '/docs/attributions/index.html'));
  const headers = vercel.headers.find((h) => h.source === '/docs/attributions');
  assert.ok(headers && headers.headers.some((h) => h.key === 'Content-Security-Policy'));
  assert.match(read('public/sitemap.xml'), /<loc>https:\/\/pg1-ai-agent\.vercel\.app\/docs\/attributions<\/loc>/);
});

test('/docs/attributions credits every OSV source with its licence, plus npm and PyPI', () => {
  const html = read('public/docs/attributions/index.html');
  const expected = [
    ['GitHub Advisory Database', 'CC-BY 4.0'],
    ['PyPI Advisory Database', 'CC-BY 4.0'],
    ['Go Vulnerability Database', 'CC-BY 4.0'],
    ['RustSec Advisory Database', 'CC0 1.0'],
    ['OpenSSF Malicious Packages', 'Apache-2.0']
  ];
  for (const [name, licence] of expected) {
    const row = html.split('\n').find((l) => l.includes(`>${name}</a>`));
    assert.ok(row, `${name} is credited`);
    assert.ok(row.includes(`>${licence}</a>`), `${name} is credited under ${licence}`);
  }
  assert.match(html, /OSV\.dev/);
  assert.match(html, /npm public registry/);
  assert.match(html, /PyPI \(the Python Package Index\)/);
  assert.match(html, /npm Open-Source Terms/);
  assert.match(html, /PyPI Terms of Use/);
  assert.match(html, /registry metadata for 1 hour, malicious-package status for 15 minutes/);
  assert.match(html, /never crawls a registry in bulk/);
});

test('no Ubuntu / Debian / CC-BY-SA data: only allow-listed advisory prefixes, none share-alike', () => {
  assert.deepEqual([...ALLOWED_OSV_ID_PREFIXES].sort(), ['GHSA-', 'GO-', 'MAL-', 'PYSEC-', 'RUSTSEC-']);
  for (const s of [...OSV_ADVISORY_SOURCES, ...PACKAGE_REGISTRIES]) {
    assert.doesNotMatch(`${s.name} ${s.licence}`, /ubuntu|debian|BY-SA|share.?alike/i, s.name);
  }
  assert.equal(pkg.summarizeOsvVulns([{ id: 'USN-1234-1' }, { id: 'UBUNTU-CVE-2026-1' }, { id: 'DSA-1' }, { id: 'DLA-1' }]).omitted, 4);
});

test('the attributions page is linked from llms.txt, /about and the tool description', () => {
  const llms = read('public/llms.txt');
  assert.match(llms, /\[Data sources and licences\]\(https:\/\/pg1-ai-agent\.vercel\.app\/docs\/attributions\)/);
  assert.match(llms, /\[check_package\]\(https:\/\/pg1-ai-agent\.vercel\.app\/api\/mcp\)/);
  assert.match(read('public/about/index.html'), /<a href="\/docs\/attributions">/);
  assert.match(read('public/about/index.html'), /<code>check_package<\/code>/);
  assert.ok(tool.description.includes('https://pg1-ai-agent.vercel.app/docs/attributions'));
});

// ---------------------------------------------------------------------------
// No AI model on this path

function importGraph(entry) {
  const files = new Set();
  const bare = new Set();
  (function walk(file) {
    if (files.has(file)) return;
    files.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1] || m[2];
      if (spec.startsWith('.')) walk(path.resolve(path.dirname(file), spec));
      else bare.add(spec);
    }
  })(path.join(ROOT, entry));
  return { files: [...files].map((f) => path.relative(ROOT, f)), bare: [...bare] };
}

test('no AI client is imported on the check_package path (lib, MCP, A2A, playground)', () => {
  const AI = /^(?:ai|@ai-sdk\/.*|openai|@anthropic-ai\/.*|@google\/genai|@google\/generative-ai|langchain|@langchain\/.*|cohere-ai|@mistralai\/.*)$/;
  const lib = importGraph('lib/packageCheck.mjs');
  assert.deepEqual(lib.files.sort(), ['lib/attributions.mjs', 'lib/invalidInput.mjs', 'lib/packageCheck.mjs', 'lib/popularPackages.mjs', 'lib/reasonCodes.mjs', 'lib/responseMeta.mjs']);
  assert.deepEqual(lib.bare, [], 'lib/packageCheck.mjs imports no package at all');
  for (const entry of ['api/mcp.mjs', 'api/a2a.mjs', 'api/playground.mjs']) {
    const g = importGraph(entry);
    assert.deepEqual(g.bare.filter((b) => AI.test(b)), [], entry);
    assert.ok(!g.files.some((f) => /chatStream|voice|imageEngines|api\/chat\.mjs/.test(f)), `${entry} reaches no model code`);
  }
});
