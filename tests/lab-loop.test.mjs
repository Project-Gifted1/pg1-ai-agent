/**
 * The living lab (lib/lab/loop.mjs, lib/lab/agenda.mjs, lib/lab/freeSearch.mjs,
 * the Autonomous tick's step 5):
 *   1. a $0 lab run uses only the free engines, so its estimate is $0 and
 *      the $0 Autonomous budget never refuses it; a paid run carries the
 *      lab's budget
 *   2. the loop: one experiment at a time, a gap, a daily cap, backing off
 *      while the free engines cool down or after quota failures
 *   3. the agenda is built from the earlier experiments (fixture), with no
 *      duplicates; lessons from finished research; gated experiments left
 *      as they are
 *   4. a continued experiment receives its earlier findings
 *   5. free search: public APIs (mocked), every finding cited
 *   6. nothing reaches main without the gate and /promote
 *
 * No network: every API is a stub; DNS is a stub lookup.
 *
 * Run with: node --test tests/lab-loop.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loopDecision, labEstimateUsd, labGapMinutes, labMaxPerDay, freeEnginesCooling, DEFAULT_LAB_GAP_MINUTES, DEFAULT_LAB_MAX_PER_DAY } from '../lib/lab/loop.mjs';
import { agendaFromHistory, syncAgenda, createAgendaStore, pickNext, contextFor, goalKey, ownAgendaItems, __resetAgenda, MAX_ATTEMPTS } from '../lib/lab/agenda.mjs';
import { freeSearch, searchTerms, __resetFreeSearch, HOST_GAP_MS } from '../lib/lab/freeSearch.mjs';
import { runExperiment } from '../lib/lab/runner.mjs';
import { handleLabCommand, handleLabApproval, parseLabCommand } from '../lib/lab/chat.mjs';
import { createLessonStore, __resetLessons } from '../lib/core/reflect.mjs';
import { createAutonomousStore, runAutonomousAction, switchOn, __resetAutonomousSnapshot } from '../lib/autonomous/state.mjs';
import { autonomousTick } from '../lib/autonomous/runner.mjs';
import { createAutonomousDb } from './helpers/autonomousDb.mjs';
import { makeLabWorld } from './helpers/labWorld.mjs';
import { __resetRouterState } from '../lib/aiRouter.mjs';
import { coolDown } from '../lib/router/quota.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUP = 'https://supabase.test';
const MIN = 60000;
const NOW = Date.UTC(2026, 9, 28, 15, 0);
const iso = (ms) => new Date(ms).toISOString();
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORIGINAL_ENV = { ...process.env };
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

beforeEach(() => { __resetAgenda(); __resetLessons(); __resetFreeSearch(); __resetAutonomousSnapshot(); __resetRouterState(); });
after(() => { process.env = { ...ORIGINAL_ENV }; });

// --- 1. the estimate -----------------------------------------------------------------------

test('1: a $0 lab run is estimated at $0 and is not refused by the $0 Autonomous budget; a paid one carries the lab budget and is', async () => {
  assert.equal(labEstimateUsd({}), 0, 'PG1_DAILY_SPEND_CAP_USD unset: free engines only');
  assert.equal(labEstimateUsd({ PG1_DAILY_SPEND_CAP_USD: '0' }), 0);
  assert.equal(labEstimateUsd({ PG1_DAILY_SPEND_CAP_USD: '5' }), 2);
  assert.equal(labEstimateUsd({ PG1_DAILY_SPEND_CAP_USD: '5', PG1_LAB_BUDGET_USD: '1.5' }), 1.5);
  const db = createAutonomousDb();
  const store = createAutonomousStore({ supUrl: 'https://auto.test', supKey: 'k', fetchImpl: db.fetch });
  await switchOn(store);
  const free = await runAutonomousAction({ store, type: 'lab_autopilot', estimateUsd: labEstimateUsd({}), run: async () => ({ ok: true, result: 'started' }) });
  assert.equal(free.status, 'done', 'not refused at $0');
  const paid = await runAutonomousAction({ store, type: 'lab_autopilot', estimateUsd: labEstimateUsd({ PG1_DAILY_SPEND_CAP_USD: '5' }), run: async () => ({ ok: true }) });
  assert.equal(paid.status, 'refused');
});

// --- 2. the loop ----------------------------------------------------------------------------

test('2: the loop runs one at a time, keeps the gap, stops at the daily cap and backs off while engines cool down', () => {
  assert.equal(labGapMinutes({}), DEFAULT_LAB_GAP_MINUTES);
  assert.equal(labGapMinutes({ PG1_LAB_GAP_MINUTES: '3' }), 3);
  assert.equal(labMaxPerDay({}), DEFAULT_LAB_MAX_PER_DAY);
  const ended = (n, agoMin, extra = {}) => ({ id: uuid(n), created_at: iso(NOW - (agoMin + 5) * MIN), updated_at: iso(NOW - agoMin * MIN), status: 'done', ...extra });
  // Nothing yet: go.
  assert.equal(loopDecision({ rows: [], now: NOW, env: {} }).go, true);
  // One at a time: a queued or running experiment holds the loop.
  const busy = loopDecision({ rows: [{ id: uuid(1), created_at: iso(NOW - MIN), status: 'running' }], now: NOW, env: {} });
  assert.equal(busy.go, false);
  assert.match(busy.reason, /one at a time/);
  assert.equal(loopDecision({ rows: [{ id: uuid(1), created_at: iso(NOW - MIN), status: 'queued' }], now: NOW, env: {} }).go, false);
  // A code experiment waiting on CI for its gate does not hold the loop.
  assert.equal(loopDecision({ rows: [{ id: uuid(1), created_at: iso(NOW - 60 * MIN), updated_at: iso(NOW - 30 * MIN), status: 'running', candidate: { type: 'code' } }], now: NOW, env: {} }).go, true);
  // The gap.
  const tooSoon = loopDecision({ rows: [ended(1, 4)], now: NOW, env: {} });
  assert.equal(tooSoon.go, false);
  assert.match(tooSoon.reason, /the gap: 10 minutes/);
  assert.equal(tooSoon.waitUntil, NOW + 6 * MIN);
  assert.equal(loopDecision({ rows: [ended(1, 11)], now: NOW, env: {} }).go, true);
  assert.equal(loopDecision({ rows: [ended(1, 4)], now: NOW, env: { PG1_LAB_GAP_MINUTES: '3' } }).go, true);
  // The daily cap (24 today, whoever started them).
  const today = Array.from({ length: 24 }, (_, i) => ended(i + 1, 30 + i));
  const capped = loopDecision({ rows: today, now: NOW, env: {} });
  assert.equal(capped.go, false);
  assert.match(capped.reason, /the daily cap: 24 of 24/);
  assert.equal(loopDecision({ rows: today, now: NOW, env: { PG1_LAB_MAX_PER_DAY: '30' } }).go, true);
  // Yesterday's do not count.
  assert.equal(loopDecision({ rows: today.map((r) => ({ ...r, created_at: iso(NOW - 20 * 3600000) })), now: NOW, env: {} }).go, true);
  // Cooling: the free engines' quota cool-downs.
  const cooling = loopDecision({ rows: [ended(1, 60)], now: NOW, env: {}, cooling: { cooling: true, until: NOW + 30 * MIN } });
  assert.equal(cooling.go, false);
  assert.match(cooling.reason, /cooling down/);
  // Backing off after runs that hit a quota: the gap doubles each time.
  const quota = [ended(2, 25, { status: 'failed', error: 'research: model call failed (free engines: groq 429; gemini_free 429)' }), ended(1, 50, { status: 'failed', error: 'research: rate limited' })];
  const back = loopDecision({ rows: quota, now: NOW, env: {} });
  assert.equal(back.go, false);
  assert.match(back.reason, /backing off: the last 2 runs hit an engine's quota; waiting 40 minutes/);
  assert.equal(loopDecision({ rows: quota, now: NOW + 16 * MIN, env: {} }).go, true);
});

test('2: freeEnginesCooling reads the quota cool-downs of every free engine', () => {
  const env = { GROQ_API_KEY: 'free-groq' };
  assert.equal(freeEnginesCooling(env, NOW).cooling, false);
  coolDown('groq', '*', { scope: 'day', resetAt: NOW + 3600000 }, NOW);
  const c = freeEnginesCooling(env, NOW);
  assert.equal(c.cooling, true);
  assert.equal(c.until, NOW + 3600000);
  assert.equal(freeEnginesCooling({}, NOW).cooling, false, 'no free engine here: the lab runner has its own');
});

// --- 3. the agenda from history ----------------------------------------------------------------

const REPORT = (what) => `## Findings\n${what} The NVD feed is public domain [1]. It updates every two hours [2].\n## Sources and licences\n[1] https://nvd.nist.gov\n## Open questions\nnone`;
function fixture() {
  const at = (h) => iso(NOW - h * 3600000);
  const rows = [
    { id: uuid(1), created_at: at(90), updated_at: at(89), kind: 'research', goal: 'Which CVE feeds can PG1 resell?', status: 'failed', error: 'research: model call failed (free engines: groq 429)' },
    { id: uuid(2), created_at: at(80), updated_at: at(79), kind: 'research', goal: 'which CVE feeds can PG1 resell', status: 'timeout', error: 'research: the experiment ran out of time' },
    { id: uuid(3), created_at: at(70), updated_at: at(69), kind: 'code', goal: 'add a batch size check to the IOC route', status: 'over_budget', error: 'build: the next call could cost up to $0.30' },
    { id: uuid(4), created_at: at(60), updated_at: at(59), kind: 'research', goal: 'How fresh is the NVD feed?', status: 'done', skipped: [{ step: 'web search', reason: 'web search needs a paid engine' }] },
    { id: uuid(5), created_at: at(50), updated_at: at(49), kind: 'research', goal: 'What do agents pay for wallet screening?', status: 'done', skipped: null },
    { id: uuid(6), created_at: at(40), updated_at: at(39), kind: 'skill', goal: 'a CVE digest skill', status: 'done', gate: { pass: true, checks: [] }, promoted_stage: 'none', candidate: { type: 'skill' } },
    { id: uuid(7), created_at: at(30), updated_at: at(29), kind: 'research', goal: '[foundry] build the radar', status: 'failed', error: 'x' },
    { id: uuid(8), created_at: at(20), updated_at: at(19), kind: 'research', goal: 'Old idea the operator stopped', status: 'stopped' },
    { id: uuid(9), created_at: at(1), kind: 'research', goal: 'Running now', status: 'running' },
    { id: uuid(10), created_at: at(85), updated_at: at(84), kind: 'research', goal: 'What do agents pay for wallet screening', status: 'failed', error: 'research: rate limited' }
  ];
  const reports = new Map([[uuid(2), REPORT('Partial: three feeds looked at.')], [uuid(4), REPORT('Two-hour updates.')], [uuid(5), REPORT('Agents pay about $0.01 a check.')]]);
  return { rows, reports };
}

test('3: the agenda is built from the earlier experiments: continue items carry their findings, research becomes lessons, gated ones stay as they are, no duplicates', () => {
  const { rows, reports } = fixture();
  const { items, lessons } = agendaFromHistory(rows, { reports });
  const keys = items.map((i) => i.goal_key);
  assert.equal(new Set(keys).size, keys.length, 'one item per goal');
  const by = (g) => items.find((i) => i.goal_key === goalKey(g));
  // Two runs of the same goal (different case and punctuation): one item, from the latest (timeout).
  const cve = by('which cve feeds can pg1 resell');
  assert.equal(cve.status, 'open');
  assert.equal(cve.continued_from, uuid(2));
  assert.match(cve.notes, /^Continue from 00000002 \(timeout: research: the experiment ran out of time\)/);
  assert.match(cve.notes, /Previous findings:\nPartial: three feeds looked at\./);
  assert.equal(by('add a batch size check to the IOC route').status, 'open');
  assert.equal(by('add a batch size check to the IOC route').kind, 'code');
  assert.match(by('How fresh is the NVD feed?').notes, /the search was skipped/);
  assert.equal(by('How fresh is the NVD feed?').status, 'open');
  // A later done run of a goal that failed before: done, not continued.
  assert.equal(by('What do agents pay for wallet screening?').status, 'done');
  // Passed the gate, not promoted: done on the agenda; the experiment itself is untouched.
  assert.equal(by('a CVE digest skill').status, 'done');
  assert.equal(by('Old idea the operator stopped').status, 'dropped');
  assert.equal(by('Running now').status, 'running');
  assert.equal(by('Running now').experiment_id, uuid(9));
  assert.equal(items.some((i) => /foundry/.test(i.goal)), false, 'Foundry builds have their own approval');
  assert.equal(items.length, 7);
  assert.deepEqual(lessons.map((l) => l.source_event), [`lab:${uuid(5)}`]);
  assert.match(lessons[0].text, /^Lab finding \(00000005, What do agents pay for wallet screening\?\): Agents pay about \$0\.01 a check\./);
});

test('3: syncAgenda on the real table: built once from history, again with nothing new adds nothing; lessons once; the experiments are not touched', async () => {
  const { db, fetchImpl } = await makeLabWorld(['20261019120000_pg1_skills.sql', '20261020120000_pg1_lab_and_flags.sql', '20261109120000_pg1_core_state.sql', '20261112120000_pg1_lab_agenda.sql']);
  const { rows, reports } = fixture();
  for (const r of rows) {
    await db.query('insert into public.pg1_lab_experiments (id, created_at, updated_at, kind, goal, status, budget_usd, error, gate, candidate, result) values ($1, $2, $3, $4, $5, $6, 2, $7, $8, $9, $10)', [r.id, r.created_at, r.updated_at || r.created_at, r.kind, r.goal, r.status, r.error || null, r.gate ? JSON.stringify(r.gate) : null, r.candidate ? JSON.stringify(r.candidate) : null, JSON.stringify({ report_markdown: reports.get(r.id) || '', ...(r.skipped ? { skipped: r.skipped } : {}) })]);
  }
  const before = (await db.query('select id, status, gate, promoted_stage, candidate, error from public.pg1_lab_experiments order by id')).rows;
  const { createLabStore } = await import('../lib/lab/store.mjs');
  const labStore = createLabStore({ supUrl: SUP, supKey: 'k', fetchImpl });
  const history = await labStore.history(100);
  assert.equal(history.length, rows.length);
  assert.deepEqual(history.find((h) => h.id === uuid(4)).skipped.map((s) => s.step), ['web search']);
  const agenda = createAgendaStore({ supUrl: SUP, supKey: 'k', fetchImpl, now: () => NOW });
  const lessons = createLessonStore({ supUrl: SUP, supKey: 'k', fetchImpl, now: () => NOW });
  const first = await syncAgenda({ agenda, history, reportsFor: (ids) => labStore.reports(ids), lessons });
  assert.equal(first.seeded, true);
  assert.equal(first.added, 7, JSON.stringify(first));
  assert.equal(first.lessons, 1);
  assert.equal(agenda.persistent, true, 'kept in pg1_lab_agenda');
  const second = await syncAgenda({ agenda, history, reportsFor: (ids) => labStore.reports(ids), lessons });
  assert.equal(second.seeded, false);
  assert.equal(second.added, 0, 'no duplicates on the next run');
  assert.equal(second.lessons, 0, 'the lesson is already there');
  const { rows: ag } = await db.query('select goal_key, status, source, continued_from from public.pg1_lab_agenda order by goal_key');
  assert.equal(ag.length, 7);
  assert.ok(ag.every((r) => r.source === 'history'));
  const { rows: ls } = await db.query('select text, status, source_event from public.pg1_core_lessons');
  assert.deepEqual(ls.map((l) => [l.status, l.source_event]), [['proposed', `lab:${uuid(5)}`]]);
  assert.deepEqual((await db.query('select id, status, gate, promoted_stage, candidate, error from public.pg1_lab_experiments order by id')).rows, before, 'experiments and their approval cards unchanged');
  // The next item: the unfinished work first.
  const next = pickNext(await agenda.list({ statuses: ['open'] }));
  assert.equal(next.continued_from !== null, true);
  // A running item closes when its experiment ends: failed reopens it (up to the limit), done closes it.
  const item = (await agenda.list()).find((r) => r.status === 'running');
  await db.query(`update public.pg1_lab_experiments set status = 'failed', error = 'research: rate limited', updated_at = now() where id = $1`, [uuid(9)]);
  await agenda.update(item.id, { attempts: 1 });
  const third = await syncAgenda({ agenda, history: await labStore.history(100), reportsFor: (ids) => labStore.reports(ids), lessons });
  assert.equal(third.reopened, 1);
  const re = (await agenda.list()).find((r) => r.id === item.id);
  assert.equal(re.status, 'open');
  assert.equal(re.continued_from, uuid(9));
  await agenda.update(item.id, { status: 'running', experiment_id: uuid(9), attempts: MAX_ATTEMPTS });
  await syncAgenda({ agenda, history: await labStore.history(100), reportsFor: (ids) => labStore.reports(ids), lessons });
  assert.equal((await agenda.list()).find((r) => r.id === item.id).status, 'done', `rests after ${MAX_ATTEMPTS} attempts`);
});

test('3: PG1 adds its own items from its missions and lessons, never twice', () => {
  const items = ownAgendaItems({ missions: [{ goal: 'keep the CVE feed healthy', status: 'active' }, { goal: 'paused one', status: 'paused' }], lessons: [{ text: 'Say when free engines come back.', status: 'approved' }, { text: 'not yet', status: 'proposed' }], existingKeys: new Set([goalKey('Keep the CVE feed healthy!')]) });
  assert.deepEqual(items.map((i) => i.goal), ['Research better practice and evidence for this lesson: Say when free engines come back.']);
  assert.equal(items[0].source, 'pg1');
});

// --- 4. continued experiments receive their earlier findings ----------------------------------

test('4: contextFor puts the continued experiment first, then the closest findings', () => {
  const history = [
    { id: uuid(1), goal: 'Which CVE feeds can PG1 resell?', report: REPORT('Three feeds checked.'), updated_at: iso(NOW - 3600000) },
    { id: uuid(2), goal: 'How do agents pay over x402?', report: REPORT('USDC on Base.'), updated_at: iso(NOW) },
    { id: uuid(3), goal: 'CVE feed licences and resale terms', report: REPORT('NVD is public domain.'), updated_at: iso(NOW) }
  ];
  const ctx = contextFor('Which CVE feeds can PG1 resell, and on what terms?', history, { continuedFrom: uuid(1) });
  assert.deepEqual(ctx.map((c) => c.id), [uuid(1), uuid(3)]);
  assert.match(ctx[0].findings, /Three feeds checked/);
  assert.ok(ctx.every((c) => c.findings.length <= 1500));
});

test('4: through the tick, a continued experiment is started with continued_from and its earlier findings; the runner puts them in its prompt and result', async () => {
  const continued = uuid(41);
  const history = [{ id: continued, created_at: iso(NOW - 3 * 3600000), updated_at: iso(NOW - 2 * 3600000), kind: 'research', goal: 'Which CVE feeds can PG1 resell?', status: 'failed', error: 'research: rate limited' }];
  const db = createAutonomousDb({ now: () => NOW, other: async (u) => (u.includes('/rest/v1/pg1_missions') ? Response.json([]) : u.includes('/rest/v1/pg1_errors') ? Response.json([]) : Response.json({}, { status: 404 })) });
  const store = createAutonomousStore({ supUrl: 'https://auto.test', supKey: 'k', fetchImpl: db.fetch, now: () => NOW });
  await switchOn(store);
  const starts = [];
  const quiet = { engineWatchdog: async () => ({ ok: true, result: 'fine' }), integrationWatch: async () => ({ ok: true, result: 'fine' }), feedGuardian: async () => ({ ok: true, result: 'fine' }), notify: async () => {} };
  await autonomousTick({ env: {}, supUrl: 'https://auto.test', supKey: 'k', fetchImpl: db.fetch, now: () => NOW, deps: { ...quiet, lessonStore: null, labCooling: () => ({ cooling: false }), listExperiments: async () => history, labReports: async (ids) => new Map(ids.map((id) => [id, REPORT('Partial: NVD and OSV checked.')])), startExperiment: async (x) => { starts.push(x); return { ok: true, id: uuid(42), free: true }; } } });
  assert.equal(starts.length, 1);
  assert.equal(starts[0].continuedFrom, continued);
  assert.equal(starts[0].input.continued_from, continued);
  assert.equal(starts[0].input.context[0].id, continued);
  assert.match(starts[0].input.context[0].findings, /Partial: NVD and OSV checked\./);
  const row = db.actions.find((r) => r.type === 'lab_autopilot');
  assert.match(row.result, /continues 00000041, with 1 earlier finding/);
  // The runner: the findings in the prompt (untrusted), continued_from on the result.
  let prompt = '';
  const fetchImpl = async (u, o = {}) => {
    if (String(u).startsWith('https://api.groq.com/')) { prompt = JSON.parse(o.body).messages.map((m) => m.content).join('\n'); return Response.json({ choices: [{ message: { content: REPORT('NVD, OSV and GHSA can be resold.') } }] }); }
    return new Response('{}', { status: 503 });
  };
  const r = await runExperiment({ id: uuid(42), kind: 'research', goal: 'Which CVE feeds can PG1 resell?', input: starts[0].input, env: { GROQ_API_KEY: 'free-groq', PG1_LAB_FREE_SEARCH: 'off' }, budgetUsd: 2, fetchImpl, lookup });
  assert.equal(r.status, 'done', r.error);
  assert.equal(r.continued_from, continued);
  assert.deepEqual(r.context_from, [continued]);
  assert.match(prompt, /<earlier_findings untrusted="true">\n<finding experiment="00000041" continues="true"/);
  assert.match(prompt, /Partial: NVD and OSV checked\./);
});

// --- 5. free search ---------------------------------------------------------------------------

function apiStubs(calls) {
  return async (u, o = {}) => {
    const url = new URL(String(u));
    calls.push({ host: url.hostname, method: o.method || 'GET', headers: o.headers || {}, path: url.pathname + url.search });
    if (o.method && o.method !== 'GET') return new Response('{}', { status: 405 });
    switch (url.hostname) {
      case 'en.wikipedia.org': return Response.json({ query: { search: [{ title: 'National Vulnerability Database', snippet: 'The <span>NVD</span> is the U.S. government repository' }] } });
      case 'export.arxiv.org': return new Response('<feed><entry><id>http://arxiv.org/abs/2401.00001v1</id><title>Vulnerability feeds at scale</title><summary>We study CVE feeds.</summary></entry></feed>');
      case 'api.github.com': return Response.json({ items: [{ full_name: 'CVEProject/cvelistV5', html_url: 'https://github.com/CVEProject/cvelistV5', description: 'CVE records', license: { spdx_id: 'CC0-1.0' }, stargazers_count: 900 }] });
      case 'registry.npmjs.org': return Response.json({ objects: [{ package: { name: 'cve-feed', version: '1.0.0', description: 'a feed client', links: { npm: 'https://www.npmjs.com/package/cve-feed' } } }] });
      case 'api.crossref.org': return Response.json({ message: { items: [{ DOI: '10.1000/xyz', title: ['A study of CVE data'], URL: 'https://doi.org/10.1000/xyz' }] } });
      case 'hn.algolia.com': return new Response('{}', { status: 429 });
      case 'api.osv.dev': return Response.json({ id: 'CVE-2024-3094', aliases: ['GHSA-rxwq-x6h5-x525'], summary: 'xz backdoor' });
      case 'pypi.org': return Response.json({ info: { name: 'cvelib', version: '1.2', summary: 'CVE tools', license: 'MIT', package_url: 'https://pypi.org/project/cvelib/' } });
      default: return new Response('{}', { status: 404 });
    }
  };
}

test('5: free search asks each public API once with GET, respects 429 and the arXiv gap, and numbers its results', async () => {
  const calls = [];
  const slept = [];
  let clock = 1000;
  const out = await freeSearch({ query: 'Research CVE-2024-3094 and the python package `cvelib` for CVE feeds', fetch: apiStubs(calls), env: { PG1_LAB_SEARCH_GITHUB_TOKEN: 'ro-token' }, sleep: async (ms) => { slept.push(ms); clock += ms; }, now: () => clock });
  assert.ok(calls.every((c) => c.method === 'GET'), 'GET only');
  assert.ok(calls.every((c) => /PG1-lab\//.test(c.headers['User-Agent'])), 'an identifying User-Agent');
  assert.equal(calls.find((c) => c.host === 'api.github.com').headers.Authorization, 'Bearer ro-token');
  assert.deepEqual([...new Set(calls.map((c) => c.host))].sort(), ['api.crossref.org', 'api.github.com', 'api.osv.dev', 'en.wikipedia.org', 'export.arxiv.org', 'hn.algolia.com', 'pypi.org', 'registry.npmjs.org']);
  assert.ok(!calls.some((c) => /google|bing|duckduckgo/.test(c.host)), 'never a search engine result page');
  assert.deepEqual(out.errors, [{ source: 'hn', reason: 'HTTP 429 (rate limited: skipped for this search)' }]);
  assert.deepEqual(out.results.map((r) => r.n), out.results.map((_, i) => i + 1));
  assert.ok(out.results.every((r) => /^https:\/\//.test(r.url)));
  assert.ok(out.results.some((r) => r.url === 'https://osv.dev/vulnerability/CVE-2024-3094'));
  assert.ok(out.results.some((r) => r.url === 'https://pypi.org/project/cvelib/'));
  assert.ok(out.results.some((r) => r.url === 'https://arxiv.org/abs/2401.00001v1'));
  // A second search at once: arXiv waits its 3 s.
  slept.length = 0;
  await freeSearch({ query: 'CVE feeds', fetch: apiStubs([]), sleep: async (ms) => { slept.push(ms); clock += ms; }, now: () => clock, sources: ['arxiv'] });
  assert.ok(slept[0] > 0 && slept[0] <= HOST_GAP_MS['export.arxiv.org']);
  assert.deepEqual(searchTerms('Research which CVE feeds PG1 can resell'), ['cve', 'feeds', 'resell']);
});

test('5: a $0 research run grounds itself on the free search, cites the results and ends with the source list; nothing is skipped', async () => {
  const calls = [];
  let prompt = '';
  const api = apiStubs(calls);
  const fetchImpl = async (u, o = {}) => {
    if (String(u).startsWith('https://api.groq.com/')) { prompt = JSON.parse(o.body).messages.map((m) => m.content).join('\n'); return Response.json({ choices: [{ message: { content: '## Findings\nThe NVD is the U.S. government repository of CVE records [1]; the CVE list is CC0 on GitHub [3].\n## Sources and licences\n[1], [3]\n## Open questions\nnone' } }] }); }
    return api(u, o);
  };
  const r = await runExperiment({ id: uuid(51), kind: 'research', goal: 'Which CVE feeds can PG1 resell?', env: { GROQ_API_KEY: 'free-groq', PG1_LAB_GEMINI_API_KEY: 'paid-g' }, budgetUsd: 2, fetchImpl, lookup, searchOpts: { sleep: async () => {} } });
  assert.equal(r.status, 'done', r.error);
  assert.equal(r.spent_usd, 0);
  assert.equal(r.skipped, undefined, 'the search ran: nothing skipped');
  assert.match(prompt, /<search_results untrusted="true"/);
  assert.match(prompt, /\[1\] National Vulnerability Database \(wikipedia\) https:\/\/en\.wikipedia\.org\/wiki\/National_Vulnerability_Database/);
  assert.match(r.report_markdown, /\[1\]; the CVE list is CC0 on GitHub \[3\]/);
  assert.match(r.report_markdown, /## Sources \(free search\)\n\[1\] National Vulnerability Database: https:\/\/en\.wikipedia\.org\/wiki\/National_Vulnerability_Database/);
  assert.ok(r.sources.some((s) => s.url === 'https://github.com/CVEProject/cvelistV5'));
  assert.ok(r.stages.research.free_search >= 5);
  assert.ok(calls.every((c) => c.method === 'GET'));
});

// --- 6. the gate is the only stop ----------------------------------------------------------------

test('6: the loop only dispatches the lab workflow; promotion needs the gate and the operator; nothing merges', async () => {
  const { gh, fetchImpl } = await makeLabWorld(['20261019120000_pg1_skills.sql', '20261020120000_pg1_lab_and_flags.sql', '20261112120000_pg1_lab_agenda.sql']);
  const writes = [];
  const watched = async (u, o = {}) => { if (String(u).startsWith('https://api.github.com/') && (o.method || 'GET') !== 'GET') writes.push(`${o.method} ${new URL(String(u)).pathname}`); return fetchImpl(u, o); };
  const { startLabExperiment } = await import('../lib/lab/chat.mjs');
  const s = await startLabExperiment({ env: { PG1_AUTONOMY: 'on', PG1_LAB_DISPATCH_SECRET: 's'.repeat(32), GITHUB_TOKEN: 'gh-test-token' }, supUrl: SUP, supKey: 'k', fetchImpl: watched, kind: 'code', goal: 'add a batch size check', input: { continued_from: uuid(3), context: [] }, continuedFrom: uuid(3) });
  assert.equal(s.ok, true, s.reply);
  assert.deepEqual(writes, ['POST /repos/Project-Gifted1/pg1-ai-agent/actions/workflows/lab.yml/dispatches'], 'one dispatch, no other GitHub write');
  assert.equal(gh.dispatches[0].inputs.kind, 'code');
  // An approval without a passed gate changes nothing.
  const { createLabStore } = await import('../lib/lab/store.mjs');
  const store = createLabStore({ supUrl: SUP, supKey: 'k', fetchImpl });
  const row = await store.get(s.id);
  assert.equal(row.continued_from, uuid(3));
  await store.update(s.id, { status: 'done', candidate: { type: 'code', pr_number: 7, pr_url: 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/7', files: ['lib/x.mjs'] }, gate: { pass: false, checks: [] } });
  const refused = await handleLabApproval({ row: { plan: { experiment_id: s.id } }, decision: 'approve', supUrl: SUP, supKey: 'k', fetchImpl, isOperator: true });
  assert.match(refused.reply, /has not passed the gate; nothing was changed/);
  await store.update(s.id, { gate: { pass: true, checks: [] } });
  const ok = await handleLabApproval({ row: { plan: { experiment_id: s.id } }, decision: 'approve', supUrl: SUP, supKey: 'k', fetchImpl, isOperator: true });
  assert.match(ok.reply, /PG1 never merges: review and merge https:\/\/github\.com\/Project-Gifted1\/pg1-ai-agent\/pull\/7 yourself; it runs for the operator only behind flag code:7 until \/promote code:7/);
  assert.equal(writes.length, 1, 'approving merges nothing');
  for (const f of ['lib/lab/loop.mjs', 'lib/lab/agenda.mjs', 'lib/lab/freeSearch.mjs']) {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /\/merge\b|merge_pull_request|api\.github\.com\/repos/, `${f}: no merge, no GitHub write`);
  }
  assert.doesNotMatch(readFileSync(path.join(ROOT, 'lib/lab/freeSearch.mjs'), 'utf8'), /method: '(?:POST|PUT|PATCH|DELETE)'/, 'free search is GET only');
  const doc = readFileSync(path.join(ROOT, 'docs/lab.md'), 'utf8');
  assert.match(doc, /The gate is the only stop/);
  assert.match(doc, /draft pull request/);
  assert.ok(readdirSync(path.join(ROOT, 'supabase/migrations')).includes('20261112120000_pg1_lab_agenda.sql'));
});

test('/lab agenda: list, add, drop and top for the operator', async () => {
  const { fetchImpl } = await makeLabWorld(['20261019120000_pg1_skills.sql', '20261020120000_pg1_lab_and_flags.sql', '20261112120000_pg1_lab_agenda.sql']);
  const say = async (text) => (await handleLabCommand({ text, env: {}, supUrl: SUP, supKey: 'k', fetchImpl, isOperator: true, now: NOW })).reply;
  assert.deepEqual(parseLabCommand('/lab agenda add "study x402 refunds" --kind research').opts, { op: 'add', kind: 'research' });
  assert.match(await say('/lab agenda'), /The research agenda is empty/);
  const a = await say('/lab agenda add "Which CVE feeds can PG1 resell?"');
  assert.match(a, /^Added to the agenda: [0-9a-f]{8} \(research\) "Which CVE feeds can PG1 resell\?"/);
  assert.match(await say('/lab agenda add "which cve feeds can pg1 resell"'), /already on the agenda/);
  const b = await say('/lab agenda add "draft a wallet screening skill" --kind skill');
  const idA = /: ([0-9a-f]{8}) /.exec(a)[1]; const idB = /: ([0-9a-f]{8}) /.exec(b)[1];
  let list = await say('/lab agenda list');
  assert.ok(list.indexOf(idA) < list.indexOf(idB) || list.includes('p70'), list);
  assert.match(await say(`/lab agenda top ${idB}`), new RegExp(`${idB} is now first`));
  list = await say('/lab agenda');
  assert.ok(list.indexOf(idB) < list.indexOf(idA), 'top moved it first');
  assert.match(await say(`/lab agenda drop ${idA}`), /Dropped from the agenda/);
  assert.doesNotMatch((await say('/lab agenda')).split('\n').filter((l) => l.startsWith('- ')).join('\n'), new RegExp(idA));
  assert.match((await handleLabCommand({ text: '/lab agenda', supUrl: SUP, supKey: 'k', fetchImpl, isOperator: false })).reply, /operator only/);
});
