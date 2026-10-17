// The free Gemini key's per-minute pace, shared by every caller (chat, the
// camera, background summaries) across every Vercel instance.
//
// Google's free tier allows a few requests per minute per key; three heavy
// chat requests in 15 s used to get an instant 429 and the reply failed.
// Now every call on the free key first takes a slot in the current minute
// (PG1_GEMINI_FREE_RPM, default 10). With none left the caller waits for the
// next minute instead of failing, up to its own budget (20 s for chat, 2
// minutes for background jobs), and only then moves on to the next engine.
//
// Chat goes ahead of background work: background callers may only use the
// minute's slots up to PG1_GEMINI_FREE_RPM minus PG1_GEMINI_FREE_CHAT_RESERVE
// (default 2), so the last slots are always chat's, and when a new minute
// opens a waiting background caller lets chat in first (a short head start).
//
// Shared through public.pg1_rate_take (supabase/migrations/
// 20261102120000_pg1_rate_windows.sql). Without the database, or with the
// migration not applied, the count is kept per instance, so the pace still
// holds within one function instance.

export const RATE_RPC = 'pg1_rate_take';
export const FREE_KEY = 'gemini_free';
export const WINDOW_MS = 60 * 1000;
export const DEFAULT_RPM = 10;
export const DEFAULT_CHAT_RESERVE = 2;
// How long a background caller lets chat in first when a minute opens.
export const BACKGROUND_HEAD_START_MS = 1500;
export const PRIORITY = Object.freeze({ CHAT: 'chat', BACKGROUND: 'background' });

function intEnv(env, name, fallback, low, high) {
  const n = Number(String((env && env[name]) ?? '').trim());
  return Number.isInteger(n) && n >= low && n <= high ? n : fallback;
}

export function freeLimits(env = {}) {
  const rpm = intEnv(env, 'PG1_GEMINI_FREE_RPM', DEFAULT_RPM, 1, 1000);
  const reserve = Math.min(rpm - 1, intEnv(env, 'PG1_GEMINI_FREE_CHAT_RESERVE', DEFAULT_CHAT_RESERVE, 0, 1000));
  return { rpm, reserve: Math.max(0, reserve) };
}

// The per-instance counter: one window per key.
export function createLocalWindows() {
  const windows = new Map();
  return {
    take(key, cap, now) {
      const start = Math.floor(now / WINDOW_MS) * WINDOW_MS;
      const w = windows.get(key);
      const cur = w && w.start === start ? w : { start, used: 0 };
      windows.set(key, cur);
      if (cur.used >= cap) return { granted: false, retryMs: start + WINDOW_MS - now };
      cur.used++;
      return { granted: true, retryMs: 0 };
    },
    clear() { windows.clear(); }
  };
}

// { acquire({ priority, maxWaitMs }) -> { granted, waitedMs } }.
export function createFreeLimiter({ env = {}, supUrl = '', supKey = '', fetchImpl = globalThis.fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), local = createLocalWindows(), key = FREE_KEY } = {}) {
  const take = async (cap) => {
    if (supUrl && supKey) {
      try {
        const res = await fetchImpl(`${supUrl}/rest/v1/rpc/${RATE_RPC}`, {
          method: 'POST',
          headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_key: key, p_cap: cap, p_window_s: WINDOW_MS / 1000 }),
          cache: 'no-store'
        });
        if (res.ok) {
          const v = await res.json().catch(() => null);
          const row = Array.isArray(v) ? v[0] : v;
          if (row && typeof row.granted === 'boolean') return { granted: row.granted, retryMs: Math.max(0, Number(row.retry_ms) || 0) };
        }
      } catch (e) { /* the database is unreachable: count locally */ }
    }
    return local.take(key, cap, now());
  };
  return {
    async acquire({ priority = PRIORITY.CHAT, maxWaitMs = 20000 } = {}) {
      const { rpm, reserve } = freeLimits(env);
      const background = priority !== PRIORITY.CHAT;
      const cap = background ? rpm - reserve : rpm;
      let waitedMs = 0;
      for (;;) {
        const t = await take(cap);
        if (t.granted) return { granted: true, waitedMs };
        const waitMs = Math.max(250, t.retryMs) + (background ? BACKGROUND_HEAD_START_MS : 0);
        if (waitedMs + waitMs > maxWaitMs) return { granted: false, waitedMs };
        await sleep(waitMs);
        waitedMs += waitMs;
      }
    }
  };
}

// Off with PG1_FREE_LIMITER=0. Under Node's test runner it is off unless
// PG1_FREE_LIMITER=1, so tests that call the free key many times are not
// paced by each other (the same convention as the cache, cacheEnabled).
export function freeLimiterEnabled(env = process.env) {
  const v = String((env && env.PG1_FREE_LIMITER) || '').trim();
  if (v === '0') return false;
  if (v === '1') return true;
  return !process.env.NODE_TEST_CONTEXT;
}

const OPEN = Object.freeze({ acquire: async () => ({ granted: true, waitedMs: 0 }) });

// One limiter per database (or one for the instance without one). The
// switch is read on every call, so a test can turn it on.
const shared = new Map();
const sharedLocal = createLocalWindows();
export function freeLimiterFor({ env = process.env, supUrl = '', supKey = '', fetchImpl } = {}) {
  const id = supUrl || 'local';
  if (!shared.has(id)) shared.set(id, createFreeLimiter({ env, supUrl, supKey, local: sharedLocal, ...(fetchImpl ? { fetchImpl } : {}) }));
  const limiter = shared.get(id);
  return { acquire: (opts) => (freeLimiterEnabled(env) ? limiter : OPEN).acquire(opts) };
}

// runRoute's freeSlot hook for a priority.
export function freeSlotFor(limiter, priority) {
  return async ({ maxWaitMs } = {}) => (await limiter.acquire({ priority, maxWaitMs })).granted;
}

export function __resetFreeLimiters() { shared.clear(); sharedLocal.clear(); }
