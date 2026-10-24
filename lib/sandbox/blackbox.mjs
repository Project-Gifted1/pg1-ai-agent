// THE BLACK BOX: a record of every action taken in a world, by whom.
//
//   agents        PG1, invited agents and blind subjects: every tool call
//                 that changes a world (create, add, update, rule, step,
//                 delete) and every in-world action a subject takes
//   inhabitants   what the people of a world decide and do: where they go
//                 and why, what they say, friendships, partnerships,
//                 births, careers, crimes, arrests, deaths
//   the world     what the society does as a whole: money, elections,
//                 technology, building, colonies, contact
//
// Append-only and tamper-evident: each record carries the hash of the one
// before it in the same world (a hash chain, SHA-256), so a changed or
// missing record shows as a broken link (verifyChain). The table refuses
// updates, and deletes of records younger than the retention period
// (supabase/migrations/20261110120000_pg1_sandbox.sql). Records outlive the
// world they belong to: deleting a world leaves its black box.
//
// Recording never breaks an action: a failure is logged and the action
// goes on.

import crypto from 'node:crypto';

export const BLACKBOX_RETENTION_DAYS = 180;
export const MAX_RECORDS_PER_CALL = 5000;
export const ACTOR_TYPES = Object.freeze(['agent', 'subject', 'inhabitant', 'world']);
// Society-wide events, recorded with the world as the actor.
const WORLD_EVENTS = new Set(['currency', 'election', 'technology', 'construction', 'built', 'colony', 'first_contact', 'sighting', 'limit', 'show', 'expedition', 'discovery', 'dispute', 'treaty', 'alliance', 'standoff', 'war_declared', 'battle', 'armistice', 'army_response', 'invention', 'accident']);
const LIVING = new Set(['person', 'child', 'astronaut', 'alien']);
const GENESIS = '0'.repeat(64);

const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
};
export function recordHash(prevHash, r) {
  return crypto.createHash('sha256').update(`${prevHash}|${canonical({ world_id: r.world_id, seq: r.seq, actor: r.actor, actor_type: r.actor_type, action: r.action, detail: r.detail, tick: r.tick, at: r.at })}`, 'utf8').digest('hex');
}

// rows: [{ actor, actor_type, action, detail?, tick? }] -> the chained records written.
export async function record(store, worldId, rows, { now = () => Date.now(), log = console.warn } = {}) {
  if (!store || typeof store.addBlackbox !== 'function' || !rows || !rows.length) return [];
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const head = await store.blackboxHead(worldId);
      let seq = head ? Number(head.seq) : 0;
      let prev = head ? head.hash : GENESIS;
      const at = new Date(now()).toISOString();
      const out = rows.slice(0, MAX_RECORDS_PER_CALL).map((r) => {
        const rec = {
          world_id: worldId, seq: ++seq,
          actor: String(r.actor || 'unknown').slice(0, 80),
          actor_type: ACTOR_TYPES.includes(r.actor_type) ? r.actor_type : 'agent',
          action: String(r.action || 'action').slice(0, 40),
          detail: r.detail && typeof r.detail === 'object' ? JSON.parse(JSON.stringify(r.detail)) : {},
          tick: Number.isFinite(Number(r.tick)) ? Math.trunc(Number(r.tick)) : null,
          at, prev_hash: prev
        };
        rec.hash = recordHash(prev, rec);
        prev = rec.hash;
        return rec;
      });
      try { await store.addBlackbox(out); return out; } catch (e) {
        // Another writer took the same sequence numbers: read the head again once.
        if (attempt === 0 && (e.status === 409 || e.conflict)) continue;
        throw e;
      }
    }
  } catch (e) {
    try { log(`[blackbox] could not record ${rows.length} action(s) for world ${String(worldId).slice(0, 8)}: ${e && e.message}`); } catch (x) { /* never breaks */ }
  }
  return [];
}

// An agent's tool call.
export function agentAction(who, action, detail = {}, tick = null) {
  return { actor: who && who.owner ? who.owner : 'unknown', actor_type: 'agent', action, detail, tick };
}

// A step's events -> records: inhabitants' actions and the world's.
// Vehicles' own comings and goings are not agents' actions and are left
// out (a rider's trip shows as the rider's decision).
export function fromEvents(events, entitiesById) {
  const out = [];
  for (const ev of events || []) {
    if (WORLD_EVENTS.has(ev.kind) || (!ev.ref && ['hypothesis', 'proof', 'message_to_observer'].includes(ev.kind))) { out.push({ actor: 'world', actor_type: 'world', action: ev.kind, detail: { summary: ev.summary, ref: ev.ref || null }, tick: ev.tick }); continue; }
    const e = ev.ref ? entitiesById.get(ev.ref) : null;
    const kind = e ? e.kind : (ev.ref ? String(ev.ref).replace(/-\d.*$/, '') : '');
    if (ev.ref && (LIVING.has(kind) || ['decide', 'talk', 'friends', 'partners', 'moved_in', 'birth', 'grew_up', 'death', 'career', 'crime', 'arrest', 'released', 'shower', 'meal', 'bought', 'retired', 'travel', 'leisure', 'hypothesis', 'proof', 'message_to_observer'].includes(ev.kind))) {
      out.push({ actor: ev.ref, actor_type: 'inhabitant', action: ev.kind, detail: { summary: ev.summary, ...(e && e.properties && e.properties.name ? { name: e.properties.name } : {}) }, tick: ev.tick });
    }
  }
  return out;
}

// rows in ascending seq order (a contiguous run): { ok, checked, broken_at? }.
export function verifyChain(rows) {
  const list = (rows || []).slice().sort((a, b) => Number(a.seq) - Number(b.seq));
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const prev = i === 0 ? r.prev_hash : list[i - 1].hash;
    if (i > 0 && Number(r.seq) !== Number(list[i - 1].seq) + 1) return { ok: false, checked: i, broken_at: Number(r.seq), reason: 'a record is missing' };
    if (r.prev_hash !== prev) return { ok: false, checked: i, broken_at: Number(r.seq), reason: 'a link does not match the record before it' };
    if (recordHash(r.prev_hash, r) !== r.hash) return { ok: false, checked: i, broken_at: Number(r.seq), reason: 'a record was changed' };
  }
  return { ok: true, checked: list.length };
}
