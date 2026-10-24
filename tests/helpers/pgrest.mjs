// A small PostgREST stand-in over a real Postgres (PGlite), for the tables
// the PG1 upgrade adds. Handles what lib/* sends: select=, column filters
// (eq, neq, in, gt, gte, lt, lte, is, and or=(...) of those; col->>field
// eq/neq on a jsonb column), order= (with
// nullsfirst/nullslast), limit=, POST (object or
// array, Prefer: return=representation|minimal), PATCH and DELETE with the
// same filters, and rpc/<fn> with named arguments. jsonb columns are sent
// as JSON text; array columns as arrays. Anything else throws, so a test
// sees an unexpected call.

import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

export async function makeDb(migrations = []) {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  for (const m of migrations) {
    const sql = readFileSync(new URL(`../../supabase/migrations/${m}`, import.meta.url), 'utf8');
    await db.exec(sql);
  }
  return db;
}

const json = (v, status = 200) => new Response(v === null ? '' : JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

async function columnTypes(db, table) {
  const { rows } = await db.query(`select column_name, data_type, udt_name from information_schema.columns where table_schema = 'public' and table_name = $1`, [table]);
  return new Map(rows.map((r) => [r.column_name, r.data_type === 'ARRAY' ? 'array' : r.udt_name]));
}

function parseFilters(params, types, vals) {
  const where = [];
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
    // or=(col.op.value,col.op."quoted value"): each part is one filter.
    if (k === 'or') {
      const parts = String(v).replace(/^\(|\)$/g, '').match(/[a-z_]+\.[a-z]+\.(?:"[^"]*"|[^,]*)/g) || [];
      const sub = parts.map((p) => { const i = p.indexOf('.'); return parseFilters([[p.slice(0, i), p.slice(i + 1).replace(/^([a-z]+)\."(.*)"$/s, '$1.$2')]], types, vals)[0]; });
      if (sub.length) where.push(`(${sub.join(' or ')})`);
      continue;
    }
    // A jsonb field as text: result->>ai_summary=eq.pending.
    const jf = /^([a-z_]+)->>([a-z_]+)$/.exec(k);
    if (jf && types.get(jf[1]) === 'jsonb') {
      const m = /^(eq|neq)\.(.*)$/s.exec(v);
      if (!m) throw new Error(`unsupported filter ${k}=${v}`);
      vals.push(m[2]);
      where.push(`(${jf[1]}->>'${jf[2]}') ${m[1] === 'eq' ? '=' : '<>'} $${vals.length}`);
      continue;
    }
    if (!/^[a-z_]+$/.test(k) || !types.has(k)) throw new Error(`unsupported filter column ${k}`);
    const m = /^(eq|neq|in|gt|gte|lt|lte|is)\.(.*)$/s.exec(v);
    if (!m) throw new Error(`unsupported filter ${k}=${v}`);
    const [, op, raw] = m;
    if (op === 'is') { where.push(`${k} is ${raw === 'null' ? 'null' : raw === 'true' ? 'true' : 'false'}`); continue; }
    if (op === 'in') {
      const list = raw.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, ''));
      const ph = list.map((x) => { vals.push(x); return `$${vals.length}`; });
      where.push(`${k}::text in (${ph.join(', ')})`);
      continue;
    }
    vals.push(raw);
    const sqlOp = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
    const cast = ['timestamptz', 'int4', 'int8', 'numeric', 'bool'].includes(types.get(k)) ? `::${types.get(k)}` : '';
    where.push(cast ? `${k} ${sqlOp} $${vals.length}${cast}` : `${k}::text ${sqlOp} $${vals.length}`);
  }
  return where;
}

export function pgRest(db, { calls = [], base = 'https://supabase.test', passthrough = null } = {}) {
  return async (url, options = {}) => {
    const u = new URL(String(url));
    const method = options.method || 'GET';
    calls.push({ url: String(url), method, body: options.body });
    if (!String(url).startsWith(`${base}/rest/v1/`)) {
      if (passthrough) { const r = await passthrough(String(url), options); if (r) return r; }
      throw new Error('Unexpected network call in test: ' + url);
    }
    const path = u.pathname.replace(/^\/rest\/v1\//, '');
    const headers = options.headers || {};
    const prefer = String(headers.Prefer || headers.prefer || '');
    const body = typeof options.body === 'string' && options.body ? JSON.parse(options.body) : null;
    try {
      if (path.startsWith('rpc/')) {
        const fn = path.slice(4);
        if (!/^[a-z_0-9]+$/.test(fn)) throw new Error('bad rpc');
        const keys = Object.keys(body || {});
        const r = await db.query(`select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`, keys.map((k) => (body[k] !== null && typeof body[k] === 'object' && !Array.isArray(body[k]) ? JSON.stringify(body[k]) : body[k])));
        return json(r.rows);
      }
      if (!/^[a-z_0-9]+$/.test(path)) throw new Error(`unsupported path ${path}`);
      const types = await columnTypes(db, path);
      if (!types.size) return json({ code: '42P01', message: `relation "public.${path}" does not exist` }, 404);
      const vals = [];
      // Columns, plus PostgREST's json path form alias:column->key.
      const select = (u.searchParams.get('select') || '*').split(',').map((c) => c.trim()).map((c) => {
        const m = /^([a-z_][a-z0-9_]*):([a-z_][a-z0-9_]*)->([a-z_][a-z0-9_]*)$/.exec(c);
        if (m) return types.get(m[2]) === 'jsonb' ? `${m[2]} -> '${m[3]}' as ${m[1]}` : null;
        return c === '*' || types.has(c) ? c : null;
      }).filter(Boolean).join(', ') || '*';
      const where = parseFilters(u.searchParams, types, vals);
      const w = where.length ? ` where ${where.join(' and ')}` : '';
      const enc = (k, v) => (v === null || v === undefined ? null : types.get(k) === 'jsonb' ? JSON.stringify(v) : v);
      const ret = prefer.includes('return=representation') || method === 'GET';
      if (method === 'POST') {
        const rows = Array.isArray(body) ? body : [body];
        // Like PostgREST: every object in a bulk insert has the same keys
        // (unless ?columns= names them), else 400 PGRST102. Production,
        // 20 Oct: the relay message rows were refused like this.
        if (rows.length > 1 && !u.searchParams.get('columns')) {
          const first = Object.keys(rows[0] || {}).sort().join(',');
          if (rows.some((r) => Object.keys(r || {}).sort().join(',') !== first)) return json({ code: 'PGRST102', details: null, hint: null, message: 'All object keys must match' }, 400);
        }
        const out = [];
        for (const row of rows) {
          const keys = Object.keys(row).filter((k) => types.has(k));
          const conflict = u.searchParams.get('on_conflict');
          const cc = conflict ? conflict.split(',') : [];
          const upsert = cc.length && /resolution=merge-duplicates/.test(prefer) && cc.every((c) => types.has(c))
            ? ` on conflict (${cc.join(', ')}) do update set ${keys.filter((k) => !cc.includes(k)).map((k) => `${k} = excluded.${k}`).join(', ') || `${cc[0]} = excluded.${cc[0]}`}`
            : '';
          const r = await db.query(`insert into public.${path} (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})${upsert} returning ${select}`, keys.map((k) => enc(k, row[k])));
          out.push(...r.rows);
        }
        return ret ? json(out, 201) : new Response(null, { status: 201 });
      }
      if (method === 'PATCH') {
        const sets = Object.entries(body).filter(([k]) => types.has(k)).map(([k, v]) => { vals.push(enc(k, v)); return `${k} = $${vals.length}`; });
        const r = await db.query(`update public.${path} set ${sets.join(', ')}${w} returning ${select}`, vals);
        return ret ? json(r.rows) : new Response(null, { status: 204 });
      }
      if (method === 'DELETE') {
        const r = await db.query(`delete from public.${path}${w} returning ${select}`, vals);
        return ret ? json(r.rows) : new Response(null, { status: 204 });
      }
      let order = '';
      const o = u.searchParams.get('order');
      if (o) order = ' order by ' + o.split(',').map((p) => { const [c, d, n] = p.split('.'); if (!types.has(c)) throw new Error('bad order'); return `${c} ${d === 'desc' ? 'desc' : 'asc'}${n === 'nullsfirst' ? ' nulls first' : n === 'nullslast' ? ' nulls last' : ''}`; }).join(', ');
      const limit = u.searchParams.get('limit') ? ` limit ${Number(u.searchParams.get('limit'))}` : '';
      const r = await db.query(`select ${select} from public.${path}${w}${order}${limit}`, vals);
      return json(r.rows);
    } catch (e) {
      return json({ code: e.code || 'XX000', message: e.message }, 400);
    }
  };
}
