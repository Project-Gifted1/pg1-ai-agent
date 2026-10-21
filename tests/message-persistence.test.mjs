// Message persistence (production, 20 Oct: PostgREST refused the messages
// insert with 400 PGRST102 "All object keys must match", for relayed turns
// at 19:13, 19:17 and 19:18 UTC and for ordinary operator turns at 05:20
// and 13:16-13:19, and nobody saw it: the insert was fire-and-forget).
//
//   - a bulk insert's rows carry the same keys (lib/restRows.mjs), and the
//     PostgREST stand-in refuses a mixed batch the way production does;
//   - an operator exchange and a relayed one save both rows, on the JSON
//     and the streamed reply;
//   - a refused insert goes to the error log (area chat: PostgREST's code
//     and message, never the content) and the reply says messageSaved:
//     false, on both paths.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDb, pgRest } from './helpers/pgrest.mjs';
import { uniformRows, MixedKeysError } from '../lib/restRows.mjs';
import { exchangeRows, __resetSpeakerColumns } from '../lib/relay.mjs';
import { extractEuWallets } from '../lib/sanctionsEu.mjs';
import { __resetAutonomousSnapshot } from '../lib/autonomous/state.mjs';
import { createSseParser } from '../lib/chatStream.mjs';

const chatModule = await import('../api/chat.mjs');
const chatHandler = chatModule.default;
const { __clearAuthRateLimitState } = chatModule;

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const OPERATOR = { user: 'test-operator', pass: 'test-secret-pass' };
const SUP = 'https://supabase.test';
const SECRET_TEXT = 'my private note about the Lisbon deal';

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, USER_API_KEY: OPERATOR.user, USER_API_PASS: OPERATOR.pass, SUPABASE_URL: SUP, SUPABASE_SERVICE_ROLE_KEY: 'service-role-persist', GEMINI_API_KEY: 'stub-gemini-key' };
  for (const k of ['GITHUB_TOKEN', 'VERCEL_TOKEN', 'PG1_AUTONOMY', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'CARTESIA_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'PG1_VIDEO_ENABLED']) delete process.env[k];
  __resetAutonomousSnapshot();
  __clearAuthRateLimitState();
  __resetSpeakerColumns();
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

// --- uniform keys ------------------------------------------------------------------

test('uniformRows: matching rows pass through unchanged; a missing key or an undefined value is caught before anything is sent', () => {
  const rows = [{ a: 1, b: null }, { b: 2, a: 3 }];
  assert.equal(uniformRows(rows, 't'), rows);
  assert.deepEqual(uniformRows([{ a: 1 }], 't'), [{ a: 1 }]);
  assert.throws(() => uniformRows([{ a: 1, b: 2 }, { a: 1 }], 'messages'), (e) => e instanceof MixedKeysError && e.code === 'MIXED_KEYS' && /messages: row 1 has keys \[a\], row 0 has \[a, b\]/.test(e.message));
  // JSON.stringify drops undefined, so it is a missing key on the wire.
  assert.throws(() => uniformRows([{ a: 1, b: 2 }, { a: 1, b: undefined }], 't'), MixedKeysError);
});

test('every exchange the chat sends has the same keys on both rows (operator, relay, and the fallback without the columns)', () => {
  for (const args of [{}, { relay: { name: 'grok' } }, { withSpeaker: false }, { relay: { name: 'grok' }, withSpeaker: false }]) {
    const [u, m] = exchangeRows({ prompt: 'p', reply: 'r', ...args });
    assert.deepEqual(Object.keys(u).sort(), Object.keys(m).sort(), JSON.stringify(args));
  }
});

test('the other bulk inserts send uniform rows: EU sanctions wallets with or without a reference', () => {
  const block = (ref, addr) => `<sanctionEntity${ref ? ` euReferenceNumber="${ref}"` : ''}><nameAlias wholeName="X"/>digital currency address ${addr}</sanctionEntity>`;
  const rows = extractEuWallets(`<export>${block('EU.1', '0x' + 'a'.repeat(40))}${block(null, '0x' + 'b'.repeat(40))}</export>`);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].eu_reference, null);
  assert.doesNotThrow(() => uniformRows(rows, 'eu'));
});

test('the PostgREST stand-in refuses a mixed batch with 400 PGRST102, like production, and accepts it with ?columns=', async () => {
  const db = await makeDb([]);
  await db.exec('create table public.t (id bigserial primary key, a text, b text);');
  const rest = pgRest(db);
  const post = (q, body) => rest(`${SUP}/rest/v1/t${q}`, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) });
  const bad = await post('', [{ a: '1', b: '2' }, { a: '3' }]);
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { code: 'PGRST102', details: null, hint: null, message: 'All object keys must match' });
  assert.equal((await post('', [{ a: '1', b: null }, { a: '3', b: null }])).status, 201);
  assert.equal((await post('?columns=a,b', [{ a: '1', b: '2' }, { a: '3' }])).status, 201);
  assert.equal((await db.query('select count(*)::int as n from public.t')).rows[0].n, 4, 'the two accepted batches, nothing from the refused one');
});

// --- the chat handler, end to end ----------------------------------------------------

async function world({ refuseMessages = null } = {}) {
  const db = await makeDb(['20260930160000_pg1_errors.sql', '20260930170000_pg1_errors_category.sql', '20261104120000_pg1_autonomous.sql', '20261105120000_pg1_missions.sql']);
  // request_id is in production (the error log writes it when it can).
  await db.exec('alter table public.pg1_errors add column if not exists request_id text;');
  await db.exec('create table public.messages (id bigserial primary key, created_at timestamptz not null default now(), role text not null, content text not null);');
  await db.exec(readFileSync(new URL('../supabase/migrations/20261106120000_pg1_chat_relay.sql', import.meta.url), 'utf8'));
  const calls = [];
  const rest = pgRest(db, {
    calls,
    passthrough: async (url, options) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        const part = { candidates: [{ content: { parts: [{ text: 'Noted. Here is my answer.' }] } }] };
        if (url.includes('streamGenerateContent')) return new Response(`data: ${JSON.stringify(part)}\n\n`);
        return new Response(JSON.stringify(part), { headers: { 'Content-Type': 'application/json' } });
      }
      return null;
    }
  });
  globalThis.fetch = async (url, options = {}) => {
    if (refuseMessages && String(url).startsWith(`${SUP}/rest/v1/messages`) && (options.method || 'GET') === 'POST') {
      calls.push({ url: String(url), method: 'POST', body: options.body });
      return new Response(JSON.stringify(refuseMessages.body), { status: refuseMessages.status, headers: { 'Content-Type': 'application/json' } });
    }
    return rest(url, options);
  };
  return { db, calls };
}
const rows = async (db, sql) => (await db.query(sql)).rows;

let ip = 0;
async function chat(body) {
  const res = { statusCode: null, headers: {}, chunks: [], jsonBody: null, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; }, write(c) { this.chunks.push(String(c)); return true; }, end() { return this; }, on() {} };
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.68.0.${++ip}` }, body: { ...OPERATOR, ...body } }, res);
  // The error log write is fire-and-forget; the message insert is awaited.
  await new Promise((r) => setTimeout(r, 50));
  return res;
}
function doneEvent(res) {
  const events = [];
  const parser = createSseParser(({ data }) => events.push(JSON.parse(data)));
  parser.push(res.chunks.join(''));
  parser.end();
  return events.find((e) => e.type === 'done');
}

for (const stream of [false, true]) {
  const path = stream ? 'streamed' : 'JSON';
  test(`${path} reply: an ordinary operator message saves both rows (speaker operator, reply null), before the reply is sent`, async () => {
    const { db } = await world();
    const res = await chat({ prompt: SECRET_TEXT, stream });
    assert.equal(res.statusCode, 200);
    const stored = await rows(db, 'select role, content, speaker, relay_name from public.messages order by id');
    assert.deepEqual(stored.map((r) => [r.role, r.speaker, r.relay_name]), [['user', 'operator', null], ['model', null, null]]);
    assert.equal(stored[0].content, SECRET_TEXT);
    const out = stream ? doneEvent(res) : res.jsonBody;
    assert.ok(out, 'a reply');
    assert.equal(out.messageSaved, undefined, 'no marker when it saved');
    assert.equal((await rows(db, 'select count(*)::int as n from public.pg1_errors'))[0].n, 0);
  });

  test(`${path} reply: a relayed message saves both rows (relay with its name, reply null)`, async () => {
    const { db } = await world();
    await chat({ prompt: '/relay grok Appreciate that, PG1.', stream });
    const stored = await rows(db, 'select role, speaker, relay_name from public.messages order by id');
    assert.deepEqual(stored.map((r) => [r.role, r.speaker, r.relay_name]), [['user', 'relay', 'grok'], ['model', null, null]]);
  });

  test(`${path} reply: a refused insert (PGRST102) is in the error log under area chat, with no content, and the reply says it was not saved`, async () => {
    const { db } = await world({ refuseMessages: { status: 400, body: { code: 'PGRST102', details: 'row 1: ' + SECRET_TEXT, hint: null, message: 'All object keys must match' } } });
    const res = await chat({ prompt: SECRET_TEXT, stream });
    assert.equal(res.statusCode, 200, 'the reply is still sent');
    const out = stream ? doneEvent(res) : res.jsonBody;
    assert.equal(out.messageSaved, false);
    assert.match(stream ? res.chunks.join('') : out.reply, /Noted\. Here is my answer\./);
    const errors = await rows(db, 'select source, route, status, reason, message, category, request_id from public.pg1_errors');
    assert.equal(errors.length, 1);
    assert.deepEqual({ ...errors[0], request_id: undefined }, { source: 'server', route: '/api/chat', status: 400, reason: 'message_save_failed', message: 'messages insert PGRST102: All object keys must match', category: 'chat', request_id: undefined });
    assert.ok(errors[0].request_id, 'the request id, to find the turn');
    assert.ok(!JSON.stringify(errors).includes('Lisbon'), 'never the message text, nor PostgREST details');
  });
}

test('a timeout saving the exchange is logged and marked too (no PostgREST code: the network error instead)', async () => {
  const { db } = await world();
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith(`${SUP}/rest/v1/messages`) && options.method === 'POST') throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    return inner(url, options);
  };
  const res = await chat({ prompt: 'hello there friend, what is new' });
  assert.equal(res.jsonBody.messageSaved, false);
  const errors = await rows(db, 'select status, reason, message from public.pg1_errors');
  assert.deepEqual(errors, [{ status: 500, reason: 'message_save_failed', message: 'messages insert timed out' }]);
});
