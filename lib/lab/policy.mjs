// The lab's limits and network policy, shared by the chat side (/lab
// start checks the budget before dispatching) and the runner
// (scripts/lab-run.mjs, inside .github/workflows/lab.yml).
//
// Budgets: PG1_LAB_BUDGET_USD per experiment (default 2) and
// PG1_LAB_DAILY_USD for all experiments in a UTC day (default 5). The
// runner stops before any call that could take an experiment over its
// budget (BudgetMeter, worst case: the call's maximum output); the chat
// refuses a start that could take the day over (spent today on the usage
// ledger, task 'lab', plus every queued or running experiment's budget).
// Time: PG1_LAB_MAX_MINUTES (default 15) inside a job capped at 20 minutes.
//
// Network: research may GET public web pages (lib/netGuard.mjs: https, no
// private addresses, no redirects). The only POSTs are to the model APIs,
// and for a code experiment to api.github.com to open the draft PR.

import { estimateCost, modelPrice, dailySpendCapUsd } from '../aiRouter.mjs';
import { safeFetch, UnsafeUrlError } from '../netGuard.mjs';

// The lab's own keys (Claude, the paid Gemini key) are paid. With
// PG1_DAILY_SPEND_CAP_USD at its $0 default (lib/aiRouter.mjs) no paid AI
// runs on its own, so the lab runs on the free engines instead (lab data
// is the operator's own, never a client's, so they are allowed): the
// runner calls no paid engine, records $0, and skips a step only a paid
// engine can do (web search grounding) with that reason, never failing the
// run for it.
export const LAB_PAID_OFF_REASON = 'paid AI is off: PG1_DAILY_SPEND_CAP_USD is $0 (unset), so the lab runs on the free engines only';
export const LAB_SEARCH_SKIPPED = 'web search needs a paid engine and paid AI is $0: skipped, the findings come from the model and any pages given';
export function labPaidOff(env = {}) {
  return !(dailySpendCapUsd(env) > 0);
}

export const DEFAULT_LAB_BUDGET_USD = 2;
export const DEFAULT_LAB_DAILY_USD = 5;
export const DEFAULT_LAB_MAX_MINUTES = 15;
export const LAB_KINDS = Object.freeze(['research', 'skill', 'code']);
export const LAB_TASK = 'lab';
export const MODEL_POST_HOSTS = Object.freeze(['generativelanguage.googleapis.com', 'api.anthropic.com']);
// The free engines a $0 lab run may call (lib/aiRouter.mjs OPENAI_COMPAT;
// the free Gemini key is on generativelanguage.googleapis.com above).
export const FREE_MODEL_POST_HOSTS = Object.freeze(['api.groq.com', 'api.mistral.ai', 'models.github.ai', 'api.cloudflare.com']);
export const GITHUB_API_HOST = 'api.github.com';

// The kind a goal really is, from its words. A goal that implements,
// builds, prototypes or drafts code (a tool, endpoint, middleware,
// component...) is a code experiment: it must go through research, build,
// test and the gate, never end as findings only. A goal about a skill is a
// skill experiment. Everything else is research.
const SKILL_GOAL = /\b(?:a|an|the|new|this)\s+(?:[\w-]+\s+){0,3}skill\b/i;
const CODE_VERB = /\b(?:implement(?:s|ed|ing)?|build(?:s|ing)?|prototyp(?:e|es|ed|ing)|refactor(?:s|ed|ing)?|scaffold(?:s|ed|ing)?|patch(?:es|ed|ing)?|code\s+(?:up|a|an|the)|wire\s+up)\b/i;
const CODE_ARTIFACT = String.raw`(?:tool|endpoint|route|api|middleware|component|function|module|script|handler|counter|check|ui|widget|migration|test|tests|parser|server|worker|cron|webhook|sdk|cli|library|code)s?`;
const CODE_MAKE = new RegExp(String.raw`\b(?:draft|write|add|create|make|develop|ship)\s+(?:a|an|the|new|our)?\s*(?:[\w./-]+\s+){0,6}${CODE_ARTIFACT}\b`, 'i');
const CODE_IDENT = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/;
export function classifyLabKind(goal) {
  const g = String(goal || '');
  if (SKILL_GOAL.test(g) && !CODE_VERB.test(g)) return 'skill';
  if (CODE_VERB.test(g) || CODE_MAKE.test(g)) return 'code';
  if (CODE_IDENT.test(g) && /\b(?:draft|write|add|create|make)\b/i.test(g)) return 'code';
  return 'research';
}

const num = (v, d, { min = 0.01, max = 1000 } = {}) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : d;
};
export const labBudgetUsd = (env = process.env) => num(env.PG1_LAB_BUDGET_USD, DEFAULT_LAB_BUDGET_USD);
export const labDailyUsd = (env = process.env) => num(env.PG1_LAB_DAILY_USD, DEFAULT_LAB_DAILY_USD);
export const labMaxMinutes = (env = process.env) => num(env.PG1_LAB_MAX_MINUTES, DEFAULT_LAB_MAX_MINUTES, { min: 1, max: 18 });

// stop: where the meter stopped. The runner stops BEFORE a call whose
// worst case could cross the budget, so the spend is usually under it:
// threshold_usd = budget - that call's worst case is the stop line.
export class LabBudgetError extends Error {
  constructor(message, stop = null) {
    super(message);
    this.code = 'over_budget';
    this.stop = stop;
  }
}

// Per-experiment spend. reserve() before a call with its worst case,
// settle() after with the real usage. Throws LabBudgetError instead of
// making a call that could go over.
export function createBudgetMeter({ budgetUsd, env = {} }) {
  let spent = 0;
  let calls = 0;
  return {
    get spent() { return Math.round(spent * 1e6) / 1e6; },
    get calls() { return calls; },
    worstCase({ provider, model, inputTokens, maxOutputTokens }) {
      return estimateCost({ env, provider, model, inputTokens, outputTokens: maxOutputTokens });
    },
    reserve({ provider, model, inputTokens, maxOutputTokens }) {
      const worst = estimateCost({ env, provider, model, inputTokens, outputTokens: maxOutputTokens });
      if (spent + worst > budgetUsd) throw new LabBudgetError(`the next call could cost up to $${worst.toFixed(4)}, over this experiment's $${budgetUsd} budget ($${spent.toFixed(4)} spent)`, { spent_usd: Math.round(spent * 1e6) / 1e6, next_call_worst_usd: Math.round(worst * 1e6) / 1e6, threshold_usd: Math.max(0, Math.round((budgetUsd - worst) * 1e6) / 1e6), budget_usd: budgetUsd });
      return worst;
    },
    settle({ provider, model, inputTokens, outputTokens }) {
      calls++;
      spent += estimateCost({ env, provider, model, inputTokens, outputTokens });
      return spent;
    },
    // A call on a free engine: counted, costs nothing.
    settleFree() {
      calls++;
      return spent;
    }
  };
}

export function priceOf(env, provider, model) {
  return modelPrice(env, provider, model);
}

// The runner's fetch: GET/HEAD to public https pages through netGuard;
// POST only to the model APIs (and api.github.com when allowGitHub).
export function createLabFetch({ fetchImpl = globalThis.fetch, allowGitHub = false, lookup, allowFree = false } = {}) {
  return async (url, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    let host = '';
    try { host = new URL(String(url)).hostname.toLowerCase(); } catch (e) { throw new UnsafeUrlError('not a valid URL', 'invalid_url'); }
    if (method === 'GET' || method === 'HEAD') {
      if (MODEL_POST_HOSTS.includes(host) || (allowGitHub && host === GITHUB_API_HOST)) return fetchImpl(url, options);
      return safeFetch(url, { ...options, method }, { fetchImpl, lookup });
    }
    if (MODEL_POST_HOSTS.includes(host)) return fetchImpl(url, options);
    if (allowFree && FREE_MODEL_POST_HOSTS.includes(host)) return fetchImpl(url, options);
    if (allowGitHub && host === GITHUB_API_HOST) return fetchImpl(url, options);
    throw new UnsafeUrlError(`the lab may not ${method} to ${host}: only model APIs`, 'write_blocked');
  };
}

// Files a code experiment may create or change. Never workflows, deploy or
// package config, secrets, the autonomy policy or the audit log.
const CODE_ALLOWED = [/^lib\/[\w./-]+\.(?:mjs|js|json|md)$/, /^api\/[\w./-]+\.(?:mjs|js)$/, /^tests\/[\w./-]+\.(?:mjs|js|json)$/, /^docs\/[\w./-]+\.md$/, /^public\/docs\/[\w./-]+\.(?:html|css|md)$/, /^scripts\/[\w./-]+\.(?:mjs|js)$/, /^supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/];
const CODE_BLOCKED = [/^\.github\//, /^scripts\/lab-/, /^lib\/lab\//, /^tests\/ci\//, /^\.env/, /(?:^|\/)\.env/, /^vercel\.json$/, /^package(?:-lock)?\.json$/, /^lib\/autonomy\.mjs$/, /^lib\/lab\/policy\.mjs$/, /audit/i, /\.\./, /^\//];
export const MAX_CODE_FILES = 20;
export const MAX_CODE_BYTES = 200 * 1024;

export function checkCodePath(path) {
  const p = String(path || '');
  if (CODE_BLOCKED.some((re) => re.test(p))) return { ok: false, reason: 'blocked path' };
  if (!CODE_ALLOWED.some((re) => re.test(p))) return { ok: false, reason: 'not an allowed path' };
  return { ok: true };
}
