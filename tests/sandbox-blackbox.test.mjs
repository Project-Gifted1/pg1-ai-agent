/**
 * The black box's volume and retention (lib/sandbox/blackbox.mjs and the
 * table in supabase/migrations/20261110120000_pg1_sandbox.sql):
 *   - agents' and subjects' records are never held back (the long chain);
 *   - inhabitants: notable events only, plus one summary per in-world day
 *     (the short chain); never every routine decision;
 *   - one simulated day of the universe writes at most 2,000 records;
 *   - budgets per world and in all, past which notable events are
 *     summarised daily;
 *   - details of at most 2,048 bytes;
 *   - retention: 30 days short, 180 days long, pruned with a checkpoint so
 *     the chain still verifies; the operator's purge writes an audit row;
 *   - the daily actions quota that bounds agent records.
 *
 * Run with: node --test tests/sandbox-blackbox.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxStore, __resetSandboxMemory } from '../lib/sandbox/store.mjs';
import { createWorld, stepWorldFor, addEntity, readBlackbox, deleteWorldFor, purgeWorldBlackbox, inviteAgent, resolveSandboxKey, pg1Principal, KEY_ACTIONS_PER_DAY, SandboxError } from '../lib/sandbox/worlds.mjs';
import { fitDetail, pgJsonSize, pruneBlackbox, BLACKBOX_BUDGETS, BLACKBOX_DETAIL_MAX, NOTABLE } from '../lib/sandbox/blackbox.mjs';
import { makeDb, pgRest } from './helpers/pgrest.mjs';

const SUP = 'https://sandbox.test';
const MIG = '20261110120000_pg1_sandbox.sql';
const ROUTINE = ['decide', 'talk', 'meal', 'shower', 'travel', 'leisure', 'friends', 'moved_in', 'grew_up', 'career', 'bought', 'retired', 'released'];
beforeEach(() => __resetSandboxMemory());

async function runDays(store, worldId, steps) {
  for (let left = steps; left > 0; left -= 100) await stepWorldFor(store, pg1Principal(), { world_id: worldId, steps: Math.min(100, left) });
}
const allRows = async (store, id) => (await readBlackbox(store, pg1Principal(), { world_id: id, limit: 2000 })).records;

test('one simulated day of the universe writes at most 2,000 black-box records: notable events and one daily summary, never routine decisions', async () => {
  const store = createSandboxStore();
  const w = await createWorld(store, pg1Principal(), { name: 'Pg1-Universe', template: 'universe' });
  await runDays(store, w.id, 240 + 1); // one full day, and into the next so its summary is written
  const rows = await allRows(store, w.id);
  assert.ok(rows.length <= 2000, `${rows.length} records for one day`);
  assert.ok(!rows.some((r) => ROUTINE.includes(r.action)), 'no routine decision is a record of its own');
  const short = rows.filter((r) => r.chain === 'short');
  assert.ok(short.every((r) => NOTABLE.has(r.action) || r.action === 'daily_summary'));
  const summary = rows.find((r) => r.action === 'daily_summary');
  assert.ok(summary, 'the day ended with its summary');
  assert.equal(summary.detail.day, 0);
  assert.ok(summary.detail.routine_actions > 100 && summary.detail.counts.meal > 0, 'the routine is counted');
  const agent = rows.filter((r) => r.chain === 'long');
  assert.equal(agent.filter((r) => r.action === 'step_world').length, 3, 'every agent call is recorded');
  assert.equal((await readBlackbox(store, pg1Principal(), { world_id: w.id })).chain.ok, true);
  console.log(`# one in-world day: ${rows.length} records (${agent.length} agent, ${short.length} inhabitants and world)`);
});

test('past a budget, notable events are summarised daily; agent records are never held back', async () => {
  const base = createSandboxStore();
  const full = { ...base, blackboxCounts: async () => ({ world: BLACKBOX_BUDGETS.world, global: 10 }) };
  for (const k of Object.keys(base)) if (typeof base[k] === 'function' && !full[k]) full[k] = base[k].bind(base);
  const w = await createWorld(full, pg1Principal(), { name: 'Full', template: 'universe' });
  await runDays(full, w.id, 241);
  const rows = await allRows(full, w.id);
  assert.ok(!rows.some((r) => r.actor_type === 'inhabitant'), 'no inhabitant record one by one');
  const summary = rows.find((r) => r.action === 'daily_summary');
  assert.ok(summary.detail.notable_summarised && Object.values(summary.detail.notable_summarised).some((n) => n > 0), 'counted in the summary instead');
  assert.equal(rows.filter((r) => r.action === 'step_world').length, 3);
  // The global budget too.
  const allFull = { ...full, blackboxCounts: async () => ({ world: 0, global: BLACKBOX_BUDGETS.global }) };
  const w2 = await createWorld(allFull, pg1Principal(), { name: 'Full 2', template: 'universe' });
  await runDays(allFull, w2.id, 100);
  assert.ok(!(await allRows(allFull, w2.id)).some((r) => r.actor_type === 'inhabitant'));
});

test('a detail is at most 2,048 bytes as the table measures it', async () => {
  const big = fitDetail({ summary: 'é'.repeat(5000), more: 'x'.repeat(3000) });
  assert.ok(pgJsonSize(big) <= BLACKBOX_DETAIL_MAX);
  assert.equal(big.truncated, true);
  const d = await makeDb([MIG]);
  const sz = (v) => d.query('select octet_length($1::jsonb::text) as n', [JSON.stringify(v)]).then((r) => r.rows[0].n);
  for (const v of [big, { a: 1, b: [1, 2, { c: 'd' }] }, { s: 'ünïcødé "quoted"\n' }]) assert.equal(await sz(v), pgJsonSize(v));
  const row = (detail) => d.query("insert into pg1_world_blackbox(world_id, chain, seq, actor, actor_type, action, detail, prev_hash, hash) values (gen_random_uuid(), 'long', 1, 'pg1', 'agent', 'x', $1::jsonb, repeat('0', 64), repeat('1', 64))", [JSON.stringify(detail)]);
  await row(big);
  await assert.rejects(row({ summary: 'x'.repeat(3000) }), /check/i);
  // The chain must match the actor: an inhabitant never goes in the long chain.
  await assert.rejects(d.query("insert into pg1_world_blackbox(world_id, chain, seq, actor, actor_type, action, prev_hash, hash) values (gen_random_uuid(), 'long', 1, 'p', 'inhabitant', 'x', repeat('0', 64), repeat('1', 64))"), /check/i);
});

test('retention: inhabitants\' records go after 30 days, agents\' after 180; pruning leaves a checkpoint and the chain still verifies; a gap without one is caught', async () => {
  const d = await makeDb([MIG]);
  const store = createSandboxStore({ supUrl: SUP, supKey: 'k', fetchImpl: pgRest(d, { base: SUP }) });
  const realNow = Date.now; const now = realNow();
  const at = (daysAgo) => { Date.now = () => now - daysAgo * 86400000; };
  let w;
  try {
    at(181); w = await createWorld(store, pg1Principal(), { name: 'Old', template: 'town' }); await runDays(store, w.id, 100);
    at(31); await runDays(store, w.id, 100);
  } finally { Date.now = realNow; }
  await runDays(store, w.id, 100);
  const count = async (chain, days) => Number((await d.query(`select count(*) as n from pg1_world_blackbox where world_id = $1 and chain = $2 and at < now() - interval '${days} days'`, [w.id, chain])).rows[0].n);
  const old = { short: await count('short', 30), long181: await count('long', 180), long31: await count('long', 30) };
  assert.ok(old.short > 0 && old.long181 > 0 && old.long31 > old.long181, JSON.stringify(old));
  // The table: a 31-day-old agent record cannot go; a recent inhabitant record cannot either.
  const oldestLong31 = Number((await d.query("select min(seq) as s from pg1_world_blackbox where world_id = $1 and chain = 'long' and at > now() - interval '180 days'", [w.id])).rows[0].s);
  await assert.rejects(d.query("delete from pg1_world_blackbox where world_id = $1 and chain = 'long' and seq = $2", [w.id, oldestLong31]), /append-only/);
  await assert.rejects(d.query("delete from pg1_world_blackbox where world_id = $1 and chain = 'short' and at > now() - interval '1 day'", [w.id]), /append-only/);
  // Pruning: short records past 30 days and long ones past 180, each with a checkpoint.
  const done = await pruneBlackbox(store, { now });
  assert.deepEqual(done.map((x) => [x.chain, x.removed]).sort(), [['long', old.long181], ['short', old.short]].sort());
  assert.equal(await count('long', 30), old.long31 - old.long181, 'agent records younger than 180 days stay');
  const after = await readBlackbox(store, pg1Principal(), { world_id: w.id, limit: 2000 });
  assert.equal(after.chain.ok, true, JSON.stringify(after.chain));
  for (const c of ['long', 'short']) assert.ok(after.records.some((r) => r.action === 'checkpoint' && r.chain === c));
  // Removing old records without a checkpoint is caught.
  const first = Number((await d.query("select min(seq) as s from pg1_world_blackbox where world_id = $1 and chain = 'short'", [w.id])).rows[0].s);
  await d.query('alter table pg1_world_blackbox disable trigger pg1_world_blackbox_append_only');
  await d.query("delete from pg1_world_blackbox where world_id = $1 and chain = 'short' and seq = $2", [w.id, first]);
  await d.query('alter table pg1_world_blackbox enable trigger pg1_world_blackbox_append_only');
  const cut = await readBlackbox(store, pg1Principal(), { world_id: w.id, limit: 2000 });
  assert.equal(cut.chain.ok, false);
  assert.equal(cut.chain.in, 'short');
  assert.match(cut.chain.reason, /missing/);
});

test('the operator\'s purge: an audit row (who, why, how many), a checkpoint, the chain still verifies; it keeps the newest record and needs a reason', async () => {
  const d = await makeDb([MIG]);
  const store = createSandboxStore({ supUrl: SUP, supKey: 'k', fetchImpl: pgRest(d, { base: SUP }) });
  const w = await createWorld(store, pg1Principal(), { name: 'Purged', template: 'town' });
  await runDays(store, w.id, 200);
  await assert.rejects(purgeWorldBlackbox(store, { world_id: w.id, chain: 'long', through_seq: 1, who: 'operator', why: '' }), SandboxError);
  await assert.rejects(purgeWorldBlackbox(store, { world_id: w.id, chain: 'long', through_seq: 99, who: 'operator', why: 'x' }), SandboxError);
  const out = await purgeWorldBlackbox(store, { world_id: w.id, chain: 'long', through_seq: 2, who: 'operator', why: 'test data' });
  assert.equal(out.removed, 2);
  const audit = (await d.query('select who, why, removed, chain, through_seq from pg1_blackbox_purges where world_id = $1', [w.id])).rows;
  assert.deepEqual(audit.map((a) => [a.who, a.why, Number(a.removed), a.chain, Number(a.through_seq)]), [['operator', 'test data', 2, 'long', 2]]);
  const bb = await readBlackbox(store, pg1Principal(), { world_id: w.id, limit: 2000 });
  assert.equal(bb.chain.ok, true, JSON.stringify(bb.chain));
  assert.ok(bb.records.some((r) => r.action === 'checkpoint' && r.detail.reason === 'operator purge' && r.detail.why === 'test data'));
  // Directly in the database, without the function, young records still cannot go.
  await assert.rejects(d.query("delete from pg1_world_blackbox where world_id = $1 and chain = 'long'", [w.id]), /append-only/);
});

test('the daily actions quota bounds agent records: an invited key makes at most 300 changes a day', async () => {
  const store = createSandboxStore();
  const inv = await inviteAgent(store, { label: 'Busy agent' });
  const who = await resolveSandboxKey(store, inv.key);
  assert.equal(who.quota.max_actions_per_day, KEY_ACTIONS_PER_DAY);
  const w = await createWorld(store, who, { name: 'Busy', spec: { seed: 1, size: { x: 50, y: 50, z: 5 }, entities: [], rules: [] } });
  for (let i = 1; i < KEY_ACTIONS_PER_DAY; i++) await store.addAction(who.owner);
  await assert.rejects(addEntity(store, who, { world_id: w.id, entity: { id: 'a', kind: 'rock', position: { x: 1, y: 1, z: 0 } } }), (e) => e.code === 'quota_actions');
  // Deleting is never refused, and its record is kept with the day's summary.
  const out = await deleteWorldFor(store, who, { world_id: w.id });
  assert.equal(out.deleted, true);
});
