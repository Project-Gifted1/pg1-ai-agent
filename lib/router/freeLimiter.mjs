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
//
// TOKENS (20 Oct: a light chat sent 10-13k tokens, and Groq refused "TPM:
// Limit 8000, Used 3769, Requested 4525"): a call that says how many tokens
// it will use (acquire({ tokens })) also takes them from the engine's
// tokens-per-minute and per-day budgets, and one request from its per-day
// budget (ENGINE_LIMITS, PG1_<ENGINE>_TPM / _TPD / _RPD, or the lower
// limit the engine's own x-ratelimit headers reported). A call that would
// pass a per-day budget is refused at once (no wait: it resets in hours);
// one that would pass the per-minute budget waits like a request does, at
// most the caller's budget. So the router picks an engine with room before
// calling it instead of calling and getting a 429. Shared through
// public.pg1_rate_take_n (supabase/migrations/20261107120000_pg1_rate_tokens.sql);
// without it the tokens are counted per instance.
//
// BACKGROUND WORK (Autonomous mode's missions, feed guardian, watchdogs, lab
// autopilot, integration watch) gets PG1_FREE_BACKGROUND_SHARE (default
// half) of every budget, and yields while operator chat is active on that
// engine (a chat call in the last CHAT_ACTIVE_MS): the call is refused with
// reason 'chat_active' and the job tries again later.

export const RATE_RPC = 'pg1_rate_take';
export const FREE_KEY = 'gemini_free';
export const WINDOW_MS = 60 * 1000;
export const DEFAULT_RPM = 10;
// Each free engine's own pace (requests per minute), from its free tier:
// PG1_<ENGINE>_RPM overrides one (PG1_GEMINI_FREE_RPM, PG1_GROQ_RPM,
// PG1_MISTRAL_RPM, PG1_GITHUB_MODELS_RPM, PG1_CLOUDFLARE_RPM).
export const ENGINE_RPM = Object.freeze({ gemini_free: 10, groq: 30, mistral: 60, github_models: 10, cloudflare: 30 });
export const PACED_ENGINES = Object.freeze(Object.keys(ENGINE_RPM));
export const rpmEnvName = (engine) => `PG1_${String(engine).toUpperCase()}_RPM`;
export const DEFAULT_CHAT_RESERVE = 2;
// How long a background caller lets chat in first when a minute opens.
export const BACKGROUND_HEAD_START_MS = 1500;
export const PRIORITY = Object.freeze({ CHAT: 'chat', BACKGROUND: 'background' });
export const DAY_S = 86400;
// Free-tier budgets per engine (the engines' published free tiers, the
// tightest model where models differ). null: no such limit.
export const ENGINE_LIMITS = Object.freeze({
  gemini_free: Object.freeze({ tpm: 250000, rpd: 250, tpd: null }),
  groq: Object.freeze({ tpm: 8000, rpd: 1000, tpd: 200000 }),
  mistral: Object.freeze({ tpm: 500000, rpd: null, tpd: null }),
  github_models: Object.freeze({ tpm: null, rpd: 150, tpd: null }),
  cloudflare: Object.freeze({ tpm: null, rpd: null, tpd: 300000 }),
  openrouter: Object.freeze({ tpm: null, rpd: 50, tpd: null })
});
export const DEFAULT_BACKGROUND_SHARE = 0.5;
export const CHAT_ACTIVE_MS = 2 * 60 * 1000;
export const RATE_N_RPC = 'pg1_rate_take_n';

function numEnv(env, name) {
  const raw = env && env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

// { tpm, tpd, rpd } for an engine: env, else the engine's own headers when
// tighter, else ENGINE_LIMITS.
export function tokenLimits(env = {}, engine = FREE_KEY, learned = null) {
  const base = ENGINE_LIMITS[engine] || {};
  const up = String(engine).toUpperCase();
  const pick = (k, envName, fromHeader) => {
    const e = numEnv(env, envName);
    if (e !== undefined) return e || null;
    const b = base[k] == null ? null : base[k];
    return Number.isFinite(fromHeader) && fromHeader > 0 ? (b == null ? fromHeader : Math.min(b, fromHeader)) : b;
  };
  return {
    tpm: pick('tpm', `PG1_${up}_TPM`, learned && learned.limitTokens),
    tpd: pick('tpd', `PG1_${up}_TPD`, null),
    rpd: pick('rpd', `PG1_${up}_RPD`, learned && learned.limitRequests)
  };
}

export function backgroundShare(env = {}) {
  const n = numEnv(env, 'PG1_FREE_BACKGROUND_SHARE');
  return n !== undefined && n > 0 && n <= 1 ? n : DEFAULT_BACKGROUND_SHARE;
}

function intEnv(env, name, fallback, low, high) {
  const n = Number(String((env && env[name]) ?? '').trim());
  return Number.isInteger(n) && n >= low && n <= high ? n : fallback;
}

export function freeLimits(env = {}, engine = FREE_KEY) {
  const rpm = intEnv(env, rpmEnvName(engine), ENGINE_RPM[engine] || DEFAULT_RPM, 1, 1000);
  const reserve = Math.min(rpm - 1, intEnv(env, 'PG1_GEMINI_FREE_CHAT_RESERVE', DEFAULT_CHAT_RESERVE, 0, 1000));
  return { rpm, reserve: Math.max(0, reserve) };
}

// The per-instance counter: one window per key. take(key, cap, now) takes
// one; takeN(key, cap, n, windowMs, now) takes n when they fit (n = 0 only
// reads the window).
export function createLocalWindows() {
  const windows = new Map();
  const takeN = (key, cap, n, windowMs, now) => {
    const start = Math.floor(now / windowMs) * windowMs;
    const id = `${key}@${windowMs}`;
    const w = windows.get(id);
    const cur = w && w.start === start ? w : { start, used: 0 };
    windows.set(id, cur);
    if (n > 0 && cur.used + n > cap) return { granted: false, retryMs: start + windowMs - now, used: cur.used };
    cur.used += n;
    return { granted: true, retryMs: 0, used: cur.used };
  };
  return {
    take(key, cap, now) { return takeN(key, cap, 1, WINDOW_MS, now); },
    takeN,
    usage(key, windowMs, now) {
      const w = windows.get(`${key}@${windowMs}`);
      return w && w.start === Math.floor(now / windowMs) * windowMs ? w.used : 0;
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
  // n units of `bucket` in a window of windowS seconds, shared when the
  // database has pg1_rate_take_n, else counted here.
  let sharedN = !!(supUrl && supKey);
  const takeN = async (bucket, cap, n, windowS) => {
    const id = `${key}:${bucket}`;
    if (sharedN) {
      try {
        const res = await fetchImpl(`${supUrl}/rest/v1/rpc/${RATE_N_RPC}`, {
          method: 'POST',
          headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_key: id, p_cap: cap, p_window_s: windowS, p_n: n }),
          cache: 'no-store'
        });
        if (res.ok) {
          const v = await res.json().catch(() => null);
          const row = Array.isArray(v) ? v[0] : v;
          if (row && typeof row.granted === 'boolean') return { granted: row.granted, retryMs: Math.max(0, Number(row.retry_ms) || 0), used: Number(row.used) || 0 };
        } else if (res.status === 404) {
          sharedN = false; // the migration is not applied yet
        }
      } catch (e) { /* the database is unreachable: count locally */ }
    }
    return local.takeN(id, cap, n, windowS * 1000, now());
  };
  const share = (cap, background) => (cap == null ? null : background ? Math.max(1, Math.floor(cap * backgroundShare(env))) : cap);
  let chatAt = 0;
  return {
    // { granted, waitedMs, reason? }: reason 'rpd' | 'tpd' (a day's budget:
    // never waited for), 'tpm' | 'rpm' (the minute's, after the wait),
    // 'chat_active' (background work yields to operator chat).
    async acquire({ priority = PRIORITY.CHAT, maxWaitMs = 20000, tokens = 0, learned = null } = {}) {
      const { rpm, reserve } = freeLimits(env, key);
      const background = priority !== PRIORITY.CHAT;
      const limits = tokenLimits(env, key, learned);
      if (!background) {
        chatAt = now();
        takeN('chat', 1e9, 1, CHAT_ACTIVE_MS / 1000).catch(() => {});
      } else {
        const chatNow = now() - chatAt < CHAT_ACTIVE_MS || ((await takeN('chat', 1e9, 0, CHAT_ACTIVE_MS / 1000)).used > 0);
        if (chatNow) return { granted: false, waitedMs: 0, reason: 'chat_active' };
      }
      // A day's budget first: refused at once, never waited for.
      const rpd = share(limits.rpd, background);
      if (rpd && !(await takeN('rpd', rpd, 1, DAY_S)).granted) return { granted: false, waitedMs: 0, reason: 'rpd' };
      const tpd = share(limits.tpd, background);
      if (tpd && tokens > 0 && !(await takeN('tpd', tpd, tokens, DAY_S)).granted) return { granted: false, waitedMs: 0, reason: 'tpd' };
      const cap = background ? Math.min(rpm - reserve, share(rpm, true)) : rpm;
      const tpm = share(limits.tpm, background);
      // A request bigger than the whole minute's tokens never fits.
      if (tpm && tokens > tpm) return { granted: false, waitedMs: 0, reason: 'tpm' };
      let waitedMs = 0;
      for (;;) {
        const t = await take(cap);
        let ok = t.granted;
        let retryMs = t.retryMs;
        let reason = 'rpm';
        if (ok && tpm && tokens > 0) {
          const tk = await takeN('tpm', tpm, tokens, WINDOW_MS / 1000);
          if (!tk.granted) { ok = false; retryMs = tk.retryMs; reason = 'tpm'; }
        }
        if (ok) return { granted: true, waitedMs };
        const waitMs = Math.max(250, retryMs) + (background ? BACKGROUND_HEAD_START_MS : 0);
        if (waitedMs + waitMs > maxWaitMs) return { granted: false, waitedMs, reason };
        await sleep(waitMs);
        waitedMs += waitMs;
      }
    },
    // What is used now, for /keys: { rpm, tpm, rpd, tpd } (this instance's
    // view when the database is not shared).
    usage() {
      const t = now();
      return { tpm: local.usage(`${key}:tpm`, WINDOW_MS, t), rpd: local.usage(`${key}:rpd`, DAY_S * 1000, t), tpd: local.usage(`${key}:tpd`, DAY_S * 1000, t) };
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

const OPEN = Object.freeze({ acquire: async () => ({ granted: true, waitedMs: 0 }), usage: () => ({ tpm: 0, rpd: 0, tpd: 0 }) });

// One limiter per database (or one for the instance without one). The
// switch is read on every call, so a test can turn it on.
const shared = new Map();
const sharedLocal = createLocalWindows();
export function freeLimiterFor({ env = process.env, supUrl = '', supKey = '', fetchImpl, engine = FREE_KEY } = {}) {
  const id = `${supUrl || 'local'}|${engine}`;
  if (!shared.has(id)) shared.set(id, createFreeLimiter({ env, supUrl, supKey, local: sharedLocal, key: engine, ...(fetchImpl ? { fetchImpl } : {}) }));
  const limiter = shared.get(id);
  return { acquire: (opts) => (freeLimiterEnabled(env) ? limiter : OPEN).acquire(opts), usage: () => limiter.usage() };
}

// runRoute's freeSlot hook for a priority.
export function freeSlotFor(limiter, priority) {
  return async ({ maxWaitMs } = {}) => (await limiter.acquire({ priority, maxWaitMs })).granted;
}

export function __resetFreeLimiters() { shared.clear(); sharedLocal.clear(); }
