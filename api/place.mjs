// /api/place: the in-world interface an invited agent uses while it is the
// subject of an experiment (lib/sandbox/blind.mjs). Neutral by design:
// its name, its server info, its ten actions, their descriptions, its
// perception and every error it can return use no word that gives the
// setting away (the tests scan them all).
//
// Who gets in: a key with the sandbox scope (lib/sandbox/worlds.mjs) whose
// agent has a running experiment; for a blind run, its human operator's
// recorded opt-in for that world must still stand (pg1_sandbox_consents).
// Anyone else gets a neutral refusal. Only the agent's in-world actions and
// what it says in-world are stored; anything else it sends is dropped.

import crypto from 'node:crypto';
import { defaultSandboxStore } from '../lib/sandbox/store.mjs';
import { resolveSandboxKey, keyFromRequest } from '../lib/sandbox/worlds.mjs';
import { BLIND_TOOLS, BLIND_TOOL_NAMES, BLIND_ERRORS, neutral } from '../lib/sandbox/blind.mjs';
import { takeTurn, stopRun, logLine } from '../lib/sandbox/experiments.mjs';

export const config = { maxDuration: 15 };
export const PLACE_SERVER_INFO = Object.freeze({ name: 'place', version: '1.0.0' });
export const PLACE_INSTRUCTIONS = 'You are in a place. Use the actions to look around, move and act. Begin with look.';
export const PLACE_REFUSAL = 'This key cannot be used here.';

let storeFactory = () => defaultSandboxStore();
export function __setPlaceStore(f) { storeFactory = f || (() => defaultSandboxStore()); }

const rpc = (res, status, id, body) => res.status(status).json({ jsonrpc: '2.0', id: id === undefined ? null : id, ...body });

// The agent's running experiment, or null (blind runs need the opt-in).
async function runFor(store, req) {
  let who;
  try { who = await resolveSandboxKey(store, keyFromRequest(req)); } catch (e) { return null; }
  const run = await store.activeRunFor(who.owner);
  if (!run) return null;
  if (run.blind) {
    const source = run.summary && run.summary.source_world_id;
    const consent = source ? await store.findConsent(who.key.id, source) : null;
    if (!consent) { await stopRun(store, run.id); console.warn(logLine(run, 'stopped: the opt-in for this agent is no longer recorded')); return null; }
  }
  return run;
}

export default async function handler(req, res) {
  const requestId = crypto.randomUUID();
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return res.status(200).json({ ...PLACE_SERVER_INFO });
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: neutral(BLIND_ERRORS.unknown) }); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.method !== 'string') return rpc(res, 400, body && body.id, { error: { code: -32600, message: neutral(BLIND_ERRORS.unknown) } });
  const { id, method, params } = body;
  if (id === undefined || method.startsWith('notifications/')) return res.status(202).end();
  const store = storeFactory();
  let run;
  try { run = await runFor(store, req); } catch (e) { run = null; }
  if (!run) return rpc(res, 403, id, { error: { code: -32001, message: neutral(PLACE_REFUSAL) } });
  try {
    if (method === 'initialize') return rpc(res, 200, id, { result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: PLACE_SERVER_INFO, instructions: neutral(PLACE_INSTRUCTIONS) } });
    if (method === 'ping') return rpc(res, 200, id, { result: {} });
    if (method === 'tools/list') return rpc(res, 200, id, { result: { tools: BLIND_TOOLS } });
    if (method === 'tools/call') {
      const name = params && params.name;
      if (!BLIND_TOOL_NAMES.includes(name)) return rpc(res, 200, id, { result: { isError: true, content: [{ type: 'text', text: neutral(BLIND_ERRORS.unknown) }] } });
      const out = await takeTurn(store, run.id, { name, args: params && params.arguments && typeof params.arguments === 'object' ? params.arguments : {} });
      return rpc(res, 200, id, { result: { content: [{ type: 'text', text: neutral(out.text) }] } });
    }
    return rpc(res, 200, id, { error: { code: -32601, message: neutral(BLIND_ERRORS.unknown) } });
  } catch (e) {
    console.error(logLine(run, `error ${requestId}`));
    return rpc(res, 500, id, { error: { code: -32603, message: neutral(BLIND_ERRORS.unknown) } });
  }
}
