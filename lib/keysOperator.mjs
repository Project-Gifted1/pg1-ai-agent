// The operator's commands for free-key deletion requests (1.23.0):
//
//   /keys delete-requests                     the requests waiting (id, age)
//   /keys delete-request <id> approve         delete that email's keys, email
//                                             and usage counts now
//   /keys delete-request <id> decline         close it without deleting
//
// A request is made at /keys with only an email (lib/keysApi.mjs): it is never
// carried out there, because anyone can type an email. The operator acts on
// it within 30 days (the page's promise). No email is ever shown: requests
// are stored by email hash.

import { createSupabaseKeyStore, performDeletionRequest } from './apiKeys.mjs';

const DAY = 24 * 60 * 60 * 1000;
export const DELETION_DUE_DAYS = 30;

export function isKeysCommand(text) {
  return /^\/keys(?:\s|$)/i.test(String(text || '').trim());
}

export function parseKeysCommand(text) {
  const t = String(text || '').trim();
  let m = /^\/keys\s+delete-requests\s*$/i.exec(t);
  if (m) return { sub: 'list' };
  m = /^\/keys\s+delete-request\s+([0-9a-f-]{8,36})\s+(approve|decline)\s*$/i.exec(t);
  if (m) return { sub: 'decide', id: m[1].toLowerCase(), decision: m[2].toLowerCase() };
  return { sub: 'help' };
}

const daysOld = (iso, now) => Math.floor((now - Date.parse(iso)) / DAY);

export async function handleKeysCommand({ text, isOperator = false, supUrl, supKey, fetchImpl = globalThis.fetch, store = null, now = Date.now() }) {
  if (isOperator !== true) return { status: 401, reply: '[AGENT] Key deletion requests are for the signed-in operator only.' };
  const s = store || (supUrl && supKey ? createSupabaseKeyStore({ supUrl, supKey, fetchImpl }) : null);
  if (!s) return { status: 200, reply: 'Keys need the vault (Supabase), which is not configured on this deployment.' };
  const cmd = parseKeysCommand(text);
  try {
    if (cmd.sub === 'help') return { status: 200, reply: 'Use /keys delete-requests, or /keys delete-request <id> approve|decline.' };
    const pending = await s.listDeletionRequests({ status: 'pending' });
    if (cmd.sub === 'list') {
      if (!pending.length) return { status: 200, reply: 'No key deletion requests are waiting.' };
      const lines = pending.map((r) => { const d = daysOld(r.created_at, now); const left = DELETION_DUE_DAYS - d; return `- \`${r.id.slice(0, 8)}\` · asked ${d} day${d === 1 ? '' : 's'} ago · ${left > 0 ? `due in ${left} day${left === 1 ? '' : 's'}` : '**overdue**'}`; });
      return { status: 200, reply: `**Key deletion requests (${pending.length})**, made with an email but not the key. Approve deletes that email's keys, the email and its usage counts.\n${lines.join('\n')}\n\n/keys delete-request <id> approve (or decline)` };
    }
    const hit = pending.filter((r) => r.id.startsWith(cmd.id));
    if (hit.length !== 1) return { status: 200, reply: hit.length ? 'That id matches more than one request: give more of it.' : 'No waiting request has that id (/keys delete-requests lists them).' };
    const r = hit[0];
    if (cmd.decision === 'decline') {
      await s.updateDeletionRequest(r.id, { status: 'declined', decided_at: new Date(now).toISOString() });
      return { status: 200, reply: `Declined \`${r.id.slice(0, 8)}\`. Nothing was deleted.` };
    }
    const out = await performDeletionRequest(s, r);
    return { status: 200, reply: `Done \`${r.id.slice(0, 8)}\`: ${out.deleted} key${out.deleted === 1 ? '' : 's'}, the email and its usage counts deleted.` };
  } catch (e) {
    return { status: 200, reply: 'Key deletion requests could not be read right now (is supabase/migrations/20261123130000_pg1_key_deletion_requests.sql applied?).' };
  }
}

// For the daily report: the requests waiting, and how many are due within 7 days or overdue.
export async function pendingDeletionSummary({ supUrl, supKey, fetchImpl = globalThis.fetch, store = null, now = Date.now() }) {
  const s = store || createSupabaseKeyStore({ supUrl, supKey, fetchImpl });
  if (!s) throw Object.assign(new Error('x'), { reason: 'storage is not configured' });
  const list = await s.listDeletionRequests({ status: 'pending' });
  const due = list.filter((r) => DELETION_DUE_DAYS - daysOld(r.created_at, now) <= 7).length;
  const overdue = list.filter((r) => daysOld(r.created_at, now) >= DELETION_DUE_DAYS).length;
  return { count: list.length, due, overdue, ids: list.slice(0, 10).map((r) => r.id.slice(0, 8)) };
}
