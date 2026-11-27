// pg1-guard: every tool call an agent makes is checked before it runs.
//
//   import { createGuard } from 'pg1-guard';
//   const guard = createGuard({ policy, approve });
//   const send = guard.wrap('send_payment', realSendPayment);
//   await send({ to: 'IE29…', amount: 40 });   // waits for approve(), then runs
//
// Allowed calls run straight away. Calls that need a person go to
// approve(action) — your approval card, chat prompt or phone push — and
// run only on a yes. Blocked calls never run: wrap() throws GuardBlocked
// with the reasons, so the agent can tell the user why. No approver set
// means nothing that needs approval runs (fail closed). Every step is in
// guard.log.
//
// Optional: pass a pg1-sdk PG1Client as `pg1` and money or install
// actions also get PG1's preflight check first (a flagged or unknown
// result turns the call into an approval, never an automatic yes).

import { resolvePolicy, evaluate, record, newState } from './policy.mjs';
import { createLog } from './log.mjs';

export { resolvePolicy, evaluate, findSecrets, findUrls, findAmount, redact, globMatch, loadDefaultPolicy } from './policy.mjs';
export { createLog, jsonlSink } from './log.mjs';

export class GuardBlocked extends Error {
  constructor(decision) {
    super(`blocked: ${decision.reasons.map((r) => r.detail).join('; ')}`);
    this.name = 'GuardBlocked';
    this.code = decision.decision === 'ask' ? 'not_approved' : 'blocked';
    this.decision = decision;
  }
}

let seq = 0;
const newId = () => `act_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function createGuard({ policy = {}, approve = null, log = createLog(), pg1 = null, preflightFor = defaultPreflightFor, clock = () => Date.now() } = {}) {
  const resolved = resolvePolicy(policy);
  const state = newState();

  async function check(tool, args = {}, meta = {}) {
    const action = { id: meta.id || newId(), tool: String(tool), args: args && typeof args === 'object' ? args : {}, agent: meta.agent || null };
    log.write('proposed', action);
    let decision = evaluate(resolved, action, state, clock());
    // PG1's preflight check for money and installs, when a client is given.
    if (pg1 && decision.decision !== 'block') {
      const pf = preflightFor(action, decision);
      if (pf) {
        try {
          const r = await pg1.preflight(pf.kind, pf.subject, pf.options || {});
          const verdict = r && r.result && r.result.decision;
          const verified = !r.verified || r.verified.valid;
          log.write('pg1_check', action, { pg1: { decision: verdict || 'unknown', verified } });
          if (verdict !== 'no_flags' || !verified) decision = { ...decision, decision: 'ask', reasons: [...(decision.decision === 'ask' ? decision.reasons : []), { rule: 'pg1.preflight', detail: `PG1's check returned ${verdict || 'no result'}${verified ? '' : ' (signature did not verify)'}` }] };
        } catch (e) {
          log.write('pg1_check', action, { pg1: { decision: 'unknown', error: String(e && e.message || e).slice(0, 200) } });
          decision = { ...decision, decision: 'ask', reasons: [...(decision.decision === 'ask' ? decision.reasons : []), { rule: 'pg1.preflight', detail: 'PG1\'s check could not run' }] };
        }
      }
    }
    log.write('decided', action, { decision: decision.decision, reasons: decision.reasons });
    if (decision.decision === 'ask') {
      let yes = false;
      if (typeof approve === 'function') {
        try { yes = (await approve({ ...action, reasons: decision.reasons, money: decision.money })) === true; } catch { yes = false; }
      }
      log.write(yes ? 'approved' : 'declined', action, approve ? {} : { note: 'no approver configured' });
      if (!yes) return { action, decision: { ...decision, decision: 'block', reasons: [...decision.reasons, { rule: 'approval', detail: approve ? 'a person declined it' : 'it needs approval and no approver is set up' }] }, approved: false };
      return { action, decision, approved: true };
    }
    return { action, decision, approved: decision.decision === 'allow' };
  }

  function wrap(tool, fn, meta = {}) {
    return async function guarded(args = {}, ...rest) {
      const { action, decision, approved } = await check(tool, args, meta);
      if (!approved) throw new GuardBlocked(decision);
      try {
        const out = await fn(args, ...rest);
        record(state, action, decision, clock());
        log.write('ran', action);
        return out;
      } catch (e) {
        record(state, action, null, clock());
        log.write('failed', action, { error: String(e && e.message || e).slice(0, 300) });
        throw e;
      }
    };
  }

  // Wraps every function in an object of tools ({ name: fn }).
  function wrapAll(tools, meta = {}) {
    return Object.fromEntries(Object.entries(tools).map(([name, fn]) => [name, typeof fn === 'function' ? wrap(name, fn, meta) : fn]));
  }

  return { check, wrap, wrapAll, log, policy: resolved };
}

// Which actions get PG1's preflight check: money moves to an address and
// package installs. Returns { kind, subject, options } or null.
export function defaultPreflightFor(action, decision) {
  const a = action.args || {};
  const to = a.to || a.address || a.recipient || a.destination;
  if (decision.money && typeof to === 'string' && /^0x[0-9a-fA-F]{40}$/.test(to)) return { kind: 'pay', subject: to, options: a.chain ? { chain: a.chain } : {} };
  if (/install/i.test(action.tool) && typeof (a.package || a.name) === 'string') return { kind: 'install', subject: a.package || a.name, options: a.ecosystem ? { ecosystem: a.ecosystem } : {} };
  return null;
}
