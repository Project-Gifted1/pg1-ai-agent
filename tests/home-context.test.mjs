/**
 * The home screen's live context (lib/homeContext.mjs, api/home-context.mjs):
 *   - the priority order: production pinned or a failed deploy, approvals
 *     waiting, a new unopened report, errors for real callers, a first-ever
 *     event, running experiments, then a calm default (only when the calm is
 *     known), else the generic line;
 *   - each state's subtitle and cards; counts come from the fixture;
 *   - /help is always one of the four cards, and every card runs a real
 *     command from the registry;
 *   - a source that cannot be read is left out, never guessed;
 *   - guests get 401 (the page keeps the generic text); the result is cached
 *     for 60 s;
 *   - the text keeps its digits: it is not a chat reply and never goes
 *     through the chat reply guard.
 * Run with: node --test tests/home-context.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  pickHome, homeState, gatherHomeContext, pickTemplate, homeDay, reportSignal, realPg1Errors,
  GENERIC_SUBTITLE, DEFAULT_CARDS, HOME_CONTEXT_CACHE_MS
} from '../lib/homeContext.mjs';
import { createHomeContextHandler, __resetHomeContextCache } from '../api/home-context.mjs';
import { COMMANDS } from '../lib/commands/registry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.parse('2026-11-05T09:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const H = 3600000;

// Everything at once: each state below removes what outranks it.
const FULL = {
  auto_merge: { state: 'paused', production_pinned: true },
  deploy: { state: 'ERROR', at: ago(2 * H), failed: true },
  approvals: { total: 2, tasks: 1, autonomous: 1 },
  report: { kind: 'daily', at: ago(2 * H), opened: false, findings: 3 },
  errors: { real_pg1_24h: 4 },
  firsts: [{ kind: 'payment', at: ago(20 * H) }],
  experiments: { lab: 1, sandbox: 0 },
  autonomous: { enabled: true }
};
const without = (s, ...keys) => { const o = structuredClone(s); for (const k of keys) delete o[k]; return o; };
const calm = { approvals: { total: 0, tasks: 0, autonomous: 0 }, errors: { real_pg1_24h: 0 }, report: { kind: 'daily', at: ago(2 * H), opened: true, findings: 0 }, auto_merge: { state: 'on', production_pinned: false }, deploy: { state: 'READY', at: ago(5 * H), failed: false }, firsts: [], experiments: { lab: 0, sandbox: 0 }, autonomous: { enabled: true } };

const REGISTRY = new Set(COMMANDS.map((c) => c.command));
const realCommand = (cmd) => REGISTRY.has(cmd) || REGISTRY.has(cmd.split(' ')[0]) || cmd === '/report resume' || cmd === '/usage 24h';

test('priority: pinned beats a failed deploy beats approvals beats the report beats errors beats a first beats experiments', () => {
  const order = [];
  let s = structuredClone(FULL);
  const steps = [
    ['pinned', (x) => { x.auto_merge.production_pinned = false; }],
    ['deploy_failed', (x) => { delete x.deploy; }],
    ['approvals', (x) => { x.approvals.total = 0; }],
    ['report', (x) => { x.report.opened = true; }],
    ['errors', (x) => { x.errors.real_pg1_24h = 0; }],
    ['first', (x) => { x.firsts = []; }],
    ['experiments', (x) => { x.experiments.lab = 0; }]
  ];
  for (const [state, drop] of steps) {
    order.push(homeState({ ...s, __now: NOW }));
    assert.equal(order.at(-1), state);
    drop(s);
  }
  assert.equal(homeState({ ...s, __now: NOW }), 'quiet');
  assert.deepEqual(order, ['pinned', 'deploy_failed', 'approvals', 'report', 'errors', 'first', 'experiments']);
});

test('pinned: a calm, specific line; cards check production and keep /help', () => {
  const h = pickHome(FULL, { now: NOW });
  assert.equal(h.state, 'pinned');
  assert.match(h.subtitle, /pinned|earlier deploy/i);
  assert.equal(h.cards[0].command, '/status');
  assert.equal(h.cards.at(-1).command, '/help');
});

test('approvals: "2 approvals" with its digit, and a "Review 2 approvals" card on /report today', () => {
  const s = without(FULL, 'deploy'); s.auto_merge = { state: 'on', production_pinned: false };
  const h = pickHome(s, { now: NOW });
  assert.equal(h.state, 'approvals');
  assert.match(h.subtitle, /\b2 (approvals|items)\b/);
  const card = h.cards.find((c) => c.label === 'Review 2 approvals');
  assert.ok(card, JSON.stringify(h.cards));
  assert.equal(card.command, '/report today');
  // one approval: singular
  s.approvals.total = 1;
  const one = pickHome(s, { now: NOW });
  assert.match(one.subtitle, /\b1 (approval|item)\b/);
  assert.ok(one.cards.some((c) => c.label === 'Review 1 approval'));
});

test('report: "3 findings" from the stored card, and the read card; a report without a stored count gives no number', () => {
  const s = { report: { kind: 'daily', at: ago(2 * H), opened: false, findings: 3 }, approvals: { total: 0 }, errors: { real_pg1_24h: 0 } };
  const h = pickHome(s, { now: NOW });
  assert.equal(h.state, 'report');
  assert.match(h.subtitle, /\b3 findings\b/);
  assert.match(h.subtitle, /^Last night's report/);
  assert.ok(h.cards.some((c) => c.command === '/report today' && /report/.test(c.label)));
  const noCount = pickHome({ ...s, report: { kind: 'daily', at: ago(2 * H), opened: false } }, { now: NOW });
  assert.equal(noCount.state, 'report');
  assert.doesNotMatch(noCount.subtitle, /\d/);
  const weekly = pickHome({ ...s, report: { kind: 'weekly', at: ago(3 * H), opened: false, findings: 1 } }, { now: NOW });
  assert.match(weekly.subtitle, /This week's report .*1 finding\b/);
  assert.ok(weekly.cards.some((c) => c.command === '/report week'));
  // an old unopened report is not "new"
  assert.notEqual(homeState({ ...s, report: { ...s.report, at: ago(72 * H) }, __now: NOW }), 'report');
});

test('errors, a first-ever event, experiments: each its own line and card', () => {
  const errors = pickHome({ errors: { real_pg1_24h: 4 }, approvals: { total: 0 } }, { now: NOW });
  assert.equal(errors.state, 'errors');
  assert.match(errors.subtitle, /\b4\b/);
  assert.ok(errors.cards.some((c) => c.command === '/usage 24h' && /4 errors/.test(c.label)));
  const first = pickHome({ errors: { real_pg1_24h: 0 }, approvals: { total: 0 }, firsts: [{ kind: 'payment', at: ago(20 * H) }] }, { now: NOW });
  assert.equal(first.state, 'first');
  assert.match(first.subtitle, /paid call settled yesterday/);
  assert.equal(first.cards[0].command, '/commerce-status');
  const job = pickHome({ firsts: [{ kind: 'a2a_job', at: ago(H) }] }, { now: NOW });
  assert.match(job.subtitle, /A2A job .*today/);
  assert.ok(job.cards.some((c) => c.command === '/a2a jobs'));
  const ex = pickHome({ experiments: { lab: 2, sandbox: 1 } }, { now: NOW });
  assert.equal(ex.state, 'experiments');
  assert.match(ex.subtitle, /2 lab experiments and 1 sandbox run/);
  assert.ok(ex.cards.some((c) => c.command === '/lab status'));
  assert.ok(ex.cards.some((c) => c.command === '/sandbox'));
});

test('calm default only when it is known; otherwise the generic line and today\'s cards', () => {
  const q = pickHome(calm, { now: NOW });
  assert.equal(q.state, 'quiet');
  assert.match(q.subtitle, /no errors|Nothing waiting/i);
  assert.ok(q.cards.some((c) => c.command === '/autonomy'), 'Autonomous mode on: what PG1 did overnight');
  // errors not read: not "all quiet"
  const unknown = pickHome(without(calm, 'errors'), { now: NOW });
  assert.equal(unknown.state, 'generic');
  assert.equal(unknown.subtitle, GENERIC_SUBTITLE);
  // nothing at all: today's text and today's four cards
  const none = pickHome({}, { now: NOW });
  assert.equal(none.subtitle, GENERIC_SUBTITLE);
  assert.deepEqual(none.cards, DEFAULT_CARDS.map((c) => ({ ...c })));
});

test('every state: four cards, /help is one of them (the last), no command twice, every command is real', () => {
  const states = [FULL, without(FULL, 'auto_merge', 'deploy'), { report: FULL.report }, { errors: { real_pg1_24h: 9 } }, { firsts: FULL.firsts }, { experiments: { lab: 0, sandbox: 3 } }, calm, {}];
  for (const s of states) {
    const { cards, subtitle } = pickHome(s, { now: NOW });
    assert.equal(cards.length, 4);
    assert.equal(cards.at(-1).command, '/help');
    assert.equal(new Set(cards.map((c) => c.command)).size, 4);
    for (const c of cards) assert.ok(realCommand(c.command), c.command);
    // one short, calm sentence
    assert.ok(subtitle.length <= 90, subtitle);
    assert.doesNotMatch(subtitle, /\bsafe\b|!|urgent|critical|alert/i);
  }
});

test('phrasing varies by day, never within a day', () => {
  const s = { approvals: { total: 2 } };
  const lines = new Set();
  for (let d = 0; d < 20; d++) lines.add(pickHome(s, { now: NOW + d * 24 * H }).subtitle);
  assert.ok(lines.size >= 2, 'more than one template over 20 days');
  assert.equal(pickHome(s, { now: NOW }).subtitle, pickHome(s, { now: NOW + 3 * H }).subtitle);
  assert.equal(pickTemplate(['a', 'b', 'c'], '2026-11-05', 'x'), pickTemplate(['a', 'b', 'c'], '2026-11-05', 'x'));
  assert.equal(homeDay(NOW), '2026-11-05');
});

// --- gathering ------------------------------------------------------------------

function fixtureDeps(overrides = {}) {
  const tasks = [
    { id: 't1', kind: 'fix', status: 'pr_open' },
    { id: 't2', kind: 'fix', status: 'open' },
    { id: 't3', kind: 'listing', status: 'needs_approval', title: 'List PG1', approval: {}, updated_at: ago(H) }
  ];
  const opStore = {
    async listTasks({ statuses }) {
      if (statuses.includes('rolled_back')) return [];
      return tasks.filter((t) => statuses.includes(t.status));
    },
    async latestReport(kind) {
      return kind === 'daily' ? { kind: 'daily', created_at: ago(2 * H), delivered_at: null, card: { findings: 3 } } : { kind: 'weekly', created_at: ago(80 * H), delivered_at: ago(70 * H), card: {} };
    }
  };
  const autoStore = {
    async listActions() { return [{ id: 'a1', type: 'sql_proposal', approval: { title: 'Add an index' }, at: ago(H) }]; },
    async getState() { return { enabled: true }; }
  };
  return {
    opStore, autoStore,
    labStore: { async list() { return [{ status: 'running' }, { status: 'done' }]; } },
    sandboxStore: { async listRuns() { return []; } },
    getStats: async () => ({ truncated: false, errors: { breakdown: [{ fault: 'pg1', real: 2, probe: 5 }, { fault: 'caller', real: 7 }, { fault: 'pg1', real: 1 }] } }),
    readDeploys: async () => [{ id: 'dpl_1', state: 'READY', created_at: ago(5 * H) }],
    productionPinned: async () => ({ pinned: false, serving: 'dpl_1', latest: 'dpl_1' }),
    rest: async (path) => {
      if (path.startsWith('agent_telemetry')) return [{ created_at: ago(30 * H) }];
      if (path.startsWith('pg1_a2a_jobs')) return [{ created_at: ago(40 * 24 * H), updated_at: ago(40 * 24 * H) }];
      return [];
    },
    ...overrides
  };
}

test('gather: every figure comes from the fixture', async () => {
  const s = await gatherHomeContext({ env: { PG1_AUTONOMY: 'on' }, now: NOW, deps: fixtureDeps() });
  assert.deepEqual(s.approvals, { total: 2, tasks: 1, autonomous: 1 });
  assert.deepEqual(s.report, { kind: 'daily', at: ago(2 * H), opened: false, findings: 3 });
  assert.deepEqual(s.auto_merge, { production_pinned: false, state: 'on' });
  assert.deepEqual(s.deploy, { state: 'READY', at: ago(5 * H), failed: false });
  assert.deepEqual(s.tasks, { total: 2, by_kind: { fix: 2 } });
  assert.deepEqual(s.errors, { real_pg1_24h: 3 }, 'PG1-fault errors from real callers only');
  assert.deepEqual(s.firsts, [{ kind: 'payment', at: ago(30 * H) }], 'the A2A job is 40 days old: not a first');
  assert.deepEqual(s.experiments, { lab: 1, sandbox: 0 });
  assert.deepEqual(s.autonomous, { enabled: true });
  const h = pickHome(s, { now: NOW });
  assert.equal(h.state, 'approvals');
  assert.match(h.subtitle, /\b2\b/);
});

test('gather: an unreadable source is left out, never guessed', async () => {
  const boom = async () => { throw new Error('down'); };
  const deps = fixtureDeps({
    opStore: { listTasks: boom, latestReport: boom },
    getStats: boom,
    productionPinned: boom,
    readDeploys: boom,
    rest: boom,
    autoStore: { listActions: boom, getState: async () => ({ enabled: false, error: 'not set up' }) }
  });
  const s = await gatherHomeContext({ env: {}, now: NOW, deps });
  for (const key of ['approvals', 'report', 'auto_merge', 'deploy', 'tasks', 'errors', 'firsts', 'autonomous']) assert.equal(key in s, false, key);
  assert.deepEqual(s.experiments, { lab: 1, sandbox: 0 }, 'what could be read stays');
  const h = pickHome(s, { now: NOW });
  assert.notEqual(h.state, 'quiet', 'not called quiet when the errors were not read');
  // a truncated usage read is partial: left out
  const partial = await gatherHomeContext({ env: {}, now: NOW, deps: fixtureDeps({ getStats: async () => ({ truncated: true, errors: { breakdown: [] } }) }) });
  assert.equal('errors' in partial, false);
  // no vault at all: nothing from it
  const bare = await gatherHomeContext({ env: {}, now: NOW, deps: { readDeploys: boom, productionPinned: boom } });
  assert.deepEqual(bare, {});
});

test('gather: a slow source times out and is left out', async () => {
  const never = () => new Promise(() => {});
  const s = await gatherHomeContext({ env: {}, now: NOW, timeoutMs: 50, deps: fixtureDeps({ getStats: never }) });
  assert.equal('errors' in s, false);
  assert.ok('approvals' in s);
});

test('reportSignal and realPg1Errors read only what is stored', () => {
  assert.equal(reportSignal(null, null), null);
  assert.deepEqual(reportSignal({ kind: 'daily', created_at: ago(H), delivered_at: ago(1), card: {} }, null), { kind: 'daily', at: ago(H), opened: true });
  assert.throws(() => realPg1Errors({ truncated: true }));
  assert.throws(() => realPg1Errors({ errors: {} }));
  assert.equal(realPg1Errors({ errors: { breakdown: [] } }), 0);
});

// --- endpoint -------------------------------------------------------------------

function makeRes() {
  return { statusCode: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
}

test('endpoint: guests get 401 (the page keeps the generic text); the operator gets the live text, cached 60 s', async () => {
  __resetHomeContextCache();
  let gathers = 0;
  let now = NOW;
  const deps = fixtureDeps();
  const origList = deps.opStore.latestReport;
  deps.opStore.latestReport = async (k) => { if (k === 'daily') gathers++; return origList(k); };
  const operator = createHomeContextHandler({ env: { PG1_AUTONOMY: 'on' }, now: () => now, deps, vault: { supUrl: null, supKey: null }, session: async () => ({ isOperator: true }) });
  const guest = createHomeContextHandler({ deps, session: async () => ({ isOperator: false }) });

  const g = makeRes();
  await guest({ method: 'POST', headers: {}, body: {} }, g);
  assert.equal(g.statusCode, 401);
  assert.equal(g.body.home, undefined);

  const r1 = makeRes();
  await operator({ method: 'POST', headers: {}, body: {} }, r1);
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.headers['Cache-Control'], 'no-store');
  assert.match(r1.body.home.subtitle, /\b2 (approvals|items)\b|You have 2 approvals/);
  assert.equal(r1.body.home.cards.at(-1).command, '/help');
  assert.equal(r1.body.cached, false);
  now += HOME_CONTEXT_CACHE_MS - 1000;
  const r2 = makeRes();
  await operator({ method: 'GET', headers: {} }, r2);
  assert.equal(r2.body.cached, true);
  assert.equal(gathers, 1);
  now += 2000;
  const r3 = makeRes();
  await operator({ method: 'GET', headers: {} }, r3);
  assert.equal(r3.body.cached, false);
  assert.equal(gathers, 2);
  const bad = makeRes();
  await operator({ method: 'DELETE', headers: {} }, bad);
  assert.equal(bad.statusCode, 405);
  __resetHomeContextCache();
});

test('endpoint is not given the wildcard CORS rule; the findings count is stored on new report cards', () => {
  const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  const rule = vercel.headers.find((h) => h.source.startsWith('/api/:path('));
  assert.match(rule.source, /home-context\$/);
  assert.match(readFileSync(join(ROOT, 'lib/operator/run.mjs'), 'utf8'), /built\.card\.findings = findings\.length;/);
});

test('digits: the home text is not a chat reply and never goes through the reply guard', () => {
  const lib = readFileSync(join(ROOT, 'lib/homeContext.mjs'), 'utf8');
  const api = readFileSync(join(ROOT, 'api/home-context.mjs'), 'utf8');
  for (const src of [lib, api]) {
    const imports = [...src.matchAll(/\bimport\b[^;]*?from\s+'([^']+)'|import\('([^']+)'\)/g)].map((m) => m[1] || m[2]);
    assert.ok(imports.length > 0);
    for (const m of imports) assert.doesNotMatch(m, /chatStream|usageClaims|secretGuard|whiteLabel|infraNames|replyFacts|aiRouter/, m);
  }
  const s = pickHome({ approvals: { total: 2 } }, { now: NOW }).subtitle;
  assert.match(s, /2/);
  assert.match(pickHome({ report: { kind: 'daily', at: ago(H), opened: false, findings: 3 } }, { now: NOW }).subtitle, /3 findings/);
  // The page sets it as text (escapeHTML / textContent), not through a reply renderer.
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  assert.match(html, /if \(typeof liveText === 'string' && liveText\) return escapeHTML\(liveText\);/);
  assert.match(html, /btn\.querySelector\('strong'\)\.textContent = card\.label;/);
});
