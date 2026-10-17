// /api/watches: the page's side of watches and reports (lib/watches).
// Signed-in operator only, like api/threads.mjs: the same credentials,
// lockout and least-privilege rule (lib/operatorSession.mjs); anyone else
// gets 401 and never reaches a table. POST with an op:
//
//   { op: 'inbox', threadKeys }        reports no screen has shown yet, for
//                                      these threads and for none
//   { op: 'ack', ids }                 marks reports as shown
//   { op: 'list' }                     the open watches
//   { op: 'stop', id }                 stops one
//   { op: 'vapid' }                    the VAPID public key (null when push
//                                      is not set up)
//   { op: 'subscribe', subscription, label? }
//                                      stores this device's push
//                                      subscription (endpoint and its two
//                                      public keys, as the browser gives them)
//   { op: 'unsubscribe', endpoint }    removes it
//   { op: 'test', subscription }       stores this device again (the same
//                                      upsert as subscribe) and sends one
//                                      test notification to it only;
//                                      answers { sent: 0 | 1 }
//
//   { op: 'auto_state' }               Autonomous mode: { enabled,
//                                      todayCount, pendingApprovals,
//                                      changedBy, reason } (the header)
//   { op: 'auto_set', enabled }        switches it ON or OFF (OFF cancels
//                                      queued actions; running ones stop at
//                                      their next safe checkpoint)
//   { op: 'auto_log', before?, limit? } the audit timeline, newest first
//
// Failures are neutral: no Supabase detail reaches the page.

import { getSupabaseCreds } from '../lib/supabase.mjs';
import { resolveOperatorSession } from '../lib/operatorSession.mjs';
import { createWatchStore } from '../lib/watches/store.mjs';
import { vapidKeys, pushToOperator } from '../lib/watches/push.mjs';
import { createAutonomousStore, switchOn, switchOff, todaySummary, ACTION_TYPES } from '../lib/autonomous/state.mjs';

export const config = { maxDuration: 15 };

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;
const requestsByIp = new Map();
export function __clearWatchesRateLimitState() { requestsByIp.clear(); }

function isRateLimited(ip) {
  const now = Date.now();
  const entry = requestsByIp.get(ip);
  if (!entry || entry.windowStart + RATE_LIMIT_WINDOW_MS < now) {
    requestsByIp.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

function clientIp(req) {
  const f = req.headers && req.headers['x-forwarded-for'];
  if (f) { const first = String(f).split(',')[0].trim(); if (first) return first; }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
// A browser push subscription: an https endpoint and the p256dh / auth
// keys. Anything else is refused.
export function cleanSubscription(sub) {
  if (!sub || typeof sub !== 'object') return null;
  const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint.trim() : '';
  const keys = sub.keys && typeof sub.keys === 'object' ? sub.keys : {};
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
  const auth = typeof keys.auth === 'string' ? keys.auth.trim() : '';
  let url;
  try { url = new URL(endpoint); } catch (e) { return null; }
  if (url.protocol !== 'https:' || endpoint.length > 1000) return null;
  if (!B64URL.test(p256dh) || p256dh.length < 40 || p256dh.length > 200) return null;
  if (!B64URL.test(auth) || auth.length < 8 || auth.length > 100) return null;
  return { endpoint, p256dh, auth };
}

const TEST_TITLE = 'PG1 test notification';
const TEST_BODY = 'Notifications work on this device.';

// AUTONOMOUS MODE (lib/autonomous/state.mjs): the header switch and its
// timeline. Rows go out as stored (already scrubbed); never a Supabase detail.
const TIMELINE_FIELDS = ['id', 'at', 'type', 'reason', 'inputs_summary', 'status', 'result', 'cost_usd', 'link', 'finished_at'];
export function timelineRow(r) {
  const out = {};
  for (const k of TIMELINE_FIELDS) out[k] = r[k] ?? null;
  out.label = ACTION_TYPES[r.type] || r.type;
  return out;
}
async function autonomousOp(body, res, store) {
  if (body.op === 'auto_state') {
    const state = await store.getState();
    const today = state.error ? { count: 0, pendingApprovals: 0, costUsd: 0 } : await todaySummary(store);
    return res.status(200).json({ ok: true, autonomous: { enabled: state.enabled === true, available: !state.error, todayCount: today.count, pendingApprovals: today.pendingApprovals, costUsd: Math.round(today.costUsd * 100) / 100, changedBy: state.changed_by, changedAt: state.changed_at, reason: state.reason, maxPerHour: state.max_actions_per_hour, dailyBudgetUsd: Number(state.daily_budget_usd) || 0 } });
  }
  if (body.op === 'auto_set') {
    if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'bad_request', message: 'enabled must be true or false' });
    if (body.enabled) await switchOn(store); else await switchOff(store, { by: 'operator', reason: 'Switched off by the operator' });
    const state = await store.getState();
    if (body.enabled && !state.enabled) return res.status(503).json({ error: 'unavailable', message: 'Autonomous mode is not set up on this deployment yet, so it stays OFF.' });
    return res.status(200).json({ ok: true, autonomous: { enabled: state.enabled === true } });
  }
  if (body.op === 'auto_log') {
    const before = typeof body.before === 'string' && !Number.isNaN(Date.parse(body.before)) ? new Date(body.before).toISOString() : null;
    const rows = await store.listActions({ limit: Math.max(1, Math.min(100, Number(body.limit) || 50)), before });
    return res.status(200).json({ ok: true, actions: rows.map(timelineRow) });
  }
  return res.status(400).json({ error: 'bad_request', message: 'Unknown autonomous op' });
}

// webpushImpl is for tests; the deployment loads web-push itself.
export function createWatchesHandler({ webpushImpl = null } = {}) {
  return async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
    if (isRateLimited(clientIp(req))) return res.status(429).json({ error: 'Too many requests, please slow down.' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
    if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid JSON body' });
    req.body = body;
    const session = resolveOperatorSession(req);
    if (session.rateLimited) return res.status(429).json({ error: 'Too many failed sign-in attempts. Try again later.' });
    if (!session.isOperator) return res.status(401).json({ error: 'unauthorized', message: 'Watches and reports are for the signed-in operator only.' });

    if (body.op === 'vapid') {
      const keys = vapidKeys();
      return res.status(200).json({ ok: true, publicKey: keys ? keys.publicKey : null });
    }

    let store;
    try {
      const { supUrl, supKey } = getSupabaseCreds();
      store = createWatchStore({ supUrl, supKey });
    } catch (e) {
      return res.status(503).json({ error: 'unavailable', message: 'Watches are not available on this deployment.' });
    }

    try {
      if (typeof body.op === 'string' && body.op.startsWith('auto_')) {
        const { supUrl, supKey } = getSupabaseCreds();
        return await autonomousOp(body, res, createAutonomousStore({ supUrl, supKey }));
      }
      if (body.op === 'inbox') {
        const reports = await store.inbox(Array.isArray(body.threadKeys) ? body.threadKeys : []);
        return res.status(200).json({ ok: true, reports });
      }
      if (body.op === 'ack') {
        return res.status(200).json({ ok: true, acknowledged: await store.ack(body.ids) });
      }
      if (body.op === 'list') {
        return res.status(200).json({ ok: true, watches: await store.list({ limit: 50 }) });
      }
      if (body.op === 'stop') {
        const w = await store.get(typeof body.id === 'string' ? body.id : '');
        if (!w) return res.status(404).json({ error: 'not_found', message: 'There is no such watch.' });
        if (w.status !== 'open') return res.status(200).json({ ok: true, watch: w });
        return res.status(200).json({ ok: true, watch: await store.close(w.id, 'stopped') });
      }
      if (body.op === 'subscribe') {
        if (!vapidKeys()) return res.status(503).json({ error: 'unavailable', message: 'Push notifications are not set up on this deployment.' });
        const sub = cleanSubscription(body.subscription);
        if (!sub) return res.status(400).json({ error: 'bad_request', message: 'That is not a push subscription.' });
        await store.addSubscription({ ...sub, label: typeof body.label === 'string' ? body.label : '' });
        return res.status(200).json({ ok: true, subscribed: true });
      }
      if (body.op === 'test') {
        if (!vapidKeys()) return res.status(503).json({ error: 'unavailable', message: 'Push notifications are not set up on this deployment.' });
        const sub = cleanSubscription(body.subscription);
        if (!sub) return res.status(400).json({ error: 'bad_request', message: 'That is not a push subscription.' });
        const row = await store.addSubscription({ ...sub, label: typeof body.label === 'string' ? body.label : '' });
        const device = { ...sub, id: row && row.id, failures: 0 };
        const sent = await pushToOperator({ store, title: TEST_TITLE, body: TEST_BODY, url: '/', tag: 'pg1-test', webpushImpl, devices: [device] });
        return res.status(200).json({ ok: true, sent });
      }
      if (body.op === 'unsubscribe') {
        const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim().slice(0, 1000) : '';
        if (!endpoint) return res.status(400).json({ error: 'bad_request', message: 'endpoint is required' });
        return res.status(200).json({ ok: true, removed: await store.removeSubscription(endpoint) });
      }
      return res.status(400).json({ error: 'bad_request', message: `Unknown op '${typeof body.op === 'string' ? body.op.slice(0, 20) : ''}'` });
    } catch (err) {
      console.error('[WATCHES] storage failed:', err && err.status ? `status=${err.status}` : 'error');
      return res.status(502).json({ error: 'unavailable', message: 'Watches could not be reached right now.' });
    }
  };
}

export default createWatchesHandler();
