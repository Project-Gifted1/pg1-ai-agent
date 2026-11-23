// Storage for the operator loop (lib/operator): the reports
// (pg1_operator_reports) and the tasks made from their findings
// (pg1_operator_tasks), supabase/migrations/20261113120000_pg1_operator.sql.
// Service role only. Text fields are scrubbed (no keys, emails, phones).

import { scrub, scrubDeep } from '../autonomous/state.mjs';

export const REPORTS_TABLE = 'pg1_operator_reports';
export const TASKS_TABLE = 'pg1_operator_tasks';
export const TASK_KINDS = Object.freeze(['fix', 'improve', 'new', 'listing', 'pricing']);
export const OPEN_TASK_STATUSES = Object.freeze(['open', 'lab_running', 'pr_open', 'watching', 'needs_approval', 'approved']);

// A report card is card > sections[] > section > groups[] > group > rows[] >
// row > field: a row's fields sit at depth 7. scrubDeep's default depth (4)
// stored every group's rows and empty text as null, so a reloaded card
// showed only its section titles (the 22 Nov daily report). Text is still
// scrubbed (keys, emails, phones); only the depth limit differs.
export const REPORT_CARD_DEPTH = 8;
export function scrubReportCard(card) {
  return scrubDeep(card && typeof card === 'object' ? card : {}, [], 0, REPORT_CARD_DEPTH);
}

// A card saved before that fix: some group's rows came back null. Its
// sections cannot be rebuilt, so the reader shows the report's full text.
export function reportCardDamaged(card) {
  const sections = card && Array.isArray(card.sections) ? card.sections : [];
  return sections.some((s) => !s || !Array.isArray(s.groups) || s.groups.some((g) => !g || !Array.isArray(g.rows)));
}

// The card as every reader shows it (the chat inbox, /report, the home
// screen): the stored card with the row's approvals; a damaged card loses
// its empty sections and says the full report is in the text.
export function reportCardFromRow(row) {
  const card = row && row.card && typeof row.card === 'object' ? row.card : {};
  const approvals = Array.isArray(row && row.approvals) ? row.approvals : [];
  if (!reportCardDamaged(card)) return { card: { ...card, approvals }, damaged: false };
  return { card: { title: card.title || 'Report', sections: [], approvals, ...(card.approvals_status ? { approvals_status: card.approvals_status } : {}), note: 'This card was saved incomplete (before the fix of 23 Nov 2026); the full report is in the text above and in the PDF.' }, damaged: true };
}

function headers(supKey, extra = {}) {
  return { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...extra };
}

export function createOperatorStore({ supUrl, supKey, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  if (!supUrl || !supKey) throw new Error('The operator loop needs the vault (Supabase), which is not configured on this deployment.');
  const rest = async (path, options = {}) => {
    const res = await fetchImpl(`${supUrl}/rest/v1/${path}`, { ...options, headers: headers(supKey, options.headers), cache: 'no-store' });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`operator storage ${res.status}`), { status: res.status });
    return text ? JSON.parse(text) : null;
  };
  const one = (r) => (Array.isArray(r) ? r[0] || null : r);
  const iso = () => new Date(now()).toISOString();
  return {
    // --- reports
    async addReport(row) {
      return one(await rest(`${REPORTS_TABLE}?select=*`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...row, title: scrub(row.title, 200), card: scrubReportCard(row.card), approvals: scrubDeep(row.approvals || [], [], 0, REPORT_CARD_DEPTH) }) }));
    },
    async updateReport(id, patch) {
      return one(await rest(`${REPORTS_TABLE}?id=eq.${id}&select=id`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) }));
    },
    async latestReport(kind) {
      return one(await rest(`${REPORTS_TABLE}?select=*&kind=eq.${kind === 'weekly' ? 'weekly' : 'daily'}&order=created_at.desc&limit=1`));
    },
    async reportSince(kind, sinceIso) {
      return one(await rest(`${REPORTS_TABLE}?select=id,created_at&kind=eq.${kind}&created_at=gte.${encodeURIComponent(sinceIso)}&limit=1`));
    },
    async undeliveredReports(limit = 5) {
      const rows = await rest(`${REPORTS_TABLE}?select=id,created_at,kind,title,markdown,card,approvals&delivered_at=is.null&order=created_at.asc&limit=${limit}`);
      return Array.isArray(rows) ? rows : [];
    },
    async ackReports(ids) {
      const list = (ids || []).filter((x) => /^[0-9a-f-]{36}$/i.test(String(x))).slice(0, 10);
      if (!list.length) return 0;
      await rest(`${REPORTS_TABLE}?id=in.(${list.join(',')})`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ delivered_at: iso() }) });
      return list.length;
    },
    // --- tasks
    async listTasks({ statuses = null, limit = 100, sinceIso = null } = {}) {
      const q = ['select=*', 'order=updated_at.desc', `limit=${Math.max(1, Math.min(500, limit))}`];
      if (statuses) q.push(`status=in.(${statuses.join(',')})`);
      if (sinceIso) q.push(`updated_at=gte.${encodeURIComponent(sinceIso)}`);
      const rows = await rest(`${TASKS_TABLE}?${q.join('&')}`);
      return Array.isArray(rows) ? rows : [];
    },
    async getTask(id) {
      const s = String(id || '').toLowerCase();
      if (/^[0-9a-f-]{36}$/.test(s)) return one(await rest(`${TASKS_TABLE}?select=*&id=eq.${s}`));
      if (!/^[0-9a-f]{8}$/.test(s)) return null;
      const hit = (await this.listTasks({ limit: 500 })).filter((t) => t.id.startsWith(s));
      return hit.length === 1 ? hit[0] : null;
    },
    async taskByKey(key) {
      return one(await rest(`${TASKS_TABLE}?select=*&finding_key=eq.${encodeURIComponent(key)}`));
    },
    async addTask(row) {
      return one(await rest(`${TASKS_TABLE}?select=*`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...row, title: scrub(row.title, 200), evidence: scrubDeep(row.evidence || {}), detail: row.detail ? scrub(row.detail, 1000) : null }) }));
    },
    async updateTask(id, patch) {
      const p = { ...patch, updated_at: iso() };
      if ('detail' in p && p.detail) p.detail = scrub(p.detail, 1000);
      if ('approval' in p && p.approval) p.approval = scrubDeep(p.approval);
      return one(await rest(`${TASKS_TABLE}?id=eq.${id}&select=*`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(p) }));
    },
    // Auto-merges since a time (for the daily cap): rolled back ones count.
    async autoMergesSince(sinceIso) {
      const rows = await rest(`${TASKS_TABLE}?select=id,status,merged_at&auto_merged=is.true&merged_at=gte.${encodeURIComponent(sinceIso)}&limit=50`);
      return Array.isArray(rows) ? rows : [];
    }
  };
}
