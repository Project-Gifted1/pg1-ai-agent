// A lab "world" for tests: Postgres (PGlite) with the given migrations plus
// the usage ledger and pending_actions, behind the PostgREST stand-in, and
// a fake GitHub Actions API (dispatches, runs, artifacts, check runs).

import zlib from 'node:zlib';
import { makeDb, pgRest } from './pgrest.mjs';

export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  Object.entries(entries).forEach(([name, text], i) => {
    const data = Buffer.from(text);
    const method = i === 0 ? 0 : 8;
    const comp = method ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data);
    const nameB = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameB.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameB.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameB, comp);
    centrals.push(central, nameB);
    offset += 30 + nameB.length + comp.length;
  });
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export async function makeLabWorld(migrations = []) {
  const db = await makeDb(migrations);
  await db.exec(`create table if not exists public.pg1_ai_usage (id bigint generated always as identity primary key, at timestamptz not null default now(), day date not null default current_date, provider text not null, model text, task text, data_class text, input_tokens integer default 0, output_tokens integer default 0, chars integer default 0, unit text, cost_usd numeric not null default 0, cached boolean default false, ok boolean default true, status integer, fallback integer default 0, request_id text);
    create table if not exists public.pending_actions (token text primary key, action_type text, plan jsonb, diff_summary text, status text, created_at timestamptz, expires_at timestamptz, resolved_at timestamptz);`);
  const gh = { dispatches: [], cancels: [], runs: new Map(), artifacts: new Map(), checks: new Map() };
  const github = async (u, options = {}) => {
    const p = new URL(u).pathname.replace('/repos/Project-Gifted1/pg1-ai-agent', '');
    let m;
    if (p === '/actions/workflows/lab.yml/dispatches') { gh.dispatches.push(JSON.parse(options.body)); return new Response(null, { status: 204 }); }
    if (p === '/actions/workflows/lab.yml/runs') return Response.json({ workflow_runs: [...gh.runs.values()] });
    if ((m = /^\/actions\/runs\/(\d+)\/cancel$/.exec(p))) { gh.cancels.push(Number(m[1])); return new Response(null, { status: 202 }); }
    if ((m = /^\/actions\/runs\/(\d+)\/artifacts$/.exec(p))) return Response.json({ artifacts: gh.artifacts.has(Number(m[1])) ? [{ id: Number(m[1]) * 10, name: gh.artifacts.get(Number(m[1])).name, expired: false, created_at: '2026-10-14T00:00:00Z' }] : [] });
    if ((m = /^\/actions\/artifacts\/(\d+)\/zip$/.exec(p))) return new Response(gh.artifacts.get(Number(m[1]) / 10).zip);
    if ((m = /^\/actions\/runs\/(\d+)$/.exec(p))) return Response.json(gh.runs.get(Number(m[1])) || {});
    if ((m = /^\/pulls\/(\d+)$/.exec(p))) return Response.json({ number: Number(m[1]), head: { sha: `sha${m[1]}` } });
    if ((m = /^\/commits\/sha(\d+)\/check-runs$/.exec(p))) return Response.json({ check_runs: gh.checks.get(Number(m[1])) || [] });
    throw new Error('Unexpected GitHub call in test: ' + u);
  };
  // Finishes the newest dispatched experiment with `result`.
  gh.finish = (result, runId = 900 + gh.runs.size) => {
    const id = gh.dispatches[gh.dispatches.length - 1].inputs.experiment_id;
    gh.runs.set(runId, { id: runId, name: `lab ${id}`, status: 'completed', conclusion: 'success' });
    gh.artifacts.set(runId, { name: `lab-result-${id}`, zip: makeZip({ 'result.json': JSON.stringify({ id, status: 'done', spent_usd: 0.1, ...result }) }) });
    return id;
  };
  const fetchImpl = pgRest(db, {
    passthrough: async (u, o) => {
      if (u.startsWith('https://api.github.com/')) return github(u, o);
      if (u.includes('/storage/v1/')) return Response.json([]);
      return null;
    }
  });
  return { db, gh, fetchImpl };
}
