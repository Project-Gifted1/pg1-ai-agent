/**
 * Send to Code (lib/handoff.mjs): prompt builder, secret stripping and PR
 * status matching. Also checks the browser twin of stripSecrets in
 * public/index.html gives the same answer on the same inputs.
 *
 * Run with: node --test tests/handoff.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { FAKE, bearerHeader, postgresUrl } from './fixtures/fake-secrets.mjs';
import {
  generateTaskId, buildHandoffPrompt, draftHandoff, stripSecrets, secretEnvValues,
  findRelevantFiles, resolveHandoffRepo, titleHasTaskId, matchPullRequest,
  computeHandoffUpdates, isSafePrUrl, TASK_ID_RE, HOUSE_RULES, DEFAULT_HANDOFF_REPO
} from '../lib/handoff.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '../public/index.html'), 'utf-8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `function ${name} not found in public/index.html`);
  let depth = 0;
  let i = html.indexOf('{', start);
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(start, i + 1);
}

const clientCtx = {};
vm.createContext(clientCtx);
vm.runInContext(extractFunction('stripSecretsClient') + '\nthis.stripSecretsClient = stripSecretsClient;', clientCtx);
const { stripSecretsClient } = clientCtx;

// --- task IDs ---------------------------------------------------------------

test('task IDs are PG1-TASK- plus six unambiguous characters', () => {
  for (let i = 0; i < 50; i++) assert.match(generateTaskId(), TASK_ID_RE);
  assert.equal(generateTaskId(Buffer.from([0, 1, 2, 3, 4, 5])), 'PG1-TASK-ABCDEF');
  for (let i = 0; i < 50; i++) assert.doesNotMatch(generateTaskId().slice('PG1-TASK-'.length), /[01IO]/);
});

// --- prompt builder ---------------------------------------------------------

test('the prompt carries the task ID line, task, repo, files and every house rule', () => {
  const prompt = buildHandoffPrompt({
    taskId: 'PG1-TASK-ABC234', task: 'Add a dark-mode toggle to the drawer', repo: DEFAULT_HANDOFF_REPO,
    files: ['public/index.html']
  });
  assert.match(prompt, /^Task ID: PG1-TASK-ABC234$/m);
  assert.match(prompt, /Add a dark-mode toggle to the drawer/);
  assert.match(prompt, /^Project-Gifted1\/pg1-ai-agent$/m);
  assert.match(prompt, /^- public\/index\.html$/m);
  assert.match(prompt, /Read the relevant code before changing anything/);
  assert.match(prompt, /Keep runtime behaviour unchanged unless this task asks for a change/);
  assert.match(prompt, /Add or update tests/);
  assert.match(prompt, /Run the full test suite/);
  assert.match(prompt, /tests\/preflight\.test\.js is a known pre-existing failure; ignore it/);
  assert.match(prompt, /Open a pull request\. Put the task ID PG1-TASK-ABC234 in the pull request title/);
  assert.match(prompt, /Stop after opening the pull request/);
  assert.equal(HOUSE_RULES.length, 6);
  assert.doesNotMatch(prompt, /\{TASK_ID\}/);
});

test('draftHandoff builds a complete prompt with a fresh task ID and relevant files', () => {
  const d = draftHandoff({ task: 'Fix the error log modal so resolved rows hide; see api/errors.mjs' });
  assert.match(d.taskId, TASK_ID_RE);
  assert.ok(d.prompt.includes(`Task ID: ${d.taskId}`));
  assert.ok(d.prompt.includes(`Put the task ID ${d.taskId} in the pull request title`));
  assert.equal(d.repo, DEFAULT_HANDOFF_REPO);
  assert.ok(d.files.includes('api/errors.mjs'));
  assert.ok(d.files.includes('public/index.html'), 'modal -> UI file');
  assert.deepEqual(d.removed, []);
});

test('relevant files: explicit paths first, then PG1 hints; other repos get explicit paths only', () => {
  assert.deepEqual(findRelevantFiles('rename handler in lib/freeTier.mjs and add a test'), ['lib/freeTier.mjs']);
  assert.deepEqual(findRelevantFiles('change the drawer button colour'), ['public/index.html']);
  assert.deepEqual(findRelevantFiles('change the drawer button colour', 'Project-Gifted1/x402'), []);
  assert.ok(findRelevantFiles('add a column to the supabase table').includes('supabase/migrations/'));
});

test('repo: default, repo: prefix, full slug; bare names in prose do not switch repo', () => {
  assert.equal(resolveHandoffRepo('fix the x402 payment check').repo, DEFAULT_HANDOFF_REPO);
  const pre = resolveHandoffRepo('repo:gold-402 bump the version');
  assert.equal(pre.repo, 'Project-Gifted1/gold-402');
  assert.equal(pre.task, 'bump the version');
  assert.equal(resolveHandoffRepo('in project-gifted1/trucker-pulse, fix the map').repo, 'Project-Gifted1/Trucker-Pulse');
  assert.equal(resolveHandoffRepo('repo:someone-else/evil do it').repo, DEFAULT_HANDOFF_REPO);
  assert.equal(resolveHandoffRepo('x', 'ZeroDay-Telemetry-Gateway').repo, 'Project-Gifted1/ZeroDay-Telemetry-Gateway');
});

// --- secret stripping -------------------------------------------------------

test('every fake credential fixture has the real format and a PG1 test marker', () => {
  const [header, payload, signature] = FAKE.supabaseJwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iss: 'supabase', ref: 'pg1-test-fixture', role: 'service_role' });
  assert.equal(Buffer.from(signature, 'base64url').toString(), 'not-a-real-signature-pg1-test-fixture');
  assert.match(FAKE.supabaseJwt, /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(FAKE.googleKey.length, 39);
  assert.match(FAKE.googleKey, /^AIzaSy[0-9A-Za-z_-]{33}$/);
  assert.match(FAKE.supabaseSecretKey, /^sb_secret_[A-Za-z0-9]{32}$/);
  assert.match(FAKE.anthropicKey, /^sk-ant-api03-[A-Za-z0-9_-]{40}$/);
  assert.match(FAKE.openaiKey, /^sk-proj-[A-Za-z0-9]{24}$/);
  assert.match(FAKE.githubPat, /^ghp_[A-Za-z0-9]{36}$/);
  assert.match(FAKE.githubFineGrainedPat, /^github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}$/);
  assert.match(FAKE.awsAccessKeyId, /^AKIA[0-9A-Z]{16}$/);
  assert.match(FAKE.bearerToken, /^[A-Za-z0-9._~+/-]{16,}$/);
  assert.match(bearerHeader(), /^Authorization: Bearer [A-Za-z0-9._~+/-]{16,}$/);
  const pemLine = (kind) => ['-----', kind, ' RSA PRIVATE', ' KEY-----'].join('');
  assert.match(FAKE.privateKeyBlock, new RegExp(`^${pemLine('BEGIN')}\\n[\\s\\S]+\\n${pemLine('END')}$`));
  const url = new URL(postgresUrl());
  assert.equal(url.protocol, 'postgres:');
  assert.equal(url.username, FAKE.dbUser);
  assert.equal(url.password, FAKE.dbPassword);
  for (const pw of [FAKE.passkey, FAKE.dbPassword, FAKE.envSecretValue]) assert.match(pw, /\d/);
  assert.match(FAKE.passkey, /[!@#$%^&*_+=~-]/);
  assert.match(FAKE.longToken, /^(?=.*[A-Z])(?=.*[a-z])(?=(?:.*\d){2})[A-Za-z0-9]{32,}$/);
  for (const [name, value] of Object.entries(FAKE)) {
    const text = name === 'supabaseJwt' ? Buffer.from(value.split('.')[1], 'base64url').toString() : value;
    assert.match(text, /pg1/i, `${name} carries the PG1 test-fixture marker`);
  }
});

const SECRET_CASES = [
  ['Supabase service key (JWT)', `use ${FAKE.supabaseJwt} to query`, 'JWT or Supabase key'],
  ['Supabase new-style key', `key ${FAKE.supabaseSecretKey}`, 'Supabase key'],
  ['Anthropic-style key', FAKE.anthropicKey, 'API key'],
  ['OpenAI-style key', FAKE.openaiKey, 'API key'],
  ['GitHub PAT', `token ${FAKE.githubPat}`, 'GitHub token'],
  ['fine-grained PAT', FAKE.githubFineGrainedPat, 'GitHub token'],
  ['Google key', FAKE.googleKey, 'API key'],
  ['AWS key', FAKE.awsAccessKeyId, 'AWS key'],
  ['bearer header', bearerHeader(), 'bearer token'],
  ['postgres URL', postgresUrl(), 'credentials in a URL'],
  ['env assignment', `set SUPABASE_SERVICE_ROLE_KEY=${FAKE.envSecretValue} then`, 'env value'],
  ['passkey in prose', `my passkey: ${FAKE.passkey} is not working`, 'password or passkey'],
  ['USER_API_PASS', `USER_API_PASS="${FAKE.envSecretValue}"`, 'env value'],
  ['private key', FAKE.privateKeyBlock, 'private key'],
  ['random blob', `value ${FAKE.longToken} here`, 'long token']
];

for (const [name, input, label] of SECRET_CASES) {
  test(`strips ${name} and reports it`, () => {
    const out = stripSecrets(input);
    assert.ok(out.text.includes('[removed]'), out.text);
    assert.ok(out.removed.includes(label), JSON.stringify(out.removed));
    const client = stripSecretsClient(input);
    assert.equal(client.text, out.text, 'browser twin gives the same text');
    assert.deepEqual([...client.removed], out.removed, 'browser twin gives the same labels');
  });
}

test('strip keeps the variable name / scheme so the prompt still reads', () => {
  assert.equal(stripSecrets(`SUPABASE_SERVICE_ROLE_KEY=${FAKE.envSecretValue}`).text, 'SUPABASE_SERVICE_ROLE_KEY=[removed]');
  assert.equal(stripSecrets(postgresUrl()).text, 'postgres://[removed]@db.example.invalid:5432/pg1');
});

const SAFE_TEXT = [
  'Fix the drawer in public/index.html and api/handoffs.mjs',
  'Repository\nProject-Gifted1/ZeroDay-Telemetry-Gateway',
  'Revert commit 4c14ad5e98d759735214269158be245bfbd1234a',
  'Rename __clearErrorsRateLimitState in the tests',
  'The approval token: a bearer-style id stored in pending_actions',
  'Add SUPABASE_SERVICE_ROLE_KEY to the env check (do not print it)',
  'Use the risk-assessment-pipeline task-runner in tests/preflight.test.js'
];

test('ordinary task text, paths, repo slugs and SHAs are left alone', () => {
  for (const t of SAFE_TEXT) {
    assert.deepEqual(stripSecrets(t), { text: t, removed: [] }, t);
    assert.equal(stripSecretsClient(t).text, t, t);
  }
});

test('a full built prompt survives stripping unchanged', () => {
  const d = draftHandoff({ task: 'repo:ZeroDay-Telemetry-Gateway add a health check' });
  assert.deepEqual(d.removed, []);
  assert.equal(stripSecrets(d.prompt).text, d.prompt);
});

test('the deployment\'s own secret env values are stripped wherever they appear, named by variable', () => {
  const env = { SUPABASE_SERVICE_ROLE_KEY: FAKE.envSecretValue.padEnd(24, 'x'), GITHUB_TOKEN: 'plainword-passphrase', NODE_ENV: 'production', SHORT_KEY: 'abc' };
  const values = secretEnvValues(env);
  assert.deepEqual(values.map((v) => v.name).sort(), ['GITHUB_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY']);
  const d = draftHandoff({ task: `login fails with plainword-passphrase and ${env.SUPABASE_SERVICE_ROLE_KEY}`, envValues: values });
  assert.ok(!d.prompt.includes('plainword-passphrase'));
  assert.ok(!d.prompt.includes(env.SUPABASE_SERVICE_ROLE_KEY));
  assert.deepEqual(d.removed, ['value of SUPABASE_SERVICE_ROLE_KEY', 'value of GITHUB_TOKEN']);
});

test('only secret-looking names with credential-length values count as env secrets', () => {
  const env = {
    GITHUB_REPO_TOKEN_SCOPE: 'Project-Gifted1/pg1-ai-agent',
    REPO_KEY: 'https://github.com/Project-Gifted1/pg1-ai-agent',
    APP_ORIGIN_KEY: 'https://pg1-ai-agent.vercel.app',
    PUBLIC_DOCS_TOKEN_URL: 'https://example.com/docs/getting-started',
    FEATURE_FLAG_SECRET: 'true',
    RATE_LIMIT_KEY: '1234567890123456789',
    USER_API_PASS: 'short-pass',
    SUPABASE_URL: 'https://abc-project-ref.supabase.co',
    VERCEL_GIT_REPO_SLUG: 'pg1-ai-agent-long-name',
    SLACK_WEBHOOK_URL: 'https://hooks.example.invalid/services/pg1-fixture-hook-0001',
    DATABASE_URL: postgresUrl()
  };
  assert.deepEqual(secretEnvValues(env).map((v) => v.name).sort(), ['DATABASE_URL', 'SLACK_WEBHOOK_URL']);
});

test('the repo name and ordinary words are never stripped, even if an env var holds them', () => {
  const tricky = [
    { name: 'GITHUB_REPO_TOKEN_SCOPE', value: 'Project-Gifted1/pg1-ai-agent' },
    { name: 'DEFAULT_KEY_PAGE', value: 'add a footer link' },
    { name: 'SECRET_WORD', value: 'llms' }
  ];
  // Even if such values reached stripSecrets directly, the Repository line
  // is filled in after stripping, and short values are ignored.
  const d = draftHandoff({ task: 'add a footer link to llms.txt in Project-Gifted1/pg1-ai-agent', envValues: tricky, taskId: 'PG1-TASK-ALVSCG' });
  assert.match(d.prompt, /^Repository\nProject-Gifted1\/pg1-ai-agent$/m);
  assert.match(d.prompt, /llms\.txt/);
  const real = draftHandoff({ task: 'add a footer link to llms.txt', envValues: secretEnvValues({ GITHUB_REPO_TOKEN_SCOPE: 'Project-Gifted1/pg1-ai-agent' }) });
  assert.deepEqual(real.removed, []);
  assert.match(real.prompt, /^Repository\nProject-Gifted1\/pg1-ai-agent$/m);
  assert.doesNotMatch(real.prompt, /\[removed\]/);
});

test('the warning names only the variable, never the value', () => {
  const env = { SUPABASE_SERVICE_ROLE_KEY: FAKE.supabaseSecretKey };
  const d = draftHandoff({ task: `debug with ${FAKE.supabaseSecretKey}`, envValues: secretEnvValues(env) });
  assert.deepEqual(d.removed, ['value of SUPABASE_SERVICE_ROLE_KEY']);
  assert.ok(!JSON.stringify(d.removed).includes(FAKE.supabaseSecretKey));
  assert.ok(!d.prompt.includes(FAKE.supabaseSecretKey));
});

test('relevant files resolve to real repo paths; names that match nothing are dropped', () => {
  const tree = ['public/', 'public/index.html', 'public/llms.txt', 'api/', 'api/chat.mjs', 'lib/handoff.mjs', 'supabase/', 'supabase/migrations/', 'supabase/migrations/x.sql', 'node_modules/foo/llms.txt'];
  assert.deepEqual(findRelevantFiles('add a footer link to llms.txt', DEFAULT_HANDOFF_REPO, 8, tree), ['public/llms.txt']);
  assert.deepEqual(findRelevantFiles('update handoff.mjs and missing.mjs', DEFAULT_HANDOFF_REPO, 8, tree), ['lib/handoff.mjs']);
  assert.deepEqual(findRelevantFiles('fix the drawer button', DEFAULT_HANDOFF_REPO, 8, tree), ['public/index.html']);
  assert.ok(findRelevantFiles('add a supabase table', DEFAULT_HANDOFF_REPO, 8, tree).includes('supabase/migrations/'));
  assert.deepEqual(findRelevantFiles('add a supabase table', DEFAULT_HANDOFF_REPO, 8, ['public/index.html']), [], 'hint dropped when the repo lacks it');
  const d = draftHandoff({ task: 'add a footer link to llms.txt', tree });
  assert.match(d.prompt, /^- public\/llms\.txt$/m);
  assert.doesNotMatch(d.prompt, /^- llms\.txt$/m);
});

test('a secret in the task never reaches the prompt and is reported', () => {
  const d = draftHandoff({ task: `fix auth; the key is ${FAKE.anthropicKey}` });
  assert.ok(!d.prompt.includes(FAKE.anthropicKey));
  assert.doesNotMatch(d.prompt, /sk-ant-api03/);
  assert.match(d.prompt, /\[removed\]/);
  assert.deepEqual(d.removed, ['API key']);
});

// --- PR status matching -------------------------------------------------------

const pr = (n, title, state, extra = {}) => ({ number: n, title, state, html_url: `https://github.com/Project-Gifted1/pg1-ai-agent/pull/${n}`, created_at: `2026-10-0${n}T00:00:00Z`, merged_at: null, ...extra });

test('title matching needs the exact task ID, any case, not a longer ID', () => {
  assert.ok(titleHasTaskId('PG1-TASK-ABC234: add toggle', 'PG1-TASK-ABC234'));
  assert.ok(titleHasTaskId('Add toggle (pg1-task-abc234)', 'PG1-TASK-ABC234'));
  assert.ok(!titleHasTaskId('PG1-TASK-ABC2345 other', 'PG1-TASK-ABC234'));
  assert.ok(!titleHasTaskId('XPG1-TASK-ABC234', 'PG1-TASK-ABC234'));
  assert.ok(!titleHasTaskId('Add toggle', 'PG1-TASK-ABC234'));
  assert.ok(!titleHasTaskId('anything', '.*'), 'non-IDs never match');
});

test('status follows the newest matching PR: open, merged or closed', () => {
  assert.deepEqual(matchPullRequest('PG1-TASK-ABC234', [pr(1, 'PG1-TASK-ABC234 x', 'open')]),
    { status: 'pr_open', pr_url: 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/1', pr_number: 1 });
  assert.equal(matchPullRequest('PG1-TASK-ABC234', [pr(1, 'PG1-TASK-ABC234', 'closed', { merged_at: '2026-10-02T00:00:00Z' })]).status, 'merged');
  assert.equal(matchPullRequest('PG1-TASK-ABC234', [pr(1, 'PG1-TASK-ABC234', 'closed')]).status, 'closed');
  const reopened = matchPullRequest('PG1-TASK-ABC234', [pr(1, 'PG1-TASK-ABC234', 'closed'), pr(2, 'PG1-TASK-ABC234 retry', 'open')]);
  assert.equal(reopened.status, 'pr_open');
  assert.equal(reopened.pr_number, 2);
  assert.equal(matchPullRequest('PG1-TASK-ABC234', [pr(1, 'unrelated', 'open')]), null);
});

test('computeHandoffUpdates only returns changed rows and never moves a merged row', () => {
  const rows = [
    { task_id: 'PG1-TASK-AAAAAA', repo: DEFAULT_HANDOFF_REPO, status: 'sent', pr_url: null },
    { task_id: 'PG1-TASK-BBBBBB', repo: DEFAULT_HANDOFF_REPO, status: 'pr_open', pr_url: 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/2' },
    { task_id: 'PG1-TASK-CCCCCC', repo: DEFAULT_HANDOFF_REPO, status: 'merged', pr_url: 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/3' },
    { task_id: 'PG1-TASK-DDDDDD', repo: DEFAULT_HANDOFF_REPO, status: 'drafted', pr_url: null }
  ];
  const pulls = { [DEFAULT_HANDOFF_REPO]: [
    pr(1, 'PG1-TASK-AAAAAA add x', 'open'),
    pr(2, 'PG1-TASK-BBBBBB fix y', 'open'),
    pr(3, 'PG1-TASK-CCCCCC z', 'closed')
  ] };
  const updates = computeHandoffUpdates(rows, pulls);
  assert.deepEqual(updates, [{ task_id: 'PG1-TASK-AAAAAA', patch: { status: 'pr_open', pr_url: 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/1', pr_number: 1 } }]);
});

test('only plain github.com pull URLs are treated as safe links', () => {
  assert.ok(isSafePrUrl('https://github.com/Project-Gifted1/pg1-ai-agent/pull/12'));
  assert.ok(!isSafePrUrl('javascript:alert(1)'));
  assert.ok(!isSafePrUrl('https://github.com.evil.example/a/b/pull/1'));
  assert.ok(!isSafePrUrl('https://github.com/a/b/pull/1"onmouseover="x'));
});

test('the hand-off code makes no model or Anthropic calls', () => {
  for (const f of ['../lib/handoff.mjs', '../api/handoffs.mjs']) {
    const src = readFileSync(join(__dirname, f), 'utf-8');
    assert.doesNotMatch(src, /api\.anthropic\.com|x-api-key|anthropic-version|ANTHROPIC_API_KEY|fetchAnthropicCore|generativelanguage|CLAUDE_CODE_OAUTH_TOKEN/, f);
  }
});
