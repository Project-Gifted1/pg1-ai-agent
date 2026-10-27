// /sandbox retemplate <world-id> <template> [--name "<new name>"] [confirm]:
// gives one of PG1's worlds a new start from a template, keeping its id.
//
//   without confirm   describes the change; nothing changes
//   with confirm      replaces the world's spec and state with the
//                     template's, resets its tick to 0, and renames it if
//                     asked. One record on the black box long chain says
//                     who, when, and the old and new template; the world's
//                     earlier black box records stay.
//
// PG1's own worlds only, never a blind copy, and never PG1's oldest world
// (its first universe: "use /sandbox upgrade instead"). Worlds are
// simulations, and the replies say so.

import { initialState, specBytes, SANDBOX_LIMITS } from './engine.mjs';
import { templateSpec, TEMPLATE_NAMES } from './templates.mjs';
import { record as recordBlackbox, agentAction, summaryRow } from './blackbox.mjs';
import { pg1Principal } from './worlds.mjs';
import { PG1_OWNER } from './store.mjs';

const ID_RE = /^[0-9a-f-]{36}$/i;
export const FIRST_UNIVERSE_RETEMPLATE = 'this is your first universe; use /sandbox upgrade instead';

// PG1's oldest world by created_at (blind copies are not worlds of its own).
export async function oldestPg1World(store) {
  const mine = (await store.listWorlds({ owner: PG1_OWNER })).filter((w) => w.owner === PG1_OWNER && !w.blind);
  return mine.sort((a, b) => (String(a.created_at) < String(b.created_at) ? -1 : String(a.created_at) > String(b.created_at) ? 1 : (a.id < b.id ? -1 : 1)))[0] || null;
}

// The template a world was made from, as its black box first recorded it
// (or as a later retemplate did), or null.
async function templateOf(store, worldId) {
  if (typeof store.listBlackbox !== 'function') return null;
  const rows = await store.listBlackbox(worldId, { chain: 'long', limit: 2000 });
  const last = rows.find((r) => r.action === 'retemplate_world' && r.detail && r.detail.new_template);
  if (last) return last.detail.new_template;
  const made = rows.filter((r) => r.action === 'create_world').pop();
  return made && made.detail && made.detail.template ? made.detail.template : null;
}

export function parseRetemplate(rest) {
  const name = /--name\s+["“]([^"”]{1,80})["”]/i.exec(rest);
  const words = String(rest || '').replace(/--name\s+["“][^"”]*["”]/i, ' ').trim().split(/\s+/).filter(Boolean);
  return { id: (words[0] || '').toLowerCase(), template: (words[1] || '').toLowerCase(), name: name ? name[1].trim() : null, confirm: words.slice(2).some((x) => x.toLowerCase() === 'confirm') };
}

// { status, reply, retemplated? } for the chat.
export async function sandboxRetemplateCommand(store, rest, { who = 'operator', now = () => Date.now() } = {}) {
  const a = parseRetemplate(rest);
  const usage = `Usage: /sandbox retemplate <world-id> <template> [--name "<new name>"] [confirm]. Templates: ${TEMPLATE_NAMES.join(', ')}.`;
  if (!ID_RE.test(a.id) || !a.template) return { status: 200, reply: usage };
  if (!TEMPLATE_NAMES.includes(a.template)) return { status: 200, reply: `There is no template "${a.template}". ${usage}` };
  const w = await store.getWorld(a.id);
  if (!w || w.owner !== PG1_OWNER) return { status: 200, reply: 'No PG1 world has that id. Only PG1\'s own worlds can be given a new template.' };
  if (w.blind) return { status: 200, reply: 'That world is a blind run\'s copy (SIMULATION — blind experiment). It is not changed.' };
  const oldest = await oldestPg1World(store);
  if (oldest && oldest.id === w.id) return { status: 200, reply: `Not changed: ${FIRST_UNIVERSE_RETEMPLATE}.` };
  const spec = templateSpec(a.template);
  if (specBytes(spec) > SANDBOX_LIMITS.specBytes) return { status: 200, reply: 'That template is too large for a world.' };
  const name = (a.name || w.name).slice(0, 80);
  const from = (await templateOf(store, w.id)) || 'unknown';
  const what = `**${w.name}** (Simulation, \`${w.id}\`, tick ${Number(w.tick) || 0}, from the ${from} template) would start again from the **${a.template}** template${name !== w.name ? `, renamed "${name}"` : ''}: ${spec.entities.length} things, tick 0. Its id and its black box records are kept; everything else in it is replaced.`;
  if (!a.confirm) return { status: 200, reply: `${what}\nNothing has changed yet. To do it, repeat the command with confirm:\n\`/sandbox retemplate ${w.id} ${a.template}${a.name ? ` --name "${a.name}"` : ''} confirm\`` };
  // The day in progress is summarised first, so the old world's routine is not lost.
  const pending = w.state && w.state.blackbox_day;
  await store.updateWorld(w.id, { spec, state: initialState(spec), tick: 0, name });
  await recordBlackbox(store, w.id, [
    ...(pending ? [summaryRow(pending, (w.spec && w.spec.day_steps) || 240)] : []),
    agentAction(pg1Principal(), 'retemplate_world', { who, when: new Date(now()).toISOString(), old_template: from, new_template: a.template, old_name: w.name, new_name: name, old_tick: Number(w.tick) || 0 }, 0)
  ]);
  return { status: 200, retemplated: true, reply: `Done: **${name}** (Simulation, \`${w.id}\`) now starts from the ${a.template} template at tick 0, with ${spec.entities.length} things. The change is on its black box long chain, and its earlier records are kept.` };
}
