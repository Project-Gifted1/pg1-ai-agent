// "Next step" after a lab experiment stopped: what will be different on a
// retry, or that a retry would fail the same way and why. Read from what
// the runner recorded (result.stages.<stage>.failure, the build calls, the
// error), never a generic "start it again". Pure.
//
//   labNextStep(exp) -> one or two sentences

import { labPaidOff } from './policy.mjs';

const has = (re, s) => re.test(String(s || ''));

export function labNextStep(exp, { env = {} } = {}) {
  const e = exp || {};
  const r = e.result || {};
  const st = r.stages || {};
  const build = st.build || {};
  const err = String(e.error || r.error || '');
  if (e.status === 'done') return e.candidate ? 'Read the report; it passed the gate, so /lab status brings up the approval card.' : 'Read the report.';
  if (e.status === 'stopped') return 'Nothing more to do unless you start it again.';
  if (e.status === 'over_budget') return 'A retry would stop at the same point: the next call could cost more than the signed budget. Start it with a larger budget, or narrow the goal so it needs fewer calls.';
  if (e.status === 'timeout') return 'A retry gets the same time limit (PG1_LAB_MAX_MINUTES); it can finish if the engines answer faster, otherwise narrow the goal.';
  const paidBuild = String(build.paid_build || '');
  switch (build.failure) {
    case 'truncated':
    case 'no_json':
      return paidBuild.startsWith('on')
        ? 'The free engines and the paid build step all failed to return complete JSON. A retry asks them again and may fail the same way; narrow the goal to one file and function so the reply is shorter.'
        : `A retry is worth it: the build now retries once on the next free engine with the format said again, so a reply that was ${build.failure === 'truncated' ? 'cut off' : 'not JSON'} gets a second chance. If it fails the same way, set PG1_LAB_PAID_BUILD=on to let the build step use the confirmed budget.`;
    case 'empty_edits':
      return 'A retry would likely fail the same way: the model found nothing to change. Check whether the behaviour is already correct (the spec check), or name the file and function the change belongs in.';
    case 'no_match':
    case 'multiple_match':
      return `A retry asks again with the same code context, so it can fail the same way: the model's search text ${build.failure === 'no_match' ? 'was not in the file' : 'matched more than once'}. Name the function to change in the goal, so the context holds exactly that code.`;
    case 'refused_path':
      return 'A retry would fail the same way: the change belongs in a path the lab may not change (workflows, package files, secrets, the autonomy policy, the lab). Make that change by hand, or rephrase the goal so it stays in lib/, api/, tests/, docs/ or scripts/.';
    case 'too_large':
      return 'A retry would fail the same way: the change is over the size limit. Split the goal into smaller changes.';
    case 'no_test':
      return 'A retry asks again; the model must add a test under tests/. Say which behaviour the test should check in the goal.';
    case 'bad_fields':
      return 'A retry asks again and the model may give complete fields; if it fails the same way, narrow the goal.';
    case 'engine':
      return labPaidOff(env) ? 'A retry works once a free engine has quota again (free quotas reset daily); nothing else changes.' : 'A retry works once an engine answers again; nothing else changes.';
    default: break;
  }
  if (has(/out of credit|spending cap|key not accepted/i, err)) return 'A retry would fail the same way until the engine\'s credit, cap or key is fixed: nothing in the lab changes that.';
  if (has(/rate limited|engine unavailable|free engines|no free engine/i, err)) return 'A retry works once the engines have quota again (free quotas reset daily); nothing else changes.';
  if (has(/^research: /, err)) return 'A retry asks the research step again; an empty answer can repeat on the same engine. Add a page or two with "urls" to ground it.';
  if (has(/^gate: /, err)) return 'A retry would not help: the gate checks the result, not the run. Read which check failed in the report.';
  if (has(/test/i, err)) return 'A retry would fail the same way unless the change does: read the failing tests in the report.';
  return 'Read the report for the reason; a retry runs the same steps and can fail the same way.';
}
