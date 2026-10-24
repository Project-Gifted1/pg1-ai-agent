// /api/sandbox: the operator's Sandbox viewer (public/index.html, the
// Sandbox screen). Signed-in operator only (lib/operatorSession.mjs, the
// same credentials and lockout as /api/watches); anyone else gets 401 and
// never reaches a table. POST with an op:
//
//   { op: 'list' }                 worlds (PG1's and invited agents'), PG1's
//                                  quota use, experiment counts
//   { op: 'world', id }            one world: entities, rules in plain
//                                  words, recent events
//   { op: 'step', id, steps? }     runs one of PG1's worlds forward (the
//                                  viewer's Step and Play): step_world, on
//                                  PG1's quota; invited worlds are read only
//   { op: 'create', template?, name? }  a new PG1 world from a template
//                                  (universe by default), on PG1's quota
//   { op: 'experiments' }          the Experiments panel: runs, timelines,
//                                  the comparison of conditions
//
// Everything is labelled: worlds as simulations, blind runs as
// "SIMULATION — blind experiment". No AI call here.

import { resolveOperatorSession } from '../lib/operatorSession.mjs';
import { defaultSandboxStore } from '../lib/sandbox/store.mjs';
import { observeWorld, stepWorldFor, listWorldsFor, pg1Principal, worldView, createWorld, SandboxError } from '../lib/sandbox/worlds.mjs';
import { TEMPLATE_NAMES } from '../lib/sandbox/templates.mjs';
import { experimentsView } from '../lib/sandbox/experiments.mjs';
import { SIMULATION_LABEL, BLIND_LABEL } from '../lib/sandbox/describe.mjs';

export const config = { maxDuration: 15 };

let storeFactory = () => defaultSandboxStore();
export function __setSandboxViewerStore(f) { storeFactory = f || (() => defaultSandboxStore()); }

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method Not Allowed' }); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid JSON body' });
  req.body = body;
  const session = resolveOperatorSession(req);
  if (session.rateLimited) return res.status(429).json({ error: 'Too many failed sign-in attempts. Try again later.' });
  if (!session.isOperator) return res.status(401).json({ error: 'unauthorized', message: 'The Sandbox is for the signed-in operator only.' });

  const store = storeFactory();
  const pg1 = pg1Principal();
  try {
    if (body.op === 'list') {
      const mine = await listWorldsFor(store, pg1);
      const all = await store.listWorlds({});
      const ex = await experimentsView(store, { limit: 50 });
      return res.status(200).json({
        ok: true, label: SIMULATION_LABEL,
        worlds: all.map((w) => ({ ...worldView(w), owner: w.owner === 'pg1' ? 'PG1' : 'invited agent', readOnly: w.owner !== 'pg1', blind: !!w.blind })),
        quota: mine.quota,
        experiments: { label: BLIND_LABEL, running: ex.runs.filter((r) => r.status === 'running').length, total: ex.runs.length }
      });
    }
    if (body.op === 'world') {
      const w = await store.getWorld(String(body.id || ''));
      if (!w) return res.status(404).json({ error: 'not_found', message: 'No such world.' });
      const v = await observeWorld(store, { owner: w.owner, quota: pg1.quota }, { world_id: w.id, events: 30 });
      return res.status(200).json({ ok: true, world: { ...v, readOnly: w.owner !== 'pg1', blind: !!w.blind } });
    }
    if (body.op === 'step') {
      const out = await stepWorldFor(store, pg1, { world_id: String(body.id || ''), steps: body.steps === undefined ? 1 : body.steps });
      const v = await observeWorld(store, pg1, { world_id: out.id, events: 30 });
      return res.status(200).json({ ok: true, world: { ...v, readOnly: false }, events: out.events });
    }
    if (body.op === 'create') {
      const template = TEMPLATE_NAMES.includes(body.template) ? body.template : 'universe';
      const made = await createWorld(store, pg1, { name: String(body.name || 'PG1 universe').slice(0, 80), template });
      const v = await observeWorld(store, pg1, { world_id: made.id, events: 0 });
      return res.status(200).json({ ok: true, world: { ...v, readOnly: false } });
    }
    if (body.op === 'experiments') return res.status(200).json({ ok: true, ...(await experimentsView(store, { limit: 50 })) });
    return res.status(400).json({ error: 'bad_request', message: 'Unknown sandbox op' });
  } catch (e) {
    if (e instanceof SandboxError) return res.status(e.status).json({ error: e.code, message: e.message });
    console.error('[sandbox viewer] unhandled:', e && e.message);
    return res.status(500).json({ error: 'internal_error', message: 'The Sandbox could not be reached right now.' });
  }
}
