// PG1 Sound in the chat (api/chat.mjs): the /music commands, the track
// card's status action (MUSIC_STATUS), the media library, and the music
// proposals in the approve / decline flow (MUSIC_FINAL, MUSIC_EDIT,
// MUSIC_RETRY in pending_actions).
//
// Signed-in operator only: guests and customers never reach an engine,
// the vault or the approvals from here (and api/chat.mjs already answers
// every slash command from a non-operator with a 401).
//
// Every request and edit goes through the safety pre-filter
// (lib/music/safety.mjs) before anything is stored, charged or dispatched.
// Nothing here calls a music engine: stages are queued on the track's row
// and dispatched to the render worker on GitHub Actions.
//
// White-label: replies and cards say PG1 Sound. The track's provider,
// model and licence note appear only in /music status (the operator's own
// reply text) and in the export README; never in the card, the library or
// anything the page keeps.

import { createMusicStore } from './store.mjs';
import { dispatchMusicRender, missingDispatchConfig } from './dispatch.mjs';
import { checkMusicRequest } from './safety.mjs';
import { estimateMusic } from './pipeline.mjs';
import {
  MUSIC_LABEL, MUSIC_HELP_TEXT, MUSIC_STATUS_LABELS, MUSIC_ACTIONS, STAGE_QUEUED, STAGE_WORDS, MUSIC_STAGES, PREVIEW_COUNT,
  parseMusicCommand, parseMusicFlags, trackTitle, fileSlug, specText, shortTrackId, musicIsActive, musicCapUsd, musicFailureMessage, failedMusicStage, usd
} from './text.mjs';

const CHANGE_WORDS = {
  lyrics: () => 'Lyrics: your new lyrics',
  instrumental: () => 'Instrumental',
  vocals: () => 'With vocals',
  bpm: (s) => `BPM: ${s.bpm}`,
  key: (s) => `Key: ${s.key}`,
  length: (s) => `Length: ${s.length}`
};
const OFF = (env) => String(env.PG1_MUSIC_ENABLED || '').trim() === '0';
const VERSIONED = (t) => t.version || 1;

function optionsOf(t) {
  return t && t.options && typeof t.options === 'object' ? t.options : {};
}

// The export's files (pg1_music_assets kind 'stems_zip', told apart by
// meta.part) of the track's current version, in download order.
const PART_ORDER = ['master', 'drums', 'bass', 'vocals', 'other', 'midi', 'readme'];
const PART_LABELS = { master: 'Master (FLAC)', drums: 'Drums stem (FLAC)', bass: 'Bass stem (FLAC)', vocals: 'Vocals stem (FLAC)', other: 'Other stem (FLAC)', readme: 'README' };

export function exportFiles(assets, t) {
  const rows = (assets || []).filter((a) => a.kind === 'stems_zip' && (a.status || 'ok') === 'ok' && (a.version || 1) === VERSIONED(t) && a.meta && typeof a.meta.part === 'string');
  const files = rows.filter((a) => PART_ORDER.includes(a.meta.part))
    .sort((x, y) => PART_ORDER.indexOf(x.meta.part) - PART_ORDER.indexOf(y.meta.part) || String(x.meta.stem || '').localeCompare(String(y.meta.stem || '')));
  return { files, zip: rows.find((a) => a.meta.part === 'zip') || null };
}

// Signed download links for the export: { downloads: [{ part, label, url }],
// zipUrl } or null before an export. PG1 labels only.
async function exportLinks(store, t, assets) {
  const { files, zip } = exportFiles(assets, t);
  if (!files.length && !zip) return null;
  const sign = async (a) => { try { return await store.sign(a.storage_path, { download: String(a.meta.name || '').slice(0, 120) || null }); } catch (e) { return null; } };
  const downloads = [];
  for (const a of files) {
    const label = a.meta.part === 'midi' ? `MIDI: ${String(a.meta.stem || 'melody')}` : PART_LABELS[a.meta.part];
    downloads.push({ part: a.meta.part, label, url: await sign(a) });
  }
  return { downloads, zipUrl: zip ? await sign(zip) : null };
}

// The takes of a track awaiting its choice, in order: { variant, url,
// durationS, token } for one that can still be approved, { variant,
// discarded: true } (no player, no approval) for one that was declined.
// durationS is the stored file's measured length.
export async function musicTakes(store, t, assets) {
  const choices = Array.isArray(t.choices) ? t.choices : [];
  const previews = (assets || []).filter((a) => a.kind === 'preview' && (a.status || 'ok') === 'ok' && (a.version || 1) === VERSIONED(t));
  const out = [];
  for (const a of previews.sort((x, y) => (x.variant || 0) - (y.variant || 0))) {
    const c = choices.find((x) => x.variant === a.variant);
    if (c && c.declined) { out.push({ variant: a.variant, discarded: true }); continue; }
    let url = null;
    try { url = await store.sign(a.storage_path); } catch (e) { url = null; }
    out.push({ variant: a.variant, url, durationS: a.duration_s == null ? null : Number(a.duration_s), token: c ? c.token : null });
  }
  return out;
}

// The length the card's header gives: the master's measured length once
// there is one, else the longest take still on offer; null before either.
function measuredSeconds(t, takes) {
  if (t.master_path && t.duration_s != null) return Number(t.duration_s);
  const lens = (takes || []).filter((p) => !p.discarded && p.durationS > 0).map((p) => p.durationS);
  return lens.length ? Math.max(...lens) : null;
}

const ALL_DISCARDED_LABEL = 'Both takes discarded: change it with /music edit';

// The card the client shows (and polls while the track is busy). No
// provider, model or licence text: those are operator-only reply text.
export async function musicCard(store, t, { assets = null } = {}) {
  const sign = async (p, download = null) => { if (!p) return null; try { return await store.sign(p, download ? { download } : {}); } catch (e) { return null; } };
  const list = assets || (await store.listAssets(t.id).catch(() => []));
  const o = optionsOf(t);
  const takes = t.status === 'awaiting_choice' ? await musicTakes(store, t, list) : null;
  const card = {
    id: t.id,
    shortId: shortTrackId(t.id),
    title: t.title || 'Untitled track',
    status: t.status,
    label: MUSIC_STATUS_LABELS[t.status] || t.status,
    active: musicIsActive(t.status),
    progress: t.progress && typeof t.progress === 'object' ? { label: String(t.progress.label || ''), done: Number(t.progress.done) || 0, total: Number(t.progress.total) || 0 } : null,
    spec: specText({ ...o, lyrics: o.lyrics ? 'yes' : '' }, { durationS: measuredSeconds(t, takes) }),
    spentUsd: Number(t.spent_usd) || 0,
    capUsd: Number(t.cap_usd) || 0,
    durationS: t.duration_s == null ? null : Number(t.duration_s),
    bpm: t.bpm == null ? null : Number(t.bpm),
    key: t.musical_key || null,
    engine: MUSIC_LABEL
  };
  if (takes) {
    card.previews = takes;
    if (takes.length && takes.every((p) => p.discarded)) card.label = ALL_DISCARDED_LABEL;
  }
  if (t.master_path) {
    const ext = String(t.master_path).split('.').pop();
    card.masterUrl = await sign(t.master_path);
    card.masterDownloadUrl = await sign(t.master_path, `${fileSlug(t.title)}.${ext}`);
  }
  const links = await exportLinks(store, t, list);
  if (links) {
    card.downloads = links.downloads;
    if (links.zipUrl) card.zipUrl = links.zipUrl;
  }
  if (t.status === 'failed') {
    card.message = musicFailureMessage(t);
    card.failure = { stage: failedMusicStage(t), reason: t.error_reason || null };
  }
  return card;
}

// One line per track for the library, with a player in the client.
export async function musicLibrary(store, limit = 10) {
  const rows = await store.listTracks(limit);
  const out = [];
  for (const t of rows) {
    let url = null;
    if (t.master_path) { try { url = await store.sign(t.master_path); } catch (e) { url = null; } }
    // Only a finished track can have an export to list.
    const links = t.status === 'done' ? await exportLinks(store, { ...t, version: t.version || 1 }, await store.listAssets(t.id, { kinds: ['stems_zip'] }).catch(() => [])) : null;
    // A track awaiting its choice lists its takes, declined ones as discarded.
    const takes = t.status === 'awaiting_choice' ? await musicTakes(store, t, await store.listAssets(t.id, { kinds: ['preview'] }).catch(() => [])) : null;
    const allDiscarded = !!(takes && takes.length && takes.every((p) => p.discarded));
    out.push({
      id: t.id, shortId: shortTrackId(t.id), title: t.title || 'Untitled track', status: t.status, label: allDiscarded ? ALL_DISCARDED_LABEL : MUSIC_STATUS_LABELS[t.status] || t.status,
      url, ...(takes ? { previews: takes } : {}), ...(links ? { downloads: links.downloads, zipUrl: links.zipUrl } : {}), durationS: t.duration_s == null ? null : Number(t.duration_s), bpm: t.bpm == null ? null : Number(t.bpm), key: t.musical_key || null,
      spentUsd: Number(t.spent_usd) || 0
    });
  }
  return out;
}

function statusReply(t, card) {
  const lines = [`${MUSIC_LABEL} · ${card.title} (${card.shortId}) · ${card.label}`, `${card.spec}.`];
  if (card.progress && card.active && card.progress.total) lines.push(`${card.progress.label} (${card.progress.done}/${card.progress.total})`);
  if (card.message) lines.push(card.message);
  if (card.bpm || card.key) lines.push(`Detected: ${card.bpm ? `${Math.round(card.bpm * 10) / 10} BPM` : ''}${card.bpm && card.key ? ', ' : ''}${card.key || ''}.`);
  // Operator-only: the engine and its terms (lib/music/engines.mjs LICENCE_NOTES).
  if (t.provider || t.licence_note) lines.push(`Licence (operator only): ${t.licence_note || 'unknown'}${t.provider ? ` [${t.provider}${t.model ? ` / ${t.model}` : ''}]` : ''}. No exclusive copyright is claimed.`);
  lines.push(`Spent ${usd(card.spentUsd)} USD of a ${usd(card.capUsd)} USD cap.`);
  return lines.join('\n');
}

function libraryReply(items) {
  if (!items.length) return `No ${MUSIC_LABEL} tracks yet. Start one with /music plus a description (genre, mood, instruments, era).`;
  return [`### [ ${MUSIC_LABEL.toUpperCase()} LIBRARY ]`, ...items.map((i) => `- ${i.shortId} · ${i.title} · ${i.label}${i.durationS ? ` · ${Math.floor(i.durationS)} s` : ''}${i.previews ? ` · ${i.previews.map((p) => `take ${p.variant}${p.discarded ? ' discarded' : ''}`).join(', ')}` : ''}${i.bpm ? ` · ${Math.round(i.bpm)} BPM` : ''}${i.key ? ` · ${i.key}` : ''}${i.downloads ? ` · stems ready${i.zipUrl ? ' (zip too)' : ''}` : ''}`)].join('\n');
}

// --- commands --------------------------------------------------------------------------

// Resolves to the JSON body for the chat reply: { reply, musicTrack?,
// musicLibrary?, pendingApproval? }. Never throws.
export async function handleMusicCommand({ text, env = {}, supUrl, supKey, requestId = null, isOperator = false, fetchImpl = globalThis.fetch, onFailure = () => {} }) {
  if (isOperator !== true) return { reply: `${MUSIC_LABEL} is for the signed-in operator only.` };
  const cmd = parseMusicCommand(text);
  if (cmd.sub === 'help') return { reply: MUSIC_HELP_TEXT };
  if (OFF(env)) return { reply: 'Music generation is switched off.' };
  const report = (reason, detail) => { try { onFailure({ reason, detail: String(detail || '') }); } catch (e) { /* never breaks the reply */ } };

  // The safety pre-filter runs before anything else, including the vault.
  let parsed = null;
  if (cmd.sub === 'new') {
    parsed = parseMusicFlags(cmd.rest);
    if (!parsed.ok) return { reply: parsed.message };
    if (!parsed.prompt) return { reply: 'Describe the track: genre, mood, instruments, era (for example: /music dusty boom-bap beat, vinyl crackle, jazzy piano --instrumental --bpm 88).' };
    const safe = checkMusicRequest({ prompt: parsed.prompt, lyrics: parsed.spec.lyrics, env });
    if (!safe.ok) return { reply: safe.message, refused: safe.reason };
  }
  if (!supUrl || !supKey) return { reply: `${MUSIC_LABEL} needs the vault (Supabase), which is not configured on this deployment.` };
  try {
    const store = createMusicStore({ supUrl, supKey, fetchImpl });
    if (cmd.sub === 'new') {
      const missing = missingDispatchConfig(env);
      if (missing.length) {
        report('music_not_configured', `missing ${missing.join(', ')}`);
        return { reply: `${MUSIC_LABEL} is not set up on this deployment yet (its render worker cannot be started). Nothing was spent.` };
      }
      const capUsd = musicCapUsd(env);
      const previewUsd = estimateMusic(env, 'preview');
      const t = await store.createTrack({ prompt: parsed.prompt, title: trackTitle(parsed.prompt), options: parsed.spec, requestId, capUsd });
      const d = await dispatchMusicRender({ env, trackId: t.id, stage: 'preview', fetchImpl });
      if (!d.ok) {
        report('music_dispatch_failed', d.detail);
        await store.updateTrack(t.id, { status: 'failed', error_reason: 'not_configured', error_detail: d.detail, failure: { stage: 'preview' } }).catch(() => {});
        return { reply: `${MUSIC_LABEL} could not start the previews (the render worker did not answer). Nothing was spent. Request ID: ${requestId || '-'}` };
      }
      return {
        reply: `${MUSIC_LABEL} is making ${PREVIEW_COUNT} previews of "${t.title}" (${shortTrackId(t.id)}; ${specText(parsed.spec)}), about ${usd(previewUsd)} USD. Approve the take you want and it is rendered in full. Spending cap for this track: ${usd(capUsd)} USD.`,
        musicTrack: await musicCard(store, t, { assets: [] })
      };
    }
    if (cmd.sub === 'list') {
      const items = await musicLibrary(store, 10);
      return { reply: libraryReply(items), musicLibrary: items };
    }
    if (!cmd.id) return { reply: `Which track? Give its id, e.g. /music ${cmd.sub} 1a2b3c4d (see /music list).` };
    const t = await store.getTrack(cmd.id);
    if (!t) return { reply: `No track has the id ${cmd.id}.` };
    const sid = shortTrackId(t.id);

    if (cmd.sub === 'status') {
      const card = await musicCard(store, t);
      return { reply: statusReply(t, card), musicTrack: card };
    }
    if (musicIsActive(t.status)) return { reply: `Track ${sid} is busy (${MUSIC_STATUS_LABELS[t.status]}). Try again when it has finished.`, musicTrack: await musicCard(store, t) };

    if (cmd.sub === 'export') {
      if (!t.master_path || t.status !== 'done') return { reply: `Track ${sid} has no final render yet (${MUSIC_STATUS_LABELS[t.status] || t.status}). Approve a take first, then export it.` };
      const assets = await store.listAssets(t.id);
      if (exportFiles(assets, t).files.length) {
        return { reply: `${MUSIC_LABEL}: the stems for ${sid} are already in the media library.`, musicTrack: await musicCard(store, t, { assets }) };
      }
      return queueStage({ store, t, stage: 'export', env, fetchImpl, report, from: ['done'], reply: `${MUSIC_LABEL} is exporting "${t.title}" (${sid}): the master and the drums, bass, vocals and other stems as FLAC (lossless), MIDI for the melodic stems and a README with BPM, key and licence, each as its own download, plus ${fileSlug(t.title)}_stems.zip when it fits the storage limit. It appears here when it is ready. No engine spend.` });
    }
    if (cmd.sub === 'retry') return proposeRetry({ store, t, env });
    if (cmd.sub === 'edit') {
      if (!cmd.rest) return { reply: `Say what to change, e.g. /music edit ${sid} slower, add warm strings --bpm 80.` };
      const f = parseMusicFlags(cmd.rest, optionsOf(t));
      if (!f.ok) return { reply: f.message };
      const prompt = f.prompt ? `${t.prompt}. Changes: ${f.prompt}` : t.prompt;
      const safe = checkMusicRequest({ prompt, lyrics: f.spec.lyrics, env });
      if (!safe.ok) return { reply: safe.message, refused: safe.reason };
      if (!['awaiting_choice', 'done', 'failed', 'cancelled'].includes(t.status)) return { reply: `Track ${sid} cannot be changed right now (${MUSIC_STATUS_LABELS[t.status] || t.status}).` };
      const est = estimateMusic(env, 'preview');
      const summary = [
        `${MUSIC_LABEL}: change "${t.title}" (${sid}), version ${VERSIONED(t)} → ${VERSIONED(t) + 1}.`,
        ...(f.prompt ? [`- Description: ${f.prompt}`] : []),
        ...f.set.map((k) => `- ${CHANGE_WORDS[k] ? CHANGE_WORDS[k](f.spec) : k}`),
        `Now: ${specText(f.spec)}.`,
        `Approving makes ${PREVIEW_COUNT} new previews (about ${usd(est)} USD); the current track stays in the library until a new take is approved. Spent ${usd(t.spent_usd)} of a ${usd(t.cap_usd)} USD cap.`
      ].join('\n');
      const proposal = await store.createPendingAction({ actionType: MUSIC_ACTIONS.edit, plan: { trackId: t.id, baseVersion: VERSIONED(t), prompt, options: f.spec, estimateUsd: est }, diffSummary: summary });
      return { reply: summary, pendingApproval: { token: proposal.token, expiresAt: proposal.expiresAt } };
    }
    return { reply: MUSIC_HELP_TEXT };
  } catch (e) {
    report('music_command_failed', e && e.message);
    return { reply: `${MUSIC_LABEL} could not do that right now. Request ID: ${requestId || '-'}` };
  }
}

// Queues a stage and starts the worker. Resolves to a reply body.
async function queueStage({ store, t, stage, env, fetchImpl, report, from, reply, patch = {} }) {
  const rows = await store.updateTrack(t.id, { ...patch, status: STAGE_QUEUED[stage], error_reason: null, error_detail: null, failure: null, progress: { label: 'Queued', done: 0, total: 1 } }, { onlyIfStatus: from });
  if (!rows.length) return { reply: `Track ${shortTrackId(t.id)} has moved on; nothing was started.`, resolution: 'declined' };
  const d = await dispatchMusicRender({ env, trackId: t.id, stage, fetchImpl });
  if (!d.ok) {
    report('music_dispatch_failed', d.detail);
    await store.updateTrack(t.id, { status: 'failed', error_reason: 'not_configured', error_detail: d.detail, failure: { stage } }, { onlyIfStatus: [STAGE_QUEUED[stage]] }).catch(() => {});
    return { reply: `${MUSIC_LABEL} could not start the render worker for ${shortTrackId(t.id)}. Nothing was spent.`, resolution: 'approved' };
  }
  return { reply, musicTrack: await musicCard(store, rows[0]), resolution: 'approved' };
}

// A MUSIC_RETRY proposal: the stage that stopped, again.
async function proposeRetry({ store, t, env }) {
  const sid = shortTrackId(t.id);
  if (t.status !== 'failed') return { reply: `Track ${sid} has not stopped (${MUSIC_STATUS_LABELS[t.status] || t.status}), so there is nothing to retry.`, musicTrack: await musicCard(store, t) };
  const stage = failedMusicStage(t);
  const est = estimateMusic(env, stage, optionsOf(t).length);
  const text = [
    `${MUSIC_LABEL}: retry "${t.title}" (${sid}) from ${STAGE_WORDS[stage]}, where it stopped.`,
    musicFailureMessage(t).replace(/ Everything already made is kept;.*$/, ''),
    stage === 'export' ? 'The final track is kept; only the export runs again (no engine spend).' : `About ${usd(est)} USD. Spent ${usd(t.spent_usd)} of a ${usd(t.cap_usd)} USD cap.`
  ].join('\n');
  const proposal = await store.createPendingAction({ actionType: MUSIC_ACTIONS.retry, plan: { trackId: t.id, stage, version: VERSIONED(t), estimateUsd: est }, diffSummary: text });
  return { reply: text, pendingApproval: { token: proposal.token, expiresAt: proposal.expiresAt }, musicTrack: await musicCard(store, t) };
}

// A declined "use take N": the take is marked declined on the track's
// choices, so the card and the library show it as discarded (no player, no
// approval) and only the other take stays approvable. The updated card
// goes back with the reply.
async function declineTake({ store, t, plan, sid }) {
  if (t.status !== 'awaiting_choice' || plan.version !== VERSIONED(t)) return { reply: `${MUSIC_LABEL}: take ${plan.variant} of ${sid} discarded.`, resolution: 'declined' };
  const choices = (Array.isArray(t.choices) ? t.choices : []).map((c) => (c.variant === plan.variant ? { ...c, declined: true } : c));
  const rows = await store.updateTrack(t.id, { choices }, { onlyIfStatus: ['awaiting_choice'] }).catch(() => []);
  const fresh = rows[0] || { ...t, choices };
  const left = choices.filter((c) => !c.declined);
  const next = left.length ? ` Approve take ${left.map((c) => c.variant).join(' or ')}, or change it with /music edit ${sid}.` : ` No take is left to approve; change it with /music edit ${sid}.`;
  return { reply: `${MUSIC_LABEL}: take ${plan.variant} of ${sid} discarded.${next}`, musicTrack: await musicCard(store, fresh), resolution: 'declined' };
}

// --- the card's status action -------------------------------------------------------------

export async function musicStatusAction({ id, supUrl, supKey, fetchImpl = globalThis.fetch }) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return { musicTrack: { id: String(id || '').slice(0, 64), status: 'not_found' } };
  const store = createMusicStore({ supUrl, supKey, fetchImpl });
  const t = await store.getTrack(id);
  if (!t) return { musicTrack: { id, status: 'not_found' } };
  return { musicTrack: await musicCard(store, t) };
}

// --- approve / decline -----------------------------------------------------------------

// A pending_actions row of a MUSIC_* type, approved or declined. Resolves
// to { reply, musicTrack?, resolution: 'approved' | 'declined' | null }.
// Never throws.
export async function handleMusicApproval({ row, decision, env = {}, supUrl, supKey, isOperator = false, fetchImpl = globalThis.fetch, onFailure = () => {} }) {
  if (isOperator !== true) return { reply: `${MUSIC_LABEL} is for the signed-in operator only.`, resolution: null };
  const plan = row && row.plan && typeof row.plan === 'object' ? row.plan : {};
  const report = (reason, detail) => { try { onFailure({ reason, detail: String(detail || '') }); } catch (e) { /* never breaks the reply */ } };
  try {
    const store = createMusicStore({ supUrl, supKey, fetchImpl });
    const t = await store.getTrack(plan.trackId);
    if (!t) return { reply: 'That track no longer exists. Nothing was spent.', resolution: 'declined' };
    const sid = shortTrackId(t.id);
    if (decision === 'decline') {
      if (row.action_type === MUSIC_ACTIONS.final) return declineTake({ store, t, plan, sid });
      if (row.action_type === MUSIC_ACTIONS.retry) return { reply: `${MUSIC_LABEL}: track ${sid} was not restarted; it stays stopped.`, resolution: 'declined' };
      return { reply: `${MUSIC_LABEL}: change discarded; track ${sid} is unchanged.`, resolution: 'declined' };
    }
    // A take offered for an earlier state of the track is closed, even while it renders.
    if (row.action_type === MUSIC_ACTIONS.final && (t.status !== 'awaiting_choice' || plan.version !== VERSIONED(t))) return { reply: `Track ${sid} has moved on since this take was offered; nothing was started.`, resolution: 'declined' };
    if (musicIsActive(t.status)) return { reply: `Track ${sid} is busy (${MUSIC_STATUS_LABELS[t.status]}). Approve again when it has finished.`, resolution: null };
    const fits = (estimateUsd) => (Number(estimateUsd) || 0) <= Number(t.cap_usd) - Number(t.spent_usd) + 1e-9;
    const overCap = (estimateUsd) => ({ reply: `${MUSIC_LABEL}: that would go over track ${sid}'s cap (${usd(t.spent_usd)} of ${usd(t.cap_usd)} USD spent, about ${usd(estimateUsd)} USD needed). Nothing was started.`, resolution: 'declined' });

    if (row.action_type === MUSIC_ACTIONS.final) {
      if (!fits(plan.estimateUsd)) return overCap(plan.estimateUsd);
      const others = (Array.isArray(t.choices) ? t.choices : []).filter((c) => c.variant !== plan.variant).map((c) => c.token);
      const r = await queueStage({ store, t, stage: 'final', env, fetchImpl, report, from: ['awaiting_choice'], patch: { chosen_variant: plan.variant }, reply: `${MUSIC_LABEL}: rendering take ${plan.variant} of "${t.title}" (${sid}) in full. It appears here when it is ready.` });
      if (r.resolution === 'approved') await store.resolvePendingActions(others, 'declined').catch(() => {});
      return r;
    }
    if (row.action_type === MUSIC_ACTIONS.retry) {
      if (t.status !== 'failed' || !MUSIC_STAGES.includes(plan.stage) || plan.version !== VERSIONED(t)) return { reply: `Track ${sid} has changed since this retry was proposed. Ask again with /music retry ${sid}.`, resolution: 'declined' };
      if (!fits(plan.estimateUsd)) return overCap(plan.estimateUsd);
      return queueStage({ store, t, stage: plan.stage, env, fetchImpl, report, from: ['failed'], reply: `${MUSIC_LABEL}: ${plan.stage === 'export' ? 'exporting' : plan.stage === 'final' ? 'rendering the final track of' : 'making new previews of'} "${t.title}" (${sid}) again. It appears here when it is ready.` });
    }
    if (row.action_type === MUSIC_ACTIONS.edit) {
      if (plan.baseVersion !== VERSIONED(t)) return { reply: `Track ${sid} has changed since this edit was proposed; nothing was applied.`, resolution: 'declined' };
      // The edit was checked when proposed; checked again in case the
      // filter has changed since.
      const safe = checkMusicRequest({ prompt: plan.prompt, lyrics: plan.options && plan.options.lyrics, env });
      if (!safe.ok) return { reply: safe.message, resolution: 'declined' };
      if (!fits(plan.estimateUsd)) return overCap(plan.estimateUsd);
      const stale = (Array.isArray(t.choices) ? t.choices : []).map((c) => c.token);
      const r = await queueStage({
        store, t, stage: 'preview', env, fetchImpl, report, from: ['awaiting_choice', 'done', 'failed', 'cancelled'],
        patch: { prompt: plan.prompt, options: plan.options, version: VERSIONED(t) + 1, title: t.title, choices: null, chosen_variant: null },
        reply: `${MUSIC_LABEL}: change applied (version ${VERSIONED(t) + 1}); making ${PREVIEW_COUNT} new previews of "${t.title}" (${sid}).`
      });
      if (r.resolution === 'approved') await store.resolvePendingActions(stale, 'declined').catch(() => {});
      return r;
    }
    return { reply: 'Unknown music proposal.', resolution: 'declined' };
  } catch (e) {
    report('music_approval_failed', e && e.message);
    return { reply: `${MUSIC_LABEL} could not act on that approval right now; it is still pending.`, resolution: null };
  }
}
