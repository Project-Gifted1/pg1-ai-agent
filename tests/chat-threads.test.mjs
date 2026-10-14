/**
 * Saved chats ("Session threads"): api/threads.mjs and lib/chatThreads.mjs
 * against a real Postgres (PGlite) with the migration applied, behind a
 * small PostgREST stand-in.
 *
 * Covered: the migration (table shape, checks, RLS on, nothing for anon or
 * authenticated, re-runnable); guests and wrong passkeys are blocked before
 * any storage call; save with an auto title from the first message; secrets
 * withheld before storage; auto-update after saving (same thread, title
 * kept); list newest first; load (get) with the full conversation in order;
 * rename; delete only with confirmation; unknown ids; input limits; and the
 * old hard-coded placeholder threads are gone from the page.
 *
 * Run with: node --test tests/chat-threads.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeThreadsDb, threadsRest } from './helpers/threadsDb.mjs';

const OPERATOR = { user: 'test-operator', pass: 'test-secret-pass' };
const SECRET_VALUE = 'svc_' + 'Zq9'.repeat(10);

const { default: threadsHandler, __clearThreadsRateLimitState } = await import('../api/threads.mjs');
const { __clearAuthRateLimitState } = await import('../api/chat.mjs');
const { autoTitle, cleanMessages, cleanTitle, ThreadInputError, MAX_THREAD_MESSAGES, AUTO_TITLE_CHARS } = await import('../lib/chatThreads.mjs');

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const SUP_URL = 'https://supabase.test';

let db;
let calls;
beforeEach(async () => {
  process.env.USER_API_KEY = OPERATOR.user;
  process.env.USER_API_PASS = OPERATOR.pass;
  process.env.SUPABASE_URL = SUP_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  process.env.PG1_TEST_SERVICE_SECRET = SECRET_VALUE;
  __clearThreadsRateLimitState();
  __clearAuthRateLimitState();
  db = await makeThreadsDb();
  calls = [];
  globalThis.fetch = threadsRest(db, calls);
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

function makeRes() {
  return {
    statusCode: null, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; }
  };
}

let ipSeq = 0;
async function call(body, { creds = OPERATOR, method = 'POST' } = {}) {
  const res = makeRes();
  await threadsHandler({ method, headers: {}, socket: { remoteAddress: `10.9.0.${++ipSeq}` }, body: { ...creds, ...body } }, res);
  return res;
}

const CHAT = [
  { role: 'user', text: 'Check the domain **pg1-test-flagged.invalid** for me and tell me how old it is, please', at: '2026-10-13T09:00:00Z' },
  { role: 'assistant', text: 'It is **flagged**: registered 3 days ago.\n\n`check_domain_age` ran.', at: '2026-10-13T09:00:05Z' }
];

// --- schema -------------------------------------------------------------------

test('migration: pg1_chat_threads has the columns, checks, RLS on and nothing for anon/authenticated', async () => {
  const { rows: cols } = await db.query(`select column_name, data_type, is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'pg1_chat_threads' order by ordinal_position`);
  assert.deepEqual(cols.map((c) => [c.column_name, c.data_type, c.is_nullable]), [
    ['id', 'uuid', 'NO'], ['created_at', 'timestamp with time zone', 'NO'], ['updated_at', 'timestamp with time zone', 'NO'],
    ['title', 'text', 'NO'], ['messages', 'jsonb', 'NO'], ['message_count', 'integer', 'NO'],
    // P1 (20261017120000_pg1_thread_task_state.sql): the thread's task state and rolling summary.
    ['task_state', 'jsonb', 'YES'], ['context_summary', 'jsonb', 'YES']
  ]);
  const { rows: rls } = await db.query(`select relrowsecurity from pg_class where oid = 'public.pg1_chat_threads'::regclass`);
  assert.equal(rls[0].relrowsecurity, true);
  const { rows: grants } = await db.query(`select grantee from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'pg1_chat_threads' and grantee in ('anon', 'authenticated', 'PUBLIC')`);
  assert.deepEqual(grants, []);
  await assert.rejects(db.query(`insert into public.pg1_chat_threads (title) values ('')`), /pg1_chat_threads_title_check/);
  await assert.rejects(db.query(`insert into public.pg1_chat_threads (title, messages) values ('x', '{}')`), /pg1_chat_threads_messages_check/);
  const { rows: tel } = await db.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'agent_telemetry'`);
  for (const c of ['mcp_method', 'requested_tool', 'amount_usd']) assert.ok(tel.some((r) => r.column_name === c), c);
  await db.query(`insert into public.agent_telemetry (event_type, endpoint, status, mcp_method) values ('mcp_request', '/api/mcp', 'ok', 'tools/list')`);
});

// --- access -------------------------------------------------------------------

test('guests are blocked: no credentials or a wrong passkey is 401 and never touches storage', async () => {
  for (const creds of [{}, { user: OPERATOR.user, pass: 'wrong' }, { user: 'guest', pass: '' }]) {
    for (const op of ['list', 'save', 'get', 'rename', 'delete']) {
      const res = await call({ op, messages: CHAT, id: '00000000-0000-4000-8000-000000000000', title: 'x', confirm: true }, { creds });
      assert.equal(res.statusCode, 401, `${op} as ${JSON.stringify(creds)}`);
      assert.match(res.body.message, /signed-in operator only/);
    }
  }
  assert.equal(calls.length, 0, 'no storage call for a guest');
  const get = makeRes();
  await threadsHandler({ method: 'GET', headers: {}, body: null }, get);
  assert.equal(get.statusCode, 405);
});

// --- save, auto-update, load ------------------------------------------------------

test('save: a new thread titled from the first message; secrets are withheld before storage', async () => {
  const messages = [...CHAT, { role: 'user', text: `here is the key sk-ant-${'a1B2'.repeat(8)} and ${SECRET_VALUE}` }];
  const res = await call({ op: 'save', messages });
  assert.equal(res.statusCode, 201);
  const t = res.body.thread;
  assert.match(t.id, /^[0-9a-f-]{36}$/);
  assert.equal(t.title, 'Check the domain pg1-test-flagged.invalid for me and tell…', 'cut at a word');
  assert.ok(t.title.length <= AUTO_TITLE_CHARS);
  assert.equal(t.message_count, 3);
  const { rows } = await db.query('select messages::text as m from public.pg1_chat_threads where id = $1', [t.id]);
  assert.ok(!rows[0].m.includes('sk-ant-'), 'API key withheld');
  assert.ok(!rows[0].m.includes(SECRET_VALUE), 'the deployment secret value withheld');
  assert.match(rows[0].m, /\[withheld\]/);
  assert.ok(rows[0].m.includes('**flagged**'), 'markdown kept as written');

  const empty = await call({ op: 'save', messages: [] });
  assert.equal(empty.statusCode, 400);
  const titled = await call({ op: 'save', messages: CHAT, title: '  My  title ' });
  assert.equal(titled.body.thread.title, 'My title');
});

test('auto-update after saving: the same thread gets the new messages, the title stays', async () => {
  const first = (await call({ op: 'save', messages: CHAT })).body.thread;
  await db.query(`update public.pg1_chat_threads set updated_at = now() - interval '1 hour' where id = $1`, [first.id]);
  const more = [...CHAT, { role: 'user', text: 'And the wallet 0x7067312d?' }, { role: 'assistant', text: 'No flags.' }];
  const res = await call({ op: 'save', id: first.id, messages: more, title: 'ignored on update' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.thread.id, first.id);
  assert.equal(res.body.thread.title, first.title, 'auto-update never changes the title');
  assert.equal(res.body.thread.message_count, 4);
  assert.ok(Date.parse(res.body.thread.updated_at) > Date.parse(first.updated_at) - 1000);
  const { rows } = await db.query('select count(*)::int as n from public.pg1_chat_threads');
  assert.equal(rows[0].n, 1, 'no second thread');

  const loaded = await call({ op: 'get', id: first.id });
  assert.equal(loaded.statusCode, 200);
  assert.deepEqual(loaded.body.thread.messages.map((m) => [m.role, m.text]), more.map((m) => [m.role, m.text]), 'the full conversation, in order');
  assert.equal(loaded.body.thread.messages[0].at, '2026-10-13T09:00:00.000Z');
});

test('list: newest first, summaries only; "No saved chats yet" when empty', async () => {
  assert.deepEqual((await call({ op: 'list' })).body.threads, []);
  const a = (await call({ op: 'save', messages: [{ role: 'user', text: 'first chat' }] })).body.thread;
  const b = (await call({ op: 'save', messages: [{ role: 'user', text: 'second chat' }] })).body.thread;
  await db.query(`update public.pg1_chat_threads set updated_at = now() - interval '1 day' where id = $1`, [a.id]);
  let list = (await call({ op: 'list' })).body.threads;
  assert.deepEqual(list.map((t) => t.title), ['second chat', 'first chat']);
  assert.ok(list.every((t) => !('messages' in t)));
  await call({ op: 'save', id: a.id, messages: [{ role: 'user', text: 'first chat' }, { role: 'assistant', text: 'updated' }] });
  list = (await call({ op: 'list' })).body.threads;
  assert.deepEqual(list.map((t) => t.id), [a.id, b.id], 'an updated thread moves to the top');
});

test('rename: a new title (guarded, one line); an empty title is refused', async () => {
  const t = (await call({ op: 'save', messages: CHAT })).body.thread;
  const res = await call({ op: 'rename', id: t.id, title: 'Domain checks\nfor Monday' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.thread.title, 'Domain checks for Monday');
  assert.equal((await call({ op: 'rename', id: t.id, title: '   ' })).statusCode, 400);
  assert.equal((await call({ op: 'rename', id: t.id, title: `key ${SECRET_VALUE}` })).body.thread.title, 'key [withheld]');
});

test('delete: only with confirm: true; then it is gone', async () => {
  const t = (await call({ op: 'save', messages: CHAT })).body.thread;
  const unconfirmed = await call({ op: 'delete', id: t.id });
  assert.equal(unconfirmed.statusCode, 400);
  assert.match(unconfirmed.body.message, /confirm/);
  assert.equal((await call({ op: 'list' })).body.threads.length, 1, 'still there');
  const res = await call({ op: 'delete', id: t.id, confirm: true });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deleted, t.id);
  assert.deepEqual((await call({ op: 'list' })).body.threads, []);
  assert.equal((await call({ op: 'get', id: t.id })).statusCode, 404);
  assert.equal((await call({ op: 'save', id: t.id, messages: CHAT })).statusCode, 404, 'auto-update of a deleted thread is a 404');
  assert.equal((await call({ op: 'delete', id: t.id, confirm: true })).statusCode, 404);
});

test('bad input: ids, roles, sizes and unknown ops are refused without a storage call', async () => {
  const before = calls.length;
  assert.equal((await call({ op: 'get', id: "1' or '1'='1" })).statusCode, 400);
  assert.equal((await call({ op: 'save', messages: [{ role: 'system', text: 'x' }] })).statusCode, 400);
  assert.equal((await call({ op: 'save', messages: 'nope' })).statusCode, 400);
  assert.equal((await call({ op: 'save', messages: [{ role: 'user', text: 'x'.repeat(20001) }] })).statusCode, 413);
  assert.equal((await call({ op: 'drop_table' })).statusCode, 400);
  assert.equal(calls.length, before);
  assert.throws(() => cleanMessages(Array.from({ length: MAX_THREAD_MESSAGES + 1 }, () => ({ role: 'user', text: 'x' }))), ThreadInputError);
});

test('autoTitle and cleanTitle', () => {
  assert.equal(autoTitle([{ role: 'assistant', text: 'hello' }, { role: 'user', text: '## /usage 7d' }]), '/usage 7d');
  assert.equal(autoTitle([{ role: 'user', text: '```js\nconst x = 1\n```\nWhy does this fail?' }]), 'Why does this fail?');
  assert.match(autoTitle([], new Date('2026-10-13T00:00:00Z')), /^Chat 2026-10-13$/);
  assert.equal(cleanTitle('a'.repeat(300)).length, 120);
  assert.throws(() => cleanTitle(42), ThreadInputError);
});

// --- the page -----------------------------------------------------------------

test('the hard-coded placeholder threads are gone from the Session threads sheet', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const gone of ['Directive: Node Scaling', 'System Audit Log', 'thread-demo-1', 'thread-demo-2', 'Sovereign matrix?', 'System routing to Thread ID']) {
    assert.ok(!html.includes(gone), `${gone} removed`);
  }
  assert.match(html, /<div class="thread-list" id="thread-list-container" aria-live="polite"><\/div>/, 'the list starts empty and is filled from /api/threads');
  assert.ok(html.includes('No saved chats yet'));
  assert.ok(html.includes("fetch('/api/threads'"));
  assert.match(html, /id="save-thread-btn"[^>]*aria-pressed="false"/);
});
