// Job 1 of .github/workflows/lab.yml: runs one experiment with the lab's
// model keys and writes lab-out/result.json (and lab-out/patch.json for a
// code experiment). Refuses to run unless the dispatch token verifies
// against PG1_LAB_DISPATCH_SECRET for exactly this id, kind, budget, goal
// and input. The budget comes from the signed dispatch and is capped at
// PG1_LAB_BUDGET_USD's hard ceiling; the time limit is PG1_LAB_MAX_MINUTES.

import { mkdirSync, writeFileSync } from 'node:fs';
import { runExperiment } from '../lib/lab/runner.mjs';
import { verifyLabToken } from '../lib/lab/token.mjs';
import { LAB_KINDS, labMaxMinutes } from '../lib/lab/policy.mjs';
// The run's one log line; it lives in lab-verdict.mjs, which must load with
// no npm packages (the verdict job installs none).
import { verdictLine } from './lab-verdict.mjs';
export { verdictLine };

const HARD_BUDGET_CEILING_USD = 10;

export async function main(env = process.env, { fetchImpl = globalThis.fetch, out = 'lab-out' } = {}) {
  const id = String(env.LAB_ID || '');
  const kind = String(env.LAB_KIND || '');
  const goal = String(env.LAB_GOAL || '').slice(0, 2000);
  const inputRaw = String(env.LAB_INPUT || '');
  const budgetUsd = Number(env.LAB_BUDGET_USD);
  mkdirSync(out, { recursive: true });
  const write = (r) => writeFileSync(`${out}/result.json`, JSON.stringify(r, null, 2));
  if (!/^[0-9a-f-]{36}$/.test(id) || !LAB_KINDS.includes(kind) || !(budgetUsd > 0 && budgetUsd <= HARD_BUDGET_CEILING_USD)) {
    write({ id, kind, status: 'failed', error: 'invalid dispatch' });
    return 1;
  }
  const v = verifyLabToken(env.LAB_TOKEN, { id, kind, budgetUsd, goal, input: inputRaw, secret: env.PG1_LAB_DISPATCH_SECRET });
  if (!v.ok) {
    write({ id, kind, status: 'failed', error: `dispatch token ${v.reason}` });
    return 1;
  }
  let input = {};
  try { input = inputRaw ? JSON.parse(Buffer.from(inputRaw, 'base64').toString('utf8')) : {}; } catch (e) { input = {}; }
  const result = await runExperiment({ id, kind, goal, input, env, budgetUsd, maxMinutes: labMaxMinutes(env), fetchImpl });
  const { patch, ...rest } = result;
  if (patch) writeFileSync(`${out}/patch.json`, JSON.stringify(patch));
  write(rest);
  // One line in the run log: the status and, for a run that did not end
  // done, the stage and the reason (operator-only: the run log is on GitHub).
  console.log(verdictLine(rest));
  // A run that did not end done fails the job, so the workflow run shows
  // red and self-healing picks it up (until 20 Oct this returned 0 either
  // way and every failed experiment ran green).
  return result.status === 'done' ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (e) => { console.error('lab run failed', e && e.message); process.exit(1); });
}
