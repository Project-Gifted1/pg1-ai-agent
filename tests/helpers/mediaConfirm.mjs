// The confirm-budget step (lib/mediaBudget.mjs) in tests that drive
// /image, /video or /music through api/chat.mjs: an in-memory
// pending_actions table for the stand-in fetch, and a run wrapper that
// presses Confirm on a budget proposal so a test about what happens after
// the start sees it (tests/spend-gaps.test.mjs checks the step itself).

const rows = new Map();
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

export function resetPendingActions() { rows.clear(); }

// [needle, handler] for a fetch stand-in's route list.
export function pendingActionsRoute() {
  return ['/rest/v1/pending_actions', (u, o = {}) => {
    const token = (/token=eq\.([^&]+)/.exec(String(u)) || [])[1];
    const method = String(o.method || 'GET').toUpperCase();
    const body = typeof o.body === 'string' ? JSON.parse(o.body) : o.body;
    if (method === 'POST') { for (const r of [].concat(body)) rows.set(r.token, { ...r }); return new Response('', { status: 201 }); }
    if (method === 'PATCH') { const t = decodeURIComponent(token || ''); if (rows.has(t)) rows.set(t, { ...rows.get(t), ...body }); return json([]); }
    const t = decodeURIComponent(token || '');
    return json(rows.has(t) ? [rows.get(t)] : []);
  }];
}

// The MEDIA_BUDGET token a response carries (JSON or streamed), or null.
export function budgetToken(res) {
  const text = JSON.stringify(res.jsonBody || null) + (res.body ? JSON.stringify(res.body) : '') + (Array.isArray(res.chunks) ? res.chunks.join('') : '');
  if (!/confirm the budget for this/.test(text)) return null;
  const m = /pendingApproval\\?"\s*:\s*\{\\?"token\\?"\s*:\s*\\?"([0-9a-f-]{36})/.exec(text);
  return m ? m[1] : null;
}

// run(body) -> the response; a budget proposal is confirmed with the same
// credentials (and the same stream flag), and the Confirm's response is
// returned instead.
export function withConfirm(run) {
  return async (body) => {
    const res = await run(body);
    const token = body && body.confirm === false ? null : budgetToken(res);
    if (!token) return res;
    const { multiFiles, ...rest } = body;
    return run({ ...rest, prompt: `/approve ${token}` });
  };
}
