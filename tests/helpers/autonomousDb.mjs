// An in-memory stand-in for pg1_autonomous_state and pg1_autonomous_actions
// (supabase/migrations/20261104120000_pg1_autonomous.sql), answering the
// PostgREST calls lib/autonomous/state.mjs makes. Other paths go to `other`
// (or 404). `now` drives the default `at` of new rows.

import crypto from 'node:crypto';

export function createAutonomousDb({ now = () => Date.now(), other = null } = {}) {
  const db = { state: null, actions: [] };
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  const DEFAULT = { id: 'global', enabled: false, changed_at: null, changed_by: 'operator', reason: null, max_actions_per_hour: 30, daily_budget_usd: 0 };
  const filterRows = (params) => {
    let rows = [...db.actions];
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
      const [op, ...rest] = v.split('.');
      const val = rest.join('.');
      if (op === 'eq') rows = rows.filter((r) => String(r[k]) === val);
      if (op === 'gte') rows = rows.filter((r) => String(r[k]) >= val);
      if (op === 'lt') rows = rows.filter((r) => String(r[k]) < val);
      if (op === 'in') { const set = val.replace(/^\(|\)$/g, '').split(','); rows = rows.filter((r) => set.includes(String(r[k]))); }
    }
    rows.sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : b.seq - a.seq));
    const limit = Number(params.get('limit'));
    return limit ? rows.slice(0, limit) : rows;
  };
  let seq = 0;
  db.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (u.pathname === '/rest/v1/pg1_autonomous_state') {
      if (method === 'GET') return json(db.state ? [db.state] : []);
      if (method === 'POST') { db.state = { ...DEFAULT, ...(db.state || {}), ...body }; return json([db.state], 201); }
    }
    if (u.pathname === '/rest/v1/pg1_autonomous_actions') {
      if (method === 'GET') return json(filterRows(u.searchParams));
      if (method === 'POST') {
        const row = { id: crypto.randomUUID(), at: new Date(now()).toISOString(), seq: ++seq, cost_usd: 0, link: null, finished_at: null, approval: null, reason: null, inputs_summary: null, result: null, ...body };
        db.actions.push(row);
        return json([row], 201);
      }
      if (method === 'PATCH') {
        const rows = filterRows(u.searchParams);
        for (const r of rows) Object.assign(r, body);
        return json(rows);
      }
    }
    if (other) return other(url, opts);
    return json({ message: 'not found' }, 404);
  };
  return db;
}
