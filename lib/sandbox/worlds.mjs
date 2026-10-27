// The sandbox's operations, shared by the agent endpoint (/api/sandbox/mcp),
// the operator's viewer (/api/sandbox) and PG1's world missions:
//
//   resolveSandboxKey(store, key)   an invited agent's access: the key must
//                                   exist, be live and carry the "sandbox"
//                                   scope. Anything else is refused.
//   createWorld / addEntity / setRule / stepWorldFor / observeWorld /
//   listWorldsFor / deleteWorldFor  each checks ownership and the quotas
//                                   (worlds per owner, steps a day, storage)
//   readBlackbox                    the world's black box (lib/sandbox/blackbox.mjs):
//                                   every change above is recorded there, with who made it
//   purgeWorldBlackbox              operator only: remove a chain's oldest records,
//                                   with an audit row and a checkpoint
//
// Write calls also count against a daily actions quota (PG1 600, an
// invited key 300): with steps a day, it bounds how many agent records a
// day can add to the black box.
//
// Worlds are simulations: every view of one says so (label).

import { validateSpec, initialState, stepWorld, withEntity, withRule, cleanEntity, cleanProperties, specBytes, spaceAltitude, SANDBOX_LIMITS, WorldError } from './engine.mjs';
import { templateSpec, TEMPLATE_NAMES } from './templates.mjs';
import { record as recordBlackbox, agentAction, fromEvents, foldNotable, rollDays, summaryRow, withinBudget, verifyChain, anchorsFrom, CHAINS } from './blackbox.mjs';
import { rulesInWords, SIMULATION_LABEL, BLIND_LABEL } from './describe.mjs';
import { hashKey, newSandboxKey, keyOwner, PG1_OWNER } from './store.mjs';

export const SANDBOX_SCOPE = 'sandbox';
// PG1's own quotas (an invited key's come from its row).
export const PG1_QUOTA = Object.freeze({ max_worlds: SANDBOX_LIMITS.worldsPerOwner, max_steps_per_day: 5000, max_storage_kb: 5120, max_actions_per_day: 600 });
export const KEY_ACTIONS_PER_DAY = 300;

export class SandboxError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'SandboxError'; this.code = code; this.status = status; }
}
const refuse = (code, message, status) => { throw new SandboxError(code, message, status); };

// --- access ---------------------------------------------------------------------------------

export function keyFromRequest(req) {
  const h = (req && req.headers) || {};
  const get = (n) => (typeof h.get === 'function' ? h.get(n) : h[n]) || '';
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(String(get('authorization')));
  return String(get('x-pg1-sandbox-key') || (bearer ? bearer[1] : '')).trim();
}

// { owner, key, quota } or a SandboxError (401/403).
export async function resolveSandboxKey(store, rawKey) {
  const key = String(rawKey || '').trim();
  if (!key) refuse('sandbox_key_required', 'This endpoint needs a PG1 sandbox key (Authorization: Bearer <key>). Sandbox access is by invitation only.', 401);
  if (key.length > 200) refuse('sandbox_key_invalid', 'The sandbox key is not valid.', 401);
  const row = await store.findKeyByHash(hashKey(key));
  if (!row) refuse('sandbox_scope_required', 'This key does not have the sandbox scope. Sandbox access is by invitation only.', 403);
  if (row.revoked_at) refuse('sandbox_key_revoked', 'This sandbox key was revoked.', 403);
  if (!Array.isArray(row.scopes) || !row.scopes.includes(SANDBOX_SCOPE)) refuse('sandbox_scope_required', 'This key does not have the sandbox scope. Sandbox access is by invitation only.', 403);
  return { owner: keyOwner(row.id), key: row, quota: { max_worlds: Math.min(SANDBOX_LIMITS.worldsPerOwner, row.max_worlds), max_steps_per_day: row.max_steps_per_day, max_storage_kb: row.max_storage_kb, max_actions_per_day: KEY_ACTIONS_PER_DAY } };
}

export const pg1Principal = () => ({ owner: PG1_OWNER, key: null, quota: PG1_QUOTA });

// An invite for an agent Gift names: the key is shown once, only its hash kept.
export async function inviteAgent(store, { label, maxWorlds = 3, maxStepsPerDay = 1000, maxStorageKb = 1024, scopes = [SANDBOX_SCOPE] } = {}) {
  const name = String(label || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name)) refuse('invalid_label', 'Name the agent with 1 to 64 letters, digits, spaces, dots, _ or -.');
  const key = newSandboxKey();
  const row = await store.insertKey({ key_hash: hashKey(key), label: name, scopes, max_worlds: Math.min(SANDBOX_LIMITS.worldsPerOwner, Math.max(1, maxWorlds)), max_steps_per_day: maxStepsPerDay, max_storage_kb: maxStorageKb });
  return { key, id: row.id, label: row.label };
}

// --- worlds -------------------------------------------------------------------------------------

const asWorldError = (e) => (e instanceof WorldError ? new SandboxError(e.code === 'limit' ? 'limit_exceeded' : 'invalid_world', e.message, 400) : e);
const labelOf = (w) => (w && w.blind ? BLIND_LABEL : SIMULATION_LABEL);

async function storageKb(store, owner, extraBytes = 0, exceptId = null) {
  const worlds = await store.listWorlds({ owner });
  const bytes = worlds.filter((w) => w.id !== exceptId).reduce((t, w) => t + specBytes(w.spec || {}) + (w.state ? specBytes(w.state) : 0), 0) + extraBytes;
  return bytes / 1024;
}

// One write call against the owner's daily actions quota.
async function countAction(store, who) {
  if (typeof store.actionsToday !== 'function') return;
  const max = (who.quota && who.quota.max_actions_per_day) || KEY_ACTIONS_PER_DAY;
  const used = await store.actionsToday(who.owner);
  if (used >= max) refuse('quota_actions', `This owner has made ${used} of its ${max} changes today; the count resets at 00:00 UTC.`, 429);
  await store.addAction(who.owner);
}

async function owned(store, who, worldId, { write = true } = {}) {
  if (typeof worldId !== 'string' || !/^[0-9a-f-]{36}$/i.test(worldId)) refuse('invalid_world_id', 'world_id must be a world id from list_worlds.');
  const w = await store.getWorld(worldId);
  if (!w) refuse('world_not_found', 'No such world.', 404);
  const mine = w.owner === who.owner;
  if (!mine && (write || w.visibility !== 'invited')) refuse('world_not_found', 'No such world.', 404);
  return w;
}

export async function createWorld(store, who, { name, spec, template, visibility = 'private', blind = false } = {}) {
  const n = String(name || '').trim().slice(0, 80);
  if (!n) refuse('invalid_name', 'Give the world a name (1 to 80 characters).');
  if (!['private', 'invited'].includes(visibility)) refuse('invalid_visibility', 'visibility is private or invited.');
  if (template !== undefined && template !== null && !TEMPLATE_NAMES.includes(template)) refuse('invalid_template', `template is one of ${TEMPLATE_NAMES.join(', ')}.`);
  let clean;
  try { clean = validateSpec(template ? templateSpec(template) : (spec || {})); } catch (e) { throw asWorldError(e); }
  // A blind run's own copy of a place does not count against the quota.
  const isBlindCopy = who.owner === PG1_OWNER && !!blind;
  const count = isBlindCopy ? 0 : (await store.listWorlds({ owner: who.owner })).filter((w) => !w.blind).length;
  await countAction(store, who);
  if (count >= who.quota.max_worlds) refuse('quota_worlds', `This owner already has ${count} worlds (the limit is ${who.quota.max_worlds}). Delete one first.`, 429);
  const state = initialState(clean);
  if (await storageKb(store, who.owner, specBytes(clean) + specBytes(state)) > who.quota.max_storage_kb) refuse('quota_storage', `This world would take this owner past its storage quota of ${who.quota.max_storage_kb} KB.`, 429);
  const w = await store.createWorld({ owner: who.owner, name: n, spec: clean, state, tick: 0, visibility, blind: isBlindCopy });
  await recordBlackbox(store, w.id, [agentAction(who, 'create_world', { name: n, template: template || null, entities: clean.entities.length, rules: clean.rules.length, blind: isBlindCopy }, 0)]);
  return worldView(w);
}

export async function addEntity(store, who, { world_id, entity } = {}) {
  const w = await owned(store, who, world_id);
  await countAction(store, who);
  let spec; let ent;
  try { spec = withEntity(w.spec, entity); ent = cleanEntity(entity, spec.size); } catch (e) { throw asWorldError(e); }
  const st = w.state || initialState(w.spec);
  if (!st.entities.some((e) => e.id === ent.id) && st.entities.length >= SANDBOX_LIMITS.entities) refuse('limit_exceeded', `A world can have at most ${SANDBOX_LIMITS.entities} entities.`);
  const state = { ...st, entities: st.entities.filter((e) => e.id !== ent.id).concat(ent).sort((a, b) => (a.id < b.id ? -1 : 1)) };
  if (await storageKb(store, who.owner, specBytes(spec) + specBytes(state), w.id) > who.quota.max_storage_kb) refuse('quota_storage', `This would take the owner past its storage quota of ${who.quota.max_storage_kb} KB.`, 429);
  const out = worldView(await store.updateWorld(w.id, { spec, state }));
  await recordBlackbox(store, w.id, [agentAction(who, 'add_entity', { id: ent.id, kind: ent.kind, position: ent.position }, st.tick)]);
  return out;
}

// Changes a live entity's properties (the world's current state, not its
// starting spec): set some, clear others. This is how an agent drives:
// target (where to go), inside (get in a vehicle; "" to get out).
export async function updateEntity(store, who, { world_id, entity_id, set, clear } = {}) {
  const w = await owned(store, who, world_id);
  await countAction(store, who);
  const st = w.state || initialState(w.spec);
  const ent = st.entities.find((e) => e.id === entity_id);
  if (!ent) refuse('entity_not_found', 'No entity with that id in this world.', 404);
  let props;
  try {
    const add = cleanProperties(set || {}, 'set');
    props = { ...ent.properties, ...add };
    for (const k of Array.isArray(clear) ? clear.slice(0, 20) : []) delete props[k];
    cleanProperties(props, 'properties');
  } catch (e) { throw asWorldError(e); }
  if (typeof props.inside === 'string' && props.inside) {
    if (!props.inside || props.inside === ent.id || !st.entities.some((e) => e.id === props.inside)) refuse('invalid_world', 'inside must name another entity in this world.');
  }
  if (props.inside === '') delete props.inside;
  const next = { ...ent, properties: props };
  // Getting in: the rider joins its vehicle at once.
  if (props.inside) next.position = { ...st.entities.find((e) => e.id === props.inside).position };
  const state = { ...st, entities: st.entities.map((e) => (e.id === ent.id ? next : e)) };
  const view = worldView(await store.updateWorld(w.id, { state }));
  await recordBlackbox(store, w.id, [agentAction(who, 'update_entity', { id: ent.id, set: set || {}, clear: Array.isArray(clear) ? clear.slice(0, 20) : [] }, st.tick)]);
  return { ...view, entity: next };
}

export async function setRule(store, who, { world_id, rule } = {}) {
  const w = await owned(store, who, world_id);
  await countAction(store, who);
  let spec;
  try { spec = withRule(w.spec, rule); } catch (e) { throw asWorldError(e); }
  const view = worldView(await store.updateWorld(w.id, { spec }));
  await recordBlackbox(store, w.id, [agentAction(who, 'set_rule', { id: rule && rule.id, type: rule && rule.type }, w.tick)]);
  return view;
}

export async function stepWorldFor(store, who, { world_id, steps = 1 } = {}) {
  const w = await owned(store, who, world_id);
  const n = Math.trunc(Number(steps));
  if (!Number.isFinite(n) || n < 1 || n > SANDBOX_LIMITS.stepsPerCall) refuse('limit_exceeded', `steps must be between 1 and ${SANDBOX_LIMITS.stepsPerCall} a call.`);
  const used = await store.stepsToday(who.owner);
  if (used + n > who.quota.max_steps_per_day) refuse('quota_steps', `This owner has used ${used} of its ${who.quota.max_steps_per_day} steps today; ${Math.max(0, who.quota.max_steps_per_day - used)} are left. The count resets at 00:00 UTC.`, 429);
  await countAction(store, who);
  let out;
  try { out = stepWorld(w.spec, w.state, n); } catch (e) { throw asWorldError(e); }
  await store.addSteps(who.owner, n);
  // The black box: notable events one by one (while the budgets allow),
  // routine ones counted into one summary per in-world day.
  const daySteps = w.spec.day_steps || 240;
  const byId = new Map(out.state.entities.map((e) => [e.id, e]));
  const { notable, routine } = fromEvents(out.events, byId, { daySteps });
  const roomy = notable.length ? await withinBudget(store, w.id) : true;
  const rolled = rollDays(w.state && w.state.blackbox_day, routine, roomy ? {} : foldNotable(notable, daySteps), { daySteps, currentDay: Math.floor(out.state.tick / daySteps) });
  const state = rolled.pending ? { ...out.state, blackbox_day: rolled.pending } : out.state;
  const updated = await store.updateWorld(w.id, { state, tick: out.state.tick });
  await store.addEvents(w.id, out.events.slice(-200));
  await recordBlackbox(store, w.id, [agentAction(who, 'step_world', { steps: n, from: w.tick, to: out.state.tick }, out.state.tick), ...(roomy ? notable : []), ...rolled.rows].sort((a, b) => (Number(a.tick) || 0) - (Number(b.tick) || 0)));
  return { ...worldView(updated), steps: n, events: out.events.slice(-50) };
}

export async function observeWorld(store, who, { world_id, events = 20 } = {}) {
  const w = await owned(store, who, world_id, { write: false });
  const recent = await store.listEvents(w.id, { limit: Math.max(0, Math.min(100, Number(events) || 20)) });
  const st = w.state || initialState(w.spec);
  // roads: the world's road network, as data (lib/sandbox/roads.mjs), for the viewer.
  return { ...worldView(w), entities: st.entities, society: st.society || null, awareness: st.awareness || null, diplomacy: st.diplomacy || null, relationships: st.relations ? Object.keys(st.relations).length : 0, recent_events: recent, roads: (w.spec && w.spec.roads) || null };
}

export async function listWorldsFor(store, who) {
  const rows = await store.listWorlds({ owner: who.owner, includeInvited: true });
  const used = await store.stepsToday(who.owner);
  return { worlds: rows.map((w) => ({ id: w.id, name: w.name, owner_is_you: w.owner === who.owner, visibility: w.visibility, tick: w.tick, entities: ((w.state && w.state.entities) || []).length, rules: ((w.spec && w.spec.rules) || []).length, label: labelOf(w) })), quota: { worlds: rows.filter((w) => w.owner === who.owner && !w.blind).length, max_worlds: who.quota.max_worlds, steps_today: used, max_steps_per_day: who.quota.max_steps_per_day, max_storage_kb: who.quota.max_storage_kb }, label: SIMULATION_LABEL };
}

export async function deleteWorldFor(store, who, { world_id } = {}) {
  const w = await owned(store, who, world_id);
  // The day in progress is summarised before the world goes.
  const pending = w.state && w.state.blackbox_day;
  await recordBlackbox(store, w.id, [agentAction(who, 'delete_world', { name: w.name }, w.tick), ...(pending ? [summaryRow(pending, (w.spec && w.spec.day_steps) || 240)] : [])]);
  await store.deleteWorld(w.id);
  return { deleted: true, world_id: w.id, black_box: 'kept' };
}

// A world's black box: its records newest first (optionally one actor's or
// one chain's), whether each chain is intact, and who acted. Owner, or
// anyone who may observe the world. before: a record id (paging).
export async function readBlackbox(store, who, { world_id, actor = null, chain = null, limit = 200, before = null } = {}) {
  const w = await owned(store, who, world_id, { write: false });
  const n = Math.max(1, Math.min(2000, Number(limit) || 200));
  const ch = CHAINS.includes(chain) ? chain : null;
  const rows = await store.listBlackbox(w.id, { actor: actor ? String(actor).slice(0, 80) : null, chain: ch, limit: n, beforeId: before == null ? null : Number(before) });
  const purges = typeof store.listPurges === 'function' ? await store.listPurges(w.id) : [];
  const checks = {};
  for (const c of CHAINS) checks[c] = await checkChain(store, w.id, c, n, purges);
  const bad = CHAINS.map((c) => checks[c]).find((x) => !x.ok);
  return { world_id: w.id, records: rows, chain: { ok: !bad, ...(bad ? { broken_at: bad.broken_at, reason: bad.reason, in: bad.in } : {}), long: checks.long, short: checks.short }, actors: typeof store.blackboxActors === 'function' ? await store.blackboxActors(w.id) : [], label: labelOf(w), simulation: true };
}

// The newest records of one chain link up, and its oldest remaining record
// starts the chain or links to a checkpoint (or a purge audit).
async function checkChain(store, worldId, chain, n, purges) {
  const recent = await store.listBlackbox(worldId, { chain, limit: n });
  if (!recent.length) return { ok: true, checked: 0, in: chain };
  const anchors = [...anchorsFrom(typeof store.listCheckpoints === 'function' ? await store.listCheckpoints(worldId, chain) : []), ...purges.filter((p) => p.chain === chain).map((p) => ({ through_seq: Number(p.through_seq), anchor_hash: p.anchor_hash }))];
  const oldest = typeof store.blackboxOldest === 'function' ? await store.blackboxOldest(worldId, chain) : null;
  const hasOldest = oldest && recent.some((r) => Number(r.seq) === Number(oldest.seq));
  let v = verifyChain(recent, { anchors, startsAtOldest: !!hasOldest });
  if (v.ok && oldest && !hasOldest) { const o = verifyChain([oldest], { anchors, startsAtOldest: true }); if (!o.ok) v = o; }
  return { ...v, in: chain };
}

// Operator only: remove a chain's records up to through_seq (its oldest
// ones). The database writes an audit row (who, why, how many); a
// checkpoint record keeps the hash of the last record removed, so the
// rest of the chain still verifies.
export async function purgeWorldBlackbox(store, { world_id, chain, through_seq, who, why } = {}) {
  if (!CHAINS.includes(chain)) refuse('invalid_chain', 'chain is long or short.');
  const by = String(who || '').trim().slice(0, 80); const reason = String(why || '').trim().slice(0, 500);
  if (!by || !reason) refuse('invalid_purge', 'Say who is purging and why.');
  const seq = Math.trunc(Number(through_seq));
  if (!Number.isFinite(seq) || seq < 1) refuse('invalid_purge', 'through_seq must be a record number in that chain.');
  const head = await store.blackboxHead(world_id, chain);
  if (!head || seq >= Number(head.seq)) refuse('invalid_purge', 'A purge keeps at least the newest record of the chain.');
  const audit = await store.purgeBlackbox({ world_id, chain, through_seq: seq, who: by, why: reason });
  if (!audit) refuse('invalid_purge', 'No record with that number in that chain.', 404);
  await recordBlackbox(store, world_id, [{ chain, actor: by, actor_type: 'system', action: 'checkpoint', detail: { reason: 'operator purge', who: by, why: reason, removed: Number(audit.removed), through_seq: seq, anchor_hash: audit.anchor_hash } }]);
  return { world_id, chain, removed: Number(audit.removed), through_seq: seq };
}

export function worldView(w) {
  if (!w) return null;
  return { id: w.id, name: w.name, owner: w.owner, visibility: w.visibility, tick: w.tick, size: w.spec && w.spec.size, seed: w.spec && w.spec.seed, space_altitude: w.spec ? spaceAltitude(w.spec) : null, day_steps: (w.spec && w.spec.day_steps) || 240, entity_count: ((w.state && w.state.entities) || []).length, rules: rulesInWords(w.spec), label: labelOf(w), simulation: true };
}
