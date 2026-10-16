/**
 * P6: opportunity pipeline (lib/opportunities.mjs, the runner's scan,
 * /api/opportunities/weekly, /opportunities).
 *
 * Covered: the signals are usage aggregates only (no caller, hash or
 * address); proposals are normalised (licence status, cited terms, the
 * 1.5x margin and the lowest allowed price); the runner's scan; the weekly
 * scan starts a lab research experiment (and is refused with autonomy off);
 * /lab status stores the proposals; /opportunities lists and shows them;
 * approving one only starts a lab prototype, which comes back through the
 * gate carrying the opportunity's sources and price (an unverified source
 * fails the licence check); nothing is launched, priced or published; the
 * cron is CRON_SECRET-gated; guests are refused.
 *
 * Run with: node --test tests/opportunities.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeLabWorld } from './helpers/labWorld.mjs';

const { opportunitySignals, normaliseProposal, runOpportunityScan, handleOpportunitiesCommand, SCAN_GOAL } = await import('../lib/opportunities.mjs');
const { runExperiment } = await import('../lib/lab/runner.mjs');
const { handleLabCommand, handleLabApproval } = await import('../lib/lab/chat.mjs');
const { default: weekly } = await import('../api/opportunities/weekly.mjs');
const { default: chatHandler, __clearAuthRateLimitState } = await import('../api/chat.mjs');

const SUP = { supUrl: 'https://supabase.test', supKey: 'k' };
const ENV = { PG1_LAB_DISPATCH_SECRET: 'x'.repeat(40), GITHUB_TOKEN: 'ghp_x', PG1_AUTONOMY: 'lab' };
const MIGRATIONS = ['20261019120000_pg1_skills.sql', '20261020120000_pg1_lab_and_flags.sql', '20261021120000_pg1_autonomy_log.sql', '20261022120000_pg1_opportunities.sql'];

const STATS = {
  period: '7d',
  traffic: { by_route: [{ route: '/api/mcp', requests: 900 }, { route: '/api/a2a', requests: 120 }] },
  tools: [{ tool: 'check_wallet_sanctions', calls: 400, pricing: 'free' }, { tool: 'get_cve_details', calls: 50, pricing: 'paid' }],
  payments: { payment_requests: 30, payments_settled: 4, callers_hit_free_limit: 12 },
  errors: { unknown_tool_calls: 22, unrecognised_tools: [{ name: 'check_contract_bytecode', count: 15 }, { name: 'scan_nft', count: 7 }], by_tool: [{ tool: 'check_package', errors: 3 }] },
  clients: [{ name: 'some-agent', requests: 10 }],
  distinct_callers_estimate: 99
};

const PROPOSAL = {
  title: 'Smart-contract bytecode check', problem: 'Agents ask for check_contract_bytecode before paying contracts.',
  target_agents: 'payment agents', data_sources: [{ name: 'Sourcify', url: 'https://sourcify.dev', licence_status: 'resale_permitted', resale_terms_url: 'https://sourcify.dev/terms' }],
  build_cost_usd: 1.5, run_cost_per_call_usd: 0.002, price_usd: 0.005, risks: 'false negatives'
};

test('the signals are aggregates only: counts and tool names, no caller, hash or address', () => {
  const s = opportunitySignals(STATS);
  assert.deepEqual(s.requested_unknown_tools, [{ name: 'check_contract_bytecode', count: 15 }, { name: 'scan_nft', count: 7 }]);
  assert.equal(s.payment_requests_without_settlement, 26);
  assert.equal(s.a2a_requests, 120);
  assert.equal(s.top_tools[0].tool, 'check_wallet_sanctions');
  const json = JSON.stringify(s);
  assert.doesNotMatch(json, /client|caller|some-agent|0x[0-9a-f]{40}|[0-9a-f]{64}/i);
});

test('proposals are normalised: licence status, cited terms, the 1.5x margin and the lowest allowed price', () => {
  const p = normaliseProposal(PROPOSAL);
  assert.equal(p.margin_ok, true);
  assert.equal(p.licence_ok, true);
  assert.equal(p.min_price_usd, 0.003);
  const cheap = normaliseProposal({ ...PROPOSAL, price_usd: 0.002 });
  assert.equal(cheap.margin_ok, false);
  const uncited = normaliseProposal({ ...PROPOSAL, data_sources: [{ name: 'Some API', url: 'http://x', licence_status: 'resale_permitted' }, { name: 'Other', licence_status: 'whatever' }] });
  assert.equal(uncited.licence_ok, false);
  assert.equal(uncited.data_sources[0].url, null, 'non-https URLs are dropped');
  assert.equal(uncited.data_sources[1].licence_status, 'unverified');
  assert.equal(normaliseProposal({ title: '' }), null);
});

test('the runner scan: signals as untrusted data, 1-3 proposals, search on the model API only', async () => {
  const calls = [];
  const fetchImpl = async (u, o = {}) => {
    calls.push({ u: String(u), method: o.method });
    const body = JSON.parse(o.body);
    assert.match(body.systemInstruction.parts[0].text, /resale/);
    assert.match(body.contents[0].parts[0].text, /<usage_signals untrusted="true">/);
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'One idea.', proposals: [PROPOSAL, PROPOSAL, PROPOSAL, PROPOSAL] }) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100 } });
  };
  const r = await runExperiment({ id: 'abababab-0000-0000-0000-000000000000', kind: 'research', goal: SCAN_GOAL, input: { task: 'opportunities', signals: opportunitySignals(STATS) }, env: { PG1_LAB_GEMINI_API_KEY: 'g' }, budgetUsd: 2, fetchImpl });
  assert.equal(r.status, 'done');
  assert.equal(r.proposals.length, 3);
  assert.match(r.report_markdown, /## Opportunity scan/);
  assert.ok(calls.every((c) => c.u.startsWith('https://generativelanguage.googleapis.com/')));
});

test('the weekly scan starts one lab research experiment with the signals; refused and logged with autonomy off', async () => {
  const { db, gh, fetchImpl } = await makeLabWorld(MIGRATIONS);
  const out = await runOpportunityScan({ env: ENV, ...SUP, fetchImpl, getStats: async ({ period }) => { assert.equal(period, '7d'); return STATS; } });
  assert.equal(out.ok, true);
  assert.equal(gh.dispatches.length, 1);
  const d = gh.dispatches[0].inputs;
  assert.equal(d.kind, 'research');
  assert.equal(d.goal, SCAN_GOAL);
  const input = JSON.parse(Buffer.from(d.input, 'base64').toString());
  assert.equal(input.task, 'opportunities');
  assert.equal(input.signals.requested_unknown_tools[0].name, 'check_contract_bytecode');
  const off = await runOpportunityScan({ env: { ...ENV, PG1_AUTONOMY: 'off' }, ...SUP, fetchImpl, getStats: async () => STATS });
  assert.equal(off.ok, false);
  assert.equal(gh.dispatches.length, 1);
  const { rows } = await db.query(`select action, decision from public.pg1_autonomy_log order by id`);
  assert.deepEqual(rows, [{ action: 'opportunity:research', decision: 'allowed' }, { action: 'opportunity:research', decision: 'denied' }]);
});

// What a code experiment's runner really returns besides the change: the
// research it did first and the build (lib/lab/runner.mjs).
const codeResearched = { report_markdown: '## Research\n## Findings\nSourcify publishes verified contract metadata; its terms permit commercial reuse.\n\n## Code change\ns', stages: { research: { ok: true, chars: 90, sources: 1, calls: 1 }, build: { ok: true, files: 2 } } };

test('/lab status stores the proposals; approve only prototypes in the lab; the prototype meets the gate with the opportunity\'s sources and price', async () => {
  const { db, gh, fetchImpl } = await makeLabWorld(MIGRATIONS);
  const op = (text) => handleOpportunitiesCommand({ text, env: ENV, ...SUP, fetchImpl, isOperator: true, getStats: async () => STATS });
  assert.equal((await op('/opportunities scan')).reply.startsWith('Lab experiment'), true);
  gh.finish({ kind: 'research', proposals: [PROPOSAL, { ...PROPOSAL, title: 'Unverified idea', data_sources: [{ name: 'Mystery API', url: 'https://m.example', licence_status: 'unverified' }] }], report_markdown: '## Opportunity scan' });
  await handleLabCommand({ text: '/lab status', env: ENV, ...SUP, fetchImpl, isOperator: true });
  const list = await op('/opportunities');
  assert.match(list.reply, /Smart-contract bytecode check\*\* · price \$0\.005 \(margin ok, licences ok\)/);
  assert.match(list.reply, /Unverified idea\*\* · price \$0\.005 \(margin ok, licences not cleared\)/);
  const { rows } = await db.query(`select id, title from public.pg1_opportunities order by title`);
  const good = rows.find((r) => r.title.startsWith('Smart')).id;
  const bad = rows.find((r) => r.title.startsWith('Unverified')).id;
  assert.match((await op(`/opportunities show ${good.slice(0, 8)}`)).reply, /the 1\.5x rule needs at least \$0\.0030; met/);
  // Approve the unverified one: a code prototype in the lab, nothing else.
  const approved = await op(`/opportunities approve ${bad.slice(0, 8)}`);
  assert.match(approved.reply, /^Prototyping [0-9a-f]{8} in the lab\./);
  assert.match(approved.reply, /PG1 will not launch, price or publish it/);
  assert.equal(gh.dispatches.length, 2);
  assert.equal(gh.dispatches[1].inputs.kind, 'code');
  assert.match((await op(`/opportunities approve ${bad.slice(0, 8)}`)).reply, /is prototyping; only a proposed one/);
  // The prototype comes back as a draft PR with green CI.
  gh.checks.set(41, [{ name: 'npm test', status: 'completed', conclusion: 'success' }]);
  gh.finish({ kind: 'code', ...codeResearched, code: { branch: 'lab/x', files: ['lib/contractCheck.mjs', 'tests/contract-check.test.mjs'], title: 't', summary: 's', tests: { passed: true, summary: '# pass 1' }, pr_number: 41, pr_url: 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/41' } });
  const status = await handleLabCommand({ text: '/lab status', env: ENV, ...SUP, fetchImpl, isOperator: true });
  assert.equal(status.pendingApproval, undefined, 'an unverified source never reaches the approval card');
  const { rows: exp } = await db.query(`select gate, status, error from public.pg1_lab_experiments where kind = 'code'`);
  assert.equal(exp[0].status, 'failed', 'a failed gate fails the experiment: it is never "done"');
  assert.match(exp[0].error, /^gate: licence/);
  const licence = exp[0].gate.checks.find((c) => c.name === 'licence');
  assert.equal(licence.ok, false);
  assert.match(licence.evidence, /without cited resale terms/);
  assert.equal(exp[0].gate.checks.find((c) => c.name === 'cost').ok, true);
  // Nothing was launched, priced or published.
  const { rows: flags } = await db.query('select key from public.pg1_feature_flags');
  assert.deepEqual(flags, []);
  assert.match((await op(`/opportunities dismiss ${good.slice(0, 8)}`)).reply, /Dismissed/);
});

test('a cleared prototype reaches the approval card with the evidence; approving it is operator-only rollout, never a launch', async () => {
  const { db, gh, fetchImpl } = await makeLabWorld(MIGRATIONS);
  const op = (text) => handleOpportunitiesCommand({ text, env: ENV, ...SUP, fetchImpl, isOperator: true, getStats: async () => STATS });
  await op('/opportunities scan');
  gh.finish({ kind: 'research', proposals: [PROPOSAL] });
  await handleLabCommand({ text: '/lab status', env: ENV, ...SUP, fetchImpl, isOperator: true });
  const { rows } = await db.query('select id from public.pg1_opportunities');
  await op(`/opportunities approve ${rows[0].id.slice(0, 8)}`);
  gh.checks.set(42, [{ name: 'npm test', status: 'completed', conclusion: 'success' }, { name: 'browser tests', status: 'completed', conclusion: 'success' }]);
  gh.finish({ kind: 'code', ...codeResearched, code: { branch: 'lab/y', files: ['lib/contractCheck.mjs'], title: 't', summary: 's', tests: { passed: true, summary: '# pass 1' }, pr_number: 42, pr_url: 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/42' } });
  const status = await handleLabCommand({ text: '/lab status', env: ENV, ...SUP, fetchImpl, isOperator: true });
  assert.ok(status.pendingApproval);
  assert.equal((await db.query(`select status from public.pg1_lab_experiments where kind = 'code'`)).rows[0].status, 'done', 'done once every stage, the gate included, passed');
  assert.match(status.reply, /✓ evals: CI success[\s\S]*✓ licence: https:\/\/sourcify\.dev: resale_permitted \(https:\/\/sourcify\.dev\/terms\)[\s\S]*✓ cost: price \$0\.005 vs worst-case cost \$0\.002/);
  const { rows: card } = await db.query('select plan from public.pending_actions');
  const done = await handleLabApproval({ row: { plan: card[0].plan }, decision: 'approve', ...SUP, fetchImpl, isOperator: true });
  assert.match(done.reply, /PG1 never merges/);
  const { rows: flags } = await db.query('select key, stage from public.pg1_feature_flags');
  assert.deepEqual(flags, [{ key: 'code:42', stage: 'operator' }]);
});

// --- through the chat and the cron ------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
beforeEach(() => {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  __clearAuthRateLimitState();
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

test('chat: /opportunities for the operator; guests are refused; the cron needs CRON_SECRET', async () => {
  const { fetchImpl } = await makeLabWorld(MIGRATIONS);
  globalThis.fetch = fetchImpl;
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  const mk = () => ({ statusCode: null, headers: {}, jsonBody: null, setHeader(k, v) { this.headers[k] = v; }, getHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; }, write() { return true; }, end() { return this; }, on() {} });
  const res = mk();
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: '10.86.0.1' }, body: { user: 'test-operator', pass: 'test-secret-pass', prompt: '/opportunities' } }, res);
  assert.match(res.jsonBody.reply, /No opportunities yet/);
  const guest = mk();
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: '10.86.0.2' }, body: { prompt: '/opportunities' } }, guest);
  assert.equal(guest.statusCode, 401);
  // The 401 is logged in the background (pg1_errors): let it finish on the stub.
  await new Promise((r) => setTimeout(r, 100));
  const cron = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  delete process.env.CRON_SECRET;
  await weekly({ method: 'GET', headers: {} }, cron);
  assert.equal(cron.statusCode, 403);
});
