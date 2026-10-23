// The sandbox's operations, shared by the agent endpoint (/api/sandbox/mcp),
// the operator's viewer (/api/sandbox) and PG1's world missions:
//
//   resolveSandboxKey(store, key)   an invited agent's access: the key must
//                                   exist, be live and carry the "sandbox"
//                                   scope. Anything else is refused.
//   createWorld / addEntity / setRule / stepWorldFor / observeWorld /
//   listWorldsFor / deleteWorldFor  each checks ownership and the quotas
//                                   (worlds per owner, steps a day, storage)
//
// Worlds are simulations: every view of one says so (label).

import { validateSpec, initialState, stepWorld, withEntity, withRule, cleanEntity, specBytes, SANDBOX_LIMITS, WorldError } from './engine.mjs';
import { rulesInWords, SIMULATION_LABEL, BLIND_LABEL } from './describe.mjs';
import { hashKey, newSandboxKey, keyOwner, PG1_OWNER } from './store.mjs';

export const SANDBOX_SCOPE = 'sandbox';
// PG1's own quotas (an invited key's come from its row).
export const PG1_QUOTA = Object.freeze({ max_worlds: SANDBOX_LIMITS.worldsPerOwner, max_steps_per_day: 5000, max_storage_kb: 5120 });

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
  return { owner: keyOwner(row.id), key: row, quota: { max_worlds: Math.min(SANDBOX_LIMITS.worldsPerOwner, row.max_worlds), max_steps_per_day: row.max_steps_per_day, max_storage_kb: row.max_storage_kb } };
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

async function owned(store, who, worldId, { write = true } = {}) {
  if (typeof worldId !== 'string' || !/^[0-9a-f-]{36}$/i.test(worldId)) refuse('invalid_world_id', 'world_id must be a world id from list_worlds.');
  const w = await store.getWorld(worldId);
  if (!w) refuse('world_not_found', 'No such world.', 404);
  const mine = w.owner === who.owner;
  if (!mine && (write || w.visibility !== 'invited')) refuse('world_not_found', 'No such world.', 404);
  return w;
}

export async function createWorld(store, who, { name, spec, visibility = 'private', blind = false } = {}) {
  const n = String(name || '').trim().slice(0, 80);
  if (!n) refuse('invalid_name', 'Give the world a name (1 to 80 characters).');
  if (!['private', 'invited'].includes(visibility)) refuse('invalid_visibility', 'visibility is private or invited.');
  let clean;
  try { clean = validateSpec(spec || {}); } catch (e) { throw asWorldError(e); }
  // A blind run's own copy of a place does not count against the quota.
  const isBlindCopy = who.owner === PG1_OWNER && !!blind;
  const count = isBlindCopy ? 0 : (await store.listWorlds({ owner: who.owner })).filter((w) => !w.blind).length;
  if (count >= who.quota.max_worlds) refuse('quota_worlds', `This owner already has ${count} worlds (the limit is ${who.quota.max_worlds}). Delete one first.`, 429);
  const state = initialState(clean);
  if (await storageKb(store, who.owner, specBytes(clean) + specBytes(state)) > who.quota.max_storage_kb) refuse('quota_storage', `This world would take this owner past its storage quota of ${who.quota.max_storage_kb} KB.`, 429);
  const w = await store.createWorld({ owner: who.owner, name: n, spec: clean, state, tick: 0, visibility, blind: isBlindCopy });
  return worldView(w);
}

export async function addEntity(store, who, { world_id, entity } = {}) {
  const w = await owned(store, who, world_id);
  let spec; let ent;
  try { spec = withEntity(w.spec, entity); ent = cleanEntity(entity, spec.size); } catch (e) { throw asWorldError(e); }
  const st = w.state || initialState(w.spec);
  if (!st.entities.some((e) => e.id === ent.id) && st.entities.length >= SANDBOX_LIMITS.entities) refuse('limit_exceeded', `A world can have at most ${SANDBOX_LIMITS.entities} entities.`);
  const state = { ...st, entities: st.entities.filter((e) => e.id !== ent.id).concat(ent).sort((a, b) => (a.id < b.id ? -1 : 1)) };
  if (await storageKb(store, who.owner, specBytes(spec) + specBytes(state), w.id) > who.quota.max_storage_kb) refuse('quota_storage', `This would take the owner past its storage quota of ${who.quota.max_storage_kb} KB.`, 429);
  return worldView(await store.updateWorld(w.id, { spec, state }));
}

export async function setRule(store, who, { world_id, rule } = {}) {
  const w = await owned(store, who, world_id);
  let spec;
  try { spec = withRule(w.spec, rule); } catch (e) { throw asWorldError(e); }
  return worldView(await store.updateWorld(w.id, { spec }));
}

export async function stepWorldFor(store, who, { world_id, steps = 1 } = {}) {
  const w = await owned(store, who, world_id);
  const n = Math.trunc(Number(steps));
  if (!Number.isFinite(n) || n < 1 || n > SANDBOX_LIMITS.stepsPerCall) refuse('limit_exceeded', `steps must be between 1 and ${SANDBOX_LIMITS.stepsPerCall} a call.`);
  const used = await store.stepsToday(who.owner);
  if (used + n > who.quota.max_steps_per_day) refuse('quota_steps', `This owner has used ${used} of its ${who.quota.max_steps_per_day} steps today; ${Math.max(0, who.quota.max_steps_per_day - used)} are left. The count resets at 00:00 UTC.`, 429);
  let out;
  try { out = stepWorld(w.spec, w.state, n); } catch (e) { throw asWorldError(e); }
  await store.addSteps(who.owner, n);
  const updated = await store.updateWorld(w.id, { state: out.state, tick: out.state.tick });
  await store.addEvents(w.id, out.events.slice(-200));
  return { ...worldView(updated), steps: n, events: out.events.slice(-50) };
}

export async function observeWorld(store, who, { world_id, events = 20 } = {}) {
  const w = await owned(store, who, world_id, { write: false });
  const recent = await store.listEvents(w.id, { limit: Math.max(0, Math.min(100, Number(events) || 20)) });
  return { ...worldView(w), entities: (w.state || initialState(w.spec)).entities, recent_events: recent };
}

export async function listWorldsFor(store, who) {
  const rows = await store.listWorlds({ owner: who.owner, includeInvited: true });
  const used = await store.stepsToday(who.owner);
  return { worlds: rows.map((w) => ({ id: w.id, name: w.name, owner_is_you: w.owner === who.owner, visibility: w.visibility, tick: w.tick, entities: ((w.state && w.state.entities) || []).length, rules: ((w.spec && w.spec.rules) || []).length, label: labelOf(w) })), quota: { worlds: rows.filter((w) => w.owner === who.owner && !w.blind).length, max_worlds: who.quota.max_worlds, steps_today: used, max_steps_per_day: who.quota.max_steps_per_day, max_storage_kb: who.quota.max_storage_kb }, label: SIMULATION_LABEL };
}

export async function deleteWorldFor(store, who, { world_id } = {}) {
  const w = await owned(store, who, world_id);
  await store.deleteWorld(w.id);
  return { deleted: true, world_id: w.id };
}

export function worldView(w) {
  if (!w) return null;
  return { id: w.id, name: w.name, owner: w.owner, visibility: w.visibility, tick: w.tick, size: w.spec && w.spec.size, seed: w.spec && w.spec.seed, entity_count: ((w.state && w.state.entities) || []).length, rules: rulesInWords(w.spec), label: labelOf(w), simulation: true };
}
