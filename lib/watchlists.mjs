// Watchlists: an agent subscribes wallets, domains, packages and CVE
// products; PG1 rechecks them and POSTs an HMAC-signed webhook when an
// item's status changes (no_flags / flagged / unknown).
//
// Paid per item per 30 days via x402 (WATCH_ITEM_PRICE_USD, at least 1.5x
// the worst-case recheck cost over the period). The recheck cron
// (api/watchlists/recheck.mjs) checks each item about once a day, at most
// RECHECK_PER_SUBSCRIBER_PER_RUN items per subscriber per run, so one
// subscriber cannot starve the others.
//
// Webhooks: https only, no private or reserved addresses, no credentials,
// no redirects (lib/netGuard.mjs), checked when subscribing and again on
// every delivery (DNS can change). Each delivery carries
//   X-PG1-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
// The secret is derived, never stored: HMAC(PG1_WATCHLIST_SECRET, id). It is
// shown once, when the watchlist is created, and also authenticates GET
// and DELETE on the watchlist.
//
// Privacy: the subscriber is a salted hash of the paying wallet; the
// targets are what the subscriber asked PG1 to watch. Watchlists are
// deleted 30 days after they expire (lib/retention.mjs).

import crypto from 'node:crypto';
import { assertPricing } from './pricing.mjs';
import { checkUrlShape, assertPublicUrl, safeFetch, UnsafeUrlError } from './netGuard.mjs';
import { planPreflight } from './preflight.mjs';

export const WATCHLIST_TABLE = 'pg1_watchlists';
export const WATCH_ITEM_TABLE = 'pg1_watch_items';
export const WATCH_KINDS = Object.freeze(['wallet', 'domain', 'package', 'cve_product']);
export const WATCH_PERIOD_DAYS = 30;
export const RECHECK_INTERVAL_HOURS = 24;
// One recheck: one or two upstream lookups (RPC/RDAP/registry/NVD).
export const RECHECK_COST_USD = 0.001;
// A webhook delivery on a status change (bounded by the rechecks).
export const WATCH_ITEM_WORST_CASE_USD = Math.round((WATCH_PERIOD_DAYS * 24 / RECHECK_INTERVAL_HOURS) * RECHECK_COST_USD * 1e6) / 1e6;
export const WATCH_ITEM_PRICE_USD = 0.05;
assertPricing([{ name: 'watchlist_item_30d', priceUsd: WATCH_ITEM_PRICE_USD, worstCaseCostUsd: WATCH_ITEM_WORST_CASE_USD }]);

export const MAX_ITEMS_PER_WATCHLIST = 50;
export const MAX_ACTIVE_WATCHLISTS_PER_SUBSCRIBER = 5;
export const RECHECK_PER_SUBSCRIBER_PER_RUN = 25;
export const RECHECK_MAX_PER_RUN = 200;
export const MAX_DELIVERY_FAILURES = 20;
export const WATCHLIST_RETENTION_DAYS = 30;
export const WEBHOOK_TIMEOUT_MS = 5000;

// Each kind is watched with the matching preflight action, so a watched
// item gets exactly the checks a preflight would run.
const KIND_ACTION = Object.freeze({ wallet: 'pay', domain: 'open', package: 'install', cve_product: 'patch' });

export class WatchlistError extends Error {
  constructor(message, { status = 400, code = 'invalid_input' } = {}) {
    super(message);
    this.watchlistError = true;
    this.status = status;
    this.code = code;
  }
}

const invalid = (m) => new WatchlistError(m);

// Validates one item into { kind, target, ecosystem?, chain? }.
export function normalizeItem(raw) {
  const it = raw && typeof raw === 'object' ? raw : {};
  const kind = String(it.kind || '').trim();
  if (!WATCH_KINDS.includes(kind)) throw invalid(`kind must be one of ${WATCH_KINDS.join(', ')}`);
  const target = String(it.target || it.value || '').trim().slice(0, 300);
  if (!target) throw invalid('each item needs a target');
  const out = { kind, target };
  if (kind === 'package') out.ecosystem = String(it.ecosystem || '');
  if (kind === 'wallet' && it.chain) out.chain = String(it.chain);
  if (kind === 'wallet' && /^https?:/i.test(target)) throw invalid('a wallet item takes a wallet address');
  if (kind === 'cve_product' && /^CVE-/i.test(target)) throw invalid('a cve_product item takes "vendor product [version]", not a CVE id');
  // planPreflight throws the same input errors preflight_check gives.
  try {
    planPreflight({ action: KIND_ACTION[kind], target, chain: out.chain, ecosystem: out.ecosystem });
  } catch (e) {
    throw invalid(`${kind} ${JSON.stringify(target.slice(0, 80))}: ${e.message}`);
  }
  return out;
}

export function normalizeItems(list) {
  if (!Array.isArray(list) || !list.length) throw invalid('items must be a non-empty array');
  if (list.length > MAX_ITEMS_PER_WATCHLIST) throw invalid(`at most ${MAX_ITEMS_PER_WATCHLIST} items per watchlist`);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const it = normalizeItem(raw);
    const key = `${it.kind}|${it.target.toLowerCase()}|${it.ecosystem || ''}|${it.chain || ''}`;
    if (!seen.has(key)) { seen.add(key); out.push(it); }
  }
  return out;
}

export function quoteWatchlist(items) {
  const n = items.length;
  return { items: n, period_days: WATCH_PERIOD_DAYS, price_usd: Math.round(n * WATCH_ITEM_PRICE_USD * 1e6) / 1e6, worst_cost_usd: Math.round(n * WATCH_ITEM_WORST_CASE_USD * 1e6) / 1e6 };
}

// The webhook URL: shape and DNS, both public.
export async function assertWebhookUrl(raw, { lookup } = {}) {
  try {
    checkUrlShape(raw);
    const { url } = await assertPublicUrl(raw, lookup ? { lookup } : {});
    return url.toString();
  } catch (e) {
    if (e instanceof UnsafeUrlError) throw invalid(`webhook_url is not allowed: ${e.message}`);
    throw e;
  }
}

export function watchlistSecret(id, env = process.env) {
  const master = String(env.PG1_WATCHLIST_SECRET || '');
  if (master.length < 32) return null;
  return crypto.createHmac('sha256', master).update(`watchlist:${id}`).digest('base64url');
}

export function signWebhook(secret, body, nowSec = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${nowSec}.${body}`).digest('hex');
  return `t=${nowSec},v1=${v1}`;
}

// For subscribers (and the SDKs): checks a delivery's signature header,
// within a tolerance window (default 5 minutes) against replays.
export function verifyWebhook(secret, body, header, { toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(header || ''));
  if (!m) return false;
  if (Math.abs(nowSec - Number(m[1])) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${m[1]}.${body}`).digest();
  const given = Buffer.from(m[2], 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const sameSecret = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

export function createWatchlistStore({ supUrl, supKey, fetchImpl = globalThis.fetch, timeoutMs = 6000 }) {
  if (!supUrl || !supKey) throw new WatchlistError('watchlists need storage', { status: 503, code: 'unavailable' });
  const rest = async (path, options = {}) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${supUrl}/rest/v1/${path}`, { ...options, headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...(options.headers || {}) }, signal: controller.signal, cache: 'no-store' });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`watchlist storage ${res.status}`), { status: res.status });
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(t);
    }
  };
  const uuid = (id) => /^[0-9a-f-]{36}$/i.test(String(id || ''));
  return {
    async create(row, items) {
      const created = await rest(`${WATCHLIST_TABLE}?select=*`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
      const w = Array.isArray(created) ? created[0] : created;
      await rest(WATCH_ITEM_TABLE, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(items.map((it) => ({ watchlist_id: w.id, kind: it.kind, target: it.target, ecosystem: it.ecosystem || null, chain: it.chain || null }))) });
      return w;
    },
    async get(id) {
      if (!uuid(id)) return null;
      const rows = await rest(`${WATCHLIST_TABLE}?select=*&id=eq.${String(id).toLowerCase()}`);
      return Array.isArray(rows) ? rows[0] || null : null;
    },
    async items(id) {
      const rows = await rest(`${WATCH_ITEM_TABLE}?select=*&watchlist_id=eq.${id}&order=created_at.asc`);
      return Array.isArray(rows) ? rows : [];
    },
    async update(id, patch) {
      await rest(`${WATCHLIST_TABLE}?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
    },
    async updateItem(id, patch) {
      await rest(`${WATCH_ITEM_TABLE}?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
    },
    async activeForSubscriber(subscriberHash, nowIso) {
      const rows = await rest(`${WATCHLIST_TABLE}?select=id&subscriber_hash=eq.${subscriberHash}&status=eq.active&expires_at=gt.${encodeURIComponent(nowIso)}`);
      return Array.isArray(rows) ? rows.length : 0;
    },
    async activeWatchlists(nowIso) {
      const rows = await rest(`${WATCHLIST_TABLE}?select=*&status=eq.active&expires_at=gt.${encodeURIComponent(nowIso)}&order=created_at.asc&limit=1000`);
      return Array.isArray(rows) ? rows : [];
    },
    async dueItems(watchlistIds, beforeIso, limit) {
      if (!watchlistIds.length) return [];
      const rows = await rest(`${WATCH_ITEM_TABLE}?select=*&watchlist_id=in.(${watchlistIds.join(',')})&or=(last_checked_at.is.null,last_checked_at.lt.${encodeURIComponent(`"${beforeIso}"`)})&order=last_checked_at.asc.nullsfirst&limit=${limit}`);
      return Array.isArray(rows) ? rows : [];
    },
    async expire(nowIso) {
      await rest(`${WATCHLIST_TABLE}?status=eq.active&expires_at=lte.${encodeURIComponent(nowIso)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'expired' }) });
    },
    async summary() {
      const rows = await rest(`${WATCHLIST_TABLE}?select=id,status,items,price_usd,created_at,expires_at,delivery_failures,last_delivery_at&order=created_at.desc&limit=200`);
      return Array.isArray(rows) ? rows : [];
    }
  };
}

// Subscribe. deps: { store, gate(priceUsd, description) -> x402 gate,
// subscriberHash(payer), screen?(payer), lookup?, env, now }.
// Returns { status: 402, paymentRequired } or { status: 201, body }.
export async function createWatchlist(input, deps) {
  const { store, gate, subscriberHash, env = process.env, now = () => Date.now(), screen = null } = deps;
  const body = input && typeof input === 'object' ? input : {};
  const items = normalizeItems(body.items);
  const webhookUrl = await assertWebhookUrl(body.webhook_url, { lookup: deps.lookup });
  if (!String(env.PG1_WATCHLIST_SECRET || '') || String(env.PG1_WATCHLIST_SECRET).length < 32) throw new WatchlistError('watchlists are not enabled on this deployment', { status: 503, code: 'unavailable' });
  const quote = quoteWatchlist(items);
  const g = await gate(quote.price_usd, `PG1 watchlist: ${quote.items} item${quote.items === 1 ? '' : 's'} for ${WATCH_PERIOD_DAYS} days`);
  if (!g.authorized) return { status: 402, paymentRequired: g.paymentRequired, quote };
  if (!g.payer) throw new WatchlistError('the payment does not name a paying wallet', { status: 402, code: 'payment_invalid' });
  if (screen) {
    const s = await screen(g.payer);
    if (s && s.refused) throw new WatchlistError(s.message || 'this wallet cannot be served', { status: 403, code: 'refused' });
  }
  const sub = subscriberHash(g.payer);
  const nowIso = new Date(now()).toISOString();
  if ((await store.activeForSubscriber(sub, nowIso)) >= MAX_ACTIVE_WATCHLISTS_PER_SUBSCRIBER) throw new WatchlistError(`at most ${MAX_ACTIVE_WATCHLISTS_PER_SUBSCRIBER} active watchlists per paying wallet`, { status: 429, code: 'limit_reached' });
  // x402: settle only once everything that can refuse has passed.
  let settled = null;
  try { settled = await g.settle(); } catch (e) { settled = null; }
  if (!settled || !settled.success) return { status: 402, paymentRequired: await g.settlementFailurePaymentRequired((settled && (settled.errorMessage || settled.errorReason)) || 'Settlement failed'), quote };
  const expiresAt = new Date(now() + WATCH_PERIOD_DAYS * 86400000).toISOString();
  const row = await store.create({ subscriber_hash: sub, webhook_url: webhookUrl, status: 'active', items: items.length, price_usd: quote.price_usd, expires_at: expiresAt, settlement_tx: (settled && settled.transaction) || null }, items);
  const secret = watchlistSecret(row.id, env);
  return {
    status: 201,
    settled,
    body: {
      id: row.id,
      secret,
      secret_note: 'Shown once. It signs every webhook (X-PG1-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>) and authenticates GET and DELETE on this watchlist (Authorization: Bearer <secret>).',
      status: 'active',
      expires_at: expiresAt,
      items,
      price_usd: quote.price_usd,
      recheck_every_hours: RECHECK_INTERVAL_HOURS
    }
  };
}

export async function authorizeWatchlist(store, id, bearer, env = process.env) {
  const w = await store.get(id);
  const secret = w ? watchlistSecret(w.id, env) : null;
  if (!w || !secret || !sameSecret(secret, bearer)) throw new WatchlistError('watchlist not found', { status: 404, code: 'not_found' });
  return w;
}

export async function watchlistView(store, w) {
  const items = await store.items(w.id);
  return {
    id: w.id,
    status: w.status,
    expires_at: w.expires_at,
    items: items.map((it) => ({ kind: it.kind, target: it.target, ...(it.ecosystem ? { ecosystem: it.ecosystem } : {}), ...(it.chain ? { chain: it.chain } : {}), status: it.last_status || 'pending', reasons: it.last_reasons || [], last_checked_at: it.last_checked_at, last_changed_at: it.last_changed_at }))
  };
}

export async function cancelWatchlist(store, w) {
  await store.update(w.id, { status: 'cancelled' });
  return { id: w.id, status: 'cancelled' };
}

export async function deliverWebhook(w, event, { env = process.env, fetchImpl = globalThis.fetch, lookup, nowSec } = {}) {
  const secret = watchlistSecret(w.id, env);
  if (!secret) return { ok: false, reason: 'no_secret' };
  const body = JSON.stringify(event);
  try {
    const res = await safeFetch(w.webhook_url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'PG1-Watchlists/1', 'X-PG1-Event': event.type, 'X-PG1-Signature': signWebhook(secret, body, nowSec) }, body }, { fetchImpl, lookup, timeoutMs: WEBHOOK_TIMEOUT_MS });
    return res.status >= 200 && res.status < 300 ? { ok: true, status: res.status } : { ok: false, status: res.status };
  } catch (e) {
    return { ok: false, reason: e instanceof UnsafeUrlError ? 'unsafe_url' : 'unreachable' };
  }
}

// One recheck run. deps: { store, runPreflight(args) -> { decision, reasons },
// env, fetchImpl, lookup, now, notify? }.
export async function recheckWatchlists(deps) {
  const { store, runPreflight, env = process.env, fetchImpl = globalThis.fetch, lookup, now = () => Date.now() } = deps;
  const nowIso = new Date(now()).toISOString();
  await store.expire(nowIso);
  const lists = await store.activeWatchlists(nowIso);
  const bySub = new Map();
  for (const w of lists) {
    if (!bySub.has(w.subscriber_hash)) bySub.set(w.subscriber_hash, []);
    bySub.get(w.subscriber_hash).push(w);
  }
  const before = new Date(now() - RECHECK_INTERVAL_HOURS * 3600000 + 10 * 60000).toISOString();
  const out = { checked: 0, changed: 0, delivered: 0, failed_deliveries: 0, subscribers: bySub.size };
  for (const [, subLists] of bySub) {
    if (out.checked >= RECHECK_MAX_PER_RUN) break;
    const byId = new Map(subLists.map((w) => [w.id, w]));
    const due = await store.dueItems([...byId.keys()], before, Math.min(RECHECK_PER_SUBSCRIBER_PER_RUN, RECHECK_MAX_PER_RUN - out.checked));
    for (const it of due) {
      const w = byId.get(it.watchlist_id);
      let decision = 'unknown';
      let reasons = [];
      try {
        const r = await runPreflight({ action: KIND_ACTION[it.kind], target: it.target, ...(it.chain ? { chain: it.chain } : {}), ...(it.ecosystem ? { ecosystem: it.ecosystem } : {}) });
        decision = r.decision;
        reasons = (r.reasons || []).map((x) => ({ code: x.code, message: x.message, check: x.check }));
      } catch (e) {
        decision = 'unknown';
      }
      out.checked++;
      const previous = it.last_status || null;
      const changed = previous !== null && previous !== decision;
      await store.updateItem(it.id, { last_status: decision, last_reasons: reasons, last_checked_at: nowIso, ...(changed || previous === null ? { last_changed_at: nowIso } : {}) });
      if (!changed) continue;
      out.changed++;
      if ((w.delivery_failures || 0) >= MAX_DELIVERY_FAILURES) continue;
      const event = { type: 'watchlist.status_changed', watchlist_id: w.id, item: { kind: it.kind, target: it.target, ...(it.ecosystem ? { ecosystem: it.ecosystem } : {}), ...(it.chain ? { chain: it.chain } : {}) }, previous_status: previous, status: decision, reasons, checked_at: nowIso };
      const d = await deliverWebhook(w, event, { env, fetchImpl, lookup });
      if (d.ok) {
        out.delivered++;
        w.delivery_failures = 0;
        await store.update(w.id, { last_delivery_at: nowIso, delivery_failures: 0 });
      } else {
        out.failed_deliveries++;
        w.delivery_failures = (w.delivery_failures || 0) + 1;
        await store.update(w.id, { delivery_failures: w.delivery_failures });
      }
    }
  }
  return out;
}

// /watchlists (operator): counts only, never a target or a webhook URL.
export function isWatchlistsCommand(text) {
  return /^\/watchlists(?:\s|$)/i.test(String(text || '').trim());
}

export async function handleWatchlistsCommand({ supUrl, supKey, fetchImpl = globalThis.fetch, isOperator = false, now = Date.now() }) {
  if (isOperator !== true) return { reply: 'Watchlist details are for the signed-in operator only.' };
  let rows;
  try {
    rows = await createWatchlistStore({ supUrl, supKey, fetchImpl }).summary();
  } catch (e) {
    return { reply: 'The watchlists could not be read right now.' };
  }
  const nowIso = new Date(now).toISOString();
  const active = rows.filter((r) => r.status === 'active' && r.expires_at > nowIso);
  const items = active.reduce((n, r) => n + (Number(r.items) || 0), 0);
  const revenue = rows.filter((r) => r.created_at >= new Date(now - 30 * 86400000).toISOString()).reduce((n, r) => n + (Number(r.price_usd) || 0), 0);
  const failing = active.filter((r) => (r.delivery_failures || 0) >= 3).length;
  return {
    reply: [
      '### [ WATCHLISTS ]',
      `- Active watchlists: ${active.length} (${items} item${items === 1 ? '' : 's'})`,
      `- Sold in the last 30 days: $${revenue.toFixed(2)}`,
      `- Webhooks failing (3+ in a row): ${failing}`,
      `- Expired or cancelled (kept ${WATCHLIST_RETENTION_DAYS} days): ${rows.length - active.length}`,
      '',
      `Rechecked about every ${RECHECK_INTERVAL_HOURS} hours, at most ${RECHECK_PER_SUBSCRIBER_PER_RUN} items per subscriber per run.`
    ].join('\n')
  };
}
