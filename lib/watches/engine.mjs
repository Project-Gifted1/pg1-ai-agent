// The watch engine: a watched target's new state in, a report out.
//
//   autoWatch(...)         PG1 watching something on its own (lib/watches/
//                          auto.mjs, re-exported here)
//   applySnapshot(...)     one watch and a state just read (a verified
//                          webhook, the lab callback or the re-sync cron).
//                          When the change is worth reporting it claims the
//                          change (a conditional update, so a webhook and
//                          the cron racing write one report, not two),
//                          writes the report for the origin thread, pushes
//                          a notification and closes the watch on an end
//                          state. With PG1_AUTONOMY=off nothing is reported
//                          and the state is not advanced: the report goes
//                          out once autonomy is back on.
//   onTargetState(...)     the same for a target, looking up its open watch
//   resyncWatches(...)     the cron: expires old watches and re-reads every
//                          open one from its source
//
// Every report is built by code (lib/watches/report.mjs) from what was
// read, so it never claims more than happened.

import { authorize, autonomyMode, logAutonomy } from '../autonomy.mjs';
import { createWatchStore } from './store.mjs';
import { autoWatch } from './auto.mjs';
import { isReportable, isTerminal, targetLabel, prTarget } from './targets.mjs';
import { composeReport } from './report.mjs';
import { pushToOperator } from './push.mjs';
import { readPr, readRun, readDeploy } from './sources.mjs';

export { autoWatch };

const nowIso = (now) => new Date(now).toISOString();

// Resolves to { reported, held?, closed?, report? }.
export async function applySnapshot({ env = process.env, store, watch, snapshot, supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now(), webpushImpl = null }) {
  if (!watch || watch.status !== 'open' || !snapshot || !snapshot.state) return { reported: false };
  const state = String(snapshot.state).slice(0, 40);
  if (!isReportable(watch, state)) {
    if (state !== watch.last_state) await store.update(watch.id, { last_state: state, last_checked_at: nowIso(now) }).catch(() => {});
    return { reported: false };
  }
  const mode = autonomyMode(env);
  const d = authorize('watch:report', { actor: 'pg1', mode });
  if (!d.allowed) return { reported: false, held: true };
  // Claim the change: only one caller moves last_state to `state`.
  const claimed = await store.claimState(watch.id, state, now);
  if (!claimed) return { reported: false };
  const report = composeReport(watch, { state, info: snapshot.info || {} });
  const row = await store.addReport({ watch_id: watch.id, origin_thread: watch.origin_thread || null, target_type: watch.target_type, target_id: watch.target_id, state, title: report.title, body: report.body, actions: report.actions });
  const closed = isTerminal(watch.target_type, state);
  if (closed) await store.close(watch.id, 'done', now).catch(() => {});
  const url = `/?report=${row && row.id ? row.id : ''}${watch.origin_thread ? `&thread=${watch.origin_thread}` : ''}`;
  const sent = await pushToOperator({ store, env, title: report.push.title, body: report.push.body, url, tag: `pg1-${watch.target_type}-${String(watch.id).slice(0, 8)}`, webpushImpl });
  if (row && row.id && sent) await store.markPushed(row.id, sent).catch(() => {});
  await logAutonomy({ supUrl, supKey, fetchImpl }, { action: 'watch:report', decision: 'allowed', mode, outcome: state, detail: `${targetLabel(watch.target_type, watch.target_id)}; push ${sent}` });
  // A finished lab code experiment opened a draft PR: watch that too.
  const pr = watch.target_type === 'lab' && snapshot.info && snapshot.info.exp && snapshot.info.exp.candidate;
  if (closed && pr && pr.type === 'code' && pr.pr_number && pr.pr_url) {
    const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/.exec(pr.pr_url);
    if (m) await autoWatch({ env, supUrl, supKey, fetchImpl, store, type: 'pr', id: prTarget(m[1], pr.pr_number), label: `lab ${String(watch.target_id).slice(0, 8)} draft`, originThread: watch.origin_thread, now });
  }
  return { reported: true, closed, report: row };
}

export async function onTargetState({ env = process.env, store, type, id, snapshot, supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now(), webpushImpl = null }) {
  const watch = await store.openFor(type, id);
  if (!watch) return { watched: false, reported: false };
  return { watched: true, ...(await applySnapshot({ env, store, watch, snapshot, supUrl, supKey, fetchImpl, now, webpushImpl })) };
}

// The lab experiment's row as the report needs it, after syncing it with
// its run when it is still queued or running. null when the lab is not
// set up here.
export async function readLab(id, { env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const { createLabStore, ACTIVE_LAB_STATUSES } = await import('../lab/store.mjs');
  const { createLabGithub } = await import('../lab/github.mjs');
  const { syncLabExperiment } = await import('../lab/chat.mjs');
  const labStore = createLabStore({ supUrl, supKey, fetchImpl });
  const e = await labStore.get(id);
  if (!e) return null;
  const gh = createLabGithub({ env, fetchImpl });
  if (ACTIVE_LAB_STATUSES.includes(e.status) && gh.configured && authorize('lab:ingest', { actor: 'pg1', mode: autonomyMode(env) }).allowed) {
    await syncLabExperiment(e, { store: labStore, gh, supUrl, supKey, fetchImpl, now });
  }
  const fresh = (await labStore.get(e.id)) || e;
  return { state: fresh.status, info: { exp: fresh } };
}

async function readTarget(w, deps) {
  if (w.target_type === 'lab') return readLab(w.target_id, deps);
  if (w.target_type === 'pr') return readPr(w.target_id, deps);
  if (w.target_type === 'workflow_run') return readRun(w.target_id, deps);
  if (w.target_type === 'deploy') return readDeploy(w.target_id, deps);
  return null;
}

// The cron's pass. Resolves to [{ id, type, state?, reported?, expired?, error? }].
// One watch's failure never stops the others. Never throws.
export async function resyncWatches({ env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now(), webpushImpl = null, max = 50 }) {
  const out = [];
  let store;
  try {
    store = createWatchStore({ supUrl, supKey, fetchImpl });
  } catch (e) {
    return out;
  }
  let open = [];
  try { open = await store.list({ limit: max }); } catch (e) { return out; }
  for (const w of open) {
    const tag = { id: String(w.id).slice(0, 8), type: w.target_type };
    if (Date.parse(w.expires_at) <= now) {
      await store.close(w.id, 'expired', now).catch(() => {});
      out.push({ ...tag, expired: true });
      continue;
    }
    try {
      const snap = await readTarget(w, { env, supUrl, supKey, fetchImpl, now });
      await store.update(w.id, { last_checked_at: nowIso(now) }).catch(() => {});
      if (!snap) { out.push({ ...tag, state: w.last_state || null }); continue; }
      const r = await applySnapshot({ env, store, watch: w, snapshot: snap, supUrl, supKey, fetchImpl, now, webpushImpl });
      out.push({ ...tag, state: snap.state, reported: !!r.reported, ...(r.held ? { held: true } : {}) });
    } catch (e) {
      console.error(`[watches] resync_failed id=${tag.id} type=${tag.type} ${e && e.status ? `status=${e.status}` : 'error'}`);
      out.push({ ...tag, error: 'unreadable' });
    }
  }
  return out;
}
