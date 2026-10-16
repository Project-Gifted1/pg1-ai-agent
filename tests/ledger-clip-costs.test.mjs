// The ledger correction (supabase/migrations/20261029140000_pg1_ledger_clip_costs.sql)
// and its read-only preview, on a real Postgres (PGlite), plus the Director
// migration's narrowed constraint drop.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const sql = (p) => readFileSync(new URL(`../supabase/${p}`, import.meta.url), 'utf8');
const MIGRATIONS = ['20261011120000_pg1_film.sql', '20261012120000_pg1_ai_usage.sql', '20261013120000_pg1_film_resume.sql', '20261029130000_pg1_director.sql']
  .map((f) => sql(`migrations/${f}`));
const FIX = sql('migrations/20261029140000_pg1_ledger_clip_costs.sql');
const PREVIEW = sql('previews/20261029140000_pg1_ledger_clip_costs_preview.sql');

async function db() {
  const d = new PGlite();
  await d.exec('create role anon; create role authenticated; create role service_role;');
  for (const m of MIGRATIONS) await d.exec(m);
  const p = (await d.query("insert into public.pg1_film_projects (request, cap_usd) values ('test', 20) returning id")).rows[0].id;
  return { d, p };
}

const usage = (d, provider, unit, cost, at, { ok = true } = {}) =>
  d.query('insert into public.pg1_ai_usage (provider, model, task, unit, cost_usd, ok, at) values ($1, $2, $3, $4, $5, $6, $7)', [provider, 'm', 'media', unit, cost, ok, at]);
const clip = (d, p, cost, at) =>
  d.query("insert into public.pg1_film_assets (project_id, kind, cost_usd, created_at, storage_path) values ($1, 'clip', $2, $3, 'x')", [p, cost, at]);

test('preview counts the rows and totals; the fix uses each clip\'s own price and runs twice safely', async () => {
  const { d, p } = await db();
  const t0 = new Date('2026-10-10T10:00:00Z');
  const at = (min) => new Date(t0.getTime() + min * 60000).toISOString();
  await usage(d, 'replicate', 'video_replicate', 1.40, at(0));     // matched: a 10 s clip at 0.60
  await clip(d, p, 0.60, at(4));
  await usage(d, 'replicate', 'video_replicate', 1.40, at(120));   // no clip nearby: 0.30
  await usage(d, 'replicate', 'video_replicate', 1.40, at(200), { ok: false }); // failed: unchanged
  await usage(d, 'replicate', 'video_replicate', 0.30, at(300));   // already right: unchanged
  await usage(d, 'gemini_paid', 'video_gemini', 0.75, at(400));    // 0.50
  await usage(d, 'replicate', 'still_replicate', 0.04, at(500));   // not a clip: unchanged

  const rows = (await d.query(PREVIEW)).rows;
  const by = Object.fromEntries(rows.map((r) => [r.unit || 'total', r]));
  assert.equal(Number(by.video_replicate.rows_changing), 2);
  assert.equal(Number(by.video_replicate.total_before_usd), 2.8);
  assert.equal(Number(by.video_replicate.total_after_usd), 0.9);
  assert.equal(Number(by.video_gemini.rows_changing), 1);
  assert.equal(Number(by.total.rows_changing), 3);
  assert.equal(Number(by.total.total_before_usd), 3.55);
  assert.equal(Number(by.total.total_after_usd), 1.4);

  const before = (await d.query('select count(*)::int n from public.pg1_ai_usage')).rows[0].n;
  await d.exec(FIX);
  await d.exec(FIX);
  const after = (await d.query('select id, unit, ok, cost_usd::float c from public.pg1_ai_usage order by id')).rows;
  assert.equal(after.length, before, 'no row is deleted');
  assert.deepEqual(after.map((r) => r.c), [0.6, 0.3, 1.4, 0.3, 0.5, 0.04]);
  const again = (await d.query(PREVIEW)).rows.find((r) => r.unit === null);
  assert.equal(Number(again.rows_changing), 0, 'nothing left to change');
});

test('Director migration drops only the status/mode/kind checks, keeps the others, and re-runs', async () => {
  const { d, p } = await db();
  await d.exec(MIGRATIONS[3]);
  const checks = (await d.query(`select t.relname tbl, k.conname name from pg_constraint k join pg_class t on t.oid = k.conrelid
    where t.relname in ('pg1_film_projects', 'pg1_film_assets') and k.contype = 'c' order by 1, 2`)).rows;
  const names = checks.map((c) => `${c.tbl}.${c.name}`);
  for (const n of ['pg1_film_projects.pg1_film_mode_ok', 'pg1_film_projects.pg1_film_status_ok', 'pg1_film_assets.pg1_film_asset_kind_ok']) assert.ok(names.includes(n), n);
  // The asset status, tier and money checks are untouched.
  await assert.rejects(d.query("insert into public.pg1_film_assets (project_id, kind, status, storage_path) values ($1, 'clip', 'bogus', 'x')", [p]));
  await assert.rejects(d.query("insert into public.pg1_film_projects (request, cap_usd, tier) values ('x', 1, 'bogus')"));
  await assert.rejects(d.query("insert into public.pg1_film_projects (request, cap_usd) values ('x', -1)"));
  await d.query("insert into public.pg1_film_projects (request, cap_usd, status, mode) values ('x', 1, 'directing', 'director')");
  await d.query("insert into public.pg1_film_assets (project_id, kind, storage_path) values ($1, 'stem', 'x')", [p]);
  // Each dropped constraint is printed (RAISE NOTICE).
  assert.match(MIGRATIONS[3], /raise notice 'pg1_director: dropping check % on %: %'/);
});
