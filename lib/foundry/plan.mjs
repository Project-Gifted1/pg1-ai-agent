// A commissioned tool is a declarative plan, never code: a list of calls
// to PG1 primitives whose arguments are the caller's inputs or literals.
//
//   { version: 1, steps: [{ tool, args: { param: "$input.<name>" | literal } }] }
//
// The lab may write code while it builds and tests the tool, but that code
// runs only in the lab. What is deployed is this plan, validated again at
// deploy time and on every call, and run by runPlan below at the EXTERNAL
// tier through PG1's own handlers. Customers can never run arbitrary code.

import { PRIMITIVES } from './catalogue.mjs';
import { reason } from '../reasonCodes.mjs';
import { FoundryInputError } from './screen.mjs';

export const PLAN_VERSION = 1;
export const STEP_TIMEOUT_MS = 8000;
const REF = /^\$input\.([a-z][a-z0-9_]{0,39})$/;

function validArg(v, inputNames) {
  if (typeof v === 'string') {
    const m = REF.exec(v);
    if (m) return inputNames.includes(m[1]);
    return v.length <= 100 && !v.startsWith('$');
  }
  return typeof v === 'number' || typeof v === 'boolean';
}

// Throws FoundryInputError when the plan is not a valid plan for these inputs.
export function validatePlan(plan, inputSchema) {
  const inputNames = Object.keys((inputSchema && inputSchema.properties) || {});
  if (!plan || plan.version !== PLAN_VERSION || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > 6) throw new FoundryInputError('a plan has 1 to 6 steps');
  for (const s of plan.steps) {
    const prim = PRIMITIVES[s && s.tool];
    if (!prim) throw new FoundryInputError(`${s && s.tool} is not a PG1 primitive`);
    const args = s.args && typeof s.args === 'object' && !Array.isArray(s.args) ? s.args : null;
    if (!args || !Object.keys(args).length) throw new FoundryInputError(`${s.tool} needs arguments`);
    for (const [k, v] of Object.entries(args)) {
      if (!prim.params.includes(k)) throw new FoundryInputError(`${s.tool} takes no argument ${k}`);
      if (!validArg(v, inputNames)) throw new FoundryInputError(`${s.tool}.${k} must be an input reference ($input.<name>) or a short literal`);
    }
  }
  return true;
}

// The plan for a spec: its compose list, or each primitive data source
// with the arguments whose names match the inputs.
export function draftPlan(spec) {
  const inputNames = Object.keys(spec.inputs.properties);
  let steps;
  if (spec.compose && spec.compose.length) {
    steps = spec.compose.map((c) => ({ tool: c.tool, args: { ...c.args } }));
  } else {
    steps = spec.data_sources.filter((s) => PRIMITIVES[s.id]).map((s) => {
      const args = {};
      for (const p of PRIMITIVES[s.id].params) if (inputNames.includes(p)) args[p] = `$input.${p}`;
      return { tool: s.id, args };
    });
  }
  const plan = { version: PLAN_VERSION, steps };
  validatePlan(plan, spec.inputs);
  return plan;
}

// Feasibility: a plan exists and its estimated p95 meets the target.
export function feasibility(spec) {
  let plan;
  try {
    plan = draftPlan(spec);
  } catch (e) {
    return { feasible: false, reason: `${e.message}. Name the inputs after the primitives' arguments, or give compose.` };
  }
  const p95 = Math.max(...plan.steps.map((s) => PRIMITIVES[s.tool].p95Ms));
  if (p95 > spec.latency_ms_target) return { feasible: false, plan, reason: `the estimated p95 is ${p95} ms, above the ${spec.latency_ms_target} ms target`, achievable_ms: p95 };
  return { feasible: true, plan, p95_ms: p95 };
}

function invalid(message) {
  return Object.assign(new Error(message), { mcpToolError: true, code: 'invalid_input' });
}

export function validateInput(inputSchema, input) {
  const a = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const props = inputSchema.properties || {};
  for (const k of Object.keys(a)) if (!props[k]) throw invalid(`unknown argument ${k}`);
  for (const r of inputSchema.required || []) if (a[r] === undefined || a[r] === null || a[r] === '') throw invalid(`${r} is required`);
  for (const [k, p] of Object.entries(props)) {
    const v = a[k];
    if (v === undefined) continue;
    const ok = p.type === 'string' ? typeof v === 'string' && v.length <= (p.maxLength || 300) : p.type === 'integer' ? Number.isInteger(v) : p.type === 'number' ? Number.isFinite(v) : typeof v === 'boolean';
    if (!ok) throw invalid(`${k} must be a ${p.type}`);
    if (p.enum && !p.enum.includes(String(v))) throw invalid(`${k} must be one of ${p.enum.join(', ')}`);
  }
  return a;
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('timed out'), { code: 'timeout' })), ms); })]).finally(() => clearTimeout(t));
}

// Runs a deployed plan. Fail closed like preflight_check: a step that errors
// or times out makes the result unknown, never no_flags.
export async function runPlan(tool, input, { runTool, timeoutMs = STEP_TIMEOUT_MS, now = () => Date.now() } = {}) {
  validatePlan(tool.plan, tool.input_schema);
  const a = validateInput(tool.input_schema, input);
  const started = now();
  const steps = await Promise.all(tool.plan.steps.map(async (s) => {
    const args = {};
    for (const [k, v] of Object.entries(s.args)) {
      const m = typeof v === 'string' ? REF.exec(v) : null;
      const val = m ? a[m[1]] : v;
      if (val !== undefined && val !== '') args[k] = val;
    }
    const t0 = now();
    try {
      const r = await withTimeout(Promise.resolve().then(() => runTool(s.tool, args)), timeoutMs);
      const status = ['no_flags', 'flagged', 'unknown'].includes(r && r.status) ? r.status : 'unknown';
      return { tool: s.tool, status, ms: now() - t0, reasons: (r && r.reasons) || [], result: r };
    } catch (e) {
      return { tool: s.tool, status: 'unknown', ms: now() - t0, error: e && e.code === 'timeout' ? 'timeout' : 'error', reasons: [] };
    }
  }));
  const reasons = [];
  for (const s of steps) for (const r of s.reasons) reasons.push({ ...r, check: s.tool });
  const incomplete = steps.filter((s) => s.error);
  if (incomplete.length) reasons.push({ ...reason('PREFLIGHT_CHECK_INCOMPLETE', `${incomplete.map((s) => `${s.tool} (${s.error})`).join(', ')} did not finish, so the result is unknown.`), check: tool.name });
  const status = steps.some((s) => s.status === 'flagged') ? 'flagged' : steps.some((s) => s.status !== 'no_flags') ? 'unknown' : 'no_flags';
  return {
    tool: tool.name,
    status,
    reasons,
    checks: steps.map((s) => ({ source: s.tool, result: s.error ? (s.error === 'timeout' ? 'timeout' : 'error') : 'ok', status: s.status, ms: s.ms })),
    results: Object.fromEntries(steps.filter((s) => s.result).map((s) => [s.tool, s.result])),
    latency_ms: now() - started
  };
}
