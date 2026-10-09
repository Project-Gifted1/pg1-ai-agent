// PG1 cost-saving AI router: one place that decides which provider, key and
// model serves each AI call, in what fallback order, and what it cost.
//
// Tasks
//   light  short replies, summaries, classification, formatting: the
//          cheapest capable model (the main core on the free Gemini key when
//          the content allows it)
//   heavy  threat analysis, code, storyboards, security decisions: the
//          strongest model (the reasoning core)
//   tts    speech: Cartesia, PG1's voice. The free Gemini key goes first
//          only when PG1_TTS_FREE_FIRST=1 and PG1_TTS_GEMINI_VOICE are set
//   media  video, images, music: paid keys only; the paid Gemini key is
//          prepaid and can run out, so Replicate is the fallback
//
// Every route is an ordered list of candidates. The next one is tried on a
// 429, a quota or billing error, a 5xx, a timeout or a network error
// (isFallbackFailure); a content-safety refusal never moves on, because
// another provider would route round the first one's safety filter.
//
// Privacy. GEMINI_API_KEY_FREE is a free-tier key, and free-tier content may
// be used by the provider to improve its products. It only ever receives
// operator content: anything that carries customer or guest data (dataClass
// 'customer', the default when a caller does not say) is planned on paid
// providers only (planRoute). Every request from a session that is not the
// signed-in operator's (a guest or a customer) is customer data whatever it
// says (dataClassFor). A key that equals the free key is never used for
// customer data, even when an old env var holds the same value.
//
// Keys by role, old names kept as fallbacks so nothing breaks:
//   free Gemini   GEMINI_API_KEY_FREE only
//   paid Gemini   GEMINI_API_KEY_PAID, else GEMINI_API_KEY1, GEMINI_API_KEY2,
//                 GEMINI_API_KEY (only when GEMINI_API_KEY_PAID is unset).
//                 The old keys are treated as paid, both for the privacy
//                 rule and for cost, since nothing says they are free; with
//                 neither new name set, chat uses them in the same order as
//                 before (preview deployments have only the old names).
//   reasoning     ANTHROPIC_API_KEY, else ANTROPIC_API_KEY
//   OpenRouter    OPENROUTER_API_KEY, else OPEN_ROUTER_KEY
//   AI gateway    VERCEL_AI_API_KEY, else AI_GATEWAY_API_KEY
//   OpenAI        OPENAI_API_KEY
//   Replicate     REPLICATE_API_TOKEN, else REPLICATE_KEY
//   Cartesia      CARTESIA_API_KEY
// TTS is Cartesia, so PG1 always speaks in the same voice. The free Gemini
// key (GEMINI_API_KEY_FREE only, never an old Gemini name) is tried first
// for operator speech only when PG1_TTS_FREE_FIRST=1 and a voice is named
// in PG1_TTS_GEMINI_VOICE; there is no default Gemini voice.
//
// Cost control. Identical requests from the same user are answered from a
// per-instance cache (text and TTS); every cache key carries the caller's
// identity, so one user's cached reply is never served to another.
// PG1_DAILY_BUDGET_<PROVIDER>_USD caps a provider's estimated spend per UTC
// day; a provider over budget is left out of every
// plan until the day turns. Every call is logged as one
// "[pg1-ai-usage] {...}" line and one ledger row with provider, model,
// task, tokens and estimated cost: never the content, never a key.
//
// White label. Replies, traces and the /spend summary only ever use the
// PG1 labels in ENGINE_LABELS; provider names stay in logs and config.

import crypto from 'node:crypto';

export const TASKS = Object.freeze({ LIGHT: 'light', HEAVY: 'heavy', TTS: 'tts', MEDIA: 'media' });
export const DATA = Object.freeze({ OPERATOR: 'operator', CUSTOMER: 'customer' });

// Ledger / budget names. gemini_free and gemini_paid are budgeted apart.
export const PROVIDERS = Object.freeze(['gemini_free', 'gemini_paid', 'anthropic', 'openai', 'openrouter', 'gateway', 'replicate', 'cartesia']);

export const ENGINE_LABELS = Object.freeze({
  gemini_free: 'PG1 main core (free tier)',
  gemini_paid: 'PG1 main core',
  anthropic: 'PG1 reasoning core',
  gateway: 'PG1 backup core A',
  openrouter: 'PG1 backup core B',
  openai: 'PG1 backup core C',
  replicate: 'PG1 media engine',
  cartesia: 'PG1 voice engine'
});

// Default models per task and provider; every list can be replaced with a
// comma-separated env var (routeModels). The main core's Flash models are
// the ones chat has always used; the reasoning core's are the strongest.
export const DEFAULT_ROUTE_MODELS = Object.freeze({
  light: Object.freeze({
    gemini: Object.freeze(['gemini-3.8-flash', 'gemini-3.6-flash']),
    anthropic: Object.freeze(['claude-haiku-5-5']),
    gateway: Object.freeze(['openai/gpt-5-mini']),
    openrouter: Object.freeze(['openai/gpt-5-mini']),
    openai: Object.freeze(['gpt-5-mini'])
  }),
  heavy: Object.freeze({
    anthropic: Object.freeze(['claude-opus-5-5', 'claude-sonnet-5-5']),
    gemini: Object.freeze(['gemini-3.8-flash', 'gemini-3.6-flash']),
    gateway: Object.freeze(['openai/gpt-5']),
    openrouter: Object.freeze(['openai/gpt-5']),
    openai: Object.freeze(['gpt-5'])
  }),
  tts: Object.freeze({
    gemini: Object.freeze(['gemini-3.1-flash-tts-preview'])
  })
});

const MODEL_ENV = Object.freeze({
  light: { gemini: 'PG1_LIGHT_GEMINI_MODELS', anthropic: 'PG1_LIGHT_ANTHROPIC_MODELS', gateway: 'PG1_LIGHT_GATEWAY_MODELS', openrouter: 'PG1_LIGHT_OPENROUTER_MODELS', openai: 'PG1_LIGHT_OPENAI_MODELS' },
  heavy: { gemini: 'PG1_HEAVY_GEMINI_MODELS', anthropic: 'PG1_HEAVY_ANTHROPIC_MODELS', gateway: 'PG1_HEAVY_GATEWAY_MODELS', openrouter: 'PG1_HEAVY_OPENROUTER_MODELS', openai: 'PG1_HEAVY_OPENAI_MODELS' },
  tts: { gemini: 'PG1_TTS_GEMINI_MODEL' }
});

// Estimated list prices in USD (text: per 1M input / output tokens; TTS:
// per 1M characters; media: per unit). Estimates only, for budgets and the
// summary; the provider's invoice is the truth. A model not listed is
// priced at its provider's default row. Override any row with
// PG1_PRICE_<MODEL ID upper-cased, non-alphanumerics as _>="in,out".
export const PRICES = Object.freeze({
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-haiku-5-5': [0.10, 0.50],
  'claude-haiku-4-5-20251001': [1, 5],
  'gemini-3.8-flash': [0.75, 3.75],
  'gemini-3.6-flash': [0.50, 3],
  'gemini-3.1-flash-tts-preview': [1, 20],
  'gpt-5': [1.25, 10],
  'gpt-5-mini': [0.25, 2],
  'openai/gpt-5': [1.25, 10],
  'openai/gpt-5-mini': [0.25, 2]
});
const PROVIDER_DEFAULT_PRICE = Object.freeze({
  gemini_paid: [0.75, 3.75], anthropic: [4, 20], openai: [1.25, 10], openrouter: [1.25, 10], gateway: [1.25, 10]
});
// Cartesia: per 1M characters. Replicate: per unit (one image, one clip,
// one music bed), the dearest the PG1 media paths use.
export const CARTESIA_USD_PER_MCHAR = 50;
export const MEDIA_UNIT_USD = Object.freeze({ image_gemini: 0.04, image_replicate: 0.003, video_gemini: 0.75, video_replicate: 1.4, music_replicate: 0.06, still_replicate: 0.04 });

// --- keys --------------------------------------------------------------------

const clean = (v) => String(v || '').replace(/\s+/g, '');
const firstOf = (env, names) => {
  for (const n of names) { const v = clean(env[n]); if (v) return v; }
  return '';
};
const uniq = (list) => [...new Set(list.filter(Boolean))];

// Gemini speech is opt-in: PG1_TTS_FREE_FIRST=1 (default off) and a voice
// named in PG1_TTS_GEMINI_VOICE. Otherwise Cartesia is the only voice.
export function ttsFreeFirst(env = {}) {
  return String(env.PG1_TTS_FREE_FIRST || '').trim() === '1';
}

export function geminiTtsVoice(env = {}) {
  const v = typeof env.PG1_TTS_GEMINI_VOICE === 'string' ? env.PG1_TTS_GEMINI_VOICE.trim() : '';
  return /^[A-Za-z][A-Za-z-]{1,40}$/.test(v) ? v : '';
}

export function legacyGeminiKeys(env = {}) {
  return uniq([env.GEMINI_API_KEY1, env.GEMINI_API_KEY2, env.GEMINI_API_KEY].map(clean));
}

// The key pools by role. geminiFree may receive operator content only;
// geminiPaid never holds the free key's value.
export function resolveKeys(env = {}) {
  const free = clean(env.GEMINI_API_KEY_FREE);
  const paid = clean(env.GEMINI_API_KEY_PAID);
  const legacy = legacyGeminiKeys(env);
  return {
    geminiFree: free ? [free] : [],
    geminiPaid: uniq(paid ? [paid] : legacy).filter((k) => k !== free),
    ttsGemini: free && ttsFreeFirst(env) && geminiTtsVoice(env) ? free : '',
    anthropic: firstOf(env, ['ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY']),
    openai: firstOf(env, ['OPENAI_API_KEY']),
    openrouter: firstOf(env, ['OPENROUTER_API_KEY', 'OPEN_ROUTER_KEY']),
    gateway: firstOf(env, ['VERCEL_AI_API_KEY', 'AI_GATEWAY_API_KEY']),
    replicate: firstOf(env, ['REPLICATE_API_TOKEN', 'REPLICATE_KEY']),
    cartesia: firstOf(env, ['CARTESIA_API_KEY'])
  };
}

// Gemini keys for media (image and video): the paid key only, with
// Replicate as the media paths' own fallback after them.
export function mediaGeminiKeys(env = {}) {
  return resolveKeys(env).geminiPaid;
}

// --- task and data classification --------------------------------------------

const LIGHT_LEAD_RE = /^\s*(?:please\s+)?(?:summari[sz]e|sum up|tl;?dr|classify|categori[sz]e|label|tag|format|reformat|tidy|clean up|rewrite|rephrase|reword|translate|proofread|shorten|condense|bullet|list|extract|convert)\b/i;
const HEAVY_RE = /\b(?:threat\w*|exploit\w*|vulnerab\w*|cve-\d|malware|phishing|ransomware|incident\w*|forensic\w*|breach\w*|attack\w*|secur\w*|pentest\w*|audit\w*|harden\w*|code|coding|refactor\w*|debug\w*|stack ?trace|bugs?|architect\w*|design doc|storyboard\w*|analy[sz]\w*|investigat\w*|root cause|decide|decision\w*|should (?:we|i)|risk\w*)\b/i;
export const HEAVY_LENGTH_CHARS = 1500;

// light or heavy for a piece of operator text. /core always means heavy.
export function classifyTask(text, { command = '' } = {}) {
  const t = String(text || '');
  if (/^\/(?:core|claude)\b/i.test(command || t.trim())) return TASKS.HEAVY;
  if (/```/.test(t)) return TASKS.HEAVY;
  if (LIGHT_LEAD_RE.test(t)) return TASKS.LIGHT;
  if (HEAVY_RE.test(t)) return TASKS.HEAVY;
  if (t.length > HEAVY_LENGTH_CHARS) return TASKS.HEAVY;
  return TASKS.LIGHT;
}

// Tools whose results describe customers or guests (who called PG1's paid
// API, from which client): a round that carries one is customer data.
export const CUSTOMER_DATA_TOOLS = Object.freeze(['get_usage_stats']);
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /\+\d[\d\s().-]{7,}\d/;
// The usage card (lib/chatTools.mjs usageReport) quoted back from history.
const USAGE_MARKER_RE = /\btop mcp clients\b|\bdistinct callers\b|\bpaid settlements\b|###\s*\[\s*USAGE\b/i;

export function containsCustomerData(text) {
  const t = String(text || '');
  return EMAIL_RE.test(t) || PHONE_RE.test(t) || USAGE_MARKER_RE.test(t);
}

function turnsMention(turns, names) {
  if (!Array.isArray(turns)) return false;
  return turns.some((turn) => {
    const s = JSON.stringify(turn || '');
    return names.some((n) => s.includes(`"${n}"`));
  });
}

// 'operator' only when the caller is the signed-in operator (isOperator
// exactly true) and nothing in the request carries customer or guest data;
// 'customer' otherwise. A guest or customer session is customer data
// regardless of content, so it is only ever planned on paid providers.
export function dataClassFor({ isOperator = false, texts = [], turns = [] } = {}) {
  if (isOperator !== true) return DATA.CUSTOMER;
  if (turnsMention(turns, CUSTOMER_DATA_TOOLS)) return DATA.CUSTOMER;
  if (texts.some(containsCustomerData)) return DATA.CUSTOMER;
  return DATA.OPERATOR;
}

// --- failures and the breaker -------------------------------------------------

const QUOTA_RE = /quota|resource[_ ]exhausted|rate[_ ]?limit|billing|credit|insufficient|payment|balance|exceeded|overloaded|capacity/i;
const SAFETY_RE = /\bsafety\b|content (?:policy|filter|moderation)|\bblocked\b|prohibited|\bnsfw\b/i;

// Moves on to the next candidate: 429, quota or billing (402, or a 400/403
// that says so), 5xx, a timeout or network error (status null), 401/403
// (a bad or revoked key) and 404 (a model that is gone). A safety refusal
// never moves on.
export function isFallbackFailure(status, text = '') {
  const t = String(text || '');
  if (SAFETY_RE.test(t) && !QUOTA_RE.test(t)) return false;
  if (status == null) return true;
  if (status === 429 || status === 402 || status >= 500) return true;
  if (status === 401 || status === 403 || status === 404) return true;
  return QUOTA_RE.test(t);
}

export const BREAKER_WINDOW_MS = 15 * 60 * 1000;
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const BILLING_RE = /billing|credit|prepa(?:id|y)|balance|payment|insufficient|spend(?:ing)? cap|exhausted your/i;
const openUntil = new Map();

// A key that answered 402 or a billing / credit error (a drained prepaid
// key) is moved to the back of every plan for BREAKER_WINDOW_MS, a plain
// 429 (rate limit) for RATE_LIMIT_WINDOW_MS, so requests go straight to a
// key that works instead of paying a round trip first. A tripped key is
// still tried last, so a deployment with one key is never left with none.
export function tripBreaker(keyId, status, text = '', now = Date.now()) {
  const t = String(text || '');
  if (status === 402 || (status != null && status < 500 && BILLING_RE.test(t))) {
    openUntil.set(keyId, now + BREAKER_WINDOW_MS);
    return true;
  }
  if (status === 429) {
    openUntil.set(keyId, Math.max(openUntil.get(keyId) || 0, now + RATE_LIMIT_WINDOW_MS));
    return true;
  }
  return false;
}

export function isTripped(keyId, now = Date.now()) {
  const until = openUntil.get(keyId);
  if (until === undefined) return false;
  if (now >= until) { openUntil.delete(keyId); return false; }
  return true;
}

export function __resetRouterState() {
  openUntil.clear();
  textCache.clear();
  ttsCache.clear();
  memoryLedger.clear();
  sharedLedgers.clear();
}

// --- models and prices ----------------------------------------------------------

export function routeModels(env = {}, task, provider) {
  const name = MODEL_ENV[task] && MODEL_ENV[task][provider];
  const raw = name && typeof env[name] === 'string' ? env[name] : '';
  const list = raw.split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,100}$/.test(s));
  if (list.length) return list;
  const d = DEFAULT_ROUTE_MODELS[task] && DEFAULT_ROUTE_MODELS[task][provider];
  return d ? [...d] : [];
}

function priceEnvName(model) {
  return `PG1_PRICE_${String(model).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export function modelPrice(env = {}, provider, model) {
  const raw = typeof env[priceEnvName(model)] === 'string' ? env[priceEnvName(model)] : '';
  const parts = raw.split(',').map(Number);
  if (parts.length === 2 && parts.every((n) => Number.isFinite(n) && n >= 0)) return parts;
  return PRICES[model] || PROVIDER_DEFAULT_PRICE[provider] || [0, 0];
}

// Estimated USD for one call. The free key costs nothing.
export function estimateCost({ env = {}, provider, model, inputTokens = 0, outputTokens = 0, chars = 0, unit = '' } = {}) {
  if (provider === 'gemini_free') return 0;
  if (provider === 'cartesia') return (chars / 1e6) * CARTESIA_USD_PER_MCHAR;
  if (unit) return MEDIA_UNIT_USD[unit] || 0;
  const [pin, pout] = modelPrice(env, provider, model);
  return (inputTokens / 1e6) * pin + (outputTokens / 1e6) * pout;
}

// Rough token count when a provider does not report usage.
export const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

// --- budgets and the ledger -------------------------------------------------------

export function budgetEnvName(provider) {
  return `PG1_DAILY_BUDGET_${String(provider).toUpperCase()}_USD`;
}

// The provider's daily budget in USD, or Infinity when none is set.
export function dailyBudgetUsd(env = {}, provider) {
  const raw = env[budgetEnvName(provider)];
  if (raw === undefined || raw === null || String(raw).trim() === '') return Infinity;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : Infinity;
}

export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

// In-memory ledger: today's spend per provider on this instance, plus the
// rows for the summary. Always written, so budgets hold even without a
// database; the Supabase ledger adds the other instances' spend.
export function createMemoryLedger({ maxRows = 5000 } = {}) {
  const rows = [];
  return {
    record(row) {
      rows.push(row);
      if (rows.length > maxRows) rows.splice(0, rows.length - maxRows);
    },
    rows(day) { return rows.filter((r) => r.day === day); },
    spent(day, provider) {
      return rows.reduce((s, r) => (r.day === day && r.provider === provider ? s + (r.cost_usd || 0) : s), 0);
    },
    clear() { rows.length = 0; }
  };
}

export const memoryLedger = createMemoryLedger();

// Supabase ledger (pg1_ai_usage, supabase/migrations/20261012120000_pg1_ai_usage.sql).
// Writes are fire-and-forget; spend per provider for a day is read through
// pg1_ai_spend and kept for SPEND_REFRESH_MS, so a budget check never waits
// on the database. Any failure leaves the in-memory figures in charge.
export const SPEND_REFRESH_MS = 60 * 1000;
export const USAGE_TABLE = 'pg1_ai_usage';
export const SPEND_RPC = 'pg1_ai_spend';
const sharedLedgers = new Map();

export function createSupabaseLedger({ supUrl, supKey, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const headers = { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json' };
  const spendByDay = new Map();
  const loading = new Map();
  const load = (day) => {
    if (loading.has(day)) return loading.get(day);
    const p = (async () => {
      try {
        const res = await fetchImpl(`${supUrl}/rest/v1/rpc/${SPEND_RPC}`, { method: 'POST', headers, body: JSON.stringify({ p_day: day }), cache: 'no-store' });
        if (!res.ok) return null;
        const list = await res.json();
        const totals = {};
        for (const r of Array.isArray(list) ? list : []) totals[r.provider] = { calls: Number(r.calls) || 0, cost_usd: Number(r.cost_usd) || 0, cached: Number(r.cached) || 0 };
        spendByDay.set(day, { at: now(), totals });
        return totals;
      } catch (e) {
        return null;
      } finally {
        loading.delete(day);
      }
    })();
    loading.set(day, p);
    return p;
  };
  return {
    record(row) {
      const day = spendByDay.get(row.day);
      if (day) {
        const t = day.totals[row.provider] || (day.totals[row.provider] = { calls: 0, cost_usd: 0, cached: 0 });
        t.calls++; t.cost_usd += row.cost_usd || 0; if (row.cached) t.cached++;
      }
      return Promise.resolve(fetchImpl(`${supUrl}/rest/v1/${USAGE_TABLE}`, { method: 'POST', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify(row), cache: 'no-store' })).catch(() => {});
    },
    // Last known shared spend (refreshed in the background), or null.
    spent(day, provider) {
      const d = spendByDay.get(day);
      if (!d || now() - d.at > SPEND_REFRESH_MS) load(day);
      return d && d.totals[provider] ? d.totals[provider].cost_usd : null;
    },
    totals: async (day) => {
      const d = spendByDay.get(day);
      if (d && now() - d.at <= SPEND_REFRESH_MS) return d.totals;
      return (await load(day)) || (d ? d.totals : null);
    }
  };
}

// The ledger for a deployment: the shared one when the database is
// configured (one per URL), else none.
export function sharedLedger({ supUrl, supKey, fetchImpl } = {}) {
  if (!supUrl || !supKey) return null;
  if (!sharedLedgers.has(supUrl)) sharedLedgers.set(supUrl, createSupabaseLedger({ supUrl, supKey, fetchImpl }));
  return sharedLedgers.get(supUrl);
}

export function spentToday(provider, { ledger = null, now = Date.now() } = {}) {
  const day = utcDay(now);
  const local = memoryLedger.spent(day, provider);
  const shared = ledger ? ledger.spent(day, provider) : null;
  return shared == null ? local : Math.max(shared, local);
}

export function budgetAllows(env, provider, { ledger = null, now = Date.now() } = {}) {
  const budget = dailyBudgetUsd(env, provider);
  if (budget === Infinity) return true;
  return spentToday(provider, { ledger, now }) < budget;
}

const ROW_FIELDS = ['day', 'provider', 'model', 'task', 'data_class', 'input_tokens', 'output_tokens', 'chars', 'unit', 'cost_usd', 'cached', 'ok', 'status', 'fallback', 'request_id'];

// One usage row: logged and kept. Only the fields above, so content and
// keys can never reach the log or the table.
export function recordUsage(entry = {}, { env = {}, ledger = null, now = Date.now(), log = console.log } = {}) {
  const row = {
    day: utcDay(now),
    provider: String(entry.provider || 'unknown').slice(0, 32),
    model: String(entry.model || '').slice(0, 100),
    task: String(entry.task || '').slice(0, 16),
    data_class: entry.dataClass === DATA.OPERATOR ? DATA.OPERATOR : DATA.CUSTOMER,
    input_tokens: Math.max(0, Math.round(Number(entry.inputTokens) || 0)),
    output_tokens: Math.max(0, Math.round(Number(entry.outputTokens) || 0)),
    chars: Math.max(0, Math.round(Number(entry.chars) || 0)),
    unit: entry.unit ? String(entry.unit).slice(0, 32) : null,
    cost_usd: 0,
    cached: !!entry.cached,
    ok: entry.ok !== false,
    status: Number.isInteger(entry.status) ? entry.status : null,
    fallback: Math.max(0, Number(entry.fallback) || 0),
    request_id: entry.requestId ? String(entry.requestId).slice(0, 64) : null
  };
  if (!row.cached && row.ok) {
    row.cost_usd = Number(estimateCost({ env, provider: row.provider, model: row.model, inputTokens: row.input_tokens, outputTokens: row.output_tokens, chars: row.chars, unit: row.unit }).toFixed(6));
  }
  const safe = {};
  for (const k of ROW_FIELDS) safe[k] = row[k];
  memoryLedger.record(safe);
  if (ledger) ledger.record(safe);
  try { log(`[pg1-ai-usage] ${JSON.stringify(safe)}`); } catch (e) { /* logging never breaks a reply */ }
  return safe;
}

// --- cache ---------------------------------------------------------------------------

// A small LRU with a TTL and a byte cap, per server instance.
export function createLruCache({ maxEntries = 500, maxBytes = 32 * 1024 * 1024, ttlMs = 10 * 60 * 1000 } = {}) {
  const map = new Map();
  let bytes = 0;
  const sizeOf = (v) => (v && v.byteLength !== undefined ? v.byteLength : (typeof v === 'string' ? v.length * 2 : JSON.stringify(v || '').length * 2));
  const drop = (k) => {
    const e = map.get(k);
    if (e) { bytes -= e.size; map.delete(k); }
  };
  return {
    get(key, now = Date.now()) {
      const e = map.get(key);
      if (!e) return undefined;
      if (now >= e.expires) { drop(key); return undefined; }
      map.delete(key); map.set(key, e);
      return e.value;
    },
    set(key, value, { ttl = ttlMs, now = Date.now() } = {}) {
      const size = sizeOf(value);
      if (size > maxBytes) return;
      drop(key);
      map.set(key, { value, size, expires: now + ttl });
      bytes += size;
      while (map.size > maxEntries || bytes > maxBytes) drop(map.keys().next().value);
    },
    clear() { map.clear(); bytes = 0; },
    get size() { return map.size; }
  };
}

export const TEXT_CACHE_TTL_MS = 10 * 60 * 1000;
export const TTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const textCache = createLruCache({ maxEntries: 500, maxBytes: 8 * 1024 * 1024, ttlMs: TEXT_CACHE_TTL_MS });
export const ttsCache = createLruCache({ maxEntries: 400, maxBytes: 32 * 1024 * 1024, ttlMs: TTS_CACHE_TTL_MS });

// Off with PG1_AI_CACHE=0. Under Node's test runner (NODE_TEST_CONTEXT) it
// is off unless PG1_AI_CACHE=1, so one test's answer is never served to
// another test that expects a provider call (tests/ai-router.test.mjs turns
// it on to test it).
export function cacheEnabled(env = {}) {
  const v = String(env.PG1_AI_CACHE || '').trim();
  if (v === '0') return false;
  if (v === '1') return true;
  return !process.env.NODE_TEST_CONTEXT;
}

// The cache identity for a chat request: the signed-in operator, or a
// guest by the client address the request came from. '' when there is no
// identity to scope by, which turns the cache off for that request.
export function cacheIdentity({ isOperator = false, operatorId = '', clientId = '' } = {}) {
  if (isOperator === true) return `operator:${String(operatorId || 'operator')}`;
  const c = String(clientId || '').trim();
  return c && c !== 'unknown' ? `guest:${c}` : '';
}

// A stable key over the caller's identity and everything that shapes the
// answer. Hashed, so the cache index holds no content. Every key is scoped
// to one user: with no identity it is null, and a null key is never cached
// (runRoute, chat and TTS all skip the cache then).
export function cacheKey(identity, ...parts) {
  if (!identity || typeof identity !== 'string') return null;
  const h = crypto.createHash('sha256');
  h.update('id:').update(identity).update('\u0000');
  for (const p of parts) h.update(typeof p === 'string' ? p : JSON.stringify(p === undefined ? null : p)).update('\u0000');
  return h.digest('hex');
}

// --- planning ---------------------------------------------------------------------------

const OPENAI_COMPAT = Object.freeze({
  gateway: 'https://ai-gateway.vercel.sh/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions'
});
export const OPENAI_COMPAT_URLS = OPENAI_COMPAT;

function geminiCandidates(keys, role, models) {
  return keys.map((key, i) => ({ provider: role, family: 'gemini', key, keyId: `${role}#${i + 1}`, keySlot: i + 1, models }));
}

// The ordered candidates for a task. Each is { provider (ledger name),
// family (wire format: gemini, anthropic, openai_compat, cartesia), key,
// keyId, models, url? }. Candidates the content may not go to (the free
// key for customer data), whose provider is over budget, or whose key is
// in its breaker window goes to the back. withTools: false leaves out the
// OpenAI-compatible backups, which PG1 calls without functions.
export function planRoute(task, { env = {}, dataClass = DATA.CUSTOMER, withTools = false, ledger = null, now = Date.now() } = {}) {
  const k = resolveKeys(env);
  const operator = dataClass === DATA.OPERATOR;
  const out = [];
  const freeGemini = (models) => (operator ? geminiCandidates(k.geminiFree, 'gemini_free', models) : []);
  const paidGemini = (models) => geminiCandidates(k.geminiPaid, 'gemini_paid', models);
  const anthropic = (models) => (k.anthropic ? [{ provider: 'anthropic', family: 'anthropic', key: k.anthropic, keyId: 'anthropic', models }] : []);
  const compat = (t) => (withTools ? [] : ['gateway', 'openrouter', 'openai']
    .filter((p) => k[p])
    .map((p) => ({ provider: p, family: 'openai_compat', key: k[p], keyId: p, models: routeModels(env, t, p), url: OPENAI_COMPAT[p] })));

  if (task === TASKS.LIGHT) {
    const gm = routeModels(env, 'light', 'gemini');
    out.push(...freeGemini(gm), ...paidGemini(gm), ...anthropic(routeModels(env, 'light', 'anthropic')), ...compat('light'));
  } else if (task === TASKS.HEAVY) {
    const gm = routeModels(env, 'heavy', 'gemini');
    out.push(...anthropic(routeModels(env, 'heavy', 'anthropic')), ...paidGemini(gm), ...freeGemini(gm), ...compat('heavy'));
  } else if (task === TASKS.TTS) {
    if (operator && k.ttsGemini) out.push({ provider: 'gemini_free', family: 'gemini_tts', key: k.ttsGemini, keyId: 'gemini_free#tts', models: routeModels(env, 'tts', 'gemini') });
    if (k.cartesia) out.push({ provider: 'cartesia', family: 'cartesia', key: k.cartesia, keyId: 'cartesia', models: [String(env.CARTESIA_MODEL_ID || '').trim() || 'sonic-3.6'] });
  } else if (task === TASKS.MEDIA) {
    out.push(...geminiCandidates(k.geminiPaid, 'gemini_paid', []));
    if (k.replicate) out.push({ provider: 'replicate', family: 'replicate', key: k.replicate, keyId: 'replicate', models: [] });
  }

  // One attempt per distinct key and family: an old key that serves both
  // roles is tried once.
  const seen = new Set();
  const allowed = out.filter((c) => {
    const id = `${c.family}|${c.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    if (c.provider === 'gemini_free' && !operator) return false;
    return budgetAllows(env, c.provider, { ledger, now });
  });
  // Keys in their breaker window go last, in their own order.
  return allowed.filter((c) => !isTripped(c.keyId, now)).concat(allowed.filter((c) => isTripped(c.keyId, now)));
}

// --- generic execution ----------------------------------------------------------------------

// Runs a plan: `attempt(candidate)` resolves to { ok, status, text?, value?,
// usage?: { inputTokens, outputTokens, chars, unit }, model, detail,
// refused? }. Moves on per isFallbackFailure, trips the breaker, records
// usage, and answers an identical request from `cache` when given a key.
// Resolves to { ok, value, candidate, model, cached, attempts, failures }.
export async function runRoute({ task, env = {}, dataClass = DATA.CUSTOMER, plan = null, attempt, cache = null, key = null, ttlMs, ledger = null, requestId = null, log = console.log, now = () => Date.now() }) {
  const candidates = plan || planRoute(task, { env, dataClass, ledger, now: now() });
  const useCache = cache && key && cacheEnabled(env);
  if (useCache) {
    const hit = cache.get(key, now());
    if (hit !== undefined) {
      recordUsage({ provider: hit.provider, model: hit.model, task, dataClass, cached: true, requestId }, { env, ledger, now: now(), log });
      return { ok: true, value: hit.value, candidate: null, model: hit.model, cached: true, attempts: 0, failures: [] };
    }
  }
  const failures = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    let r;
    try {
      r = await attempt(c);
    } catch (e) {
      r = { ok: false, status: null, detail: e && e.message };
    }
    if (r && r.ok) {
      const u = r.usage || {};
      recordUsage({ provider: c.provider, model: r.model || c.models[0] || '', task, dataClass, inputTokens: u.inputTokens, outputTokens: u.outputTokens, chars: u.chars, unit: u.unit, ok: true, fallback: i, requestId }, { env, ledger, now: now(), log });
      if (useCache) cache.set(key, { value: r.value, provider: c.provider, model: r.model || c.models[0] || '' }, { ttl: ttlMs, now: now() });
      return { ok: true, value: r.value, candidate: c, model: r.model || c.models[0] || '', cached: false, attempts: i + 1, failures };
    }
    const status = r ? r.status : null;
    failures.push({ provider: c.provider, keyId: c.keyId, model: (r && r.model) || '', status, detail: r && r.detail ? String(r.detail).slice(0, 300) : '' });
    recordUsage({ provider: c.provider, model: (r && r.model) || c.models[0] || '', task, dataClass, ok: false, status, fallback: i, requestId }, { env, ledger, now: now(), log });
    tripBreaker(c.keyId, status, r && r.detail, now());
    if (r && r.refused) break;
    if (!isFallbackFailure(status, r && r.detail)) break;
  }
  return { ok: false, value: null, candidate: null, model: '', cached: false, attempts: failures.length, failures };
}

// One text call on an OpenAI-compatible endpoint (the AI gateway,
// OpenRouter, OpenAI): system + one user message, no functions.
export async function callOpenAiCompat({ candidate, model, system, prompt, fetchImpl = globalThis.fetch, timeoutMs = 20000, maxTokens = 4096 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetchImpl(candidate.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${candidate.key}` },
      body: JSON.stringify({ model, max_completion_tokens: maxTokens, messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }] }),
      cache: 'no-store',
      signal: controller.signal
    });
    const raw = await res.text();
    if (!res.ok) return { ok: false, status: res.status, model, detail: raw.slice(0, 300) };
    let json = null;
    try { json = JSON.parse(raw); } catch (e) { /* not JSON */ }
    const text = json && json.choices && json.choices[0] && json.choices[0].message && typeof json.choices[0].message.content === 'string' ? json.choices[0].message.content : '';
    if (!text) return { ok: false, status: res.status, model, detail: 'no text in the answer' };
    const usage = (json && json.usage) || {};
    return { ok: true, status: res.status, model, value: text, text, usage: { inputTokens: usage.prompt_tokens || estimateTokens((system || '') + prompt), outputTokens: usage.completion_tokens || estimateTokens(text) } };
  } catch (e) {
    return { ok: false, status: null, model, detail: controller.signal.aborted ? 'timed out' : e && e.message };
  } finally {
    clearTimeout(timer);
  }
}

// --- the operator's spend summary ---------------------------------------------------------------------

const usd = (n) => `$${(Number(n) || 0).toFixed(n >= 1 ? 2 : 4)}`;

// Today's (or a given day's) spend per engine, as markdown for the
// operator. PG1 labels only. `totals` comes from the shared ledger when it
// answered; the instance's own rows otherwise.
export async function spendSummary({ env = {}, ledger = null, day = utcDay() } = {}) {
  let totals = ledger && ledger.totals ? await ledger.totals(day) : null;
  let scope = 'all instances';
  if (!totals) {
    scope = 'this server instance only (the usage table is not available)';
    totals = {};
    for (const r of memoryLedger.rows(day)) {
      const t = totals[r.provider] || (totals[r.provider] = { calls: 0, cost_usd: 0, cached: 0 });
      t.calls++; t.cost_usd += r.cost_usd || 0; if (r.cached) t.cached++;
    }
  }
  const lines = [`### [ AI SPEND · ${day} UTC ]`];
  let total = 0;
  for (const p of PROVIDERS) {
    const t = totals[p];
    const budget = dailyBudgetUsd(env, p);
    if (!t && budget === Infinity) continue;
    const spent = t ? t.cost_usd : 0;
    total += spent;
    const cap = budget === Infinity ? 'no daily cap' : `cap ${usd(budget)}${spent >= budget ? ', reached: switched off until 00:00 UTC' : ''}`;
    lines.push(`- **${ENGINE_LABELS[p]}**: ${usd(spent)} over ${t ? t.calls : 0} calls${t && t.cached ? ` (${t.cached} from cache)` : ''} · ${cap}`);
  }
  if (lines.length === 1) lines.push('- No AI calls recorded yet.');
  lines.push(`- **Total**: ${usd(total)} (estimated from list prices; scope: ${scope})`);
  return lines.join('\n');
}
