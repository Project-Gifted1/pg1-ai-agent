/**
 * The code lab's build step (lib/lab/runner.mjs, lib/lab/edits.mjs,
 * lib/lab/codeContext.mjs), after lab 82aaad40 ("Improve (server/discover):
 * 11 method_not_found answers", 23 Nov) failed with "The model proposed no
 * usable change" at $0.00 of $2.00:
 *   - the build gets the real code: the goal's names searched for in the
 *     repository, the matching functions with line numbers, as untrusted
 *     context;
 *   - targeted edits: each "search" must match its file exactly once (zero
 *     and several matches are refused with the reason); new files whole;
 *   - every failure reason is reported distinctly; the raw reply is saved,
 *     scrubbed and capped, with the engine and model that answered;
 *   - free engines first; a cut-off or unparseable reply is retried once on
 *     the next free engine; PG1_LAB_PAID_BUILD is off by default;
 *   - the spec check: an unknown method's -32601 is correct behaviour;
 *     server/discover is a spec method PG1 should answer;
 *   - the opportunity scan's title is filled and its report keeps every
 *     proposal in full; "Next step" says what a retry would change.
 * No network: every engine is a stub.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runExperiment, keepRawReply, RAW_REPLY_MAX_BYTES, paidBuildOn } from '../lib/lab/runner.mjs';
import { parseBuildReply, checkBuildPlan, applyEditsToText, countOccurrences, BUILD_FAILURES } from '../lib/lab/edits.mjs';
import { goalTerms, gatherCodeContext } from '../lib/lab/codeContext.mjs';
import { specVerdict, verdictLine } from '../lib/lab/specCheck.mjs';
import { labNextStep } from '../lib/lab/nextStep.mjs';
import { applyPatch } from '../scripts/lab-apply.mjs';
import { __resetQuota } from '../lib/router/quota.mjs';

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const FINDINGS = '## Findings\nJSON-RPC 2.0 answers an unknown method with -32601 Method not found; MCP 2026-07-28 adds server/discover.\n## Sources\nnone';
const GOAL = 'Improve (server/discover): 11 method_not_found answers to real callers in 7 days (clearer inputs and messages). Evidence: {"tool":"(server/discover)","type":"method_not_found"}';
const MCP = [
  'export async function handle(method, params) {',
  "  if (method === 'initialize') {",
  "    return { protocolVersion: '2025-06-18' };",
  '  }',
  "  if (method === 'tools/list') return { tools: [] };",
  "  return { error: { code: -32601, message: `Method not found: ${method}` } };",
  '}',
  ''
].join('\n');

function repo() {
  const root = mkdtempSync(path.join(tmpdir(), 'pg1-build-'));
  mkdirSync(path.join(root, 'api'), { recursive: true });
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  writeFileSync(path.join(root, 'api/mcp.mjs'), MCP);
  writeFileSync(path.join(root, 'tests/mcp.test.mjs'), "import { handle } from '../api/mcp.mjs';\n");
  return root;
}
const GOOD = {
  summary: 'Answer server/discover with the versions PG1 serves',
  edits: [{ path: 'api/mcp.mjs', search: "  if (method === 'tools/list') return { tools: [] };", replace: "  if (method === 'server/discover') return { resultType: 'complete', supportedVersions: ['2025-06-18'], capabilities: {}, ttlMs: 3600000, cacheScope: 'public' };\n  if (method === 'tools/list') return { tools: [] };" }],
  new_files: [{ path: 'tests/discover.test.mjs', content: "import { test } from 'node:test';\n" }],
  tests: 'server/discover answers'
};

// The engines: free ones answer by provider; a paid key records whether it was called.
function engines(byProvider, { calls = [] } = {}) {
  const fetchImpl = async (u, o = {}) => {
    const url = String(u);
    const host = new URL(url).hostname;
    calls.push({ host, method: o.method || 'GET', body: o.body ? JSON.parse(o.body) : null });
    const provider = host === 'api.groq.com' ? 'groq' : host === 'api.mistral.ai' ? 'mistral' : host === 'api.anthropic.com' ? 'anthropic' : host === 'generativelanguage.googleapis.com' ? 'gemini' : null;
    if (!provider) return new Response('{}', { status: 404 });
    const body = o.body ? JSON.parse(o.body) : {};
    const sys = provider === 'anthropic' ? body.system : provider === 'gemini' ? body.systemInstruction.parts[0].text : (body.messages || []).find((m) => m.role === 'system')?.content || '';
    const prompt = provider === 'anthropic' ? body.messages[0].content : provider === 'gemini' ? body.contents[0].parts[0].text : (body.messages || []).filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const research = /researching before a change/.test(sys);
    const ans = research ? { text: FINDINGS } : await byProvider(provider, { system: sys, prompt, n: calls.filter((c) => c.host === host).length });
    if (!ans) return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 });
    if (provider === 'anthropic') return Response.json({ content: [{ type: 'text', text: ans.text }], stop_reason: ans.finish === 'length' ? 'max_tokens' : 'end_turn', usage: { input_tokens: 100, output_tokens: 100 } });
    if (provider === 'gemini') return Response.json({ candidates: [{ content: { parts: [{ text: ans.text }] }, finishReason: ans.finish === 'length' ? 'MAX_TOKENS' : 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100 } });
    return Response.json({ choices: [{ message: { content: ans.text }, finish_reason: ans.finish || 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100 } });
  };
  return { fetchImpl, calls };
}
const FREE_ENV = { GROQ_API_KEY: 'free-groq-key-123456', MISTRAL_API_KEY: 'free-mistral-key-123456', PG1_LAB_FREE_SEARCH: 'off' };
const run = (fetchImpl, env = FREE_ENV, root = repo()) => runExperiment({ id: '82aaad40-0000-0000-0000-000000000000', kind: 'code', goal: GOAL, env, budgetUsd: 2, fetchImpl, lookup, root });

beforeEach(() => { try { __resetQuota(); } catch (e) { /* no quota state */ } });

test('edits: each search must match its file exactly once (zero, one, several)', () => {
  assert.equal(countOccurrences('a b a', 'a'), 2);
  assert.equal(applyEditsToText('x = 1;\ny = 2;\n', [{ search: 'y = 2;', replace: 'y = 3;' }], 'f'), 'x = 1;\ny = 3;\n', 'one match: applied');
  assert.throws(() => applyEditsToText('x = 1;\n', [{ search: 'z = 9;', replace: 'z' }], 'lib/f.mjs'), (e) => e.code === 'no_match' && /edit 1 in lib\/f\.mjs: the search text is not in the file/.test(e.message));
  assert.throws(() => applyEditsToText('a();\na();\na();\n', [{ search: 'a();', replace: 'b();' }], 'lib/f.mjs'), (e) => e.code === 'multiple_match' && /appears 3 times; it must appear exactly once/.test(e.message));
  assert.equal(applyEditsToText('$& x', [{ search: 'x', replace: '$1 $&' }], 'f'), '$& $1 $&', 'replace is literal text, never a pattern');
  // lab-apply applies the same rule on the test and PR jobs.
  const root = repo();
  assert.equal(applyPatch([{ path: 'api/mcp.mjs', edits: GOOD.edits.map(({ search, replace }) => ({ search, replace })) }, GOOD.new_files[0]], root), 2);
  assert.match(readFileSync(path.join(root, 'api/mcp.mjs'), 'utf8'), /server\/discover/);
  assert.throws(() => applyPatch([{ path: 'api/mcp.mjs', edits: [{ search: 'nothing like this', replace: 'x' }] }], root), /not in the file/);
});

test('every failure reason is reported distinctly, with the file and edit', async () => {
  const cases = {
    no_json: { text: 'I would change the error message to be clearer.' },
    truncated: { text: '{"summary":"x","edits":[{"path":"api/mcp.mjs","search":"  if (method', finish: 'length' },
    empty_edits: { text: JSON.stringify({ summary: 'nothing to change', edits: [], new_files: [] }) },
    bad_fields: { text: JSON.stringify({ summary: 'x', edits: [{ path: 'api/mcp.mjs', replace: 'y' }] }) },
    no_match: { text: JSON.stringify({ ...GOOD, edits: [{ path: 'api/mcp.mjs', search: "if (method === 'ping')", replace: 'x' }] }) },
    multiple_match: { text: JSON.stringify({ ...GOOD, edits: [{ path: 'api/mcp.mjs', search: "  if (method === '", replace: 'x' }] }) },
    refused_path: { text: JSON.stringify({ ...GOOD, new_files: [...GOOD.new_files, { path: '.github/workflows/x.yml', content: 'x' }] }) },
    too_large: { text: JSON.stringify({ ...GOOD, new_files: [...GOOD.new_files, { path: 'lib/big.mjs', content: 'x'.repeat(210 * 1024) }] }) },
    no_test: { text: JSON.stringify({ ...GOOD, new_files: [] }) }
  };
  const messages = new Set();
  for (const [code, ans] of Object.entries(cases)) {
    // The same reply from every free engine, so the retry cannot rescue it.
    const { fetchImpl } = engines(async () => ans);
    const r = await run(fetchImpl);
    assert.equal(r.status, 'failed', code);
    assert.equal(r.stages.build.failure, code, `${code}: ${r.error}`);
    assert.match(r.error, /^build: /);
    messages.add(r.stages.build.reason.replace(/\d+/g, '#'));
    if (code === 'no_match') assert.match(r.error, /edit 1 in api\/mcp\.mjs: the search text is not in the file/);
    if (code === 'multiple_match') assert.match(r.error, /edit 1 in api\/mcp\.mjs: the search text appears 2 times; it must appear exactly once/);
    if (code === 'refused_path') assert.match(r.error, /\.github\/workflows\/x\.yml/);
    if (code === 'bad_fields') assert.match(r.error, /edit 1 \(api\/mcp\.mjs\) has no "search" text/);
    assert.match(r.report_markdown, /### Build calls/);
    assert.match(r.report_markdown, /### Code context given to the build\n- api\/mcp\.mjs: lines/);
  }
  assert.equal(messages.size, Object.keys(cases).length, 'each reason has its own words');
  assert.deepEqual(Object.keys(BUILD_FAILURES).sort(), Object.keys(cases).sort());
});

test('the build gets the real code as untrusted context, and a good reply becomes targeted edits', async () => {
  assert.deepEqual(goalTerms(GOAL).map((t) => t.term).slice(0, 2), ['server/discover', "method === 'initialize'"]);
  const root = repo();
  const c = gatherCodeContext({ goal: GOAL, root });
  assert.ok(c.files.some((f) => f.path === 'api/mcp.mjs'));
  assert.match(c.text, /<file path="api\/mcp\.mjs" lines="2-8"[^>]*>\n {4}2\|   if \(method === 'initialize'\) \{[\s\S]*    6\|   return \{ error: \{ code: -32601/);
  let prompt = '';
  const { fetchImpl } = engines(async (p, x) => { prompt = x.prompt; return { text: JSON.stringify(GOOD) }; });
  const r = await run(fetchImpl, FREE_ENV, root);
  assert.equal(r.status, 'done', r.error);
  assert.match(prompt, /<code_context untrusted="true">[\s\S]*api\/mcp\.mjs[\s\S]*-32601[\s\S]*<\/code_context>/);
  assert.deepEqual(r.patch, [{ path: 'api/mcp.mjs', edits: [{ search: GOOD.edits[0].search, replace: GOOD.edits[0].replace }] }, GOOD.new_files[0]]);
  assert.equal(r.stages.build.edits, 1); assert.equal(r.stages.build.new_files, 1);
  assert.equal(readFileSync(path.join(root, 'api/mcp.mjs'), 'utf8'), MCP, 'the runner writes nothing');
});

test('the raw reply is saved with the experiment: scrubbed, capped at 20 KB, with the engine and model', async () => {
  const env = { ...FREE_ENV, PG1_LAB_GEMINI_API_KEY: 'AIzaSyD-this-is-a-real-looking-key-000000' };
  const { fetchImpl } = engines(async () => ({ text: `Here is my answer. key=${FREE_ENV.GROQ_API_KEY} and AIzaSyD-this-is-a-real-looking-key-000000 ${'filler '.repeat(5000)}` }));
  const r = await run(fetchImpl, env);
  assert.equal(r.stages.build.failure, 'no_json');
  const raw = r.build_reply;
  assert.ok(raw && raw.text, 'kept');
  assert.ok(!raw.text.includes(FREE_ENV.GROQ_API_KEY) && !raw.text.includes('AIzaSyD-this'), 'scrubbed');
  assert.ok(Buffer.byteLength(raw.text) <= RAW_REPLY_MAX_BYTES && raw.cut === true);
  assert.equal(raw.engine, 'free');
  assert.ok(['groq', 'mistral'].includes(raw.provider));
  assert.match(raw.model, /^free:(groq|mistral)\//);
  const k = keepRawReply({ text: 'short', provider: 'groq', model: 'free:groq/m', truncated: true }, {});
  assert.deepEqual({ ...k }, { engine: 'free', provider: 'groq', model: 'free:groq/m', truncated: true, chars: 5, text: 'short', cut: false });
});

test('free engines first: a cut-off reply is retried once on the next free engine; the paid build is off by default', async () => {
  // The first free engine is cut off; the next one answers.
  let first = null;
  const a = engines(async (p) => { if (!first) first = p; return p === first ? { text: '{"summary":"x","edits":[', finish: 'length' } : { text: JSON.stringify(GOOD) }; });
  const r = await run(a.fetchImpl, { ...FREE_ENV, PG1_LAB_ANTHROPIC_API_KEY: 'paid-key-0000000000000' });
  assert.equal(r.status, 'done', r.error);
  const at = r.stages.build.attempts;
  assert.equal(at.length, 2);
  assert.equal(at[0].outcome, 'truncated'); assert.equal(at[0].truncated, true);
  assert.equal(at[1].outcome, 'ok');
  assert.notEqual(at[0].provider, at[1].provider, 'the retry is on the next free engine');
  assert.equal(r.stages.build.paid_build, 'off');
  assert.equal(a.calls.filter((c) => c.host === 'api.anthropic.com').length, 0, 'no paid call');
  assert.equal(r.spent_usd, 0);
  assert.match(r.report_markdown, /Paid build \(PG1_LAB_PAID_BUILD\): off/);
  // Both free engines fail: off by default, so no paid call, and the report says so.
  const b = engines(async (p) => (p === 'anthropic' ? { text: JSON.stringify(GOOD) } : { text: 'not json' }));
  const off = await run(b.fetchImpl, { ...FREE_ENV, PG1_LAB_ANTHROPIC_API_KEY: 'paid-key-0000000000000' });
  assert.equal(off.stages.build.failure, 'no_json');
  assert.equal(off.stages.build.attempts.length, 2);
  assert.equal(b.calls.filter((c) => c.host === 'api.anthropic.com').length, 0);
  assert.equal(paidBuildOn({}), false);
  // On: the confirmed budget pays for the build step only, after the free tries.
  const c = engines(async (p) => (p === 'anthropic' ? { text: JSON.stringify(GOOD) } : { text: 'not json' }));
  const on = await run(c.fetchImpl, { ...FREE_ENV, PG1_LAB_ANTHROPIC_API_KEY: 'paid-key-0000000000000', PG1_LAB_PAID_BUILD: 'on' });
  assert.equal(on.status, 'done', on.error);
  assert.equal(on.stages.build.paid_build, 'on (used)');
  assert.equal(on.stages.build.attempts.at(-1).engine, 'paid');
  const paidCalls = c.calls.filter((x) => x.host === 'api.anthropic.com');
  assert.equal(paidCalls.length, 1);
  assert.match(paidCalls[0].body.system, /targeted edits/, 'the build step only (research stayed free)');
  assert.ok(on.spent_usd > 0 && on.spent_usd <= 2);
});

test('the spec check: an unknown method\'s -32601 is correct behaviour; server/discover is a spec method to support', async () => {
  const unknown = specVerdict({ type: 'method_not_found', method: '__mcp_index_nonexistent__' });
  assert.equal(unknown.correct, true);
  assert.match(unknown.source, /JSON-RPC 2\.0/);
  assert.match(verdictLine(unknown, { count: 4 }), /correct behaviour, no change[\s\S]*Source: JSON-RPC 2\.0/);
  const discover = specVerdict({ type: 'method_not_found', method: '(server/discover)' });
  assert.equal(discover.correct, false);
  assert.equal(discover.adopt.method, 'server/discover');
  assert.match(discover.adopt.source, /2026-07-28[\s\S]*MUST implement server\/discover/);
  assert.equal(specVerdict({ type: 'method_not_found', method: 'server/discover', implemented: ['server/discover'] }).correct, null, 'a spec method PG1 already answers: an error there is to look into');
  assert.equal(specVerdict({ type: 'invalid_params' }).messageOnly, true);
  assert.equal(specVerdict({ type: 'payment_required' }).correct, true);
  const { weeklyFindings, actOnFindings, labGoalFor } = await import('../lib/operator/tasks.mjs');
  const f = weeklyFindings({ now: Date.parse('2026-11-23T08:00:00Z'), errors: { breakdown: [
    { tool: '(server/discover)', type: 'method_not_found', fault: 'caller', real: 11 },
    { tool: '(__mcp_index_nonexistent__)', type: 'method_not_found', fault: 'caller', real: 14 },
    { tool: 'check_wallet_age', type: 'invalid_params', fault: 'caller', real: 12 }
  ] } });
  const note = f.find((x) => x.kind === 'note');
  assert.match(note.title, /__mcp_index_nonexistent__ method_not_found \(14\): correct behaviour, no change/);
  const adopt = f.find((x) => x.kind === 'new');
  assert.match(adopt.title, /^Support server\/discover \(MCP 2026-07-28\): 11 real callers/);
  assert.match(labGoalFor({ kind: 'new', title: adopt.title, evidence: adopt.evidence }).goal, /^Support server\/discover \(MCP 2026-07-28\): answer server\/discover on \/api\/mcp with supportedVersions/);
  assert.ok(f.some((x) => x.kind === 'improve' && /check_wallet_age/.test(x.title)), 'invalid params: the message can still be clearer');
  const added = [];
  const out = await actOnFindings({ findings: [note], opStore: { taskByKey: async () => null, addTask: async (t) => { added.push(t); return { id: 't', ...t }; }, updateTask: async () => {} }, env: { PG1_AUTONOMY: 'on' }, audit: { supUrl: '', supKey: '' }, startLab: async () => ({ ok: true, id: 'x' }) });
  assert.equal(added.length, 0, 'a note never becomes a task');
  assert.deepEqual(out.notes, [note.title]);
  const { buildWeeklyReport } = await import('../lib/operator/reports.mjs');
  void buildWeeklyReport;
});

test('the opportunity scan: its title is filled and its report keeps every proposal in full', async () => {
  const problem = `AI agents dynamically discovering MCP endpoints risk connecting to rogue servers ${'that deliver prompt injection payloads, '.repeat(20)}end.`;
  const scan = { proposals: [{ title: 'check_mcp_server_reputation', problem, target_agents: 'MCP agents', data_sources: [{ name: 'PG1 telemetry', licence_status: 'own_data' }], price_usd: 0.005, run_cost_per_call_usd: 0.002, build_cost_usd: 600, risks: 'rotation' }, { title: 'verify_agent_card_authenticity', problem: 'Spoofed cards.', price_usd: 0.003, run_cost_per_call_usd: 0.001 }], summary: 'We propose `check_mcp_server_reputation` and `verify_agent_card_authenticity`.' };
  const { fetchImpl } = engines(async () => ({ text: JSON.stringify(scan) }));
  const r = await runExperiment({ id: '83c7d665-0000-0000-0000-000000000000', kind: 'research', goal: 'Weekly opportunity scan: from this week\'s usage signals and the market, propose 1-3 new tools agents would pay for', input: { task: 'opportunities', signals: {} }, env: FREE_ENV, budgetUsd: 2, fetchImpl, lookup });
  assert.equal(r.status, 'done', r.error);
  assert.equal(r.title, 'Opportunity scan: check_mcp_server_reputation, verify_agent_card_authenticity');
  assert.ok(r.report_markdown.includes(problem), 'the problem in full');
  assert.match(r.report_markdown, /### 1\. check_mcp_server_reputation\n/);
  assert.match(r.report_markdown, /- Data sources:\n {2}- PG1 telemetry: own_data/);
  assert.match(r.report_markdown, /build cost \$600/);
  const { composeReport } = await import('../lib/watches/report.mjs');
  const rep = composeReport({ target_type: 'lab', target_id: '83c7d665-0000-0000-0000-000000000000' }, { state: 'done', info: { exp: { id: '83c7d665-0000-0000-0000-000000000000', kind: 'research', goal: 'Weekly opportunity scan: from this week\'s usage signals and the market, propose 1-3 new tools agents would pay for', status: 'done', spent_usd: 0, budget_usd: 2, result: r } } });
  assert.ok(!/propose \)/.test(rep.body), rep.body);
  assert.match(rep.body, /\(research: Opportunity scan: check_mcp_server_reputation, verify_agent_card_authenticity\)/);
});

test('"Next step" after a failure says what a retry would change, or why it would fail the same way', () => {
  const failed = (failure, extra = {}) => ({ status: 'failed', error: 'build: x', result: { stages: { build: { ok: false, failure, ...extra } } } });
  assert.match(labNextStep(failed('truncated', { paid_build: 'off' })), /retries once on the next free engine[\s\S]*PG1_LAB_PAID_BUILD=on/);
  assert.match(labNextStep(failed('no_json', { paid_build: 'on (used)' })), /may fail the same way/);
  assert.match(labNextStep(failed('refused_path')), /^A retry would fail the same way: the change belongs in a path the lab may not change/);
  assert.match(labNextStep(failed('too_large')), /would fail the same way[\s\S]*Split/);
  assert.match(labNextStep(failed('empty_edits')), /spec check/);
  assert.match(labNextStep(failed('no_match')), /can fail the same way[\s\S]*Name the function/);
  assert.match(labNextStep({ status: 'failed', error: 'research: model call failed (anthropic 400 out of credit)' }), /fail the same way until the engine's credit/);
  assert.match(labNextStep({ status: 'over_budget' }), /larger budget/);
  const texts = ['truncated', 'empty_edits', 'no_match', 'refused_path', 'too_large', 'no_test', 'bad_fields'].map((c) => labNextStep(failed(c, { paid_build: 'off' })));
  assert.equal(new Set(texts).size, texts.length);
  for (const t of texts) assert.ok(!/^Read the report for the reason, then start it again/.test(t));
});

// Recorded-shape engine replies (tests/fixtures/lab-build/*.json, OpenAI-compatible
// chat completions as Groq and Mistral return them): the first free engine called
// gets the first fixture, the next engine the second.
const FIX = (name) => JSON.parse(readFileSync(new URL(`./fixtures/lab-build/${name}.json`, import.meta.url), 'utf8')).response;
function replay(first, second) {
  const calls = [];
  const order = [];
  const fetchImpl = async (u, o = {}) => {
    const host = new URL(String(u)).hostname;
    calls.push({ host, method: o.method || 'GET' });
    if (host !== 'api.groq.com' && host !== 'api.mistral.ai') return new Response('{}', { status: 404 });
    const body = JSON.parse(o.body || '{}');
    const sys = (body.messages || []).find((m) => m.role === 'system')?.content || '';
    if (/researching before a change/.test(sys)) return Response.json({ choices: [{ message: { content: FINDINGS }, finish_reason: 'stop' }] });
    if (!order.includes(host)) order.push(host);
    return Response.json(FIX(order.indexOf(host) === 0 ? first : second));
  };
  return { fetchImpl, calls, order };
}

test('recorded replies: a cut-off reply, then the next free engine answers', async () => {
  const x = replay('groq-cut-off', 'free-edits');
  const r = await run(x.fetchImpl);
  assert.equal(r.status, 'done', r.error);
  const [a, b] = r.stages.build.attempts;
  assert.equal(a.outcome, 'truncated'); assert.equal(a.truncated, true);
  assert.equal(b.outcome, 'ok');
  assert.equal(x.order.length, 2, 'two different free engines');
  assert.equal(r.patch[0].path, 'api/mcp.mjs');
});

test('recorded replies: an unparseable reply, then the next free engine answers', async () => {
  const x = replay('mistral-unparseable', 'free-edits');
  const r = await run(x.fetchImpl);
  assert.equal(r.status, 'done', r.error);
  assert.deepEqual(r.stages.build.attempts.map((t) => t.outcome), ['no_json', 'ok']);
});

test('recorded replies: cut off, then unparseable: fails with the reason, the raw reply kept, no paid call', async () => {
  const x = replay('groq-cut-off', 'mistral-unparseable');
  const r = await run(x.fetchImpl, { ...FREE_ENV, PG1_LAB_ANTHROPIC_API_KEY: 'paid-key-0000000000000' });
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.stages.build.attempts.map((t) => t.outcome), ['truncated', 'no_json']);
  assert.equal(r.stages.build.failure, 'no_json');
  assert.match(r.error, /^build: the reply held no JSON object \(it began: "I would make the error message/);
  assert.match(r.build_reply.text, /^I would make the error message/);
  assert.equal(r.stages.build.paid_build, 'off');
  assert.equal(x.calls.filter((c) => c.host === 'api.anthropic.com').length, 0);
  assert.match(labNextStep({ status: r.status, error: r.error, result: r }), /PG1_LAB_PAID_BUILD=on/);
});
