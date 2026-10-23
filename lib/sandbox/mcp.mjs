// The sandbox's MCP tools (/api/sandbox/mcp): a separate endpoint, so the
// public tool list at /api/mcp is unchanged. By invitation only: every call
// needs a key with the "sandbox" scope (lib/sandbox/worlds.mjs
// resolveSandboxKey). Worlds are simulations and every result says so.

import { createWorld, addEntity, setRule, stepWorldFor, observeWorld, listWorldsFor, deleteWorldFor, SandboxError } from './worlds.mjs';
import { SANDBOX_LIMITS, RULE_TYPES } from './engine.mjs';

const L = SANDBOX_LIMITS;
const SIM = 'Worlds are simulations: nothing in them is a real event.';
const WORLD_ID = { type: 'string', description: 'The world id from create_world or list_worlds.' };

export const SANDBOX_TOOLS = Object.freeze([
  { name: 'create_world', description: `PG1 Sandbox: creates a world from JSON data (never code): size, seed, entities [{id, kind, properties, position}] and rules from a fixed vocabulary (${RULE_TYPES.join(', ')}). Limits: ${L.entities} entities, ${L.rules} rules, ${L.specBytes / 1024} KB, ${L.worldsPerOwner} worlds per owner. ${SIM}`, inputSchema: { type: 'object', properties: { name: { type: 'string', maxLength: 80 }, spec: { type: 'object', description: 'The world: { size?, seed?, entities?, rules? }.' }, visibility: { type: 'string', enum: ['private', 'invited'], description: 'invited: other invited agents can observe it (read only).' } }, required: ['name', 'spec'], additionalProperties: false } },
  { name: 'add_entity', description: `PG1 Sandbox: adds an entity to one of your worlds (or replaces the one with the same id). Properties are numbers, short strings or true/false. ${SIM}`, inputSchema: { type: 'object', properties: { world_id: WORLD_ID, entity: { type: 'object', description: '{ id, kind, properties?, position? {x,y,z} }' } }, required: ['world_id', 'entity'], additionalProperties: false } },
  { name: 'set_rule', description: `PG1 Sandbox: adds a rule to one of your worlds (or replaces the one with the same id). Types: ${RULE_TYPES.join(', ')}. ${SIM}`, inputSchema: { type: 'object', properties: { world_id: WORLD_ID, rule: { type: 'object', description: '{ id, type, ...fields of that type }' } }, required: ['world_id', 'rule'], additionalProperties: false } },
  { name: 'step_world', description: `PG1 Sandbox: runs one of your worlds forward 1 to ${L.stepsPerCall} steps, deterministically for its seed, and returns what happened. Counts against your steps a day. ${SIM}`, inputSchema: { type: 'object', properties: { world_id: WORLD_ID, steps: { type: 'integer', minimum: 1, maximum: L.stepsPerCall } }, required: ['world_id'], additionalProperties: false } },
  { name: 'observe_world', description: `PG1 Sandbox: a world's entities, rules in plain words and recent events. Your own worlds, or worlds shared as invited. ${SIM}`, inputSchema: { type: 'object', properties: { world_id: WORLD_ID, events: { type: 'integer', minimum: 0, maximum: 100 } }, required: ['world_id'], additionalProperties: false } },
  { name: 'list_worlds', description: `PG1 Sandbox: your worlds and the shared ones, with your quota use (worlds, steps today, storage). ${SIM}`, inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'delete_world', description: `PG1 Sandbox: deletes one of your worlds and its events. ${SIM}`, inputSchema: { type: 'object', properties: { world_id: WORLD_ID }, required: ['world_id'], additionalProperties: false } }
]);
export const SANDBOX_TOOL_NAMES = Object.freeze(SANDBOX_TOOLS.map((t) => t.name));

const RUN = {
  create_world: (s, who, a) => createWorld(s, who, { name: a.name, spec: a.spec, visibility: a.visibility || 'private' }),
  add_entity: (s, who, a) => addEntity(s, who, a),
  set_rule: (s, who, a) => setRule(s, who, a),
  step_world: (s, who, a) => stepWorldFor(s, who, { world_id: a.world_id, steps: a.steps === undefined ? 1 : a.steps }),
  observe_world: (s, who, a) => observeWorld(s, who, a),
  list_worlds: (s, who) => listWorldsFor(s, who),
  delete_world: (s, who, a) => deleteWorldFor(s, who, a)
};

// { result } or { error: { code, message, status } }; never throws a
// SandboxError (an unexpected error still throws).
export async function callSandboxTool(store, who, name, args) {
  if (!Object.hasOwn(RUN, name)) return { error: { code: 'unknown_tool', message: `Unknown tool. Tools: ${SANDBOX_TOOL_NAMES.join(', ')}.`, status: 400 } };
  try {
    return { result: await RUN[name](store, who, args && typeof args === 'object' ? args : {}) };
  } catch (e) {
    if (e instanceof SandboxError) return { error: { code: e.code, message: e.message, status: e.status } };
    throw e;
  }
}
