// The /keys endpoints (1.23.0): free API keys for lead capture, rotation,
// "delete my key and email", and Team member keys.
//
//   GET  /api/keys/signup   the form's settings (bot-check site key, if any)
//   POST /api/keys/signup   { email, consent: true, marketing?: false, challenge_token? }
//                           -> 201 { key, ... } (the key is shown once)
//   POST /api/keys/rotate   X-API-KEY: the current key -> a new key, the old
//                           one revoked
//   POST /api/keys/delete   X-API-KEY: the key -> the email, its keys and
//                           usage counts deleted at once. Without the key,
//                           { email } only RECORDS a request (anyone can type
//                           an email): the operator carries it out within 30
//                           days (/keys delete-request <id> approve). The same
//                           answer whether or not the email has a key.
//   GET/POST/DELETE /api/keys/team
//                           X-API-KEY: a Team licence -> list, create (up to 4
//                           more keys, 5 in all) or revoke Team keys
//
// Bot check: Cloudflare Turnstile when TURNSTILE_SITE_KEY and
// TURNSTILE_SECRET_KEY are both set; without them a strict per-IP signup
// limit (3 a day). The pages and responses never name the provider.
//
// Nothing here is logged with an email or a key; only counts.

import crypto from 'node:crypto';
import { logApiError } from './errorLog.mjs';
import { getSupabaseCreds } from './supabase.mjs';
import { createFreeKey, rotateKey, deleteHolder, requestDeletionByEmail, generateApiKey, hashApiKey, keyHint, licenceAccount, CONSENT_VERSION, TEAM_EXTRA_KEYS, normalizeEmail } from './apiKeys.mjs';
import { defaultKeyStore, forgetKey } from './checkMeter.mjs';
import { resolveLicencePlan, isPg1Key } from './paymentGate.mjs';
import { getRequestIdentifier, freeTierKey } from './freeTier.mjs';
import { PLANS, KEYS_URL, PRICING_URL, periodFor } from './plans.mjs';

export const SIGNUP_LIMIT_WITH_CHALLENGE = 10;
export const SIGNUP_LIMIT_WITHOUT_CHALLENGE = 3;
export const DELETE_LIMIT = 10;
const CHALLENGE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function challengeConfig(env = process.env) {
  const site = String(env.TURNSTILE_SITE_KEY || '').trim();
  const secret = String(env.TURNSTILE_SECRET_KEY || '').trim();
  return site && secret ? { siteKey: site, secret } : null;
}

export async function verifyChallenge(token, { secret, ip, fetchImpl = fetch } = {}) {
  if (typeof token !== 'string' || !token || token.length > 4096) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip && ip !== 'unknown') body.set('remoteip', ip);
    const res = await fetchImpl(CHALLENGE_VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    return data && data.success === true;
  } catch (e) {
    return false;
  }
}

// Per-IP limits: the shared usage counters (by salted IP hash), with an
// in-memory fallback where there is no hash or no store.
const memoryLimits = new Map();
export function __resetKeyLimitsForTests() { memoryLimits.clear(); }
async function takeIpAllowance(store, kind, ip, limit, now) {
  const hash = ip && ip !== 'unknown' ? freeTierKey(ip) : null;
  const { key: day } = periodFor('anonymous', now);
  if (store && hash) {
    try {
      const used = await store.takeUsage(`${kind}:${hash}`, day, 'signup', limit);
      return used >= 0;
    } catch (e) { /* fall through to memory */ }
  }
  const k = `${kind}|${ip || 'unknown'}|${day}`;
  const n = memoryLimits.get(k) || 0;
  if (n >= limit) return false;
  if (memoryLimits.size > 20000) memoryLimits.clear();
  memoryLimits.set(k, n + 1);
  return true;
}

function headerOf(req, name) {
  const v = req.headers && req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function bodyOf(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
  return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
}

function commonHeaders(res, requestId) {
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Retry-After');
}

const links = () => ({ keys_url: KEYS_URL, pricing_url: PRICING_URL });
const unavailable = (res, requestId) => res.status(503).json({ error: 'storage_unavailable', message: 'Keys cannot be issued or changed right now. Please try again in a few minutes.', request_id: requestId });

// The one answer to a signup, whether a key was issued or not (it never
// says whether an email is registered; a key is shown only when created).
export const SIGNUP_MESSAGE = 'If this email can get a key, it has been issued; check the page.';
// The one answer to a deletion request made with only an email.
export const DELETION_REQUEST_MESSAGE = "We'll delete your email and key within 30 days.";

// A deletion request reaches the operator in the error log now (and in the
// daily report, lib/operator/reports.mjs). Never the email; the request id.
function notifyDeletionRequest(rec) {
  try {
    const { supUrl, supKey } = getSupabaseCreds();
    logApiError(supUrl, supKey, {
      source: 'server', route: 'keys:deletion-request', status: null,
      reason: rec.failed ? 'key_deletion_request_not_stored' : 'key_deletion_requested',
      message: rec.failed ? 'A request to delete a free key and its email could not be stored (is supabase/migrations/20261123130000_pg1_key_deletion_requests.sql applied?). It must be done within 30 days: ask the holder again or check the key table.' : `A request to delete a free key and its email is waiting (id ${String(rec.id || '').slice(0, 8)}): /keys delete-request ${String(rec.id || '').slice(0, 8)} approve. Due within 30 days.`
    }).catch(() => {});
  } catch (e) { /* storage not configured */ }
  console.log(`[keys] deletion request ${rec.failed ? 'not stored' : 'recorded'}`);
}

export function freeKeyResponse(key, requestId) {
  return {
    key,
    key_hint: keyHint(key),
    plan: 'free',
    daily_quota: PLANS.free.quota,
    header: 'X-API-KEY',
    shown_once: true,
    note: `Send this key in the X-API-KEY header. It gives ${PLANS.free.quota} checks a day of check_agent_message and check_repo_trap (one shared quota). It is shown once: PG1 stores only a hash of it.`,
    ...links(),
    request_id: requestId
  };
}

export function createKeysHandler(action, deps = {}) {
  const getStore = () => (deps.store !== undefined ? deps.store : defaultKeyStore());
  const env = deps.env || process.env;
  const now = () => (deps.now ? deps.now() : Date.now());
  const verify = deps.verifyChallenge || verifyChallenge;
  const resolveLicence = deps.resolveLicence || resolveLicencePlan;

  return async function keysHandler(req, res) {
    const requestId = crypto.randomUUID();
    commonHeaders(res, requestId);
    const method = req.method || 'GET';
    if (method === 'OPTIONS') return res.status(204).end();
    const store = getStore();
    const ip = getRequestIdentifier(req);

    if (action === 'signup') {
      const challenge = challengeConfig(env);
      if (method === 'GET') {
        return res.status(200).json({ challenge_site_key: challenge ? challenge.siteKey : null, consent_version: CONSENT_VERSION, daily_quota: PLANS.free.quota, ...links() });
      }
      if (method !== 'POST') { res.setHeader('Allow', 'GET, POST, OPTIONS'); return res.status(405).json({ error: 'method_not_allowed', request_id: requestId }); }
      const body = bodyOf(req);
      if (!body) return res.status(400).json({ error: 'invalid_input', message: 'Send a JSON body: { "email": "you@example.com", "consent": true }.', request_id: requestId });
      const email = normalizeEmail(body.email);
      if (!email) return res.status(400).json({ error: 'invalid_email', message: 'Enter a valid email address.', request_id: requestId });
      if (body.consent !== true) return res.status(400).json({ error: 'consent_required', message: 'Tick the box to agree that PG1 stores your email, a hash of your key and usage counts, as described on the page.', request_id: requestId });
      if (challenge) {
        const ok = await verify(body.challenge_token, { secret: challenge.secret, ip });
        if (!ok) return res.status(403).json({ error: 'challenge_failed', message: 'The bot check did not pass. Reload the page and try again.', request_id: requestId });
      }
      const allowed = await takeIpAllowance(store, 'signup', ip, challenge ? SIGNUP_LIMIT_WITH_CHALLENGE : SIGNUP_LIMIT_WITHOUT_CHALLENGE, now());
      if (!allowed) { res.setHeader('Retry-After', '3600'); return res.status(429).json({ error: 'rate_limited', message: 'Too many key requests from this network today. Try again tomorrow.', request_id: requestId }); }
      if (!store) return unavailable(res, requestId);
      let out;
      try {
        out = await createFreeKey(store, { email, marketing: body.marketing === true, now: now() });
      } catch (e) {
        return unavailable(res, requestId);
      }
      // Never says whether an email is registered: the same status and
      // message whether a key was issued or the email already had one. A key
      // is in the answer only when one was created.
      if (out.exists) return res.status(200).json({ issued: false, message: SIGNUP_MESSAGE, ...links(), request_id: requestId });
      console.log('[keys] free key issued');
      return res.status(200).json({ ...freeKeyResponse(out.key, requestId), issued: true, message: SIGNUP_MESSAGE });
    }

    if (action === 'rotate') {
      if (method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return res.status(405).json({ error: 'method_not_allowed', request_id: requestId }); }
      const key = String(headerOf(req, 'x-api-key') || '').trim();
      if (!isPg1Key(key)) return res.status(400).json({ error: 'key_required', message: 'Send the key to rotate in the X-API-KEY header. Licence keys are managed with your card payment receipt, not here.', request_id: requestId });
      if (!store) return unavailable(res, requestId);
      let out;
      try { out = await rotateKey(store, key); } catch (e) { return unavailable(res, requestId); }
      if (out.notFound) return res.status(404).json({ error: 'key_not_found', message: 'No active key matches. It may already be rotated or deleted.', request_id: requestId });
      forgetKey(key);
      console.log('[keys] key rotated');
      return res.status(200).json({ ...(out.row && out.row.tier === 'team' ? { key: out.key, key_hint: keyHint(out.key), plan: 'team', header: 'X-API-KEY', shown_once: true, ...links(), request_id: requestId } : freeKeyResponse(out.key, requestId)), rotated: true, old_key_revoked: true });
    }

    if (action === 'delete') {
      if (method !== 'POST' && method !== 'DELETE') { res.setHeader('Allow', 'POST, DELETE, OPTIONS'); return res.status(405).json({ error: 'method_not_allowed', request_id: requestId }); }
      const key = String(headerOf(req, 'x-api-key') || '').trim();
      const body = bodyOf(req) || {};
      if (!key && !normalizeEmail(body.email)) return res.status(400).json({ error: 'invalid_input', message: 'Send your key in X-API-KEY to delete it now, or a JSON body { "email": "you@example.com" } to ask for deletion.', request_id: requestId });
      if (key && !isPg1Key(key)) return res.status(400).json({ error: 'key_required', message: 'Only PG1 keys from /keys can be deleted here.', request_id: requestId });
      const allowed = await takeIpAllowance(store, 'delete', ip, DELETE_LIMIT, now());
      if (!allowed) { res.setHeader('Retry-After', '3600'); return res.status(429).json({ error: 'rate_limited', message: 'Too many delete requests from this network today. Try again tomorrow.', request_id: requestId }); }
      if (!store) return unavailable(res, requestId);
      if (key) {
        // Self-service: the key proves who is asking.
        let out;
        try { out = await deleteHolder(store, { key }); } catch (e) { return unavailable(res, requestId); }
        forgetKey(key);
        console.log('[keys] key deleted by its holder');
        return res.status(200).json({ ok: true, deleted: out.deleted > 0, message: out.deleted > 0 ? 'Your key, your email and its usage counts are now deleted.' : 'No active key matches; nothing was deleted.', request_id: requestId });
      }
      // Email only: recorded for the operator, never performed here.
      let rec = { recorded: false };
      try { rec = await requestDeletionByEmail(store, body.email); } catch (e) { rec = { recorded: false, failed: true }; }
      if (rec.recorded || rec.failed) notifyDeletionRequest(rec);
      return res.status(200).json({ ok: true, message: DELETION_REQUEST_MESSAGE, request_id: requestId });
    }

    if (action === 'team') {
      const licence = String(headerOf(req, 'x-api-key') || '').trim();
      if (!licence || isPg1Key(licence)) return res.status(401).json({ error: 'licence_required', message: 'Send your Team licence key in the X-API-KEY header.', ...links(), request_id: requestId });
      const plan = await resolveLicence(licence, { env }).catch(() => ({ valid: false, reason: 'verification_unavailable' }));
      if (!plan.valid && plan.reason === 'verification_unavailable') { res.setHeader('Retry-After', '30'); return res.status(503).json({ error: 'verification_unavailable', message: 'Licence verification is temporarily unavailable, please retry.', request_id: requestId }); }
      if (!plan.valid || plan.tier !== 'team') return res.status(403).json({ error: 'team_licence_required', message: `Team keys need an active Team licence (up to ${PLANS.team.keys} keys sharing ${PLANS.team.quota.toLocaleString('en-US')} checks a month). See ${PRICING_URL}.`, ...links(), request_id: requestId });
      if (!store) return unavailable(res, requestId);
      const account = licenceAccount(licence);
      try {
        const active = await store.listTeamKeys(account);
        const view = (k) => ({ id: k.id, key_hint: k.key_hint, label: k.label || null, created_at: k.created_at });
        if (method === 'GET') return res.status(200).json({ plan: 'team', keys: active.map(view), max_extra_keys: TEAM_EXTRA_KEYS, note: `Your licence key plus up to ${TEAM_EXTRA_KEYS} team keys (${PLANS.team.keys} in all) share one monthly quota.`, request_id: requestId });
        if (method === 'POST') {
          if (active.length >= TEAM_EXTRA_KEYS) return res.status(409).json({ error: 'team_key_limit', message: `This Team licence already has ${TEAM_EXTRA_KEYS} team keys (${PLANS.team.keys} keys with the licence key). Revoke one first.`, request_id: requestId });
          const body = bodyOf(req) || {};
          const label = typeof body.label === 'string' ? body.label.replace(/[^\w .,@()-]/g, '').trim().slice(0, 60) || null : null;
          const key = generateApiKey();
          const row = await store.insertKey({ key_hash: hashApiKey(key), key_hint: keyHint(key), tier: 'team', account, label });
          return res.status(201).json({ key, key_hint: keyHint(key), id: row && row.id, label, plan: 'team', header: 'X-API-KEY', shown_once: true, note: 'Shown once: PG1 stores only a hash of it.', request_id: requestId });
        }
        if (method === 'DELETE') {
          const id = String((req.query && req.query.id) || (bodyOf(req) || {}).id || '');
          const target = active.find((k) => k.id === id);
          if (!target) return res.status(404).json({ error: 'key_not_found', message: 'No active team key with that id on this licence.', request_id: requestId });
          await store.revokeKey(target.id);
          return res.status(200).json({ ok: true, revoked: target.id, request_id: requestId });
        }
      } catch (e) {
        return unavailable(res, requestId);
      }
      res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
      return res.status(405).json({ error: 'method_not_allowed', request_id: requestId });
    }

    return res.status(404).json({ error: 'not_found', request_id: requestId });
  };
}
