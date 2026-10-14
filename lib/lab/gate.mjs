// The promotion gate. A lab candidate reaches the operator's approval card
// only after passing all four checks, and the card shows the evidence:
//
//   evals    a skill: every eval passed in the lab (each trait judged);
//            code: CI on the draft PR's head is green (the Tests
//            workflow's "npm test" must be among the checks; none = fail)
//   safety   a skill: checkSkill again (secrets, injection, the tool
//            allowlist, no code); code: every changed path allowed and no
//            secret in the PR's title or summary
//   licence  every NEW data source cites resale terms (a licence and an
//            https terms URL); "unverified" is a failure
//   cost     when the candidate is priced: price >= 1.5x worst-case cost
//            (lib/pricing.mjs)
//
// Pure: the caller passes the lab result and the CI state.

import { checkSkill } from '../skills/skill.mjs';
import { checkCodePath } from './policy.mjs';
import { priceCoversCost, MIN_PRICE_MULTIPLIER } from '../pricing.mjs';

export const GATE_CHECKS = Object.freeze(['evals', 'safety', 'licence', 'cost']);

function licenceCheck(sources) {
  const list = Array.isArray(sources) ? sources : [];
  if (!list.length) return { name: 'licence', ok: true, evidence: 'no new data sources' };
  const bad = list.filter((s) => !s || !s.licence || s.licence === 'unverified' || !/^https:\/\//i.test(String(s.resale_terms_url || '')));
  return bad.length
    ? { name: 'licence', ok: false, evidence: `${bad.length} source${bad.length === 1 ? '' : 's'} without cited resale terms: ${bad.slice(0, 3).map((s) => (s && s.url) || '?').join(', ')}` }
    : { name: 'licence', ok: true, evidence: list.map((s) => `${s.url}: ${s.licence} (${s.resale_terms_url})`).join('; ') };
}

function costCheck(pricing) {
  if (!pricing) return { name: 'cost', ok: true, evidence: 'not priced (nothing is sold)' };
  const ok = priceCoversCost(pricing.price_usd, pricing.worst_case_cost_usd);
  return { name: 'cost', ok, evidence: `price $${pricing.price_usd} vs worst-case cost $${pricing.worst_case_cost_usd} (needs >= ${MIN_PRICE_MULTIPLIER}x)` };
}

// candidate: { type: 'skill'|'code'|'tool', skill?, sources?, pricing? }
// result: the lab result; ci: { state, checks } for code.
export function evaluateGate({ candidate, result = {}, ci = null, guard = null }) {
  const checks = [];
  if (!candidate || !candidate.type) return { pass: false, checks: [{ name: 'candidate', ok: false, evidence: 'nothing to promote (findings only)' }] };
  if (candidate.type === 'skill') {
    const evals = Array.isArray(result.evals) ? result.evals : [];
    const passed = evals.filter((e) => e.pass).length;
    checks.push({ name: 'evals', ok: evals.length > 0 && passed === evals.length, evidence: evals.length ? `${passed} of ${evals.length} evals passed: ${evals.map((e) => `${e.pass ? 'PASS' : 'FAIL'} "${String(e.prompt).slice(0, 60)}"`).join('; ')}` : 'no eval results' });
    try {
      checkSkill(candidate.skill, { guard });
      checks.push({ name: 'safety', ok: true, evidence: 'no secrets, no override phrasing, no code, tools within the allowlist' });
    } catch (e) {
      checks.push({ name: 'safety', ok: false, evidence: e.message });
    }
  } else if (candidate.type === 'code' || candidate.type === 'tool') {
    const state = ci && ci.state;
    const noCi = !state || state === 'none' ? ' (the Tests workflow has not run on the PR head; a PR opened with the built-in GITHUB_TOKEN does not start it: close and reopen the draft PR, or push a commit to its branch, yourself)' : '';
    checks.push({ name: 'evals', ok: state === 'success', evidence: `CI ${state || 'not found'}${noCi}${ci && ci.checks && ci.checks.length ? `: ${ci.checks.map((c) => `${c.name} ${c.conclusion || c.status}`).join(', ')}` : ''}` });
    const files = (result.code && result.code.files) || candidate.files || [];
    const badPaths = files.filter((p) => !checkCodePath(p).ok);
    const text = `${(result.code && result.code.title) || ''}\n${(result.code && result.code.summary) || ''}`;
    const leaked = guard ? (guard(text).removed || []).length > 0 : false;
    checks.push({ name: 'safety', ok: !badPaths.length && !leaked && files.length > 0, evidence: badPaths.length ? `blocked paths: ${badPaths.join(', ')}` : leaked ? 'the PR text contains something secret-shaped' : `${files.length} file${files.length === 1 ? '' : 's'}, all in allowed paths` });
  } else {
    checks.push({ name: 'evals', ok: false, evidence: `unknown candidate type ${candidate.type}` });
  }
  checks.push(licenceCheck(candidate.sources));
  checks.push(costCheck(candidate.pricing));
  return { pass: checks.every((c) => c.ok), checks };
}

export function gateEvidenceText(gate) {
  return (gate.checks || []).map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.evidence}`).join('\n');
}
