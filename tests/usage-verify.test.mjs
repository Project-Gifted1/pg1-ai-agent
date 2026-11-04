/**
 * /usage verify (lib/usageVerify.mjs) and usage figures in conversation
 * (lib/usageClaims.mjs, api/chat.mjs):
 *   - telemetry vs server request counts per day: matching, a gap over 5%
 *     flagged "telemetry may be dropping rows", insert failures from
 *     pg1_errors
 *   - revenue vs chain: matched, an on-chain transfer with no settled row,
 *     a settled row with no transfer, a transfer not yet final never
 *     counted as received
 *   - a source that cannot be read is named and the rest still runs, with
 *     no estimate in its place; licence sales paused / not configured
 *   - the verdict ("Figures verified" or what does not match), never "safe"
 *   - /usage verify end to end (operator only, read-only) and /pdf usage verify
 *   - a plain "how many lookups a day" question, a relayed "40,000 lookups
 *     a day, $400 daily" against 542 real calls a week and 0 settled, a
 *     relayed weekly-return promise, an explicit projection request, and a
 *     reply that promises a return
 * Run with: node --test tests/usage-verify.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyUsage, verifyRange, verifyReport, verifyCardView, verifyVerdict, matchSettlements, compareTraffic, gapShare,
  VERIFY_ROUTES, TX_LINK_BASE
} from '../lib/usageVerify.mjs';
import {
  extractUsageClaims, checkUsageClaims, claimCheckNote, detectPayoutPromise, isUsageQuestion, wantsVerify, wantsProjection,
  prepareUsageTurn, usageTurnNotes, ownReturnPromiseNote, usageFactsBlock, PAYOUT_WARNING
} from '../lib/usageClaims.mjs';
import { aggregateUsage, usageDayOf } from '../lib/usageStats.mjs';
import { handlePdfCommand } from '../lib/pdf/chat.mjs';
import { renderPdf } from '../lib/pdf/render.mjs';
// No "safe" wording at all in what these reports and checks write.
const unnegatedSafe = (text) => String(text).match(/\bsafe(?:ty|ly)?\b/gi) || [];

// 4 Nov 2026, 12:00 UTC (Ireland is on GMT): the window is 29 Oct – 4 Nov.
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const SUP = 'https://supabase.test';
const PAY_TO = '0x' + 'ab'.repeat(20);
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ENV = {
  SUPABASE_URL: SUP, SUPABASE_SERVICE_ROLE_KEY: 'service-role-verify',
  VERCEL_TOKEN: 'vercel-token-test', VERCEL_TEAM_ID: 'team_TEST123', PG1_VERCEL_PROJECT_ID: 'prj_TEST123',
  X402_PAY_TO_ADDRESS: PAY_TO, ALCHEMY_API_KEY: 'alchemy-test-key'
};
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const at = (day, hour = 10, min = 0) => new Date(Date.UTC(2026, 9, 29 + day, hour, min)).toISOString();

// Telemetry: `perDay[i]` request rows on day i (all /api/mcp), plus extra
// routes; settled rows as given.
function world({ perDay = [100, 100, 100, 100, 100, 100, 50], platformPerDay = null, settled = [], transfers = [], finalized = 1_000_000, failures = [], vercelStatus = 200, chainDown = false, gumroad = null, env = ENV } = {}) {
  const requestRows = [];
  perDay.forEach((n, d) => {
    for (let i = 0; i < n; i++) requestRows.push({ created_at: at(d, 9, i % 60), event_type: i % 3 ? 'tool_call' : 'mcp_request', endpoint: '/api/mcp' });
    requestRows.push({ created_at: at(d, 11), event_type: 'tool_call', endpoint: '/api/ioc' });
  });
  const platform = platformPerDay || perDay;
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body });
    if (u.startsWith(`${SUP}/rest/v1/agent_telemetry`)) {
      const range = (opts.headers && opts.headers.Range) || '0-999';
      const offset = Number(range.split('-')[0]);
      const rows = u.includes('event_type=eq.settlement') ? settled : requestRows;
      return Response.json(rows.slice(offset, offset + 1000));
    }
    if (u.startsWith(`${SUP}/rest/v1/pg1_errors`)) return Response.json(failures);
    if (u.startsWith('https://api.vercel.com/v2/observability/query')) {
      if (vercelStatus !== 200) return new Response('{"error":"forbidden"}', { status: vercelStatus });
      const body = JSON.parse(opts.body);
      assert.equal(body.metric, 'vercel.request.count');
      assert.deepEqual(body.groupBy, ['request_path', 'request_method']);
      assert.equal(body.bucketTimezone, 'Europe/Dublin');
      const data = [];
      platform.forEach((n, d) => {
        const ts = `2026-${d + 29 > 31 ? '11' : '10'}-${String(d + 29 > 31 ? d - 2 : d + 29).padStart(2, '0')}T00:00:00.000Z`;
        data.push({ timestamp: ts, request_path: '/api/mcp', request_method: 'POST', vercel_request_count_sum: n });
        data.push({ timestamp: ts, request_path: '/api/mcp', request_method: 'GET', vercel_request_count_sum: 900 }); // health checks: not counted
        data.push({ timestamp: ts, request_path: '/api/ioc', request_method: 'GET', vercel_request_count_sum: 1 });
        data.push({ timestamp: ts, request_path: '/api/ioc', request_method: 'HEAD', vercel_request_count_sum: 4 }); // not recorded
      });
      return Response.json({ data });
    }
    if (u.startsWith('https://base-mainnet.g.alchemy.com/v2/')) {
      if (chainDown) return new Response('bad gateway', { status: 502 });
      const req = JSON.parse(opts.body);
      if (req.method === 'eth_getBlockByNumber') return Response.json({ jsonrpc: '2.0', id: 1, result: { number: '0x' + finalized.toString(16) } });
      if (req.method === 'alchemy_getAssetTransfers') {
        const p = req.params[0];
        assert.equal(p.toAddress, PAY_TO);
        assert.deepEqual(p.contractAddresses, [USDC]);
        const list = [...transfers].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map((t) => ({
          blockNum: '0x' + t.block.toString(16), hash: t.hash, from: '0x' + '11'.repeat(20), to: PAY_TO, value: t.usd, asset: 'USDC',
          rawContract: { value: '0x' + Math.round(t.usd * 1e6).toString(16), address: USDC.toLowerCase(), decimal: '0x6' },
          metadata: { blockTimestamp: t.at }
        }));
        list.push({ blockNum: '0x1', hash: hash(999), rawContract: { value: '0x2710', address: USDC.toLowerCase() }, metadata: { blockTimestamp: '2026-09-01T00:00:00.000Z' } });
        return Response.json({ jsonrpc: '2.0', id: 1, result: { transfers: list } });
      }
    }
    if (u.startsWith('https://api.gumroad.com/v2/sales')) return gumroad ? gumroad(u) : new Response('no', { status: 500 });
    throw new Error(`unexpected call ${u}`);
  };
  return { fetchImpl, calls, env };
}

const writes = (calls) => calls.filter((c) => c.method !== 'GET' && !c.url.includes('/v2/observability/query') && !c.url.includes('alchemy.com'));

test('the window is the last 7 Ireland days, read up to a few minutes back', () => {
  const r = verifyRange(NOW);
  assert.equal(r.days.length, 7);
  assert.equal(r.days[0], '2026-10-29');
  assert.equal(r.days[6], '2026-11-04');
  assert.equal(r.to, '2026-11-04T11:55:00.000Z');
  assert.equal(usageDayOf(Date.parse('2026-10-28T23:30:00Z')), '2026-10-28');
});

test('matching data: telemetry equals the server per day, every settled row has its final transfer: "Figures verified"', async () => {
  const settled = [{ created_at: at(1, 14, 0), endpoint: '/api/mcp', tool_name: 'get_cve_details', amount_usd: 0.01 }, { created_at: at(3, 9, 30), endpoint: '/api/a2a', tool_name: 'job.batch_wallet_screen', amount_usd: 0.5 }];
  const transfers = [{ at: at(1, 13, 59), usd: 0.01, block: 900_000, hash: hash(1) }, { at: at(3, 9, 31), usd: 0.5, block: 900_100, hash: hash(2) }];
  const w = world({ settled, transfers });
  const r = await verifyUsage({ env: w.env, now: NOW, fetchImpl: w.fetchImpl });
  assert.equal(r.verdict.status, 'verified');
  assert.equal(r.verdict.line, 'Figures verified');
  assert.equal(r.traffic.days.length, 7);
  assert.ok(r.traffic.days.every((d) => !d.flagged && d.telemetry === d.platform), 'GET health checks and HEAD are not counted on the server side');
  assert.equal(r.traffic.telemetry_total, 657);
  assert.equal(r.revenue.settled_count, 2);
  assert.equal(r.revenue.received_count, 2);
  assert.equal(r.revenue.received_usd, 0.51);
  assert.equal(r.revenue.matched.length, 2);
  assert.deepEqual(r.revenue.unmatched_settled, []);
  assert.deepEqual(r.revenue.unmatched_transfers, []);
  assert.equal(r.licence.status, 'not_configured');
  const md = verifyReport(r);
  assert.match(md, /^\*\*Figures verified\.\*\*/);
  assert.match(md, /Licence sales are paused and not configured for reading/);
  assert.ok(md.includes(`${TX_LINK_BASE}${hash(1)}`), 'each transfer links to its transaction');
  assert.match(md, /Received on chain \(final\): 2 \(0\.51 USD\)/);
  assert.deepEqual(writes(w.calls), [], 'read-only: nothing was written, paid or spent');
  assert.deepEqual(unnegatedSafe(md), []);
  const card = verifyCardView(r);
  assert.deepEqual(card.sections.map((s) => s.id), ['verdict', 'traffic', 'revenue', 'licence']);
  assert.equal(card.sections[0].groups[0].rows[0].value, 'Figures verified');
  const tx = card.sections[2].groups[1].rows[0];
  assert.equal(tx.href, `${TX_LINK_BASE}${hash(2)}`);
  assert.match(tx.sub, /matched/);
  assert.deepEqual(unnegatedSafe(JSON.stringify(card)), []);
});

test('a telemetry gap over 5% is flagged "telemetry may be dropping rows", with logged insert failures', async () => {
  const w = world({ perDay: [100, 100, 80, 100, 100, 100, 50], platformPerDay: [100, 100, 100, 100, 100, 103, 50], failures: [{ reason: 'telemetry_insert_failed', count: 3, first_seen: at(2, 8), last_seen: at(2, 9) }] });
  const r = await verifyUsage({ env: w.env, now: NOW, fetchImpl: w.fetchImpl });
  const flagged = r.traffic.days.filter((d) => d.flagged);
  assert.deepEqual(flagged.map((d) => d.day), ['2026-10-31'], 'a 3% gap is not flagged, a 20% gap is');
  assert.equal(flagged[0].telemetry, 81);
  assert.equal(flagged[0].platform, 101);
  assert.equal(r.verdict.status, 'mismatch');
  assert.match(r.verdict.line, /^Does not match: Traffic: telemetry and server counts differ by more than 5% on 31 Oct \(\/api\/mcp\); telemetry may be dropping rows\. Telemetry: 3 logged insert failures \(telemetry_insert_failed\)/);
  const md = verifyReport(r);
  assert.match(md, /\| 31 Oct \| 81 \| 101 \| 19\.8% \(flagged: telemetry may be dropping rows\) \|/);
  assert.match(md, /telemetry_insert_failed ×3/);
  const card = verifyCardView(r);
  const day = card.sections[1].groups[1].rows.find((x) => x.label === '31 Oct');
  assert.equal(day.value, '81 / 101');
  assert.equal(day.warn, true);
  assert.match(day.sub, /telemetry may be dropping rows/);
});

test('revenue: an on-chain transfer with no settled row, a settled row with no transfer, and a transfer not yet final', async () => {
  const settled = [
    { created_at: at(1, 14, 0), endpoint: '/api/mcp', tool_name: 'get_cve_details', amount_usd: 0.01 },
    { created_at: at(2, 10, 0), endpoint: '/api/mcp', tool_name: 'get_cve_details', amount_usd: 0.01 } // nothing on chain
  ];
  const transfers = [
    { at: at(1, 14, 2), usd: 0.01, block: 900_000, hash: hash(1) },
    { at: at(4, 16, 0), usd: 2, block: 950_000, hash: hash(3) }, // no settled row
    { at: at(6, 11, 50), usd: 0.01, block: 1_200_000, hash: hash(4) } // above the finalized block
  ];
  const w = world({ settled, transfers });
  const r = await verifyUsage({ env: w.env, now: NOW, fetchImpl: w.fetchImpl });
  assert.equal(r.revenue.settled_count, 2);
  assert.equal(r.revenue.received_count, 2, 'the transfer that is not final is not counted as received');
  assert.equal(r.revenue.received_usd, 2.01);
  assert.equal(r.revenue.pending.length, 1);
  assert.equal(r.revenue.matched.length, 1);
  assert.equal(r.revenue.unmatched_settled.length, 1);
  assert.equal(r.revenue.unmatched_settled[0].created_at, undefined);
  assert.equal(r.revenue.unmatched_transfers.map((t) => t.hash)[0], hash(3));
  assert.equal(r.verdict.status, 'mismatch');
  assert.match(r.verdict.line, /1 settled payment in telemetry \(0\.01 USD\) with no matching transfer on chain/);
  assert.match(r.verdict.line, /1 on-chain transfer \(2\.00 USD\) with no settled row in telemetry/);
  const md = verifyReport(r);
  assert.match(md, /Awaiting finality \(not counted as received\): 1/);
  assert.ok(!md.includes(hash(4)), 'a transfer that is not final is not listed as received');
  assert.match(md, /\| 2\.00 USD \| \[0x00000000…000003\]\(https:\/\/basescan\.org\/tx\/0x0{63}3\) \| no settled row \|/);
});

test('matching is one to one, by exact amount and time within 15 minutes', () => {
  const t = (n, iso, usd) => ({ hash: hash(n), at: iso, raw: String(Math.round(usd * 1e6)), amount_usd: usd, final: true });
  const m = matchSettlements(
    [{ at: '2026-11-01T10:00:00Z', amount_usd: 0.01 }, { at: '2026-11-01T10:01:00Z', amount_usd: 0.01 }, { at: '2026-11-01T12:00:00Z', amount_usd: 0.05 }],
    [t(1, '2026-11-01T10:00:30Z', 0.01), t(2, '2026-11-01T12:30:00Z', 0.05), t(3, '2026-11-01T12:01:00Z', 0.5)]
  );
  assert.equal(m.matched.length, 1);
  assert.equal(m.unmatchedSettled.length, 2, 'one transfer cannot match two rows; 30 minutes is too far');
  assert.deepEqual(m.unmatchedTransfers.map((x) => x.hash), [hash(2), hash(3)]);
  assert.equal(gapShare(95, 100), 0.05);
  assert.equal(gapShare(0, 0), 0);
  assert.equal(compareTraffic(['2026-11-01'], null, null)[0].telemetry, null);
});

test('an unreadable source is named, the rest still runs, and no figure is filled in', async () => {
  const settled = [{ created_at: at(1, 14, 0), endpoint: '/api/mcp', tool_name: 'x', amount_usd: 0.01 }];
  const w = world({ settled, vercelStatus: 403, chainDown: true });
  const r = await verifyUsage({ env: w.env, now: NOW, fetchImpl: w.fetchImpl });
  assert.equal(r.sources.platform.ok, false);
  assert.equal(r.sources.platform.reason, 'The platform API answered HTTP 403');
  assert.equal(r.sources.chain.ok, false);
  assert.equal(r.sources.telemetry.ok, true);
  assert.equal(r.traffic.platform_total, null);
  assert.ok(r.traffic.days.every((d) => d.platform === null && d.gap === null && !d.flagged));
  assert.equal(r.revenue.settled_count, 1);
  assert.equal(r.revenue.received_count, null);
  assert.equal(r.revenue.matched, null);
  assert.equal(r.verdict.status, 'incomplete');
  assert.match(r.verdict.line, /^Not fully verified: Server request counts \(Vercel\), Chain \(USDC on Base\) could not be read/);
  const md = verifyReport(r);
  assert.match(md, /Server request counts \(Vercel\): could not be read \(The platform API answered HTTP 403\)/);
  assert.match(md, /\| 29 Oct \| 101 \| not read \| — \|/);
  assert.match(md, /Received on chain \(final\): not read/);
  assert.match(md, /a source that could not be read shows no figure, never an estimate/);

  // Missing settings name the setting; telemetry missing too.
  const bare = world({ env: { X402_PAY_TO_ADDRESS: PAY_TO } });
  const r2 = await verifyUsage({ env: bare.env, now: NOW, fetchImpl: bare.fetchImpl });
  assert.equal(r2.sources.telemetry.reason, 'the database is not configured');
  assert.match(r2.sources.platform.reason, /VERCEL_TOKEN/);
  assert.match(r2.sources.chain.reason, /ALCHEMY_API_KEY/);
  assert.equal(r2.revenue, null);
  assert.match(verifyReport(r2), /Neither telemetry nor the chain could be read, so no revenue figure is shown/);
  assert.deepEqual(bare.calls, [], 'nothing is called without its settings');
});

test('licence sales: counted for the configured products when readable; a failing store is named', async () => {
  const gumroad = (u) => Response.json({ success: true, sales: [
    { created_at: at(2, 10), price: 4900, currency: 'usd', product_id: 'p1' },
    { created_at: at(3, 10), price: 4900, currency: 'usd', refunded: true },
    { created_at: '2026-10-01T10:00:00Z', price: 4900, currency: 'usd' }
  ] });
  const w = world({ gumroad, env: { ...ENV, GUMROAD_PRODUCT_ID: 'p1', GUMROAD_ACCESS_TOKEN: 'gr-token' } });
  const r = await verifyUsage({ env: w.env, now: NOW, fetchImpl: w.fetchImpl });
  assert.equal(r.licence.status, 'read');
  assert.equal(r.licence.count, 1);
  assert.match(verifyReport(r), /1 sale across 1 product \(49\.00 USD\)/);
  const bad = world({ env: { ...ENV, GUMROAD_PRODUCT_ID: 'p1', GUMROAD_ACCESS_TOKEN: 'gr-token' } });
  const r2 = await verifyUsage({ env: bad.env, now: NOW, fetchImpl: bad.fetchImpl });
  assert.equal(r2.sources.licence.ok, false);
  assert.equal(r2.verdict.status, 'incomplete');
  assert.match(verifyReport(r2), /Licence sales could not be read \(The licence store answered HTTP 500\)/);
});

test('/pdf usage verify makes the verify report into a PDF; /pdf usage still the usage report', async () => {
  const asked = [];
  const out = await handlePdfCommand({ text: '/pdf usage verify', isOperator: true, supUrl: null, supKey: null, usageMarkdown: async (p) => { asked.push(p); return null; } });
  assert.deepEqual(asked, ['verify']);
  assert.match(out.reply, /could not be read/);
  // The full report (tables, transaction links) lays out as a PDF.
  const settled = [{ created_at: at(1, 14, 0), endpoint: '/api/mcp', tool_name: 'x', amount_usd: 0.01 }];
  const w = world({ settled, transfers: [{ at: at(1, 14, 1), usd: 0.01, block: 900_000, hash: hash(1) }, { at: at(2, 9), usd: 2, block: 900_001, hash: hash(2) }], perDay: [100, 100, 60, 100, 100, 100, 50], platformPerDay: [100, 100, 100, 100, 100, 100, 50] });
  const md = verifyReport(await verifyUsage({ env: w.env, now: NOW, fetchImpl: w.fetchImpl }));
  const pdf = await renderPdf({ title: 'PG1 usage verify', subtitle: 'Last 7 days', markdown: md });
  assert.ok(pdf.pages >= 1);
  assert.ok(pdf.bytes.length > 1000);
});

// ---------------------------------------------------------------------------
// Figures in conversation.

// 542 real tool calls in the last 7 days and nothing settled.
function fixtureRows(now = Date.now()) {
  const rows = [];
  for (let i = 0; i < 542; i++) {
    rows.push({ created_at: new Date(now - 3600_000 - (i % 6) * 86400_000 - i * 1000).toISOString(), event_type: 'tool_call', endpoint: '/api/mcp', tool_name: 'check_domain_age', payment_type: 'free', status: 'ok', client_name: null, caller_hash: (i % 9).toString(16).repeat(32), is_fixture: false, mcp_method: null, requested_tool: null, amount_usd: null, caller_kind: null });
  }
  return rows;
}
const fixtureStats = (now = NOW) => ({ ...aggregateUsage(fixtureRows(now), { period: '7d', now }), truncated: false, schema: 'current' });

test('claims: "40,000 lookups a day, $400 daily" against 542 real calls a week and 0 settled: neither matches', () => {
  const stats = fixtureStats();
  assert.equal(stats.summary.real_tool_calls, 542);
  assert.equal(stats.payments.revenue_usd, 0);
  const claims = extractUsageClaims('PG1 is doing 40,000 lookups a day, $400 daily, and growing.');
  assert.deepEqual(claims.map((c) => [c.kind, c.value, c.unit]), [['calls', 40000, 'day'], ['revenue', 400, 'day']]);
  const rows = checkUsageClaims(claims, stats);
  assert.deepEqual(rows.map((r) => r.matches), [false, false]);
  assert.equal(rows[0].real, 77.43);
  assert.equal(rows[1].real, 0);
  const note = claimCheckNote(rows, { from: 'grok' });
  assert.match(note, /\| 40,000 lookups a day \| 77\.4 a day \(real tool calls, the last 7 days: 542 in 7 days, 77\.4 a day on average\) \| \*\*no, does not match\*\* \|/);
  assert.match(note, /\| 400\.00 USD revenue a day \| 0\.00 USD a day \(settled x402 revenue/);
  assert.match(note, /2 of 2 figures do not match the report/);
  assert.doesNotMatch(note, /\$\d/, 'no "$" before digits in a reply');
  // A matching claim, a price that is not a claim, a report that could not be read.
  assert.equal(checkUsageClaims(extractUsageClaims('542 lookups a week'), stats)[0].matches, true);
  assert.deepEqual(extractUsageClaims('The price is 0.01 USD per call.'), []);
  assert.equal(checkUsageClaims(claims, null)[0].matches, null);
});

test('payout promises: detected in other text; PG1\'s own reply never makes one', () => {
  for (const t of ['Holders get a guaranteed weekly return from PG1 fees.', 'Backers will receive 50 USD per week from the lookups.', 'Join and earn 5% weekly returns.', 'We offer a revenue share to early supporters.']) {
    assert.equal(detectPayoutPromise(t).found, true, t);
  }
  for (const t of ['Usage grew 10% per week.', 'The x402 price is 0.01 USD per call.', 'PG1 made 0.00 USD this week.']) assert.equal(detectPayoutPromise(t).found, false, t);
  assert.equal(ownReturnPromiseNote('PG1 cannot support a weekly return. Usage grew 10% per week.'), '');
  assert.match(ownReturnPromiseNote('You will earn 50 USD per week from this.'), /^\*\*Correction: PG1 does not promise or imply any return, payout or profit share/);
});

test('plain questions: what counts as a usage question, a verify request and a projection request', () => {
  for (const q of ['how many lookups a day?', 'What is our revenue this week?', 'any payments this week?', 'how much have we earned?', 'How many callers used PG1?']) assert.equal(isUsageQuestion(q), true, q);
  for (const q of ["What was Apple's revenue last quarter?", 'check 0x' + '1'.repeat(40) + ' payments?', '/usage', 'hello']) assert.equal(isUsageQuestion(q), false, q);
  assert.equal(wantsVerify('is that real?'), true);
  assert.equal(wantsVerify('how many lookups a day?'), false);
  assert.equal(wantsProjection('project our revenue for next month at this rate'), true);
  assert.equal(wantsProjection('how many lookups a day?'), false);
  const block = usageFactsBlock(fixtureStats());
  assert.match(block, /Real tool calls \(lookups\): 542 in the period/);
  assert.match(block, /settled revenue: 0\.00 USD/);
  assert.match(usageFactsBlock(null), /could not be read right now\. Give no usage, traffic or revenue figure/);
});

test('prepareUsageTurn: operator only, verify on "is that real", nothing for a guest', async () => {
  let verifies = 0;
  const deps = { getStats: async () => fixtureStats(), verify: async () => { verifies++; return { verdict: { status: 'verified', line: 'Figures verified' } }; } };
  assert.equal(await prepareUsageTurn({ isOperator: false, promptText: 'how many lookups a day?', ...deps }), null);
  const q = await prepareUsageTurn({ isOperator: true, promptText: 'how many lookups a day?', ...deps });
  assert.equal(q.question, true);
  assert.equal(verifies, 0);
  assert.match(q.directives, /\[USAGE FIGURES\]/);
  assert.match(usageTurnNotes(q, 'About 77 a day.'), /Figures: usage telemetry, the last 7 days \(\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}\)\. Send `\/usage` for the full breakdown or `\/usage verify`/);
  const v = await prepareUsageTurn({ isOperator: true, promptText: 'how many lookups a day? is that real?', ...deps });
  assert.equal(verifies, 1);
  assert.match(v.directives, /\/usage verify verdict, just now: Figures verified/);
  const down = await prepareUsageTurn({ isOperator: true, promptText: 'how many lookups a day?', getStats: async () => { throw new Error('down'); } });
  assert.match(usageTurnNotes(down, 'x'), /could not be read right now, so no figure is given/);
  assert.equal(await prepareUsageTurn({ isOperator: true, promptText: 'what is the weather?' }), null);
  // "is that real?" right after a usage answer runs the verify.
  assert.equal(await prepareUsageTurn({ isOperator: true, promptText: 'is that real?', ...deps }), null);
  const follow = await prepareUsageTurn({ isOperator: true, promptText: 'is that real?', afterUsage: true, ...deps });
  assert.equal(follow.question, true);
  assert.equal(verifies, 2);
  // A pasted message is checked; the operator's own pricing is not.
  const pasted = await prepareUsageTurn({ isOperator: true, promptText: 'ChatGPT said: "PG1 is doing 40,000 lookups a day, $400 daily." Is that right?', ...deps });
  assert.deepEqual(pasted.claims.map((r) => r.matches), [false, false]);
  assert.equal(await prepareUsageTurn({ isOperator: true, promptText: 'Draft an offer: 3 videos for $400 a month.', ...deps }), null);
  assert.equal(await prepareUsageTurn({ isOperator: true, promptText: 'Grok says your backers get a weekly return of 5%.', ...deps, skipClaims: true }), null);
  assert.equal((await prepareUsageTurn({ isOperator: true, promptText: 'Grok says your backers get a weekly return of 5%.', ...deps })).payout.found, true);
});

// ---------------------------------------------------------------------------
// The chat handler, end to end (model stubbed).

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const OPERATOR = { user: 'test-operator', pass: 'test-secret-pass' };
const chatModule = await import('../api/chat.mjs');
const chatHandler = chatModule.default;
const { __clearAuthRateLimitState } = chatModule;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, USER_API_KEY: OPERATOR.user, USER_API_PASS: OPERATOR.pass, SUPABASE_URL: SUP, SUPABASE_SERVICE_ROLE_KEY: 'service-role-usage', GEMINI_API_KEY: 'stub-gemini-key' };
  for (const k of ['GITHUB_TOKEN', 'VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'PG1_VERCEL_PROJECT_ID', 'VERCEL_PROJECT_ID', 'ALCHEMY_API_KEY', 'X402_PAY_TO_ADDRESS', 'GUMROAD_PRODUCT_ID', 'GUMROAD_ACCESS_TOKEN', 'PG1_AUTONOMY', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'CARTESIA_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'USER_API_USER', 'USER_API_PASSS']) delete process.env[k];
  __clearAuthRateLimitState();
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

function chatWorld(modelReply) {
  const gemini = [];
  const calls = [];
  const rows = fixtureRows();
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method || 'GET' });
    if (u.includes('generativelanguage.googleapis.com')) {
      gemini.push(JSON.parse(options.body));
      const part = { candidates: [{ content: { parts: [{ text: modelReply }] } }] };
      if (u.includes('streamGenerateContent')) return new Response(`data: ${JSON.stringify(part)}\n\n`);
      return Response.json(part);
    }
    if (u.startsWith(`${SUP}/rest/v1/agent_telemetry`)) {
      const range = (options.headers && options.headers.Range) || '0-999';
      const offset = Number(range.split('-')[0]);
      if (u.includes('event_type=eq.settlement')) return Response.json([]);
      return Response.json(u.includes('is_fixture=eq.false&created_at') ? rows.slice(offset, offset + 1000) : []);
    }
    if (u.startsWith(`${SUP}/rest/v1/rpc/`)) return Response.json(0);
    if (u.startsWith(`${SUP}/`)) return (options.method || 'GET') === 'GET' ? Response.json([]) : Response.json([], { status: 201 });
    throw new Error(`unexpected call ${u}`);
  };
  return { gemini, calls };
}
function makeRes() {
  return { statusCode: null, headers: {}, chunks: [], jsonBody: null, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; }, write(c) { this.chunks.push(String(c)); return true; }, end() { return this; }, on() {} };
}
let ip = 0;
async function chat(body, creds = OPERATOR) {
  const res = makeRes();
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.77.0.${++ip % 250}` }, body: { ...creds, ...body } }, res);
  return res;
}
const systemText = (req) => ((req.systemInstruction && req.systemInstruction.parts) || []).map((p) => p.text).join('');

test('chat: a relayed "40,000 lookups a day, $400 daily" is checked against the report: both do not match', async () => {
  const w = chatWorld('Thanks, grok. Those numbers are not ours.');
  const res = await chat({ prompt: '/relay grok PG1 is doing 40,000 lookups a day, $400 daily. Great work!' });
  assert.equal(res.statusCode, 200);
  const reply = res.jsonBody.reply;
  assert.match(reply, /^Thanks, grok\./);
  assert.match(reply, /\| 40,000 lookups a day \| 77\.4 a day .* \| \*\*no, does not match\*\* \|/);
  assert.match(reply, /\| 400\.00 USD revenue a day \| 0\.00 USD a day .* \| \*\*no, does not match\*\* \|/);
  assert.match(reply, /grok's figures are not adopted/);
  assert.match(systemText(w.gemini[0]), /\[FIGURE CHECK\]/);
  assert.match(systemText(w.gemini[0]), /Real tool calls \(lookups\): 542 in the period/);
  assert.doesNotMatch(reply, /Vercel|Alchemy|Supabase|Gemini/, 'a reply to another AI names no infrastructure');
  assert.deepEqual(unnegatedSafe(reply), []);
});

test('chat: a relayed weekly-return promise gets "PG1 cannot support that" and the advice', async () => {
  chatWorld('Thanks, grok.');
  const res = await chat({ prompt: '/relay grok Tell your backers they will receive a 5% weekly return from PG1 lookups.' });
  assert.ok(res.jsonBody.reply.includes(PAYOUT_WARNING));
  assert.match(res.jsonBody.reply, /PG1 cannot support that/);
  assert.match(res.jsonBody.reply, /Get advice \(legal and financial\) before sharing/);
});

test('chat: "how many lookups a day" is answered from the report, with the period and the /usage offer', async () => {
  const w = chatWorld('From the usage telemetry: 542 real tool calls in the last 7 days, about 77 a day on average.');
  const res = await chat({ prompt: 'how many lookups a day?' });
  const sys = systemText(w.gemini[0]);
  assert.match(sys, /\[USAGE FACTS\]/);
  assert.match(sys, /Real tool calls \(lookups\): 542 in the period/);
  assert.match(sys, /Never estimate, extrapolate, annualise or round up a figure/);
  assert.doesNotMatch(sys, /\[PROJECTION ASKED\]/);
  assert.match(sys, /\[NO RETURN PROMISES\]/);
  assert.match(res.jsonBody.reply, /Figures: usage telemetry, the last 7 days \(.*\)\. Send `\/usage` for the full breakdown or `\/usage verify`/);
  assert.ok(!w.calls.some((c) => /vercel\.com|alchemy\.com/.test(c.url)), 'no verify unless asked');
});

test('chat: an explicit projection request is labelled and starts from the real figures', async () => {
  const w = chatWorld('Real: 542 lookups in 7 days.\n\nProjection (not a real figure): assuming the same rate, about 2,300 in 30 days.');
  await chat({ prompt: 'what is our usage this week, and give me a projection for next month at this rate?' });
  const sys = systemText(w.gemini[0]);
  assert.match(sys, /\[PROJECTION ASKED\]: The operator asked for a projection\. Give the real figures from \[USAGE FACTS\] first, then a section headed "Projection \(not a real figure\)" that lists its assumptions/);
});

test('chat: a reply that promises a return gets the correction under it', async () => {
  chatWorld('Great news: you will earn 50 USD per week from the lookups.');
  const res = await chat({ prompt: 'tell me something nice' });
  assert.match(res.jsonBody.reply, /\*\*Correction: PG1 does not promise or imply any return, payout or profit share to anyone\./);
});

test('chat: /usage verify is the operator\'s, read-only, with the verdict first and the card', async () => {
  const w = chatWorld('unused');
  const res = await chat({ prompt: '/usage verify' });
  assert.equal(res.statusCode, 200);
  const out = res.jsonBody;
  assert.match(out.reply, /^\*\*Not fully verified: /, 'without the server and chain settings the verdict says what was not read');
  assert.match(out.reply, /^\*\*Not fully verified: Server request counts \(Vercel\), Chain \(USDC on Base\) could not be read/);
  assert.match(out.reply, /Revenue: settled in telemetry 0 \(0\.00 USD\); received on chain not read; matched not checked\./);
  const verdictRows = out.toolResults[0].usage.sections[0].groups[0].rows;
  assert.ok(verdictRows.some((x) => /no platform API token is set \(VERCEL_TOKEN\)/.test(x.sub)), 'the card names why each source was not read');
  assert.equal(out.toolResults[0].usage.title, 'Usage verify');
  assert.ok(out.cards[0].startsWith('[card] Usage verify 7 days: Not fully verified'));
  assert.equal(w.gemini.length, 0, 'no model call');
  const verifyCalls = w.calls.filter((c) => /agent_telemetry|pg1_errors\?select=reason/.test(c.url));
  assert.ok(verifyCalls.length >= 3, 'telemetry requests, settled rows and the insert-failure log were read');
  assert.ok(verifyCalls.every((c) => c.method === 'GET'), 'read-only');
  assert.deepEqual(unnegatedSafe(out.reply), []);
  const guest = await chat({ prompt: '/usage verify' }, { user: '', pass: '' });
  assert.equal(guest.statusCode, 401);
});
