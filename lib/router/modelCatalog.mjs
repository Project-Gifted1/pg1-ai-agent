// The no-card free engines' models, read from each engine's own model list
// once a day instead of hard-coded ids that go away (request sjv9vnbs, 17
// Oct: Groq answered 404 for qwen/qwen3-32b, which it had retired, and 413
// for openai/gpt-oss-120b, whose free tier takes 8,000 tokens a minute).
//
//   groq           GET https://api.groq.com/openai/v1/models
//                  (id, active, context_window)
//   cloudflare     GET .../accounts/{id}/ai/models/search?task=Text Generation
//                  (name, properties: context_window)
//   github_models  GET https://models.github.ai/catalog/models
//                  (id, rate_limit_tier, limits.max_input_tokens)
//
// The list is cached per instance for CATALOG_TTL_MS (a day; a failed read
// is tried again after CATALOG_RETRY_MS). The models a call uses are the
// engine's preference list (best first) narrowed to the ids the engine
// lists today; when none of them is listed, the best chat model the engine
// does list (largest free input limit, never speech, embedding, guard or
// image models). Before the first read, or when it fails, the whole
// preference list is used and a 404 moves on to the next id. A model that
// answers 404 is left out until the next read (markModelGone).
//
// PG1_<LIGHT|HEAVY>_<ENGINE>_MODELS still overrides everything
// (lib/aiRouter.mjs routeModels).
//
// Free-tier input limits (tokens per request, or per minute where that is
// the tighter limit; lib/capabilities/registry.mjs ENGINE_MAX_INPUT_TOKENS
// has each engine's default): the request is trimmed to fit before the
// call (lib/router/fit.mjs) and a model too small for it is tried last.

export const CATALOG_PROVIDERS = Object.freeze(['groq', 'cloudflare', 'github_models']);
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
export const CATALOG_RETRY_MS = 10 * 60 * 1000;
export const CATALOG_TIMEOUT_MS = 2500;

// Best first. Heavy: the strongest model that fits a ~10k-token chat on
// the free tier; light: the quickest good one. No first-party Chinese host
// is involved: these engines run every model on their own servers.
export const MODEL_PREFERENCES = Object.freeze({
  groq: Object.freeze({
    heavy: Object.freeze(['openai/gpt-oss-120b', 'meta-llama/llama-4-maverick-17b-128e-instruct', 'llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant']),
    light: Object.freeze(['meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'])
  }),
  cloudflare: Object.freeze({
    heavy: Object.freeze(['@cf/openai/gpt-oss-120b', '@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/mistralai/mistral-small-3.1-24b-instruct', '@cf/openai/gpt-oss-20b']),
    light: Object.freeze(['@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/openai/gpt-oss-20b', '@cf/mistralai/mistral-small-3.1-24b-instruct', '@cf/meta/llama-3.1-8b-instruct-fast'])
  }),
  github_models: Object.freeze({
    heavy: Object.freeze(['openai/gpt-4.1', 'openai/gpt-4o', 'meta/llama-4-maverick-17b-128e-instruct-fp8', 'meta/llama-3.3-70b-instruct', 'openai/gpt-4.1-mini']),
    light: Object.freeze(['openai/gpt-4.1-mini', 'openai/gpt-4o-mini', 'openai/gpt-4.1', 'meta/llama-3.3-70b-instruct'])
  })
});

// Free-tier input limits per model where the engine's list does not give
// the binding one. Groq's free tier caps tokens per minute per model, and a
// single request larger than that is refused (413): that cap is the
// request's real limit. GitHub Models' free tier allows 8,000 input tokens
// per request on every chat model (4,000 on its "custom" tier).
export const GROQ_FREE_TPM = Object.freeze({
  'openai/gpt-oss-120b': 8000,
  'openai/gpt-oss-20b': 8000,
  'llama-3.3-70b-versatile': 12000,
  'llama-3.1-8b-instant': 6000,
  'meta-llama/llama-4-scout-17b-16e-instruct': 30000,
  'meta-llama/llama-4-maverick-17b-128e-instruct': 6000
});
export const GITHUB_FREE_INPUT = Object.freeze({ low: 8000, high: 8000, custom: 4000 });
export const DEFAULT_LIMITS = Object.freeze({ groq: 6000, cloudflare: 24000, github_models: 8000 });
// Output tokens asked for on the free engines: Groq counts max_tokens into
// the same per-minute budget, so its share is kept small.
export const FREE_MAX_OUTPUT = Object.freeze({ groq: 1024, cloudflare: 2048, github_models: 2048 });

const NOT_CHAT_RE = /whisper|tts|speech|playai|embed|guard|safeguard|moderation|rerank|vision-only|image|flux|stable-diffusion|sdxl|dreamshaper|distil|bge|m2m|translation|ocr|compound|orpheus|prompt-guard|resnet|detr|melotron|deepgram|aura|lucid|phoenix/i;
// Never a model from a first-party Chinese lab on these lists' fallback
// pick: the operator's rule is that data does not go to servers in China,
// and these are run by the engines' own (non-Chinese) hosts, but a model
// family is kept out of the automatic pick anyway so nothing changes hands.
const EXCLUDED_FAMILY_RE = /deepseek|qwen|kimi|moonshot|glm|zhipu|baichuan|yi-|minimax|ernie/i;

const state = new Map(); // provider -> { at, ok, models: [{ id, maxInputTokens }] }
const gone = new Map(); // `${provider}|${id}` -> until
const inflight = new Map();

export function __resetModelCatalog() { state.clear(); gone.clear(); inflight.clear(); }

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };

// The engine's free-tier input limit for one model (tokens).
export function modelInputLimit(provider, model, entry = null) {
  const listed = entry && entry.maxInputTokens;
  if (provider === 'groq') return Math.min(GROQ_FREE_TPM[model] || DEFAULT_LIMITS.groq, listed || Infinity);
  if (provider === 'github_models') return Math.min(GITHUB_FREE_INPUT[entry && entry.tier] || DEFAULT_LIMITS.github_models, listed || Infinity);
  if (provider === 'cloudflare') return listed || (/llama-3\.3-70b/.test(model) ? 24000 : DEFAULT_LIMITS.cloudflare);
  return listed || Infinity;
}

// Parsers: an engine's list body -> [{ id, maxInputTokens, tier? }].
export const PARSERS = Object.freeze({
  groq: (json) => (json && Array.isArray(json.data) ? json.data : [])
    .filter((m) => m && typeof m.id === 'string' && m.active !== false)
    .map((m) => ({ id: m.id, maxInputTokens: num(m.context_window) })),
  cloudflare: (json) => (json && Array.isArray(json.result) ? json.result : [])
    .filter((m) => m && typeof m.name === 'string' && (!m.task || /text generation/i.test(String(m.task.name || m.task))))
    .map((m) => {
      const props = Array.isArray(m.properties) ? m.properties : [];
      const cw = props.find((p) => p && /context_window|max_input_tokens/i.test(String(p.property_id || '')));
      return { id: m.name, maxInputTokens: num(cw && cw.value) };
    }),
  github_models: (json) => githubModelEntries(json)
    .map((m) => ({ ...m, id: githubModelId(m) }))
    .filter((m) => m.id && hasText(m.supported_output_modalities) && hasText(m.supported_input_modalities))
    .map((m) => ({ id: m.id, maxInputTokens: num(m.limits && (m.limits.max_input_tokens || m.limits.maxInputTokens)), tier: String(m.rate_limit_tier || m.rateLimitTier || '').toLowerCase() || null }))
});

// GITHUB MODELS: the catalog has come back as a bare array, as { models },
// and as a paged { data | items | value } envelope; ids as "publisher/name"
// in `id`, or only in `name` / `model_id`; modalities in any case. The
// parser takes all of them, so a shape change no longer reads as "listed=0"
// (production, 19-20 Oct: "[pg1-models] provider=github_models ok=false
// listed=0 status=200" on every refresh).
function githubModelEntries(json) {
  if (Array.isArray(json)) return json.filter((m) => m && typeof m === 'object');
  if (!json || typeof json !== 'object') return [];
  for (const k of ['models', 'data', 'items', 'value', 'results']) if (Array.isArray(json[k])) return json[k].filter((m) => m && typeof m === 'object');
  return [];
}
function githubModelId(m) {
  for (const v of [m.id, m.model_id, m.modelId, m.name]) {
    if (typeof v === 'string' && /^[\w.-]+\/[\w.:-]+$/.test(v.trim())) return v.trim();
  }
  return typeof m.id === 'string' && m.id.trim() && !/\s/.test(m.id) ? m.id.trim() : null;
}
function hasText(list) {
  return !Array.isArray(list) || list.some((x) => String(x).toLowerCase() === 'text');
}

// Why a 200 read listed no model, as a fixed word for the log line (never
// body text): an empty list (most often a token without the models:read
// permission, or none of the catalog's models enabled for the account), a
// body that is not JSON, or JSON in a shape the parser does not know (its
// top-level keys, names only).
export function emptyCatalogReason(json, rawOk = true) {
  if (!rawOk) return 'not_json';
  if (Array.isArray(json)) return json.length ? 'no_text_models' : 'empty_list';
  if (json && typeof json === 'object') {
    const arr = githubModelEntries(json);
    if (arr.length) return 'no_text_models';
    const keys = Object.keys(json).filter((k) => /^[\w-]{1,32}$/.test(k)).slice(0, 6).join(',');
    return `unknown_shape:${keys || 'none'}`;
  }
  return 'unknown_shape:none';
}

// The known-good model list each engine falls back to when its catalog read
// lists none: the heavy and light preference lists together, best first.
export function defaultModels(provider) {
  const p = MODEL_PREFERENCES[provider];
  if (!p) return [];
  return [...new Set([...(p.heavy || []), ...(p.light || [])])].map((id) => ({ id, maxInputTokens: null, fallback: true }));
}

export function catalogUrl(provider, env = {}) {
  if (provider === 'groq') return 'https://api.groq.com/openai/v1/models';
  if (provider === 'github_models') return 'https://models.github.ai/catalog/models';
  if (provider === 'cloudflare') {
    const account = String(env.CLOUDFLARE_ACCOUNT_ID || '').trim();
    return /^[0-9a-f]{32}$/i.test(account) ? `https://api.cloudflare.com/client/v4/accounts/${account}/ai/models/search?task=${encodeURIComponent('Text Generation')}&per_page=100` : '';
  }
  return '';
}

function headersFor(provider, key) {
  const h = { Authorization: `Bearer ${key}` };
  if (provider === 'github_models') h.Accept = 'application/vnd.github+json';
  return h;
}

// Reads one engine's list (at most once per CATALOG_TTL_MS). keys: the
// router's resolved keys (lib/aiRouter.mjs resolveKeys). Never throws.
export async function refreshCatalog(provider, { env = {}, key = '', fetchImpl = globalThis.fetch, now = () => Date.now(), force = false, timeoutMs = CATALOG_TIMEOUT_MS, log = () => {} } = {}) {
  const cur = state.get(provider);
  if (!force && cur && now() - cur.at < (cur.ok ? CATALOG_TTL_MS : CATALOG_RETRY_MS)) return cur;
  const url = catalogUrl(provider, env);
  if (!key || !url) return cur || null;
  if (inflight.has(provider)) return inflight.get(provider);
  const p = (async () => {
    let next;
    try {
      const res = await fetchImpl(url, { headers: headersFor(provider, key), cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
      let json = null;
      let parsed = false;
      if (res && res.ok) {
        const text = await res.text().catch(() => '');
        try { json = text ? JSON.parse(text) : null; parsed = !!text; } catch (e) { json = null; }
      }
      const models = json ? PARSERS[provider](json) : [];
      next = { at: now(), ok: models.length > 0, models, listed: models.length, status: res ? res.status : null };
      if (!models.length && res && res.ok) next.reason = emptyCatalogReason(json, parsed);
    } catch (e) {
      next = { at: now(), ok: false, models: cur ? cur.models : [], listed: 0, status: null, reason: 'unreachable' };
    }
    if (!next.ok && cur && cur.models.length && !cur.fallback) next.models = cur.models;
    // Nothing listed and nothing known from an earlier read: the engine's
    // known-good default list, so the engine stays in the plan.
    if (!next.models.length) { next.models = defaultModels(provider); next.fallback = next.models.length > 0; }
    state.set(provider, next);
    try { log(`[pg1-models] provider=${provider} ok=${next.ok} listed=${next.listed} status=${next.status == null ? 'none' : next.status}${next.reason ? ` reason=${next.reason}` : ''}${next.fallback ? ' fallback=defaults' : ''}`); } catch (e) { /* logging never breaks a call */ }
    return next;
  })().finally(() => inflight.delete(provider));
  inflight.set(provider, p);
  return p;
}

// Refreshes every free engine that has a key, in parallel, waiting at most
// timeoutMs in all (a slow list never holds up a reply: its last known
// state, or the preference list, is used meanwhile).
export async function ensureCatalogs({ env = {}, keys = {}, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = CATALOG_TIMEOUT_MS, log = () => {} } = {}) {
  const jobs = CATALOG_PROVIDERS.filter((p) => keys[p]).map((p) => refreshCatalog(p, { env, key: keys[p], fetchImpl, now, timeoutMs, log }));
  if (!jobs.length) return;
  await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, timeoutMs + 100).unref?.())]);
}

export function markModelGone(provider, model, now = Date.now()) {
  gone.set(`${provider}|${model}`, now + CATALOG_TTL_MS);
  const cur = state.get(provider);
  if (cur) cur.at = 0; // read the list again on the next call
}

function isGone(provider, model, now) {
  const until = gone.get(`${provider}|${model}`);
  if (!until) return false;
  if (now >= until) { gone.delete(`${provider}|${model}`); return false; }
  return true;
}

// The best chat model an engine lists when none of the preferred ones is.
export function bestListed(provider, models) {
  return models
    .filter((m) => !NOT_CHAT_RE.test(m.id) && !EXCLUDED_FAMILY_RE.test(m.id))
    .map((m) => ({ ...m, limit: modelInputLimit(provider, m.id, m), size: Number((/(\d+(?:\.\d+)?)b\b/i.exec(m.id) || [])[1]) || 0 }))
    .sort((a, b) => (b.size - a.size) || (b.limit - a.limit) || a.id.localeCompare(b.id))
    .map((m) => m.id);
}

// The models one call tries, best first: [{ id, maxInputTokens }].
export function catalogModels(provider, task = 'heavy', { now = Date.now() } = {}) {
  const prefs = (MODEL_PREFERENCES[provider] && (MODEL_PREFERENCES[provider][task] || MODEL_PREFERENCES[provider].heavy)) || [];
  const cur = state.get(provider);
  let ids;
  if (cur && cur.models.length) {
    const listed = new Map(cur.models.map((m) => [m.id, m]));
    ids = prefs.filter((id) => listed.has(id));
    if (!ids.length) ids = bestListed(provider, cur.models).slice(0, 3);
  } else {
    ids = [...prefs];
  }
  ids = ids.filter((id) => !isGone(provider, id, now));
  const listed = cur ? new Map(cur.models.map((m) => [m.id, m])) : new Map();
  return ids.map((id) => ({ id, maxInputTokens: modelInputLimit(provider, id, listed.get(id) || null) }));
}

// The model ids one call tries, best first (catalogModels without limits).
export function catalogModelIds(provider, task = 'heavy', opts = {}) {
  return catalogModels(provider, task, opts).map((m) => m.id);
}

// The model each free engine would use now, for the operator (/keys).
export function selectedModels(task = 'heavy', opts = {}) {
  return Object.fromEntries(CATALOG_PROVIDERS.map((p) => [p, catalogModelIds(p, task, opts)[0] || null]));
}

// Orders a call's models so the request fits: those whose free limit takes
// the request untrimmed come first, in preference order; then the rest,
// largest limit first (they are trimmed to fit, lib/router/fit.mjs).
export function orderForFit(models, inputTokens) {
  const fits = models.filter((m) => !Number.isFinite(m.maxInputTokens) || m.maxInputTokens >= inputTokens);
  const rest = models.filter((m) => !fits.includes(m)).sort((a, b) => b.maxInputTokens - a.maxInputTokens);
  return fits.concat(rest);
}

// One model's free-tier input limit, from the engine's list when it has
// been read (catalogModels without the ordering).
export function catalogLimit(provider, model) {
  const cur = state.get(provider);
  const entry = cur ? cur.models.find((m) => m.id === model) || null : null;
  return modelInputLimit(provider, model, entry);
}

// The last catalog read of one engine, for /keys: { listed, status,
// reason, fallback, at } or null before the first read.
export function catalogState(provider) {
  const cur = state.get(provider);
  return cur ? { listed: cur.listed == null ? cur.models.length : cur.listed, status: cur.status == null ? null : cur.status, reason: cur.reason || null, fallback: !!cur.fallback, at: cur.at } : null;
}

// One line for /keys: the model each free engine uses now (operator only).
const ENGINE_NAMES = { groq: 'Groq', cloudflare: 'Cloudflare Workers AI', github_models: 'GitHub Models' };
export function freeModelsLine(selected = {}) {
  const parts = CATALOG_PROVIDERS.filter((p) => selected[p]).map((p) => `${ENGINE_NAMES[p]} \`${selected[p]}\``);
  return parts.length ? `Free engines' heavy-task model now (read from each engine's model list, at most once a day): ${parts.join(' · ')}.` : '';
}
