/**
 * The public tools playground: POST /api/playground (api/playground.mjs,
 * lib/playground.mjs, lib/ens.mjs) and the /playground page
 * (public/playground/).
 *
 * Covers: each always-free check returns the chat's result card; strict
 * input validation with neutral messages; paid and write tools rejected;
 * per-visitor and global daily limits; "unknown" never shown as safe, on
 * the server and in the page's renderer; no provider or model names in any
 * response; no LLM client on the import path; the page's CSP; no cookies,
 * storage or analytics.
 *
 * Run with: node --test tests/playground.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import defaultHandler, { createPlaygroundHandler } from '../api/playground.mjs';
import {
  createPlaygroundLimiter, validatePlaygroundRequest, PLAYGROUND_TOOLS, PLAYGROUND_DAILY_CAP, PLAYGROUND_TOOL_LIMITS,
  PLAYGROUND_CHAINS, PLAYGROUND_WINDOW_MS, MESSAGES, NOTES
} from '../lib/playground.mjs';
import { namehash, normalizeEnsName, resolveEnsName, ENS_REGISTRY } from '../lib/ens.mjs';
import { FIXTURE_VALUES } from '../lib/fixtures.mjs';
import { RATE_LIMIT_WINDOW_MS, DOMAIN_AGE_RATE_LIMIT_MAX, HOSTNAME_REPUTATION_RATE_LIMIT_MAX, WALLET_AGE_RATE_LIMIT_MAX } from '../lib/x402Config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const W = FIXTURE_VALUES.wallet;
const D = FIXTURE_VALUES.domain;

// Every response body any test sees, checked for provider/model names at
// the end.
const SEEN_BODIES = [];

// Names of PG1's data providers, hosting, payment and model vendors that
// must never reach a playground visitor.
const FORBIDDEN_NAMES = /ofac|treasury|metamask|eth-phishing-detect|rdap|alchemy|supabase|gumroad|alienvault|mitre|gemini|google|anthropic|claude|openai|gpt-|vercel|coinbase|llm|model/i;

function makeReq(body, { ip = '203.0.113.50', method = 'POST', headers = {} } = {}) {
  return { method, headers: { 'x-forwarded-for': ip, ...headers }, socket: { remoteAddress: '127.0.0.1' }, body };
}

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; SEEN_BODIES.push(JSON.stringify(p)); return this; },
    end() { return this; }
  };
}

const quiet = () => {};

function makeHandler(opts = {}) {
  const records = [];
  const runs = [];
  const handler = createPlaygroundHandler({
    limiter: opts.limiter || createPlaygroundLimiter(opts.limiterOptions),
    resolveEns: opts.resolveEns || (async () => { throw new Error('ENS should not be called'); }),
    record: (...args) => records.push(args),
    executorOptions: {
      log: quiet,
      ...(opts.run ? { run: async (name, args, ctx) => { runs.push({ name, args, ctx }); return opts.run(name, args, ctx); } } : {}),
      ...(opts.fixtures ? { fixtures: opts.fixtures } : {}),
      ...(opts.executorOptions || {})
    }
  });
  async function call(body, reqOpts) {
    const res = makeRes();
    await handler(makeReq(body, reqOpts), res);
    return res;
  }
  return { handler, call, records, runs };
}

// ---------------------------------------------------------------------------
// Each tool returns a card

test('each of the four checks returns the result card through /api/playground', async () => {
  const { call } = makeHandler();
  const cases = [
    [{ tool: 'check_domain_age', input: D.CLEAN }, 'no_flags', 'domain'],
    [{ tool: 'check_hostname_reputation', input: D.FLAGGED }, 'flagged', 'hostname'],
    [{ tool: 'check_wallet_sanctions', input: W.FLAGGED }, 'flagged', 'address'],
    [{ tool: 'check_wallet_age', input: W.CLEAN, chain: 'ethereum' }, 'no_flags', 'address']
  ];
  for (const [body, status, kind] of cases) {
    const res = await call(body);
    assert.equal(res.statusCode, 200, body.tool);
    assert.equal(res.body.ok, true);
    const card = res.body.card;
    assert.equal(card.tool, body.tool);
    assert.equal(card.status, status, body.tool);
    assert.equal(card.subject_kind, kind);
    assert.ok(card.title && card.status_label && Array.isArray(card.fields) && Array.isArray(card.reasons) && Array.isArray(card.checks));
    assert.match(card.request_id, /^[0-9a-f-]{36}$/);
    assert.equal(res.headers['X-Request-Id'], card.request_id);
    assert.equal(card.test_fixture, true);
    assert.equal(card.raw, undefined, 'no raw upstream JSON on the playground card');
    assert.equal(card.input, undefined);
  }
});

test('check_wallet_age defaults to base and passes the picked chain to the tool', async () => {
  const run = async (name, args) => ({ address: args.address, chain: args.chain, found: true, first_seen: '2023-09-01T00:00:00Z', age_days: 700, status: 'no_flags', reasons: [], checks: [{ source: 'on-chain transfer history', result: 'ok' }] });
  const { call, runs } = makeHandler({ run });
  const addr = '0x' + 'ab'.repeat(20);
  await call({ tool: 'check_wallet_age', input: addr });
  await call({ tool: 'check_wallet_age', input: addr, chain: 'polygon' });
  assert.deepEqual(runs.map((r) => r.args.chain), ['base', 'polygon']);
  assert.deepEqual(PLAYGROUND_CHAINS, ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon', 'bsc'], 'chain allow-list is the MCP tool enum');
  const html = read('public/playground/index.html');
  for (const c of PLAYGROUND_CHAINS) assert.match(html, new RegExp(`<option value="${c}"`), `chain picker offers ${c}`);
  assert.equal((html.match(/<option /g) || []).length, PLAYGROUND_CHAINS.length, 'chain picker offers nothing else');
});

test('the real (non-fixture) path runs the shared tool handler as a guest, keyed by a hash, never the raw IP', async () => {
  const run = async (name, args) => ({ domain: args.domain, found: true, registration_date: '2010-01-01T00:00:00Z', age_days: 6000, status: 'no_flags', reasons: [], checks: [{ source: 'domain registration records', result: 'ok' }] });
  const { call, runs } = makeHandler({ run });
  const res = await call({ tool: 'check_domain_age', input: '  Example.COM ' }, { ip: '198.51.100.77' });
  assert.equal(res.body.card.status, 'no_flags');
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].args, { domain: 'example.com' });
  assert.equal(runs[0].ctx.licensed, false, 'guest standing: the anonymous MCP limits apply too');
  assert.match(runs[0].ctx.identifier, /^playground:[0-9a-f]{32}$/);
  assert.doesNotMatch(runs[0].ctx.identifier, /198\.51\.100\.77/);
});

// ---------------------------------------------------------------------------
// Validation

test('invalid inputs are rejected with a neutral message that never echoes the input, and nothing runs', async () => {
  let ran = 0;
  const { call } = makeHandler({ run: async () => { ran++; return {}; }, fixtures: () => { ran++; return null; } });
  const bad = [
    [{ tool: 'check_domain_age', input: 'https://example.com' }, MESSAGES.domain],
    [{ tool: 'check_domain_age', input: 'example.com/path' }, MESSAGES.domain],
    [{ tool: 'check_domain_age', input: 'example.com:8080' }, MESSAGES.domain],
    [{ tool: 'check_domain_age', input: 'exa mple.com' }, MESSAGES.domain],
    [{ tool: 'check_domain_age', input: 'localhost' }, MESSAGES.domain],
    [{ tool: 'check_domain_age', input: 'example.com.' }, MESSAGES.domain],
    [{ tool: 'check_domain_age', input: '-bad.com' }, MESSAGES.domain],
    [{ tool: 'check_domain_age', input: '192.0.2.1' }, MESSAGES.domain],
    [{ tool: 'check_domain_age', input: '<script>alert(1)</script>.com' }, MESSAGES.domain],
    [{ tool: 'check_domain_age', input: 'a'.repeat(300) + '.com' }, MESSAGES.domain],
    [{ tool: 'check_domain_age', input: 42 }, MESSAGES.domain],
    [{ tool: 'check_domain_age' }, MESSAGES.domain],
    [{ tool: 'check_hostname_reputation', input: '*.example.com' }, MESSAGES.hostname],
    [{ tool: 'check_hostname_reputation', input: 'user@example.com' }, MESSAGES.hostname],
    [{ tool: 'check_hostname_reputation', input: '' }, MESSAGES.hostname],
    [{ tool: 'check_wallet_sanctions', input: '0x1234' }, MESSAGES.wallet],
    [{ tool: 'check_wallet_sanctions', input: '0x' + 'g'.repeat(40) }, MESSAGES.wallet],
    [{ tool: 'check_wallet_sanctions', input: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' }, MESSAGES.wallet],
    [{ tool: 'check_wallet_sanctions', input: 'example.com' }, MESSAGES.wallet],
    [{ tool: 'check_wallet_sanctions', input: '.eth' }, MESSAGES.wallet],
    [{ tool: 'check_wallet_sanctions', input: 'bad_name.eth' }, MESSAGES.wallet],
    [{ tool: 'check_wallet_age', input: W.CLEAN, chain: 'solana' }, MESSAGES.chain],
    [{ tool: 'check_wallet_age', input: W.CLEAN, chain: 7 }, MESSAGES.chain],
    [{ tool: 'check_domain_age', input: D.CLEAN, chain: 'base' }, MESSAGES.bad_request],
    [{ tool: 'check_domain_age', input: D.CLEAN, extra: 1 }, MESSAGES.bad_request],
    [['check_domain_age'], MESSAGES.bad_request],
    ['{not json', MESSAGES.bad_request],
    [null, MESSAGES.bad_request]
  ];
  for (const [body, message] of bad) {
    const res = await call(body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'invalid_input', JSON.stringify(body));
    assert.equal(res.body.error.message, message, JSON.stringify(body));
    assert.match(res.body.request_id, /^[0-9a-f-]{36}$/, 'every rejection carries a request_id');
    if (body && typeof body === 'object' && typeof body.input === 'string' && body.input && !message.includes(body.input)) {
      assert.ok(!JSON.stringify(res.body).includes(body.input), 'the input is never echoed back');
    }
  }
  assert.equal(ran, 0, 'no tool or fixture lookup runs for a rejected request');
});

test('valid inputs: bare domains and hostnames (lowercased), punycode, EVM addresses and ENS names', () => {
  assert.deepEqual(validatePlaygroundRequest({ tool: 'check_domain_age', input: ' Example.Co.UK ' }), { ok: true, tool: 'check_domain_age', value: 'example.co.uk', kind: 'domain' });
  assert.equal(validatePlaygroundRequest({ tool: 'check_hostname_reputation', input: 'xn--mtamask-6ua.io' }).ok, true);
  assert.equal(validatePlaygroundRequest({ tool: 'check_wallet_sanctions', input: '0x' + 'aB'.repeat(20) }).kind, 'address');
  assert.deepEqual(validatePlaygroundRequest({ tool: 'check_wallet_age', input: 'Vitalik.ETH' }), { ok: true, tool: 'check_wallet_age', value: 'vitalik.eth', kind: 'ens', chain: 'base' });
  assert.equal(validatePlaygroundRequest({ tool: 'check_wallet_sanctions', input: 'pay.alice.eth' }).kind, 'ens');
});

test('paid, write and other non-playground tools are rejected and never run', async () => {
  let ran = 0;
  const { call } = makeHandler({ run: async () => { ran++; return {}; }, fixtures: () => { ran++; return null; } });
  assert.deepEqual([...PLAYGROUND_TOOLS].sort(), ['check_domain_age', 'check_hostname_reputation', 'check_wallet_age', 'check_wallet_sanctions']);
  for (const tool of ['get_threat_indicators', 'get_ioc_context', 'get_ioc_batch', 'get_cve_details', 'get_cve_batch', 'get_cve_by_product', 'get_threat_actor_profile', 'subscribe_alerts', 'submit_indicator', 'get_usage_status', 'tools/call', '', 'CHECK_DOMAIN_AGE']) {
    const res = await call({ tool, input: 'example.com' });
    assert.equal(res.statusCode, 400, tool);
    assert.equal(res.body.error.code, 'not_available', tool);
    assert.equal(res.body.error.message, MESSAGES.not_available);
  }
  assert.equal(ran, 0);
});

test('only POST runs a check', async () => {
  const { handler } = makeHandler();
  const res = makeRes();
  await handler(makeReq(undefined, { method: 'GET' }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.body.ok, false);
  assert.ok(res.body.request_id);
});

// ---------------------------------------------------------------------------
// Rate limits

test('per-visitor limit: the MCP anonymous limit per check (60/hour), then a neutral message with the retry time', async () => {
  assert.equal(PLAYGROUND_WINDOW_MS, RATE_LIMIT_WINDOW_MS);
  assert.equal(PLAYGROUND_TOOL_LIMITS.check_domain_age, DOMAIN_AGE_RATE_LIMIT_MAX);
  assert.equal(PLAYGROUND_TOOL_LIMITS.check_hostname_reputation, HOSTNAME_REPUTATION_RATE_LIMIT_MAX);
  assert.equal(PLAYGROUND_TOOL_LIMITS.check_wallet_age, WALLET_AGE_RATE_LIMIT_MAX);
  assert.equal(PLAYGROUND_TOOL_LIMITS.check_wallet_sanctions, 60);

  let t = Date.UTC(2026, 9, 3, 12, 0, 0);
  const { call } = makeHandler({ limiterOptions: { now: () => t } });
  for (let i = 0; i < DOMAIN_AGE_RATE_LIMIT_MAX; i++) {
    const ok = await call({ tool: 'check_domain_age', input: D.CLEAN }, { ip: '198.51.100.9' });
    assert.equal(ok.statusCode, 200, `call ${i + 1}`);
  }
  t += 20 * 60 * 1000;
  const over = await call({ tool: 'check_domain_age', input: D.CLEAN }, { ip: '198.51.100.9' });
  assert.equal(over.statusCode, 429);
  assert.equal(over.body.error.code, 'rate_limited');
  assert.equal(over.body.error.message, 'You have reached the limit for this check. Try again in about 40 minutes.');
  assert.equal(over.body.error.retry_after_seconds, 40 * 60);
  assert.equal(over.headers['Retry-After'], String(40 * 60));
  assert.ok(over.body.request_id);

  // Another check, or another visitor, is unaffected.
  assert.equal((await call({ tool: 'check_wallet_sanctions', input: W.CLEAN }, { ip: '198.51.100.9' })).statusCode, 200);
  assert.equal((await call({ tool: 'check_domain_age', input: D.CLEAN }, { ip: '198.51.100.10' })).statusCode, 200);

  // The window resets.
  t += 41 * 60 * 1000;
  assert.equal((await call({ tool: 'check_domain_age', input: D.CLEAN }, { ip: '198.51.100.9' })).statusCode, 200);
});

test('global daily cap across all visitors (default 2000), reset at the next UTC day', async () => {
  assert.equal(PLAYGROUND_DAILY_CAP, 2000);

  // The default limiter really stops at 2000.
  let t = Date.UTC(2026, 9, 3, 18, 0, 0);
  const limiter = createPlaygroundLimiter({ now: () => t });
  for (let i = 0; i < PLAYGROUND_DAILY_CAP; i++) assert.equal(limiter.take('check_domain_age', `10.0.${i >> 8}.${i & 255}`).ok, true, `take ${i + 1}`);
  const refused = limiter.take('check_domain_age', '10.9.9.9');
  assert.equal(refused.ok, false);
  assert.equal(refused.scope, 'global');
  assert.equal(refused.retryMs, 6 * 60 * 60 * 1000);

  // Through the endpoint, with a small cap.
  t = Date.UTC(2026, 9, 3, 23, 30, 0);
  const { call } = makeHandler({ limiterOptions: { now: () => t, dailyCap: 3 } });
  for (let i = 0; i < 3; i++) assert.equal((await call({ tool: 'check_wallet_sanctions', input: W.CLEAN }, { ip: `192.0.2.${i + 1}` })).statusCode, 200);
  const over = await call({ tool: 'check_domain_age', input: D.CLEAN }, { ip: '192.0.2.200' });
  assert.equal(over.statusCode, 429);
  assert.equal(over.body.error.message, 'The playground has reached its daily limit. Try again in about 30 minutes.');
  assert.equal(over.headers['Retry-After'], String(30 * 60));
  t = Date.UTC(2026, 9, 4, 0, 0, 1);
  assert.equal((await call({ tool: 'check_domain_age', input: D.CLEAN }, { ip: '192.0.2.200' })).statusCode, 200);
});

test('a visitor over their own limit does not use up the global cap', () => {
  const t = Date.UTC(2026, 9, 3, 12, 0, 0);
  const limiter = createPlaygroundLimiter({ now: () => t, dailyCap: 62 });
  for (let i = 0; i < 60; i++) limiter.take('check_wallet_age', '192.0.2.1');
  for (let i = 0; i < 10; i++) assert.equal(limiter.take('check_wallet_age', '192.0.2.1').scope, 'visitor');
  assert.equal(limiter.take('check_wallet_age', '192.0.2.2').ok, true);
  assert.equal(limiter.take('check_wallet_age', '192.0.2.3').ok, true);
  assert.equal(limiter.take('check_wallet_age', '192.0.2.4').scope, 'global');
});

test('invalid requests do not count against any limit', async () => {
  const t = Date.UTC(2026, 9, 3, 12, 0, 0);
  const { call } = makeHandler({ limiterOptions: { now: () => t, dailyCap: 1 } });
  for (let i = 0; i < 5; i++) await call({ tool: 'check_domain_age', input: 'not a domain' });
  assert.equal((await call({ tool: 'check_domain_age', input: D.CLEAN })).statusCode, 200);
});

// ---------------------------------------------------------------------------
// Honesty: unknown is never safe, no_flags carries the caveat

test('unknown and failed results are never presented as safe; no_flags carries the caveat', async () => {
  const { call } = makeHandler();
  const unknown = (await call({ tool: 'check_domain_age', input: D.UNKNOWN })).body.card;
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.status_label, 'Unknown');
  assert.equal(unknown.note, NOTES.unknown);
  assert.match(unknown.note, /not as safe/);

  const failed = (await call({ tool: 'check_wallet_age', input: W.UNKNOWN })).body.card;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.note, NOTES.failed);
  assert.match(failed.note, /not as safe/);
  assert.equal(failed.error.message, 'The check could not be completed right now.');
  assert.ok(failed.request_id);

  const clean = (await call({ tool: 'check_domain_age', input: D.CLEAN })).body.card;
  assert.equal(clean.status, 'no_flags');
  assert.match(clean.note, /not an endorsement or guarantee of safety/);

  for (const card of [unknown, failed, clean]) assert.doesNotMatch(`${card.status_label} ${card.note}`, /\b(?:is|looks|appears) safe\b|\bclean\b|\blegitimate\b/i);
  assert.deepEqual(unknown.fields.find((f) => f.label === 'Reason'), { label: 'Reason', value: 'timeout' }, 'only the reason code, not the upstream prose');
});

test('a result with a missing or unrecognised status is shown as unknown', async () => {
  const { call } = makeHandler({ run: async (name, args) => ({ hostname: args.hostname, verdict: 'not_listed', status: 'safe', reasons: [], checks: [{ source: 'phishing domain list', result: 'ok' }] }) });
  const card = (await call({ tool: 'check_hostname_reputation', input: 'example.org' })).body.card;
  assert.equal(card.status, 'unknown');
  assert.equal(card.note, NOTES.unknown);
});

function loadClient() {
  const ctx = vm.createContext({});
  vm.runInContext(read('public/playground/playground.js'), ctx);
  return ctx.PG1Playground;
}

test('the page renders unknown, failed and unrecognised statuses as Unknown/Failed with the unverified note, never as safe', () => {
  const ui = loadClient();
  const base = { tool: 'check_domain_age', title: 'Domain age', subject: 'example.com', fields: [], reasons: [], checks: [], request_id: '11111111-2222-3333-4444-555555555555' };
  for (const status of ['unknown', 'safe', 'clean', undefined, 'no-flags']) {
    const html = ui.cardHtml({ ...base, status, status_label: 'Safe', note: 'This domain is safe.' });
    assert.match(html, /tool-chip is-unknown">Unknown</, String(status));
    assert.match(html, /Treat it as unverified, not as safe\./);
    assert.doesNotMatch(html, /is-clear|No flags|Safe<|is safe/, String(status));
    assert.match(html, /request_id <code>11111111-2222-3333-4444-555555555555<\/code>/);
  }
  const failed = ui.cardHtml({ ...base, status: 'failed', error: { code: 'unavailable', message: 'The check could not be completed right now.' } });
  assert.match(failed, /is-failed">Failed</);
  assert.match(failed, /not as safe/);

  const clean = ui.cardHtml({ ...base, status: 'no_flags', note: '' });
  assert.match(clean, /is-clear">No flags</);
  assert.match(clean, /It is not an endorsement or guarantee of safety\./, 'the caveat comes from the page, whatever the server sends');

  // Everything from the payload is escaped.
  const xss = ui.cardHtml({ ...base, status: 'flagged', subject: '<img src=x onerror=alert(1)>', fields: [{ label: '<b>', value: '<script>' }], reasons: [{ code: '<i>', message: '"x"' }] });
  assert.doesNotMatch(xss, /<img|<script>|<b>|<i>/);

  // Error responses show the neutral message and the request_id.
  const limited = ui.responseHtml(429, { ok: false, error: { code: 'rate_limited', message: 'You have reached the limit for this check. Try again in about 5 minutes.' }, request_id: 'abc-123' });
  assert.match(limited, /Try again in about 5 minutes\./);
  assert.match(limited, /request_id <code>abc-123<\/code>/);
});

// ---------------------------------------------------------------------------
// No provider or model names, no raw upstream errors

test('upstream failures: neutral message, request_id, detail only in pg1_errors under that id', async () => {
  const { call, records } = makeHandler({
    run: async () => {
      const err = new Error('Alchemy responded 503: upstream gateway error from eth-mainnet (gemini-2.5 fallback)');
      err.serviceUnavailable = true;
      throw err;
    }
  });
  const res = await call({ tool: 'check_wallet_age', input: '0x' + 'cd'.repeat(20) });
  assert.equal(res.statusCode, 200);
  const card = res.body.card;
  assert.equal(card.status, 'failed');
  assert.deepEqual(card.error, { code: 'unavailable', message: 'The check could not be completed right now.' });
  // The request_id is a random UUID, so it can itself contain "503" or
  // "cdcdcd"; it is checked by value below and left out of the text scans.
  const withoutId = (v) => JSON.stringify(v).split(card.request_id).join('<request_id>');
  assert.doesNotMatch(withoutId(res.body), /503|gateway|eth-mainnet/);
  assert.equal(records.length, 1);
  assert.equal(records[0][0], '/api/playground:check_wallet_age');
  assert.equal(records[0][4], card.request_id, 'logged under the request_id the visitor sees');
  assert.doesNotMatch(withoutId(records[0]), /cdcdcd/, 'the input is not logged');
});

test('the tool\'s own rate-limit or invalid-input text never reaches the visitor', async () => {
  const limited = makeHandler({ run: async () => { const e = new Error('check_domain_age is limited to 60 calls/hour per caller. Use a Gumroad license key (X-API-KEY).'); e.mcpToolError = true; e.code = 'rate_limited'; throw e; } });
  const r1 = (await limited.call({ tool: 'check_domain_age', input: 'example.net' })).body.card;
  assert.deepEqual(r1.error, { code: 'busy', message: 'This check is busy right now. Try again later.' });
  const invalid = makeHandler({ run: async () => { const e = new Error('Supabase says no'); e.fixIt = { problem: 'x' }; throw e; } });
  const r2 = (await invalid.call({ tool: 'check_wallet_sanctions', input: '0x' + 'ef'.repeat(20) })).body.card;
  assert.deepEqual(r2.error, { code: 'invalid_input', message: 'That input could not be checked.' });
});

test('result fields that name a data source (attribution, source, messages) are dropped from the card', async () => {
  const { call } = makeHandler({
    run: async (name, args) => ({
      hostname: args.hostname, verdict: 'not_listed', sources: [], lookalike_of: null, list_synced_at: '2026-10-01T00:00:00Z',
      attribution: 'Data sourced from MetaMask eth-phishing-detect', source: 'RDAP (rdap.verisign.com)', message: 'Not on the OFAC SDN list',
      status: 'no_flags', reasons: [{ code: 'HOSTNAME_LOOKALIKE', message: 'Lookalike per MetaMask fuzzylist' }],
      checks: [{ source: 'phishing domain list', result: 'ok', data_as_of: '2026-10-01T00:00:00Z' }, { source: 'Alchemy RPC', result: 'ok' }]
    })
  });
  const res = await call({ tool: 'check_hostname_reputation', input: 'example.org' });
  const text = JSON.stringify(res.body);
  assert.doesNotMatch(text, FORBIDDEN_NAMES);
  assert.equal(res.body.card.reasons[0].message, 'Hostname is a probable lookalike/typosquat of a known brand domain.', 'reasons use PG1\'s fixed wording');
  assert.deepEqual(res.body.card.checks.map((c) => c.source), ['phishing domain list', 'data source']);
});

// ---------------------------------------------------------------------------
// ENS

// vitalik.eth and its published address, for the look-alike tests.
const VITALIK = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
const ZWSP = '\u200B';
const ZWJ = '\u200D';
const CYRILLIC_I = '\u0456'; // "і", looks like Latin "i"

test('ENS: names are ENSIP-15 normalised by viem; namehash is viem\'s', () => {
  assert.equal(namehash('eth'), '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae');
  assert.equal(namehash('foo.eth'), '0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f');
  assert.equal(normalizeEnsName('vitalik.eth'), 'vitalik.eth');
  assert.equal(normalizeEnsName('  VitaLik.ETH '), 'vitalik.eth', 'mixed case normalises');
  assert.equal(normalizeEnsName('\u{1F4A9}.eth'), '\u{1F4A9}.eth', 'valid Unicode names are kept');
  // A zero-width character: ZWJ fails ENSIP-15; ZWSP is something ENSIP-15
  // would silently drop, and is refused here instead.
  assert.equal(normalizeEnsName(`vit${ZWJ}alik.eth`), null);
  assert.equal(normalizeEnsName(`vit${ZWSP}alik.eth`), null);
  assert.equal(normalizeEnsName(`v${CYRILLIC_I}talik.eth`), null, 'Latin + Cyrillic mixture fails normalisation');
  for (const bad of ['bad_name.eth', '.eth', 'a..eth', 'vitalik\uFF0Eeth', 'vitalik.com', '0x' + 'ab'.repeat(20), '', null]) {
    assert.equal(normalizeEnsName(bad), null, JSON.stringify(bad));
  }
});

test('ENS through the endpoint: mixed case resolves; zero-width, look-alike and invalid names get the neutral message and never reach a lookup', async () => {
  const looked = [];
  // A resolver that only knows the real vitalik.eth.
  const resolveEns = async (name) => { looked.push(name); return name === 'vitalik.eth' ? VITALIK : null; };
  const { call, runs } = makeHandler({ resolveEns, run: async (name, args) => ({ address: args.address, chain: args.chain, found: true, first_seen: '2015-08-01T00:00:00Z', status: 'no_flags', reasons: [], checks: [{ source: 'on-chain transfer history', result: 'ok' }] }) });

  const mixed = await call({ tool: 'check_wallet_age', input: 'VitaLik.ETH' });
  assert.equal(mixed.body.card.subject, VITALIK);
  assert.deepEqual(mixed.body.card.fields[0], { label: 'ENS name', value: 'vitalik.eth' });
  assert.deepEqual(looked, ['vitalik.eth']);

  for (const input of [`vit${ZWSP}alik.eth`, `vit${ZWJ}alik.eth`, `v${CYRILLIC_I}talik.eth`, 'bad_name.eth', '.eth']) {
    const res = await call({ tool: 'check_wallet_sanctions', input });
    assert.equal(res.statusCode, 400, JSON.stringify(input));
    assert.equal(res.body.error.message, MESSAGES.wallet);
    assert.doesNotMatch(JSON.stringify(res.body), new RegExp(VITALIK, 'i'), 'never vitalik\'s address');
  }
  assert.deepEqual(looked, ['vitalik.eth'], 'no lookup ran for any rejected name');
  assert.equal(runs.length, 1);
});

test('ENS: a Unicode look-alike of vitalik.eth never resolves to vitalik\'s address, even at the resolver', async () => {
  const realNode = namehash('vitalik.eth').slice(2);
  const resolver = '0x' + '12'.repeat(20);
  const word = (addr) => '0x' + '0'.repeat(24) + addr.slice(2);
  const origFetch = globalThis.fetch;
  const asked = [];
  // An RPC that answers only for vitalik.eth's real node.
  globalThis.fetch = async (url, opts) => {
    const { to, data } = JSON.parse(opts.body).params[0];
    asked.push(data);
    const forReal = data.endsWith(realNode);
    return { ok: true, json: async () => ({ result: forReal ? word(to === ENS_REGISTRY ? resolver : VITALIK) : '0x' + '0'.repeat(64) }) };
  };
  try {
    const rpc = { rpcUrl: 'https://rpc.example.invalid' };
    assert.equal(await resolveEnsName('vitalik.eth', rpc), VITALIK);
    for (const lookalike of [`v${CYRILLIC_I}talik.eth`, `vit${ZWSP}alik.eth`, 'VITALIK.ETH']) {
      asked.length = 0;
      assert.equal(await resolveEnsName(lookalike, rpc), null, JSON.stringify(lookalike));
      assert.equal(asked.length, 0, 'not normalised: no lookup is made at all');
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('ENS: resolver then addr() on mainnet; no resolver is "not resolved"; a failed lookup is unavailable', async () => {
  const origFetch = globalThis.fetch;
  const node = namehash('alice.eth').slice(2);
  const resolver = '0x' + '12'.repeat(20);
  const target = '0x' + '34'.repeat(20);
  const word = (addr) => '0x' + '0'.repeat(24) + addr.slice(2);
  try {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push({ url, to: body.params[0].to, data: body.params[0].data });
      const result = body.params[0].to === ENS_REGISTRY ? word(resolver) : word(target);
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
    };
    assert.equal(await resolveEnsName('alice.eth', { rpcUrl: 'https://rpc.example.invalid' }), target);
    assert.deepEqual(calls.map((c) => c.data), ['0x0178b8bf' + node, '0x3b3b57de' + node]);
    assert.equal(calls[1].to, resolver);

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ result: '0x' + '0'.repeat(64) }) });
    assert.equal(await resolveEnsName('nobody.eth', { rpcUrl: 'https://rpc.example.invalid' }), null);

    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
    await assert.rejects(resolveEnsName('alice.eth', { rpcUrl: 'https://rpc.example.invalid' }), (e) => e.ensUnavailable === true);
    await assert.rejects(resolveEnsName('alice.eth', { rpcUrl: null }), (e) => e.ensUnavailable === true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('ENS through the endpoint: resolved address is checked, unresolved and unavailable are failed cards', async () => {
  const target = '0x' + '56'.repeat(20);
  const ok = makeHandler({ resolveEns: async (name) => (name === 'alice.eth' ? target : null), run: async (name, args) => ({ address: args.address, listed: false, matches: [], status: 'no_flags', reasons: [], checks: [{ source: 'sanctions list', result: 'ok' }] }) });
  const res = await ok.call({ tool: 'check_wallet_sanctions', input: 'Alice.eth' });
  assert.equal(res.body.card.status, 'no_flags');
  assert.equal(res.body.card.subject, target);
  assert.deepEqual(res.body.card.fields[0], { label: 'ENS name', value: 'alice.eth' });
  assert.deepEqual(ok.runs[0].args, { address: target });

  const missing = (await ok.call({ tool: 'check_wallet_age', input: 'nobody.eth' })).body.card;
  assert.equal(missing.status, 'failed');
  assert.equal(missing.error.message, 'That name does not resolve to an address.');
  assert.match(missing.note, /not as safe/);

  const down = makeHandler({ resolveEns: async () => { const e = new Error('Alchemy 500'); e.ensUnavailable = true; throw e; } });
  const res2 = await down.call({ tool: 'check_wallet_age', input: 'alice.eth' });
  assert.equal(res2.body.card.status, 'failed');
  assert.equal(res2.body.card.error.message, 'The check could not be completed right now.');
  assert.equal(down.records[0][0], '/api/playground:ens');
  assert.equal(down.records[0][4], res2.body.card.request_id);
  assert.equal(down.runs.length, 0);
});

// ---------------------------------------------------------------------------
// No LLM on this path

test('no LLM client is imported anywhere on the /api/playground path', () => {
  const seen = new Set();
  const packages = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1] || m[2] || m[3];
      if (spec.startsWith('.')) walk(path.resolve(path.dirname(file), spec));
      else packages.add(spec);
    }
  };
  walk(path.join(ROOT, 'api/playground.mjs'));
  const files = [...seen].map((f) => path.relative(ROOT, f));
  assert.ok(files.includes('lib/chatTools.mjs'), 'uses the shared tool runner');
  for (const f of files) {
    assert.doesNotMatch(f, /^api\/chat\.mjs$|chatStream|voice|imageEngines|upstreamFailure|secretGuard|identity/, `${f} is a chat/model module`);
    const src = read(f);
    assert.doesNotMatch(src, /generativelanguage\.googleapis\.com|api\.anthropic\.com|api\.openai\.com/, `${f} calls a model API`);
  }
  for (const p of packages) {
    assert.doesNotMatch(p, /^ai$|^@ai-sdk\/|^@anthropic-ai\/|^openai$|^@google\/(?:genai|generative-ai)|langchain/, `${p} is an LLM client`);
  }
});

test('a playground request makes no model call: only the tool\'s own upstream is fetched', async () => {
  const origFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return { ok: false, status: 500, json: async () => ({}), text: async () => '' }; };
  try {
    const res = makeRes();
    await defaultHandler(makeReq({ tool: 'check_domain_age', input: D.CLEAN }, { ip: '192.0.2.99' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.card.status, 'no_flags');
    assert.deepEqual(urls.filter((u) => /googleapis|anthropic|openai/.test(u)), []);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------------------------------------------------------------------------
// The page: CSP, no inline scripts, no cookies/storage/analytics, footer

const PAGE_CSP_RE = /default-src 'self'; script-src 'self'; style-src 'self';/;

test('a strict Content-Security-Policy is set for /playground (vercel.json headers and the page itself)', () => {
  const vercel = JSON.parse(read('vercel.json'));
  for (const source of ['/playground', '/playground/(.*)']) {
    const entry = vercel.headers.find((h) => h.source === source);
    assert.ok(entry, `headers for ${source}`);
    const csp = entry.headers.find((h) => h.key === 'Content-Security-Policy');
    assert.ok(csp, `CSP for ${source}`);
    assert.match(csp.value, PAGE_CSP_RE);
    assert.match(csp.value, /object-src 'none'/);
    assert.match(csp.value, /frame-ancestors 'none'/);
    assert.match(csp.value, /connect-src 'self'/);
    assert.doesNotMatch(csp.value, /unsafe-inline|unsafe-eval|https?:|\*/);
  }
  assert.ok(vercel.rewrites.some((r) => r.source === '/playground' && r.destination === '/playground/index.html'));
  const cors = vercel.headers.find((h) => h.source.startsWith('/api/:path'));
  assert.match(cors.source, /playground\$/, '/api/playground is not given the wildcard CORS header');

  const html = read('public/playground/index.html');
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(meta);
  assert.match(meta[1], PAGE_CSP_RE);
});

test('the API response carries its own CSP, no-store and no cookie', async () => {
  const { call } = makeHandler();
  for (const body of [{ tool: 'check_domain_age', input: D.CLEAN }, { tool: 'nope', input: 'x' }]) {
    const res = await call(body);
    assert.equal(res.headers['Content-Security-Policy'], "default-src 'none'; frame-ancestors 'none'");
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.headers['Set-Cookie'], undefined);
  }
});

test('the page has no inline scripts, styles or handlers, and nothing third-party', () => {
  const html = read('public/playground/index.html');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0][1], /src="\/playground\/playground\.js"/);
  assert.equal(scripts[0][2].trim(), '', 'no inline script body');
  assert.doesNotMatch(html, /<style\b|\sstyle="|\son[a-z]+=/i);
  assert.doesNotMatch(html.replace(/https:\/\/pg1-ai-agent\.vercel\.app\/playground/, '').replace(/http:\/\/www\.w3\.org\/2000\/svg/, ''), /https?:\/\//, 'no external resources');
  const js = read('public/playground/playground.js');
  assert.doesNotMatch(js, /\bon[a-z]+="|onclick/i, 'rendered markup has no inline handlers either');
});

test('no cookies, no browser storage, no analytics; the only request is POST /api/playground', () => {
  const stripComments = (src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const js = read('public/playground/playground.js');
  const html = read('public/playground/index.html');
  for (const src of [stripComments(js), html]) {
    assert.doesNotMatch(src, /document\.cookie|localStorage|sessionStorage|indexedDB|navigator\.sendBeacon|gtag|analytics|plausible|posthog|segment/i);
  }
  const fetches = [...js.matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(fetches, ['/api/playground']);
  assert.match(js, /credentials: 'omit'/);
});

test('the page offers exactly the four free checks and the footer invites developers to /about', () => {
  const html = read('public/playground/index.html');
  const tools = [...html.matchAll(/name="tool" value="([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tools.sort(), [...PLAYGROUND_TOOLS].sort());
  const footer = html.match(/<footer>([\s\S]*?)<\/footer>/)[1];
  assert.match(footer, /MCP/);
  assert.match(footer, /A2A/);
  assert.match(footer, /href="\/about"/);
  assert.ok(fs.existsSync(path.join(ROOT, 'public/about/index.html')));
  assert.doesNotMatch(html, /chat|sign in|log in|model/i, 'no chat, no sign-in, no model on the page');
});

// Runs last: every body the tests above produced.
test('no provider or model names in any playground response', () => {
  assert.ok(SEEN_BODIES.length > 50, `checked ${SEEN_BODIES.length} responses`);
  for (const body of SEEN_BODIES) assert.doesNotMatch(body, FORBIDDEN_NAMES, body.slice(0, 200));
});
