/**
 * /api/handoffs (api/handoffs.mjs): operator-only access, drafting and
 * storing a hand-off, the sent transition, and status sync from GitHub PR
 * titles using PG1's existing GITHUB_TOKEN.
 *
 * Run with: node --test tests/handoff-endpoint.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import handler, { __clearHandoffsRateLimitState } from '../api/handoffs.mjs';
import { FAKE } from './fixtures/fake-secrets.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const AUTH = { user: 'test-operator', pass: 'test-secret-pass' };

beforeEach(() => {
  process.env.USER_API_KEY = AUTH.user;
  process.env.USER_API_PASS = AUTH.pass;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.GITHUB_TOKEN = 'gh-test-token-value';
  delete process.env.USER_API_USER;
  delete process.env.USER_API_PASSS;
  __clearHandoffsRateLimitState();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

const makeReq = (body, method = 'POST') => ({ method, headers: {}, socket: { remoteAddress: '127.0.0.1' }, body });
function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; }
  };
}

function installFetch(calls, { rows = [], pulls = {}, insertOk = true, ghOk = true } = {}) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    calls.push({ url: u, method, headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
    if (u.startsWith('https://api.github.com/repos/')) {
      const repo = u.slice('https://api.github.com/repos/'.length).split('/pulls')[0];
      return { ok: ghOk, json: async () => pulls[repo] || [] };
    }
    if (u.includes('/rest/v1/pg1_handoffs') && method === 'POST') return { ok: insertOk, json: async () => ({}) };
    if (u.includes('/rest/v1/pg1_handoffs') && method === 'GET') return { ok: true, json: async () => rows };
    return { ok: true, json: async () => ({}) };
  };
}

async function call(body) {
  const res = makeRes();
  await handler(makeReq(body), res);
  return res;
}

test('every op is operator-only: no or wrong credentials get 401 and touch nothing', async () => {
  for (const op of ['draft', 'sent', 'list']) {
    const calls = [];
    installFetch(calls);
    const none = await call({ op, task: 'x', taskId: 'PG1-TASK-ABCDEF' });
    assert.equal(none.statusCode, 401, op);
    const wrong = await call({ op, user: AUTH.user, pass: 'nope', task: 'x' });
    assert.equal(wrong.statusCode, 401, op);
    assert.equal(calls.length, 0, `${op}: no Supabase or GitHub call when unauthenticated`);
  }
});

test('operator-only also when the deployment has no operator credentials configured', async () => {
  delete process.env.USER_API_KEY;
  delete process.env.USER_API_PASS;
  installFetch([]);
  assert.equal((await call({ op: 'draft', user: '', pass: '', task: 'x' })).statusCode, 401);
});

test('GET and other methods are refused', async () => {
  const res = makeRes();
  await handler(makeReq(null, 'GET'), res);
  assert.equal(res.statusCode, 405);
});

test('draft returns the prompt and stores a drafted row with the stripped prompt', async () => {
  const calls = [];
  installFetch(calls);
  const res = await call({ op: 'draft', ...AUTH, task: `Add a toggle to the drawer. Password: ${FAKE.passkey}` });
  assert.equal(res.statusCode, 200);
  const d = res.body;
  assert.match(d.taskId, /^PG1-TASK-[A-Z0-9]{6}$/);
  assert.ok(d.prompt.includes(`Put the task ID ${d.taskId} in the pull request title`));
  assert.equal(d.stored, true);
  assert.deepEqual(d.removed, ['password or passkey']);
  assert.ok(!d.prompt.includes(FAKE.passkey));
  const insert = calls.find((c) => c.method === 'POST');
  assert.equal(insert.url, 'https://example.supabase.co/rest/v1/pg1_handoffs');
  assert.equal(insert.headers.apikey, 'test-service-role-key');
  assert.equal(insert.body.task_id, d.taskId);
  assert.equal(insert.body.status, 'drafted');
  assert.equal(insert.body.prompt, d.prompt);
  assert.ok(!JSON.stringify(insert.body).includes(FAKE.passkey));
  assert.ok(!calls.some((c) => c.url.includes('anthropic') || c.url.includes('claude.ai')), 'no model or Code call');
});

test('draft strips the deployment\'s own secrets (e.g. the operator passkey) from the task', async () => {
  installFetch([]);
  const res = await call({ op: 'draft', ...AUTH, task: 'login with test-secret-pass fails' });
  assert.doesNotMatch(res.body.prompt, /test-secret-pass/);
  assert.ok(res.body.removed.includes('environment value'));
});

test('draft still works when storage is down, and says so', async () => {
  installFetch([], { insertOk: false });
  const res = await call({ op: 'draft', ...AUTH, task: 'Fix a bug' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stored, false);
  assert.ok(res.body.prompt);
});

test('draft without a task is a 400', async () => {
  installFetch([]);
  assert.equal((await call({ op: 'draft', ...AUTH, task: '   ' })).statusCode, 400);
});

test('sent re-strips the edited prompt and only moves drafted/sent rows to sent', async () => {
  const calls = [];
  installFetch(calls);
  const res = await call({ op: 'sent', ...AUTH, taskId: 'PG1-TASK-ABCDEF', prompt: `Task ID: PG1-TASK-ABCDEF\nuse ${FAKE.githubPat}` });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.removed, ['GitHub token']);
  const patches = calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches.length, 2);
  assert.match(patches[0].url, /task_id=eq\.PG1-TASK-ABCDEF&status=in\.\(drafted,sent\)$/);
  assert.equal(patches[0].body.status, 'sent');
  assert.match(patches[1].url, /status=not\.in\.\(drafted,sent\)$/);
  assert.equal(patches[1].body.status, undefined, 'a PR-tracked row keeps its status');
  for (const p of patches) {
    assert.doesNotMatch(p.body.prompt, /ghp_/);
    assert.ok(!p.body.prompt.includes(FAKE.githubPat));
  }
});

test('sent rejects anything that is not a task ID', async () => {
  installFetch([]);
  assert.equal((await call({ op: 'sent', ...AUTH, taskId: '*', prompt: 'x' })).statusCode, 400);
});

test('list syncs status from PR titles with the existing GITHUB_TOKEN and links to GitHub', async () => {
  const calls = [];
  const rows = [
    { task_id: 'PG1-TASK-AAAAAA', created_at: '2026-10-02T10:00:00Z', repo: 'Project-Gifted1/pg1-ai-agent', task: 'add x', status: 'sent', pr_url: null },
    { task_id: 'PG1-TASK-BBBBBB', created_at: '2026-10-02T09:00:00Z', repo: 'Project-Gifted1/pg1-ai-agent', task: 'fix y', status: 'pr_open', pr_url: 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/7' },
    { task_id: 'PG1-TASK-CCCCCC', created_at: '2026-10-02T08:00:00Z', repo: 'Project-Gifted1/pg1-ai-agent', task: 'old', status: 'merged', pr_url: 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/3' }
  ];
  const pulls = { 'Project-Gifted1/pg1-ai-agent': [
    { number: 8, title: 'PG1-TASK-AAAAAA: add x', state: 'open', merged_at: null, created_at: '2026-10-02T11:00:00Z', html_url: 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/8' },
    { number: 7, title: 'Fix y (PG1-TASK-BBBBBB)', state: 'closed', merged_at: '2026-10-02T12:00:00Z', created_at: '2026-10-02T10:30:00Z', html_url: 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/7' }
  ] };
  installFetch(calls, { rows, pulls });
  const res = await call({ op: 'list', ...AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.synced, true);
  const byId = Object.fromEntries(res.body.handoffs.map((h) => [h.task_id, h]));
  assert.equal(byId['PG1-TASK-AAAAAA'].status, 'pr_open');
  assert.equal(byId['PG1-TASK-AAAAAA'].pr_url, 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/8');
  assert.equal(byId['PG1-TASK-BBBBBB'].status, 'merged');
  assert.equal(byId['PG1-TASK-CCCCCC'].status, 'merged');

  const gh = calls.filter((c) => c.url.startsWith('https://api.github.com/'));
  assert.equal(gh.length, 1, 'one PR listing per repo');
  assert.equal(gh[0].headers.Authorization, `Bearer ${process.env.GITHUB_TOKEN}`);
  const patches = calls.filter((c) => c.method === 'PATCH');
  assert.deepEqual(patches.map((p) => [p.url.split('task_id=eq.')[1], p.body.status]),
    [['PG1-TASK-AAAAAA', 'pr_open'], ['PG1-TASK-BBBBBB', 'merged']]);
  assert.ok(!calls.some((c) => /pending_actions|CONFIRM_PENDING_ACTION/.test(c.url)), 'never routed through the Approve flow');
});

test('list without GitHub access shows stored status and says why (no new credentials)', async () => {
  delete process.env.GITHUB_TOKEN;
  const calls = [];
  installFetch(calls, { rows: [{ task_id: 'PG1-TASK-AAAAAA', repo: 'Project-Gifted1/pg1-ai-agent', task: 't', status: 'sent', pr_url: null }] });
  const res = await call({ op: 'list', ...AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.synced, false);
  assert.match(res.body.syncError, /GitHub access is not configured/);
  assert.equal(res.body.handoffs[0].status, 'sent');
  assert.ok(!calls.some((c) => c.url.includes('github')));
});

test('list never returns an unsafe PR link and ignores repos outside the known list', async () => {
  const calls = [];
  installFetch(calls, { rows: [
    { task_id: 'PG1-TASK-AAAAAA', repo: 'evil/repo', task: 't', status: 'sent', pr_url: 'javascript:alert(1)' }
  ] });
  const res = await call({ op: 'list', ...AUTH });
  assert.equal(res.body.handoffs[0].pr_url, null);
  assert.ok(!calls.some((c) => c.url.includes('evil/repo')));
});
