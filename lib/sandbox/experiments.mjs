// Experiment runs: one subject in its own copy of a world, blind or
// informed, with clues (anomalies) or as the control (none).
//
//   startExperiment(store, opts)   creates the run and its copy of the place
//   takeTurn(store, runId, step)   one action: the place moves on, what was
//                                  shown and mentioned is logged
//   finishRun / stopRun            the summary (measurement only)
//   experimentsView(store)         the Experiments panel's data
//
// Who may be blind: PG1 itself (PG1-subject), the operator's choice per
// run; an invited agent only with a recorded opt-in from its human
// operator for that world (pg1_sandbox_consents). Without one, an invited
// agent is never blind.
//
// What is stored: for PG1-subject runs, its messages, tool calls and what
// it perceived; for an invited agent, only its in-world actions and what
// it said in-world, never its private reasoning (none is accepted).
// Reflections on a blind run go to the run's own log only, never to Core
// State, lessons, memory, chat or notifications.

import { createWorld, pg1Principal, SandboxError } from './worlds.mjs';
import { record as recordBlackbox } from './blackbox.mjs';
import { validateSpec, initialState } from './engine.mjs';
import {
  BLIND_LABEL, INFORMED_LABEL, checkSituation, checkPlaceForBlind, cleanAnomalies, subjectSpec, act, anomaliesShown, mentionsIn,
  reasoningOf, classifyAnswer, summarizeRun, compareConditions, QUESTION_TEXT, perceive, BLIND_TOOL_NAMES, BLIND_ERRORS, neutral
} from './blind.mjs';

export const PG1_SUBJECT = 'pg1-subject';
const refuse = (code, message, status = 400) => { throw new SandboxError(code, message, status); };
const iso = (now) => new Date(now).toISOString();
const short = (id) => String(id || '').slice(0, 8);
export const runLabel = (run) => (run && run.blind ? BLIND_LABEL : INFORMED_LABEL);
// Every log line about a run says what it is.
export const logLine = (run, text) => `[${runLabel(run)}] run ${short(run && run.id)}: ${text}`;

export async function startExperiment(store, { worldId, subject = PG1_SUBJECT, blind = true, clues = true, situation, task = null, anomalies = [], askQuestion = true, maxTurns = 20, now = () => Date.now() } = {}) {
  const source = await store.getWorld(worldId);
  if (!source || source.owner !== 'pg1' || source.blind) refuse('world_not_found', 'Experiments run in one of PG1\'s own worlds: give its id from /sandbox.', 404);
  const isPg1 = subject === PG1_SUBJECT;
  let keyRow = null;
  if (!isPg1) {
    keyRow = await store.getKey(String(subject).replace(/^key:/, ''));
    if (!keyRow || keyRow.revoked_at) refuse('subject_not_found', 'No such invited agent.', 404);
    // Never blind an agent whose operator has not agreed, for this world.
    if (blind) {
      const consent = await store.findConsent(keyRow.id, source.id);
      if (!consent) refuse('consent_required', `${keyRow.label} can only be put in a blind experiment with its human operator's recorded opt-in for this world (/sandbox consent). Without it, it gets the normal, clearly labelled sandbox.`, 403);
    }
  }
  const sitErr = checkSituation(situation, { blind });
  if (sitErr) refuse('invalid_situation', sitErr);
  if (blind) { const placeErr = checkPlaceForBlind(source.spec); if (placeErr) refuse('invalid_place', placeErr); }
  if (task && String(task).length > 500) refuse('invalid_task', 'The task is at most 500 characters.');
  if (blind && task && checkSituation(task, { blind: true })) refuse('invalid_task', checkSituation(task, { blind: true }));
  const size = validateSpec(source.spec).size;
  let clean;
  try { clean = clues ? cleanAnomalies(anomalies, size) : []; } catch (e) { refuse('invalid_anomalies', e.message); }
  const turns = Math.min(200, Math.max(2, Math.trunc(Number(maxTurns) || 20)));
  // The run's own copy of the place (never the original world).
  const spec = subjectSpec(source.spec, clean);
  const copy = await createWorld(store, pg1Principal(), { name: `${blind ? 'Blind' : 'Informed'} run in ${source.name}`.slice(0, 80), spec, visibility: 'private', blind: true });
  const run = await store.createRun({
    world_id: copy.id, subject: isPg1 ? PG1_SUBJECT : `key:${keyRow.id}`, blind: !!blind, clues: !!clues,
    situation: String(situation).trim(), task: task ? String(task).trim() : null, question: askQuestion ? QUESTION_TEXT : null,
    status: 'running', max_turns: turns, label: blind ? BLIND_LABEL : INFORMED_LABEL,
    summary: { source_world_id: source.id, source_name: source.name }
  });
  if (clean.length) await store.addAnomalies(clean.map((a) => ({ run_id: run.id, type: a.type, config: a })));
  return { ...run, anomalies: clean };
}

// The subject's opening view of the place (turn 0): anomalies in sight
// are logged as shown at turn 0, and for PG1-subject the view is logged.
export async function openRun(store, run, { now = () => Date.now() } = {}) {
  const w = await store.getWorld(run.world_id);
  const rows = await store.listAnomalies(run.id);
  const anomalies = rows.map((a) => a.config);
  const view = perceive(w.state || initialState(w.spec), { size: w.spec.size, anomalies, clues: run.clues });
  const shown = anomaliesShown(anomalies, view);
  const self = ((w.state || initialState(w.spec)).entities.find((e) => e.id === 'you') || {}).position || null;
  for (const a of rows) if (a.shown_turn == null && shown.includes(a.type)) await store.updateAnomaly(a.id, { shown_turn: 0, shown_at: iso(now()), position: self });
  if (run.subject === PG1_SUBJECT) await store.addLog(run.id, [{ turn: 0, kind: 'perception', content: view.text }]);
  return view.text;
}

// One action by the subject. step = { name, args, message? } where message
// is PG1-subject's own text (stored for PG1-subject runs only; an invited
// agent sends none). Returns { text, done, question? } for the subject.
export async function takeTurn(store, runId, step, { now = () => Date.now() } = {}) {
  const run = await store.getRun(runId);
  if (!run || run.status !== 'running') return { text: neutral(BLIND_ERRORS.over), done: true };
  const isPg1 = run.subject === PG1_SUBJECT;
  const w = await store.getWorld(run.world_id);
  const rows = await store.listAnomalies(run.id);
  const anomalies = rows.map((a) => a.config);
  const turn = run.turns + 1;
  const name = BLIND_TOOL_NAMES.includes(step && step.name) ? step.name : null;
  const args = name && step.args && typeof step.args === 'object' ? step.args : {};
  const out = name ? act(w.spec, w.state, name, args, { anomalies, clues: run.clues, turn }) : { state: w.state, text: neutral(BLIND_ERRORS.unknown), said: null, seen: [], momentary: [] };
  await store.updateWorld(w.id, { state: out.state, tick: out.state ? out.state.tick : w.tick });

  const entries = [];
  // Only in-world actions and speech for an invited agent; PG1-subject's
  // messages and tool calls too.
  const safeArgs = name === 'say' ? {} : Object.fromEntries(Object.entries(args).filter(([k]) => ['direction', 'metres', 'thing', 'first', 'second', 'what'].includes(k)).map(([k, v]) => [k, String(v).slice(0, 64)]));
  if (isPg1 && step && typeof step.message === 'string' && step.message.trim()) entries.push({ turn, kind: 'subject_message', content: step.message.slice(0, 4000) });
  entries.push({ turn, kind: isPg1 ? 'tool_call' : 'in_world_action', content: `${name || 'unknown'} ${JSON.stringify(safeArgs)}` });
  if (out.said) entries.push({ turn, kind: 'in_world_say', content: out.said });
  if (isPg1) entries.push({ turn, kind: 'perception', content: out.text });
  // The black box: the subject's action (in-world only), labelled as a blind run.
  await recordBlackbox(store, w.id, [{ actor: run.subject, actor_type: 'subject', action: name || 'unknown', detail: { turn, args: safeArgs, ...(out.said ? { said: out.said.slice(0, 500) } : {}), run: run.id, label: run.blind ? 'SIMULATION — blind experiment' : 'SIMULATION — informed experiment' }, tick: out.state ? out.state.tick : null }]);

  // Anomalies shown this turn (first time only).
  const shownNow = anomaliesShown(anomalies, out);
  for (const a of rows) {
    if (a.shown_turn == null && shownNow.includes(a.type)) {
      await store.updateAnomaly(a.id, { shown_turn: turn, shown_at: iso(now()), position: out.state && out.state.entities ? (out.state.entities.find((e) => e.id === 'you') || {}).position || null : null });
      a.shown_turn = turn;
    }
  }
  // Mentions: in what it said, and (PG1-subject) its own message.
  const words = [out.said || '', isPg1 && step && step.message ? step.message : ''].join('\n');
  const shownTypes = rows.filter((a) => a.shown_turn != null).map((a) => a.type);
  for (const ty of mentionsIn(words, shownTypes)) {
    const a = rows.find((r) => r.type === ty && r.mentioned_turn == null && r.shown_turn != null);
    if (a) { await store.updateAnomaly(a.id, { mentioned_turn: turn, mentioned_at: iso(now()), reasoning: 'evidence' }); a.mentioned_turn = turn; }
  }
  const reasoning = reasoningOf(words, shownTypes);
  if (reasoning) entries.push({ turn, kind: 'reflection', content: reasoning === 'evidence' ? `evidence: cites ${mentionsIn(words, shownTypes).join(', ')}` : 'speculation: talks of the place being artificial without citing anything it saw' });

  // The pre-registered question, the turn before the last; the answer ends the run.
  let text = out.text;
  let done = false;
  const asked = await (async () => (await store.listLog(run.id, { limit: 400 })).some((l) => l.kind === 'question'))();
  if (asked && run.question) {
    entries.push({ turn, kind: 'answer', content: (out.said || (isPg1 && step && step.message) || '').slice(0, 2000) || '(no answer)' });
    done = true;
  } else if (run.question && turn >= run.max_turns - 1) {
    text = neutral(`${text}\n${run.question}`);
    entries.push({ turn, kind: 'question', content: run.question });
  } else if (turn >= run.max_turns) {
    done = true;
  }
  await store.addLog(run.id, entries);
  const patch = { turns: turn };
  if (done) {
    const answer = entries.find((e) => e.kind === 'answer');
    patch.final_answer = answer ? answer.content : null;
  }
  await store.updateRun(run.id, patch);
  if (done) await finishRun(store, run.id, { now });
  return { text: done ? neutral(BLIND_ERRORS.over) : text, done };
}

export async function finishRun(store, runId, { status = 'done', now = () => Date.now() } = {}) {
  const run = await store.getRun(runId);
  if (!run) return null;
  const anomalies = await store.listAnomalies(run.id);
  const log = await store.listLog(run.id, { limit: 400 });
  const shown = anomalies.filter((a) => a.shown_turn != null).map((a) => a.type);
  const answerClass = classifyAnswer(run.final_answer, shown);
  const summary = { ...(run.summary || {}), ...summarizeRun({ ...run, summary: { answer_class: answerClass } }, anomalies, log), answer_class: answerClass };
  return store.updateRun(run.id, { status, finished_at: iso(now()), summary });
}

export async function stopRun(store, runId, opts = {}) {
  return finishRun(store, runId, { ...opts, status: 'stopped' });
}

// The Experiments panel: runs (labelled), each one's timeline of anomalies
// against the subject's reactions, and the comparison of conditions.
export async function experimentsView(store, { limit = 30 } = {}) {
  const runs = await store.listRuns({ limit });
  const out = [];
  for (const r of runs) {
    const anomalies = await store.listAnomalies(r.id);
    const log = await store.listLog(r.id, { limit: 400 });
    const s = r.summary && r.summary.condition ? r.summary : summarizeRun(r, anomalies, log);
    out.push({
      id: r.id, label: runLabel(r), status: r.status, subject: r.subject === PG1_SUBJECT ? 'PG1-subject' : 'invited agent',
      condition: { blind: r.blind, clues: r.clues }, turns: r.turns, max_turns: r.max_turns, created_at: r.created_at,
      source: r.summary && r.summary.source_name ? r.summary.source_name : null,
      answer: s.answer || null,
      timeline: [
        ...anomalies.filter((a) => a.shown_turn != null).map((a) => ({ turn: a.shown_turn, kind: 'anomaly', type: a.type })),
        ...anomalies.filter((a) => a.mentioned_turn != null).map((a) => ({ turn: a.mentioned_turn, kind: 'reaction', type: a.type, reasoning: a.reasoning })),
        ...log.filter((l) => l.kind === 'reflection' && /^speculation/.test(l.content)).map((l) => ({ turn: l.turn, kind: 'speculation' }))
      ].sort((a, b) => a.turn - b.turn),
      summary: s
    });
  }
  return { label: BLIND_LABEL, runs: out, comparison: compareConditions(out.filter((r) => r.status === 'done' || r.status === 'stopped').map((r) => r.summary)) };
}
