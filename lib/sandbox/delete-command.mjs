// /sandbox delete <world-id> [confirm]: the operator deletes one of PG1's
// worlds from the chat (until now only the agent tool delete_world could).
//
//   without confirm   shows the world (name, id, tick, in-world day, created)
//                     and asks for the command again with confirm; nothing
//                     is deleted
//   with confirm      deletes it through deleteWorldFor, as owner pg1, so the
//                     delete_world record is written on the black box long
//                     chain first; the black box records are kept
//
// Refused: another owner's world, a blind run's copy, a world with an
// experiment run still active, and PG1's oldest world (its first universe,
// which is kept). Worlds are simulations, and the replies say so.

import { deleteWorldFor, pg1Principal } from './worlds.mjs';
import { PG1_OWNER } from './store.mjs';

const ID_RE = /^[0-9a-f-]{36}$/i;
export const FIRST_UNIVERSE_KEPT = 'this is your first universe; it is kept';

// PG1's oldest world by created_at (blind copies are not worlds of its own).
export async function oldestPg1World(store) {
  const mine = (await store.listWorlds({ owner: PG1_OWNER })).filter((w) => w.owner === PG1_OWNER && !w.blind);
  return mine.sort((a, b) => (String(a.created_at) < String(b.created_at) ? -1 : String(a.created_at) > String(b.created_at) ? 1 : (a.id < b.id ? -1 : 1)))[0] || null;
}

// An experiment run still going in (or on a copy of) this world.
async function activeRunIn(store, world) {
  if (typeof store.listRuns !== 'function') return null;
  const runs = await store.listRuns({ limit: 200, status: 'running' });
  return runs.find((r) => r.status === 'running' && (r.world_id === world.id || (r.summary && r.summary.source_world_id === world.id))) || null;
}

const dayOf = (w) => Math.floor((Number(w.tick) || 0) / ((w.spec && w.spec.day_steps) || 240)) + 1;
const describeWorld = (w) => `**${w.name}** (Simulation) · \`${w.id}\` · tick ${Number(w.tick) || 0} · in-world day ${dayOf(w)} · created ${String(w.created_at || '').slice(0, 16).replace('T', ' ')} UTC`;

// { status, reply, deleted? } for the chat. rest: "<world-id> [confirm]".
export async function sandboxDeleteCommand(store, rest) {
  const words = String(rest || '').trim().split(/\s+/).filter(Boolean);
  const id = (words[0] || '').toLowerCase();
  const confirm = words.slice(1).some((x) => x.toLowerCase() === 'confirm');
  if (!ID_RE.test(id)) return { status: 200, reply: 'Usage: /sandbox delete <world-id> [confirm] (the full world id, from /sandbox).' };
  const w = await store.getWorld(id);
  if (!w || w.owner !== PG1_OWNER) return { status: 200, reply: 'No PG1 world has that id. Only PG1\'s own worlds can be deleted here.' };
  if (w.blind) return { status: 200, reply: 'That world is a blind run\'s copy (SIMULATION — blind experiment). It is not deleted from here.' };
  const run = await activeRunIn(store, w);
  if (run) return { status: 200, reply: `An experiment run is still active in "${w.name}" (run ${String(run.id).slice(0, 8)}). Stop it first with /sandbox stop ${String(run.id).slice(0, 8)}.` };
  const oldest = await oldestPg1World(store);
  if (oldest && oldest.id === w.id) return { status: 200, reply: `Not deleted: ${FIRST_UNIVERSE_KEPT}. ${describeWorld(w)}` };
  if (!confirm) return { status: 200, reply: `This would delete ${describeWorld(w)}.\nIts black box records are kept. Nothing has been deleted. To delete it, repeat the command with confirm:\n\`/sandbox delete ${w.id} confirm\`` };
  const out = await deleteWorldFor(store, pg1Principal(), { world_id: w.id });
  return { status: 200, deleted: out.deleted === true, reply: `Deleted ${describeWorld(w)}.\nIts black box was kept: the delete_world record is on its long chain, and every earlier record stays readable.` };
}
