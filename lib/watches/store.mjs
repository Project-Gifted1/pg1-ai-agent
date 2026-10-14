// Storage for watches, their reports and the operator's push devices
// (supabase/migrations/20261028120000_pg1_watches.sql). Service role only;
// every caller has already checked the operator's session or a signed
// event.

import { TARGET_TYPES, WATCH_TTL_MS, DEFAULT_REPORT_ON, validTarget } from './targets.mjs';

export const WATCH_TABLE = 'pg1_watches';
export const REPORT_TABLE = 'pg1_watch_reports';
export const PUSH_TABLE = 'pg1_push_subscriptions';
export const THREAD_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WATCH_COLUMNS = 'id,created_at,updated_at,expires_at,target_type,target_id,label,origin_thread,report_on,source,status,last_state,last_checked_at,closed_at';

export function cleanThreadKey(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return THREAD_KEY_RE.test(s) ? s : null;
}

const oneLine = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export function createWatchStore({ supUrl, supKey, fetchImpl = globalThis.fetch }) {
  if (!supUrl || !supKey) throw new Error('Watches need the vault (Supabase), which is not configured on this deployment.');
  const rest = async (path, options = {}) => {
    const res = await fetchImpl(`${supUrl}/rest/v1/${path}`, {
      ...options,
      headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
      cache: 'no-store'
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`watch storage ${res.status}`), { status: res.status });
    return text ? JSON.parse(text) : null;
  };
  const one = (r) => (Array.isArray(r) ? r[0] || null : r);
  const enc = encodeURIComponent;

  const store = {
    async openFor(type, id) {
      if (!TARGET_TYPES.includes(type)) return null;
      return one(await rest(`${WATCH_TABLE}?select=${WATCH_COLUMNS}&target_type=eq.${type}&target_id=eq.${enc(id)}&status=eq.open&limit=1`));
    },
    // One open watch per target: a second request for the same target
    // returns the open one (and fills in the thread if it had none).
    // Resolves to { watch, created }.
    async create({ type, id, label = '', originThread = null, reportOn = null, source = 'operator', lastState = null, now = Date.now() }) {
      if (!validTarget(type, id)) throw Object.assign(new Error('not a watchable target'), { badTarget: true });
      const thread = cleanThreadKey(originThread);
      const existing = await store.openFor(type, id);
      if (existing) {
        if (thread && !existing.origin_thread) return { watch: (await store.update(existing.id, { origin_thread: thread })) || existing, created: false };
        return { watch: existing, created: false };
      }
      const row = {
        target_type: type, target_id: id, label: oneLine(label, 200) || null, origin_thread: thread,
        report_on: reportOn === 'changes' || reportOn === 'finish' ? reportOn : DEFAULT_REPORT_ON[type],
        source: source === 'auto' ? 'auto' : 'operator', status: 'open', last_state: lastState ? oneLine(lastState, 40) : null,
        expires_at: new Date(now + WATCH_TTL_MS[type]).toISOString()
      };
      try {
        return { watch: one(await rest(`${WATCH_TABLE}?select=${WATCH_COLUMNS}`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) })), created: true };
      } catch (err) {
        // Two requests at once: the unique index kept one; return it.
        const again = await store.openFor(type, id);
        if (again) return { watch: again, created: false };
        throw err;
      }
    },
    async get(idOrPrefix) {
      const s = String(idOrPrefix || '').toLowerCase();
      if (THREAD_KEY_RE.test(s)) return one(await rest(`${WATCH_TABLE}?select=${WATCH_COLUMNS}&id=eq.${s}`));
      if (!/^[0-9a-f]{8}$/.test(s)) return null;
      const rows = (await store.list({ limit: 100, includeClosed: true })).filter((r) => r.id.startsWith(s));
      return rows.length === 1 ? rows[0] : null;
    },
    async list({ limit = 20, includeClosed = false } = {}) {
      const rows = await rest(`${WATCH_TABLE}?select=${WATCH_COLUMNS}${includeClosed ? '' : '&status=eq.open'}&order=created_at.desc&limit=${Math.max(1, Math.min(100, limit))}`);
      return Array.isArray(rows) ? rows : [];
    },
    async update(id, patch) {
      return one(await rest(`${WATCH_TABLE}?id=eq.${id}&select=${WATCH_COLUMNS}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) }));
    },
    // Moves an open watch to `state` only if it is not there already.
    // true when this caller made the move (and so writes the report).
    async claimState(id, state, now = Date.now()) {
      const s = String(state).replace(/[^a-z_]/g, '').slice(0, 40);
      if (!s) return false;
      const rows = await rest(`${WATCH_TABLE}?id=eq.${id}&status=eq.open&or=(last_state.is.null,last_state.neq.${s})&select=id`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ last_state: s, last_checked_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() }) });
      return Array.isArray(rows) && rows.length > 0;
    },
    async close(id, status, now = Date.now()) {
      return store.update(id, { status, closed_at: new Date(now).toISOString() });
    },

    // --- reports
    async addReport(row) {
      return one(await rest(`${REPORT_TABLE}?select=id,created_at,origin_thread,target_type,target_id,state,title,body,actions`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) }));
    },
    async markPushed(id, n) {
      await rest(`${REPORT_TABLE}?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ push_sent: Math.max(0, n | 0) }) });
    },
    // Reports no screen has shown yet, for these threads plus the ones with
    // no thread (production deploys, watches made outside a chat).
    async inbox(threadKeys = [], limit = 20) {
      const keys = (Array.isArray(threadKeys) ? threadKeys : []).map(cleanThreadKey).filter(Boolean).slice(0, 4);
      const where = keys.length ? `&or=(origin_thread.is.null,${keys.map((k) => `origin_thread.eq.${k}`).join(',')})` : '&origin_thread=is.null';
      const rows = await rest(`${REPORT_TABLE}?select=id,created_at,origin_thread,target_type,target_id,state,title,body,actions&delivered_at=is.null${where}&order=created_at.asc&limit=${Math.max(1, Math.min(50, limit))}`);
      return Array.isArray(rows) ? rows : [];
    },
    async ack(ids = [], now = Date.now()) {
      const list = (Array.isArray(ids) ? ids : []).map((x) => String(x || '').toLowerCase()).filter((x) => THREAD_KEY_RE.test(x)).slice(0, 50);
      if (!list.length) return 0;
      const rows = await rest(`${REPORT_TABLE}?id=in.(${list.join(',')})&delivered_at=is.null&select=id`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ delivered_at: new Date(now).toISOString() }) });
      return Array.isArray(rows) ? rows.length : 0;
    },

    // --- push devices
    async subscriptions() {
      const rows = await rest(`${PUSH_TABLE}?select=id,endpoint,p256dh,auth,failures&order=created_at.desc&limit=20`);
      return Array.isArray(rows) ? rows : [];
    },
    async addSubscription({ endpoint, p256dh, auth, label = '' }) {
      const body = { endpoint, p256dh, auth, label: oneLine(label, 60) || null, failures: 0 };
      return one(await rest(`${PUSH_TABLE}?on_conflict=endpoint&select=id`, { method: 'POST', headers: { Prefer: 'return=representation,resolution=merge-duplicates' }, body: JSON.stringify(body) }));
    },
    async removeSubscription(endpoint) {
      const rows = await rest(`${PUSH_TABLE}?endpoint=eq.${enc(endpoint)}&select=id`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
      return Array.isArray(rows) ? rows.length : 0;
    },
    // After one send: 'ok' resets the count, 'gone' (the browser dropped
    // the subscription: 404/410) removes the device, 'failed' counts up and
    // removes it at the fifth failure in a row.
    async subscriptionResult(sub, outcome, now = Date.now()) {
      const where = `${PUSH_TABLE}?id=eq.${sub.id}`;
      if (outcome === 'ok') return rest(where, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ last_ok_at: new Date(now).toISOString(), failures: 0 }) });
      if (outcome === 'gone' || (Number(sub.failures) || 0) + 1 >= 5) return rest(where, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return rest(where, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ failures: (Number(sub.failures) || 0) + 1 }) });
    }
  };
  return store;
}
