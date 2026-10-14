/**
 * P11: customer sanctions screening (lib/screening.mjs, lib/sanctionsEu.mjs,
 * the hooks in every payment path, /screening).
 *
 * Covered: a sanctioned wallet is refused before any 402 or settlement (per
 * call on MCP, A2A and REST; A2A jobs and quotes; Foundry; watchlists); a
 * clean wallet passes; a cached screening adds under 50 ms; screening that
 * cannot run fails closed and is not cached; the refusal record is hashed;
 * screening never touches the free tier; the EU list's addresses are
 * extracted and synced, delisted ones removed, and an operator dismissal
 * stops a match.
 *
 * Run with: node --test tests/screening.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, pgRest } from './helpers/pgrest.mjs';

delete process.env.X402_PAY_TO_ADDRESS;
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

const scr = await import('../lib/screening.mjs');
const eu = await import('../lib/sanctionsEu.mjs');
const { handleScreeningCommand } = await import('../lib/screeningAdmin.mjs');
const mcp = await import('../api/mcp.mjs');
const { default: mcpHandler, __setX402GateForTests } = mcp;
const { default: a2aHandler } = await import('../api/a2a.mjs');
const { default: preflightRest } = await import('../api/preflight.mjs');
const wl = await import('../lib/watchlists.mjs');
const { payerHash } = await import('../lib/a2aJobs/jobs.mjs');

const SUP = { supUrl: 'https://supabase.test', supKey: 'k' };
const BAD = '0x' + '0b'.repeat(20);
const BAD_EU = '0x' + 'e0'.repeat(20);
const CLEAN = '0x' + 'c1'.repeat(20);

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, SUPABASE_URL: SUP.supUrl, SUPABASE_SERVICE_ROLE_KEY: SUP.supKey, TELEMETRY_IP_SALT: 'screening-test-salt' };
  scr.__clearScreeningCache();
  globalThis.fetch = ORIGINAL_FETCH;
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; __setX402GateForTests(null); });

async function world() {
  const db = await makeDb(['20261021120000_pg1_autonomy_log.sql', '20261027120000_pg1_screening.sql']);
  await db.exec(`create table sanctioned_wallets (address_normalized text, sdn_uid text, sdn_name text, currency text, programs text[], updated_at timestamptz default now());
    insert into sanctioned_wallets (address_normalized, sdn_uid, sdn_name, currency) values ('${BAD.toLowerCase()}', '12345', 'Listed Entity', 'ETH');
    insert into pg1_eu_sanctioned_wallets (address_normalized, address, eu_reference, entity_name) values ('${BAD_EU.toLowerCase()}', '${BAD_EU}', 'EU.1.2', 'Listed EU Entity');`);
  const calls = [];
  const fetchImpl = pgRest(db, { calls, passthrough: async () => new Response('{}', { status: 404 }) });
  globalThis.fetch = fetchImpl;
  return { db, calls, fetchImpl };
}

// A verified x402 payment from `payer`; settles are recorded.
function verifiedPayment(payer, settles) {
  __setX402GateForTests(async () => ({ authorized: true, payer, settle: async () => { settles.push(payer); return { success: true, transaction: '0xt' }; }, settlementFailurePaymentRequired: async (m) => ({ error: m }) }));
}

const makeRes = () => ({ statusCode: null, body: null, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, end() { return this; } });

test('sources are cited: OFAC SDN and the EU consolidated list with its official URL', () => {
  assert.match(scr.SCREENING_SOURCES.ofac.url, /^https:\/\/sanctionslist\.ofac\.treas\.gov\//);
  assert.match(scr.SCREENING_SOURCES.eu.url, /^https:\/\/webgate\.ec\.europa\.eu\/fsd\/fsf\/public\/files\/xmlFullSanctionsList/);
  assert.match(scr.SCREENING_SOURCES.eu.licence, /2011\/833\/EU/);
});

test('a sanctioned wallet is refused before any 402 or settlement: MCP, A2A and REST per-call payments', async () => {
  const w = await world();
  const settles = [];
  verifiedPayment(BAD, settles);
  const m = makeRes();
  await mcpHandler({ method: 'POST', headers: { 'x-forwarded-for': '100.64.1.1', 'payment-signature': 'x' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_cve_details', arguments: { cve_id: 'CVE-2021-44228' } } } }, m);
  const body = JSON.parse(m.body.result.content[0].text);
  assert.equal(body.code, 'payer_refused');
  assert.equal(m.body.result.structuredContent, undefined, 'no payment request');
  assert.equal(m.headers['payment-required'], undefined, 'no 402 header');

  const a = makeRes();
  await a2aHandler({ method: 'POST', headers: { 'x-forwarded-for': '100.64.1.2', 'payment-signature': 'x' }, query: {}, body: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: 'm', parts: [{ kind: 'data', data: { skill: 'get_cve_details', arguments: { cve_id: 'CVE-2021-44228' } } }] } } } }, a);
  assert.equal(a.body.error.data.code, 'payer_refused');

  const r = makeRes();
  await preflightRest({ method: 'POST', headers: { 'x-forwarded-for': '100.64.1.3', 'payment-signature': 'x' }, body: { action: 'open', target: 'example.com' } }, r);
  assert.equal(r.statusCode, 403);
  assert.equal(r.headers['payment-required'], undefined);

  assert.deepEqual(settles, [], 'nothing was settled');
  assert.ok(!w.calls.some((c) => c.url.includes('free_tier_usage')), 'screening never touches the free tier');
  const events = (await w.db.query('select * from pg1_screening_events')).rows;
  assert.ok(events.length >= 1);
  for (const e of events) {
    assert.match(e.wallet_hash, /^[0-9a-f]{32}$/);
    assert.deepEqual(e.lists, ['ofac']);
    assert.ok(!JSON.stringify(e).toLowerCase().includes(BAD.slice(2)), 'no raw wallet in the record');
  }
  await new Promise((done) => setTimeout(done, 100));
});

test('a named payer is screened before a quote: no quote, no job row for a sanctioned wallet (EU list match)', async () => {
  const w = await world();
  const a = makeRes();
  await a2aHandler({ method: 'POST', headers: { 'x-forwarded-for': '100.64.1.4' }, query: {}, body: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: 'm', metadata: { 'pg1.payer': BAD_EU }, parts: [{ kind: 'data', data: { skill: 'submit_job', arguments: { job_type: 'batch_wallet_screen', input: { addresses: [CLEAN] } } } }] } } } }, a);
  assert.equal(a.body.error.data.code, 'payer_refused');
  assert.match(a.body.error.message, /Nothing was charged/);
  const events = (await w.db.query('select lists, eu_references from pg1_screening_events')).rows;
  assert.deepEqual(events[0].lists, ['eu']);
  assert.deepEqual(events[0].eu_references, ['EU.1.2']);
  await new Promise((done) => setTimeout(done, 100));
});

test('a clean wallet passes and is charged once; the deps adapters agree for jobs, Foundry and watchlists', async () => {
  await world();
  const settles = [];
  verifiedPayment(CLEAN, settles);
  const r = makeRes();
  const original = mcp.STANDARD_TOOL_HANDLERS.preflight_check;
  mcp.STANDARD_TOOL_HANDLERS.preflight_check = async () => ({ decision: 'no_flags', status: 'no_flags', reasons: [], checks: [] });
  try {
    await preflightRest({ method: 'POST', headers: { 'x-forwarded-for': '100.64.1.5', 'payment-signature': 'x' }, body: { action: 'open', target: 'example.com' } }, r);
  } finally {
    mcp.STANDARD_TOOL_HANDLERS.preflight_check = original;
  }
  assert.equal(r.statusCode, 200);
  assert.deepEqual(settles, [CLEAN]);

  const screen = scr.payerScreen({ ...SUP, fetchImpl: globalThis.fetch });
  const ok = await screen(CLEAN);
  assert.deepEqual([ok.allowed, ok.refused], [true, false]);
  const no = await screen(BAD);
  assert.deepEqual([no.allowed, no.refused, no.reason], [false, true, 'payer_screening']);
  // Watchlists: a refused wallet is never charged (lib/watchlists.mjs createWatchlist).
  const wsettles = [];
  const refused = await wl.createWatchlist({ items: [{ kind: 'domain', target: 'example.com' }], webhook_url: 'https://hooks.example.com/x' }, {
    store: { activeForSubscriber: async () => 0, create: async () => { throw new Error('must not store'); } },
    gate: async () => ({ authorized: true, payer: BAD, settle: async () => { wsettles.push(1); return { success: true }; } }),
    subscriberHash: payerHash, screen, env: { PG1_WATCHLIST_SECRET: 'w'.repeat(40) }, lookup: async () => [{ address: '93.184.216.34' }]
  }).catch((e) => e);
  assert.equal(refused.status, 403);
  assert.deepEqual(wsettles, []);
  await new Promise((done) => setTimeout(done, 100));
});

test('a cached screening adds under 50 ms and makes no request', async () => {
  const w = await world();
  const slow = async (url, o) => { await new Promise((r) => setTimeout(r, 120)); return w.fetchImpl(url, o); };
  let requests = 0;
  const counting = async (url, o) => { requests++; return slow(url, o); };
  const t0 = performance.now();
  const first = await scr.screenPayer(CLEAN, { ...SUP, fetchImpl: counting });
  const firstMs = performance.now() - t0;
  assert.equal(first.allowed, true);
  assert.ok(firstMs >= 100, 'the first screening did the lookups');
  const before = requests;
  const times = [];
  for (let i = 0; i < 20; i++) {
    const s = performance.now();
    const r = await scr.screenPayer(CLEAN, { ...SUP, fetchImpl: counting });
    times.push(performance.now() - s);
    assert.equal(r.cached, true);
  }
  assert.equal(requests, before, 'no request on a cache hit');
  assert.ok(Math.max(...times) < 50, `cached screening took ${Math.max(...times).toFixed(1)} ms`);
  // A refusal is cached too (24 hours).
  await scr.screenPayer(BAD, { ...SUP, fetchImpl: w.fetchImpl });
  assert.equal((await scr.screenPayer(BAD, { ...SUP, fetchImpl: async () => { throw new Error('no fetch on a hit'); } })).refused, true);
  assert.equal((await scr.screenPayer(CLEAN, { ...SUP, fetchImpl: counting, now: Date.now() + scr.SCREENING_CACHE_MS + 1000 })).cached, false, 'expires after 24 hours');
});

test('screening that cannot run fails closed: no payment taken, not cached, retry hint', async () => {
  const down = async () => new Response('{}', { status: 500 });
  const r = await scr.screenPayer(CLEAN, { ...SUP, fetchImpl: down });
  assert.deepEqual([r.allowed, r.refused, r.unavailable], [false, false, true]);
  assert.match(r.message, /Nothing was charged/);
  assert.equal((await scr.screenPayer(CLEAN, { ...SUP, fetchImpl: down })).cached, false);
  const emptyList = async (url) => new Response(url.includes('order=updated_at') ? '[]' : '[]');
  assert.equal((await scr.screenPayer(CLEAN, { ...SUP, fetchImpl: emptyList })).unavailable, true, 'an empty OFAC list is not a clean answer');
  await assert.rejects(scr.payerScreen({ ...SUP, fetchImpl: down })(CLEAN), (e) => e.screeningUnavailable && e.status === 503);
  assert.equal((await scr.screenPayer('', { ...SUP, fetchImpl: down })).refused, true, 'a payment with no wallet cannot be screened');

  globalThis.fetch = down;
  const settles = [];
  verifiedPayment(CLEAN, settles);
  const m = makeRes();
  await mcpHandler({ method: 'POST', headers: { 'x-forwarded-for': '100.64.1.6', 'payment-signature': 'x' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_cve_details', arguments: { cve_id: 'CVE-2021-44228' } } } }, m);
  assert.equal(JSON.parse(m.body.result.content[0].text).code, 'screening_unavailable');
  assert.equal(m.headers['retry-after'], '60');
  assert.deepEqual(settles, []);
  await new Promise((done) => setTimeout(done, 100));
});

function euXml(extra = '') {
  const filler = Array.from({ length: 120 }, (_, i) => `<sanctionEntity euReferenceNumber="EU.9.${i}"><nameAlias wholeName="Entity ${i}"/><remark>Registration number 1A2B3C4D5E6F7G8H9J1K2L3M4N5P${i}</remark></sanctionEntity>`).join('\n');
  return `<?xml version="1.0"?><export>${filler}\n${extra}</export>`;
}

test('EU list: addresses are extracted with their reference, ordinary identifiers are not, the sync replaces the table, and a dismissal stops a match', async () => {
  const xml = euXml(`<sanctionEntity euReferenceNumber="EU.7.77"><nameAlias wholeName="Listed &amp; Co"/><remark>Digital currency address - ETH ${CLEAN.toUpperCase().replace('0X', '0x')}; XBT bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh</remark></sanctionEntity>`);
  const found = eu.extractEuWallets(xml);
  assert.deepEqual(found.map((f) => f.eu_reference), ['EU.7.77', 'EU.7.77']);
  assert.equal(found[0].entity_name, 'Listed & Co');
  assert.ok(!found.some((f) => /^1A2B/.test(f.address)), 'a base58-looking registration number is not an address');

  const w = await world();
  const out = await eu.syncEuList({ ...SUP, fetchImpl: async (url, o) => (String(url).startsWith('https://webgate.ec.europa.eu/') ? new Response(xml) : w.fetchImpl(url, o)) });
  assert.deepEqual([out.ok, out.wallets], [true, 2]);
  const rows = (await w.db.query('select address_normalized from pg1_eu_sanctioned_wallets order by 1')).rows.map((r) => r.address_normalized);
  assert.ok(!rows.includes(BAD_EU.toLowerCase()), 'the delisted seed row was removed');
  assert.ok(rows.includes(CLEAN.toLowerCase()));
  assert.equal((await scr.screenPayer(CLEAN, { ...SUP, fetchImpl: w.fetchImpl })).refused, true);

  const partial = await eu.syncEuList({ ...SUP, fetchImpl: async (url) => (String(url).startsWith('https://webgate') ? new Response('<export><sanctionEntity euReferenceNumber="x"/></export>') : w.fetchImpl(url)) });
  assert.equal(partial.ok, false, 'a partial file never replaces the list');

  assert.match((await handleScreeningCommand({ text: `/screening dismiss ${CLEAN} too short`, ...SUP, fetchImpl: w.fetchImpl, isOperator: false })).reply, /operator only/);
  const d = await handleScreeningCommand({ text: `/screening dismiss ${CLEAN} extraction error checked against EU.7.77`, ...SUP, fetchImpl: w.fetchImpl, isOperator: true });
  assert.match(d.reply, /Dismissed/);
  assert.equal((await scr.screenPayer(CLEAN, { ...SUP, fetchImpl: w.fetchImpl })).allowed, true);
  assert.match((await handleScreeningCommand({ text: `/screening dismiss ${BAD} not on the EU list`, ...SUP, fetchImpl: w.fetchImpl, isOperator: true })).reply, /OFAC entries cannot be dismissed/);
  const list = await handleScreeningCommand({ text: '/screening', ...SUP, fetchImpl: w.fetchImpl, isOperator: true });
  assert.match(list.reply, /SANCTIONS SCREENING/);
  assert.ok(!list.reply.includes(CLEAN.slice(2)), 'no raw wallet in the operator view');
});
