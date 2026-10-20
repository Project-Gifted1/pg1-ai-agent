/**
 * Lab failures hidden behind a green workflow (19 Oct: lab runs 2-8 all
 * "completed successfully" while /api/hooks/github logged "[lab] ingested
 * id=aef41455 status=failed spent_usd=0", 65ff6fc9 and a2d54017).
 *
 *   - root cause: the lab's Claude key was out of credit (400 "credit
 *     balance is too low") and the paid Gemini key over its monthly
 *     spending cap (429); non-search calls (the build stage) went to Claude
 *     only, never Gemini, and the error kept only "anthropic 400
 *     invalid_request_error". Now each call falls back to the other engine
 *     on a capacity failure and the error says why each refused;
 *   - scripts/lab-run.mjs exits 1 when a run does not end done, and the
 *     verdict job (scripts/lab-verdict.mjs) fails the run when the
 *     experiment or its test run failed: the run shows red;
 *   - /lab status, the lab card and the living lab show the failing stage
 *     and its error.
 *
 * Run with: node --test tests/lab-failures.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, readFileSync as read } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runExperiment, labRefusalReason } from '../lib/lab/runner.mjs';
import { main as labRun, verdictLine } from '../scripts/lab-run.mjs';
import { labVerdict, main as verdictMain } from '../scripts/lab-verdict.mjs';
import { signLabToken } from '../lib/lab/token.mjs';
import { labCardView, labFailure } from '../lib/lab/card.mjs';
import { statusSummary } from '../lib/lab/chat.mjs';
import { labSceneState } from '../lib/labScene.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ID = 'aef41455-207c-4a26-960f-5d28111fafe9';
const CLAUDE_CREDIT = () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } }), { status: 400 });
const GEMINI_CAP = () => new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Your project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend.' } }), { status: 429 });
const gemini = (text) => Response.json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } });
const ENV = { PG1_LAB_ANTHROPIC_API_KEY: 'sk-ant-lab', PG1_LAB_GEMINI_API_KEY: 'AQ.lab' };
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

// --- the root cause ---------------------------------------------------------------------

test('reproduced: both lab engines refuse, the run fails in milliseconds with nothing spent, and the error now says why each refused', async () => {
  const fetchImpl = async (u) => (String(u).includes('anthropic') ? CLAUDE_CREDIT() : GEMINI_CAP());
  const skill = await runExperiment({ id: ID, kind: 'skill', goal: 'e1c7b356 build it.', env: ENV, budgetUsd: 2, fetchImpl, lookup });
  assert.equal(skill.status, 'failed');
  assert.equal(skill.spent_usd, 0);
  assert.equal(skill.error, 'build: model call failed (anthropic 400 out of credit); (gemini 429 monthly spending cap reached)');
  const code = await runExperiment({ id: ID, kind: 'code', goal: 'e1c7b356 build it.', env: ENV, budgetUsd: 2, fetchImpl, lookup });
  assert.equal(code.error, 'research: model call failed (gemini 429 monthly spending cap reached); (anthropic 400 out of credit)');
});

test('fixed: Claude out of credit, the build stage goes on to Gemini and the run is done', async () => {
  const calls = [];
  const skillJson = JSON.stringify({ name: 'wallet-triage', description: 'When the operator asks to triage a wallet.', instructions: '1. Run the wallet checks.\n2. Summarise.\nPitfalls: none.\nPreferences: short.', evals: [{ prompt: 'triage 0xabc', traits: ['names the checks'] }] });
  const fetchImpl = async (u, o) => {
    const url = String(u);
    calls.push(url.includes('anthropic') ? 'anthropic' : 'gemini');
    if (url.includes('anthropic')) return CLAUDE_CREDIT();
    const body = JSON.parse(o.body);
    const sys = body.systemInstruction.parts[0].text;
    if (/draft a reusable skill/.test(sys)) return gemini(skillJson);
    if (/grade an answer/.test(sys)) return gemini(JSON.stringify({ traits: [{ trait: 'names the checks', pass: true, why: 'it does' }] }));
    return gemini('I would run check_wallet_age and screen_wallet_sanctions, then summarise.');
  };
  const r = await runExperiment({ id: ID, kind: 'skill', goal: 'a wallet triage skill', env: ENV, budgetUsd: 2, fetchImpl, lookup });
  assert.equal(r.status, 'done', r.error);
  assert.ok(calls.includes('anthropic') && calls.includes('gemini'), 'Claude first, then Gemini');
  assert.ok(r.spent_usd > 0);
});

test('the refusal reason: credit, spending cap, rate limit, bad key, outage; never a key value', () => {
  assert.equal(labRefusalReason('anthropic', 400, { error: { message: 'Your credit balance is too low' } }), 'anthropic 400 out of credit');
  assert.equal(labRefusalReason('gemini', 429, { error: { message: 'Your project has exceeded its monthly spending cap.' } }), 'gemini 429 monthly spending cap reached');
  assert.equal(labRefusalReason('gemini', 429, { error: { message: 'Please retry in 7s.' } }), 'gemini 429 rate limited');
  assert.equal(labRefusalReason('anthropic', 401, { error: { type: 'authentication_error' } }), 'anthropic 401 key not accepted');
  assert.equal(labRefusalReason('anthropic', 529, { error: { type: 'overloaded_error' } }), 'anthropic 529 engine unavailable');
  assert.equal(labRefusalReason('gemini', 400, { error: { message: 'API key AIzaSECRET123 not valid. Please pass a valid key.' } }), 'gemini 400 API key [key] not valid.');
});

// --- the exit code -------------------------------------------------------------------------

async function runScript(fetchImpl, kind = 'skill') {
  const out = mkdtempSync(path.join(tmpdir(), 'lab-out-'));
  const secret = 'lab-dispatch-secret-0123456789';
  const goal = 'e1c7b356 build it.';
  const token = signLabToken({ id: ID, kind, budgetUsd: 2, goal, input: '', secret });
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(String(l));
  try {
    const code = await labRun({ ...ENV, LAB_ID: ID, LAB_KIND: kind, LAB_GOAL: goal, LAB_INPUT: '', LAB_BUDGET_USD: '2', LAB_TOKEN: token, PG1_LAB_DISPATCH_SECRET: secret }, { fetchImpl, out });
    return { code, lines, result: JSON.parse(read(path.join(out, 'result.json'), 'utf8')), out };
  } finally { console.log = orig; }
}

test('lab-run exits 1 when the run ends failed, and logs the stage and the reason', async () => {
  const { code, lines, result } = await runScript(async (u) => (String(u).includes('anthropic') ? CLAUDE_CREDIT() : GEMINI_CAP()));
  assert.equal(code, 1, 'the experiment job fails: the run shows red');
  assert.equal(result.status, 'failed');
  assert.ok(lines.includes('[lab] id=aef41455 kind=skill status=failed stage=build error=model call failed (anthropic 400 out of credit); (gemini 429 monthly spending cap reached) spent_usd=0'), lines.join('\n'));
});

test('the verdict job: red for a failed run, a failed lab test run or no result; green for done', () => {
  assert.equal(labVerdict({ id: ID, kind: 'skill', status: 'failed', error: 'build: x' }).ok, false);
  assert.equal(labVerdict({ id: ID, kind: 'research', status: 'timeout', error: 'research: the experiment ran out of time' }).ok, false);
  const tests = labVerdict({ id: ID, kind: 'code', status: 'done', code: { tests: { passed: false, summary: '# tests 10\n# fail 1\nnot ok 3 - x' } } });
  assert.equal(tests.ok, false);
  assert.match(tests.line, /stage=test error=the lab's test run failed: # fail 1 \| not ok 3 - x/);
  assert.equal(labVerdict(null).ok, false);
  assert.equal(labVerdict({ id: ID, kind: 'code', status: 'done', code: { tests: { passed: true } } }).ok, true);
  assert.equal(verdictMain('/nonexistent/result.json'), 1);
  assert.equal(verdictLine({ id: ID, kind: 'skill', status: 'done', spent_usd: 0.4 }), '[lab] id=aef41455 kind=skill status=done spent_usd=0.4');
});

test('lab.yml: a verdict job runs last whatever happened and fails the run from the result artifact; it names no secret', () => {
  const yml = readFileSync(path.join(ROOT, '.github/workflows/lab.yml'), 'utf8');
  const verdict = yml.slice(yml.indexOf('\n  verdict:'), yml.indexOf('\n  notify:'));
  assert.match(verdict, /needs: \[experiment, test, pull, notify\]/);
  assert.match(verdict, /if: always\(\)/);
  assert.match(verdict, /run: node scripts\/lab-verdict\.mjs lab-out\/result\.json/);
  assert.doesNotMatch(verdict, /secrets\./);
  assert.doesNotMatch(verdict, /continue-on-error: true\n\s+run: node scripts\/lab-verdict/, 'the verdict step itself may fail the run');
  assert.doesNotMatch(readFileSync(path.join(ROOT, 'scripts/lab-run.mjs'), 'utf8'), /\? 0 : 0/);
});

test('the verdict job runs with no npm install: lab-verdict.mjs imports node: built-ins only and runs on its own (#352)', () => {
  const src = readFileSync(path.join(ROOT, 'scripts/lab-verdict.mjs'), 'utf8');
  const specifiers = [...src.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(specifiers.length > 0);
  assert.deepEqual(specifiers.filter((s) => !s.startsWith('node:')), [], 'only node: built-ins');
  // The exact failure on GitHub: the script alone, with no node_modules and
  // no other repo file next to it.
  const dir = mkdtempSync(path.join(tmpdir(), 'lab-verdict-'));
  writeFileSync(path.join(dir, 'lab-verdict.mjs'), src);
  writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ id: ID, kind: 'skill', status: 'failed', spent_usd: 0, error: 'build: model call failed (anthropic 400 out of credit)' }));
  const r = spawnSync(process.execPath, [path.join(dir, 'lab-verdict.mjs'), path.join(dir, 'result.json')], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /\[lab\] id=aef41455 kind=skill status=failed stage=build error=model call failed/);
  assert.doesNotMatch(r.stderr, /ERR_MODULE_NOT_FOUND/);
  writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ id: ID, kind: 'skill', status: 'done', spent_usd: 0.4 }));
  assert.equal(spawnSync(process.execPath, [path.join(dir, 'lab-verdict.mjs'), path.join(dir, 'result.json')], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } }).status, 0);
});

// --- the status display -----------------------------------------------------------------

const FAILED = { id: ID, kind: 'skill', goal: 'e1c7b356 build it.', status: 'failed', budget_usd: 2, spent_usd: 0, error: 'build: model call failed (anthropic 400 out of credit); (gemini 429 monthly spending cap reached)' };

test('/lab status and the card show the failing stage and its error', () => {
  assert.deepEqual(labFailure(FAILED), { stage: 'build', message: 'model call failed (anthropic 400 out of credit); (gemini 429 monthly spending cap reached)' });
  const card = labCardView(FAILED, { actions: true });
  assert.deepEqual(card.failure, labFailure(FAILED));
  assert.equal(card.stages.find((s) => s.name === 'build').state, 'failed');
  assert.equal(labCardView({ ...FAILED, status: 'running', error: null }).failure, undefined, 'no failure while it runs');
  const text = statusSummary([FAILED, { id: '65ff6fc9-0000-4000-8000-000000000000', kind: 'research', status: 'done', goal: 'g' }]);
  assert.match(text, /1 failed, 1 done/);
  assert.match(text, /Stopped: aef41455 failed at \*\*build\*\* \(model call failed \(anthropic 400 out of credit\); \(gemini 429 monthly spending cap reached\)\)\./);
  assert.doesNotMatch(text, /^- /m, 'words, not a list repeating the cards');
});

test('the living lab state carries the failing stage and error for a stopped experiment, nothing for the rest', async () => {
  const now = Date.parse('2026-10-19T19:10:00Z');
  const fetchImpl = async (url) => {
    const u = decodeURIComponent(String(url));
    if (u.includes('pg1_lab_experiments')) return Response.json([{ ...FAILED, updated_at: '2026-10-19T19:09:25Z' }, { id: 'c9d0e1f2-0000-4000-8000-000000000000', kind: 'research', status: 'running', updated_at: '2026-10-19T19:09:00Z' }]);
    return Response.json([]);
  };
  const scene = await labSceneState({ supUrl: 'https://supabase.test', supKey: 'k', fetchImpl, env: {}, now });
  assert.deepEqual(scene.experiments, [
    { id8: 'aef41455', status: 'failed', stage: 'build', error: 'model call failed (anthropic 400 out of credit); (gemini 429 monthly spending cap reached)' },
    { id8: 'c9d0e1f2', status: 'running' }
  ]);
  assert.equal(scene.mode, 'error');
  assert.ok(!JSON.stringify(scene).includes('e1c7b356 build it'), 'never the goal');
});
