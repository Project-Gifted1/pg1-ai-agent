// The living lab's state (public/lab/living-lab.js), from the existing lab
// and watch data only: nothing is invented, so the scene never shows
// activity that did not happen.
//
//   experiments  the lab experiments that are queued or running, plus any
//                that finished in the last two hours (one ring each)
//   events       the last two hours of: watch reports (webhooks: lab runs,
//                PRs, CI, deploys), Autonomous mode's checks (scans) and
//                threat feed rows that arrived (feed updates, read through
//                the /api/ioc source policy, counted, never their values)
//   mode         error    a lab run or an autonomous action failed in the
//                         last 30 minutes
//                running  an experiment is queued or running
//                thinking an autonomous action is running
//                success  an experiment finished in the last 30 minutes
//                idle     otherwise
// Operator only (api/watches.mjs op lab_scene). Ids are shortened; no goal,
// value or link leaves the server. A stopped experiment carries the stage it
// failed at and the runner's reason (lib/lab/card.mjs labFailure), so the
// screen says why it is red.

import { fetchThreatTelemetry } from './sourcePolicy.mjs';
import { labFailure } from './lab/card.mjs';

const MIN = 60000;
const RECENT_MS = 2 * 60 * MIN;
const FRESH_MS = 30 * MIN;
const ACTIVE = ['queued', 'running'];
const SCENE_STATUS = { queued: 'queued', running: 'running', done: 'done', failed: 'failed', over_budget: 'over_budget', stopped: 'stopped', cancelled: 'stopped' };
const SCANS = ['feed_guardian', 'engine_watchdog', 'integration_watch', 'self_heal', 'mission', 'lab_autopilot'];

export function sceneMode({ experiments = [], actions = [], now = Date.now() }) {
  const recent = (iso) => Date.parse(iso || '') >= now - FRESH_MS;
  if (experiments.some((e) => e.status === 'failed' && recent(e.updated_at)) || actions.some((a) => a.status === 'failed' && recent(a.finished_at || a.at))) return 'error';
  if (experiments.some((e) => ACTIVE.includes(e.status))) return 'running';
  if (actions.some((a) => a.status === 'running')) return 'thinking';
  if (experiments.some((e) => e.status === 'done' && recent(e.updated_at))) return 'success';
  return 'idle';
}

export async function labSceneState({ supUrl, supKey, fetchImpl = globalThis.fetch, env = process.env, now = Date.now() }) {
  const headers = { apikey: supKey, Authorization: `Bearer ${supKey}` };
  const since = new Date(now - RECENT_MS).toISOString();
  const get = async (path) => {
    try {
      const res = await fetchImpl(`${supUrl}/rest/v1/${path}`, { headers, cache: 'no-store' });
      return res.ok ? await res.json() : [];
    } catch (e) { return []; }
  };
  const [exps, reports, actions, feed] = await Promise.all([
    get(`pg1_lab_experiments?select=id,kind,goal,status,updated_at,error,candidate,gate&or=(status.in.(queued,running),updated_at.gte.${encodeURIComponent(since)})&order=created_at.desc&limit=8`),
    get(`pg1_watch_reports?select=id,created_at&created_at=gte.${encodeURIComponent(since)}&order=created_at.asc&limit=30`),
    get(`pg1_autonomous_actions?select=id,at,type,status,finished_at&at=gte.${encodeURIComponent(since)}&order=at.asc&limit=50`),
    fetchThreatTelemetry(supUrl, supKey, ['select=ingested_at', `ingested_at=gte.${encodeURIComponent(since)}`, 'order=ingested_at.asc', 'limit=20'], { fetchImpl, env }).then((r) => (r.ok ? r.rows : [])).catch(() => [])
  ]);
  const experiments = (Array.isArray(exps) ? exps : []).map((e) => {
    const f = labFailure(e);
    return { id8: String(e.id || '').slice(0, 8), status: SCENE_STATUS[e.status] || 'queued', updated_at: e.updated_at, ...(f ? { stage: f.stage, error: f.message.slice(0, 160) } : {}) };
  });
  const acts = Array.isArray(actions) ? actions : [];
  const events = [
    ...(Array.isArray(reports) ? reports : []).map((r) => ({ id: `w-${String(r.id).slice(0, 8)}`, kind: 'webhook', at: r.created_at })),
    ...acts.filter((a) => SCANS.includes(a.type) && a.status !== 'queued').map((a) => ({ id: `a-${String(a.id).slice(0, 8)}`, kind: 'scan', at: a.at })),
    ...(Array.isArray(feed) ? feed : []).map((r, i) => ({ id: `f-${r.ingested_at}-${i}`, kind: 'feed', at: r.ingested_at }))
  ].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-50);
  return {
    mode: sceneMode({ experiments, actions: acts, now }),
    experiments: experiments.map(({ id8, status, stage, error }) => ({ id8, status, ...(stage ? { stage, error } : {}) })),
    events,
    at: new Date(now).toISOString()
  };
}
