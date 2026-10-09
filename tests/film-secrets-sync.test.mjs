/**
 * /film sync-secrets (lib/film/secretsSync.mjs, lib/film/chat.mjs,
 * api/chat.mjs): the allowlist, the token it uses, the approve / decline
 * gate, missing values, permission errors, and that no value ever shows up
 * in a reply, a stored proposal, an error row or a log. GitHub is a stand-in
 * holding a real libsodium keypair, so every upload is decrypted and checked.
 */
import { test, describe, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { handleFilmApproval } from '../lib/film/chat.mjs';
import { FILM_ACTIONS, parseFilmCommand } from '../lib/film/text.mjs';
import { readFileSync } from 'node:fs';
import { FILM_SECRET_NAMES, filmSecretsPlan, syncFilmSecrets, syncProposalText, SECRETS_PERMISSION_TEXT } from '../lib/film/secretsSync.mjs';
import { makeFilmDb, filmDbRoutes, routedFetch, json } from './helpers/filmDb.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const SUP_URL = 'https://supabase-sync-secret-url.test';
const REPO_SECRETS = 'https://api.github.com/repos/Project-Gifted1/pg1-ai-agent/actions/secrets';

const FILM_TOKEN = 'github_pat_film_only_token_0123456789';
const VALUES = {
  PG1_VIDEO_RENDER_SECRET: 'render-secret-value-AAAA-0123456789',
  SUPABASE_URL: SUP_URL,
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-value-BBBB-0123456789',
  REPLICATE_API_TOKEN: 'r8_replicate_value_CCCC_0123456789',
  CARTESIA_API_KEY: 'sk_car_cartesia_value_DDDD_0123456789',
  GEMINI_API_KEY_PAID: 'AQ.gemini_paid_value_IIII_0123456789',
  OPENROUTER_API_KEY: 'sk-or-openrouter-value-JJJJ-0123456789'
};
const FORBIDDEN = {
  ANTHROPIC_API_KEY: 'sk-ant-anthropic-value-EEEE-0123456789',
  GITHUB_TOKEN: 'ghp_general_token_FFFF_0123456789',
  GITHUB_OWNER_KEY: 'ghp_owner_key_GGGG_0123456789',
  SOME_OTHER_SECRET: 'other-secret-HHHH-0123456789',
  // Film content goes to paid providers only: the free key never leaves.
  GEMINI_API_KEY_FREE: 'AIza-gemini-free-value-KKKK-0123456789'
};
const ALL_VALUES = [...Object.values(VALUES), ...Object.values(FORBIDDEN), FILM_TOKEN];

await sodium.ready;

// The forms a value could leak in: as is, base64, and hex.
function leaks(text) {
  const s = String(text);
  return ALL_VALUES.filter((v) => [v, Buffer.from(v).toString('base64'), Buffer.from(v).toString('hex')].some((f) => s.includes(f)));
}

// A stand-in GitHub Actions secrets API. `existing` names answer 204
// (updated), others 201 (created). `stored` holds the decrypted values.
function fakeGitHub({ keyStatus = 200, putStatus = null, existing = [] } = {}) {
  const kp = sodium.crypto_box_keypair();
  const keyB64 = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const stored = new Map();
  const handler = (u, o, body) => {
    if (u === `${REPO_SECRETS}/public-key`) {
      return keyStatus === 200 ? json({ key_id: 'kid-1', key: keyB64 }) : json({ message: 'Resource not accessible by personal access token' }, keyStatus);
    }
    assert.equal(o.method, 'PUT');
    const name = u.slice(REPO_SECRETS.length + 1);
    if (putStatus) return new Response(JSON.stringify({ message: 'nope' }), { status: putStatus });
    assert.equal(body.key_id, 'kid-1');
    const plain = sodium.crypto_box_seal_open(sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL), kp.publicKey, kp.privateKey);
    stored.set(name, sodium.to_string(plain));
    return new Response(null, { status: existing.includes(name) ? 204 : 201 });
  };
  return { handler, stored };
}

// Captures everything written to the console while `fn` runs.
async function captureConsole(fn) {
  const out = [];
  const saved = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[k] = console[k];
    console[k] = (...args) => { out.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  }
  try {
    return { result: await fn(), logs: out };
  } finally {
    Object.assign(console, saved);
  }
}

// --- the sync itself --------------------------------------------------------------------

describe('syncFilmSecrets', () => {
  test('writes exactly the allowlisted names, encrypted, with PG1_FILM_GITHUB_TOKEN only', async () => {
    const gh = fakeGitHub({ existing: ['SUPABASE_URL'] });
    const fetchImpl = routedFetch([['api.github.com', gh.handler]]);
    const env = { ...VALUES, ...FORBIDDEN, PG1_FILM_GITHUB_TOKEN: FILM_TOKEN };
    const out = await syncFilmSecrets({ env, fetchImpl });

    assert.deepEqual(FILM_SECRET_NAMES, ['PG1_VIDEO_RENDER_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'REPLICATE_API_TOKEN', 'CARTESIA_API_KEY', 'GEMINI_API_KEY_PAID', 'OPENROUTER_API_KEY']);
    assert.equal(out.ok, true);
    assert.deepEqual(out.results, FILM_SECRET_NAMES.map((name) => ({ name, result: name === 'SUPABASE_URL' ? 'updated' : 'created' })));
    assert.deepEqual([...gh.stored.keys()].sort(), [...FILM_SECRET_NAMES].sort());
    for (const name of FILM_SECRET_NAMES) assert.equal(gh.stored.get(name), VALUES[name]);

    const puts = fetchImpl.calls.filter((c) => c.method === 'PUT');
    assert.deepEqual(puts.map((c) => c.url).sort(), FILM_SECRET_NAMES.map((n) => `${REPO_SECRETS}/${n}`).sort());
    assert.ok(!fetchImpl.calls.some((c) => /ANTHROPIC|GITHUB_TOKEN|GITHUB_OWNER_KEY|SOME_OTHER|GEMINI_API_KEY_FREE/.test(c.url)));
    for (const c of fetchImpl.calls) {
      assert.equal(c.headers.Authorization, `Bearer ${FILM_TOKEN}`);
      assert.ok(c.url.startsWith(REPO_SECRETS));
      // Only ciphertext goes over the wire.
      assert.deepEqual(leaks(JSON.stringify(c.body)), []);
    }
    assert.deepEqual(leaks(JSON.stringify(out)), []);
  });

  test('never falls back to GITHUB_TOKEN or GITHUB_OWNER_KEY', async () => {
    const fetchImpl = routedFetch([]);
    const out = await syncFilmSecrets({ env: { ...VALUES, ...FORBIDDEN }, fetchImpl });
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(out.ok, false);
    assert.match(out.message, /PG1_FILM_GITHUB_TOKEN is not set/);
    assert.ok(out.results.every((r) => r.result === 'skipped'));
  });

  test('missing or empty values are skipped and reported, not sent', async () => {
    const gh = fakeGitHub();
    const fetchImpl = routedFetch([['api.github.com', gh.handler]]);
    const env = { ...VALUES, SUPABASE_SERVICE_ROLE_KEY: '', CARTESIA_API_KEY: '   ', PG1_FILM_GITHUB_TOKEN: FILM_TOKEN };
    delete env.REPLICATE_API_TOKEN;
    delete env.GEMINI_API_KEY_PAID;
    delete env.OPENROUTER_API_KEY;
    assert.deepEqual(filmSecretsPlan(env), { ready: ['PG1_VIDEO_RENDER_SECRET', 'SUPABASE_URL'], missing: ['SUPABASE_SERVICE_ROLE_KEY', 'REPLICATE_API_TOKEN', 'CARTESIA_API_KEY', 'GEMINI_API_KEY_PAID', 'OPENROUTER_API_KEY'] });
    const out = await syncFilmSecrets({ env, fetchImpl });
    assert.deepEqual(out.results, [
      { name: 'PG1_VIDEO_RENDER_SECRET', result: 'created' },
      { name: 'SUPABASE_URL', result: 'created' },
      { name: 'SUPABASE_SERVICE_ROLE_KEY', result: 'skipped' },
      { name: 'REPLICATE_API_TOKEN', result: 'skipped' },
      { name: 'CARTESIA_API_KEY', result: 'skipped' },
      { name: 'GEMINI_API_KEY_PAID', result: 'skipped' },
      { name: 'OPENROUTER_API_KEY', result: 'skipped' }
    ]);
    assert.deepEqual([...gh.stored.keys()].sort(), ['PG1_VIDEO_RENDER_SECRET', 'SUPABASE_URL']);
  });

  test('the free Gemini key never reaches the worker, even when GEMINI_API_KEY_PAID holds its value', async () => {
    assert.ok(!FILM_SECRET_NAMES.includes('GEMINI_API_KEY_FREE'));
    assert.ok(!FILM_SECRET_NAMES.some((n) => /^GEMINI_API_KEY\d?$/.test(n)), 'no old Gemini name either (it could hold a free-tier key)');
    const gh = fakeGitHub();
    const fetchImpl = routedFetch([['api.github.com', gh.handler]]);
    const env = { ...VALUES, GEMINI_API_KEY_FREE: FORBIDDEN.GEMINI_API_KEY_FREE, GEMINI_API_KEY_PAID: ` ${FORBIDDEN.GEMINI_API_KEY_FREE} `, PG1_FILM_GITHUB_TOKEN: FILM_TOKEN };
    assert.ok(filmSecretsPlan(env).missing.includes('GEMINI_API_KEY_PAID'));
    assert.match(syncProposalText(env), /- GEMINI_API_KEY_PAID: skipped \(it holds the free Gemini key\)/);
    const out = await syncFilmSecrets({ env, fetchImpl });
    assert.deepEqual(out.results.find((r) => r.name === 'GEMINI_API_KEY_PAID'), { name: 'GEMINI_API_KEY_PAID', result: 'skipped' });
    assert.ok(!gh.stored.has('GEMINI_API_KEY_PAID'));
    assert.ok(![...gh.stored.values()].includes(FORBIDDEN.GEMINI_API_KEY_FREE));
  });

  test('the render job is given the paid fallback keys and never the free Gemini key', () => {
    const yml = readFileSync(new URL('../.github/workflows/film-render.yml', import.meta.url), 'utf8');
    assert.match(yml, /GEMINI_API_KEY_PAID: \$\{\{ secrets\.GEMINI_API_KEY_PAID \}\}/);
    assert.match(yml, /OPENROUTER_API_KEY: \$\{\{ secrets\.OPENROUTER_API_KEY \}\}/);
    assert.match(yml, /ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
    assert.doesNotMatch(yml, /GEMINI_API_KEY_FREE|GEMINI_API_KEY[12]?:/, 'no free or old Gemini name in the job');
  });

  test('a token without the Secrets permission writes nothing and says so', async () => {
    for (const status of [401, 403, 404]) {
      const gh = fakeGitHub({ keyStatus: status });
      const fetchImpl = routedFetch([['api.github.com', gh.handler]]);
      const out = await syncFilmSecrets({ env: { ...VALUES, PG1_FILM_GITHUB_TOKEN: FILM_TOKEN }, fetchImpl });
      assert.equal(out.permissionDenied, true);
      assert.equal(out.message, SECRETS_PERMISSION_TEXT);
      assert.match(out.message, /Secrets: Read and write/);
      assert.equal(fetchImpl.calls.filter((c) => c.method === 'PUT').length, 0);
    }
    // Read-only Secrets permission: the key is readable, the write is not.
    const gh = fakeGitHub({ putStatus: 403 });
    const fetchImpl = routedFetch([['api.github.com', gh.handler]]);
    const out = await syncFilmSecrets({ env: { ...VALUES, PG1_FILM_GITHUB_TOKEN: FILM_TOKEN }, fetchImpl });
    assert.equal(out.ok, false);
    assert.equal(out.permissionDenied, true);
    assert.ok(out.results.every((r) => r.result === 'failed'));
    assert.equal(fetchImpl.calls.filter((c) => c.method === 'PUT').length, 1, 'stops after the first refusal');
  });

  test('another failure is reported per name, never with GitHub\'s body', async () => {
    const gh = fakeGitHub({ putStatus: 422 });
    const fetchImpl = routedFetch([['api.github.com', gh.handler]]);
    const out = await syncFilmSecrets({ env: { ...VALUES, PG1_FILM_GITHUB_TOKEN: FILM_TOKEN }, fetchImpl });
    assert.ok(out.results.every((r) => r.result === 'failed'));
    assert.equal(out.permissionDenied, false);
    assert.doesNotMatch(JSON.stringify(out), /nope/);
  });
});

// --- approval gate (handler level) ------------------------------------------------------

describe('handleFilmApproval for FILM_SYNC_SECRETS', () => {
  const row = { action_type: FILM_ACTIONS.syncSecrets, plan: {} };
  const env = { ...VALUES, ...FORBIDDEN, PG1_FILM_GITHUB_TOKEN: FILM_TOKEN };

  test('decline writes nothing', async () => {
    const fetchImpl = routedFetch([]);
    const r = await handleFilmApproval({ row, decision: 'decline', env, isOperator: true, fetchImpl });
    assert.equal(r.resolution, 'declined');
    assert.match(r.reply, /Nothing was written to GitHub/);
    assert.equal(fetchImpl.calls.length, 0);
  });

  test('without the operator role nothing is written', async () => {
    const fetchImpl = routedFetch([]);
    const r = await handleFilmApproval({ row, decision: 'approve', env, fetchImpl });
    assert.equal(r.resolution, null);
    assert.equal(fetchImpl.calls.length, 0);
  });

  test('parses as its own subcommand', () => {
    assert.deepEqual(parseFilmCommand('/film sync-secrets'), { sub: 'sync-secrets', id: null, rest: '' });
    assert.deepEqual(parseFilmCommand('/FILM Sync-Secrets now'), { sub: 'sync-secrets', id: null, rest: '' });
  });
});

// --- the chat ---------------------------------------------------------------------------

describe('/film sync-secrets in the chat', () => {
  let db;
  let calls;
  let gh;
  let ipSeq = 0;
  const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.84.0.${++ipSeq}` }, body });
  const makeRes = () => ({
    statusCode: null, headers: {}, jsonBody: null,
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; },
    write() { return true; }, end() { return this; }, on() {}
  });
  const chat = async (body) => { const res = makeRes(); await chatHandler(makeReq(body), res); return res; };
  const authed = (extra) => ({ user: 'test-operator', pass: 'test-secret-pass', ...extra });
  const githubCalls = () => calls.filter((c) => c.url.includes('api.github.com'));

  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV, ...VALUES, ...FORBIDDEN };
    process.env.USER_API_KEY = 'test-operator';
    process.env.USER_API_PASS = 'test-secret-pass';
    process.env.PG1_FILM_GITHUB_TOKEN = FILM_TOKEN;
    process.env.PG1_VIDEO_ENABLED = '1';
    for (const k of ['GEMINI_API_KEY', 'GEMINI_API_KEY1', 'GEMINI_API_KEY2', 'ANTROPIC_API_KEY']) delete process.env[k];
    __clearAuthRateLimitState();
    db = await makeFilmDb();
    calls = [];
    gh = fakeGitHub({ existing: ['PG1_VIDEO_RENDER_SECRET'] });
    globalThis.fetch = routedFetch([
      ['api.github.com', gh.handler],
      ['/rest/v1/messages', (u, o) => (o.method === 'POST' ? new Response('', { status: 201 }) : json([]))],
      ['/storage/v1/object/list/pg1-vault', () => json([])],
      ['/rest/v1/threat_indicators', () => json([])],
      ...filmDbRoutes(db)
    ], calls);
  });

  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });
  after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

  const pendingRows = async () => (await db.query('select * from pending_actions')).rows;

  test('guests get a 401 and nothing is proposed or written', async () => {
    const res = await chat({ prompt: '/film sync-secrets' });
    assert.equal(res.statusCode, 401);
    assert.equal((await pendingRows()).length, 0);
    assert.equal(githubCalls().length, 0);
  });

  test('the command only proposes; decline leaves GitHub untouched', async () => {
    const { result: res, logs } = await captureConsole(() => chat(authed({ prompt: '/film sync-secrets' })));
    assert.equal(res.statusCode, 200);
    const body = res.jsonBody;
    assert.ok(body.pendingApproval && body.pendingApproval.token);
    for (const n of FILM_SECRET_NAMES) assert.match(body.reply, new RegExp(`- ${n}: will be written`));
    assert.doesNotMatch(body.reply, /ANTHROPIC_API_KEY|GITHUB_OWNER_KEY/);
    assert.equal(githubCalls().length, 0, 'nothing reaches GitHub before approval');
    const rows = await pendingRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action_type, 'FILM_SYNC_SECRETS');
    assert.deepEqual(leaks(JSON.stringify(rows)), [], 'the stored proposal holds names only');
    assert.deepEqual(leaks(JSON.stringify(body)), []);
    assert.deepEqual(leaks(logs.join('\n')), []);

    const no = await chat(authed({ action: 'CONFIRM_PENDING_ACTION', token: body.pendingApproval.token, decision: 'decline' }));
    assert.match(no.jsonBody.reply, /declined\. Nothing was written to GitHub/);
    assert.equal(githubCalls().length, 0);
    assert.equal((await pendingRows())[0].status, 'declined');

    const again = await chat(authed({ action: 'CONFIRM_PENDING_ACTION', token: body.pendingApproval.token, decision: 'approve' }));
    assert.match(again.jsonBody.reply, /already 'declined'/);
    assert.equal(githubCalls().length, 0);
  });

  test('approving writes the allowlisted secrets and the reply shows names and results only', async () => {
    delete process.env.CARTESIA_API_KEY;
    const proposed = await chat(authed({ prompt: '/film sync-secrets' }));
    assert.match(proposed.jsonBody.reply, /- CARTESIA_API_KEY: skipped \(not set here\)/);

    const { result: ok, logs } = await captureConsole(() => chat(authed({ action: 'CONFIRM_PENDING_ACTION', token: proposed.jsonBody.pendingApproval.token, decision: 'approve' })));
    const reply = ok.jsonBody.reply;
    assert.match(reply, /- PG1_VIDEO_RENDER_SECRET: updated/);
    assert.match(reply, /- SUPABASE_URL: created/);
    assert.match(reply, /- SUPABASE_SERVICE_ROLE_KEY: created/);
    assert.match(reply, /- REPLICATE_API_TOKEN: created/);
    assert.match(reply, /- CARTESIA_API_KEY: skipped/);
    assert.match(reply, /- GEMINI_API_KEY_PAID: created/);
    assert.match(reply, /- OPENROUTER_API_KEY: created/);
    assert.doesNotMatch(reply, /GEMINI_API_KEY_FREE/);
    assert.equal((await pendingRows())[0].status, 'approved');

    assert.deepEqual([...gh.stored.keys()].sort(), ['GEMINI_API_KEY_PAID', 'OPENROUTER_API_KEY', 'PG1_VIDEO_RENDER_SECRET', 'REPLICATE_API_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL']);
    for (const [name, value] of gh.stored) assert.equal(value, VALUES[name]);
    for (const c of githubCalls()) {
      assert.equal(c.headers.Authorization, `Bearer ${FILM_TOKEN}`);
      assert.ok(!/ANTHROPIC/.test(c.url));
    }
    assert.deepEqual(leaks(JSON.stringify(ok.jsonBody)), []);
    assert.deepEqual(leaks(logs.join('\n')), []);
  });

  test('a token without the Secrets permission: a clear message, no values anywhere', async () => {
    gh = fakeGitHub({ keyStatus: 403 });
    globalThis.fetch = routedFetch([
      ['api.github.com', gh.handler],
      ['/rest/v1/messages', (u, o) => (o.method === 'POST' ? new Response('', { status: 201 }) : json([]))],
      ['/storage/v1/object/list/pg1-vault', () => json([])],
      ['/rest/v1/threat_indicators', () => json([])],
      ...filmDbRoutes(db)
    ], calls);
    const proposed = await chat(authed({ prompt: '/film sync-secrets' }));
    const { result: res, logs } = await captureConsole(() => chat(authed({ action: 'CONFIRM_PENDING_ACTION', token: proposed.jsonBody.pendingApproval.token, decision: 'approve' })));
    assert.match(res.jsonBody.reply, /does not have the Secrets permission/);
    assert.equal(gh.stored.size, 0);
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
    // The failure row (pg1_errors) carries no value either.
    const errorPosts = calls.filter((c) => c.url.includes('/rest/v1/pg1_errors'));
    assert.deepEqual(leaks(JSON.stringify(errorPosts.map((c) => c.body))), []);
    assert.deepEqual(leaks(JSON.stringify(res.jsonBody)), []);
    assert.deepEqual(leaks(logs.join('\n')), []);
  });

  test('without PG1_FILM_GITHUB_TOKEN nothing is proposed, even with GITHUB_TOKEN set', async () => {
    delete process.env.PG1_FILM_GITHUB_TOKEN;
    const res = await chat(authed({ prompt: '/film sync-secrets' }));
    assert.match(res.jsonBody.reply, /PG1_FILM_GITHUB_TOKEN is not set/);
    assert.equal(res.jsonBody.pendingApproval, undefined);
    assert.equal((await pendingRows()).length, 0);
    assert.equal(githubCalls().length, 0);
  });
});
