// "Fix it" on a failure card (public/index.html), or /fix <request id>:
// PG1 asks before fixing. The command finds the logged failure for that
// request (pg1_errors, written under the reply's request ID) and proposes
// the self-healing diagnosis as an approval card. Approve runs it
// (lib/autonomous/capabilities.mjs selfHeal: free engines only, a DRAFT
// pull request with the report and, when one is safe, a proposed fix);
// decline drops it. PG1 never merges, and never runs this on its own:
// without the operator's approve, only Autonomous mode (ON, within its
// rules) queues self-healing for production errors (lib/autonomous/runner).

import { selfHeal } from '../autonomous/capabilities.mjs';
import { scrub, scrubBody } from '../autonomous/state.mjs';

export const FIX_ACTION = 'SELF_HEAL_FIX';
const REQUEST_ID_RE = /^[a-z0-9]{6,40}$/i;

export function isFixCommand(text) {
  return /^\/fix(?:\s|$)/i.test(String(text || '').trim());
}
export function isFixAction(actionType) {
  return actionType === FIX_ACTION;
}

async function findFailure({ supUrl, supKey, fetchImpl, requestId }) {
  const res = await fetchImpl(`${supUrl}/rest/v1/pg1_errors?request_id=eq.${encodeURIComponent(requestId)}&select=id,route,status,reason,category,message,count,last_seen&order=last_seen.desc&limit=1`, {
    headers: { apikey: supKey, Authorization: `Bearer ${supKey}` }, cache: 'no-store'
  });
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// /fix <request id>: { reply, pendingApproval? }. storePending(plan, summary)
// resolves to { ok, token, expiresAt } (api/chat.mjs storePendingAction).
export async function handleFixCommand({ text, supUrl, supKey, fetchImpl = globalThis.fetch, storePending }) {
  const id = String(text || '').trim().split(/\s+/)[1] || '';
  if (!REQUEST_ID_RE.test(id)) return { reply: 'Say which failed request to fix: /fix <request id> (the ID under the failure, or tap Fix it on its card).' };
  if (!supUrl || !supKey) return { reply: 'The error log is not configured on this deployment, so there is nothing to diagnose from.' };
  let row = null;
  try { row = await findFailure({ supUrl, supKey, fetchImpl, requestId: id }); } catch (e) { row = null; }
  if (!row) return { reply: `No logged failure for request ${id}: it may have been grouped with a later one of the same kind. The error log in the ➕ menu lists them, each with its FIX button.` };
  const summary = `${scrub(row.route || '', 40)} ${row.status || ''} ${scrub(row.reason || '', 80)}`.replace(/\s+/g, ' ').trim();
  const plan = { kind: 'runtime', ref: row.id, request_id: id, summary, logs: scrubBody(`route=${row.route} status=${row.status} reason=${row.reason} category=${row.category || ''} count=${row.count}\n${row.message || ''}`).slice(0, 4000) };
  const stored = await storePending(plan, `Self-healing for request ${id}: ${summary}`);
  if (!stored || !stored.ok) return { reply: 'The fix proposal could not be saved right now, so nothing was started. Try again in a moment.' };
  return {
    reply: `Fix request ${id} (${summary})?\nApprove runs the self-healing diagnosis on the free engines and opens a **draft** pull request with the report and, when one is safe, a proposed fix. PG1 never merges it: you review and merge. Decline leaves it as it is.`,
    pendingApproval: { token: stored.token, expiresAt: stored.expiresAt instanceof Date ? stored.expiresAt.toISOString() : stored.expiresAt }
  };
}

// Approve or decline a SELF_HEAL_FIX card: { reply, resolution }.
export async function handleFixApproval({ row, decision, env = process.env, fetchImpl = globalThis.fetch, heal = selfHeal }) {
  if (decision !== 'approve') return { reply: 'Left as it is: no diagnosis ran and nothing was opened.', resolution: 'declined' };
  const plan = row && row.plan ? row.plan : {};
  const out = await heal({ env, fetchImpl, event: { kind: 'runtime', ref: String(plan.ref || ''), summary: String(plan.summary || ''), logs: String(plan.logs || '') } });
  const tail = out && out.link ? `\n${out.link}` : '';
  return { reply: `${out && out.ok ? 'Self-healing ran' : 'Self-healing could not finish'}: ${(out && out.result) || 'no result'}${tail}`, resolution: 'approved' };
}
