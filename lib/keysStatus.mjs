// /keys (signed-in operator only): every AI key PG1 has, set or missing,
// and its live state from the cheapest check that can tell:
//
//   working          the engine answered
//   spend cap reached  Gemini's 429 "exceeded its monthly spending cap": the
//                    operator's own monthly cap in AI Studio, not credit
//   out of credit    a 402, or a credit or billing error (Anthropic's 400
//                    "credit balance is too low", OpenAI's insufficient_quota)
//   rate-limited     a 429 that is not about credit
//   invalid          401 or 403 (a wrong, revoked or under-scoped key)
//   unreachable      a timeout or network error
//
// Checks: a balance or account endpoint where the engine has one (OpenRouter
// /api/v1/key and /credits, the AI gateway /v1/credits, ElevenLabs
// /v1/user/subscription, Replicate /v1/account); a model list where a valid
// key is all it can show (Cartesia, Groq, Mistral, GitHub Models,
// Cloudflare); otherwise a one-token request (Anthropic, Gemini, OpenAI),
// the only way to see an empty account.
//
// Results are cached for 5 minutes per key (/keys fresh checks again). The
// key values never leave this module: rows carry the engine, set/missing,
// the state and the status only. Operator-only output, so provider names
// are allowed here.

import crypto from 'node:crypto';
import { resolveKeys, isBillingFailure, isSpendCapFailure } from './aiRouter.mjs';
import { readOpenRouter } from './router/openrouterGuard.mjs';
import { PARSERS, emptyCatalogReason } from './router/modelCatalog.mjs';

export const KEYS_CACHE_MS = 5 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 8000;
export const STATES = Object.freeze({ WORKING: 'working', SPEND_CAP: 'spend cap reached', NO_CREDIT: 'out of credit', RATE_LIMITED: 'rate-limited', INVALID: 'invalid', UNREACHABLE: 'unreachable', MISSING: 'missing' });

export function isKeysCommand(lower) {
  return /^\/keys(?:\s|$)/.test(String(lower || '').trim());
}

// The state for one HTTP outcome.
export function stateFor(status, text = '') {
  if (status == null) return STATES.UNREACHABLE;
  if (status >= 200 && status < 300) return STATES.WORKING;
  if (isSpendCapFailure(status, text)) return STATES.SPEND_CAP;
  if (isBillingFailure(status, text) || (status === 400 && /credit/i.test(String(text || '')))) return STATES.NO_CREDIT;
  if (status === 429) return STATES.RATE_LIMITED;
  if (status === 401 || status === 403) return STATES.INVALID;
  return `error (${status})`;
}

async function hit(fetchImpl, url, options = {}) {
  try {
    const res = await fetchImpl(url, { cache: 'no-store', ...options, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    return { status: res.status, text: text.slice(0, 400), json };
  } catch (e) {
    return { status: null, text: e && e.name === 'TimeoutError' ? 'timed out' : 'unreachable', json: null };
  }
}

const money = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
const jsonPost = (key, body, extra = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });

// One check per engine: (key, keys, fetchImpl) -> { status, state, note? }.
const CHECKS = {
  anthropic: async (key, k, f) => {
    const r = await hit(f, 'https://api.anthropic.com/v1/messages', jsonPost(key, { model: 'claude-haiku-5-5', max_tokens: 1, messages: [{ role: 'user', content: '.' }] }, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }));
    return { status: r.status, state: stateFor(r.status, r.text) };
  },
  gemini_paid: (key, k, f) => geminiCheck(key, f),
  gemini_free: (key, k, f) => geminiCheck(key, f),
  openrouter: async (key, k, f) => {
    const o = await readOpenRouter({ key, fetchImpl: f, timeoutMs: CHECK_TIMEOUT_MS });
    if (!o.ok) return { status: o.status, state: stateFor(o.status, o.detail || '') };
    const bal = o.balanceUsd == null ? 'balance unknown' : `balance ${money(o.balanceUsd)}`;
    const note = `${bal}; today ${money(o.usageDailyUsd || 0)}; free tier ${o.freeDailyRequests} free-model requests/day${o.balanceUsd != null && o.balanceUsd <= 0 ? '; dormant until above $0' : o.balanceUsd != null && o.balanceUsd <= 2 ? '; free models only (paid above $2)' : ''}`;
    return { status: o.status, state: o.balanceUsd != null && o.balanceUsd <= 0 ? STATES.NO_CREDIT : STATES.WORKING, note, balanceUsd: o.balanceUsd == null ? null : o.balanceUsd };
  },
  gateway: async (key, k, f) => {
    const r = await hit(f, 'https://ai-gateway.vercel.sh/v1/credits', { headers: { Authorization: `Bearer ${key}` } });
    const bal = r.json && Number.isFinite(Number(r.json.balance)) ? Number(r.json.balance) : null;
    if (r.status === 200 && bal != null) return { status: 200, state: bal > 0 ? STATES.WORKING : STATES.NO_CREDIT, note: `balance ${money(bal)}`, balanceUsd: bal };
    return { status: r.status, state: stateFor(r.status, r.text) };
  },
  openai: async (key, k, f) => {
    const r = await hit(f, 'https://api.openai.com/v1/chat/completions', jsonPost(key, { model: 'gpt-4.1-nano', max_tokens: 1, messages: [{ role: 'user', content: '.' }] }, { Authorization: `Bearer ${key}` }));
    return { status: r.status, state: stateFor(r.status, r.text) };
  },
  elevenlabs: async (key, k, f) => {
    const r = await hit(f, 'https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': key } });
    if (r.status === 200 && r.json) {
      const used = Number(r.json.character_count) || 0;
      const limit = Number(r.json.character_limit) || 0;
      return { status: 200, state: limit && used >= limit ? STATES.NO_CREDIT : STATES.WORKING, ...(limit ? { charsLeft: Math.max(0, limit - used), charsLimit: limit } : {}), note: limit ? `${used.toLocaleString('en-GB')} of ${limit.toLocaleString('en-GB')} characters used${r.json.tier ? ` (${String(r.json.tier).replace(/[^\w -]/g, '')} plan)` : ''}` : '' };
    }
    return { status: r.status, state: stateFor(r.status, r.text) };
  },
  cartesia: async (key, k, f) => {
    const r = await hit(f, 'https://api.cartesia.ai/voices?limit=1', { headers: { 'X-API-Key': key, 'Cartesia-Version': '2024-06-10' } });
    return { status: r.status, state: stateFor(r.status, r.text), note: r.status === 200 ? 'key valid (Cartesia has no credit endpoint)' : '' };
  },
  replicate: async (key, k, f) => {
    const r = await hit(f, 'https://api.replicate.com/v1/account', { headers: { Authorization: `Bearer ${key}` } });
    return { status: r.status, state: stateFor(r.status, r.text), note: r.status === 200 ? 'key valid (credit shows on the first paid call)' : '' };
  },
  groq: (key, k, f) => listCheck(f, 'https://api.groq.com/openai/v1/models', { Authorization: `Bearer ${key}` }),
  mistral: (key, k, f) => listCheck(f, 'https://api.mistral.ai/v1/models', { Authorization: `Bearer ${key}` }),
  github_models: (key, k, f) => githubModelsCheck(key, f),
  cloudflare: (key, k, f) => listCheck(f, `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(k.cloudflareAccount)}/ai/models/search?per_page=1`, { Authorization: `Bearer ${key}` })
};

async function geminiCheck(key, f) {
  const r = await hit(f, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent', jsonPost(key, { contents: [{ role: 'user', parts: [{ text: '.' }] }], generationConfig: { maxOutputTokens: 1 } }, { 'x-goog-api-key': key }));
  const state = stateFor(r.status, r.text);
  return { status: r.status, state, note: state === STATES.SPEND_CAP ? `${SPEND_CAP_NOTE}` : '' };
}

// The operator's next step for a capped Gemini project (operator-only
// output: /keys and the film / movie pre-spend check).
export const SPEND_CAP_LINK = 'https://ai.studio/spend';
export const SPEND_CAP_NOTE = `monthly spending cap reached; raise it at ${SPEND_CAP_LINK}`;

// GitHub Models: the catalog (how many chat models it lists, and why none
// when it lists none) and a one-token call on the free tier, the only way
// to see a token without the models:read permission: the catalog answers
// 200 either way. The state is the call's; the note says both.
export const GITHUB_MODELS_PROBE_MODEL = 'openai/gpt-4.1-mini';
async function githubModelsCheck(key, f) {
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const list = await hit(f, 'https://models.github.ai/catalog/models', { headers });
  const models = list.status === 200 && list.json ? PARSERS.github_models(list.json) : [];
  const listed = list.status === 200
    ? (models.length ? `catalog lists ${models.length} chat models` : `catalog lists 0 models (${emptyCatalogReason(list.json, list.json != null)}); using the default model list`)
    : `catalog read failed (${list.status == null ? list.text : list.status})`;
  const call = await hit(f, 'https://models.github.ai/inference/chat/completions', jsonPost(key, { model: GITHUB_MODELS_PROBE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: '.' }] }, { Authorization: `Bearer ${key}` }));
  let state = stateFor(call.status, call.text);
  let note = listed;
  if (call.status === 200) note += '; a free-tier call answered';
  else if (call.status === 401 || call.status === 403) note += /models/i.test(call.text) || call.status === 403 ? '; the token cannot call models: give it the models:read permission' : '; the token was refused';
  else if (call.status === 429) note += '; free-tier calls rate-limited now';
  else if (call.status === 404) { state = list.status === 200 ? STATES.WORKING : state; note += `; probe model ${GITHUB_MODELS_PROBE_MODEL} not offered`; }
  return { status: call.status, state, note, listed: models.length };
}

async function listCheck(f, url, headers) {
  const r = await hit(f, url, { headers });
  return { status: r.status, state: stateFor(r.status, r.text), note: r.status === 200 ? 'key valid (free tier; limits show on a call)' : '' };
}

// Every key, in the order /keys shows them: [engine, label, env var names].
export const KEY_ROWS = Object.freeze([
  ['anthropic', 'Anthropic (Claude)', 'ANTHROPIC_API_KEY'],
  ['gemini_paid', 'Gemini (paid key)', 'GEMINI_API_KEY_PAID'],
  ['gemini_free', 'Gemini (free key)', 'GEMINI_API_KEY_FREE'],
  ['openrouter', 'OpenRouter', 'OPENROUTER_API_KEY'],
  ['gateway', 'AI gateway', 'VERCEL_AI_API_KEY'],
  ['openai', 'OpenAI', 'OPENAI_API_KEY'],
  ['groq', 'Groq (free)', 'GROQ_API_KEY'],
  ['mistral', 'Mistral (free)', 'MISTRAL_API_KEY'],
  ['github_models', 'GitHub Models (free)', 'GITHUB_MODELS_TOKEN'],
  ['cloudflare', 'Cloudflare Workers AI (free)', 'CLOUDFLARE_AI_TOKEN + CLOUDFLARE_ACCOUNT_ID'],
  ['elevenlabs', 'ElevenLabs', 'ELEVENLABS_API_KEY'],
  ['cartesia', 'Cartesia', 'CARTESIA_API_KEY'],
  ['replicate', 'Replicate', 'REPLICATE_API_TOKEN']
]);

function keyOf(keys, engine) {
  if (engine === 'gemini_paid') return keys.geminiPaid[0] || '';
  if (engine === 'gemini_free') return keys.geminiFree[0] || '';
  return keys[engine] || '';
}

const cache = new Map();
export function __resetKeysCache() { cache.clear(); }
const fingerprint = (engine, key) => `${engine}:${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16)}`;

// [{ engine, label, set, state, status, note, cached }] for every key.
// cachedOnly: no live check; a key not checked in the last 5 minutes is
// returned as 'not checked' (/usage reads balances this way, /keys checks).
export async function keysStatus({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), fresh = false, cachedOnly = false } = {}) {
  const keys = resolveKeys(env);
  return Promise.all(KEY_ROWS.map(async ([engine, label, envName]) => {
    const key = keyOf(keys, engine);
    if (!key) return { engine, label, envName, set: false, state: STATES.MISSING, status: null, note: '', cached: false };
    const id = fingerprint(engine, key);
    const hitCache = cache.get(id);
    if (!fresh && hitCache && now() - hitCache.at < KEYS_CACHE_MS) return { ...hitCache.row, cached: true };
    if (cachedOnly) return { engine, label, envName, set: true, state: 'not checked', status: null, note: '', cached: false };
    let out;
    try { out = await CHECKS[engine](key, keys, fetchImpl); } catch (e) { out = { status: null, state: STATES.UNREACHABLE }; }
    const row = { engine, label, envName, set: true, state: out.state, status: out.status == null ? null : out.status, note: out.note || '', cached: false };
    if (Number.isFinite(out.balanceUsd)) row.balanceUsd = out.balanceUsd;
    if (Number.isFinite(out.charsLeft)) { row.charsLeft = out.charsLeft; row.charsLimit = out.charsLimit; }
    cache.set(id, { at: now(), row });
    return row;
  }));
}

const ICON = { [STATES.WORKING]: 'working', [STATES.SPEND_CAP]: 'SPEND CAP REACHED', [STATES.NO_CREDIT]: 'OUT OF CREDIT', [STATES.RATE_LIMITED]: 'rate-limited', [STATES.INVALID]: 'INVALID', [STATES.UNREACHABLE]: 'unreachable', [STATES.MISSING]: 'missing' };

export function keysTable(rows) {
  const clean = (t) => String(t || '').replace(/\|/g, '/');
  const lines = ['### [ AI KEYS ]', '', '| Engine | Key | State | Status | Notes |', '|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.label} | ${r.set ? 'set' : `missing (${r.envName})`} | ${ICON[r.state] || r.state} | ${r.status == null ? '-' : r.status} | ${clean(r.note)}${r.cached ? (r.note ? ' ' : '') + '(cached)' : ''} |`);
  const working = rows.filter((r) => r.state === STATES.WORKING).length;
  lines.push('', `${working} of ${rows.filter((r) => r.set).length} set keys working. Checked at most every 5 minutes; \`/keys fresh\` checks again. Key values are never shown.`);
  return lines.join('\n');
}

export async function handleKeysCommand({ env = process.env, fetchImpl = globalThis.fetch, fresh = false, now } = {}) {
  const rows = await keysStatus({ env, fetchImpl, fresh, ...(now ? { now } : {}) });
  return { rows, reply: keysTable(rows) };
}
