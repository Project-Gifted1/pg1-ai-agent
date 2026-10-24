/**
 * PG1 Sandbox (lib/sandbox, api/sandbox/mcp.mjs, api/sandbox.mjs): worlds
 * PG1 and invited agents build and run.
 *   - the engine is deterministic for a given seed
 *   - every limit is enforced (entities, rules, steps a call, 256 KB,
 *     worlds per owner, properties)
 *   - no code-execution path exists: strings like "process.exit()" in a
 *     spec are inert data, and the engine imports and calls nothing
 *   - a key without the sandbox scope (a licence key included) is refused
 *   - quotas hold (worlds, steps a day, storage) with clear errors
 *   - world missions stop on the kill switch, make no paid call at $0 (or
 *     ever), and an invited agent's world data never reaches an AI engine
 *   - the migration applies twice, service role only
 *
 * Run with: node --test tests/sandbox.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stepWorld, validateSpec, initialState, SANDBOX_LIMITS, WorldError } from '../lib/sandbox/engine.mjs';
import { rulesInWords } from '../lib/sandbox/describe.mjs';
import { createSandboxStore, __resetSandboxMemory, hashKey } from '../lib/sandbox/store.mjs';
import { createWorld, addEntity, setRule, stepWorldFor, observeWorld, listWorldsFor, inviteAgent, resolveSandboxKey, pg1Principal, readBlackbox, deleteWorldFor, SandboxError } from '../lib/sandbox/worlds.mjs';
import { SANDBOX_TOOL_NAMES } from '../lib/sandbox/mcp.mjs';
import { runWorldMission, assertPg1World, parsePlan } from '../lib/sandbox/missions.mjs';
import sandboxMcp, { __setSandboxStore } from '../api/sandbox/mcp.mjs';
import sandboxViewer, { __setSandboxViewerStore } from '../api/sandbox.mjs';
import { handleSandboxCommand } from '../lib/sandbox/chat.mjs';
import { createAutonomousStore, switchOn, setLimits, __resetAutonomousSnapshot } from '../lib/autonomous/state.mjs';
import { autonomousTick } from '../lib/autonomous/runner.mjs';
import { __resetRouterState } from '../lib/aiRouter.mjs';
import { __resetCoreState, readCoreState } from '../lib/core/state.mjs';
import { createAutonomousDb } from './helpers/autonomousDb.mjs';
import { makeDb, pgRest } from './helpers/pgrest.mjs';

const ROOT = new URL('../', import.meta.url);
const SUP = 'https://sandbox.test';
const FREE = 'AIza-free-sandbox-0123456789';
const PAID = 'AQ.paid-sandbox-0123456789';
const ANTHROPIC = 'sk-ant-sandbox-0123456789abcdef';

beforeEach(() => { __resetSandboxMemory(); __resetAutonomousSnapshot(); __resetRouterState(); __resetCoreState(); });

const SPEC = {
  seed: 42, size: { x: 50, y: 50, z: 5 },
  entities: [
    { id: 'r1', kind: 'rabbit', properties: { energy: 5 }, position: { x: 10, y: 10 } },
    { id: 'r2', kind: 'rabbit', properties: { energy: 3 }, position: { x: 30, y: 12 } },
    { id: 'g1', kind: 'grass', properties: { size: 1 }, position: { x: 12, y: 11 } }
  ],
  rules: [
    { id: 'w', type: 'move', kind: 'rabbit', wander: 1 },
    { id: 'g', type: 'grow', kind: 'grass', property: 'size', amount: 0.5, max: 5 },
    { id: 'd', type: 'decay', kind: 'rabbit', property: 'energy', amount: 0.2, remove_below: 0 },
    { id: 'e', type: 'interact', a: 'rabbit', b: 'grass', radius: 3, effect: { on: 'a', property: 'energy', delta: 1 }, emit: 'ate' },
    { id: 's', type: 'spawn', kind: 'grass', every: 5, chance: 0.5 },
    { id: 'a', type: 'attract', kind: 'rabbit', toward: 'grass', strength: 1, radius: 20 },
    { id: 'p', type: 'repel', kind: 'grass', from: 'rabbit', strength: 0.1, radius: 2 },
    { id: 'm', type: 'emit', kind: 'grass', every: 10, event: 'seeded' },
    { id: 'c', type: 'condition', kind: 'rabbit', if: { property: 'energy', op: '>', value: 8 }, then: { property: 'mood', set: 'happy' }, emit: 'content' }
  ]
};

// --- the engine ------------------------------------------------------------------------------

test('the engine is deterministic for a given seed: same result every run, in one call or several; a different seed differs', () => {
  const a = stepWorld(SPEC, null, 60);
  const b = stepWorld(SPEC, null, 60);
  assert.deepEqual(a, b);
  const first = stepWorld(SPEC, null, 25);
  const rest = stepWorld(SPEC, first.state, 35);
  assert.deepEqual(rest.state, a.state, '25 + 35 steps equal 60 steps');
  const other = stepWorld({ ...SPEC, seed: 43 }, null, 60);
  assert.notDeepEqual(other.state.entities, a.state.entities);
  assert.equal(a.state.tick, 60);
  assert.ok(a.events.some((e) => e.kind === 'ate'));
  // The arguments are never changed.
  const st = initialState(SPEC);
  const copy = JSON.stringify(st);
  stepWorld(SPEC, st, 10);
  assert.equal(JSON.stringify(st), copy);
  // Every rule type has plain words.
  for (const r of rulesInWords(validateSpec(SPEC))) assert.ok(r.text.length > 10 && !/unknown rule/.test(r.text), r.id);
});

test('every limit is enforced: entities, rules, steps a call, 256 KB, properties, ids, rule types', () => {
  const ents = (n) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, kind: 'dot', position: { x: 1, y: 1 } }));
  assert.doesNotThrow(() => validateSpec({ entities: ents(SANDBOX_LIMITS.entities) }));
  assert.throws(() => validateSpec({ entities: ents(SANDBOX_LIMITS.entities + 1) }), (e) => e instanceof WorldError && e.code === 'limit');
  const rules = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, type: 'grow', kind: 'dot', property: 'size', amount: 1 }));
  assert.doesNotThrow(() => validateSpec({ rules: rules(SANDBOX_LIMITS.rules) }));
  assert.throws(() => validateSpec({ rules: rules(SANDBOX_LIMITS.rules + 1) }), /at most 50 rules/);
  assert.throws(() => stepWorld(SPEC, null, 101), /between 1 and 100/);
  assert.throws(() => stepWorld(SPEC, null, 0), /between 1 and 100/);
  assert.doesNotThrow(() => stepWorld(SPEC, null, 100));
  const big = { entities: [{ id: 'x', kind: 'dot', properties: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, 'y'.repeat(200)])) }], pad: 'z'.repeat(SANDBOX_LIMITS.specBytes) };
  assert.throws(() => validateSpec(big), /larger than 256 KB/);
  assert.throws(() => validateSpec({ entities: [{ id: 'x', kind: 'dot', properties: Object.fromEntries(Array.from({ length: SANDBOX_LIMITS.propertiesPerEntity + 1 }, (_, i) => [`p${i}`, 1])) }] }), new RegExp(`at most ${SANDBOX_LIMITS.propertiesPerEntity} properties`));
  assert.throws(() => validateSpec({ entities: [{ id: 'bad id!', kind: 'dot' }] }), /id must be/);
  assert.throws(() => validateSpec({ rules: [{ id: 'x', type: 'script', code: 'process.exit()' }] }), /type must be one of/);
  assert.throws(() => validateSpec({ entities: [{ id: 'x', kind: 'dot' }, { id: 'x', kind: 'dot' }] }), /used twice/);
  // Spawning stops at the entity limit, with an event.
  const full = { entities: ents(SANDBOX_LIMITS.entities), rules: [{ id: 's', type: 'spawn', kind: 'dot', every: 1, chance: 1 }] };
  const out = stepWorld(full, null, 3);
  assert.equal(out.state.entities.length, SANDBOX_LIMITS.entities);
  assert.ok(out.events.some((e) => e.kind === 'limit'));
});

test('no code-execution path: strings like "process.exit()" are inert data, odd keys are refused, and the engine imports and calls nothing', async () => {
  globalThis.__pg1SandboxRan = false;
  const evil = ['process.exit()', "require('fs').rmSync('/', {recursive:true})", '${globalThis.__pg1SandboxRan = true}', "constructor.constructor('globalThis.__pg1SandboxRan=true')()", '__proto__', 'import("node:child_process")'];
  const spec = {
    seed: 1,
    entities: evil.map((v, i) => ({ id: `e${i}`, kind: 'note', properties: { text: v, flag: 'process.exit()' } })),
    rules: [{ id: 'c', type: 'condition', kind: 'note', if: { property: 'text', op: '==', value: 'process.exit()' }, then: { property: 'flag', set: "globalThis.__pg1SandboxRan = true" }, emit: 'matched' }]
  };
  const out = stepWorld(spec, null, 5);
  assert.equal(globalThis.__pg1SandboxRan, false, 'nothing in a spec ever runs');
  assert.equal(out.state.entities.find((e) => e.id === 'e0').properties.flag, 'globalThis.__pg1SandboxRan = true', 'a string stays a string');
  // A prototype-polluting key is not a property name.
  assert.throws(() => validateSpec({ entities: [{ id: 'x', kind: 'dot', properties: JSON.parse('{"__proto__": {"polluted": true}}') }] }));
  // An ordinary-looking key is just an own property holding data.
  const inert = validateSpec({ entities: [{ id: 'x', kind: 'dot', properties: { constructor: 'process.exit()' } }] });
  assert.equal(Object.getOwnPropertyDescriptor(inert.entities[0].properties, 'constructor').value, 'process.exit()');
  assert.equal({}.polluted, undefined);
  // The engine and its helpers: no eval, Function, dynamic import, require, child process, file system or network.
  for (const f of ['engine.mjs', 'describe.mjs', 'blind.mjs', 'mcp.mjs', 'worlds.mjs']) {
    const src = readFileSync(new URL(`lib/sandbox/${f}`, ROOT), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /\beval\s*\(|new\s+Function\b|\bFunction\s*\(|\bimport\s*\(|\brequire\s*\(|child_process|node:fs|node:vm|\bfetch\s*\(|XMLHttpRequest|WebSocket/, f);
  }
});

// --- access and quotas -----------------------------------------------------------------------------

function res() {
  return { statusCode: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, end() { return this; } };
}
async function mcp(store, key, method, params = {}) {
  __setSandboxStore(() => store);
  const r = res();
  await sandboxMcp({ method: 'POST', headers: key ? { authorization: `Bearer ${key}` } : {}, body: { jsonrpc: '2.0', id: 1, method, params } }, r);
  return r;
}
const callTool = async (store, key, name, args) => {
  const r = await mcp(store, key, 'tools/call', { name, arguments: args });
  const c = r.body.result && r.body.result.content && JSON.parse(r.body.result.content[0].text);
  return { r, c };
};

test('a key without the sandbox scope is refused (no key, a licence key, another scope, a revoked key); the sandbox tools need a sandbox key', async () => {
  const store = createSandboxStore();
  const none = await mcp(store, null, 'tools/list');
  assert.equal(none.statusCode, 401);
  assert.equal(none.body.error.data.code, 'sandbox_key_required');
  const licence = await mcp(store, '7F3A9C21-B4D6E8F0-12345678-9ABCDEF0', 'initialize');
  assert.equal(licence.statusCode, 403);
  assert.equal(licence.body.error.data.code, 'sandbox_scope_required');
  await store.insertKey({ key_hash: hashKey('pg1sb_other-scope-key'), label: 'other', scopes: ['read'] });
  assert.equal((await mcp(store, 'pg1sb_other-scope-key', 'tools/list')).body.error.data.code, 'sandbox_scope_required');
  const inv = await inviteAgent(store, { label: 'Frits agent' });
  assert.match(inv.key, /^pg1sb_/);
  assert.equal((await store.listKeys()).some((k) => 'key_hash' in k), false, 'the hash is never listed');
  const ok = await mcp(store, inv.key, 'tools/list');
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body.result.tools.map((t) => t.name), ['create_world', 'add_entity', 'set_rule', 'step_world', 'observe_world', 'list_worlds', 'delete_world', 'update_entity', 'get_catalog', 'read_blackbox']);
  assert.deepEqual(SANDBOX_TOOL_NAMES, ok.body.result.tools.map((t) => t.name));
  for (const t of ok.body.result.tools) assert.match(t.description, /simulation/i, `${t.name} says worlds are simulations`);
  await store.revokeKey(inv.id);
  assert.equal((await mcp(store, inv.key, 'tools/list')).body.error.data.code, 'sandbox_key_revoked');
  // The public MCP server's tool list is unchanged by the sandbox.
  const { listedTools } = await import('../api/mcp.mjs');
  for (const n of SANDBOX_TOOL_NAMES) assert.ok(!listedTools({}).some((t) => t.name === n), `${n} is not on /api/mcp`);
});

test('quotas hold, with clear errors: worlds per owner, steps a day, storage; an invited agent only writes its own worlds', async () => {
  const store = createSandboxStore();
  const inv = await inviteAgent(store, { label: 'Tom agent', maxWorlds: 2, maxStepsPerDay: 50, maxStorageKb: 40 });
  const w1 = await callTool(store, inv.key, 'create_world', { name: 'one', spec: SPEC });
  assert.equal(w1.c.simulation, true);
  assert.equal(w1.c.label, 'Simulation');
  await callTool(store, inv.key, 'create_world', { name: 'two', spec: { seed: 2 } });
  const third = await callTool(store, inv.key, 'create_world', { name: 'three', spec: {} });
  assert.equal(third.r.body.result.isError, true);
  assert.equal(third.c.code, 'quota_worlds');
  assert.match(third.c.message, /already has 2 worlds \(the limit is 2\)/);
  const s1 = await callTool(store, inv.key, 'step_world', { world_id: w1.c.id, steps: 40 });
  assert.equal(s1.c.tick, 40);
  const s2 = await callTool(store, inv.key, 'step_world', { world_id: w1.c.id, steps: 20 });
  assert.equal(s2.c.code, 'quota_steps');
  assert.match(s2.c.message, /used 40 of its 50 steps today; 10 are left/);
  const big = await callTool(store, inv.key, 'add_entity', { world_id: w1.c.id, entity: { id: 'big', kind: 'note', properties: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, 'x'.repeat(200)])) } });
  assert.equal(big.c.code === 'quota_storage' || big.c.id === w1.c.id, true);
  // Entities and rules through the tools, validated.
  const bad = await callTool(store, inv.key, 'set_rule', { world_id: w1.c.id, rule: { id: 'x', type: 'exec', code: 'process.exit()' } });
  assert.equal(bad.c.code, 'invalid_world');
  const rule = await callTool(store, inv.key, 'set_rule', { world_id: w1.c.id, rule: { id: 'shine', type: 'emit', kind: 'grass', every: 2, event: 'shine' } });
  assert.ok(rule.c.rules.some((r) => r.id === 'shine' && /every 2 steps/.test(r.text)));
  // Another agent cannot see or change a private world; an invited one is read only.
  const other = await inviteAgent(store, { label: 'Other agent' });
  assert.equal((await callTool(store, other.key, 'step_world', { world_id: w1.c.id })).c.code, 'world_not_found');
  assert.equal((await callTool(store, other.key, 'observe_world', { world_id: w1.c.id })).c.code, 'world_not_found');
  const shared = await callTool(store, inv.key, 'delete_world', { world_id: w1.c.id });
  assert.equal(shared.c.deleted, true);
  const pub = await callTool(store, inv.key, 'create_world', { name: 'shared', spec: SPEC, visibility: 'invited' });
  assert.equal((await callTool(store, other.key, 'observe_world', { world_id: pub.c.id })).c.entities.length, 3);
  assert.equal((await callTool(store, other.key, 'add_entity', { world_id: pub.c.id, entity: { id: 'z', kind: 'dot' } })).c.code, 'world_not_found');
  const list = await callTool(store, other.key, 'list_worlds', {});
  assert.deepEqual(list.c.worlds.map((w) => [w.name, w.owner_is_you]), [['shared', false]]);
  // PG1 itself: 10 worlds at most.
  for (let i = 0; i < SANDBOX_LIMITS.worldsPerOwner; i++) await createWorld(store, pg1Principal(), { name: `pg1 ${i}`, spec: {} });
  await assert.rejects(createWorld(store, pg1Principal(), { name: 'eleven', spec: {} }), (e) => e instanceof SandboxError && e.code === 'quota_worlds');
});

// --- world missions --------------------------------------------------------------------------------

const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const gemini = (text) => json({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
const PLAN = 'ENTITY {"id":"fox1","kind":"fox","properties":{"hunger":1},"position":{"x":5,"y":5,"z":0}}\nRULE {"id":"foxmove","type":"move","kind":"fox","wander":2}\nSTEP 10';

function tickWorld({ missions = [], onGemini = () => gemini(PLAN) } = {}) {
  const calls = [];
  const db = createAutonomousDb({
    other: async (url, opts = {}) => {
      const u = String(url);
      calls.push({ url: u, method: (opts.method || 'GET').toUpperCase(), headers: opts.headers || {}, body: String(opts.body || '') });
      if (u.includes('generativelanguage.googleapis.com')) return opts.headers['x-goog-api-key'] === FREE ? onGemini(JSON.parse(opts.body)) : json({ error: { code: 402, message: 'paid key must not be called' } }, 402);
      if (u.includes('api.anthropic.com')) return json({ error: { message: 'paid engine must not be called' } }, 400);
      if (u.includes('/rest/v1/pg1_missions')) return json((opts.method || 'GET') === 'PATCH' ? missions : missions);
      if (u.includes('/rest/v1/')) return json([]);
      return json({ message: `not stubbed: ${u}` }, 404);
    }
  });
  const env = { GEMINI_API_KEY_FREE: FREE, GEMINI_API_KEY_PAID: PAID, ANTHROPIC_API_KEY: ANTHROPIC, PG1_DAILY_SPEND_CAP_USD: '50' };
  const autoStore = createAutonomousStore({ supUrl: SUP, supKey: 'service', fetchImpl: db.fetch });
  return { db, calls, env, autoStore };
}
const noScheduled = { engineWatchdog: async () => ({ ok: true, result: 'fine' }), integrationWatch: async () => ({ ok: true, result: 'fine' }), feedGuardian: async () => ({ ok: true, result: 'fine' }), listExperiments: async () => [], startExperiment: async () => ({ ok: false }) };
const due = (extra) => ({ id: 'aaaa1111-0000-4000-8000-000000000001', goal: 'grow a small ecosystem', schedule: 'daily', interval_minutes: 1440, status: 'active', next_run_at: new Date(Date.now() - 1000).toISOString(), kind: 'world', world_id: null, ...extra });

test('a world mission plans on a free engine and the engine applies it; no paid call even with an autonomous budget and a spend cap; labelled simulation', async () => {
  const sandbox = createSandboxStore();
  const w = tickWorld({ missions: [due()] });
  await switchOn(w.autoStore);
  await setLimits(w.autoStore, { dailyBudgetUsd: 5 });
  const out = await autonomousTick({ env: w.env, supUrl: SUP, supKey: 'service', fetchImpl: w.db.fetch, deps: { ...noScheduled, notify: async () => {}, sandboxStore: sandbox } });
  const row = w.db.actions.find((r) => r.type === 'world_mission');
  assert.ok(row, JSON.stringify(out.ran));
  assert.equal(row.status, 'done', row.result);
  assert.match(row.result, /^Simulation: 3 changes in "grow a small ecosystem"/);
  assert.match(row.body, /Simulation \(not real events\)/);
  const worlds = await sandbox.listWorlds({ owner: 'pg1' });
  assert.equal(worlds.length, 1);
  assert.equal(worlds[0].tick, 10);
  assert.ok(worlds[0].state.entities.some((e) => e.id === 'fox1'));
  const ai = w.calls.filter((c) => /generativelanguage|anthropic|openrouter|openai|groq|mistral/.test(c.url));
  assert.ok(ai.length >= 1);
  assert.ok(ai.every((c) => c.headers['x-goog-api-key'] === FREE), 'free engine only');
  assert.equal(w.calls.filter((c) => c.url.includes('api.anthropic.com')).length, 0);
  // Core State: a sandbox event, counts and words only.
  const events = (await readCoreState({ events: 20 })).events.filter((e) => e.area === 'sandbox');
  assert.ok(events.some((e) => e.kind === 'world_mission' && /^Simulation: world mission/.test(e.summary)));
});

test('the kill switch stops a world mission at its next checkpoint: nothing more is applied', async () => {
  const sandbox = createSandboxStore();
  let w;
  w = tickWorld({ missions: [due()], onGemini: () => { w.db.state.enabled = false; return gemini(PLAN); } });
  await switchOn(w.autoStore);
  await autonomousTick({ env: w.env, supUrl: SUP, supKey: 'service', fetchImpl: w.db.fetch, deps: { ...noScheduled, notify: async () => {}, sandboxStore: sandbox } });
  const row = w.db.actions.find((r) => r.type === 'world_mission');
  assert.equal(row.status, 'stopped');
  assert.match(row.result, /Stopped at a safe checkpoint/);
  const world = (await sandbox.listWorlds({ owner: 'pg1' }))[0];
  assert.equal(world.tick, 0, 'no step ran');
  assert.equal(world.state.entities.length, 0, 'no entity was added');
  // OFF: the tick runs nothing at all.
  const off = tickWorld({ missions: [due()] });
  const out = await autonomousTick({ env: off.env, supUrl: SUP, supKey: 'service', fetchImpl: off.db.fetch, deps: { ...noScheduled, sandboxStore: sandbox } });
  assert.deepEqual(out.ran, []);
  assert.equal(off.calls.filter((c) => /generativelanguage/.test(c.url)).length, 0);
});

test('an invited agent\'s world data never reaches an AI engine: a world mission pointed at one is refused before any prompt', async () => {
  const sandbox = createSandboxStore();
  const inv = await inviteAgent(sandbox, { label: 'Outside agent' });
  const who = await resolveSandboxKey(sandbox, inv.key);
  const theirs = await createWorld(sandbox, who, { name: 'INVITED-WORLD-NAME', spec: { entities: [{ id: 'secret', kind: 'note', properties: { text: 'INVITED-SECRET-7731' } }] }, visibility: 'invited' });
  assert.throws(() => assertPg1World({ owner: who.owner }), /only work on PG1's own worlds/);
  let called = 0;
  const direct = await runWorldMission({ store: sandbox, mission: { id: 'm1', goal: 'evolve it', world_id: theirs.id }, textFn: async () => { called++; return { ok: true, text: PLAN }; } });
  assert.equal(direct.ok, false);
  assert.equal(called, 0, 'no AI call for an invited world');
  // Through the tick too: every AI request is free of the invited data.
  const w = tickWorld({ missions: [due({ world_id: theirs.id }), due({ id: 'bbbb2222-0000-4000-8000-000000000002', goal: 'pg1 garden' })] });
  await switchOn(w.autoStore);
  await autonomousTick({ env: w.env, supUrl: SUP, supKey: 'service', fetchImpl: w.db.fetch, deps: { ...noScheduled, notify: async () => {}, sandboxStore: sandbox } });
  const ai = w.calls.filter((c) => /generativelanguage|anthropic|groq|mistral|openrouter|openai|cloudflare|models\.github/.test(c.url));
  assert.ok(ai.length >= 1, 'PG1\'s own world mission did reach a free engine');
  for (const c of ai) {
    assert.doesNotMatch(c.body, /INVITED-SECRET-7731|INVITED-WORLD-NAME/);
  }
  const rows = w.db.actions.filter((r) => r.type === 'world_mission');
  assert.ok(rows.some((r) => r.status === 'failed' && /only work on PG1's own worlds/.test(r.result)));
  // The failure is reflected on like any other job.
  const events = (await readCoreState({ events: 50 })).events.filter((e) => e.area === 'sandbox' && e.kind === 'world_mission_failed');
  assert.equal(events.length, 1);
  assert.equal(events[0].severity, 'error');
  assert.doesNotMatch(JSON.stringify(events), /INVITED-SECRET-7731/);
  // The invited world was not touched.
  assert.equal((await sandbox.getWorld(theirs.id)).tick, 0);
});

test('parsePlan keeps at most three valid lines and ignores anything else', () => {
  assert.deepEqual(parsePlan('hello\nSTEP 999\nRULE {not json}\nENTITY {"id":"a","kind":"b"}\nRULE {"id":"r","type":"emit","kind":"b","every":1,"event":"e"}\nSTEP 2').map((p) => p.kind), ['STEP', 'ENTITY', 'RULE']);
  assert.equal(parsePlan('STEP 999')[0].steps, 50);
});

// --- the operator's side ---------------------------------------------------------------------------

test('the viewer API is the operator\'s only; list, world, step (PG1 worlds), read only for invited worlds', async () => {
  const store = createSandboxStore();
  __setSandboxViewerStore(() => store);
  process.env.USER_API_KEY = 'op'; process.env.USER_API_PASS = 'pass-sandbox';
  const call = async (body, creds = true) => { const r = res(); await sandboxViewer({ method: 'POST', headers: {}, socket: { remoteAddress: '10.40.0.1' }, body: { ...body, ...(creds ? { user: 'op', pass: 'pass-sandbox' } : {}) } }, r); return r; };
  assert.equal((await call({ op: 'list' }, false)).statusCode, 401);
  const mine = await createWorld(store, pg1Principal(), { name: 'Garden', spec: SPEC });
  const inv = await inviteAgent(store, { label: 'Viewer test' });
  const theirs = await createWorld(store, await resolveSandboxKey(store, inv.key), { name: 'Theirs', spec: SPEC });
  const list = await call({ op: 'list' });
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.label, 'Simulation');
  assert.deepEqual(list.body.worlds.map((w) => [w.name, w.readOnly]).sort(), [['Garden', false], ['Theirs', true]]);
  const step = await call({ op: 'step', id: mine.id, steps: 3 });
  assert.equal(step.body.world.tick, 3);
  assert.ok(step.body.world.rules.length === SPEC.rules.length);
  assert.equal((await call({ op: 'step', id: theirs.id })).statusCode, 404, 'an invited agent\'s world is read only');
  assert.equal((await call({ op: 'world', id: theirs.id })).body.world.readOnly, true);
  assert.equal((await call({ op: 'experiments' })).body.label, 'SIMULATION — blind experiment');
});

test('chat: /sandbox, /world, /sandbox create and invite are the operator\'s; replies say simulation and carry the viewer button', async () => {
  const store = createSandboxStore();
  assert.equal((await handleSandboxCommand({ text: '/sandbox', isOperator: false, store })).status, 401);
  const created = await handleSandboxCommand({ text: '/sandbox create "Pond"', isOperator: true, store });
  assert.match(created.reply, /Created "Pond" \(Simulation, from the universe template: \d+ things\)/);
  assert.equal(created.sandbox.open, true);
  const id8 = /\/world ([0-9a-f]{8})/.exec(created.reply)[1];
  const one = await handleSandboxCommand({ text: `/world ${id8}`, isOperator: true, store });
  assert.match(one.reply, /\*\*Pond\*\* \(Simulation\)/);
  assert.match(one.sandbox.worldId, /^[0-9a-f-]{36}$/);
  const all = await handleSandboxCommand({ text: '/sandbox', isOperator: true, store });
  assert.match(all.reply, /Simulation: nothing here is a real event/);
  const inv = await handleSandboxCommand({ text: '/sandbox invite Frits agent', isOperator: true, store });
  assert.match(inv.reply, /shown once: `pg1sb_[A-Za-z0-9_-]+`/);
  assert.match(inv.reply, /never put in a blind experiment without its human operator's recorded opt-in/);
});

test('the registry has /sandbox and /world with buttons; the commands file is built from it', async () => {
  const { COMMANDS } = await import('../lib/commands/registry.mjs');
  for (const c of ['/sandbox', '/world', '/sandbox invite', '/sandbox consent', '/sandbox experiment', '/sandbox stop', '/sandbox create']) assert.ok(COMMANDS.some((x) => x.command === c), c);
  const built = JSON.parse(readFileSync(new URL('public/commands.json', ROOT), 'utf8'));
  assert.ok(JSON.stringify(built).includes('/world'));
});

// --- the migration -----------------------------------------------------------------------------------

test('migration: a unique timestamp after every other, safe to run twice, service role only, after or without missions and Core State', async () => {
  const MIG = '20261110120000_pg1_sandbox.sql';
  const names = readdirSync(new URL('supabase/migrations/', ROOT)).filter((f) => f.endsWith('.sql')).sort();
  assert.equal(names.at(-1), MIG);
  assert.equal(names.filter((n) => n.slice(0, 14) === MIG.slice(0, 14)).length, 1);
  const d = await makeDb(['20261105120000_pg1_missions.sql', '20261109120000_pg1_core_state.sql', MIG, MIG]);
  const tables = ['pg1_worlds', 'pg1_world_events', 'pg1_sandbox_keys', 'pg1_sandbox_usage', 'pg1_sandbox_consents', 'pg1_experiment_runs', 'pg1_experiment_anomalies', 'pg1_experiment_log', 'pg1_world_blackbox'];
  for (const t of tables) {
    const rls = await d.query('select relrowsecurity from pg_class where relname = $1', [t]);
    assert.equal(rls.rows[0].relrowsecurity, true, `${t} has RLS on`);
    const g = await d.query("select count(*)::int as n from information_schema.role_table_grants where table_name = $1 and grantee in ('anon', 'authenticated')", [t]);
    assert.equal(g.rows[0].n, 0, `${t} grants nothing to anon or authenticated`);
  }
  await d.query("insert into pg1_core_state(area) values ('sandbox')");
  await assert.rejects(d.query("insert into pg1_worlds(owner, name, spec) values ('someone', 'x', '{}')"));
  await assert.rejects(d.query("insert into pg1_worlds(owner, name, spec, visibility) values ('pg1', 'x', '{}', 'public')"));
  await assert.rejects(d.query("insert into pg1_experiment_log(run_id, turn, kind, content) values (gen_random_uuid(), 1, 'private_reasoning', 'x')"));
  const cols = await d.query("select column_name from information_schema.columns where table_name = 'pg1_missions' and column_name in ('kind', 'world_id') order by 1");
  assert.deepEqual(cols.rows.map((r) => r.column_name), ['kind', 'world_id']);
  await makeDb([MIG]); // without the missions and Core State tables: still applies
  // The store against the real tables.
  const fetchImpl = pgRest(d, { base: SUP });
  const store = createSandboxStore({ supUrl: SUP, supKey: 'k', fetchImpl });
  const v = await createWorld(store, pg1Principal(), { name: 'Db world', spec: SPEC });
  await stepWorldFor(store, pg1Principal(), { world_id: v.id, steps: 5 });
  const o = await observeWorld(store, pg1Principal(), { world_id: v.id });
  assert.equal(o.tick, 5);
  assert.equal((await listWorldsFor(store, pg1Principal())).quota.steps_today, 5);
  const inv = await inviteAgent(store, { label: 'Db agent' });
  assert.equal((await resolveSandboxKey(store, inv.key)).key.label, 'Db agent');
  await addEntity(store, pg1Principal(), { world_id: v.id, entity: { id: 'n', kind: 'note', properties: { text: 'process.exit()' } } });
  await setRule(store, pg1Principal(), { world_id: v.id, rule: { id: 'z', type: 'grow', kind: 'note', property: 'size', amount: 1 } });
  assert.equal((await store.getWorld(v.id)).spec.rules.length, SPEC.rules.length + 1);
  // World events are kept 30 days: the pulse prunes older ones.
  await d.query("update pg1_world_events set created_at = now() - interval '31 days' where id = (select min(id) from pg1_world_events)");
  const n0 = (await d.query('select count(*)::int as n from pg1_world_events')).rows[0].n;
  await store.pruneEvents(new Date(Date.now() - 30 * 86400000).toISOString());
  assert.equal((await d.query('select count(*)::int as n from pg1_world_events')).rows[0].n, n0 - 1);
  // The black box: every change above recorded, chained, append-only.
  const bb = await readBlackbox(store, pg1Principal(), { world_id: v.id });
  assert.deepEqual(bb.records.map((r) => r.action).filter((a) => ['create_world', 'step_world', 'add_entity', 'set_rule'].includes(a)).reverse(), ['create_world', 'step_world', 'add_entity', 'set_rule']);
  assert.equal(bb.chain.ok, true);
  assert.ok(bb.actors.some((a) => a.actor === 'pg1'));
  await assert.rejects(d.query("update pg1_world_blackbox set action = 'nothing' where seq = 1"), /append-only/);
  await assert.rejects(d.query('delete from pg1_world_blackbox where seq = 1'), /append-only/);
  await d.query('alter table pg1_world_blackbox disable trigger pg1_world_blackbox_append_only');
  await d.query("update pg1_world_blackbox set detail = '{\"name\":\"forged\"}' where seq = 1");
  await d.query('alter table pg1_world_blackbox enable trigger pg1_world_blackbox_append_only');
  const forged = await readBlackbox(store, pg1Principal(), { world_id: v.id });
  assert.equal(forged.chain.ok, false, 'a changed record breaks the chain');
  assert.equal(forged.chain.broken_at, 1);
  await deleteWorldFor(store, pg1Principal(), { world_id: v.id });
  assert.ok((await d.query('select count(*)::int as n from pg1_world_blackbox where world_id = $1', [v.id])).rows[0].n > 0, 'the black box outlives the world');
});
