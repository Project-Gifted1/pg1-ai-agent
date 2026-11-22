// PG1's own API keys (1.23.0): free keys from /keys (lead capture) and Team
// member keys. Sent as X-API-KEY, the same header as a licence key.
//
//   pg1_<32 random base64url characters>    (192 bits)
//
// Only sha256(key) is stored, with the first 8 characters as a hint so a
// holder can tell keys apart; the key itself is shown once, at creation.
// One active free key per email (a unique index in the migration). Rotating
// a key revokes the old one; deleting removes the email, the key rows and
// their usage counts.
//
// Storage: Supabase tables pg1_api_keys and pg1_check_usage (migration
// 20261122120000_pg1_paid_checks.sql), through PostgREST with the service
// key. createMemoryKeyStore is the same interface in memory, for tests.

import crypto from 'node:crypto';
import { PG1_KEY_PREFIX } from './paymentGate.mjs';

export const CONSENT_VERSION = '2026-11-22';
export const MAX_EMAIL_LENGTH = 254;
export const TEAM_EXTRA_KEYS = 4; // the licence key plus 4 = 5 keys

export function generateApiKey() {
  return PG1_KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
}

export function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

export function keyHint(key) {
  return String(key).slice(0, 8);
}

export function isWellFormedPg1Key(key) {
  return typeof key === 'string' && /^pg1_[A-Za-z0-9_-]{32}$/.test(key);
}

// A plain, deliberately strict email check: one @, a dot in the domain, no
// spaces or angle brackets, at most 254 characters. Lower-cased and trimmed.
export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH) return null;
  if (!/^[^\s@<>()",;:]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)) return null;
  return email;
}

export function hashEmail(email) {
  return crypto.createHash('sha256').update(`pg1-email-v1:${email}`).digest('hex');
}

// The licence account a Team (or Builder) licence counts against.
export function licenceAccount(licenceKey) {
  return 'lic:' + crypto.createHash('sha256').update(`pg1-licence-account-v1:${String(licenceKey).trim()}`).digest('hex').slice(0, 48);
}

// ---------------------------------------------------------------- stores ---

export class StoreUnavailableError extends Error {
  constructor(message = 'Key storage is not available right now.') {
    super(message);
    this.storeUnavailable = true;
  }
}

// In-memory store with the Supabase store's interface.
export function createMemoryKeyStore({ now = () => Date.now() } = {}) {
  const keys = [];
  const usage = new Map();
  const iso = () => new Date(now()).toISOString();
  return {
    keys,
    usage,
    async findActiveKey(keyHash) {
      return keys.find((k) => k.key_hash === keyHash && !k.revoked_at) || null;
    },
    async findActiveFreeKeyByEmail(emailHash) {
      return keys.find((k) => k.tier === 'free' && k.email_hash === emailHash && !k.revoked_at) || null;
    },
    async insertKey(row) {
      if (row.tier === 'free' && keys.some((k) => k.tier === 'free' && k.email_hash === row.email_hash && !k.revoked_at)) {
        throw Object.assign(new Error('duplicate'), { duplicate: true });
      }
      const saved = { id: crypto.randomUUID(), created_at: iso(), revoked_at: null, marketing_opt_in: false, label: null, account: null, email: null, email_hash: null, consent_at: null, consent_version: null, ...row };
      keys.push(saved);
      return saved;
    },
    async revokeKey(id) {
      const k = keys.find((x) => x.id === id && !x.revoked_at);
      if (k) k.revoked_at = iso();
      return !!k;
    },
    async deleteByEmailHash(emailHash) {
      const gone = keys.filter((k) => k.email_hash === emailHash);
      for (const k of gone) keys.splice(keys.indexOf(k), 1);
      return gone.map((k) => k.id);
    },
    async listTeamKeys(account) {
      return keys.filter((k) => k.tier === 'team' && k.account === account && !k.revoked_at);
    },
    async countSignupsByDay(sinceIso) {
      const out = {};
      for (const k of keys) if (k.tier === 'free' && k.created_at >= sinceIso) out[k.created_at.slice(0, 10)] = (out[k.created_at.slice(0, 10)] || 0) + 1;
      return out;
    },
    // Atomic in the database (pg1_check_usage_take): one more use when under
    // the limit, returning the new count, or -1 when the limit is reached.
    async takeUsage(subject, period, tier, limit) {
      const k = `${subject}|${period}`;
      const cur = usage.get(k) || 0;
      if (limit != null && cur >= limit) return -1;
      usage.set(k, cur + 1);
      return cur + 1;
    },
    async refundUsage(subject, period) {
      const k = `${subject}|${period}`;
      const cur = usage.get(k) || 0;
      if (cur > 0) usage.set(k, cur - 1);
    },
    async deleteUsage(subjects) {
      for (const k of [...usage.keys()]) if (subjects.includes(k.split('|')[0])) usage.delete(k);
    }
  };
}

const TIMEOUT_MS = 2500;

export function createSupabaseKeyStore({ supUrl, supKey, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!supUrl || !supKey) return null;
  const headers = { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json' };
  async function call(path, init = {}) {
    let res;
    try {
      res = await fetchImpl(`${supUrl}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new StoreUnavailableError();
    }
    if (res.status === 409) throw Object.assign(new Error('duplicate'), { duplicate: true });
    if (!res.ok) {
      let code = null;
      try { code = (await res.json()).code || null; } catch (e) { /* no body */ }
      if (code === '23505') throw Object.assign(new Error('duplicate'), { duplicate: true });
      throw new StoreUnavailableError();
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  const enc = encodeURIComponent;
  const SELECT = 'id,key_hint,tier,email,email_hash,account,label,consent_at,consent_version,marketing_opt_in,created_at,revoked_at';
  return {
    async findActiveKey(keyHash) {
      const rows = await call(`pg1_api_keys?key_hash=eq.${enc(keyHash)}&revoked_at=is.null&select=${SELECT}&limit=1`);
      return (rows && rows[0]) || null;
    },
    async findActiveFreeKeyByEmail(emailHash) {
      const rows = await call(`pg1_api_keys?email_hash=eq.${enc(emailHash)}&tier=eq.free&revoked_at=is.null&select=${SELECT}&limit=1`);
      return (rows && rows[0]) || null;
    },
    async insertKey(row) {
      const rows = await call('pg1_api_keys?select=' + SELECT, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
      return rows && rows[0];
    },
    async revokeKey(id) {
      const rows = await call(`pg1_api_keys?id=eq.${enc(id)}&revoked_at=is.null`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ revoked_at: new Date().toISOString() }) });
      return Array.isArray(rows) && rows.length > 0;
    },
    async deleteByEmailHash(emailHash) {
      const rows = await call(`pg1_api_keys?email_hash=eq.${enc(emailHash)}&select=id`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
      return (rows || []).map((r) => r.id);
    },
    async listTeamKeys(account) {
      return (await call(`pg1_api_keys?account=eq.${enc(account)}&tier=eq.team&revoked_at=is.null&select=${SELECT}&order=created_at.asc`)) || [];
    },
    async countSignupsByDay(sinceIso) {
      const rows = (await call(`pg1_api_keys?tier=eq.free&created_at=gte.${enc(sinceIso)}&select=created_at&limit=10000`)) || [];
      const out = {};
      for (const r of rows) { const d = String(r.created_at).slice(0, 10); out[d] = (out[d] || 0) + 1; }
      return out;
    },
    async takeUsage(subject, period, tier, limit) {
      const v = await call('rpc/pg1_check_usage_take', { method: 'POST', body: JSON.stringify({ p_subject: subject, p_period: period, p_tier: tier, p_limit: limit ?? null }) });
      return typeof v === 'number' ? v : Number(v);
    },
    async refundUsage(subject, period) {
      await call('rpc/pg1_check_usage_refund', { method: 'POST', body: JSON.stringify({ p_subject: subject, p_period: period }) });
    },
    async deleteUsage(subjects) {
      if (!subjects.length) return;
      await call(`pg1_check_usage?subject=in.(${subjects.map((s) => `"${s.replace(/"/g, '')}"`).map(enc).join(',')})`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    }
  };
}

// The usage counter a free key counts against: per email, so rotating a
// key does not reset the day's count.
export function freeKeySubject(emailHash) {
  return 'free:' + String(emailHash).slice(0, 48);
}

// Usage counters are kept 62 days (the /keys privacy notice), then deleted
// by the daily cleanup cron (api/errors/cleanup.mjs).
export const CHECK_USAGE_RETENTION_DAYS = 62;
export async function purgeExpiredCheckUsage({ supUrl, supKey, now = Date.now(), fetchImpl = fetch } = {}) {
  if (!supUrl || !supKey) return { ok: false, skipped: true };
  const cutoff = new Date(now - CHECK_USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const res = await fetchImpl(`${supUrl}/rest/v1/pg1_check_usage?updated_at=lt.${encodeURIComponent(cutoff)}`, { method: 'DELETE', headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, Prefer: 'return=minimal' }, signal: AbortSignal.timeout(5000) });
    // 404: the table is not there yet (migration not run) - nothing to purge.
    return { ok: res.ok || res.status === 404, status: res.status };
  } catch (e) {
    return { ok: false, error: 'unreachable' };
  }
}

// ------------------------------------------------------------ operations ---

// A new free key for an email. Returns { key, row } or { exists: true }.
export async function createFreeKey(store, { email, marketing = false, now = Date.now() }) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw Object.assign(new Error('invalid email'), { invalidEmail: true });
  const emailHash = hashEmail(normalized);
  const existing = await store.findActiveFreeKeyByEmail(emailHash);
  if (existing) return { exists: true };
  const key = generateApiKey();
  try {
    const row = await store.insertKey({
      key_hash: hashApiKey(key),
      key_hint: keyHint(key),
      tier: 'free',
      email: normalized,
      email_hash: emailHash,
      consent_at: new Date(now).toISOString(),
      consent_version: CONSENT_VERSION,
      marketing_opt_in: marketing === true
    });
    return { key, row };
  } catch (e) {
    if (e.duplicate) return { exists: true };
    throw e;
  }
}

// Rotate: a new key for the same holder, the old one revoked first (so the
// one-free-key-per-email rule holds throughout).
export async function rotateKey(store, oldKey) {
  if (!isWellFormedPg1Key(oldKey)) return { notFound: true };
  const current = await store.findActiveKey(hashApiKey(oldKey));
  if (!current) return { notFound: true };
  const full = current;
  await store.revokeKey(current.id);
  const key = generateApiKey();
  const row = await store.insertKey({
    key_hash: hashApiKey(key),
    key_hint: keyHint(key),
    tier: full.tier,
    email: full.email || null,
    email_hash: full.email_hash || null,
    account: full.account || null,
    label: full.label || null,
    consent_at: full.consent_at || (full.tier === 'free' ? new Date().toISOString() : null),
    consent_version: full.consent_version || (full.tier === 'free' ? CONSENT_VERSION : null),
    marketing_opt_in: full.marketing_opt_in === true
  });
  return { key, row, revokedId: current.id };
}

// Delete a holder's email, keys and usage counts. By key (the holder's own
// free key) or by email. Returns the number of key rows removed.
export async function deleteHolder(store, { key, email }) {
  let emailHash = null;
  let keyRow = null;
  if (key) {
    if (!isWellFormedPg1Key(key)) return { deleted: 0 };
    keyRow = await store.findActiveKey(hashApiKey(key));
    if (!keyRow) return { deleted: 0 };
    emailHash = keyRow.email_hash;
    if (!emailHash) {
      // A Team member key has no email: revoke just that key.
      await store.revokeKey(keyRow.id);
      return { deleted: 1 };
    }
  } else {
    const normalized = normalizeEmail(email);
    if (!normalized) throw Object.assign(new Error('invalid email'), { invalidEmail: true });
    emailHash = hashEmail(normalized);
  }
  const ids = await store.deleteByEmailHash(emailHash);
  await store.deleteUsage([freeKeySubject(emailHash)]);
  return { deleted: ids.length };
}
