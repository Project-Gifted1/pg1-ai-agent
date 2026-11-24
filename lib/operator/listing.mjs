// PG1's MCP registry listing, checked live (never from a report's snapshot).
//
//   listingState({ fetchImpl })                 { listed, live, matches }
//   resolveStaleListings({ opStore, ... })       closes waiting listing approvals the
//                                                registry has since caught up with
//                                                ("resolved, nothing to publish")
//   publishListing({ task, gh, ... })            runs publish-mcp.yml only when the
//                                                registry lacks the live version, and
//                                                records the run
//   refreshPublishRun({ task, gh, opStore })     the run's real result on the task
//                                                (published, or the failure reason)
//
// A listing approval is made from a weekly report (lib/operator/tasks.mjs
// weeklyFindings); by the time it is shown or approved, a release may have
// been published already. So the live version and the registry are read again
// before anything is shown or run.

import { PG1_VERSION } from '../identity.mjs';
import { registryVersion } from './reports.mjs';
import { autonomyMode, logAutonomy } from '../autonomy.mjs';

export const REGISTRY_NAME = 'io.github.Project-Gifted1/pg1-threat-intel';
export const PUBLISH_WORKFLOW = 'publish-mcp.yml';

export async function listingState({ fetchImpl = globalThis.fetch, name = REGISTRY_NAME, live = PG1_VERSION, readRegistry = registryVersion } = {}) {
  const listed = await readRegistry({ fetchImpl, name });
  return { listed: listed || null, live, matches: !!listed && listed === live };
}

export const resolvedDetail = (s) => `Resolved, nothing to publish: the MCP registry already lists ${s.listed}, the live version.`;

// Waiting listing approvals (all, or only `ids`) the registry has caught up
// with are closed as done. Returns the closed ones. Never throws: if the
// registry cannot be read, nothing is closed (the item stays as it was).
export async function resolveStaleListings({ opStore, fetchImpl = globalThis.fetch, ids = null, now = Date.now(), audit = null, env = process.env, state = null, readState = listingState }) {
  let tasks = [];
  try { tasks = (await opStore.listTasks({ statuses: ['needs_approval'], limit: 50 })).filter((t) => t.kind === 'listing' && (!ids || ids.includes(t.id))); } catch (e) { return []; }
  if (!tasks.length) return [];
  let s = state;
  if (!s) { try { s = await readState({ fetchImpl }); } catch (e) { return []; } }
  if (!s || !s.matches) return [];
  const closed = [];
  for (const t of tasks) {
    await opStore.updateTask(t.id, { status: 'done', decided_at: new Date(now).toISOString(), detail: resolvedDetail(s), approval: { ...(t.approval || {}), approvable: false, resolved: true, reason: resolvedDetail(s) } });
    closed.push({ id: t.id, title: t.title, detail: resolvedDetail(s) });
  }
  if (closed.length && audit) await logAutonomy(audit, { action: 'directory:register', actor: 'pg1', decision: 'allowed', mode: autonomyMode(env), outcome: 'resolved', detail: `${closed.length} listing approval${closed.length === 1 ? '' : 's'} closed: the registry lists ${s.listed}, live ${s.live}` }).catch(() => null);
  return closed;
}

// The approved publish: skipped when the registry already has the live
// version; otherwise the workflow is started and its run recorded on the
// task, so the card can show the real result. { ran, skipped, message }
export async function publishListing({ task, gh, opStore, fetchImpl = globalThis.fetch, now = Date.now(), readState = listingState }) {
  const a = task.approval || {};
  let s = null;
  try { s = await readState({ fetchImpl }); } catch (e) { s = null; }
  if (s && s.matches) {
    await opStore.updateTask(task.id, { status: 'done', detail: `Not run: ${resolvedDetail(s).replace(/^Resolved, nothing to publish: /, '')}`, approval: { ...a, resolved: true } });
    return { ran: false, skipped: true, message: `Approved, but nothing to publish: the MCP registry already lists ${s.listed}, the live version, so ${a.workflow || PUBLISH_WORKFLOW} was not run.` };
  }
  const workflow = a.workflow || PUBLISH_WORKFLOW;
  const startedAt = new Date(now - 5000).toISOString();
  const ok = await gh.dispatch(workflow).catch(() => false);
  if (!ok) {
    await opStore.updateTask(task.id, { status: 'approved', detail: `${workflow} could not be started; steps: ${(a.steps || []).join(' ')}` });
    return { ran: false, skipped: false, message: `Approved, but ${workflow} could not be started. The steps: ${(a.steps || []).join(' ')}` };
  }
  const run = gh.findRun ? await gh.findRun(workflow, startedAt).catch(() => null) : null;
  await opStore.updateTask(task.id, { status: 'approved', detail: `publishing ${s ? s.live : PG1_VERSION}: ${workflow} running${run ? ` (run ${run.id})` : ''}`, approval: { ...a, run: run ? { id: run.id, url: run.url } : { started_at: startedAt } } });
  return { ran: true, skipped: false, run, message: `Approved: PG1 started ${workflow}${run ? ` (run ${run.id})` : ''} to publish ${s ? s.live : PG1_VERSION}. This card shows its result when it finishes.` };
}

// The publish run's real result, written to the task once it has finished:
// done (published, with the registry's version) or failed (the reason from
// the run's log). Returns { status, detail } or null while still running.
export async function refreshPublishRun({ task, gh, opStore, fetchImpl = globalThis.fetch, readState = listingState }) {
  const a = task.approval || {};
  if (task.kind !== 'listing' || task.status !== 'approved' || !a.run || !gh) return null;
  let run = a.run;
  if (!run.id && gh.findRun) { const r = await gh.findRun(a.workflow || PUBLISH_WORKFLOW, run.started_at).catch(() => null); if (!r) return null; run = { id: r.id, url: r.url }; }
  const r = await gh.runResult(run.id).catch(() => null);
  if (!r || r.status !== 'completed') return null;
  let out;
  if (r.conclusion === 'success') {
    let listed = null; try { listed = (await readState({ fetchImpl })).listed; } catch (e) { listed = null; }
    out = { status: 'done', detail: `Published: run ${run.id} succeeded${listed ? `; the MCP registry lists ${listed}` : ''}.` };
  } else out = { status: 'failed', detail: `The publish run ${run.id} ${r.conclusion || 'failed'}${r.reason ? `: ${r.reason}` : ''}.` };
  await opStore.updateTask(task.id, { ...out, approval: { ...a, run: { ...run, conclusion: r.conclusion } } });
  return out;
}
