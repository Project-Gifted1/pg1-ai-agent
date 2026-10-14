// A real Postgres (PGlite) with the saved-chats migration applied, behind a
// small PostgREST stand-in for public.pg1_chat_threads: the shapes
// api/threads.mjs sends. Used by tests/chat-threads.test.mjs and the
// browser test, which runs the real handler against it.

import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION = readFileSync(new URL('../../supabase/migrations/20261015120000_pg1_usage_report_and_chat_threads.sql', import.meta.url), 'utf8');
// Task state and rolling summary columns (P1).
const TASK_STATE_MIGRATION = readFileSync(new URL('../../supabase/migrations/20261017120000_pg1_thread_task_state.sql', import.meta.url), 'utf8');

// The telemetry part of the migration needs the table it alters.
export async function makeThreadsDb({ withTaskState = true } = {}) {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  await db.exec(`create table public.agent_telemetry (id bigint generated always as identity primary key, created_at timestamptz not null default now(),
    event_type text not null default 'tool_call', endpoint text not null, tool_name text, payment_type text not null default 'none', status text not null)`);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION); // re-runnable
  if (withTaskState) {
    await db.exec(TASK_STATE_MIGRATION);
    await db.exec(TASK_STATE_MIGRATION); // re-runnable
  }
  return db;
}

export const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

// PostgREST for public.pg1_chat_threads: the shapes api/threads.mjs sends.
export function threadsRest(db, calls = []) {
  return async (url, options = {}) => {
    const u = new URL(String(url));
    const method = options.method || 'GET';
    calls.push({ url: String(url), method });
    if (!u.pathname.endsWith('/rest/v1/pg1_chat_threads')) throw new Error('Unexpected network call in test: ' + url);
    const where = [];
    const vals = [];
    let order = '';
    let limit = '';
    let select = '*';
    for (const [k, v] of u.searchParams) {
      if (k === 'select') { select = v.split(',').filter((c) => /^[a-z_]+$/.test(c)).join(', ') || '*'; continue; }
      if (k === 'order') { const [col, dir] = v.split('.'); order = ` order by ${col} ${dir === 'desc' ? 'desc' : 'asc'}`; continue; }
      if (k === 'limit') { limit = ` limit ${Number(v)}`; continue; }
      if (!/^[a-z_]+$/.test(k) || !v.startsWith('eq.')) throw new Error(`unsupported filter ${k}=${v}`);
      vals.push(v.slice(3));
      where.push(`${k}::text = $${vals.length}`);
    }
    const w = where.length ? where.join(' and ') : 'true';
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    const enc = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
    try {
      if (method === 'POST') {
        const keys = Object.keys(body);
        const r = await db.query(`insert into public.pg1_chat_threads (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning ${select}`, keys.map((k) => enc(body[k])));
        return json(r.rows, 201);
      }
      if (method === 'PATCH') {
        const sets = Object.entries(body).map(([k, v]) => { vals.push(enc(v)); return `${k} = $${vals.length}`; });
        return json((await db.query(`update public.pg1_chat_threads set ${sets.join(', ')} where ${w} returning ${select}`, vals)).rows);
      }
      if (method === 'DELETE') return json((await db.query(`delete from public.pg1_chat_threads where ${w} returning ${select}`, vals)).rows);
      return json((await db.query(`select ${select} from public.pg1_chat_threads where ${w}${order}${limit}`, vals)).rows);
    } catch (e) {
      return json({ code: e.code || 'XX000', message: e.message }, 400);
    }
  };
}

