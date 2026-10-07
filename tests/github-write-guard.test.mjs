/**
 * Every route that writes to GitHub (api/chat.mjs: APPLY_SURGICAL_PATCH and
 * /patch, ACCEPT_AUTHORIZATION and /deploy-cron, REORGANIZE_FILES,
 * CONFIRM_PENDING_ACTION and /approve):
 * - returns 401 without the operator session and makes no GitHub request;
 * - with the operator session, writes only to a fresh agent branch and opens
 *   a pull request: never a ref, contents write or merge on main;
 * - refuses a repository or path outside lib/githubWriteGuard.mjs's
 *   allow-list before any GitHub write, including a stored proposal on
 *   /approve;
 * - stops before committing when the agent branch could not be created.
 * The old standalone commit routes are gone.
 * Run with: node --test tests/github-write-guard.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { resolveWriteRepo, checkWritePath, isAgentBranch, agentBranchName } from '../lib/githubWriteGuard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const OPERATOR = { user: 'test-operator', pass: 'test-secret-pass' };
const SUPABASE = 'https://example.supabase.co';

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.USER_API_KEY = OPERATOR.user;
  process.env.USER_API_PASS = OPERATOR.pass;
  process.env.GITHUB_TOKEN = 'ghp_test_token';
  delete process.env.USER_API_USER;
  delete process.env.USER_API_PASSS;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASEAPI_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLEKEY;
  __clearAuthRateLimitState();
});

after(() => {
  process.env = ORIGINAL_ENV;
  globalThis.fetch = ORIGINAL_FETCH;
});

let ipCounter = 0;
function makeReq(body) {
  ipCounter += 1;
  return { method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.9.${ipCounter >> 8}.${ipCounter & 255}` }, body };
}

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    write() { return true; },
    end() { return this; }
  };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const TREE = [
  { type: 'blob', path: 'README.md', sha: 'sha-readme' },
  { type: 'blob', path: 'lib/util.py', sha: 'sha-util' },
  { type: 'blob', path: 'vercel.json', sha: 'sha-vercel' },
  { type: 'blob', path: '.github/workflows/action_pipeline.yml', sha: 'sha-wf' },
  { type: 'blob', path: 'vendor/lib/pwn.py', sha: 'sha-pwn' }
];

// A fake GitHub API plus a permissive fake Supabase. Records every request.
function installFakes(opts = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = (options.method || 'GET').toUpperCase();
    let body = null;
    try { body = options.body ? JSON.parse(options.body) : null; } catch (e) { body = options.body; }
    calls.push({ url: u, method, body });

    if (u.startsWith(SUPABASE)) {
      if (u.includes('/rest/v1/pending_actions') && method === 'GET') return json(opts.pendingRows || []);
      return json([]);
    }
    if (!u.startsWith('https://api.github.com/')) throw new Error('Unexpected network call in test: ' + u);

    if (method === 'GET' && /\/git\/trees\/(main|tree-sha)\?recursive=1$/.test(u)) return json({ tree: TREE });
    if (method === 'GET' && u.endsWith('/git/ref/heads/main')) return json({ object: { sha: 'main-sha' } });
    if (method === 'GET' && u.includes('/git/commits/')) return json({ tree: { sha: 'tree-sha' } });
    if (method === 'GET' && u.includes('/contents/')) return json({ content: b64('hello old world\n'), sha: 'sha-file' });
    if (method === 'POST' && u.endsWith('/git/refs')) return opts.refFails ? json({ message: 'nope' }, 422) : json({ ref: body.ref }, 201);
    if (method === 'POST' && u.endsWith('/git/blobs')) return json({ sha: 'blob-sha' }, 201);
    if (method === 'POST' && u.endsWith('/git/trees')) return json({ sha: 'new-tree-sha' }, 201);
    if (method === 'POST' && u.endsWith('/git/commits')) return json({ sha: 'new-commit-sha' }, 201);
    if (method === 'PUT' && u.includes('/contents/')) return json({ commit: { sha: 'c1' } }, 201);
    if (method === 'POST' && u.endsWith('/pulls')) return json({ html_url: 'https://github.com/x/y/pull/1' }, 201);
    throw new Error(`Unexpected GitHub call in test: ${method} ${u}`);
  };
  return calls;
}

const github = (calls) => calls.filter((c) => c.url.startsWith('https://api.github.com/'));
const githubWrites = (calls) => github(calls).filter((c) => c.method !== 'GET');

// The invariant: nothing is ever written to main.
function assertNeverTargetsMain(calls) {
  for (const c of githubWrites(calls)) {
    assert.ok(!/\/git\/refs\/heads\/main$/.test(c.url), `no update of the main ref: ${c.method} ${c.url}`);
    assert.ok(!c.url.endsWith('/merges'), 'no merge API call');
    assert.ok(!/\/pulls\/\d+\/merge$/.test(c.url), 'no PR merge');
    if (c.url.endsWith('/git/refs')) {
      assert.ok(isAgentBranch(c.body.ref.replace('refs/heads/', '')), `branch created is an agent branch: ${c.body.ref}`);
    }
    if (c.method === 'PUT' && c.url.includes('/contents/')) {
      assert.ok(c.body.branch, 'a contents write always names its branch (missing = default branch)');
      assert.ok(isAgentBranch(c.body.branch), `contents write goes to an agent branch: ${c.body.branch}`);
    }
    if (c.url.endsWith('/pulls')) {
      assert.ok(isAgentBranch(c.body.head), `PR head is an agent branch: ${c.body.head}`);
    }
  }
}

// --- 401 without the operator session ---------------------------------------

const WRITE_REQUESTS = {
  'APPLY_SURGICAL_PATCH action': { action: 'APPLY_SURGICAL_PATCH', targetFile: 'README.md', search: 'old', replace: 'new', isAuthorizedAction: true, requireApproval: false },
  'APPLY_SURGICAL_PATCH JSON prompt': { prompt: JSON.stringify({ actionType: 'APPLY_SURGICAL_PATCH', targetFile: 'README.md', search: 'old', replace: 'new', isAuthorizedAction: true }), requireApproval: false },
  '/patch command': { prompt: '/patch ' + JSON.stringify({ targetFile: 'README.md', search: 'old', replace: 'new' }), isAuthorizedAction: true, requireApproval: false },
  'ACCEPT_AUTHORIZATION action': { action: 'ACCEPT_AUTHORIZATION', targetFile: 'lib/util.py', pendingCode: 'x = 1\n', isAuthorizedAction: true, requireApproval: false },
  'execute_commit JSON prompt': { prompt: JSON.stringify({ action: 'execute_commit', targetFile: 'lib/util.py', isAuthorizedAction: true }), pendingCode: 'x = 1\n', requireApproval: false },
  '/deploy-cron command': { prompt: '/deploy-cron', requireApproval: false },
  'REORGANIZE_FILES action': { action: 'REORGANIZE_FILES', isAuthorizedAction: true, requireApproval: false, operations: [{ op: 'create', path: 'lib/new.py', content: 'y = 2\n' }] },
  'CONFIRM_PENDING_ACTION action': { action: 'CONFIRM_PENDING_ACTION', token: 'tok', decision: 'approve' },
  '/approve command': { prompt: '/approve tok' }
};

for (const [name, body] of Object.entries(WRITE_REQUESTS)) {
  for (const [label, creds] of [['no credentials', {}], ['wrong credentials', { user: OPERATOR.user, pass: 'wrong' }]]) {
    test(`${name}: ${label} gets 401 and no GitHub request`, async () => {
      process.env.SUPABASE_URL = SUPABASE;
      process.env.SUPABASEAPI_KEY = 'sb-key';
      const calls = installFakes({ pendingRows: [] });
      const res = makeRes();
      await chatHandler(makeReq({ ...body, ...creds }), res);
      assert.equal(res.statusCode, 401, JSON.stringify(res.body));
      assert.equal(github(calls).length, 0, 'no GitHub call at all');
    });
  }
}

// --- operator session: branch + PR only, never main ------------------------

test('operator APPLY_SURGICAL_PATCH: commits to a surgical-patch branch and opens a PR', async () => {
  const calls = installFakes();
  const res = makeRes();
  await chatHandler(makeReq({ ...WRITE_REQUESTS['APPLY_SURGICAL_PATCH action'], ...OPERATOR }), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.reply, /PR Opened/);
  const put = githubWrites(calls).find((c) => c.method === 'PUT');
  assert.ok(put.body.branch.startsWith('surgical-patch-'));
  assert.ok(put.url.startsWith('https://api.github.com/repos/Project-Gifted1/sovereign-threat-pipeline/'));
  assertNeverTargetsMain(calls);
});

test('operator ACCEPT_AUTHORIZATION: commits to an agent-patch branch and opens a PR', async () => {
  const calls = installFakes();
  const res = makeRes();
  await chatHandler(makeReq({ ...WRITE_REQUESTS['ACCEPT_AUTHORIZATION action'], ...OPERATOR }), res);
  assert.match(res.body.reply, /Pull Request Created/);
  assert.ok(githubWrites(calls).find((c) => c.method === 'PUT').body.branch.startsWith('agent-patch-'));
  assertNeverTargetsMain(calls);
});

test('operator REORGANIZE_FILES: one commit on a reorganize branch, then a PR', async () => {
  const calls = installFakes();
  const res = makeRes();
  await chatHandler(makeReq({ ...WRITE_REQUESTS['REORGANIZE_FILES action'], ...OPERATOR }), res);
  assert.match(res.body.reply, /PR opened/);
  const ref = githubWrites(calls).find((c) => c.url.endsWith('/git/refs'));
  assert.ok(ref.body.ref.startsWith('refs/heads/reorganize-'));
  assertNeverTargetsMain(calls);
});

test('operator /approve of a stored patch: commits to an approved branch and opens a PR', async () => {
  process.env.SUPABASE_URL = SUPABASE;
  process.env.SUPABASEAPI_KEY = 'sb-key';
  const calls = installFakes({
    pendingRows: [{
      token: 'tok', status: 'pending', action_type: 'APPLY_SURGICAL_PATCH', diff_summary: '-old\n+new',
      expires_at: new Date(Date.now() + 60000).toISOString(),
      plan: { repoPath: 'Project-Gifted1/sovereign-threat-pipeline', actualFilePath: 'README.md', updatedContent: 'new\n', baseFileSha: 'sha-file' }
    }]
  });
  const res = makeRes();
  await chatHandler(makeReq({ prompt: '/approve tok', ...OPERATOR }), res);
  assert.match(res.body.reply, /Approved & PR Opened/);
  assert.ok(githubWrites(calls).find((c) => c.method === 'PUT').body.branch.startsWith('approved-'));
  assertNeverTargetsMain(calls);
});

test('operator /approve of a stored reorganize: commit on an approved branch, then a PR', async () => {
  process.env.SUPABASE_URL = SUPABASE;
  process.env.SUPABASEAPI_KEY = 'sb-key';
  const calls = installFakes({
    pendingRows: [{
      token: 'tok', status: 'pending', action_type: 'REORGANIZE_FILES', diff_summary: 'CREATE lib/new.py',
      expires_at: new Date(Date.now() + 60000).toISOString(),
      plan: { repoPath: 'Project-Gifted1/sovereign-threat-pipeline', baseCommitSha: 'main-sha', baseTreeSha: 'tree-sha', commitMessage: 'm', opSummaries: [], treeEntries: [{ path: 'lib/new.py', mode: '100644', type: 'blob', sha: 'blob-sha' }] }
    }]
  });
  const res = makeRes();
  await chatHandler(makeReq({ prompt: '/approve tok', ...OPERATOR }), res);
  assert.match(res.body.reply, /PR opened/);
  assertNeverTargetsMain(calls);
});

// --- allow-list: refused before any GitHub write ----------------------------

const REFUSED = {
  'repository outside the allow-list': { ...WRITE_REQUESTS['APPLY_SURGICAL_PATCH action'], targetRepo: 'x402' },
  'another owner': { ...WRITE_REQUESTS['APPLY_SURGICAL_PATCH action'], targetRepo: 'someone-else/sovereign-threat-pipeline' },
  'a workflow file': { ...WRITE_REQUESTS['ACCEPT_AUTHORIZATION action'], targetFile: '.github/workflows/action_pipeline.yml', pendingCode: 'name: x\n', confirmProtectedPath: true },
  'vercel.json': { ...WRITE_REQUESTS['ACCEPT_AUTHORIZATION action'], targetFile: 'vercel.json', pendingCode: '{}', confirmProtectedPath: true },
  'a path with ..': { ...WRITE_REQUESTS['ACCEPT_AUTHORIZATION action'], targetFile: 'lib/../vercel.json', confirmProtectedPath: true },
  '/deploy-cron (writes a workflow)': { ...WRITE_REQUESTS['/deploy-cron command'], confirmProtectedPath: true },
  'a reorganize batch with one bad path': { ...WRITE_REQUESTS['REORGANIZE_FILES action'], operations: [{ op: 'create', path: 'lib/ok.py', content: 'a\n' }, { op: 'move', path: 'lib/util.py', newPath: 'Dockerfile' }] },
  'a reorganize into another repository': { ...WRITE_REQUESTS['REORGANIZE_FILES action'], targetRepo: 'gold-402' }
};

for (const [name, body] of Object.entries(REFUSED)) {
  test(`operator write to ${name} is refused with no GitHub write`, async () => {
    const calls = installFakes();
    const res = makeRes();
    await chatHandler(makeReq({ ...body, ...OPERATOR }), res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body.reply, /Refused/);
    assert.equal(githubWrites(calls).length, 0);
  });
}

test('a fuzzy path match that resolves outside the allow-list is refused', async () => {
  // "lib/pwn.py" is inside lib/, but the only file ending in it is
  // vendor/lib/pwn.py, which is not: the resolved path is checked too.
  const calls = installFakes();
  const res = makeRes();
  await chatHandler(makeReq({ ...WRITE_REQUESTS['APPLY_SURGICAL_PATCH action'], targetFile: 'lib/pwn.py', ...OPERATOR }), res);
  assert.match(res.body.reply, /Refused: 'vendor\/lib\/pwn\.py'/);
  assert.equal(githubWrites(calls).length, 0);
});

test('/approve of a stored proposal outside the allow-list is discarded, nothing written', async () => {
  process.env.SUPABASE_URL = SUPABASE;
  process.env.SUPABASEAPI_KEY = 'sb-key';
  const calls = installFakes({
    pendingRows: [{
      token: 'tok', status: 'pending', action_type: 'ACCEPT_AUTHORIZATION', diff_summary: '',
      expires_at: new Date(Date.now() + 60000).toISOString(),
      plan: { repoPath: 'Project-Gifted1/sovereign-threat-pipeline', actualFilePath: '.github/workflows/action_pipeline.yml', pendingCode: 'name: x\n', baseFileSha: 'sha-file' }
    }]
  });
  const res = makeRes();
  await chatHandler(makeReq({ prompt: '/approve tok', ...OPERATOR }), res);
  assert.match(res.body.reply, /Confirmation Refused/);
  assert.equal(github(calls).length, 0);
  const status = calls.find((c) => c.url.includes('/rest/v1/pending_actions') && c.method === 'PATCH');
  assert.equal(status.body.status, 'declined');
});

test('when the agent branch cannot be created, nothing is committed', async () => {
  const calls = installFakes({ refFails: true });
  const res = makeRes();
  await chatHandler(makeReq({ ...WRITE_REQUESTS['APPLY_SURGICAL_PATCH action'], ...OPERATOR }), res);
  assert.match(res.body.reply, /could not create branch/);
  assert.ok(!githubWrites(calls).some((c) => c.method === 'PUT' || c.url.endsWith('/pulls')));
});

// --- the guard itself ---------------------------------------------------------

test('resolveWriteRepo: only the allow-listed repositories of Project-Gifted1', () => {
  assert.equal(resolveWriteRepo('sovereign-threat-pipeline'), 'Project-Gifted1/sovereign-threat-pipeline');
  assert.equal(resolveWriteRepo('project-gifted1/PG1-AI-AGENT'), 'Project-Gifted1/pg1-ai-agent');
  for (const bad of ['', 'x402', 'evil/pg1-ai-agent', 'Project-Gifted1/pg1-ai-agent/extra', null, undefined, 42]) {
    assert.equal(resolveWriteRepo(bad), null, String(bad));
  }
});

test('checkWritePath: allowed directories only, no dotfiles or traversal', () => {
  const pg1 = 'Project-Gifted1/pg1-ai-agent';
  const stp = 'Project-Gifted1/sovereign-threat-pipeline';
  for (const [repo, path] of [[pg1, 'api/chat.mjs'], [pg1, 'public/index.html'], [pg1, 'README.md'], [stp, 'build_pipeline.py'], [stp, 'lib/x.py']]) {
    assert.ok(checkWritePath(repo, path).ok, path);
  }
  for (const [repo, path] of [
    [pg1, '.github/workflows/tests.yml'], [pg1, 'vercel.json'], [pg1, 'package.json'], [pg1, 'package-lock.json'],
    [pg1, '.env'], [pg1, 'api/../vercel.json'], [pg1, './api/chat.mjs'], [pg1, '/api/chat.mjs'], [pg1, 'api//x.js'],
    [pg1, 'api\\x.js'], [pg1, 'api/.env.local'], [pg1, 'build_pipeline.py'], [stp, 'Dockerfile'], [stp, 'requirements.txt'],
    [stp, '.github/workflows/action_pipeline.yml'], [stp, 'lib/sub/../../x.py'], ['Project-Gifted1/x402', 'README.md']
  ]) {
    assert.equal(checkWritePath(repo, path).ok, false, `${repo} ${path}`);
  }
});

test('agent branches: never main or another protected name', () => {
  assert.ok(isAgentBranch(agentBranchName('approved-')));
  for (const bad of ['main', 'MAIN', 'master', 'gh-pages', 'feature-x', 'approved-', '', null]) {
    assert.equal(isAgentBranch(bad), false, String(bad));
  }
  assert.throws(() => agentBranchName('main'));
});

test('the standalone commit routes are deleted', () => {
  for (const path of ['api/system/patch.js', 'api/github.js', 'app/api/agent/execute/route.ts']) {
    assert.equal(existsSync(join(ROOT, path)), false, path);
  }
});
