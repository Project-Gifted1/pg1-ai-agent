// The sandbox in the chat (operator only; no AI call):
//
//   /sandbox                       worlds, quota use and experiments, with
//                                  the Open the Sandbox button
//   /world <id>                    one world: its rules in plain words, and
//                                  the button that opens it in the viewer
//   /sandbox invite <name>         an access key for an agent Gift invites
//                                  (shown once; only its hash is kept)
//   /sandbox consent <agent> <world> "<who agreed>" [on <YYYY-MM-DD>]
//                                  records that agent's human operator's
//                                  opt-in to blind experiments in that world
//   /sandbox experiment <world> [blind|informed] [clues|control]
//                       [<anomaly,anomaly,...>] [--agent <name>] "<situation>"
//                                  starts a run (PG1-subject by default)
//   /sandbox stop <run>            stops a run
//
// Worlds are simulations, and every reply says so; blind runs are labelled
// "SIMULATION — blind experiment".

import { createWorld, listWorldsFor, observeWorld, inviteAgent, pg1Principal, SandboxError } from './worlds.mjs';
import { startExperiment, stopRun, experimentsView, PG1_SUBJECT } from './experiments.mjs';
import { ANOMALY_TYPES, BLIND_LABEL, INFORMED_LABEL } from './blind.mjs';
import { SIMULATION_LABEL } from './describe.mjs';

export const SANDBOX_RE = /^\/(?:sandbox|world|universe)\b/i;
export const isSandboxCommand = (t) => SANDBOX_RE.test(String(t || '').trim());
const OPERATOR_ONLY = 'The Sandbox is for the signed-in operator only.';
const short = (id) => String(id || '').slice(0, 8);
export const SANDBOX_HELP = [
  '### [ SANDBOX ] (simulations)',
  '- /sandbox: worlds, quota use and experiments; /world <id>: one world',
  '- /sandbox invite <name>: an access key for an agent you invite',
  '- /sandbox consent <agent> <world> "<who agreed>" [on YYYY-MM-DD]: that agent\'s human operator agreed to blind experiments in that world',
  `- /sandbox experiment <world> [blind|informed] [clues|control] [${ANOMALY_TYPES.join(',')}] [--agent <name>] "<situation>": a run (PG1-subject by default)`,
  '- /sandbox stop <run>',
  `Worlds are simulations. Blind runs are labelled "${BLIND_LABEL}".`
].join('\n');

async function findWorld(store, prefix) {
  const p = String(prefix || '').toLowerCase().replace(/[^0-9a-f-]/g, '');
  if (p.length < 4) return null;
  const hits = (await store.listWorlds({})).filter((w) => w.id.startsWith(p));
  return hits.length === 1 ? hits[0] : null;
}
async function findAgent(store, name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  const keys = (await store.listKeys()).filter((k) => !k.revoked_at);
  const hits = keys.filter((k) => k.label.toLowerCase() === n || k.id.startsWith(n));
  return hits.length === 1 ? hits[0] : null;
}

export function parseExperimentArgs(rest) {
  const out = { blind: true, clues: true, anomalies: [], agent: null, situation: '', world: '' };
  const quoted = /["“](.+?)["”]\s*$/s.exec(rest);
  if (quoted) out.situation = quoted[1].trim();
  const head = (quoted ? rest.slice(0, quoted.index) : rest).trim();
  const agent = /--agent\s+(\S+)/i.exec(head);
  if (agent) out.agent = agent[1];
  const words = head.replace(/--agent\s+\S+/i, '').split(/\s+/).filter(Boolean);
  out.world = words.shift() || '';
  for (const w of words) {
    const l = w.toLowerCase();
    if (l === 'blind') out.blind = true;
    else if (l === 'informed') out.blind = false;
    else if (l === 'clues') out.clues = true;
    else if (l === 'control') out.clues = false;
    else for (const t of l.split(',')) if (ANOMALY_TYPES.includes(t)) out.anomalies.push({ type: t });
  }
  return out;
}

export async function handleSandboxCommand({ text, isOperator = false, store }) {
  if (isOperator !== true) return { status: 401, reply: OPERATOR_ONLY };
  // /universe is /sandbox by its Pg1-Universe name.
  const t = String(text || '').trim().replace(/^\/universe\b/i, '/sandbox');
  try {
    const world = /^\/world\s+(\S+)/i.exec(t);
    if (world || /^\/world\s*$/i.test(t)) {
      const w = world ? await findWorld(store, world[1]) : null;
      if (!w) return { status: 200, reply: 'No single world matches that id. /sandbox lists them.' };
      const v = await observeWorld(store, { owner: w.owner, quota: pg1Principal().quota }, { world_id: w.id, events: 5 });
      return { status: 200, reply: [`**${v.name}** (${v.label}) · step ${v.tick} · ${v.entity_count} entities${w.owner === 'pg1' ? '' : ' · an invited agent\'s world'}`, ...(v.rules.length ? v.rules.map((r) => `- ${r.text}`) : ['- No rules yet.']), v.recent_events.length ? `Recent: ${v.recent_events.map((e) => e.summary).join('; ')}` : ''].filter(Boolean).join('\n'), sandbox: { open: true, worldId: w.id, label: v.label } };
    }
    const m = /^\/sandbox\s*(\S*)\s*([\s\S]*)$/i.exec(t);
    const sub = (m && m[1] || '').toLowerCase();
    const rest = (m && m[2] || '').trim();
    if (!sub) {
      const lw = await listWorldsFor(store, pg1Principal());
      const all = await store.listWorlds({});
      const ex = await experimentsView(store, { limit: 10 });
      const running = ex.runs.filter((r) => r.status === 'running');
      return {
        status: 200,
        reply: [
          `**PG1 Sandbox** (${SIMULATION_LABEL}: nothing here is a real event). ${lw.quota.worlds} of ${lw.quota.max_worlds} PG1 worlds · ${lw.quota.steps_today} of ${lw.quota.max_steps_per_day} steps today · ${all.filter((w) => w.owner !== 'pg1').length} invited agents' worlds.`,
          ...all.filter((w) => !w.blind).slice(0, 8).map((w) => `- \`/world ${short(w.id)}\` ${w.name} · step ${w.tick}${w.owner === 'pg1' ? '' : ' · invited'}`),
          running.length ? `Experiments running: ${running.length} (${BLIND_LABEL} or informed, as labelled in the viewer).` : 'No experiment is running.',
          'Open the viewer for the 3D view, play/pause/step and the Experiments panel.'
        ].join('\n'),
        sandbox: { open: true }
      };
    }
    if (sub === 'help') return { status: 200, reply: SANDBOX_HELP };
    if (sub === 'invite') {
      const out = await inviteAgent(store, { label: rest });
      return { status: 200, reply: `Invited **${out.label}** to the PG1 Sandbox (simulations only). Its key, shown once: \`${out.key}\`\nIt calls https://pg1-ai-agent.vercel.app/api/sandbox/mcp with Authorization: Bearer <key>. Only a hash of the key is kept. It is never put in a blind experiment without its human operator's recorded opt-in (/sandbox consent).` };
    }
    if (sub === 'consent') {
      // The agent by its name (in quotes when it has spaces) or its id.
      const c = /^(?:["“](.+?)["”]|(\S+))\s+(\S+)\s+["“](.+?)["”](?:\s+on\s+(\d{4}-\d{2}-\d{2}))?\s*$/i.exec(rest);
      if (!c) return { status: 200, reply: 'Usage: /sandbox consent <agent> <world> "<who agreed>" [on YYYY-MM-DD]' };
      c.splice(1, 2, c[1] || c[2]);
      const agent = await findAgent(store, c[1]);
      const w = await findWorld(store, c[2]);
      if (!agent) return { status: 200, reply: 'No single invited agent matches that name.' };
      if (!w || w.owner !== 'pg1') return { status: 200, reply: 'No single PG1 world matches that id.' };
      const agreedAt = c[4] ? new Date(`${c[4]}T00:00:00Z`) : new Date();
      if (Number.isNaN(agreedAt.getTime())) return { status: 200, reply: 'The date must be YYYY-MM-DD.' };
      await store.addConsent({ key_id: agent.id, world_id: w.id, agreed_by: c[3].trim().slice(0, 120), agreed_at: agreedAt.toISOString() });
      return { status: 200, reply: `Recorded: ${c[3].trim()} agreed on ${agreedAt.toISOString().slice(0, 10)} that ${agent.label} may be put in blind experiments in "${w.name}". Humans always see these runs labelled "${BLIND_LABEL}".` };
    }
    if (sub === 'experiment') {
      const a = parseExperimentArgs(rest);
      const w = await findWorld(store, a.world);
      if (!w) return { status: 200, reply: 'No single world matches that id. Usage: ' + SANDBOX_HELP.split('\n')[4].slice(2) };
      let subject = PG1_SUBJECT;
      if (a.agent) { const agent = await findAgent(store, a.agent); if (!agent) return { status: 200, reply: 'No single invited agent matches that name.' }; subject = `key:${agent.id}`; }
      const run = await startExperiment(store, { worldId: w.id, subject, blind: a.blind, clues: a.clues, situation: a.situation, anomalies: a.anomalies });
      return { status: 200, reply: `${a.blind ? BLIND_LABEL : INFORMED_LABEL}: run ${short(run.id)} started in a copy of "${w.name}" · ${a.clues ? `clues: ${run.anomalies.map((x) => x.type).join(', ') || 'none configured'}` : 'control (no anomalies)'} · subject ${subject === PG1_SUBJECT ? 'PG1-subject (free engines, while Autonomous mode is ON)' : 'an invited agent, at /api/place'}.`, sandbox: { open: true, panel: 'experiments' } };
    }
    if (sub === 'stop') {
      const runs = await store.listRuns({ limit: 200 });
      const p = rest.toLowerCase();
      const hit = p.length >= 4 ? runs.filter((r) => r.id.startsWith(p)) : [];
      if (hit.length !== 1) return { status: 200, reply: 'No single run matches that id.' };
      await stopRun(store, hit[0].id);
      return { status: 200, reply: `Run ${short(hit[0].id)} stopped (${hit[0].blind ? BLIND_LABEL : INFORMED_LABEL}).` };
    }
    if (sub === 'create') {
      // /sandbox create "<name>" [town|universe|meadow|empty]
      const m = /^["“]([^"”]{1,80})["”]\s*(\w+)?\s*$/.exec(rest) || /^(.*?)\s*\b(town|universe|meadow|empty)?\s*$/i.exec(rest);
      const name = ((m && m[1]) || '').trim() || 'Pg1-Universe';
      const tpl = ((m && m[2]) || 'universe').toLowerCase();
      if (!['town', 'universe', 'meadow', 'empty'].includes(tpl)) return { status: 200, reply: 'Templates: universe (the default: a living town and the space above it), town, meadow or empty.' };
      const v = await createWorld(store, pg1Principal(), tpl === 'empty' ? { name, spec: { seed: 1, entities: [], rules: [] } } : { name, template: tpl });
      return { status: 200, reply: `Created "${v.name}" (${v.label}, ${tpl === 'empty' ? 'empty' : `from the ${tpl} template`}: ${v.entity_count} things). \`/world ${short(v.id)}\``, sandbox: { open: true, worldId: v.id } };
    }
    return { status: 200, reply: SANDBOX_HELP };
  } catch (e) {
    if (e instanceof SandboxError) return { status: 200, reply: e.message };
    return { status: 200, reply: 'The Sandbox could not be reached right now.' };
  }
}
