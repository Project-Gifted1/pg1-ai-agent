// Missions: standing goals the operator gives Autonomous mode
// (supabase/migrations/20261105120000_pg1_missions.sql).
//
//   /mission add "<goal>" [hourly | every 6h | daily | weekly]
//   /mission list
//   /mission pause <id>      (and /mission resume <id>)
//   /mission remove <id>
//
// A mission only runs while Autonomous mode is ON (lib/autonomous/runner.mjs
// runs the due ones on the tick): PG1 plans up to three read-only tasks for
// it on a free engine (capabilities.mjs MISSION_PLAN_SYSTEM) and runs them.
// The goal is the operator's text, scrubbed and capped; it is data for the
// planner, never an instruction that can widen the allowlist.

import { scrub } from './state.mjs';
import { parseSchedule } from './capabilities.mjs';

export const MISSIONS_TABLE = 'pg1_missions';

export function createMissionStore({ supUrl, supKey, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const rest = async (path, opts = {}) => {
    const res = await fetchImpl(`${supUrl}/rest/v1/${path}`, { cache: 'no-store', ...opts, headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (!res.ok) { const e = new Error(`missions ${res.status}`); e.status = res.status; throw e; }
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  };
  const one = (rows) => (Array.isArray(rows) ? rows[0] || null : rows);
  return {
    async add({ goal, schedule, kind = 'standard' }) {
      const s = parseSchedule(schedule);
      // kind 'world' needs the sandbox migration's column; a standard mission never sends it.
      // A project moves one stage every tick (lib/autonomous/projects.mjs).
      const interval = kind === 'project' ? 10 : Math.round(s.ms / 60000);
      return one(await rest(MISSIONS_TABLE, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ goal: scrub(goal, 300), schedule: kind === 'project' ? 'until done' : s.label, interval_minutes: interval, status: 'active', next_run_at: new Date(now()).toISOString(), ...(kind === 'world' ? { kind: 'world' } : {}), ...(kind === 'project' ? { kind: 'project', stage: 'research', project: {} } : {}) }) }));
    },
    async list({ includeRemoved = false } = {}) {
      return (await rest(`${MISSIONS_TABLE}?select=id,created_at,goal,schedule,interval_minutes,status,last_run_at,next_run_at${includeRemoved ? '' : '&status=neq.removed'}&order=created_at.asc&limit=50`)) || [];
    },
    // With the sandbox migration a mission has kind and world_id; before it
    // runs, the old columns only (every mission is then a standard one).
    async due() {
      const filter = `status=eq.active&next_run_at=lte.${encodeURIComponent(new Date(now()).toISOString())}&order=next_run_at.asc&limit=5`;
      try {
        try {
          return (await rest(`${MISSIONS_TABLE}?select=id,goal,schedule,interval_minutes,status,last_run_at,next_run_at,kind,world_id,stage,project&${filter}`)) || [];
        } catch (e2) {
          if (e2.status !== 400) throw e2;
          return (await rest(`${MISSIONS_TABLE}?select=id,goal,schedule,interval_minutes,status,last_run_at,next_run_at,kind,world_id&${filter}`)) || [];
        }
      } catch (e) {
        if (e.status !== 400) throw e;
        return (await rest(`${MISSIONS_TABLE}?select=id,goal,schedule,interval_minutes,status,last_run_at,next_run_at&${filter}`)) || [];
      }
    },
    async find(prefix) {
      const p = String(prefix || '').toLowerCase().replace(/[^0-9a-f-]/g, '');
      if (p.length < 4) return null;
      const rows = await this.list({ includeRemoved: false });
      const hits = rows.filter((r) => r.id.startsWith(p));
      return hits.length === 1 ? hits[0] : null;
    },
    async update(id, patch) {
      return one(await rest(`${MISSIONS_TABLE}?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) }));
    },
    async ran(m, at = now()) {
      return this.update(m.id, { last_run_at: new Date(at).toISOString(), next_run_at: new Date(at + (Number(m.interval_minutes) || 1440) * 60000).toISOString() });
    }
  };
}

export function isMissionCommand(text) {
  return /^\/missions?(?:\s|$)/i.test(String(text || '').trim());
}

export function parseMissionCommand(text) {
  const t = String(text || '').trim().replace(/^\/missions?\s*/i, '');
  const m = /^(add|list|pause|resume|remove|delete)\b\s*([\s\S]*)$/i.exec(t);
  if (!m) return { sub: t ? 'help' : 'list', rest: '' };
  const sub = m[1].toLowerCase() === 'delete' ? 'remove' : m[1].toLowerCase();
  let rest = m[2].trim();
  if (sub !== 'add') return { sub, rest };
  // /mission add world "<goal>": a world mission (lib/sandbox/missions.mjs).
  // /mission add project "<goal>": research, build, test (lib/autonomous/projects.mjs).
  const kindWord = /^(world|project)\s+/i.exec(rest);
  const kind = kindWord ? kindWord[1].toLowerCase() : null;
  if (kind) rest = rest.slice(kindWord[0].length);
  const quoted = /^["“'](.+?)["”']\s*(.*)$/.exec(rest);
  return { sub, ...(kind ? { kind } : {}), goal: quoted ? quoted[1].trim() : rest, schedule: quoted ? quoted[2].trim() : '' };
}

const short = (id) => String(id || '').slice(0, 8);
const when = (iso) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)) : 'never');

export const MISSION_HELP = [
  '### [ MISSIONS ]',
  '- /mission add "<goal>" [hourly | every 6h | daily | weekly]: a standing goal for Autonomous mode (daily by default)',
  '- /mission add world "<goal>" [schedule]: a world mission: PG1 builds and evolves one of its own sandbox worlds (a simulation) on free engines',
  '- /mission add project "<goal>": PG1 researches it, builds it as a draft pull request, runs its tests (and fixes failures), and asks for your review only when all that is done',
  '- /mission list, /mission pause <id>, /mission resume <id>, /mission remove <id>',
  'Missions run only while Autonomous mode is ON, with read-only tasks (feed, engine and integration checks, research notes) on free engines; the daily briefing sums them up.'
].join('\n');

export async function handleMissionCommand({ text, isOperator = false, supUrl, supKey, fetchImpl = globalThis.fetch }) {
  if (isOperator !== true) return { status: 401, reply: '[AGENT] Missions are for the signed-in operator only.' };
  if (!supUrl || !supKey) return { status: 200, reply: 'Missions need the vault (Supabase), which is not configured on this deployment.' };
  const store = createMissionStore({ supUrl, supKey, fetchImpl });
  const cmd = parseMissionCommand(text);
  try {
    if (cmd.sub === 'help') return { status: 200, reply: MISSION_HELP };
    if (cmd.sub === 'add') {
      if (!cmd.goal || cmd.goal.length < 3) return { status: 200, reply: 'Give the mission a goal, e.g. /mission add "keep the CVE feed healthy" daily.' };
      let m;
      try {
        m = await store.add({ goal: cmd.goal, schedule: cmd.schedule, kind: cmd.kind || 'standard' });
      } catch (e) {
        if ((cmd.kind === 'world' || cmd.kind === 'project') && e && e.status === 400) return { status: 200, reply: `${cmd.kind === 'world' ? 'World missions' : 'Projects'} need the sandbox migration (supabase/migrations/20261110120000_pg1_sandbox.sql), which has not been run yet.` };
        throw e;
      }
      if (cmd.kind === 'project') return { status: 200, reply: `Project ${short(m.id)} added: "${m.goal}". While Autonomous mode is ON (/auto on), PG1 researches it, builds it as a draft pull request, runs its tests and fixes failures, on free engines only. You'll be asked once, for review, when it's done. Nothing is merged or deployed.` };
      return { status: 200, reply: `${cmd.kind === 'world' ? 'World mission' : 'Mission'} ${short(m.id)} added: "${m.goal}" (${m.schedule}). It runs only while Autonomous mode is ON (/auto on)${cmd.kind === 'world' ? '; it builds and evolves one of PG1\'s own worlds, a simulation, on free engines only' : ''}.` };
    }
    if (cmd.sub === 'list') {
      const rows = await store.list();
      if (!rows.length) return { status: 200, reply: 'No missions yet. Add one with /mission add "<goal>" daily.' };
      return { status: 200, reply: ['### [ MISSIONS ]', ...rows.map((m) => `- ${short(m.id)} · ${m.status} · ${m.schedule} · "${m.goal}" · last run ${when(m.last_run_at)}${m.status === 'active' ? ` · next ${when(m.next_run_at)}` : ''}`)].join('\n') };
    }
    const m = await store.find(cmd.rest);
    if (!m) return { status: 200, reply: `No single mission matches "${scrub(cmd.rest, 20)}". /mission list shows the ids.` };
    if (cmd.sub === 'pause') { await store.update(m.id, { status: 'paused' }); return { status: 200, reply: `Mission ${short(m.id)} paused.` }; }
    if (cmd.sub === 'resume') { await store.update(m.id, { status: 'active', next_run_at: new Date().toISOString() }); return { status: 200, reply: `Mission ${short(m.id)} resumed.` }; }
    if (cmd.sub === 'remove') { await store.update(m.id, { status: 'removed' }); return { status: 200, reply: `Mission ${short(m.id)} removed.` }; }
    return { status: 200, reply: MISSION_HELP };
  } catch (e) {
    return { status: 200, reply: e && e.status === 404 ? 'Missions are not set up on this deployment yet (supabase/migrations/20261105120000_pg1_missions.sql).' : 'Missions could not be reached right now.' };
  }
}
