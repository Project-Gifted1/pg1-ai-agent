// A real Postgres (PGlite) with the PG1 Studio migration applied, behind a
// small PostgREST + Storage stand-in, for the film tests. Only the shapes
// lib/film/store.mjs sends are handled; anything else fails the test.

import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const FILM_MIGRATION = readFileSync(new URL('../../supabase/migrations/20261011120000_pg1_film.sql', import.meta.url), 'utf8');

export const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

export async function makeFilmDb() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  // pending_actions predates the migrations folder; the columns api/chat.mjs uses.
  await db.exec(`create table public.pending_actions (token text primary key, action_type text, plan jsonb, diff_summary text, status text,
    created_at timestamptz, expires_at timestamptz, resolved_at timestamptz)`);
  await db.exec(FILM_MIGRATION);
  await db.exec(FILM_MIGRATION); // re-runnable
  return db;
}

const TABLES = new Set(['pg1_film_projects', 'pg1_film_assets', 'pending_actions']);
const val = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

function filters(url) {
  const where = [];
  const vals = [];
  let order = '';
  let limit = '';
  for (const [k, v] of new URL(url).searchParams) {
    if (k === 'select') continue;
    if (k === 'order') { const [col, dir] = v.split('.'); order = ` order by ${col} ${dir === 'desc' ? 'desc' : 'asc'}`; continue; }
    if (k === 'limit') { limit = ` limit ${Number(v)}`; continue; }
    if (!/^[a-z_]+$/.test(k)) throw new Error(`bad column ${k}`);
    if (v.startsWith('eq.')) { vals.push(v.slice(3)); where.push(`${k}::text = $${vals.length}`); } else if (v.startsWith('in.(')) {
      const ph = v.slice(4, -1).split(',').map((x) => { vals.push(decodeURIComponent(x)); return `$${vals.length}`; });
      where.push(`${k}::text in (${ph.join(', ')})`);
    } else throw new Error(`unsupported filter ${k}=${v}`);
  }
  return { where: where.length ? where.join(' and ') : 'true', vals, order, limit };
}

function strip(rows) {
  return rows.map((r) => { const { search, ...rest } = r; void search; return rest; });
}

// Routes for installFetch: [needle, handler(url, options, body)].
export function filmDbRoutes(db, vault = new Map()) {
  return [
    ['/rest/v1/rpc/pg1_film_charge', async (u, o, body) => json((await db.query('select * from public.pg1_film_charge($1, $2)', [body.p_project, body.p_amount])).rows)],
    ['/rest/v1/pg1_errors', (u, o) => (o.method === 'POST' || o.method === 'PATCH' ? new Response('', { status: 201 }) : json([]))],
    ['/rest/v1/', async (u, o, body) => {
      const table = new URL(u).pathname.split('/rest/v1/')[1];
      if (!TABLES.has(table)) throw new Error(`unexpected table ${table}`);
      const method = o.method || 'GET';
      if (method === 'POST') {
        const rows = Array.isArray(body) ? body : [body];
        const out = [];
        for (const row of rows) {
          const keys = Object.keys(row);
          const r = await db.query(`insert into public.${table} (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning *`, keys.map((k) => val(row[k])));
          out.push(...r.rows);
        }
        return json(strip(out), 201);
      }
      const { where, vals, order, limit } = filters(u);
      if (method === 'PATCH') {
        const sets = Object.entries(body).map(([k, v]) => { vals.push(val(v)); return `${k} = $${vals.length}`; });
        return json(strip((await db.query(`update public.${table} set ${sets.join(', ')} where ${where} returning *`, vals)).rows));
      }
      return json(strip((await db.query(`select * from public.${table} where ${where}${order}${limit}`, vals)).rows));
    }],
    ['/storage/v1/object/sign/pg1-vault/', (u) => json({ signedURL: `/object/sign/pg1-vault/${u.split('/pg1-vault/')[1]}?token=signed` })],
    ['/storage/v1/object/pg1-vault/', async (u, o) => {
      const path = u.split('/storage/v1/object/pg1-vault/')[1];
      if (o.method === 'POST') { vault.set(path, Buffer.from(o.body)); return json({ Key: path }); }
      return vault.has(path) ? new Response(vault.get(path), { status: 200 }) : new Response('not found', { status: 404 });
    }]
  ];
}

// A fetch that serves `routes` (first needle that matches wins) and
// records every call.
export function routedFetch(routes, calls = []) {
  const f = async (url, options = {}) => {
    const u = String(url);
    let body = null;
    if (typeof options.body === 'string') { try { body = JSON.parse(options.body); } catch (e) { body = options.body; } } else if (options.body) body = options.body;
    calls.push({ url: u, method: options.method || 'GET', body, headers: options.headers || {} });
    for (const [needle, handler] of routes) if (u.includes(needle)) return handler(u, options, body);
    throw new Error('Unexpected network call in test: ' + u);
  };
  f.calls = calls;
  return f;
}
