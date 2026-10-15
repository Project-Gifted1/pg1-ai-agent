// Watches in the chat (signed-in operator only).
//
//   /watch  or  /watch list      the open watches
//   /watch stop <id>             stops one (the 8-character id from the list)
//   /watch lab <id>              a lab experiment
//   /watch pr <owner/repo#n | PR URL>
//   /watch run <owner/repo@id | run URL>
//   /watch deploy <dpl_...>
//   "watch it", "monitor it", "tell me when it's done", "let me know when
//   it finishes" (typed or spoken): a watch on the thing just discussed —
//   the newest lab experiment, PR, workflow run or deploy named in this
//   message or the recent conversation. Nothing found: PG1 says so and
//   asks which one; it never claims to be watching.
//
// Every reply here says what really happened: "Watching ..." only after
// the watch row was written.

import { createWatchStore, cleanThreadKey } from './store.mjs';
import { prTarget, runTarget, targetLabel, isTerminal, validTarget } from './targets.mjs';
import { authorize, autonomyMode } from '../autonomy.mjs';
import { vapidKeys } from './push.mjs';

export function isWatchCommand(text) {
  return /^\/watch(?:\s|$)/i.test(String(text || '').trim());
}

const WATCH_PHRASE_RE = /^(?:(?:hey|ok|okay)\s+)?(?:pg ?1[,:]?\s+)?(?:please\s+|can you\s+|could you\s+|would you\s+)?(?:watch|monitor|track|keep (?:an )?eye on|keep watching|follow)\s+(?:it|that|this|the (?:experiment|run|deploy(?:ment)?|pr|pull request|build|lab(?: experiment)?))(?:\s+for me)?(?:\s+please)?$|^(?:(?:hey|ok|okay)\s+)?(?:pg ?1[,:]?\s+)?(?:please\s+)?(?:tell|let|ping|notify|alert)\s+me\s+(?:know\s+)?when\s+(?:it|that|this|the (?:experiment|run|deploy(?:ment)?|pr|pull request|build|lab(?: experiment)?))(?:'s|\s+is|\s+has)?\s+(?:done|finished|finishes|complete|completed|ready|live|merged|over|deployed|through)(?:\s+please)?$/;

// "watch it", "tell me when it's done": a short request about the thing
// just discussed. Pure.
export function isWatchRequest(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[“”"]/g, '').replace(/[’]/g, "'").replace(/[.!?,]+$/g, '').replace(/\s+/g, ' ');
  if (!t || t.startsWith('/') || t.split(' ').length > 14) return false;
  return WATCH_PHRASE_RE.test(t);
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const REFS = [
  { type: 'pr', re: /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g, id: (m) => prTarget(m[1], m[2]) },
  { type: 'pr', re: /\b([\w.-]+\/[\w.-]+)#(\d{1,9})\b/g, id: (m) => prTarget(m[1], m[2]) },
  { type: 'workflow_run', re: /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)/g, id: (m) => runTarget(m[1], m[2]) },
  { type: 'deploy', re: /\b(dpl_[A-Za-z0-9]{6,64})\b/g, id: (m) => m[1] },
  { type: 'lab', re: new RegExp(`\\b(${UUID})\\b`, 'gi'), id: (m) => m[1].toLowerCase(), labFull: true },
  { type: 'lab', re: /\b(?:lab experiment|experiment|lab report|lab stop|LAB|lab)\s+([0-9a-f]{8})\b/gi, id: (m) => m[1].toLowerCase(), labPrefix: true }
];

// The things a text names, in the order they appear.
export function referencesIn(text) {
  const t = String(text || '');
  const found = [];
  for (const r of REFS) {
    r.re.lastIndex = 0;
    let m;
    while ((m = r.re.exec(t))) found.push({ type: r.type, id: r.id(m), at: m.index, labPrefix: !!r.labPrefix });
  }
  return found.sort((a, b) => a.at - b.at);
}

// The newest thing discussed: this message first, then the recent
// conversation newest first (the last few messages only). Pure.
export function subjectFrom({ text = '', history = [] } = {}) {
  const fromText = referencesIn(text);
  if (fromText.length) return fromText[fromText.length - 1];
  const recent = (Array.isArray(history) ? history : []).slice(-8).reverse();
  for (const m of recent) {
    const refs = referencesIn(m && m.text);
    if (refs.length) return refs[refs.length - 1];
  }
  return null;
}

// An explicit /watch <kind> <target>.
export function parseWatchTarget(args) {
  const m = /^(lab|experiment|pr|run|workflow|deploy|deployment)\s+(\S+)$/i.exec(String(args || '').trim());
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const ref = referencesIn(kind === 'lab' || kind === 'experiment' ? `lab ${m[2]}` : m[2]).find((r) => (
    kind === 'lab' || kind === 'experiment' ? r.type === 'lab' : kind === 'pr' ? r.type === 'pr' : kind === 'deploy' || kind === 'deployment' ? r.type === 'deploy' : r.type === 'workflow_run'
  ));
  return ref || null;
}

const fmtWhen = (iso) => String(iso || '').replace('T', ' ').slice(0, 16) + ' UTC';

export const WATCH_HELP_TEXT = [
  '### [ WATCH ]',
  '- Say **watch it**, **monitor it** or **tell me when it\'s done** after a lab experiment, PR, workflow run or deploy comes up: PG1 watches it and reports here when it finishes (with a push notification to devices that turned them on)',
  '- **/watch list**: the open watches',
  '- **/watch stop** <id>: stops one',
  '- **/watch lab** <id>, **/watch pr** <owner/repo#n or URL>, **/watch run** <run URL>, **/watch deploy** <dpl_...>',
  'Lab starts, PRs PG1 opens and production deploys are watched automatically. Reports stop while PG1_AUTONOMY=off.'
].join('\n');

async function pushLine(store, env) {
  if (!vapidKeys(env)) return 'Push notifications are not set up on this deployment (VAPID keys), so the report will only appear here.';
  let n = 0;
  try { n = (await store.subscriptions()).length; } catch (e) { n = 0; }
  return n ? `A push notification goes to ${n} device${n === 1 ? '' : 's'} too.` : 'No device has push notifications on yet: turn them on in the menu (Notifications) to be told even when PG1 is closed.';
}

function heldLine(env) {
  return authorize('watch:report', { actor: 'pg1', mode: autonomyMode(env) }).allowed ? '' : ' Reports are held while PG1_AUTONOMY=off; they go out once it is back on.';
}

// Resolves to { reply, actions? }. Never throws.
export async function handleWatchCommand({ text, history = [], threadKey = null, env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, isOperator = false, now = Date.now() }) {
  if (isOperator !== true) return { reply: 'Watches are for the signed-in operator only.' };
  let store;
  try {
    store = createWatchStore({ supUrl, supKey, fetchImpl });
  } catch (e) {
    return { reply: 'Nothing is being watched: watches need the vault (Supabase), which is not configured on this deployment.' };
  }
  const t = String(text || '').trim();
  const cmd = /^\/watch\b\s*(.*)$/i.exec(t);
  const args = cmd ? cmd[1].trim() : '';
  try {
    if (cmd && (!args || /^list$/i.test(args))) {
      const rows = await store.list({ limit: 20 });
      if (!rows.length) return { reply: `No open watches.${heldLine(env)}\n\n${WATCH_HELP_TEXT}` };
      return { reply: ['### [ WATCHES ]', ...rows.map((w) => `- ${w.id.slice(0, 8)} · ${w.label || targetLabel(w.target_type, w.target_id)} · ${w.target_type}${w.last_state ? ` · last seen ${w.last_state}` : ''} · ${w.source === 'auto' ? 'automatic' : 'asked'} · until ${fmtWhen(w.expires_at)}`), heldLine(env).trim()].filter(Boolean).join('\n') };
    }
    if (cmd && /^help$/i.test(args)) return { reply: WATCH_HELP_TEXT };
    const stop = cmd && /^(?:stop|cancel|remove)\s+(\S+)$/i.exec(args);
    if (stop) {
      const w = await store.get(stop[1]);
      if (!w) return { reply: `There is no watch ${stop[1].slice(0, 36)}. /watch list shows the ids.` };
      if (w.status !== 'open') return { reply: `Watch ${w.id.slice(0, 8)} is already ${w.status}.` };
      const closed = await store.close(w.id, 'stopped', now);
      if (!closed || closed.status !== 'stopped') return { reply: `Watch ${w.id.slice(0, 8)} could not be stopped right now; it is still open.` };
      return { reply: `Stopped watching ${w.label || targetLabel(w.target_type, w.target_id)} (watch ${w.id.slice(0, 8)}). No more reports for it.` };
    }
    const subject = cmd ? parseWatchTarget(args) : subjectFrom({ text: t, history });
    if (!subject) {
      return { reply: cmd
        ? `I did not start a watch: "${args.slice(0, 80)}" is not something I can watch.\n\n${WATCH_HELP_TEXT}`
        : 'I am not watching anything yet: I cannot tell what "it" is, because no lab experiment, PR, workflow run or deploy came up in the last few messages. Say which one, for example `/watch lab <id>` or `/watch pr <PR URL>`.' };
    }
    let type = subject.type;
    let id = subject.id;
    let label = '';
    let lastState = null;
    if (type === 'lab') {
      const { createLabStore } = await import('../lab/store.mjs');
      const exp = await createLabStore({ supUrl, supKey, fetchImpl }).get(id);
      if (!exp) return { reply: `I am not watching anything: there is no lab experiment ${id.slice(0, 8)}. /lab status lists them.` };
      id = exp.id;
      label = `Lab experiment ${id.slice(0, 8)}: ${String(exp.goal || '').slice(0, 60)}`;
      if (isTerminal('lab', exp.status)) return { reply: `Experiment ${id.slice(0, 8)} has already finished (${exp.status}), so there is nothing to watch. /lab report ${id.slice(0, 8)} has its report.`, actions: [] };
      lastState = exp.status;
    }
    if (!validTarget(type, id)) return { reply: 'I did not start a watch: that target id does not look right.' };
    const { watch, created } = await store.create({ type, id, label: label || targetLabel(type, id), originThread: cleanThreadKey(threadKey), source: 'operator', lastState, now });
    const what = watch.label || targetLabel(type, id);
    const when = watch.report_on === 'changes' ? 'its CI finishes and when it is merged or closed' : 'it finishes';
    const head = created ? `Watching ${what} (watch ${watch.id.slice(0, 8)}). I will post a report in this chat when ${when}.` : `Already watching ${what} (watch ${watch.id.slice(0, 8)}); the report comes to this chat when ${when}.`;
    return { reply: `${head} ${await pushLine(store, env)}${heldLine(env)}` };
  } catch (e) {
    console.error(`[watches] command_failed ${e && e.status ? `status=${e.status}` : 'error'}`);
    return { reply: 'I am not watching anything: the watch could not be saved right now. Try again in a minute.' };
  }
}
