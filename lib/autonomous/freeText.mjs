// Text for autonomous work (diagnoses, mission plans, the daily briefing):
// the free engines only, unless the operator gave autonomous work a daily
// budget (/auto budget), and then the paid engines only after every free
// one failed. Operator content: never client data. A safety refusal stops
// the task and is never tried on another engine (runRoute).

import {
  TASKS, DATA, planRoute, runRoute, callOpenAiCompat, isPaidProvider, BACKGROUND_THROTTLE, estimateTokens
} from '../aiRouter.mjs';
import { fitRequest } from '../router/fit.mjs';
import { ENGINE_MAX_INPUT_TOKENS } from '../capabilities/registry.mjs';
import { catalogLimit, CATALOG_PROVIDERS, FREE_MAX_OUTPUT } from '../router/modelCatalog.mjs';
import { classify429, coolDown, isCooling, readyModels, learnedLimits } from '../router/quota.mjs';
import { freeLimiterFor, PRIORITY, PACED_ENGINES } from '../router/freeLimiter.mjs';
import { getSupabaseCreds } from '../supabase.mjs';
import { claimAlert } from '../router/alerts.mjs';

// BACKGROUND SHARE (lib/router/freeLimiter.mjs): autonomous work takes its
// requests and tokens from the smaller background share of each free
// engine's budget, yields while operator chat is active, and skips a model
// whose quota is cooling down (lib/router/quota.mjs). When every free engine
// refuses for those reasons the work pauses: autonomousText answers
// { ok: false, paused: true } and the operator gets one notice a day, not
// one per job.
export const BACKGROUND_WAIT_MS = 30000;
export const PAUSE_NOTICE_ENGINE = 'background_paused';
const PAUSE_REASONS = new Set(['chat_active', 'rpd', 'tpd', 'tpm', 'rpm', 'cooling']);

let creds = undefined;
function dbCreds() {
  if (creds === undefined) { try { creds = getSupabaseCreds() || null; } catch (e) { creds = null; } }
  return creds || {};
}

async function backgroundSlot(c, tokens, env) {
  if (!PACED_ENGINES.includes(c.provider)) return { granted: true };
  return freeLimiterFor({ env, ...dbCreds(), engine: c.provider }).acquire({ priority: PRIORITY.BACKGROUND, maxWaitMs: BACKGROUND_WAIT_MS, tokens, learned: learnedLimits(c.provider) });
}

// One notice a day when background work pauses (claimed across instances
// like the router's alerts).
export async function notePausedOnce({ env = process.env, reasons = [], notify = null, now = Date.now() } = {}) {
  try {
    const claimed = await claimAlert({ engine: PAUSE_NOTICE_ENGINE, ...dbCreds(), now, windowMs: 24 * 3600 * 1000 });
    if (!claimed) return false;
    const line = `Autonomous mode paused its AI work: the free engines are busy with your chat or their free quotas are low (${[...new Set(reasons)].join(', ') || 'no room'}). It resumes on its own when they have room.`;
    console.log(`[autonomous] paused reasons=${[...new Set(reasons)].join(',')}`);
    if (notify) await notify(line);
    return true;
  } catch (e) { return false; }
}

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';

async function geminiText({ candidate, system, prompt, maxTokens, fetchImpl }) {
  let last = { ok: false, status: null, detail: 'no model' };
  const models = readyModels(candidate.provider, candidate.models);
  if (!models.length) return { ok: false, status: null, detail: 'cooling: every model quota is cooling down', pause: 'cooling' };
  for (const model of models) {
    try {
      const res = await fetchImpl(`${GEMINI_API}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': candidate.key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } }),
        signal: AbortSignal.timeout(45000)
      });
      const raw = await res.text();
      if (!res.ok) {
        if (res.status === 429) coolDown(candidate.provider, model, classify429({ provider: candidate.provider, status: 429, text: raw }));
        last = { ok: false, status: res.status, model, detail: raw.slice(0, 300) };
        continue;
      }
      const j = JSON.parse(raw || '{}');
      const cand = (j.candidates || [])[0];
      const blocked = (j.promptFeedback && j.promptFeedback.blockReason) || (cand && ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(cand.finishReason) ? cand.finishReason : '');
      if (blocked) return { ok: false, status: res.status, model, refused: true, detail: `blocked: ${blocked}` };
      const text = ((cand && cand.content && cand.content.parts) || []).map((p) => (p && typeof p.text === 'string' && !p.thought ? p.text : '')).join('');
      if (text) return { ok: true, status: 200, model, value: text, usage: { inputTokens: estimateTokens(system + prompt), outputTokens: estimateTokens(text) } };
      last = { ok: false, status: null, model, detail: 'no text' };
    } catch (e) {
      last = { ok: false, status: null, model, detail: e && e.name === 'TimeoutError' ? 'timed out' : String(e && e.message) };
    }
  }
  return last;
}

// { ok, text, provider, refused, failures }.
export async function autonomousText({ env = process.env, system, prompt, maxTokens = 1500, allowPaid = false, fetchImpl = globalThis.fetch, ledger = null, log = () => {}, notify = null }) {
  const plan = planRoute(TASKS.HEAVY, { env, dataClass: DATA.OPERATOR, background: true, ledger })
    .filter((c) => (allowPaid || !isPaidProvider(c.provider)) && (c.family === 'gemini' || c.family === 'openai_compat'));
  if (!plan.length) return { ok: false, text: '', provider: null, refused: false, failures: [], reason: allowPaid ? 'no text engine is available' : 'no free text engine is configured (and paid AI is $0 for autonomous work)' };
  const out = await runRoute({
    task: TASKS.HEAVY, env, dataClass: DATA.OPERATOR, plan, ledger, log, throttle: BACKGROUND_THROTTLE,
    attempt: async (c) => {
      if (isCooling(c.provider, '*')) return { ok: false, status: null, detail: 'cooling', pause: 'cooling' };
      const slot = await backgroundSlot(c, estimateTokens(system + prompt) + maxTokens, env);
      if (!slot.granted) return { ok: false, status: null, detail: `background share: ${slot.reason}`, pause: slot.reason };
      if (c.family === 'gemini') return geminiText({ candidate: c, system, prompt, maxTokens, fetchImpl });
      const out = maxTokens > (FREE_MAX_OUTPUT[c.provider] || Infinity) ? FREE_MAX_OUTPUT[c.provider] : maxTokens;
      for (const model of readyModels(c.provider, c.models)) {
        const limit = CATALOG_PROVIDERS.includes(c.provider) ? catalogLimit(c.provider, model) : ENGINE_MAX_INPUT_TOKENS[c.provider];
        const fit = fitRequest({ system, prompt, maxInputTokens: (Number.isFinite(limit) ? limit : Infinity) - (c.provider === 'groq' ? out : 0) });
        if (!fit.fits) continue;
        const r = await callOpenAiCompat({ candidate: c, model, system: fit.system, prompt: fit.prompt, maxTokens: out, fetchImpl, env, log });
        if (r.status === 429) coolDown(c.provider, Array.isArray(model) ? model[0] : model, classify429({ provider: c.provider, status: 429, text: r.detail || '', headers: r.rateHeaders || null }));
        if (r.ok || r.refused) return r;
        if (r.status === 401 || r.status === 402 || r.status === 403) return r;
      }
      return { ok: false, status: 413, detail: 'the request does not fit this engine' };
    }
  });
  const refused = !out.ok && out.failures.some((f) => f.refused);
  // Every free engine said "not now" (chat active, its share used, cooling):
  // the work pauses, with one notice a day.
  const pauses = (out.failures || []).map((f) => f.pause || (/^background share: (\w+)|^cooling/.exec(String(f.detail || '')) || [])[1] || (/^cooling/.test(String(f.detail || '')) ? 'cooling' : null));
  const paused = !out.ok && !refused && pauses.length > 0 && pauses.every((p) => p && PAUSE_REASONS.has(p));
  if (paused) await notePausedOnce({ env, reasons: pauses, notify });
  return { ok: out.ok, text: out.ok ? String(out.value || '') : '', provider: out.candidate ? out.candidate.provider : null, refused, failures: out.failures, ...(paused ? { paused: true, reason: 'paused: the free engines are busy with chat or low on quota' } : {}) };
}

// The first JSON object in a model's reply, or null.
export function jsonFrom(text) {
  const t = String(text || '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  const body = fenced ? fenced[1] : t;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch (e) { return null; }
}
