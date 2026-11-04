// PG1's scheduled reports on its own service (no command needed):
//
//   daily   07:15 UTC (api/operator/daily.mjs): real usage (probes,
//           crawlers, own and test traffic already left out by
//           lib/usageStats.mjs) for yesterday against the day before and
//           the average of the 7 days before today; payments (402s, paid,
//           settled, on-chain received when the chain can be read); errors
//           by fault; production deploys and their state; what PG1 did on
//           its own in the last 24 hours (pg1_autonomy_log and the
//           Autonomous mode log); what it plans next; approvals waiting.
//   weekly  Mondays 07:30 UTC (api/opportunities/weekly.mjs, with the
//           opportunity scan): the week against the week before, demand
//           PG1 does not serve (unknown tools, unknown MCP methods, A2A
//           requests) split real vs probe, the payment funnel, discovery
//           health (agent-card fetches, the MCP registry's version against
//           the live version), lab experiments and their results, and
//           proposals.
//
// Every figure comes from a source read just now. A source that cannot be
// read is named and shows no figure: nothing is estimated. Each report is
// stored (pg1_operator_reports), shown as a card in PG1 chat, pushed to the
// operator's devices and saved as a PDF in the media library. /report today
// and /report week show the latest (lib/operator/chat.mjs).

import { autonomyMode, recentAutonomy } from '../autonomy.mjs';
import { createAutonomousStore } from '../autonomous/state.mjs';
import { PG1_VERSION } from '../identity.mjs';
import { USAGE_TIME_ZONE } from '../usageStats.mjs';

// Kept here (not imported from merge.mjs, which imports this file).
export const PINNED_TEXT = 'Production is pinned to the earlier deploy: new merges will not go live until a deploy is promoted. Auto-merge is paused until then; after promoting, send /report resume.';

const H = 3600000;
const DAY = 24 * H;
export const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';
export const AGENT_CARD_PATHS = Object.freeze(['/.well-known/agent-card.json', '/.well-known/agent.json']);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
export const fmtCount = (n) => (Number.isFinite(n) ? (Math.round(n * 10) / 10).toLocaleString('en-GB') : 'not read');
export const fmtUsd = (n) => (Number.isFinite(n) ? `${n.toFixed(2)} USD` : 'not read');
const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(1)}%` : '—');

// A read that may fail: { ok: true, value } or { ok: false, reason }.
export async function attempt(fn, reason = 'could not be read') {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, reason: (e && e.reason) || reason };
  }
}

export function vercelProject(env = process.env) {
  return String(env.PG1_VERCEL_PROJECT_ID || env.VERCEL_PROJECT_ID || '').trim();
}
function vercelAuth(env) {
  const token = String(env.VERCEL_TOKEN || '').replace(/\s+/g, '');
  const team = String(env.VERCEL_TEAM_ID || '').trim();
  const project = vercelProject(env);
  if (!token) throw Object.assign(new Error('x'), { reason: 'no platform token is set (VERCEL_TOKEN)' });
  if (!/^prj_[A-Za-z0-9]+$/.test(project)) throw Object.assign(new Error('x'), { reason: 'no project id is set (PG1_VERCEL_PROJECT_ID)' });
  return { token, team: /^team_[A-Za-z0-9]+$/.test(team) ? team : '', project };
}

// Production deployments since a time: [{ id, state, created_at, commit_sha, message }].
export async function readDeploys({ env = process.env, fetchImpl = globalThis.fetch, sinceMs, limit = 20 }) {
  const { token, team, project } = vercelAuth(env);
  const q = new URLSearchParams({ projectId: project, target: 'production', limit: String(limit), since: String(sinceMs) });
  if (team) q.set('teamId', team);
  const res = await fetchImpl(`https://api.vercel.com/v6/deployments?${q}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) throw Object.assign(new Error('x'), { reason: `the platform API answered HTTP ${res.status}` });
  const j = await res.json();
  return (Array.isArray(j.deployments) ? j.deployments : []).map((d) => ({
    id: String(d.uid || d.id || ''),
    state: String(d.state || d.readyState || 'UNKNOWN'),
    created_at: new Date(Number(d.createdAt || d.created) || 0).toISOString(),
    commit_sha: String((d.meta && d.meta.githubCommitSha) || ''),
    message: String((d.meta && d.meta.githubCommitMessage) || '').split('\n')[0].slice(0, 100)
  }));
}

// One observability query (POST /v2/observability/query).
export async function observability({ env = process.env, fetchImpl = globalThis.fetch, body }) {
  const { token, team, project } = vercelAuth(env);
  if (!team) throw Object.assign(new Error('x'), { reason: 'no team id is set (VERCEL_TEAM_ID)' });
  const res = await fetchImpl(`https://api.vercel.com/v2/observability/query?teamId=${team}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ scope: { type: 'project', ownerId: team, projectIds: [project] }, limit: 100, ...body })
  });
  if (!res.ok) throw Object.assign(new Error('x'), { reason: `the platform API answered HTTP ${res.status}` });
  const j = await res.json();
  if (!j || !Array.isArray(j.summary)) throw Object.assign(new Error('x'), { reason: 'the platform API sent no figures' });
  return j;
}

// Agent-card fetches in a window, from the server's own request counts.
export async function agentCardFetches({ env, fetchImpl, fromIso, toIso }) {
  const j = await observability({ env, fetchImpl, body: { metric: 'vercel.request.count', startTime: fromIso, endTime: toIso, groupBy: ['request_path'], filter: `request_path in (${AGENT_CARD_PATHS.map((p) => `'${p}'`).join(',')})` } });
  return j.summary.reduce((n, r) => n + num(r.vercel_request_count_sum), 0);
}

// The MCP registry's latest listed version of this server.
export async function registryVersion({ fetchImpl = globalThis.fetch, name }) {
  const res = await fetchImpl(`${REGISTRY_URL}?search=${encodeURIComponent(name)}&limit=20`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw Object.assign(new Error('x'), { reason: `the MCP registry answered HTTP ${res.status}` });
  const j = await res.json();
  const rows = (Array.isArray(j.servers) ? j.servers : []).map((s) => (s && s.server) || s).filter((s) => s && s.name === name);
  if (!rows.length) return null;
  const latest = rows.find((s) => s._meta && s._meta['io.modelcontextprotocol.registry/official'] && s._meta['io.modelcontextprotocol.registry/official'].isLatest) || rows[rows.length - 1];
  return String(latest.version || '');
}

// On-chain USDC received by the payTo address (lib/usageVerify.mjs when it
// is on this deployment); null when it is not.
async function chainReceived({ env, fetchImpl, fromIso, toIso }) {
  let mod;
  try { mod = await import('../usageVerify.mjs'); } catch (e) { throw Object.assign(new Error('x'), { reason: 'the chain check is not on this deployment' }); }
  const r = await mod.readChainTransfers({ env, range: { from: fromIso, to: toIso }, fetchImpl });
  const finals = r.transfers.filter((t) => t.final);
  return { count: finals.length, usd: Math.round(finals.reduce((n, t) => n + t.amount_usd, 0) * 1e6) / 1e6 };
}

const dublinDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: USAGE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

// Per-day real and probe requests, complete days only (today is left out).
export function completeDays(stats, now) {
  const today = dublinDay(now);
  const days = (stats && stats.traffic && Array.isArray(stats.traffic.per_day) ? stats.traffic.per_day : []).filter((d) => d.day < today);
  return days.map((d) => ({ day: d.day, real: num(d.real), probe: num(d.probe) }));
}

// Approvals waiting: operator tasks and Autonomous mode cards.
export async function waitingApprovals({ opStore, autoStore }) {
  const out = [];
  const tasks = await opStore.listTasks({ statuses: ['needs_approval'], limit: 50 });
  for (const t of tasks) {
    const a = t.approval || {};
    out.push({ id: t.id, source: 'task', kind: t.kind, title: t.title, reason: String(a.reason || t.detail || '').slice(0, 160), approvable: a.approvable !== false, requested_at: t.approval_requested_at || t.updated_at });
  }
  if (autoStore) {
    const rows = await autoStore.listActions({ statuses: ['needs_approval'], limit: 20 });
    for (const r of rows) out.push({ id: r.id, source: 'action', kind: r.type, title: String((r.approval && r.approval.title) || r.result || r.type).slice(0, 200), reason: String((r.approval && r.approval.detail) || r.reason || '').slice(0, 160), approvable: true, requested_at: r.at });
  }
  return out;
}

// --- gathering ---------------------------------------------------------------------

export async function gatherDaily({ env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now(), getStats, opStore, autoStore = null }) {
  const since24 = new Date(now - DAY).toISOString();
  const [s30, s24, deploys, log, autoRows, tasks, approvals, chain, held] = await Promise.all([
    attempt(() => getStats({ period: '30d' }), 'the usage report could not be read'),
    attempt(() => getStats({ period: '24h' }), 'the usage report could not be read'),
    attempt(() => readDeploys({ env, fetchImpl, sinceMs: now - DAY })),
    attempt(() => recentAutonomy({ supUrl, supKey, fetchImpl, now, hours: 24 }), 'the autonomy log could not be read'),
    attempt(() => (autoStore ? autoStore.listActions({ sinceIso: since24, limit: 200 }) : []), 'the Autonomous mode log could not be read'),
    attempt(() => opStore.listTasks({ statuses: ['open', 'lab_running', 'pr_open', 'watching', 'approved'], limit: 20 }), 'the task list could not be read'),
    attempt(() => waitingApprovals({ opStore, autoStore }), 'the approvals could not be read'),
    attempt(() => chainReceived({ env, fetchImpl, fromIso: since24, toIso: new Date(now).toISOString() })),
    attempt(() => opStore.listTasks({ statuses: ['rolled_back', 'merged'], limit: 50 }), 'the task list could not be read')
  ]);
  let usage = { ok: false, reason: s30.ok ? '' : s30.reason };
  if (s30.ok) {
    const days = completeDays(s30.value, now);
    const y = days[days.length - 1] || null;
    const p = days[days.length - 2] || null;
    const last7 = days.slice(-7);
    usage = { ok: true, yesterday: y, previous: p, avg7: last7.length ? last7.reduce((n, d) => n + d.real, 0) / last7.length : null, avg7_days: last7.length };
  }
  return {
    kind: 'daily', now, from: since24, to: new Date(now).toISOString(), mode: autonomyMode(env),
    usage,
    last24: s24.ok ? { ok: true, summary: s24.value.summary || {}, payments: s24.value.payments || {}, errors: s24.value.errors || {}, own: s24.value.own_traffic || {} } : { ok: false, reason: s24.reason },
    chain: chain.ok ? { ok: true, ...chain.value } : { ok: false, reason: chain.reason },
    deploys: deploys.ok ? { ok: true, list: deploys.value } : { ok: false, reason: deploys.reason },
    autonomy: log.ok ? { ok: true, rows: log.value } : { ok: false, reason: log.reason },
    autonomous: autoRows.ok ? { ok: true, rows: autoRows.value } : { ok: false, reason: autoRows.reason },
    plans: tasks.ok ? { ok: true, tasks: tasks.value } : { ok: false, reason: tasks.reason },
    approvals: approvals.ok ? { ok: true, list: approvals.value } : { ok: false, reason: approvals.reason },
    // Merges that left production pinned (a rollback, or a merge not live):
    // auto-merge is paused until the operator promotes a deploy.
    pinned: held.ok ? held.value.filter((t) => t.approval && t.approval.pinned === true && !t.decided_at) : []
  };
}

export async function gatherWeekly({ env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now(), getStats, opStore, autoStore = null, labHistory = null, proposals = null, registryName = null }) {
  const from = new Date(now - 7 * DAY).toISOString();
  const to = new Date(now).toISOString();
  const name = registryName || 'io.github.Project-Gifted1/pg1-threat-intel';
  const [s7, s30, cards, reg, lab, props, approvals, tasks] = await Promise.all([
    attempt(() => getStats({ period: '7d' }), 'the usage report could not be read'),
    attempt(() => getStats({ period: '30d' }), 'the usage report could not be read'),
    attempt(() => agentCardFetches({ env, fetchImpl, fromIso: from, toIso: to })),
    attempt(() => registryVersion({ fetchImpl, name })),
    attempt(async () => (labHistory ? labHistory() : []), 'the lab record could not be read'),
    attempt(async () => (proposals ? proposals() : []), 'the proposals could not be read'),
    attempt(() => waitingApprovals({ opStore, autoStore }), 'the approvals could not be read'),
    attempt(() => opStore.listTasks({ sinceIso: from, limit: 100 }), 'the task list could not be read')
  ]);
  let trend = { ok: false, reason: s30.ok ? '' : s30.reason };
  if (s30.ok) {
    const days = completeDays(s30.value, now);
    const week = days.slice(-7);
    const before = days.slice(-14, -7);
    trend = { ok: true, week: { days: week.length, real: week.reduce((n, d) => n + d.real, 0), probe: week.reduce((n, d) => n + d.probe, 0) }, previous: { days: before.length, real: before.reduce((n, d) => n + d.real, 0), probe: before.reduce((n, d) => n + d.probe, 0) }, per_day: week };
  }
  const st = s7.ok ? s7.value : null;
  const a2a = st ? ((st.traffic && st.traffic.by_route) || []).find((r) => r.route === '/api/a2a') || { requests: 0, real: 0, probe: 0 } : null;
  const recentLab = lab.ok ? lab.value.filter((e) => Date.parse(e.created_at) >= now - 7 * DAY) : [];
  return {
    kind: 'weekly', now, from, to, mode: autonomyMode(env),
    trend,
    demand: st ? { ok: true, unknown_tools: (st.errors && st.errors.unrecognised_tools_split) || [], unknown_methods: (st.errors && st.errors.methods_not_found) || [], a2a: { requests: num(a2a.requests), real: num(a2a.real), probe: num(a2a.probe) } } : { ok: false, reason: s7.reason },
    funnel: st ? { ok: true, ...(st.payments || {}) } : { ok: false, reason: s7.reason },
    summary: st ? st.summary || {} : null,
    errors: st ? st.errors || {} : null,
    discovery: {
      agent_card_fetches: cards.ok ? { ok: true, count: cards.value } : { ok: false, reason: cards.reason },
      registry: reg.ok ? { ok: true, listed: reg.value, live: PG1_VERSION, matches: reg.value === PG1_VERSION } : { ok: false, reason: reg.reason, live: PG1_VERSION }
    },
    experiments: lab.ok ? { ok: true, list: recentLab } : { ok: false, reason: lab.reason },
    proposals: props.ok ? { ok: true, list: props.value.slice(0, 10) } : { ok: false, reason: props.reason },
    tasks: tasks.ok ? { ok: true, list: tasks.value } : { ok: false, reason: tasks.reason },
    approvals: approvals.ok ? { ok: true, list: approvals.value } : { ok: false, reason: approvals.reason }
  };
}

// --- building -----------------------------------------------------------------------

const row = (label, value, extra = {}) => ({ label: String(label), value: String(value), ...extra });
const notRead = (x) => `not read (${x.reason || 'unavailable'})`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : String(d || '—'); };
const timeLabel = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: USAGE_TIME_ZONE, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).replace(',', '');

function approvalItems(data) {
  if (!data.approvals.ok) return [];
  return data.approvals.list.map((a) => ({ id: a.id, source: a.source, kind: a.kind, title: a.title, reason: a.reason, approvable: a.approvable !== false }));
}

function autonomyLines(data) {
  const out = [];
  if (!data.autonomy.ok) out.push(`- Autonomy log: ${notRead(data.autonomy)}`);
  else {
    const rows = data.autonomy.rows.filter((r) => r.actor === 'pg1' || r.actor === 'lab');
    const allowed = rows.filter((r) => r.decision === 'allowed');
    const by = allowed.reduce((m, r) => { m[r.action] = (m[r.action] || 0) + 1; return m; }, {});
    out.push(`- Autonomy log: ${rows.length} decision${rows.length === 1 ? '' : 's'} (${allowed.length} allowed, ${rows.filter((r) => r.decision === 'denied').length} denied, ${rows.filter((r) => r.decision === 'needs_approval').length} sent for approval)${Object.keys(by).length ? `: ${Object.entries(by).map(([k, v]) => `${k} ×${v}`).join(', ')}` : ''}`);
  }
  if (!data.autonomous.ok) out.push(`- Autonomous mode: ${notRead(data.autonomous)}`);
  else {
    const rows = data.autonomous.rows;
    out.push(`- Autonomous mode: ${rows.length} action${rows.length === 1 ? '' : 's'} (${rows.filter((r) => r.status === 'done').length} done, ${rows.filter((r) => r.status === 'failed').length} failed)`);
    for (const r of rows.slice(0, 8)) out.push(`  - ${r.type}: ${r.status}${r.result ? ` — ${String(r.result).slice(0, 120)}` : ''}`);
  }
  return out;
}

export function buildDailyReport(data) {
  const u = data.usage;
  const l = data.last24;
  const title = `PG1 daily report · ${dayLabel(dublinDay(data.now))}`;
  const md = [`# ${title}`, ''];
  const pinned = data.pinned || [];
  if (pinned.length) {
    md.push('## Production is pinned to an earlier deploy', '');
    for (const t of pinned) md.push(`- PR #${t.pr_number} (${t.title}): ${t.status === 'rolled_back' ? 'rolled back' : 'merged but not live'}. ${String(t.detail || '').split('. ')[0]}.`);
    md.push(`- ${PINNED_TEXT}`, '');
  }
  md.push(`Mode: PG1_AUTONOMY=${data.mode}. Figures from the sources named, read ${timeLabel(data.to)} (Ireland time); a source that could not be read shows no figure.`, '', '## Usage (real callers only: probes, crawlers, own and test traffic excluded)');
  if (!u.ok) md.push(`- Usage: ${notRead(u)}`);
  else {
    md.push(`- Real requests ${u.yesterday ? dayLabel(u.yesterday.day) : 'yesterday'}: ${u.yesterday ? fmtCount(u.yesterday.real) : 'no data'}`);
    md.push(`- Day before (${u.previous ? dayLabel(u.previous.day) : '—'}): ${u.previous ? fmtCount(u.previous.real) : 'no data'} (change ${u.yesterday && u.previous ? pct(u.yesterday.real, u.previous.real) : '—'})`);
    md.push(`- Average of the last ${u.avg7_days} complete days: ${u.avg7 == null ? 'no data' : fmtCount(u.avg7)} (yesterday vs average ${u.yesterday && u.avg7 ? pct(u.yesterday.real, u.avg7) : '—'})`);
  }
  if (l.ok) md.push(`- Last 24 hours: ${fmtCount(num(l.summary.real_tool_calls))} real tool calls from about ${fmtCount(num(l.summary.distinct_real_callers_estimate))} distinct callers (estimated from hashed IPs)`);
  md.push('', '## Payments (last 24 hours)');
  if (!l.ok) md.push(`- ${notRead(l)}`);
  else md.push(`- Payment requests (402): ${fmtCount(num(l.payments.payment_requests))} · paid calls settled: ${fmtCount(num(l.payments.payments_settled))} · settled: ${fmtUsd(num(l.payments.revenue_usd))}`);
  md.push(`- Received on chain: ${data.chain.ok ? `${data.chain.count} transfer${data.chain.count === 1 ? '' : 's'} (${fmtUsd(data.chain.usd)})` : notRead(data.chain)}`);
  md.push('', '## Errors by fault (last 24 hours)');
  if (!l.ok) md.push(`- ${notRead(l)}`);
  else { const f = l.errors.by_fault || {}; md.push(`- PG1 or its sources: ${fmtCount(num(f.pg1))} · callers: ${fmtCount(num(f.caller))} · unclassified: ${fmtCount(num(f.unclassified))}`); }
  md.push('', '## Production deploys (last 24 hours)');
  if (!data.deploys.ok) md.push(`- ${notRead(data.deploys)}`);
  else if (!data.deploys.list.length) md.push('- None.');
  else for (const d of data.deploys.list.slice(0, 10)) md.push(`- ${timeLabel(d.created_at)} · ${d.state}${d.message ? ` · ${d.message}` : ''}`);
  md.push('', '## What PG1 did on its own (last 24 hours)', ...autonomyLines(data));
  md.push('', '## Next');
  if (!data.plans.ok) md.push(`- ${notRead(data.plans)}`);
  else if (!data.plans.tasks.length) md.push('- No open tasks.');
  else for (const t of data.plans.tasks.slice(0, 10)) md.push(`- [${t.kind}] ${t.title} — ${t.status.replace(/_/g, ' ')}`);
  appendApprovals(md, data);
  const card = { title: 'Daily report', sections: [
    ...(pinned.length ? [{ id: 'pinned', title: 'Production pinned', groups: [{ rows: [...pinned.map((t) => row(`PR #${t.pr_number}`, t.status === 'rolled_back' ? 'rolled back' : 'not live', { sub: t.title, warn: true })), row('New merges', 'not going live', { sub: 'Promote a deploy, then /report resume. Auto-merge is paused.', warn: true, tag: 'paused' })] }] }] : []),
    { id: 'usage', title: 'Usage (real)', groups: [{ rows: u.ok ? [
      row(u.yesterday ? dayLabel(u.yesterday.day) : 'Yesterday', u.yesterday ? fmtCount(u.yesterday.real) : 'no data', { sub: 'real requests' }),
      row('Day before', u.previous ? fmtCount(u.previous.real) : 'no data', { sub: u.yesterday && u.previous ? `change ${pct(u.yesterday.real, u.previous.real)}` : '' }),
      row(`${u.avg7_days}-day average`, u.avg7 == null ? 'no data' : fmtCount(u.avg7), { sub: u.yesterday && u.avg7 ? `yesterday ${pct(u.yesterday.real, u.avg7)}` : '' })
    ] : [row('Usage', 'not read', { sub: u.reason, warn: true })] }] },
    { id: 'payments', title: 'Payments (24 h)', groups: [{ rows: l.ok ? [
      row('402 challenges', fmtCount(num(l.payments.payment_requests))), row('Paid calls settled', fmtCount(num(l.payments.payments_settled))), row('Settled', fmtUsd(num(l.payments.revenue_usd))),
      row('Received on chain', data.chain.ok ? fmtUsd(data.chain.usd) : 'not read', { sub: data.chain.ok ? `${data.chain.count} transfers` : data.chain.reason })
    ] : [row('Payments', 'not read', { sub: l.reason, warn: true })] }] },
    { id: 'errors', title: 'Errors by fault (24 h)', groups: [{ rows: l.ok ? Object.entries({ 'PG1 or sources': 'pg1', Callers: 'caller', Unclassified: 'unclassified' }).map(([k, f]) => row(k, fmtCount(num((l.errors.by_fault || {})[f])), { warn: f === 'pg1' && num((l.errors.by_fault || {}).pg1) > 0 })) : [row('Errors', 'not read', { warn: true })] }] },
    { id: 'deploys', title: 'Deploys (24 h)', groups: [{ rows: data.deploys.ok ? data.deploys.list.slice(0, 5).map((d) => row(timeLabel(d.created_at), d.state, { sub: d.message, warn: d.state !== 'READY' })) : [row('Deploys', 'not read', { sub: data.deploys.reason, warn: true })], empty: 'No production deploys.' }] },
    { id: 'autonomy', title: 'PG1 on its own (24 h)', groups: [{ rows: autonomyLines(data).filter((x) => !x.startsWith('  ')).map((x) => { const [k, ...v] = x.replace(/^- /, '').split(': '); return row(k, v.join(': ').split(' (')[0], { sub: v.join(': ').includes('(') ? v.join(': ').slice(v.join(': ').indexOf('(')) : '' }); }) }] },
    { id: 'next', title: 'Next', groups: [{ rows: data.plans.ok ? data.plans.tasks.slice(0, 5).map((t) => row(t.title, t.status.replace(/_/g, ' '), { sub: t.kind })) : [], empty: data.plans.ok ? 'No open tasks.' : 'Tasks not read.' }] }
  ], note: 'Every figure is read from its source; "not read" means the source did not answer, never an estimate.' };
  return finish({ kind: 'daily', title, md, card, data, pushBody: dailyPushBody(data) });
}

function dailyPushBody(data) {
  const u = data.usage;
  const parts = [];
  if (u.ok && u.yesterday) parts.push(`${fmtCount(u.yesterday.real)} real requests yesterday${u.avg7 ? ` (${pct(u.yesterday.real, u.avg7)} vs avg)` : ''}`);
  if (data.last24.ok) parts.push(`${fmtCount(num(data.last24.payments.payments_settled))} paid`);
  if ((data.pinned || []).length) parts.unshift('Production pinned to an earlier deploy; auto-merge paused');
  const n = data.approvals.ok ? data.approvals.list.length : 0;
  if (n) parts.push(`${n} waiting for approval`);
  return parts.join(' · ') || 'Your daily report is in the app.';
}

function appendApprovals(md, data) {
  md.push('', '## Waiting for your approval');
  if (!data.approvals.ok) md.push(`- ${notRead(data.approvals)}`);
  else if (!data.approvals.list.length) md.push('- Nothing.');
  else for (const a of data.approvals.list) md.push(`- ${a.title}${a.reason ? ` — ${a.reason}` : ''} (\`${a.id.slice(0, 8)}\`${a.approvable === false ? ', cannot be approved yet' : ''})`);
}

function finish({ kind, title, md, card, data, pushBody }) {
  const approvals = approvalItems(data);
  // The page draws these as the card's last section, with Approve / Decline.
  card.approvals = approvals;
  return { kind, title, markdown: md.join('\n'), card, approvals, push: { title: kind === 'daily' ? 'PG1 daily report' : 'PG1 weekly report', body: pushBody } };
}

export function buildWeeklyReport(data) {
  const title = `PG1 weekly report · week to ${dayLabel(dublinDay(data.now))}`;
  const t = data.trend;
  const d = data.demand;
  const f = data.funnel;
  const md = [`# ${title}`, '', `Mode: PG1_AUTONOMY=${data.mode}. Real callers only unless a line says probe; a source that could not be read shows no figure.`, '', '## Trend'];
  if (!t.ok) md.push(`- ${notRead(t)}`);
  else md.push(`- Real requests, last ${t.week.days} complete days: ${fmtCount(t.week.real)} (previous ${t.previous.days} days: ${fmtCount(t.previous.real)}, change ${pct(t.week.real, t.previous.real)}); probe requests ${fmtCount(t.week.probe)}`);
  md.push('', '## Demand PG1 does not serve (real / probe)');
  if (!d.ok) md.push(`- ${notRead(d)}`);
  else {
    md.push(`- Unknown tools: ${d.unknown_tools.length ? d.unknown_tools.map((x) => `\`${x.name}\` ${x.real}/${x.probe}`).join(', ') : 'none'}`);
    md.push(`- Unknown MCP methods: ${d.unknown_methods.length ? d.unknown_methods.map((x) => `\`${x.method}\` ${x.real}/${x.probe}`).join(', ') : 'none'}`);
    md.push(`- A2A requests: ${d.a2a.real}/${d.a2a.probe}`);
  }
  md.push('', '## Payment funnel (7 days)');
  if (!f.ok) md.push(`- ${notRead(f)}`);
  else md.push(`- Free checks ${fmtCount(num(f.free_checks_used))} → hit the free limit ${fmtCount(num(f.callers_hit_free_limit))} callers → 402 challenges ${fmtCount(num(f.payment_requests))} → settled ${fmtCount(num(f.payments_settled))} (${fmtUsd(num(f.revenue_usd))})`);
  md.push('', '## Discovery health');
  const c = data.discovery.agent_card_fetches;
  md.push(`- Agent-card fetches (7 days): ${c.ok ? fmtCount(c.count) : notRead(c)}`);
  const r = data.discovery.registry;
  md.push(`- MCP registry: ${r.ok ? (r.listed ? `lists ${r.listed}, live is ${r.live}${r.matches ? ' (matches)' : ' (out of date)'}` : `not listed (live is ${r.live})`) : notRead(r)}`);
  md.push('', '## Experiments (7 days)');
  if (!data.experiments.ok) md.push(`- ${notRead(data.experiments)}`);
  else if (!data.experiments.list.length) md.push('- None.');
  else for (const e of data.experiments.list.slice(0, 10)) md.push(`- ${e.kind}: ${String(e.goal || '').slice(0, 90)} — ${e.status}${e.gate ? (e.gate.pass ? ', gate passed' : ', gate failed') : ''}`);
  md.push('', '## Proposals');
  if (!data.proposals.ok) md.push(`- ${notRead(data.proposals)}`);
  else if (!data.proposals.list.length) md.push('- None this week.');
  else for (const p of data.proposals.list) md.push(`- ${p.title} — ${p.status}${p.price_usd != null ? `, price ${p.price_usd} USD (${p.margin_ok ? '1.5x cost met' : '1.5x cost NOT met'})` : ''}`);
  md.push('', '## Tasks this week');
  if (!data.tasks.ok) md.push(`- ${notRead(data.tasks)}`);
  else if (!data.tasks.list.length) md.push('- None.');
  else for (const x of data.tasks.list.slice(0, 15)) md.push(`- [${x.kind}] ${x.title} — ${x.status.replace(/_/g, ' ')}${x.pr_url ? ` (${x.pr_url})` : ''}`);
  appendApprovals(md, data);
  const card = { title: 'Weekly report', sections: [
    { id: 'trend', title: 'Trend (real)', groups: [{ rows: t.ok ? [row('This week', fmtCount(t.week.real), { sub: `${t.week.days} days` }), row('Week before', fmtCount(t.previous.real), { sub: `change ${pct(t.week.real, t.previous.real)}` }), row('Probe requests', fmtCount(t.week.probe))] : [row('Trend', 'not read', { warn: true })] }] },
    { id: 'demand', title: 'Unserved demand (real / probe)', groups: [{ rows: d.ok ? [...d.unknown_tools.slice(0, 5).map((x) => row(x.name, `${x.real} / ${x.probe}`, { mono: true, sub: 'unknown tool' })), ...d.unknown_methods.slice(0, 5).map((x) => row(x.method, `${x.real} / ${x.probe}`, { mono: true, sub: 'unknown method' })), row('A2A requests', `${d.a2a.real} / ${d.a2a.probe}`)] : [row('Demand', 'not read', { warn: true })] }] },
    { id: 'funnel', title: 'Payment funnel', groups: [{ rows: f.ok ? [row('402 challenges', fmtCount(num(f.payment_requests))), row('Settled', fmtCount(num(f.payments_settled)), { sub: fmtUsd(num(f.revenue_usd)) })] : [row('Funnel', 'not read', { warn: true })] }] },
    { id: 'discovery', title: 'Discovery', groups: [{ rows: [row('Agent-card fetches', c.ok ? fmtCount(c.count) : 'not read', { sub: c.ok ? '7 days' : c.reason }), row('MCP registry', r.ok ? (r.listed || 'not listed') : 'not read', { sub: `live ${r.live}`, warn: !r.ok || !r.matches })] }] },
    { id: 'experiments', title: 'Experiments', groups: [{ rows: data.experiments.ok ? data.experiments.list.slice(0, 5).map((e) => row(e.kind, e.status, { sub: String(e.goal || '').slice(0, 80) })) : [], empty: 'None this week.' }] }
  ], note: 'Every figure is read from its source; "not read" means the source did not answer, never an estimate.' };
  const pushBody = [t.ok ? `${fmtCount(t.week.real)} real requests (${pct(t.week.real, t.previous.real)})` : '', f.ok ? `${fmtCount(num(f.payments_settled))} paid` : '', data.approvals.ok && data.approvals.list.length ? `${data.approvals.list.length} waiting for approval` : ''].filter(Boolean).join(' · ') || 'Your weekly report is in the app.';
  return finish({ kind: 'weekly', title, md, card, data, pushBody });
}

// Stores the report, saves its PDF and pushes it. Each step on its own:
// a PDF or push that fails does not lose the report.
export async function publishReport({ built, data, opStore, env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, push = null, makePdf = null }) {
  const saved = await opStore.addReport({ kind: built.kind, period_start: data.from, period_end: data.to, title: built.title, markdown: built.markdown.slice(0, 60000), card: built.card, approvals: built.approvals });
  let documentId = null;
  try {
    const make = makePdf || (async () => {
      const { makeDocument } = await import('../pdf/store.mjs');
      const out = await makeDocument({ doc: { title: built.title, subtitle: built.kind === 'daily' ? 'Daily report' : 'Weekly report', markdown: built.markdown.replace(/^# [^\n]*\n/, '') }, source: 'usage', env, supUrl, supKey, fetchImpl });
      return out && out.ok && out.card && out.card.stored ? out.card.id : null;
    });
    documentId = await make(built);
    if (documentId && saved && saved.id) await opStore.updateReport(saved.id, { document_id: documentId });
  } catch (e) { documentId = null; }
  let pushed = 0;
  try { pushed = push ? await push(built.push) : 0; } catch (e) { pushed = 0; }
  return { id: saved && saved.id, documentId, pushed };
}

export { DAY, H, dayLabel, timeLabel, createAutonomousStore };
