// PG1 Studio movies in the chat (api/chat.mjs): /movie and the movie
// proposals in the approve / decline flow. Signed-in operator only.
//
//   /movie "<idea>" [--length N] [--voice "<narrator>"] [--client ["Name"]]
//       creates the movie and queues the screenplay on the render worker
//       (stage movie_script). The worker writes and checks the screenplay,
//       casts every speaking character and proposes MOVIE_SCRIPT.
//   approve MOVIE_SCRIPT (checkpoint a)
//       plans the bibles and the shot list here, by rule (no engine call,
//       nothing spent), prices every stage and proposes MOVIE_BUDGET.
//   approve MOVIE_BUDGET (checkpoint b)
//       the only approval that lets the shoot spend: queues stage movie.
//   /movie retry, /movie retake: MOVIE_RETRY, reusing everything saved.
//
// Every reply goes through sayMovie (white label); engine detail goes to
// pg1_errors only (onFailure).

import { createFilmStore } from '../film/store.mjs';
import { dispatchFilmRender, missingDispatchConfig } from '../film/dispatch.mjs';
import { filmMediaCredit, mediaCreditText, creditCheckEnabled } from '../film/mediaCredit.mjs';
import { fitsCap } from '../film/cost.mjs';
import { filmCard } from '../film/chat.mjs';
import { chosenVoiceCast, OPERATOR_REFUSAL } from '../film/voices.mjs';
import { directorBrief } from '../film/director.mjs';
import { screenplayText } from './screenplay.mjs';
import { planMovie, castLines } from './pipeline.mjs';
import { estimateMovieText } from './cost.mjs';
import { shotListStats } from './coverage.mjs';
import {
  MOVIE_LABEL, MOVIE_KIND, MOVIE_ACTIONS, MOVIE_STAGES, MOVIE_HELP_TEXT, MOVIE_STATUS_LABELS, parseMovieCommand, shortMovieId, sayMovie, usd, movieCapUsd, isMovieProject, movieFailureMessage
} from './text.mjs';

const ACTIVE = new Set(['storyboard_queued', 'storyboarding', 'director_queued', 'directing']);

// The film card, with a movie's own labels and its checks.
export async function movieCard(store, p) {
  const card = await filmCard(store, p);
  card.label = MOVIE_STATUS_LABELS[p.status] || card.label;
  card.kind = MOVIE_KIND;
  if (p.status === 'failed') card.message = movieFailureMessage(p);
  if (p.pending_token && (p.status === 'awaiting_preview_approval' || p.status === 'awaiting_director_approval' || p.status === 'failed')) card.pendingApproval = { token: p.pending_token };
  const d = p.director || {};
  card.movie = { minutes: d.minutes || null, stage: d.stage || null, narration: !!d.narration, gate: d.delivery && d.delivery.gate ? { pass: d.delivery.gate.pass, text: sayMovie(d.delivery.gate.text) } : null };
  // The words on the card in PG1's terms (its signed links stay as they are).
  for (const k of ['label', 'message', 'title']) if (typeof card[k] === 'string') card[k] = sayMovie(card[k]);
  return card;
}

function statusText(p) {
  const d = p.director || {};
  const lines = [`${MOVIE_LABEL} · ${p.title || 'Untitled'} (${shortMovieId(p.id)}) · ${MOVIE_STATUS_LABELS[p.status] || p.status}`];
  if (p.progress && ACTIVE.has(p.status) && p.progress.total) lines.push(`${p.progress.label} (${p.progress.done}/${p.progress.total})`);
  if (p.status === 'failed') lines.push(movieFailureMessage(p));
  if (d.delivery) {
    lines.push(`Runtime ${Math.round(d.delivery.durationS)} s; ${d.delivery.shots.length} shots, ${d.delivery.retakes} retake(s)${d.delivery.flagged.length ? `, still flagged: ${d.delivery.flagged.join(', ')}` : ''}.`);
    if (d.delivery.gate) lines.push(`QC gate: ${d.delivery.gate.pass ? 'passed' : 'needs a look'}${d.delivery.gate.fixedOnce ? ' (fixed and re-rendered once)' : ''}.`, d.delivery.gate.text);
    lines.push(`Deliverables: the master and three stems (dialogue, effects and ambience, score).`);
  }
  // The estimate approved at checkpoint (b), as saved on the movie.
  if (d.estimate) lines.push('Approved cost estimate:', estimateMovieText(d.estimate, { capUsd: Number(p.cap_usd), spentUsd: 0 }));
  lines.push(`Spent ${usd(p.spent_usd)} USD of a ${usd(p.cap_usd)} USD cap.`);
  return sayMovie(lines.join('\n'));
}

async function findMovie(store, id) {
  if (!id) return null;
  if (id.length === 36) { const p = await store.getProject(id); return isMovieProject(p) ? p : null; }
  const list = await store.listProjects(50);
  return list.find((p) => p.id.startsWith(id) && isMovieProject(p)) || null;
}

// Resolves to { reply, filmProject?, pendingApproval? }. Never throws.
export async function handleMovieCommand({ text, env = {}, supUrl, supKey, requestId = null, isOperator = false, fetchImpl = globalThis.fetch, onFailure = () => {} }) {
  if (isOperator !== true) return { status: 401, reply: OPERATOR_REFUSAL };
  const report = (reason, detail) => { try { onFailure({ reason, detail: String(detail || '') }); } catch (e) { /* never breaks the reply */ } };
  const cmd = parseMovieCommand(text);
  if (cmd.sub === 'help') return { reply: MOVIE_HELP_TEXT };
  if (!supUrl || !supKey) return { reply: sayMovie(`${MOVIE_LABEL} needs the vault (Supabase), which is not configured on this deployment.`) };
  const store = createFilmStore({ supUrl, supKey, fetchImpl });
  try {
    if (cmd.sub === 'list') {
      const list = (await store.listProjects(30)).filter(isMovieProject).slice(0, 10);
      if (!list.length) return { reply: sayMovie(`${MOVIE_LABEL} has no movies yet. Start one with /movie "<idea>".`) };
      return { reply: sayMovie(['### [ PG1 STUDIO MOVIES ]', ...list.map((p) => `- ${shortMovieId(p.id)} · ${p.title || 'Untitled'} · ${MOVIE_STATUS_LABELS[p.status] || p.status} · ${usd(p.spent_usd)} USD`)].join('\n')) };
    }
    if (cmd.sub !== 'new') {
      const p = await findMovie(store, cmd.id);
      if (!p) return { reply: sayMovie(`${MOVIE_LABEL} has no movie ${cmd.id || ''}. /movie list shows them.`.replace(/\s+\./, '.')) };
      if (cmd.sub === 'status') {
        const card = await movieCard(store, p);
        // The signed link is added after the white-label pass, byte for byte.
        return { reply: `${statusText(p)}${card.finalUrl ? `\nMaster: ${card.finalUrl}` : ''}`, filmProject: card };
      }
      if (cmd.sub === 'screenplay') return { reply: p.director && p.director.screenplay ? sayMovie(`\`\`\`\n${screenplayText(p.director.screenplay)}\n\`\`\``) : sayMovie('The screenplay is not written yet.') };
      if (cmd.sub === 'retry') return proposeRetry({ store, p, shots: null });
      if (cmd.sub === 'retake') {
        const ids = cmd.rest.split(/[\s,]+/).filter(Boolean);
        const known = new Set(((p.director && p.director.shots) || []).map((s) => s.id));
        const bad = ids.filter((x) => !known.has(x));
        if (!ids.length || bad.length) return { reply: sayMovie(`Name the shots to retake by their ids${bad.length ? ` (unknown: ${bad.join(', ')})` : ''}, for example /movie retake ${shortMovieId(p.id)} s2-d3.`) };
        return proposeRetry({ store, p, shots: ids });
      }
      return { reply: MOVIE_HELP_TEXT };
    }
    // A new movie.
    if (!cmd.idea) return { reply: sayMovie('Give the movie an idea, for example /movie "two rival bakers share an oven on the night of a storm" --length 1.') };
    const missing = missingDispatchConfig(env);
    if (missing.length) { report('movie_not_configured', `missing ${missing.join(', ')}`); return { reply: sayMovie(`${MOVIE_LABEL} is not set up on this deployment yet (its render worker cannot be started). Nothing was spent.`) }; }
    const clientWork = !!cmd.client;
    // Narration only when asked for, and the narrator checked (and, for a
    // client movie, cleared) before anything is created or spent.
    const chosen = await chosenVoiceCast({ query: cmd.voice, env, fetchImpl, clientWork, onFailure: (f) => report(f.reason, f.detail) });
    if (!chosen.ok) return { reply: sayMovie(chosen.reply) };
    // ROUTING POLICY: media credit (and Gemini's monthly spending cap)
    // first, before anything is created or spent (lib/film/mediaCredit.mjs).
    // Operator-only reply: the spend-cap line names where to raise the cap,
    // so it does not go through sayMovie's white-label pass.
    if (creditCheckEnabled(env)) {
      const credit = await filmMediaCredit({ env, clientWork, fetchImpl });
      if (!credit.ok) {
        if (credit.spendCap) report('spend_cap_reached', 'gemini_paid: monthly spending cap reached (pre-movie probe)');
        return { reply: credit.spendCap ? mediaCreditText(credit, MOVIE_LABEL, 'movie') : sayMovie(mediaCreditText(credit, MOVIE_LABEL, 'movie')) };
      }
    }
    const brief = directorBrief(cmd.idea);
    const capUsd = movieCapUsd(env);
    const created = await store.createProject({ request: brief.brief, requestId, tier: 'pro', capUsd, status: 'storyboard_queued' });
    const rows = await store.updateProject(created.id, {
      mode: 'director', client: cmd.client,
      director: { kind: MOVIE_KIND, stage: 'screenplay', minutes: cmd.minutes, narration: !!cmd.voice, notes: brief.notes, approvals: {}, ...(chosen.cast ? { cast: chosen.cast } : {}) }
    });
    const p = rows[0] || created;
    const dsp = await dispatchFilmRender({ env, projectId: p.id, stage: MOVIE_STAGES.script, fetchImpl });
    if (!dsp.ok) {
      report('movie_dispatch_failed', dsp.detail);
      await store.updateProject(p.id, { status: 'failed', error_reason: 'not_configured', error_detail: dsp.detail, failure: { stage: MOVIE_STAGES.script } }).catch(() => {});
      return { reply: sayMovie(`${MOVIE_LABEL} could not start the render worker for movie ${shortMovieId(p.id)}. Nothing was spent.`) };
    }
    const reply = [
      `${MOVIE_LABEL}: movie ${shortMovieId(p.id)}, about ${cmd.minutes} min${cmd.client ? `, for ${cmd.client.name}` : ''}. Writing the screenplay and casting every speaking character now.`,
      cmd.voice ? `Narration on, read by ${chosen.cast.narrator.name}; the characters still carry the story.` : 'No narration: the story is told by the characters on screen.',
      ...brief.notes,
      cmd.client ? 'A client movie: licensed engines only, and only voices cleared for client work.' : '',
      'You approve the screenplay and cast first, then the cost estimate; nothing in the shoot is spent before both.'
    ].filter(Boolean).join('\n');
    return { reply: sayMovie(reply), filmProject: await movieCard(store, { ...p, status: 'storyboard_queued' }) };
  } catch (e) {
    report('movie_command_failed', e && e.message);
    return { reply: sayMovie(`${MOVIE_LABEL} could not do that right now. Request ID: ${requestId || '-'}`) };
  }
}

// A MOVIE_RETRY proposal: a stopped movie from where it stopped, or a new
// take of the named shots. Priced for what is not saved yet.
async function proposeRetry({ store, p, shots }) {
  const sid = shortMovieId(p.id);
  const d = p.director || {};
  const retake = Array.isArray(shots) && shots.length;
  if (!retake && p.status !== 'failed') return { reply: sayMovie(`Movie ${sid} has not stopped (${MOVIE_STATUS_LABELS[p.status] || p.status}), so there is nothing to retry.`) };
  if (retake && (ACTIVE.has(p.status) || !d.approvals || !d.approvals.budget)) return { reply: sayMovie(`Movie ${sid} cannot take a retake now (${MOVIE_STATUS_LABELS[p.status] || p.status}).`) };
  const stage = d.approvals && d.approvals.budget ? MOVIE_STAGES.render : MOVIE_STAGES.script;
  let estText = '';
  let estimateUsd = 0;
  if (stage === MOVIE_STAGES.render) {
    const dd = retake ? { ...d, takes: Object.fromEntries(Object.entries(d.takes || {}).filter(([k]) => !shots.includes(k))) } : d;
    const plan = planMovie(dd);
    estimateUsd = plan.estimate.expectedUsd;
    estText = estimateMovieText(plan.estimate, { capUsd: Number(p.cap_usd), spentUsd: Number(p.spent_usd) });
  }
  const text = sayMovie([
    retake ? `${MOVIE_LABEL}: a new take of ${shots.join(', ')} in movie ${sid}, then the edit and master again. Every other take, the screenplay, the bibles and the cast are kept.` : `${MOVIE_LABEL}: retry movie ${sid} from where it stopped.`,
    !retake ? movieFailureMessage(p).replace(/ Everything already made.*$/, '') : '',
    'Everything saved (screenplay, bibles, cast, accepted takes, sound) is reused, never made or paid for again.',
    estText
  ].filter(Boolean).join('\n'));
  const proposal = await store.createPendingAction({ actionType: MOVIE_ACTIONS.retry, plan: { projectId: p.id, stage, shots: retake ? shots : null, estimateUsd }, diffSummary: text });
  await store.updateProject(p.id, { pending_token: proposal.token }).catch(() => {});
  return { reply: text, pendingApproval: { token: proposal.token, expiresAt: proposal.expiresAt } };
}

// A MOVIE_* pending action, approved or declined. Resolves to { reply,
// filmProject?, pendingApproval?, resolution }. Never throws.
export async function handleMovieApproval({ row, decision, env = {}, supUrl, supKey, isOperator = false, fetchImpl = globalThis.fetch, onFailure = () => {} }) {
  const report = (reason, detail) => { try { onFailure({ reason, detail: String(detail || '') }); } catch (e) { /* never breaks the reply */ } };
  if (isOperator !== true) return { reply: sayMovie('Only the signed-in operator can decide on a movie.'), resolution: null };
  const store = createFilmStore({ supUrl, supKey, fetchImpl });
  const plan = row && row.plan && typeof row.plan === 'object' ? row.plan : {};
  try {
    const p = await store.getProject(plan.projectId);
    if (!p || !isMovieProject(p)) return { reply: sayMovie('That movie no longer exists. Nothing was spent.'), resolution: 'declined' };
    const sid = shortMovieId(p.id);
    const d = p.director;
    if (decision === 'decline') {
      if (row.action_type === MOVIE_ACTIONS.retry) {
        await store.updateProject(p.id, { pending_token: null }).catch(() => {});
        return { reply: sayMovie(`${MOVIE_LABEL}: movie ${sid} was not started again.`), resolution: 'declined' };
      }
      await store.updateProject(p.id, { status: 'cancelled', pending_token: null }, { onlyIfStatus: ['awaiting_preview_approval', 'awaiting_director_approval'] });
      return { reply: sayMovie(`${MOVIE_LABEL}: movie ${sid} cancelled. ${row.action_type === MOVIE_ACTIONS.script ? 'Only the screenplay was spent on.' : 'Nothing in the shoot was spent.'}`), resolution: 'declined' };
    }
    if (ACTIVE.has(p.status)) return { reply: sayMovie(`Movie ${sid} is busy (${MOVIE_STATUS_LABELS[p.status]}). Approve again when it has finished.`), resolution: null };
    const queue = async (stage, fromStatuses, estimateUsd, directorPatch = {}) => {
      if (stage === MOVIE_STAGES.render && !fitsCap({ expectedUsd: Number(estimateUsd) || 0 }, { capUsd: Number(p.cap_usd), spentUsd: Number(p.spent_usd) })) {
        return { reply: sayMovie(`${MOVIE_LABEL}: that would go over movie ${sid}'s cap (${usd(p.spent_usd)} of ${usd(p.cap_usd)} USD spent, about ${usd(estimateUsd)} USD needed; raise PG1_MOVIE_MAX_USD or shorten it). Nothing was started.`), resolution: 'declined' };
      }
      const status = stage === MOVIE_STAGES.script ? 'storyboard_queued' : 'director_queued';
      const rows = await store.updateProject(p.id, { status, pending_token: null, error_reason: null, error_detail: null, director: { ...d, ...directorPatch }, progress: { label: 'Queued', done: 0, total: 1 } }, { onlyIfStatus: fromStatuses });
      if (!rows.length) return { reply: sayMovie(`Movie ${sid} has moved on since this was proposed; nothing was started.`), resolution: 'declined' };
      const dsp = await dispatchFilmRender({ env, projectId: p.id, stage, fetchImpl });
      if (!dsp.ok) {
        report('movie_dispatch_failed', dsp.detail);
        await store.updateProject(p.id, { status: 'failed', error_reason: 'not_configured', error_detail: dsp.detail, failure: { stage } }, { onlyIfStatus: [status] }).catch(() => {});
        return { reply: sayMovie(`${MOVIE_LABEL} could not start the render worker for ${sid}. Nothing was spent.`), resolution: 'approved' };
      }
      return { reply: sayMovie(stage === MOVIE_STAGES.script ? `${MOVIE_LABEL}: writing the screenplay for ${sid} again from where it stopped.` : `${MOVIE_LABEL}: shooting movie ${sid}. Bibles, shots and takes, voices, sound, edit, master and QC; it appears here when it is ready.`), filmProject: await movieCard(store, { ...p, ...rows[0] }), resolution: 'approved' };
    };
    if (row.action_type === MOVIE_ACTIONS.script) {
      // Checkpoint (a) approved: plan and price (free), then checkpoint (b).
      if (p.status !== 'awaiting_preview_approval') return { reply: sayMovie(`Movie ${sid} has moved on since this was proposed.`), resolution: 'declined' };
      const planned = planMovie(d);
      const stats = shotListStats(planned.shots);
      const text = sayMovie([
        `${MOVIE_LABEL}: cost estimate for movie ${sid}, "${planned.sp.title}". Approve it to start the shoot; nothing is spent before you do.`,
        `Shot list: ${stats.shots} shots (${stats.dialogueShots} with dialogue), about ${Math.round(stats.seconds)} s cut, ${stats.averageS} s average shot; ${planned.bibles.characters.length} character bible(s) and ${planned.bibles.locations.length} location(s); look: ${planned.sp.look} (${planned.sp.grade.replace(/_/g, ' ')} grade).`,
        'Per stage:',
        estimateMovieText(planned.estimate, { capUsd: Number(p.cap_usd), spentUsd: Number(p.spent_usd), priceUsd: p.price_usd ? Number(p.price_usd) : null })
      ].join('\n'));
      const proposal = await store.createPendingAction({ actionType: MOVIE_ACTIONS.budget, plan: { projectId: p.id, estimateUsd: planned.estimate.expectedUsd }, diffSummary: text });
      const rows = await store.updateProject(p.id, {
        status: 'awaiting_director_approval', pending_token: proposal.token, est_full_usd: planned.estimate.expectedUsd,
        director: { ...d, stage: 'approve_budget', bibles: planned.bibles, shots: planned.shots, estimate: planned.estimate, approvals: { ...(d.approvals || {}), script: new Date().toISOString() } }
      }, { onlyIfStatus: ['awaiting_preview_approval'] });
      if (!rows.length) return { reply: sayMovie(`Movie ${sid} has moved on since this was proposed.`), resolution: 'declined' };
      return { reply: text, pendingApproval: { token: proposal.token, expiresAt: proposal.expiresAt }, filmProject: await movieCard(store, rows[0]), resolution: 'approved' };
    }
    if (row.action_type === MOVIE_ACTIONS.budget) {
      if (p.status !== 'awaiting_director_approval' || !d.approvals || !d.approvals.script) return { reply: sayMovie(`Movie ${sid} has moved on since this was proposed.`), resolution: 'declined' };
      return queue(MOVIE_STAGES.render, ['awaiting_director_approval'], plan.estimateUsd, { stage: 'render', approvals: { ...d.approvals, budget: new Date().toISOString() } });
    }
    if (row.action_type === MOVIE_ACTIONS.retry) {
      if (plan.shots && plan.shots.length) {
        // A retake the operator asked for: those shots only get new takes.
        const takes = { ...(d.takes || {}) };
        for (const id of plan.shots) takes[id] = { attempts: [], previous: takes[id] ? takes[id].accepted || null : null };
        return queue(MOVIE_STAGES.render, ['done', 'failed'], plan.estimateUsd, { takes, delivered: false });
      }
      if (p.status !== 'failed') return { reply: sayMovie(`Movie ${sid} has moved on since this retry was proposed.`), resolution: 'declined' };
      return queue(plan.stage === MOVIE_STAGES.script ? MOVIE_STAGES.script : MOVIE_STAGES.render, ['failed'], plan.estimateUsd);
    }
    return { reply: sayMovie('Unknown movie proposal.'), resolution: 'declined' };
  } catch (e) {
    report('movie_approval_failed', e && e.message);
    return { reply: sayMovie(`${MOVIE_LABEL} could not act on that approval right now; it is still pending.`), resolution: null };
  }
}

export { castLines };
