// A lab's kind, its required stages and "done" (lib/lab/policy.mjs
// classifyLabKind, lib/lab/chat.mjs verdictFor and the gate phase,
// lib/lab/card.mjs).
//
//   - build work (implement, build, prototype, draft a tool...) is a code
//     experiment, whatever kind it was asked as: the five real labs that
//     ended as research-only (e1c7b356, e2f6594e, 74cdef04, 45a8b26f,
//     e2981021) would now be code experiments
//   - "done" only when every stage the kind requires passed; research-only
//     is done only for a research experiment
//   - empty research fails the experiment, never "done"
//   - a code experiment waits on the gate (CI) as "running", then ends as
//     done (gate passed) or failed (gate failed)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyLabKind } from '../lib/lab/policy.mjs';
import { verdictFor, handleLabCommand, parseLabCommand } from '../lib/lab/chat.mjs';
import { labCardView } from '../lib/lab/card.mjs';
import { honestReply } from '../lib/honestActions.mjs';
import { unzip } from '../lib/lab/unzip.mjs';
import { makeLabWorld } from './helpers/labWorld.mjs';

const REAL_TITLES = {
  e1c7b356: 'Implement sanitized demand tracking middleware and Supabase metric counters from research e2f6594e',
  e2f6594e: 'Prototype sanitized demand tracking for MCP queries (aggregated counters per tool)',
  '74cdef04': 'build verify_agent_delegation',
  '45a8b26f': 'prototype lightweight threat feed UI component',
  e2981021: 'research and draft agent auth scope preflight check MCP tool'
};

test('kind: every title that implements, builds or prototypes code is a code experiment', () => {
  for (const [id, title] of Object.entries(REAL_TITLES)) assert.equal(classifyLabKind(title), 'code', `${id}: ${title}`);
  for (const t of ['add a CVE batch size check to the playground', 'write a parser for the EU sanctions XML', 'refactor the feed reader', 'create an endpoint for watchlist exports']) assert.equal(classifyLabKind(t), 'code', t);
  for (const t of ['Compare two public CVE feeds for freshness', 'Survey every public phishing list', 'check NVD licence terms', 'which wallet screening sources allow resale?', 'hostname reputation']) assert.equal(classifyLabKind(t), 'research', t);
  for (const t of ['Draft a skill that explains a KEV entry in plain words', 'a phishing triage skill']) assert.equal(classifyLabKind(t), 'skill', t);
  // /lab start with no --kind, and the Start experiment button
  for (const title of Object.values(REAL_TITLES)) assert.equal(parseLabCommand(`/lab start ${title}`).opts.kind, 'code', title);
  const button = honestReply('I am starting the experiment now.', { prompt: 'start an experiment to prototype lightweight threat feed UI component', isOperator: true }).actions[0];
  assert.equal(button.command, '/lab start --kind code prototype lightweight threat feed ui component');
});

const FINDINGS = '## Findings\nMCP leaves tool-level authorization to servers; a preflight check can compare granted scopes with a plan.';

test('done needs every stage the kind requires: research-only is done only for a research experiment', () => {
  const research = { status: 'done', report_markdown: FINDINGS, stages: { research: { ok: true, chars: FINDINGS.length } }, spent_usd: 0.01 };
  assert.equal(verdictFor({ kind: 'research', goal: 'g' }, research).status, 'done');
  // The same research-only result for a code experiment: build never ran.
  const asCode = verdictFor({ kind: 'code', goal: REAL_TITLES.e2981021 }, research);
  assert.equal(asCode.status, 'failed');
  assert.equal(asCode.error, 'build: no proposed change');
  // Tests failed, or passed with no draft PR: not done.
  const built = { ...research, stages: { research: { ok: true }, build: { ok: true, files: 1 } }, code: { files: ['lib/x.mjs'] } };
  assert.equal(verdictFor({ kind: 'code', goal: 'g' }, built).error, 'test: no test result from the lab test run');
  assert.equal(verdictFor({ kind: 'code', goal: 'g' }, { ...built, code: { files: ['lib/x.mjs'], tests: { passed: false } } }).error, 'test: the lab test run failed');
  assert.match(verdictFor({ kind: 'code', goal: 'g' }, { ...built, code: { files: ['lib/x.mjs'], tests: { passed: true }, pr_error: 'GitHub 403' } }).error, /^test: the tests passed but no draft PR was opened \(GitHub 403\)/);
  // Every runner and workflow stage passed: the gate is still ahead.
  assert.equal(verdictFor({ kind: 'code', goal: 'g' }, { ...built, code: { files: ['lib/x.mjs'], tests: { passed: true }, pr_number: 9 } }).status, 'running');
  assert.equal(verdictFor({ kind: 'code', goal: '[foundry] tool' }, { ...built, code: { files: ['lib/x.mjs'], tests: { passed: true }, pr_number: 9 } }).status, 'done', 'a Foundry build is gated by /foundry approve');
  // A skill: a failing eval fails the test stage.
  assert.equal(verdictFor({ kind: 'skill', goal: 'g' }, { status: 'done', skill_drafts: [{ name: 's' }], evals: [{ pass: true }, { pass: false }] }).error, 'test: 1 of 2 evals passed');
});

test('empty or failed research marks the lab failed, never done', () => {
  for (const report of ['', '   ', 'ok', '## Findings\n']) {
    const v = verdictFor({ kind: 'research', goal: 'g' }, { status: 'done', report_markdown: report, spent_usd: 0.01 });
    assert.equal(v.status, 'failed', JSON.stringify(report));
    assert.match(v.error, /^research: /);
  }
  // The runner's own verdict wins over its "done"
  assert.equal(verdictFor({ kind: 'research', goal: 'g' }, { status: 'done', report_markdown: FINDINGS, stages: { research: { ok: false, reason: 'the model returned no findings (empty answer)' } } }).error, 'research: the model returned no findings (empty answer)');
  assert.equal(verdictFor({ kind: 'research', goal: 'g' }, { status: 'failed', error: 'research: model call failed (gemini 503)' }).status, 'failed');
  assert.equal(verdictFor({ kind: 'research', goal: 'g' }, { status: 'weird' }).status, 'failed');
});

test('the real e2981021 result: research ran (one grounded call, 10 sources); as a code experiment it would end failed at build, not done', () => {
  const result = JSON.parse(unzip(readFileSync(new URL('./fixtures/lab-result-e2981021.zip', import.meta.url))).get('result.json').toString('utf8'));
  assert.equal(result.kind, 'research');
  assert.equal(result.calls, 1);
  assert.equal(result.spent_usd, 0.012074);
  assert.equal(result.sources.length, 10);
  assert.ok(result.report_markdown.length > 3000);
  assert.equal(verdictFor({ kind: 'research', goal: result.goal }, result).status, 'done', 'as dispatched (research), its findings are real');
  const code = verdictFor({ kind: classifyLabKind(result.goal), goal: result.goal }, result);
  assert.deepEqual([code.status, code.error], ['failed', 'build: no proposed change']);
  assert.equal(code.stages.research.ok, true);
  assert.deepEqual(labCardView({ id: result.id, kind: 'code', goal: result.goal, status: code.status, error: code.error }).stages.map((s) => s.state), ['done', 'failed', 'todo', 'todo']);
});

const SUP = { supUrl: 'https://supabase.test', supKey: 'k' };
const ENV = { PG1_DAILY_SPEND_CAP_USD: '1000', PG1_LAB_DISPATCH_SECRET: 'x'.repeat(40), GITHUB_TOKEN: 'ghp_x', PG1_AUTONOMY: 'lab', PG1_LAB_DAILY_USD: '20' };
const MIGRATIONS = ['20261019120000_pg1_skills.sql', '20261020120000_pg1_lab_and_flags.sql', '20261021120000_pg1_autonomy_log.sql'];
const codeResult = (pr) => ({ kind: 'code', spent_usd: 0.3, calls: 2, report_markdown: `## Research\n${FINDINGS}\n\n## Code change\nadds it`, stages: { research: { ok: true, chars: 120, sources: 2, calls: 1 }, build: { ok: true, files: 2 } }, code: { branch: 'lab/x', title: 't', summary: 's', files: ['lib/delegation.mjs', 'tests/delegation.test.mjs'], tests: { passed: true, summary: '# pass 2' }, pr_number: pr, pr_url: `https://github.com/Project-Gifted1/pg1-ai-agent/pull/${pr}` } });

test('a code experiment runs research, build, test and the gate: "running" while CI is out, then done (passed) or failed (gate failed)', async () => {
  const { db, gh, fetchImpl } = await makeLabWorld(MIGRATIONS);
  const lab = (text) => handleLabCommand({ text, env: ENV, ...SUP, fetchImpl, isOperator: true });
  const started = await lab(`/lab start ${REAL_TITLES['74cdef04']}`);
  assert.match(started.reply, /queued \(code, budget/);
  assert.equal(gh.dispatches[0].inputs.kind, 'code');
  // Research, build and the lab's test run passed, the draft PR is open,
  // CI has not reported: the gate waits; the experiment is not done.
  const id = gh.finish(codeResult(51));
  let s = await lab('/lab status');
  let card = s.labCards.find((c) => c.id.startsWith(id.slice(0, 8)));
  assert.equal(card.status, 'running');
  assert.deepEqual(card.stages.map((x) => x.state), ['done', 'done', 'current', 'todo']);
  assert.equal((await db.query('select count(*)::int as n from public.pg1_ai_usage')).rows[0].n, 1, 'the spend is recorded once');
  // CI green: the gate passes, the experiment is done, the card is asked for.
  gh.checks.set(51, [{ name: 'npm test', status: 'completed', conclusion: 'success' }]);
  s = await lab('/lab status');
  card = s.labCards.find((c) => c.id.startsWith(id.slice(0, 8)));
  assert.equal(card.status, 'done');
  assert.deepEqual(card.stages.map((x) => x.state), ['done', 'done', 'done', 'done']);
  assert.ok(s.pendingApproval && s.pendingApproval.token);
  assert.equal((await db.query('select count(*)::int as n from public.pg1_ai_usage')).rows[0].n, 1, 'still recorded once');

  // A second one whose CI fails: failed at the gate, never done.
  await lab('/lab start prototype lightweight threat feed UI component');
  const id2 = gh.finish(codeResult(52), 990);
  gh.checks.set(52, [{ name: 'npm test', status: 'completed', conclusion: 'failure' }]);
  s = await lab('/lab status');
  card = s.labCards.find((c) => c.id.startsWith(id2.slice(0, 8)));
  assert.equal(card.status, 'failed');
  assert.deepEqual(card.stages.map((x) => x.state), ['done', 'done', 'done', 'failed']);
  const { rows } = await db.query('select status, error from public.pg1_lab_experiments where id = $1', [id2]);
  assert.match(rows[0].error, /^gate: evals \(CI failure/);

  // A code experiment whose runner returned research only (no change): failed at build.
  await lab('/lab start build verify_agent_delegation again');
  const id3 = gh.finish({ kind: 'code', spent_usd: 0.01, calls: 1, report_markdown: FINDINGS }, 991);
  s = await lab('/lab status');
  card = s.labCards.find((c) => c.id.startsWith(id3.slice(0, 8)));
  assert.equal(card.status, 'failed');
  assert.deepEqual(card.stages.map((x) => x.state), ['done', 'failed', 'todo', 'todo']);

  // Empty research: failed, with the reason in the report.
  await lab('/lab start compare two CVE feeds for freshness');
  const id4 = gh.finish({ kind: 'research', spent_usd: 0.01, calls: 1, report_markdown: '' }, 992);
  s = await lab('/lab status');
  assert.equal(s.labCards.find((c) => c.id.startsWith(id4.slice(0, 8))).status, 'failed');
  const report = await lab(`/lab report ${id4.slice(0, 8)}`);
  assert.match(report.reply, /^### \[ LAB [0-9a-f]{8} · research · failed \]/);
  assert.match(report.reply, /research: no findings: the research step returned an empty answer/);

  // Each lab once, newest first, each with its own Report button.
  assert.deepEqual(s.labCards.map((c) => c.id), [id4, id3, id2, id]);
  assert.ok(s.labCards.every((c) => c.actions.filter((a) => a.command === `/lab report ${c.id8}`).length === 1));
  assert.match(s.reply, /^\*\*Lab\*\*: the latest 4 experiments: /);
  assert.doesNotMatch(s.reply, /^- [0-9a-f]{8} · /m, 'no text list repeats the cards');
});

test('a run stopped short of its budget reports "near budget" with its threshold', async () => {
  const { db, gh, fetchImpl } = await makeLabWorld(MIGRATIONS);
  const lab = (text) => handleLabCommand({ text, env: ENV, ...SUP, fetchImpl, isOperator: true });
  await lab('/lab start survey every public phishing list');
  const id = gh.finish({ kind: 'research', status: 'over_budget', spent_usd: 1.94, calls: 9, error: 'research: the next call could cost up to $0.0700, over this experiment\'s $2 budget ($1.9400 spent)', budget_stop: { spent_usd: 1.94, next_call_worst_usd: 0.07, threshold_usd: 1.93, budget_usd: 2 } });
  const s = await lab('/lab status');
  const card = s.labCards.find((c) => c.id === id);
  assert.equal(card.label, 'near budget');
  assert.equal(card.threshold_usd, 1.93);
  assert.match(s.reply, /1 near budget/);
  const report = await lab(`/lab report ${id.slice(0, 8)}`);
  assert.match(report.reply, /^### \[ LAB [0-9a-f]{8} · research · near_budget \]/);
  assert.match(report.reply, /Stopped at its stop threshold of \$1\.93: the next call could have cost up to \$0\.07\./);
  assert.equal((await db.query('select status from public.pg1_lab_experiments')).rows[0].status, 'over_budget');
});

test('migrations: old "done" research rows with no findings become failed; fixture indicators leave the live table', async () => {
  const { makeDb } = await import('./helpers/pgrest.mjs');
  const sql = (f) => readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8');
  const db = await makeDb(['20261020120000_pg1_lab_and_flags.sql']);
  const ins = (id, kind, status, result) => db.query('insert into public.pg1_lab_experiments (id, kind, goal, status, budget_usd, spent_usd, result) values ($1, $2, $3, $4, 2, 0.01, $5)', [id, kind, 'g', status, JSON.stringify(result)]);
  await ins('74cdef04-5769-40cc-b467-704d7d88a442', 'research', 'done', { status: 'done', report_markdown: '' });
  await ins('e2981021-4070-40fd-b160-e012feec0449', 'research', 'done', { status: 'done', report_markdown: FINDINGS });
  await ins('0c0c0c0c-0000-4000-8000-000000000000', 'research', 'done', { status: 'done', report_markdown: '## Opportunity scan', proposals: [{ title: 'x' }] });
  await ins('0d0d0d0d-0000-4000-8000-000000000000', 'code', 'done', { status: 'done' });
  await db.exec(sql('20261030130000_lab_empty_research_failed.sql'));
  const { rows } = await db.query('select left(id::text, 8) as id, status, error from public.pg1_lab_experiments order by id');
  assert.deepEqual(rows.map((r) => [r.id, r.status]), [['0c0c0c0c', 'done'], ['0d0d0d0d', 'done'], ['74cdef04', 'failed'], ['e2981021', 'done']]);
  assert.match(rows.find((r) => r.id === '74cdef04').error, /^research: no findings/);

  await db.exec('create table public.threat_ioc_telemetry (id bigint generated always as identity primary key, value text, indicator_type text, verification_source text)');
  const values = ['evil.example', 'https://evil.example/x', 'pg1-test-flagged.invalid', 'www.example.com', '198.51.100.3', '2001:db8::1', 'CVE-0000-0001', 'CVE-2026-41001', 'examples.com', '8.8.8.8', 'nvd.nist.gov'];
  for (const v of values) await db.query('insert into public.threat_ioc_telemetry (value, indicator_type, verification_source) values ($1, $2, $3)', [v, 'x', 'NVD']);
  await db.exec(sql('20261030120000_drop_reserved_test_indicators.sql'));
  const left = (await db.query('select value from public.threat_ioc_telemetry order by id')).rows.map((r) => r.value);
  assert.deepEqual(left, ['CVE-2026-41001', 'examples.com', '8.8.8.8', 'nvd.nist.gov']);
  // Where the table does not exist, both do nothing.
  const empty = await makeDb([]);
  await empty.exec(sql('20261030120000_drop_reserved_test_indicators.sql'));
  await empty.exec(sql('20261030130000_lab_empty_research_failed.sql'));
});
