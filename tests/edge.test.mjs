/**
 * P8: competitive edge. preflight_check (MCP, A2A, REST; fail closed),
 * signed results (round trip, tamper detection, JWKS, verify_result, the
 * JS and Python SDKs), check_x402_endpoint and check_agent_card, SSRF
 * blocked everywhere a URL comes in, watchlists (pricing, x402 before
 * anything is stored, HMAC-signed webhooks on a status change, limits),
 * proprietary signals off by default, /status with no identifiers, the
 * short-TTL result cache and the 5% error-rate alert.
 *
 * Run with: node --test tests/edge.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { makeDb, pgRest } from './helpers/pgrest.mjs';

delete process.env.X402_PAY_TO_ADDRESS;
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

const signing = await import('../lib/signing.mjs');
const { runPreflight, planPreflight, PREFLIGHT_PRICE_USD, PREFLIGHT_WORST_CASE_COST_USD } = await import('../lib/preflight.mjs');
const { checkX402Endpoint, checkAgentCard, validateAgentCard } = await import('../lib/agentChecks.mjs');
const { cachedCheck, __clearResultCache } = await import('../lib/resultCache.mjs');
const wl = await import('../lib/watchlists.mjs');
const { signalsEnabled, buildObservation, aggregateSignal, SIGNALS_K_ANONYMITY } = await import('../lib/signals.mjs');
const status = await import('../lib/statusMetrics.mjs');
const { checkUrlShape, assertPublicUrl } = await import('../lib/netGuard.mjs');
const { priceCoversCost } = await import('../lib/pricing.mjs');
const { payerHash } = await import('../lib/a2aJobs/jobs.mjs');
const mcp = await import('../api/mcp.mjs');
const { default: mcpHandler, TOOLS, STANDARD_TOOL_HANDLERS } = mcp;
const { default: a2aHandler } = await import('../api/a2a.mjs');
const { default: preflightHandler } = await import('../api/preflight.mjs');
const { default: signingKeyHandler } = await import('../api/signing-key.mjs');
const { default: statusHandler } = await import('../api/status.mjs');
const { default: watchlistsHandler, __setWatchlistDeps } = await import('../api/watchlists.mjs');
const sdk = await import('../sdk/js/index.mjs');
const { FIXTURE_VALUES } = await import('../lib/fixtures.mjs');

const SEED = crypto.randomBytes(32).toString('base64url');
const SEED2 = crypto.randomBytes(32).toString('base64url');
const SUP = { supUrl: 'https://supabase.test', supKey: 'k' };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, PG1_SIGNING_KEY: SEED, TELEMETRY_IP_SALT: 'edge-test-salt' };
  delete process.env.PG1_SIGNING_PREVIOUS_JWKS;
  delete process.env.PG1_SIGNALS;
  globalThis.fetch = ORIGINAL_FETCH;
  __clearResultCache();
  status.__clearStatusCache();
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; __setWatchlistDeps({ screen: null, lookup: undefined, fetchImpl: undefined }); });

function makeRes() {
  return {
    statusCode: null, body: null, headers: {}, sent: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    send(p) { this.sent = p; return this; },
    end() { return this; }
  };
}
let ipN = 0;
const freshIp = () => { ipN += 1; return `100.64.9.${ipN % 250}`; };
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [{ address: '10.0.0.7', family: 4 }];
const res402 = (body, headers = {}) => new Response(JSON.stringify(body), { status: 402, headers: { 'Content-Type': 'application/json', ...headers } });

async function callMcp(name, args, headers = {}) {
  const res = makeRes();
  await mcpHandler({ method: 'POST', headers: { 'x-forwarded-for': freshIp(), ...headers }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } }, res);
  return res;
}
async function callA2a(skill, args, headers = {}) {
  const res = makeRes();
  await a2aHandler({ method: 'POST', headers: { 'x-forwarded-for': freshIp(), ...headers }, query: {}, body: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: 'm1', parts: [{ kind: 'data', data: { skill, arguments: args } }] } } } }, res);
  return res;
}

// --- preflight ------------------------------------------------------------------------

test('preflight_check is first in tools/list, paid at >= 1.5x its worst-case cost, and plans the right checks', () => {
  assert.equal(TOOLS[0].name, 'preflight_check');
  assert.ok(priceCoversCost(PREFLIGHT_PRICE_USD, PREFLIGHT_WORST_CASE_COST_USD));
  assert.deepEqual(planPreflight({ action: 'pay', target: FIXTURE_VALUES.wallet.CLEAN }).map((p) => p.tool), ['check_wallet_sanctions', 'check_wallet_age']);
  assert.deepEqual(planPreflight({ action: 'pay', target: 'https://api.example.com/x' }).map((p) => p.tool), ['check_x402_endpoint']);
  assert.deepEqual(planPreflight({ action: 'open', target: 'https://login.example.co.uk/a' }).map((p) => p.tool), ['check_hostname_reputation', 'check_domain_age']);
  assert.deepEqual(planPreflight({ action: 'install', target: '@scope/pkg@1.2.3', ecosystem: 'npm' })[0].args, { ecosystem: 'npm', name: '@scope/pkg', version: '1.2.3' });
  assert.deepEqual(planPreflight({ action: 'patch', target: 'cve-2021-44228' })[0], { tool: 'get_cve_details', args: { cve_id: 'CVE-2021-44228' } });
  assert.deepEqual(planPreflight({ action: 'trust_agent', target: 'agent.example.com' })[0], { tool: 'check_agent_card', args: { domain: 'agent.example.com' } });
  for (const bad of [{ action: 'nuke', target: 'x' }, { action: 'pay', target: 'not a wallet' }, { action: 'install', target: 'x' }, { action: 'open', target: '' }]) {
    assert.throws(() => planPreflight(bad), (e) => e.mcpToolError && e.code === 'invalid_input');
  }
});

test('preflight fails closed: an error or a timeout makes it unknown (never no_flags); any flag wins; reasons name their check', async () => {
  const wallet = '0x' + 'ab'.repeat(20);
  const clean = async () => ({ status: 'no_flags', reasons: [], checks: [{ source: 'x' }] });
  assert.equal((await runPreflight({ action: 'pay', target: wallet }, { runTool: clean })).decision, 'no_flags');

  const erroring = async (tool) => { if (tool === 'check_wallet_age') throw Object.assign(new Error('down'), { code: 'upstream_unavailable' }); return clean(); };
  const e = await runPreflight({ action: 'pay', target: wallet }, { runTool: erroring });
  assert.equal(e.decision, 'unknown');
  assert.ok(e.reasons.some((r) => r.code === 'PREFLIGHT_CHECK_INCOMPLETE' && /check_wallet_age/.test(r.message)));
  assert.equal(e.checks.find((c) => c.tool === 'check_wallet_age').result, 'error');

  const slow = async (tool) => (tool === 'check_wallet_age' ? new Promise(() => {}) : clean());
  const t = await runPreflight({ action: 'pay', target: wallet }, { runTool: slow, timeoutMs: 30 });
  assert.equal(t.decision, 'unknown');
  assert.equal(t.checks.find((c) => c.tool === 'check_wallet_age').result, 'timeout');

  const garbage = async () => ({ status: 'definitely-safe', reasons: [] });
  assert.equal((await runPreflight({ action: 'pay', target: wallet }, { runTool: garbage })).decision, 'unknown', 'an unrecognised status is not no_flags');

  const flagged = async (tool) => (tool === 'check_wallet_sanctions' ? { status: 'flagged', reasons: [{ code: 'WALLET_SANCTIONED', message: 'm' }] } : new Promise(() => {}));
  const f = await runPreflight({ action: 'pay', target: wallet }, { runTool: flagged, timeoutMs: 30 });
  assert.equal(f.decision, 'flagged');
  assert.deepEqual(f.reasons.map((r) => [r.code, r.check]), [['WALLET_SANCTIONED', 'check_wallet_sanctions'], ['PREFLIGHT_CHECK_INCOMPLETE', 'preflight_check']]);
  assert.ok(Number.isFinite(f.latency_ms));
});

test('preflight runs on the test fixtures through the real handlers (no upstream call)', async () => {
  const flagged = await STANDARD_TOOL_HANDLERS.preflight_check({ action: 'open', target: FIXTURE_VALUES.domain.FLAGGED });
  assert.equal(flagged.decision, 'flagged');
  const unknown = await STANDARD_TOOL_HANDLERS.preflight_check({ action: 'open', target: FIXTURE_VALUES.domain.UNKNOWN });
  assert.notEqual(unknown.decision, 'no_flags');
});

test('preflight is paid on MCP, A2A and REST: with the free tier declined, each asks for payment and runs nothing', async () => {
  let ran = 0;
  const original = STANDARD_TOOL_HANDLERS.preflight_check;
  STANDARD_TOOL_HANDLERS.preflight_check = async () => { ran++; return { decision: 'no_flags' }; };
  try {
    const m = await callMcp('preflight_check', { action: 'open', target: 'example.com' }, { 'x-free-tier': '0' });
    assert.equal(m.body.result.isError, true);
    assert.ok(m.body.result.structuredContent.accepts || m.body.result.structuredContent.error);
    const a = await callA2a('preflight_check', { action: 'open', target: 'example.com' }, { 'x-free-tier': '0' });
    assert.equal(a.body.result.status.state, 'input-required');
    const r = makeRes();
    await preflightHandler({ method: 'POST', headers: { 'x-forwarded-for': freshIp(), 'x-free-tier': '0' }, body: { action: 'open', target: 'example.com' } }, r);
    assert.equal(r.statusCode, 402);
    assert.equal(ran, 0);
  } finally {
    STANDARD_TOOL_HANDLERS.preflight_check = original;
  }
});

// --- signatures ------------------------------------------------------------------------

test('signature round trip, tamper detection, request binding, and key rotation', () => {
  const result = { status: 'flagged', reasons: [{ code: 'X' }], checks: [{ source: 'sanctions list', result: 'ok' }] };
  const sig = signing.signResult({ tool: 'check_wallet_sanctions', args: { address: '0x1' }, result });
  const jwks = signing.publicJwks();
  assert.equal(jwks.keys.length, 1);
  assert.ok(!('d' in jwks.keys[0]), 'never the private part');
  assert.deepEqual(signing.verifySignedResult({ result, signature: sig, jwks, tool: 'check_wallet_sanctions', args: { address: '0x1' } }), { valid: true, reason: 'ok', kid: sig.kid });
  const tampered = JSON.parse(JSON.stringify(result));
  tampered.status = 'no_flags';
  assert.equal(signing.verifySignedResult({ result: tampered, signature: sig, jwks }).reason, 'bad_signature');
  assert.equal(signing.verifySignedResult({ result, signature: { ...sig, timestamp: '2020-01-01T00:00:00.000Z' }, jwks }).reason, 'bad_signature');
  assert.equal(signing.verifySignedResult({ result, signature: { ...sig, version: '9.9.9' }, jwks }).reason, 'bad_signature');
  assert.equal(signing.verifySignedResult({ result: { ...result, checks: [] }, signature: sig, jwks }).reason, 'sources_mismatch');
  assert.equal(signing.verifySignedResult({ result, signature: sig, jwks, tool: 'check_wallet_sanctions', args: { address: '0x2' } }).reason, 'request_mismatch');
  assert.equal(signing.verifySignedResult({ result, signature: sig, jwks: { keys: [] } }).reason, 'unknown_key');

  // Rotation: a new key signs, the old public key stays published.
  const oldJwk = jwks.keys[0];
  process.env.PG1_SIGNING_KEY = SEED2;
  process.env.PG1_SIGNING_PREVIOUS_JWKS = JSON.stringify([oldJwk]);
  const rotated = signing.publicJwks();
  assert.equal(rotated.keys.length, 2);
  assert.notEqual(rotated.keys[0].kid, oldJwk.kid);
  assert.equal(signing.verifySignedResult({ result, signature: sig, jwks: rotated }).valid, true, 'an old signature still verifies');
  // No key: nothing is signed, the JWKS is empty.
  delete process.env.PG1_SIGNING_KEY;
  delete process.env.PG1_SIGNING_PREVIOUS_JWKS;
  assert.equal(signing.signResult({ tool: 't', args: {}, result }), null);
  assert.deepEqual(signing.publicJwks(), { keys: [] });
});

test('MCP results carry _meta["pg1/signature"]; the JWKS route serves it; verify_result and the JS SDK confirm it and catch tampering', async () => {
  const args = { domain: FIXTURE_VALUES.domain.CLEAN };
  const res = await callMcp('check_domain_age', args);
  const result = JSON.parse(res.body.result.content[0].text);
  const sig = res.body.result._meta['pg1/signature'];
  assert.ok(sig && sig.sig);
  assert.equal(sig.request_hash, signing.requestHash('check_domain_age', args));

  const k = makeRes();
  signingKeyHandler({ method: 'GET', headers: {} }, k);
  assert.equal(k.statusCode, 200);
  assert.equal(k.headers['content-type'], 'application/jwk-set+json');
  const jwks = k.body;
  assert.equal(jwks.keys[0].kid, sig.kid);

  const v = await callMcp('verify_result', { result, signature: sig, tool: 'check_domain_age', arguments: args });
  assert.equal(JSON.parse(v.body.result.content[0].text).valid, true);
  const bad = await callMcp('verify_result', { result: { ...result, age_days: 1 }, signature: sig });
  assert.equal(JSON.parse(bad.body.result.content[0].text).valid, false);

  assert.deepEqual(await sdk.verifyResult({ result, signature: sig, jwks, tool: 'check_domain_age', args }), { valid: true, reason: 'ok', kid: sig.kid });
  assert.equal((await sdk.verifyResult({ result: { ...result, status: 'no_flags', age_days: 9999 }, signature: sig, jwks })).valid, false);
  assert.equal(await sdk.requestHash('check_domain_age', args), sig.request_hash, 'the SDK hashes requests exactly like the server');

  // The SDK client end to end against the handler.
  const client = new sdk.PG1Client({
    baseUrl: 'https://pg1.test',
    fetch: async (url, opts) => {
      if (String(url).endsWith('/.well-known/pg1-signing-key')) return new Response(JSON.stringify(jwks));
      const r = makeRes();
      await mcpHandler({ method: 'POST', headers: { 'x-forwarded-for': freshIp() }, body: JSON.parse(opts.body) }, r);
      return new Response(JSON.stringify(r.body));
    }
  });
  const out = await client.checkDomainAge(FIXTURE_VALUES.domain.FLAGGED);
  assert.equal(out.result.status, 'flagged');
  assert.equal(out.verified.valid, true);
});

test('the Python SDK verifies a server signature and rejects a tampered result', () => {
  const result = { status: 'no_flags', score: 0.25, tiny: 1e-7, name: 'é', reasons: [], checks: [{ source: 'a' }, { source: 'b' }] };
  const args = { address: '0xabc', n: 2 };
  const signature = signing.signResult({ tool: 'check_wallet_sanctions', args, result });
  const jwks = signing.publicJwks();
  const code = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(new URL('../sdk/python', import.meta.url).pathname)})`,
    'from pg1_sdk import verify_result',
    'd = json.load(sys.stdin)',
    'ok = verify_result(d["result"], d["signature"], d["jwks"], "check_wallet_sanctions", d["args"])',
    'd["result"]["status"] = "flagged"',
    'bad = verify_result(d["result"], d["signature"], d["jwks"])',
    'print(json.dumps([ok, bad]))'
  ].join('\n');
  const run = spawnSync('python3', ['-I', '-c', code], { input: JSON.stringify({ result, signature, jwks, args }), encoding: 'utf8' });
  if (run.error && run.error.code === 'ENOENT') return; // no Python on this machine: the JS SDK test above covers verification
  if (/No module named 'cryptography'/.test(run.stderr || '')) return;
  assert.equal(run.status, 0, run.stderr);
  const [ok, bad] = JSON.parse(run.stdout);
  assert.equal(ok.valid, true, JSON.stringify(ok));
  assert.equal(bad.valid, false);
  assert.equal(bad.reason, 'bad_signature');
});

test('A2A results carry metadata["pg1.signature"]; REST preflight carries a top-level signature', async () => {
  const args = { domain: FIXTURE_VALUES.domain.CLEAN };
  const a = await callA2a('check_domain_age', args);
  const task = a.body.result;
  const sig = task.metadata['pg1.signature'];
  assert.ok(sig);
  const data = task.artifacts[0].parts[0].data;
  assert.equal(signing.verifySignedResult({ result: data, signature: sig, jwks: signing.publicJwks(), tool: 'check_domain_age', args }).valid, true);

  // REST: a licence-free paid path is stubbed by granting the free tier.
  const db = new Map();
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/free_tier_usage')) {
      if ((opts.method || 'GET') === 'GET') return new Response(JSON.stringify(db.has('n') ? [{ request_count: db.get('n') }] : []));
      db.set('n', (db.get('n') || 0) + 1);
      return new Response('', { status: 201 });
    }
    if (u.includes('/rest/v1/')) return new Response('', { status: 201 });
    throw new Error('unexpected fetch ' + u);
  };
  process.env.SUPABASE_URL = SUP.supUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SUP.supKey;
  const body = { action: 'open', target: FIXTURE_VALUES.domain.FLAGGED };
  const r = makeRes();
  await preflightHandler({ method: 'POST', headers: { 'x-forwarded-for': freshIp() }, body }, r);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.decision, 'flagged');
  const { signature, ...rest } = r.body;
  assert.equal(signing.verifySignedResult({ result: rest, signature, jwks: signing.publicJwks(), tool: 'preflight_check', args: body }).valid, true);
  await new Promise((done) => setTimeout(done, 100));
});

// --- agent-economy checks and SSRF ------------------------------------------------------

const stubTools = (over = {}) => async (tool, args) => {
  if (over[tool]) return over[tool](args);
  if (tool === 'check_wallet_sanctions') return { status: 'no_flags', listed: false, reasons: [] };
  if (tool === 'check_wallet_age') return { status: 'no_flags', found: true, age_days: 400, reasons: [] };
  if (tool === 'check_domain_age') return { status: 'no_flags', age_days: 900, reasons: [] };
  if (tool === 'check_hostname_reputation') return { status: 'no_flags', reasons: [] };
  throw new Error('unexpected ' + tool);
};

test('check_x402_endpoint: reads the 402, screens payTo, checks network and asset; flags a sanctioned payTo and an unknown asset', async () => {
  const payTo = '0x' + '12'.repeat(20);
  const required = { x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: '0x0000000000000000000000000000000000000001', payTo, amount: '10000' }] };
  const out = await checkX402Endpoint({ url: 'https://api.example.com/paid' }, {
    runTool: stubTools({ check_wallet_sanctions: () => ({ status: 'flagged', listed: true, reasons: [{ code: 'WALLET_SANCTIONED' }] }) }),
    fetchImpl: async () => res402(required),
    lookup: publicLookup
  });
  assert.equal(out.status, 'flagged');
  const codes = out.reasons.map((r) => r.code);
  assert.ok(codes.includes('WALLET_SANCTIONED'));
  assert.ok(codes.includes('X402_UNKNOWN_ASSET'));
  assert.equal(out.x402.options[0].pay_to_sanctioned, true);

  const none = await checkX402Endpoint({ url: 'https://api.example.com/free' }, { runTool: stubTools(), fetchImpl: async () => new Response('{}', { status: 200 }), lookup: publicLookup });
  assert.equal(none.status, 'unknown', 'no payment request is not a clean bill');
});

test('check_agent_card: schema validity and look-alike names', async () => {
  assert.deepEqual(validateAgentCard({ name: 'A', url: 'https://a.example', version: '1', skills: [{ id: 's', name: 's' }] }), []);
  assert.ok(validateAgentCard({ name: 'A' }).length > 0);
  const card = { name: 'OpenAI Official Agent', url: 'https://agent.evil.example', version: '1', skills: [{ id: 's', name: 's' }] };
  const out = await checkAgentCard({ domain: 'agent.evil.example' }, { runTool: stubTools(), fetchImpl: async () => new Response(JSON.stringify(card)), lookup: publicLookup });
  assert.ok(out.reasons.some((r) => r.code === 'AGENT_CARD_NAME_IMPERSONATION'));
  assert.equal(out.status, 'flagged');
});

test('SSRF is blocked everywhere a URL comes in: the checks, preflight, watchlist webhooks (subscribe and delivery), subscribe_alerts', async () => {
  const PRIVATE = ['https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'https://localhost/x', 'https://10.1.2.3/', 'https://[::1]/', 'https://user:pw@example.com/', 'http://example.com/', 'https://2130706433/', 'https://metadata.google.internal/', 'https://example.com:6379/'];
  let fetched = 0;
  const fetchImpl = async () => { fetched++; return new Response('{}'); };
  for (const url of PRIVATE) {
    assert.throws(() => checkUrlShape(url), undefined, url);
    await assert.rejects(checkX402Endpoint({ url }, { runTool: stubTools(), fetchImpl, lookup: publicLookup }), (e) => e.mcpToolError, url);
    await assert.rejects(checkAgentCard({ url }, { runTool: stubTools(), fetchImpl, lookup: publicLookup }), (e) => e.mcpToolError, url);
    await assert.rejects(wl.assertWebhookUrl(url, { lookup: publicLookup }), (e) => e.watchlistError, url);
  }
  // A public name that resolves to a private address (DNS rebinding).
  await assert.rejects(checkX402Endpoint({ url: 'https://rebind.example.com/' }, { runTool: stubTools(), fetchImpl, lookup: privateLookup }), (e) => e.code === 'private_address');
  await assert.rejects(checkAgentCard({ domain: 'rebind.example.com' }, { runTool: stubTools(), fetchImpl, lookup: privateLookup }), (e) => e.code === 'private_address');
  await assert.rejects(assertPublicUrl('https://rebind.example.com/', { lookup: privateLookup }));
  const d = await wl.deliverWebhook({ id: crypto.randomUUID(), webhook_url: 'https://hooks.example.com/x' }, { type: 't' }, { env: { PG1_WATCHLIST_SECRET: 'x'.repeat(40) }, fetchImpl, lookup: privateLookup });
  assert.deepEqual(d, { ok: false, reason: 'unsafe_url' }, 'delivery re-checks DNS');
  assert.equal(fetched, 0, 'nothing was fetched');

  // Over MCP: the tools answer with an error, never a fetch.
  const r = await callMcp('check_x402_endpoint', { url: 'https://169.254.169.254/latest/meta-data' });
  assert.equal(r.body.result.isError, true);
  // subscribe_alerts (licence holders): a valid licence still cannot point it at a private address.
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://api.gumroad.com/')) return new Response(JSON.stringify({ success: true, purchase: {} }));
    throw new Error('unexpected fetch ' + url);
  };
  const p = await callMcp('subscribe_alerts', { webhook_url: 'https://127.0.0.1/hook' }, { 'x-api-key': 'edge-test-licence' });
  assert.match(JSON.stringify(p.body), /not allowed/);
  assert.ok(calls.every((u) => u.startsWith('https://api.gumroad.com/')), 'no subscription was written');
});

// --- result cache ------------------------------------------------------------------------

test('safe results are cached briefly: the second call does not rerun the check and returns in well under 500 ms; unknown is never cached', async () => {
  let runs = 0;
  const run = async () => { runs++; await new Promise((r) => setTimeout(r, 30)); return { status: 'no_flags', reasons: [] }; };
  await cachedCheck('check_agent_card', { domain: 'a.example' }, run);
  const times = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    await cachedCheck('check_agent_card', { domain: 'a.example' }, run);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  assert.equal(runs, 1);
  assert.ok(times[Math.ceil(0.95 * times.length) - 1] < 500);
  let u = 0;
  const unknown = async () => { u++; return { status: 'unknown', reasons: [] }; };
  await cachedCheck('check_agent_card', { domain: 'b.example' }, unknown);
  await cachedCheck('check_agent_card', { domain: 'b.example' }, unknown);
  assert.equal(u, 2);
});

// --- watchlists ------------------------------------------------------------------------

const WL_ENV = { PG1_WATCHLIST_SECRET: 'w'.repeat(48) };
const PAYER = '0x' + '34'.repeat(20);

test('watchlist pricing: >= 1.5x the 30-day recheck cost per item; inputs are validated like preflight', () => {
  assert.ok(priceCoversCost(wl.WATCH_ITEM_PRICE_USD, wl.WATCH_ITEM_WORST_CASE_USD));
  assert.deepEqual(wl.quoteWatchlist([{}, {}, {}]).price_usd, 0.15);
  assert.throws(() => wl.normalizeItems([]), (e) => e.watchlistError);
  assert.throws(() => wl.normalizeItems([{ kind: 'wallet', target: 'https://x' }]), (e) => e.watchlistError);
  assert.throws(() => wl.normalizeItems([{ kind: 'package', target: 'left-pad' }]), /ecosystem/);
  assert.throws(() => wl.normalizeItems(Array.from({ length: 51 }, (_, i) => ({ kind: 'domain', target: `d${i}.example.com` }))), /at most 50/);
  assert.equal(wl.normalizeItems([{ kind: 'domain', target: 'a.example.com' }, { kind: 'domain', target: 'A.example.com' }]).length, 1);
});

test('webhook signing: round trip, tamper and replay are rejected; the JS SDK agrees', async () => {
  const secret = wl.watchlistSecret(crypto.randomUUID(), WL_ENV);
  assert.ok(secret);
  assert.equal(wl.watchlistSecret('x', { PG1_WATCHLIST_SECRET: 'short' }), null, 'a weak master key disables watchlists');
  const body = JSON.stringify({ type: 'watchlist.status_changed', status: 'flagged' });
  const now = Math.floor(Date.now() / 1000);
  const header = wl.signWebhook(secret, body, now);
  assert.equal(wl.verifyWebhook(secret, body, header, { nowSec: now }), true);
  assert.equal(wl.verifyWebhook(secret, body.replace('flagged', 'no_flags'), header, { nowSec: now }), false);
  assert.equal(wl.verifyWebhook('other', body, header, { nowSec: now }), false);
  assert.equal(wl.verifyWebhook(secret, body, header, { nowSec: now + 3600 }), false, 'replay outside the window');
  assert.equal(await sdk.verifyWebhook(secret, body, header, { nowSec: now }), true);
  assert.equal(await sdk.verifyWebhook(secret, body + ' ', header, { nowSec: now }), false);
});

async function watchWorld() {
  const db = await makeDb(['20261024120000_pg1_watchlists.sql']);
  const fetchImpl = pgRest(db);
  return { db, fetchImpl, store: wl.createWatchlistStore({ ...SUP, fetchImpl }) };
}

function gateStub(log, { pay = true, payer = PAYER, settleOk = true } = {}) {
  return async (priceUsd) => {
    log.push({ priceUsd });
    if (!pay) return { authorized: false, paymentRequired: { x402Version: 2, accepts: [{ amount: String(Math.round(priceUsd * 1e6)) }] } };
    return { authorized: true, payer, settle: async () => { log.push('settled'); return settleOk ? { success: true, transaction: '0xtx' } : { success: false, errorReason: 'insufficient' }; }, settlementFailurePaymentRequired: async (m) => ({ x402Version: 2, error: m, accepts: [] }) };
  };
}

test('watchlists: no payment -> 402 and nothing stored; paid -> created with a derived secret; per-wallet limit; a refused wallet is never charged', async () => {
  const w = await watchWorld();
  const items = [{ kind: 'domain', target: 'example.com' }, { kind: 'package', target: 'left-pad', ecosystem: 'npm' }];
  const log = [];
  const base = { store: w.store, subscriberHash: payerHash, env: WL_ENV, lookup: publicLookup };
  const unpaid = await wl.createWatchlist({ items, webhook_url: 'https://hooks.example.com/pg1' }, { ...base, gate: gateStub(log, { pay: false }) });
  assert.equal(unpaid.status, 402);
  assert.equal(unpaid.paymentRequired.accepts[0].amount, '100000');
  assert.equal((await w.db.query('select count(*)::int as n from pg1_watchlists')).rows[0].n, 0);

  const refused = await wl.createWatchlist({ items, webhook_url: 'https://hooks.example.com/pg1' }, { ...base, gate: gateStub(log), screen: async () => ({ refused: true, message: 'no' }) }).catch((e) => e);
  assert.equal(refused.status, 403);
  assert.ok(!log.includes('settled'), 'a refused wallet is not charged');

  const ok = await wl.createWatchlist({ items, webhook_url: 'https://hooks.example.com/pg1' }, { ...base, gate: gateStub(log) });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.secret, wl.watchlistSecret(ok.body.id, WL_ENV));
  const row = (await w.db.query('select * from pg1_watchlists')).rows[0];
  assert.match(row.subscriber_hash, /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(row).includes(PAYER.slice(2)), 'the wallet is stored only as a hash');
  assert.ok(!JSON.stringify(row).includes(ok.body.secret), 'the secret is never stored');

  await assert.rejects(wl.authorizeWatchlist(w.store, ok.body.id, 'wrong', WL_ENV), (e) => e.status === 404);
  const got = await wl.authorizeWatchlist(w.store, ok.body.id, ok.body.secret, WL_ENV);
  assert.equal((await wl.watchlistView(w.store, got)).items.length, 2);

  for (let i = 1; i < wl.MAX_ACTIVE_WATCHLISTS_PER_SUBSCRIBER; i++) await wl.createWatchlist({ items, webhook_url: 'https://hooks.example.com/pg1' }, { ...base, gate: gateStub([]) });
  const settles = [];
  const over = await wl.createWatchlist({ items, webhook_url: 'https://hooks.example.com/pg1' }, { ...base, gate: gateStub(settles) }).catch((e) => e);
  assert.equal(over.status, 429);
  assert.ok(!settles.includes('settled'), 'over the limit is refused before settlement');
});

test('watchlist recheck: baseline without a webhook, then one signed webhook on a status change; per-subscriber limit per run', async () => {
  const w = await watchWorld();
  const base = { store: w.store, subscriberHash: payerHash, env: WL_ENV, lookup: publicLookup };
  const many = Array.from({ length: 30 }, (_, i) => ({ kind: 'domain', target: `d${i}.example.com` }));
  const a = await wl.createWatchlist({ items: many, webhook_url: 'https://hooks.example.com/a' }, { ...base, gate: gateStub([]) });
  const deliveries = [];
  const fetchImpl = async (url, opts) => { deliveries.push({ url, opts }); return new Response('', { status: 200 }); };
  let verdict = 'no_flags';
  const runPreflightStub = async (args) => ({ decision: args.target === 'd0.example.com' ? verdict : 'no_flags', reasons: verdict === 'flagged' && args.target === 'd0.example.com' ? [{ code: 'DOMAIN_NEWLY_REGISTERED_30D', message: 'new', check: 'check_domain_age' }] : [] });
  let t = Date.now();
  const deps = { store: w.store, runPreflight: runPreflightStub, env: WL_ENV, fetchImpl, lookup: publicLookup, now: () => t };

  const first = await wl.recheckWatchlists(deps);
  assert.equal(first.checked, wl.RECHECK_PER_SUBSCRIBER_PER_RUN, 'one subscriber is capped per run');
  assert.equal(deliveries.length, 0, 'the first check is a baseline');
  await wl.recheckWatchlists(deps); // the remaining 5
  assert.equal(deliveries.length, 0);
  assert.equal((await wl.recheckWatchlists(deps)).checked, 0, 'nothing is due again within 24 hours');

  verdict = 'flagged';
  t += 25 * 3600000;
  const second = await wl.recheckWatchlists(deps);
  assert.equal(second.changed, 1);
  assert.equal(deliveries.length, 1);
  const { url, opts } = deliveries[0];
  assert.equal(url, 'https://hooks.example.com/a');
  assert.equal(opts.redirect, 'manual');
  const event = JSON.parse(opts.body);
  assert.deepEqual([event.type, event.previous_status, event.status, event.item.target], ['watchlist.status_changed', 'no_flags', 'flagged', 'd0.example.com']);
  assert.equal(wl.verifyWebhook(a.body.secret, opts.body, opts.headers['X-PG1-Signature']), true);
});

test('watchlists over HTTP: 402 with PAYMENT-REQUIRED first; a private webhook URL is refused before any payment', async () => {
  const w = await watchWorld();
  globalThis.fetch = w.fetchImpl;
  process.env.SUPABASE_URL = SUP.supUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SUP.supKey;
  process.env.PG1_WATCHLIST_SECRET = WL_ENV.PG1_WATCHLIST_SECRET;
  __setWatchlistDeps({ lookup: publicLookup, fetchImpl: w.fetchImpl });
  const r1 = makeRes();
  await watchlistsHandler({ method: 'POST', headers: {}, query: {}, body: { items: [{ kind: 'domain', target: 'example.com' }], webhook_url: 'https://10.0.0.5/hook' } }, r1);
  assert.equal(r1.statusCode, 400);
  assert.ok(!r1.headers['payment-required']);
  const r2 = makeRes();
  await watchlistsHandler({ method: 'POST', headers: {}, query: {}, body: { items: [{ kind: 'domain', target: 'example.com' }], webhook_url: 'https://hooks.example.com/x' } }, r2);
  assert.equal(r2.statusCode, 402);
  assert.ok(r2.headers['payment-required']);
  assert.equal((await w.db.query('select count(*)::int as n from pg1_watchlists')).rows[0].n, 0);
  const r3 = makeRes();
  await watchlistsHandler({ method: 'GET', headers: { authorization: 'Bearer nope' }, query: { id: crypto.randomUUID() } }, r3);
  assert.equal(r3.statusCode, 404);
});

// --- signals ------------------------------------------------------------------------------

test('proprietary signals are off by default: no observation is built; k-anonymity holds when designed on', () => {
  assert.equal(signalsEnabled({}), false);
  assert.equal(signalsEnabled({ PG1_SIGNALS: 'off' }), false);
  const hashTarget = (s) => crypto.createHash('sha256').update(s).digest('hex');
  assert.equal(buildObservation({ kind: 'wallet', target: '0xabc', status: 'flagged', callerHash: 'a'.repeat(32) }, { env: {}, hashTarget }), null);
  const obs = buildObservation({ kind: 'wallet', target: '0xabc', status: 'flagged', callerHash: 'a'.repeat(32) }, { env: { PG1_SIGNALS: 'on' }, hashTarget });
  assert.ok(obs && !JSON.stringify(obs).includes('0xabc'), 'the target is hashed');
  const some = Array.from({ length: SIGNALS_K_ANONYMITY - 1 }, (_, i) => ({ caller_hash: `c${i}`, status: 'flagged', observed_at: new Date().toISOString() }));
  assert.equal(aggregateSignal(some), null, 'below k nothing is published');
  const enough = [...some, { caller_hash: 'z', status: 'no_flags', observed_at: new Date().toISOString() }];
  const sig = aggregateSignal(enough);
  assert.ok(sig);
  assert.ok(!JSON.stringify(sig).includes('c1'), 'no caller hash in a signal');
});

// --- status --------------------------------------------------------------------------------

test('/status and get_usage_status show per-tool p50/p95 and success with no raw identifiers', async () => {
  const hash = 'f'.repeat(32);
  const rows = [
    ...Array.from({ length: 19 }, (_, i) => ({ tool_name: 'check_domain_age', status: 'ok', latency_ms: 10 + i, caller_hash: hash, requested_tool: 'x' })),
    { tool_name: 'check_domain_age', status: 'upstream_error', latency_ms: 4000, caller_hash: hash },
    { tool_name: 'check_domain_age', status: 'invalid_input', latency_ms: 1, caller_hash: hash },
    { tool_name: 'secret_internal_tool', status: 'ok', latency_ms: 5, caller_hash: hash }
  ];
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return new Response(JSON.stringify(rows)); };
  process.env.SUPABASE_URL = SUP.supUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SUP.supKey;
  const j = makeRes();
  await statusHandler({ method: 'GET', headers: {}, query: { format: 'json' } }, j);
  const m = j.body.tools.find((t) => t.tool === 'check_domain_age');
  assert.deepEqual([m.calls, m.success_rate, m.p50_ms, m.p95_ms], [20, 0.95, 19, 28]);
  assert.ok(!j.body.tools.some((t) => t.tool === 'secret_internal_tool'), 'only public tool names');
  assert.ok(!JSON.stringify(j.body).includes(hash));
  assert.ok(urls.every((u) => !/caller_hash|requested_tool|client_name/.test(u.split('select=')[1].split('&')[0])), 'identifiers are never even read');
  const h = makeRes();
  status.__clearStatusCache();
  await statusHandler({ method: 'GET', headers: {}, query: {} }, h);
  assert.match(h.sent, /check_domain_age/);
  assert.ok(!h.sent.includes(hash));
  assert.ok(!/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(h.sent), 'no IP address on the page');
});

test('the error-rate alert fires above 5% over the hour (with enough calls) and not at or below it', async () => {
  const mk = (ok, bad) => [...Array.from({ length: ok }, () => ({ tool_name: 'check_package', status: 'ok', latency_ms: 5 })), ...Array.from({ length: bad }, () => ({ tool_name: 'check_package', status: 'tool_error', latency_ms: 5 }))];
  const alerts = [];
  const notify = async (a) => { alerts.push(a); return true; };
  const fetchWith = (rows) => async () => new Response(JSON.stringify(rows));
  await status.monitorErrorRates({ ...SUP, tools: ['check_package'], fetchImpl: fetchWith(mk(95, 5)), notify });
  assert.equal(alerts.length, 0, '5% exactly is not above 5%');
  await status.monitorErrorRates({ ...SUP, tools: ['check_package'], fetchImpl: fetchWith(mk(90, 10)), notify });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].reason, 'tool_error_rate');
  assert.match(alerts[0].message, /check_package: 10% of 100 calls/);
  await status.monitorErrorRates({ ...SUP, tools: ['check_package'], fetchImpl: fetchWith(mk(5, 5)), notify });
  assert.equal(alerts.length, 1, 'too few calls to alert');
});
