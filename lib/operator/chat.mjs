// /report today | week (signed-in operator only): the latest stored daily
// or weekly report (lib/operator/reports.mjs) as its card, with Approve and
// Decline on each waiting item. /report approve <id> and /report decline
// <id> decide an item (lib/operator/tasks.mjs decideTask): approving runs
// it under its APPROVAL action and is logged. /report resume lifts the
// auto-merge pause a rollback set, once the operator has promoted a deploy
// (PG1 checks production is no longer pinned first). PG1 words only.

import { createOperatorStore } from './store.mjs';
import { decideTask } from './tasks.mjs';
import { createOperatorGithub, productionPinned } from './merge.mjs';
import { logAutonomy, autonomyMode } from '../autonomy.mjs';
import { approvedMerger } from './run.mjs';

export function isReportCommand(text) {
  return /^\/report(?:\s|$)/i.test(String(text || '').trim());
}

export function parseReportCommand(text) {
  const m = /^\/report\s*(\S*)\s*(\S*)/i.exec(String(text || '').trim());
  const sub = (m && m[1] ? m[1] : 'today').toLowerCase();
  const kind = ['week', 'weekly'].includes(sub) ? 'weekly' : ['today', 'daily', 'day'].includes(sub) ? 'daily' : null;
  return { sub, kind, id: m && m[2] ? m[2].toLowerCase() : '' };
}

export function reportCardResult(row) {
  return { id: `report-${row.id}`, tool: 'operator_report', title: row.title, status: 'report', status_label: 'Report', fields: [], reasons: [], checks: [], usage: { ...(row.card || {}), approvals: Array.isArray(row.approvals) ? row.approvals : [] } };
}

export async function handleReportCommand({ text, isOperator = false, env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, deps = {} }) {
  if (isOperator !== true) return { status: 401, reply: '[AGENT] Reports are for the signed-in operator only.' };
  if (!supUrl || !supKey) return { status: 200, reply: 'Reports need the vault (Supabase), which is not configured on this deployment.' };
  const { sub, kind, id } = parseReportCommand(text);
  try {
    const store = deps.opStore || createOperatorStore({ supUrl, supKey, fetchImpl });
    if (sub === 'approve' || sub === 'decline') {
      if (!/^[0-9a-f]{8}(?:[0-9a-f-]{28})?$/.test(id)) return { status: 200, reply: `Give the item's id: /report ${sub} <id>.` };
      const out = await decideTask({
        id, decision: sub === 'approve' ? 'approve' : 'decline', actor: 'operator', opStore: store, env, fetchImpl, audit: { supUrl, supKey, fetchImpl },
        gh: deps.gh || createOperatorGithub({ env, fetchImpl }), startLab: deps.startLab || null,
        mergeApproved: deps.mergeApproved || approvedMerger({ env, supUrl, supKey, fetchImpl, deps: { opStore: store, gh: deps.gh } })
      });
      return { status: 200, reply: out.message };
    }
    if (sub === 'resume') {
      const held = (await store.listTasks({ statuses: ['rolled_back', 'merged'], limit: 50 })).filter((t) => t.approval && t.approval.pinned === true && !t.decided_at);
      if (!held.length) return { status: 200, reply: 'Auto-merge is not paused.' };
      const pin = await (deps.productionPinned || productionPinned)({ env, fetchImpl, now: Date.now() }).catch(() => null);
      if (!pin) return { status: 200, reply: 'The production deployment could not be read, so auto-merge stays paused. Try again shortly.' };
      if (pin.pinned) return { status: 200, reply: `Production is still pinned to ${pin.serving} (the newest deploy is ${pin.latest}). Promote a deploy in the platform first; auto-merge stays paused until then.` };
      for (const t of held) await store.updateTask(t.id, { decided_at: new Date().toISOString() });
      await logAutonomy({ supUrl, supKey, fetchImpl }, { action: 'code:merge_low_risk', actor: 'operator', decision: 'allowed', mode: autonomyMode(env), outcome: 'resumed', detail: `auto-merge resumed after ${held.length} pinned merge${held.length === 1 ? '' : 's'}` });
      return { status: 200, reply: `Production serves the newest deploy again. Auto-merge is resumed (${held.length} pause${held.length === 1 ? '' : 's'} cleared).` };
    }
    if (!kind) return { status: 200, reply: 'Use /report today, /report week, /report approve <id>, /report decline <id> or /report resume.' };
    const row = await store.latestReport(kind);
    if (!row) return { status: 200, reply: `No ${kind} report yet. It is sent ${kind === 'daily' ? 'every day at 07:15 UTC' : 'on Mondays at 07:30 UTC'} while Autonomous mode is on.` };
    const waiting = Array.isArray(row.approvals) ? row.approvals.length : 0;
    return { status: 200, reply: `**${row.title}** (sent ${String(row.created_at).slice(0, 16).replace('T', ' ')} UTC)${waiting ? `, ${waiting} item${waiting === 1 ? '' : 's'} waiting for your approval` : ''}. The full report is in the card below and in the media library as a PDF.`, toolResults: [reportCardResult(row)], markdown: row.markdown };
  } catch (e) {
    return { status: 200, reply: e && /not configured/.test(e.message) ? e.message : 'Reports could not be read right now (is supabase/migrations/20261113120000_pg1_operator.sql applied?).' };
  }
}
