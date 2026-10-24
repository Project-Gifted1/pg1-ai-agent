// THE BLACK BOX: a record of every action taken in a world, by whom.
//
// Two chains per world, each with its own retention:
//
//   long  (180 days)  agents and blind subjects: every tool call that
//                     changes a world (create, add, update, rule, step,
//                     delete) and every in-world action a subject takes.
//                     Never limited: this is what the black box is for.
//   short (30 days)   the inhabitants and the world: only notable events
//                     (births, deaths, partnerships, crimes, elections,
//                     wars, treaties, discoveries, contact, buildings
//                     finished...) and one summary per in-world day with
//                     the counts of everything routine (meals, showers,
//                     trips, talk...). Never every routine decision.
//
// Volume is bounded: a world may keep BLACKBOX_BUDGETS.world short-chain
// records and the whole database BLACKBOX_BUDGETS.global; past either,
// notable events are folded into the daily summary instead of written one
// by one. Agent and subject records are never held back. A record's detail
// is at most 2,048 bytes (the table checks it too).
//
// Append-only and tamper-evident: each record carries the hash of the one
// before it in the same chain (SHA-256), so a changed or missing record
// shows as a broken link (verifyChain). The table refuses updates, and
// deletes of records younger than their chain's retention, except through
// the operator's purge function, which writes an audit row. Retention
// pruning and purges remove the oldest records of a chain (a prefix) and
// leave a checkpoint record with the hash of the last one removed, so the
// rest still verifies. Records outlive the world they belong to.
//
// Recording never breaks an action: a failure is logged and the action
// goes on.

import crypto from 'node:crypto';

export const BLACKBOX_RETENTION_DAYS = Object.freeze({ long: 180, short: 30 });
export const BLACKBOX_BUDGETS = Object.freeze({ world: 20000, global: 100000 });
export const BLACKBOX_DETAIL_MAX = 2048;
export const MAX_RECORDS_PER_CALL = 2000;
export const ACTOR_TYPES = Object.freeze(['agent', 'subject', 'inhabitant', 'world', 'system']);
export const CHAINS = Object.freeze(['long', 'short']);
export const chainOf = (actorType) => (actorType === 'agent' || actorType === 'subject' ? 'long' : 'short');
// What is worth a record of its own; everything else is counted daily.
export const NOTABLE = Object.freeze(new Set([
  'birth', 'death', 'partners', 'crime', 'arrest',
  'election', 'currency', 'technology', 'invention', 'built', 'colony',
  'dispute', 'standoff', 'treaty', 'alliance', 'war_declared', 'battle', 'armistice', 'army_response',
  'first_contact', 'sighting', 'expedition', 'discovery', 'accident',
  'hypothesis', 'proof', 'message_to_observer', 'limit'
]));
const WORLD_EVENTS = new Set(['currency', 'election', 'technology', 'invention', 'construction', 'built', 'colony', 'first_contact', 'sighting', 'limit', 'show', 'expedition', 'discovery', 'dispute', 'treaty', 'alliance', 'standoff', 'war_declared', 'battle', 'armistice', 'army_response', 'accident']);
const INHABITANT_ACTIONS = new Set(['decide', 'talk', 'friends', 'partners', 'moved_in', 'birth', 'grew_up', 'death', 'career', 'crime', 'arrest', 'released', 'shower', 'meal', 'bought', 'retired', 'travel', 'leisure', 'hypothesis', 'proof', 'message_to_observer']);
const LIVING = new Set(['person', 'child', 'astronaut', 'alien']);
const GENESIS = '0'.repeat(64);

const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
};
export function recordHash(prevHash, r) {
  return crypto.createHash('sha256').update(`${prevHash}|${canonical({ world_id: r.world_id, chain: r.chain, seq: r.seq, actor: r.actor, actor_type: r.actor_type, action: r.action, detail: r.detail, tick: r.tick, at: r.at })}`, 'utf8').digest('hex');
}

// The size Postgres gives a jsonb value as text (octet_length(detail::text)):
// JSON with ", " and ": " between items.
export function pgJsonSize(v) {
  const t = (x) => {
    if (Array.isArray(x)) return 2 + x.reduce((a, y) => a + t(y), 0) + Math.max(0, x.length - 1) * 2;
    if (x && typeof x === 'object') { const ks = Object.keys(x).filter((k) => x[k] !== undefined); return 2 + ks.reduce((a, k) => a + Buffer.byteLength(JSON.stringify(k), 'utf8') + 2 + t(x[k]), 0) + Math.max(0, ks.length - 1) * 2; }
    return Buffer.byteLength(JSON.stringify(x === undefined ? null : x), 'utf8');
  };
  return t(v);
}

// At most BLACKBOX_DETAIL_MAX bytes as the table measures it: a longer
// detail keeps a cut summary.
export function fitDetail(detail) {
  const d = detail && typeof detail === 'object' ? JSON.parse(JSON.stringify(detail)) : {};
  if (pgJsonSize(d) <= BLACKBOX_DETAIL_MAX) return d;
  const text = typeof d.summary === 'string' ? d.summary : JSON.stringify(d);
  const out = { truncated: true, summary: '' };
  let n = Math.min(text.length, BLACKBOX_DETAIL_MAX - 64);
  do { out.summary = text.slice(0, n); n = Math.floor(n * 0.9); } while (pgJsonSize(out) > BLACKBOX_DETAIL_MAX);
  return out;
}

// rows: [{ actor, actor_type, action, detail?, tick?, chain? }] -> the chained records written.
export async function record(store, worldId, rows, { now = () => Date.now(), log = console.warn } = {}) {
  if (!store || typeof store.addBlackbox !== 'function' || !rows || !rows.length) return [];
  const written = [];
  for (const chain of CHAINS) {
    const mine = rows.filter((r) => (r.chain || chainOf(r.actor_type)) === chain);
    if (!mine.length) continue;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const head = await store.blackboxHead(worldId, chain);
        let seq = head ? Number(head.seq) : 0;
        let prev = head ? head.hash : GENESIS;
        const at = new Date(now()).toISOString();
        const out = mine.slice(0, MAX_RECORDS_PER_CALL).map((r) => {
          const rec = {
            world_id: worldId, chain, seq: ++seq,
            actor: String(r.actor || 'unknown').slice(0, 80),
            actor_type: ACTOR_TYPES.includes(r.actor_type) ? r.actor_type : 'agent',
            action: String(r.action || 'action').slice(0, 40),
            detail: fitDetail(r.detail),
            tick: r.tick !== null && r.tick !== undefined && Number.isFinite(Number(r.tick)) ? Math.trunc(Number(r.tick)) : null,
            at, prev_hash: prev
          };
          rec.hash = recordHash(prev, rec);
          prev = rec.hash;
          return rec;
        });
        try { await store.addBlackbox(out); written.push(...out); break; } catch (e) {
          // Another writer took the same sequence numbers: read the head again once.
          if (attempt === 0 && (e.status === 409 || e.conflict)) continue;
          throw e;
        }
      }
    } catch (e) {
      try { log(`[blackbox] could not record ${mine.length} action(s) for world ${String(worldId).slice(0, 8)}: ${e && e.message}`); } catch (x) { /* never breaks */ }
    }
  }
  return written;
}

// An agent's tool call.
export function agentAction(who, action, detail = {}, tick = null) {
  return { actor: who && who.owner ? who.owner : 'unknown', actor_type: 'agent', action, detail, tick };
}

// A step's events, split: notable ones as records (inhabitants' and the
// world's), and routine ones as counts per in-world day. Vehicles' own
// comings and goings are not anyone's decisions and are left out.
export function fromEvents(events, entitiesById, { daySteps = 240 } = {}) {
  const notable = [];
  const routine = {}; // day -> { action: n }
  for (const ev of events || []) {
    const isWorld = WORLD_EVENTS.has(ev.kind) || (!ev.ref && ['hypothesis', 'proof', 'message_to_observer'].includes(ev.kind));
    const e = ev.ref ? entitiesById.get(ev.ref) : null;
    const kind = e ? e.kind : (ev.ref ? String(ev.ref).replace(/-\d.*$/, '') : '');
    const isInhabitant = !isWorld && ev.ref && (LIVING.has(kind) || INHABITANT_ACTIONS.has(ev.kind));
    if (!isWorld && !isInhabitant) continue;
    if (NOTABLE.has(ev.kind)) {
      notable.push(isWorld
        ? { actor: 'world', actor_type: 'world', action: ev.kind, detail: { summary: ev.summary, ref: ev.ref || null }, tick: ev.tick }
        : { actor: ev.ref, actor_type: 'inhabitant', action: ev.kind, detail: { summary: ev.summary, ...(e && e.properties && e.properties.name ? { name: e.properties.name } : {}) }, tick: ev.tick });
    } else {
      const day = Math.floor((Number(ev.tick) || 0) / daySteps);
      const c = routine[day] || (routine[day] = {});
      c[ev.kind] = (c[ev.kind] || 0) + 1;
    }
  }
  return { notable, routine };
}

// Notable records folded into counts per day (when a budget is reached).
export function foldNotable(rows, daySteps = 240) {
  const out = {};
  for (const r of rows) { const day = Math.floor((Number(r.tick) || 0) / daySteps); const c = out[day] || (out[day] = {}); c[r.action] = (c[r.action] || 0) + 1; }
  return out;
}

// The daily summary, carried in the world's state between calls as
// pending = { day, counts: { action: n }, summarised: { action: n } }.
// Returns the summary records for the days that ended, and the new pending.
export function rollDays(pending, routine, folded, { daySteps = 240, currentDay = null } = {}) {
  const rows = [];
  let p = pending && typeof pending.day === 'number' ? { day: pending.day, counts: { ...pending.counts }, summarised: { ...(pending.summarised || {}) } } : null;
  const days = [...new Set([...Object.keys(routine || {}), ...Object.keys(folded || {})].map(Number))].sort((a, b) => a - b);
  for (const day of days) {
    if (!p) p = { day, counts: {}, summarised: {} };
    if (day > p.day) { rows.push(summaryRow(p, daySteps)); p = { day, counts: {}, summarised: {} }; }
    for (const [k, n] of Object.entries((routine || {})[day] || {})) p.counts[k] = (p.counts[k] || 0) + n;
    for (const [k, n] of Object.entries((folded || {})[day] || {})) p.summarised[k] = (p.summarised[k] || 0) + n;
  }
  if (p && currentDay !== null && currentDay > p.day) { rows.push(summaryRow(p, daySteps)); p = null; }
  return { rows, pending: p };
}
export function summaryRow(p, daySteps = 240) {
  const total = Object.values(p.counts).reduce((a, b) => a + b, 0);
  return { actor: 'world', actor_type: 'world', action: 'daily_summary', detail: { day: p.day, routine_actions: total, counts: p.counts, ...(Object.keys(p.summarised || {}).length ? { notable_summarised: p.summarised } : {}) }, tick: (p.day + 1) * daySteps - 1 };
}

// Whether the short chain may take more records one by one.
export async function withinBudget(store, worldId, budgets = BLACKBOX_BUDGETS) {
  if (!store || typeof store.blackboxCounts !== 'function') return true;
  try {
    const c = await store.blackboxCounts(worldId);
    return Number(c.world) < budgets.world && Number(c.global) < budgets.global;
  } catch (e) { return false; } // unknown: summarise (fail closed on volume)
}

// One chain's rows, any order. anchors: [{ through_seq, anchor_hash }] from
// checkpoints and purge audits. startsAtOldest: the rows include the
// chain's oldest remaining record, which must then start the chain or
// link to a checkpoint's hash.
export function verifyChain(rows, { anchors = [], startsAtOldest = false } = {}) {
  const list = (rows || []).slice().sort((a, b) => Number(a.seq) - Number(b.seq));
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (i > 0 && Number(r.seq) !== Number(list[i - 1].seq) + 1) return { ok: false, checked: i, broken_at: Number(r.seq), reason: 'a record is missing' };
    if (i > 0 && r.prev_hash !== list[i - 1].hash) return { ok: false, checked: i, broken_at: Number(r.seq), reason: 'a link does not match the record before it' };
    if (recordHash(r.prev_hash, r) !== r.hash) return { ok: false, checked: i, broken_at: Number(r.seq), reason: 'a record was changed' };
  }
  if (startsAtOldest && list.length) {
    const first = list[0];
    if (Number(first.seq) === 1) { if (first.prev_hash !== GENESIS) return { ok: false, checked: 0, broken_at: 1, reason: 'the first record does not start the chain' }; }
    else if (!anchors.some((a) => Number(a.through_seq) === Number(first.seq) - 1 && a.anchor_hash === first.prev_hash)) {
      return { ok: false, checked: 0, broken_at: Number(first.seq), reason: 'older records are missing with no checkpoint for them' };
    }
  }
  return { ok: true, checked: list.length };
}

export function anchorsFrom(rows) {
  return (rows || []).filter((r) => r.action === 'checkpoint' && r.detail && r.detail.through_seq != null).map((r) => ({ through_seq: Number(r.detail.through_seq), anchor_hash: r.detail.anchor_hash }));
}

// Retention: remove each chain's records past its retention, oldest first,
// leaving a checkpoint with the hash of the last one removed. Never throws.
export async function pruneBlackbox(store, { now = Date.now(), log = console.warn } = {}) {
  const done = [];
  if (!store || typeof store.blackboxPrunePlan !== 'function') return done;
  for (const chain of CHAINS) {
    try {
      // An hour's margin, so the table's own check (its clock) agrees.
      const cutoff = new Date(now - BLACKBOX_RETENTION_DAYS[chain] * 86400000 - 3600000).toISOString();
      for (const p of await store.blackboxPrunePlan(chain, cutoff)) {
        await store.deleteBlackboxThrough(p.world_id, chain, Number(p.through_seq));
        await record(store, p.world_id, [{ chain, actor: 'pg1', actor_type: 'system', action: 'checkpoint', detail: { reason: `retention (${BLACKBOX_RETENTION_DAYS[chain]} days)`, removed: Number(p.removed), through_seq: Number(p.through_seq), anchor_hash: p.anchor_hash } }], { now: () => now, log });
        done.push({ world_id: p.world_id, chain, removed: Number(p.removed) });
      }
    } catch (e) { try { log(`[blackbox] pruning the ${chain} chain failed: ${e && e.message}`); } catch (x) { /* never breaks */ } }
  }
  return done;
}
