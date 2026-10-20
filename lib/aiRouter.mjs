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
//   media  video, images: paid keys only; the paid Gemini key is
//          prepaid and can run out, so Replicate is the fallback
//   music  original music (/music, and /film's music beds): paid keys only.
//          ElevenLabs Music (only when ELEVENLABS_API_KEY is set; WAV), then
//          Lyria on the paid Gemini key (PG1_MUSIC_LYRIA_MODEL, default
//          lyria-3.5; previews and short tracks use the 30-second clip
//          model first, PG1_MUSIC_LYRIA_CLIP_MODEL, default
//          lyria-3-clip-preview), then Replicate's music model
//          (lib/music/engines.mjs)
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
//   ElevenLabs    ELEVENLABS_API_KEY (music only, optional)
// TTS is Cartesia, so PG1 always speaks in the same voice. The free Gemini
// key (GEMINI_API_KEY_FREE only, never an old Gemini name) is tried first
// for operator speech only when PG1_TTS_FREE_FIRST=1 and a voice is named
// in PG1_TTS_GEMINI_VOICE; there is no default Gemini voice.
//
// Cost control. The operator's identical requests are answered from a
// per-instance cache (text and TTS); every cache key carries the operator's
// identity. Guest and customer sessions are never cached at all.
// PG1_DAILY_BUDGET_<PROVIDER>_USD caps a provider's estimated spend per UTC
// day; a provider over budget is left out of every
// plan until the day turns. Every call is logged as one
// "[pg1-ai-usage] {...}" line and one ledger row with provider, model,
// task, tokens and estimated cost: never the content, never a key.
//
// White label. Replies, traces and the /spend summary only ever use the
// PG1 labels in ENGINE_LABELS; provider names stay in logs and config.

import crypto from 'node:crypto';
import { ROUTING_CHAINS, ENGINE_UNIT_COSTS, clientAllowedStep } from './capabilities/registry.mjs';
import { CATALOG_PROVIDERS, MODEL_PREFERENCES, catalogModelIds } from './router/modelCatalog.mjs';

export const TASKS = Object.freeze({ LIGHT: 'light', HEAVY: 'heavy', TTS: 'tts', MEDIA: 'media', MUSIC: 'music' });
export const DATA = Object.freeze({ OPERATOR: 'operator', CUSTOMER: 'customer' });

// Ledger / budget names. gemini_free and gemini_paid are budgeted apart.
// The no-card free engines (Groq, Mistral's Experiment plan, GitHub Models,
// Cloudflare Workers AI): operator content only, like the free Gemini key
// (their free tiers' terms are unclear for client work, and some may use
// free-tier data for training), each with its own key and per-minute pace.
export const FREE_COMPAT_PROVIDERS = Object.freeze(['groq', 'mistral', 'github_models', 'cloudflare']);
// Operator-only engines: the free Gemini key and the no-card free engines.
export const OPERATOR_ONLY_PROVIDERS = Object.freeze(['gemini_free', ...FREE_COMPAT_PROVIDERS]);
export const PROVIDERS = Object.freeze(['gemini_free', 'gemini_paid', 'anthropic', 'openai', 'openrouter', 'gateway', ...FREE_COMPAT_PROVIDERS, 'replicate', 'cartesia', 'elevenlabs']);

export const ENGINE_LABELS = Object.freeze({
  gemini_free: 'PG1 main core (free tier)',
  gemini_paid: 'PG1 main core',
  anthropic: 'PG1 reasoning core',
  gateway: 'PG1 backup core A',
  groq: 'PG1 free core A',
  mistral: 'PG1 free core B',
  github_models: 'PG1 free core C',
  cloudflare: 'PG1 free core D',
  openrouter: 'PG1 backup core B',
  openai: 'PG1 backup core C',
  replicate: 'PG1 media engine',
  cartesia: 'PG1 voice engine',
  elevenlabs: 'PG1 music engine'
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
    openai: Object.freeze(['gpt-5-mini']),
    // The free engines' lists are their preference lists, narrowed each day
    // to the models the engine still lists (lib/router/modelCatalog.mjs).
    groq: MODEL_PREFERENCES.groq.light,
    mistral: Object.freeze(['mistral-small-latest']),
    github_models: MODEL_PREFERENCES.github_models.light,
    cloudflare: MODEL_PREFERENCES.cloudflare.light
  }),
  heavy: Object.freeze({
    anthropic: Object.freeze(['claude-opus-5-5', 'claude-sonnet-5-5']),
    gemini: Object.freeze(['gemini-3.8-flash', 'gemini-3.6-flash']),
    gateway: Object.freeze(['openai/gpt-5']),
    openrouter: Object.freeze(['openai/gpt-5']),
    openai: Object.freeze(['gpt-5']),
    groq: MODEL_PREFERENCES.groq.heavy,
    mistral: Object.freeze(['mistral-medium-latest', 'mistral-small-latest']),
    github_models: MODEL_PREFERENCES.github_models.heavy,
    cloudflare: MODEL_PREFERENCES.cloudflare.heavy
  }),
  tts: Object.freeze({
    gemini: Object.freeze(['gemini-3.1-flash-tts-preview'])
  }),
  music: Object.freeze({
    elevenlabs: Object.freeze(['music_v2_5']),
    gemini: Object.freeze(['lyria-3.5']),
    gemini_clip: Object.freeze(['lyria-3-clip-preview'])
  })
});

const MODEL_ENV = Object.freeze({
  light: { gemini: 'PG1_LIGHT_GEMINI_MODELS', anthropic: 'PG1_LIGHT_ANTHROPIC_MODELS', gateway: 'PG1_LIGHT_GATEWAY_MODELS', openrouter: 'PG1_LIGHT_OPENROUTER_MODELS', openai: 'PG1_LIGHT_OPENAI_MODELS', groq: 'PG1_LIGHT_GROQ_MODELS', mistral: 'PG1_LIGHT_MISTRAL_MODELS', github_models: 'PG1_LIGHT_GITHUB_MODELS', cloudflare: 'PG1_LIGHT_CLOUDFLARE_MODELS' },
  heavy: { gemini: 'PG1_HEAVY_GEMINI_MODELS', anthropic: 'PG1_HEAVY_ANTHROPIC_MODELS', gateway: 'PG1_HEAVY_GATEWAY_MODELS', openrouter: 'PG1_HEAVY_OPENROUTER_MODELS', openai: 'PG1_HEAVY_OPENAI_MODELS', groq: 'PG1_HEAVY_GROQ_MODELS', mistral: 'PG1_HEAVY_MISTRAL_MODELS', github_models: 'PG1_HEAVY_GITHUB_MODELS', cloudflare: 'PG1_HEAVY_CLOUDFLARE_MODELS' },
  tts: { gemini: 'PG1_TTS_GEMINI_MODEL' },
  music: { elevenlabs: 'PG1_MUSIC_ELEVENLABS_MODEL', gemini: 'PG1_MUSIC_LYRIA_MODEL', gemini_clip: 'PG1_MUSIC_LYRIA_CLIP_MODEL' }
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
// Media and voice prices come from the capability registry
// (ENGINE_UNIT_COSTS): the price of the engine that made the call, never a
// worst case. TTS: per 1M characters. Media: per unit, at PG1's default
// length (a 5 s clip, one track); a caller that knows the length passes
// costUsd (lib/capabilities/registry.mjs engineCostUsd).
const perMChar = (unit) => ENGINE_UNIT_COSTS[unit].usd * 1000;
export const CARTESIA_USD_PER_MCHAR = perMChar('tts_cartesia');
// ElevenLabs text to speech: the dearer of its pages' 0.08-0.10 USD per
// 1,000 characters.
export const ELEVENLABS_TTS_USD_PER_MCHAR = perMChar('tts_elevenlabs');
export const MEDIA_UNIT_USD = Object.freeze({
  // /image: not in the capability registry; PG1's own estimates.
  image_gemini: 0.04, image_replicate: 0.003,
  // Replicate's Lyria 2: no longer routed (R1); kept for old ledger rows.
  music_replicate: 0.06,
  ...Object.fromEntries(Object.entries(ENGINE_UNIT_COSTS).filter(([, c]) => c.flat != null).map(([u, c]) => [u, c.flat]))
});

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
    cartesia: firstOf(env, ['CARTESIA_API_KEY']),
    elevenlabs: firstOf(env, ['ELEVENLABS_API_KEY']),
    groq: firstOf(env, ['GROQ_API_KEY']),
    mistral: firstOf(env, ['MISTRAL_API_KEY']),
    github_models: firstOf(env, ['GITHUB_MODELS_TOKEN']),
    // Workers AI needs the account id with the token (its URL carries it).
    cloudflare: clean(env.CLOUDFLARE_ACCOUNT_ID) && /^[0-9a-f]{32}$/i.test(clean(env.CLOUDFLARE_ACCOUNT_ID)) ? firstOf(env, ['CLOUDFLARE_AI_TOKEN']) : '',
    cloudflareAccount: clean(env.CLOUDFLARE_ACCOUNT_ID)
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

// Out of credit, from any provider, whatever the status. Anthropic answers a
// drained account with a 400 invalid_request_error ("Your credit balance is
// too low to access the Anthropic API. Please go to Plans & Billing to
// upgrade or purchase credits."), OpenRouter with a 402 ("Insufficient
// credits", "requires more credits"), OpenAI with a 429 insufficient_quota,
// a prepaid Gemini key with a 429 whose message names the prepayment.
const BILLING_RE = /credit balance|(?:insufficient|not enough|out of|no (?:remaining )?|more|purchase|buy|add) (?:\w+ )?(?:credits?|funds|balance)|credits? (?:have |has )?(?:run out|been (?:exhausted|depleted)|exhausted|depleted|expired)|insufficient[_ ]quota|billing|prepa(?:id|y)|payment (?:required|method|failed|overdue)|spend(?:ing)? (?:cap|limit)|exhausted your|hard[_ ]limit|account (?:balance|has no credit)/i;

// A billing failure: 402, or any status below 500 whose message says the
// account or key is out of credit. Moves on (isFallbackFailure) and opens
// the breaker for BREAKER_WINDOW_MS (tripBreaker), even on a 400.
// Google's every 429 says "You exceeded your current quota, please check
// your plan and billing details", a per-minute rate limit included: that
// sentence alone is not a billing failure (request sjv9vnbs, 17 Oct: the
// free key's 429 was read as an empty account, so it was never waited for
// and its breaker opened for 15 minutes). A prepaid key that ran out still
// names the prepayment, which BILLING_RE catches.
const GOOGLE_QUOTA_BOILERPLATE_RE = /please check your plan and billing details\.?/gi;
// SPEND CAP: Gemini's 429 "Your project has exceeded its monthly spending
// cap" (19 Oct: the movie stopped as out_of_credit at shots, and the paid
// chat call got the same 429). The account has credit; the operator's own
// monthly cap in AI Studio stopped it. Its own code, spend_cap_reached,
// apart from rate_limited (waiting does not help until the month turns or
// the cap is raised) and out_of_credit (topping up does not help).
export const SPEND_CAP_CODE = 'spend_cap_reached';
const SPEND_CAP_RE = /(?:exceeded|reached|hit|over)\s+(?:its|your|the)\s+(?:monthly\s+)?spend(?:ing)?\s+(?:cap|limit)|monthly\s+spend(?:ing)?\s+(?:cap|limit)\s+(?:has\s+been\s+|is\s+)?(?:reached|exceeded|hit)|spend(?:ing)?[_ ]cap[_ ](?:reached|exceeded)/i;
export function isSpendCapFailure(status, text = '') {
  if (status != null && status >= 500) return false;
  return SPEND_CAP_RE.test(String(text || ''));
}

export function isBillingFailure(status, text = '') {
  if (status === 402) return true;
  return (status == null || status < 500) && BILLING_RE.test(String(text || '').replace(GOOGLE_QUOTA_BOILERPLATE_RE, ''));
}

// Which quota a 429 hit: 'day' (a daily quota: waiting will not help until
// it resets), 'minute' (a per-minute rate: worth waiting for) or null (it
// does not say). Reads Gemini's QuotaFailure quotaId
// ("GenerateRequestsPerDayPerProjectPerModel-FreeTier",
// "...PerMinute...") and the plain words other engines use ("tokens per
// minute (TPM)", "requests per day (RPD)"). A day wins over a minute when a
// body names both: the day's quota is the one that will not reset soon.
const DAY_SCOPE_RE = /per[ _-]?day|perday|daily (?:limit|quota)|requests per day|tokens per day|\bRPD\b|\bTPD\b/i;
const MINUTE_SCOPE_RE = /per[ _-]?minute|perminute|requests per minute|tokens per minute|\bRPM\b|\bTPM\b/i;
export function quotaScope(text = '') {
  const t = String(text || '');
  if (DAY_SCOPE_RE.test(t)) return 'day';
  if (MINUTE_SCOPE_RE.test(t)) return 'minute';
  return null;
}

// What a Gemini error body says about its quota: { scope, retryAfterMs }.
// The scope and RetryInfo live in error.details, which providerErrorText
// leaves out of the logged text, so this reads the raw body.
export function geminiQuotaInfo(body = '') {
  const raw = String(body || '');
  let details = [];
  try {
    const err = JSON.parse(raw).error;
    details = err && Array.isArray(err.details) ? err.details : [];
  } catch (e) { /* not JSON: the words are all there is */ }
  const ids = details.flatMap((d) => (d && Array.isArray(d.violations) ? d.violations : [])).map((v) => `${v.quotaId || ''} ${v.quotaMetric || ''}`).join(' ');
  const retry = details.find((d) => d && typeof d.retryDelay === 'string');
  const hint = retry ? /^(\d+(?:\.\d+)?)s$/.exec(retry.retryDelay.trim()) : null;
  return {
    scope: quotaScope(ids) || quotaScope(raw),
    retryAfterMs: hint ? Math.round(Number(hint[1]) * 1000) : retryAfterMs({ text: raw })
  };
}

// Moves on to the next candidate: 429, quota or billing (402, or a 400/403
// that says so: isBillingFailure), 5xx, a timeout or network error (status
// null), 401/403 (a bad or revoked key) and 404 (a model that is gone). A
// safety refusal never moves on, unless the message is about billing.
export function isFallbackFailure(status, text = '') {
  const t = String(text || '');
  if (isBillingFailure(status, t)) return true;
  if (SAFETY_RE.test(t) && !QUOTA_RE.test(t)) return false;
  if (status == null) return true;
  if (status === 429 || status >= 500) return true;
  if (status === 401 || status === 403 || status === 404) return true;
  return QUOTA_RE.test(t);
}

// The one rule for every chain (docs/director-mode.md A2): what moves a
// call to the next engine and what stops it.
//   capacity  out of credit or quota, 429, 5xx, timeout or network error,
//             a missing or revoked key (401/403), a model that is gone (404)
//   refused   a content-safety block, the engine's or PG1's own: never tried
//             on another engine
//   error     any other 4xx: the request itself is wrong
// `kind` is an EngineError kind when there is one (lib/film/providers.mjs).
export const FAILURE = Object.freeze({ CAPACITY: 'capacity', REFUSED: 'refused', ERROR: 'error' });
const CAPACITY_KINDS = new Set(['throttled', 'billing', 'spend_cap', 'timeout', 'network', 'not_configured', 'budget']);
export function failureClass({ status = null, text = '', refused = false, kind = null } = {}) {
  if (refused || kind === 'refused') return FAILURE.REFUSED;
  if (kind && CAPACITY_KINDS.has(kind)) return FAILURE.CAPACITY;
  // A job the engine accepted, ran and failed (no HTTP status): the engine
  // has capacity; the same engine is asked again (a shot's retries).
  if (kind === 'engine' && status == null) return FAILURE.ERROR;
  return isFallbackFailure(status, text) ? FAILURE.CAPACITY : (SAFETY_RE.test(String(text || '')) ? FAILURE.REFUSED : FAILURE.ERROR);
}

// --- media failures and throttling ---------------------------------------------
//
// A media engine's 429 is either throttling (wait and send the same request
// again: the engine refused it, so nothing ran and nothing was billed) or
// a quota or credit failure (waiting will not help). Replicate's throttle
// message can mention credit ("reduced to 6 requests per minute ... while
// you have less than $5.0 in credit. Your rate limit resets in ~10s."), so
// throttle wording wins over billing wording on a 429.
const THROTTLE_RE = /throttl|rate[_ ]?limit|too many requests|resets? in|retry (?:after|in)|try again in|slow down/i;

// 'throttled' | 'billing' | 'refused' | 'error' for a failed media call.
export function mediaFailureKind(status, text = '') {
  const t = String(text || '');
  if (isSpendCapFailure(status, t)) return 'spend_cap';
  if (status === 429 && (THROTTLE_RE.test(t) || !isBillingFailure(status, t))) return 'throttled';
  if (isBillingFailure(status, t)) return 'billing';
  if (SAFETY_RE.test(t) && !QUOTA_RE.test(t)) return 'refused';
  return 'error';
}

// How long a throttled engine asked us to wait, in ms, or null when it did
// not say: the Retry-After header (seconds or an HTTP date), a
// rate-limit reset header (seconds, or an epoch time), or the message's own
// words ("resets in ~5s", "retry after 12 seconds", "try again in 1m30s",
// "available in 2 minutes", "resets at 2026-10-09T12:00:00Z").
export function retryAfterMs({ headers = null, text = '', now = Date.now() } = {}) {
  const get = (name) => {
    try { return headers && typeof headers.get === 'function' ? headers.get(name) : headers && headers[name]; } catch (e) { return null; }
  };
  const ra = get('retry-after');
  if (ra != null && String(ra).trim() !== '') {
    const s = String(ra).trim();
    if (/^\d+(?:\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
    const at = Date.parse(s);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  for (const name of ['x-ratelimit-reset', 'ratelimit-reset', 'x-ratelimit-reset-requests']) {
    const v = get(name);
    if (v == null || !/^\d+(?:\.\d+)?$/.test(String(v).trim())) continue;
    const n = Number(String(v).trim());
    // An epoch time in seconds is far in the future; a small number is a delay.
    return Math.round(n > 1e9 ? Math.max(0, n * 1000 - now) : n * 1000);
  }
  const t = String(text || '');
  // Gemini's RetryInfo: "retryDelay": "41s" (or "1.5s").
  const delay = /"?retryDelay"?\s*:\s*"(\d+(?:\.\d+)?)s"/i.exec(t);
  if (delay) return Math.round(Number(delay[1]) * 1000);
  const at = /\b(?:resets?|available|retry|try again)\s+(?:at|after)\s+(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(t);
  if (at) { const ms = Date.parse(at[1]); if (Number.isFinite(ms)) return Math.max(0, ms - now); }
  const m = /\b(?:resets?|available|retry|try again|wait)(?:\s+\w+){0,3}?\s+(?:in|after|for)\s+~?\s*((?:\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?)\s*)+)/i.exec(t);
  if (!m) return null;
  let ms = 0;
  for (const [, n, unit] of m[1].matchAll(/(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?)/gi)) {
    const u = unit.toLowerCase();
    ms += Number(n) * (u === 'ms' || u.startsWith('milli') ? 1 : u.startsWith('h') ? 3600000 : u === 'm' || u.startsWith('min') ? 60000 : 1000);
  }
  return Math.round(ms);
}

// Throttled requests: wait as the engine says (retryAfterMs), else back off
// exponentially from baseMs; at most maxAttempts sends of the same request
// in all, and never more than maxTotalWaitMs of waiting for one request.
export const THROTTLE_POLICY = Object.freeze({ baseMs: 10000, maxAttempts: 5, maxTotalWaitMs: 3 * 60 * 1000 });

// The wait before retry number `retry` (1 = the first retry).
export function throttleWaitMs(retry, hintMs = null, policy = THROTTLE_POLICY) {
  if (Number.isFinite(hintMs) && hintMs >= 0) return Math.max(1000, Math.round(hintMs));
  return policy.baseMs * 2 ** Math.max(0, retry - 1);
}

// Sends one request until it is not throttled. `send(attempt)` resolves to
// { throttled: true, waitMs?, detail? } or anything else (the outcome,
// returned as is). Resolves to { outcome, throttles, waitedMs, exhausted }:
// exhausted when the last send was still throttled (out of attempts, or the
// next wait would pass maxTotalWaitMs). onThrottle({ attempt, waitMs,
// detail }) runs before each wait.
export async function sendWithThrottleRetry(send, { policy = THROTTLE_POLICY, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onThrottle = () => {} } = {}) {
  let waitedMs = 0;
  let throttles = 0;
  for (let attempt = 1; ; attempt++) {
    const outcome = await send(attempt);
    if (!outcome || !outcome.throttled) return { outcome, throttles, waitedMs, exhausted: false };
    throttles++;
    const waitMs = throttleWaitMs(attempt, outcome.waitMs, policy);
    if (attempt >= policy.maxAttempts || waitedMs + waitMs > policy.maxTotalWaitMs) return { outcome, throttles, waitedMs, exhausted: true };
    try { onThrottle({ attempt, waitMs, detail: outcome.detail || '' }); } catch (e) { /* a listener never breaks the call */ }
    await sleep(waitMs);
    waitedMs += waitMs;
  }
}

// --- text calls: wait out a rate limit, then fall through ---------------------
//
// A 429 that is a rate limit (not billing, not a daily quota) is waited out
// on the same engine: the wait the engine asked for (Retry-After, Gemini's
// retryDelay, "retry in 12s"), else 2 s, 5 s, then 10 s. At most 20 s of
// waiting in all for a chat reply and 2 minutes for a background job; a
// wait that would pass the cap (or the caller's deadline) is not started,
// and the call falls through to the next engine. 402s, credit errors and
// daily quotas never wait: they fall through at once.
export const CHAT_THROTTLE = Object.freeze({ waitsMs: Object.freeze([2000, 5000, 10000]), maxTotalWaitMs: 20000 });
export const BACKGROUND_THROTTLE = Object.freeze({ waitsMs: Object.freeze([2000, 5000, 10000]), maxTotalWaitMs: 120000 });
// No waiting: speech (a reply being read aloud cannot pause) and callers
// that pace their own retries (music, lib/music/engines.mjs).
export const NO_THROTTLE_WAIT = Object.freeze({ waitsMs: Object.freeze([0]), maxTotalWaitMs: 0 });
// A 429 worth waiting for: a rate limit, not an empty account or a day's
// quota. `scope` is what the engine's body said (quotaScope, or
// geminiQuotaInfo for Gemini) when the caller read it.
export function isThrottle(status, text = '', scope = undefined) {
  const t = String(text || '');
  if (status !== 429 || isBillingFailure(status, t)) return false;
  return (scope === undefined ? quotaScope(t) : scope) !== 'day';
}

// The wait before retry number `retry` (1 = the first): the engine's own
// hint when it gave one, else the policy's back-off list (its last entry
// repeats).
export function textThrottleWaitMs(retry, hintMs, policy = CHAT_THROTTLE) {
  if (Number.isFinite(hintMs) && hintMs >= 0) return Math.max(500, Math.round(hintMs));
  const w = policy.waitsMs;
  return w[Math.min(w.length - 1, Math.max(0, retry - 1))];
}

// Runs `attempt()` until it is not a throttle, or until waiting more would
// pass the policy's cap or `deadlineTs` (reserving `reserveMs` for the
// reply itself). `attempt()` resolves to a result with { status, detail or
// error, retryAfterMs? }. Resolves to { result, throttles, waitedMs }:
// the last result, which the caller treats as any other failure (the
// next engine) when it is still a throttle.
// Under Node's test runner (NODE_TEST_CONTEXT) the waits are instant unless
// a test passes its own sleep, so a test that answers 429 does not wait in
// real time (the same convention as the cache, cacheEnabled).
export const throttleSleep = (ms) => (process.env.NODE_TEST_CONTEXT ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));
export async function withThrottleRetry(attempt, { policy = CHAT_THROTTLE, deadlineTs = Infinity, reserveMs = 3000, sleep = throttleSleep, now = () => Date.now(), onWait = () => {} } = {}) {
  let waitedMs = 0;
  let throttles = 0;
  for (let n = 1; ; n++) {
    const result = await attempt(n);
    const text = result ? (result.detail || result.error || '') : '';
    if (!result || result.ok || result.text || !isThrottle(result.status, text, result.quotaScope === undefined ? undefined : result.quotaScope) || policy.maxTotalWaitMs <= 0) return { result, throttles, waitedMs };
    throttles++;
    const hint = Number.isFinite(result.retryAfterMs) ? result.retryAfterMs : retryAfterMs({ text });
    const waitMs = textThrottleWaitMs(n, hint, policy);
    if (waitedMs + waitMs > policy.maxTotalWaitMs || now() + waitMs > deadlineTs - reserveMs) return { result, throttles, waitedMs };
    try { onWait({ attempt: n, waitMs }); } catch (e) { /* a listener never breaks the call */ }
    await sleep(waitMs);
    waitedMs += waitMs;
  }
}

export const BREAKER_WINDOW_MS = 15 * 60 * 1000;
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const openUntil = new Map();

// A key that answered a billing failure (a drained prepaid key, an account
// out of credit) is moved to the back of every plan for BREAKER_WINDOW_MS, a
// plain 429 (rate limit) for RATE_LIMIT_WINDOW_MS, so requests go straight
// to a key that works instead of paying a round trip first. A tripped key
// is still tried last, so a deployment with one key is never left with none.
// A daily quota (quotaScope 'day') goes to the back until its quota resets:
// Google's free tier resets at midnight Pacific time, the others at
// midnight UTC; the later of the two is used, at most 24 hours away.
export function nextDailyResetMs(now = Date.now()) {
  const utcMidnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
  let pacific = utcMidnight;
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
    const into = ((Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000;
    pacific = now + (86400000 - into);
  } catch (e) { /* no time zone data: UTC midnight */ }
  return Math.min(now + 86400000, Math.max(utcMidnight, pacific));
}

export function tripBreaker(keyId, status, text = '', now = Date.now(), { scope = undefined, retryAfterMs: hintMs = null } = {}) {
  if (status != null && isBillingFailure(status, text)) {
    openUntil.set(keyId, now + BREAKER_WINDOW_MS);
    return true;
  }
  if (status === 429) {
    const daily = (scope === undefined ? quotaScope(text) : scope) === 'day';
    const until = daily ? nextDailyResetMs(now) : now + Math.max(RATE_LIMIT_WINDOW_MS, Number.isFinite(hintMs) ? hintMs : 0);
    openUntil.set(keyId, Math.max(openUntil.get(keyId) || 0, until));
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
  if (CATALOG_PROVIDERS.includes(provider) && (task === TASKS.LIGHT || task === TASKS.HEAVY)) return catalogModelIds(provider, task);
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
  if (provider === 'elevenlabs' && chars && !unit) return (chars / 1e6) * ELEVENLABS_TTS_USD_PER_MCHAR;
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

// The daily spend cap on all paid AI together (text and media, every paid
// account), PG1_DAILY_SPEND_CAP_USD; Infinity when unset. The free engines
// cost nothing and never count. Checked before every paid call is planned
// (planRoute, lib/router/chains.mjs chainPlan): at the cap, every paid
// engine is left out until 00:00 UTC.
export const SPEND_CAP_ENV = 'PG1_DAILY_SPEND_CAP_USD';
export function dailySpendCapUsd(env = {}) {
  const raw = env[SPEND_CAP_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === '') return Infinity;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : Infinity;
}
export const isPaidProvider = (provider) => !OPERATOR_ONLY_PROVIDERS.includes(provider);
export function paidSpentToday({ ledger = null, now = Date.now() } = {}) {
  return PROVIDERS.filter(isPaidProvider).reduce((sum, p) => sum + spentToday(p, { ledger, now }), 0);
}
export function spendCapAllows(env = {}, { ledger = null, now = Date.now() } = {}) {
  const cap = dailySpendCapUsd(env);
  if (cap === Infinity) return true;
  return paidSpentToday({ ledger, now }) < cap;
}

export function budgetAllows(env, provider, { ledger = null, now = Date.now() } = {}) {
  // Speech (Cartesia) is on its own plan: counted, never switched off by the cap.
  if (isPaidProvider(provider) && provider !== 'cartesia' && !spendCapAllows(env, { ledger, now })) return false;
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
  // costUsd: the call's own price when the caller knows it (a film clip at
  // its engine's per-second rate), else the price table's estimate.
  if (!row.cached && row.ok && Number.isFinite(entry.costUsd) && entry.costUsd >= 0) {
    row.cost_usd = Number(Number(entry.costUsd).toFixed(6));
  } else if (!row.cached && row.ok) {
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

// The cache identity for a request: the signed-in operator only. Guest and
// customer sessions get '', which turns the cache off for them entirely
// (text and TTS): only the operator's requests are ever cached.
export function cacheIdentity({ isOperator = false, operatorId = '' } = {}) {
  return isOperator === true ? `operator:${String(operatorId || 'operator')}` : '';
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
  openai: 'https://api.openai.com/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  mistral: 'https://api.mistral.ai/v1/chat/completions',
  github_models: 'https://models.github.ai/inference/chat/completions',
  // {account} is CLOUDFLARE_ACCOUNT_ID (compatUrl).
  cloudflare: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1/chat/completions'
});
export const OPENAI_COMPAT_URLS = OPENAI_COMPAT;

function compatUrl(provider, keys) {
  return provider === 'cloudflare' ? OPENAI_COMPAT.cloudflare.replace('{account}', encodeURIComponent(keys.cloudflareAccount)) : OPENAI_COMPAT[provider];
}

// OpenRouter's state (lib/router/openrouterGuard.mjs): dormant while the
// account balance is zero or below, free models only below $2 or for
// background work. Set by the guard; read here, so planning stays
// synchronous. null (never checked, or the guard is off) plans it as before.
let openRouterState = null;
export function setOpenRouterState(state) { openRouterState = state || null; }
export function getOpenRouterState() { return openRouterState; }

// OpenRouter while the guard has a balance (lib/router/openrouterGuard.mjs):
// the free (:free) models first, sent together as one request's `models`
// list, then the paid ones only while the balance is above $2 and never for
// background work. Dormant (null) at a balance of zero or below. Never a
// first-party Chinese host: PG1_OPENROUTER_IGNORE (default DeepSeek,
// Alibaba, Moonshot AI, Z.AI, MiniMax, StepFun, Baidu) goes to OpenRouter's
// provider.ignore, so free DeepSeek and Qwen models run on hosts outside
// China.
export const OPENROUTER_FREE_MODELS = Object.freeze(['deepseek/deepseek-chat-v3.1:free', 'qwen/qwen3-235b-a22b:free', 'qwen/qwen3-coder:free']);
export const OPENROUTER_IGNORED_PROVIDERS = Object.freeze(['DeepSeek', 'Alibaba', 'Moonshot AI', 'Z.AI', 'MiniMax', 'StepFun', 'Baidu']);
export const OPENROUTER_PAID_MIN_BALANCE_USD = 2;
export function openRouterFreeModels(env = {}) {
  const raw = typeof env.PG1_OPENROUTER_FREE_MODELS === 'string' ? env.PG1_OPENROUTER_FREE_MODELS : '';
  const list = raw.split(',').map((x) => x.trim()).filter((x) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,100}:free$/.test(x));
  return (list.length ? list : [...OPENROUTER_FREE_MODELS]).slice(0, 3);
}
export function openRouterIgnored(env = {}) {
  const raw = typeof env.PG1_OPENROUTER_IGNORE === 'string' ? env.PG1_OPENROUTER_IGNORE : '';
  const list = raw.split(',').map((x) => x.trim()).filter(Boolean);
  return [...new Set([...OPENROUTER_IGNORED_PROVIDERS, ...list])];
}
function openRouterCandidate(c, { env, background }) {
  if (c.provider !== 'openrouter') return c;
  const state = openRouterState;
  if (state && state.active === false) return null;
  const paidOk = !background && (!state || state.paidAllowed === true);
  return { ...c, freeModels: openRouterFreeModels(env), models: paidOk ? c.models : [], ignoreProviders: openRouterIgnored(env) };
}

function geminiCandidates(keys, role, models) {
  return keys.map((key, i) => ({ provider: role, family: 'gemini', key, keyId: `${role}#${i + 1}`, keySlot: i + 1, models }));
}

// The ordered candidates for a task. Each is { provider (ledger name),
// family (wire format: gemini, anthropic, openai_compat, cartesia), key,
// keyId, models, url? }. Candidates the content may not go to (the free
// key for customer data), whose provider is over budget, or whose key is
// in its breaker window goes to the back. The OpenAI-compatible backups are
// called without functions; withTools no longer drops them: with tools on they stay as tools-off
// backups (toolsOff: true) after every engine that can run the checks, so
// a round never ends with engines untried. withMedia (an image or file on
// the round) drops them: they would answer without seeing it.
// excludeFree: the routing floor (lib/contextWindow.mjs needsRoutingFloor)
// leaves the free key out of the plan whatever the data class.
// clientWork: a client job: only steps cleared for client work
// (registry clientAllowedStep: a deliverable, commercial_ok engine, never
// excluded for clients or operator-only), so OpenRouter, the AI gateway and
// OpenAI (T1) are never planned for one, nor Replicate's media engines.
// background: a background job (never paid OpenRouter models).
// requiresTool: the round must run a check (a forced tool): a tools-off
// engine cannot do that, so it does not fit the request and goes after the
// engines that can.
//
// Routing policy for text (light and heavy): operator content always tries
// the free engines first (the free Gemini key, then the no-card engines)
// and plans a paid engine only after them, so paid credit is spent only
// when every free engine failed or could not fit the request; paid text
// counts against PG1_DAILY_SPEND_CAP_USD like everything paid. Customer
// and guest data never touches a free engine; client work (clientWork)
// only the engines cleared for it (Claude, the paid Gemini key), and when
// none of those is available the plan is empty: the caller stops and tells
// the operator, never falls back to a free engine.
export function planRoute(task, { env = {}, dataClass = DATA.CUSTOMER, withTools = false, withMedia = false, ledger = null, now = Date.now(), excludeFree = false, clientWork = false, background = false, requiresTool = false } = {}) {
  const k = resolveKeys(env);
  const operator = dataClass === DATA.OPERATOR;
  const out = [];
  const freeGemini = (models) => (operator ? geminiCandidates(k.geminiFree, 'gemini_free', models) : []);
  const paidGemini = (models) => geminiCandidates(k.geminiPaid, 'gemini_paid', models);
  const anthropic = (models) => (k.anthropic ? [{ provider: 'anthropic', family: 'anthropic', key: k.anthropic, keyId: 'anthropic', models }] : []);
  // The no-card free engines: operator content only, never with the
  // routing floor (excludeFree), like the free Gemini key.
  const freeCompat = operator && !excludeFree ? FREE_COMPAT_PROVIDERS : [];
  const compat = (t) => (withMedia ? [] : ['gateway', 'openrouter', 'openai', ...freeCompat]
    .filter((p) => k[p])
    .map((p) => openRouterCandidate({ provider: p, family: 'openai_compat', key: k[p], keyId: p, models: routeModels(env, t, p), url: compatUrl(p, k), ...(withTools ? { toolsOff: true } : {}) }, { env, task: t, background }))
    .filter(Boolean));

  // The order is the registry's (lib/capabilities/registry.mjs
  // ROUTING_CHAINS): each step names a provider, filled in here with this
  // deployment's keys and models.
  const byProvider = (t) => {
    const gm = routeModels(env, t, 'gemini');
    return {
      gemini_free: freeGemini(gm), gemini_paid: paidGemini(gm), anthropic: anthropic(routeModels(env, t, 'anthropic')),
      ...Object.fromEntries(compat(t).map((c) => [c.provider, [c]]))
    };
  };
  const ordered = (chain, pool) => {
    const used = new Set();
    return chain.flatMap((step) => {
      if (clientWork && !clientAllowedStep(step)) return [];
      if (used.has(step.provider)) return [];
      used.add(step.provider);
      return pool[step.provider] || [];
    });
  };
  if (task === TASKS.LIGHT) {
    out.push(...ordered(ROUTING_CHAINS.chat_light, byProvider('light')));
  } else if (task === TASKS.HEAVY) {
    out.push(...ordered(ROUTING_CHAINS.text, byProvider('heavy')));
  } else if (task === TASKS.TTS) {
    const pool = {
      gemini_free: operator && k.ttsGemini ? [{ provider: 'gemini_free', family: 'gemini_tts', key: k.ttsGemini, keyId: 'gemini_free#tts', models: routeModels(env, 'tts', 'gemini') }] : [],
      cartesia: k.cartesia ? [{ provider: 'cartesia', family: 'cartesia', key: k.cartesia, keyId: 'cartesia', models: [String(env.CARTESIA_MODEL_ID || '').trim() || 'sonic-3.6'] }] : []
    };
    out.push(...ordered(ROUTING_CHAINS.speech, pool));
  } else if (task === TASKS.MEDIA) {
    out.push(...geminiCandidates(k.geminiPaid, 'gemini_paid', []));
    // Replicate's stills (FLUX, not deliverable) and clips (Kling, R1) are
    // never planned for a client.
    if (k.replicate && !clientWork) out.push({ provider: 'replicate', family: 'replicate', key: k.replicate, keyId: 'replicate', models: [] });
  } else if (task === TASKS.MUSIC) {
    // Lyria on the paid Gemini key (never the free key: music prompts are
    // planned like customer data whoever asks), then ElevenLabs when its key
    // is set (ROUTING_CHAINS.music). The clip model is lib/music/engines.mjs
    // musicClipPlan, on the same key.
    const pool = {
      gemini_paid: geminiCandidates(k.geminiPaid, 'gemini_paid', routeModels(env, 'music', 'gemini')).map((c) => ({ ...c, family: 'lyria' })),
      elevenlabs: k.elevenlabs ? [{ provider: 'elevenlabs', family: 'elevenlabs_music', key: k.elevenlabs, keyId: 'elevenlabs', models: routeModels(env, 'music', 'elevenlabs') }] : []
    };
    out.push(...ordered(ROUTING_CHAINS.music, pool));
  }

  // One attempt per distinct key and family: an old key that serves both
  // roles is tried once.
  const seen = new Set();
  const allowed = out.filter((c) => {
    const id = `${c.family}|${c.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    if (OPERATOR_ONLY_PROVIDERS.includes(c.provider) && (!operator || excludeFree)) return false;
    return budgetAllows(env, c.provider, { ledger, now });
  });
  // Keys in their breaker window go last, in their own order.
  const ready = allowed.filter((c) => !isTripped(c.keyId, now)).concat(allowed.filter((c) => isTripped(c.keyId, now)));
  return (task === TASKS.LIGHT || task === TASKS.HEAVY) && operator && !clientWork ? freeFirst(ready, { requiresTool }) : ready;
}

// Free engines before paid ones, each group in its own order (a free key in
// its breaker window still comes before every paid engine: it costs
// nothing to try). With a check required, a tools-off engine cannot fit the
// round, so the order is free with tools, paid with tools, then the
// tools-off engines (free first).
export function freeFirst(plan, { requiresTool = false } = {}) {
  const free = plan.filter((c) => !isPaidProvider(c.provider));
  const paid = plan.filter((c) => isPaidProvider(c.provider));
  if (!requiresTool) return free.concat(paid);
  const tools = (list) => list.filter((c) => !c.toolsOff);
  const off = (list) => list.filter((c) => c.toolsOff);
  return tools(free).concat(tools(paid), off(free), off(paid));
}

// --- generic execution ----------------------------------------------------------------------

// Runs a plan: `attempt(candidate)` resolves to { ok, status, text?, value?,
// usage?: { inputTokens, outputTokens, chars, unit }, model, detail,
// refused?, invalid? }. Moves on per isFallbackFailure, or when the answer
// failed the caller's own check (invalid), trips the breaker, records
// usage, and answers an identical request from `cache` when given a key.
// Resolves to { ok, value, candidate, model, cached, attempts, failures }.
// onCapacity({ engine, status, kind, next }) hears each capacity failure
// (lib/router/alerts.mjs).
// throttle: CHAT_THROTTLE (default) or BACKGROUND_THROTTLE, how long a
// rate-limited engine is waited for before the next one (withThrottleRetry).
// freeSlot({ maxWaitMs }) resolves to true when the free key may be called
// now (lib/router/freeLimiter.mjs); without it the free key is not paced.
// onAllOut(failures) runs when every candidate failed on capacity.
export async function runRoute({ task, env = {}, dataClass = DATA.CUSTOMER, plan = null, attempt, cache = null, key = null, ttlMs, ledger = null, requestId = null, log = console.log, now = () => Date.now(), onCapacity = null, throttle = CHAT_THROTTLE, freeSlot = null, sleep, onAllOut = null }) {
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
    if (c.provider === 'gemini_free' && freeSlot && !(await freeSlot({ maxWaitMs: throttle.maxTotalWaitMs }))) {
      r = { ok: false, status: 429, detail: 'free key: per-minute limit reached (PG1 limiter)' };
    } else {
      r = (await withThrottleRetry(async () => {
        try {
          return await attempt(c);
        } catch (e) {
          return { ok: false, status: null, detail: e && e.message };
        }
      }, { policy: throttle, now, ...(sleep ? { sleep } : {}) })).result;
    }
    if (r && r.ok) {
      const u = r.usage || {};
      recordUsage({ provider: c.provider, model: r.model || c.models[0] || '', task, dataClass, inputTokens: u.inputTokens, outputTokens: u.outputTokens, chars: u.chars, unit: u.unit, ...(Number.isFinite(u.costUsd) ? { costUsd: u.costUsd } : {}), ok: true, fallback: i, requestId }, { env, ledger, now: now(), log });
      if (useCache) cache.set(key, { value: r.value, provider: c.provider, model: r.model || c.models[0] || '' }, { ttl: ttlMs, now: now() });
      return { ok: true, value: r.value, candidate: c, model: r.model || c.models[0] || '', cached: false, attempts: i + 1, failures };
    }
    const status = r ? r.status : null;
    failures.push({ provider: c.provider, keyId: c.keyId, model: (r && r.model) || '', status, detail: r && r.detail ? String(r.detail).slice(0, 300) : '', refused: !!(r && r.refused) });
    recordUsage({ provider: c.provider, model: (r && r.model) || c.models[0] || '', task, dataClass, ok: false, status, unit: r && r.usage ? r.usage.unit : undefined, fallback: i, requestId }, { env, ledger, now: now(), log });
    tripBreaker(c.keyId, status, r && r.detail, now());
    if (r && r.refused) break;
    if (!(r && r.invalid) && !isFallbackFailure(status, r && r.detail)) break;
    if (onCapacity && !(r && r.invalid)) {
      try { Promise.resolve(onCapacity({ engine: c.provider, status, kind: null, next: candidates[i + 1] ? candidates[i + 1].provider : null })).catch(() => {}); } catch (e) { /* an alert never breaks a call */ }
    }
  }
  if (onAllOut && failures.length && failures.length === candidates.length && failures.every((f) => !f.refused && isFallbackFailure(f.status, f.detail))) {
    try { Promise.resolve(onAllOut(failures)).catch(() => {}); } catch (e) { /* an alert never breaks a call */ }
  }
  return { ok: false, value: null, candidate: null, model: '', cached: false, attempts: failures.length, failures };
}

// Reasoning effort for the backups' reasoning models (gpt-5, gpt-5-mini).
// Left at the provider's default ("medium"), gpt-5-mini thinks before it
// writes, and a ~10k-token chat prompt can run past the 20 s per-call cap
// with nothing returned (request h47kxyr6: all three backups timed out with
// 0 output tokens). Chat replies need no long reasoning: "low" by default,
// PG1_COMPAT_REASONING_EFFORT (minimal|low|medium|high) to change it.
// OpenRouter takes its own `reasoning` object; the AI gateway and OpenAI
// take reasoning_effort.
export const COMPAT_REASONING_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high']);
export function compatReasoningFields(provider, model, env = process.env) {
  if (!/(?:^|\/)(?:gpt-5|o\d)/i.test(String(model || ''))) return {};
  const raw = String((env && env.PG1_COMPAT_REASONING_EFFORT) || '').trim().toLowerCase();
  const effort = COMPAT_REASONING_EFFORTS.includes(raw) ? raw : 'low';
  // OpenRouter maps "minimal" to its lowest level, "low".
  if (provider === 'openrouter') return { reasoning: { effort: effort === 'minimal' ? 'low' : effort } };
  return { reasoning_effort: effort };
}

// One text call on an OpenAI-compatible endpoint (the AI gateway,
// OpenRouter, OpenAI, and the no-card free engines): system + one user
// message, no functions, streamed.
//
// Streaming: the first token is the proof of life. The call times out only
// when no token has arrived within firstTokenMs (20 s), and otherwise runs
// up to totalMs (90 s for heavy work; the caller's deadline caps it). On
// 16 Oct OpenRouter finished and billed two replies PG1 had abandoned at a
// flat 20 s with nothing received; now a reply that is coming in is kept.
// Every call logs the provider's generation or request id
// ("[pg1-compat] provider=... id=..."), so a timeout can be matched to a bill.
//
// `model` is one model id, or for OpenRouter an array of :free model ids
// sent as one request's `models` list (OpenRouter tries them in order).
// OpenRouter requests also carry provider.ignore (candidate.ignoreProviders).
export const COMPAT_FIRST_TOKEN_MS = 20000;
export const COMPAT_HEAVY_TOTAL_MS = 90000;
// Providers that take max_tokens rather than max_completion_tokens.
export const MAX_TOKENS_FIELD = { mistral: 'max_tokens', cloudflare: 'max_tokens', github_models: 'max_tokens', groq: 'max_tokens' };

function compatBody(candidate, model, { system, prompt, maxTokens, env }) {
  const list = Array.isArray(model) ? model : null;
  const first = list ? list[0] : model;
  const body = {
    model: first,
    ...(list && list.length > 1 ? { models: list } : {}),
    [MAX_TOKENS_FIELD[candidate.provider] || 'max_completion_tokens']: maxTokens,
    ...compatReasoningFields(candidate.provider, first, env),
    messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
    stream: true,
    ...(candidate.provider === 'openrouter' || candidate.provider === 'gateway' || candidate.provider === 'openai' ? { stream_options: { include_usage: true } } : {})
  };
  if (candidate.provider === 'openrouter' && Array.isArray(candidate.ignoreProviders) && candidate.ignoreProviders.length) body.provider = { ignore: candidate.ignoreProviders };
  return body;
}

function scrubKey(text, key) {
  const t = String(text || '');
  return key && key.length >= 8 ? t.split(key).join('[key]') : t;
}

export async function callOpenAiCompat({ candidate, model, system, prompt, fetchImpl = globalThis.fetch, timeoutMs = COMPAT_HEAVY_TOTAL_MS, firstTokenMs = COMPAT_FIRST_TOKEN_MS, maxTokens = 4096, env = process.env, log = console.log }) {
  const label = Array.isArray(model) ? model[0] : model;
  const controller = new AbortController();
  const total = Math.max(1, timeoutMs);
  let why = '';
  const abort = (reason) => { if (!why) why = reason; controller.abort(); };
  const totalTimer = setTimeout(() => abort('timed out'), total);
  let firstTimer = setTimeout(() => abort('timed out: no token'), Math.max(1, Math.min(firstTokenMs, total)));
  let genId = null;
  let status = null;
  // When ok is false the provider's own message is logged in full (up to
  // 300 characters), never the key: a failure that only said "no text in
  // the answer" (request sjv9vnbs) could not be diagnosed.
  const done = (out) => {
    if (!out.ok) out = { ...out, detail: scrubKey(out.detail, candidate.key) };
    try { log(`[pg1-compat] provider=${candidate.provider} model=${String(out.model || label).slice(0, 80)} status=${out.status == null ? 'none' : out.status} ok=${!!out.ok} id=${genId || 'none'}${out.ok ? '' : ` detail=${String(out.detail || '').replace(/\s+/g, ' ').slice(0, 300)}`}`); } catch (e) { /* logging never breaks a call */ }
    return { ...out, generationId: genId };
  };
  try {
    const res = await fetchImpl(candidate.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${candidate.key}` },
      body: JSON.stringify(compatBody(candidate, model, { system, prompt, maxTokens, env })),
      cache: 'no-store',
      signal: controller.signal
    });
    status = res.status;
    try { genId = (res.headers && typeof res.headers.get === 'function' && (res.headers.get('x-generation-id') || res.headers.get('x-request-id') || res.headers.get('cf-ray'))) || null; } catch (e) { genId = null; }
    if (!res.ok) {
      const raw = await res.text();
      return done({ ok: false, status: res.status, model: label, detail: raw.slice(0, 300), retryAfterMs: retryAfterMs({ headers: res.headers, text: raw }) });
    }
    const type = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '';
    let text = '';
    let usage = {};
    let used = label;
    if (!/event-stream/i.test(type) || !res.body) {
      // A provider that answered without streaming: one JSON body.
      clearTimeout(firstTimer);
      const raw = await res.text();
      let json = null;
      try { json = JSON.parse(raw); } catch (e) { /* not JSON */ }
      genId = genId || (json && json.id) || null;
      used = (json && json.model) || label;
      // An error carried in a 200 body (GitHub Models answers some refusals
      // this way): its own code and message, not "no text".
      if (json && json.error) {
        const e = json.error;
        const code = Number(e.code) || Number(e.status) || null;
        return done({ ok: false, status: code && code >= 400 ? code : res.status, model: used, detail: `${e.code ? `${e.code}: ` : ''}${String(e.message || e.details || JSON.stringify(e)).slice(0, 300)}` });
      }
      const choice0 = json && json.choices && json.choices[0];
      text = choice0 && choice0.message && typeof choice0.message.content === 'string' ? choice0.message.content : '';
      usage = (json && json.usage) || {};
      if (!text) {
        if (choice0 && choice0.finish_reason === 'content_filter') return done({ ok: false, status: res.status, model: used, refused: true, detail: 'content_filter: the engine\'s content filter blocked the answer' });
        return done({ ok: false, status: res.status, model: used, detail: `no text in the answer (finish_reason=${(choice0 && choice0.finish_reason) || 'none'}; body: ${raw.replace(/\s+/g, ' ').slice(0, 200)})` });
      }
    } else {
      const reader = res.body.getReader();
      // A timer that fires cancels the read, whatever the body source does
      // with the abort signal.
      controller.signal.addEventListener('abort', () => { reader.cancel().catch(() => {}); }, { once: true });
      const decoder = new TextDecoder();
      let buf = '';
      let head = '';
      let finish = '';
      for (;;) {
        const { value, done: end } = await reader.read();
        if (controller.signal.aborted) return done({ ok: false, status: null, model: used, detail: why || 'timed out' });
        if (end) break;
        const piece = decoder.decode(value, { stream: true });
        if (head.length < 400) head += piece.slice(0, 400 - head.length);
        buf += piece;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let chunk = null;
          try { chunk = JSON.parse(data); } catch (e) { continue; }
          if (chunk.id && !genId) genId = chunk.id;
          if (chunk.model) used = chunk.model;
          if (chunk.usage) usage = chunk.usage;
          if (chunk.error) return done({ ok: false, status: Number(chunk.error.code) || status, model: used, detail: `${chunk.error.code && !Number(chunk.error.code) ? `${chunk.error.code}: ` : ''}${String(chunk.error.message || 'stream error')}`.slice(0, 300) });
          if (chunk.choices && chunk.choices[0] && chunk.choices[0].finish_reason) finish = chunk.choices[0].finish_reason;
          const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
          if (delta && typeof delta.content === 'string' && delta.content) {
            if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
            text += delta.content;
          }
        }
      }
      // What came back instead of text, for the log: the finish reason and
      // the start of the stream (an error object a provider sent in a form
      // the parser above did not read).
      if (!text && finish === 'content_filter') return done({ ok: false, status, model: used, refused: true, detail: 'content_filter: the engine\'s content filter blocked the answer' });
      if (!text) return done({ ok: false, status, model: used, detail: `no text in the answer (finish_reason=${finish || 'none'}; stream: ${head.replace(/\s+/g, ' ').slice(0, 200) || 'empty'})` });
    }
    if (!text) return done({ ok: false, status, model: used, detail: 'no text in the answer' });
    return done({ ok: true, status, model: used, value: text, text, usage: { inputTokens: usage.prompt_tokens || estimateTokens((system || '') + prompt), outputTokens: usage.completion_tokens || estimateTokens(text) } });
  } catch (e) {
    return done({ ok: false, status: null, model: label, detail: controller.signal.aborted ? (why || 'timed out') : e && e.message });
  } finally {
    clearTimeout(totalTimer);
    if (firstTimer) clearTimeout(firstTimer);
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
