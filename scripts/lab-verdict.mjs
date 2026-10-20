// The last job of .github/workflows/lab.yml: reads the run's final
// lab-out/result.json (the pull job's copy for a code experiment, with the
// lab's own test run in code.tests) and exits 1 when the experiment did not
// end done or its tests failed, so a failed lab run shows red on GitHub and
// self-healing picks it up. Prints one line saying why. Reads files only:
// no network, no secret, and no npm package: the verdict job runs without
// npm install, so this file imports node: built-ins only (20 Oct, self-heal
// #352: it imported lab-run.mjs, which loads the lab runner and @x402/evm,
// and failed with ERR_MODULE_NOT_FOUND).

import { readFileSync } from 'node:fs';

// "[lab] id=aef41455 status=failed stage=build error=..." (and the kind).
export function verdictLine(r) {
  const e = r || {};
  const m = /^(research|build|test|gate): ([\s\S]*)$/.exec(String(e.error || ''));
  return `[lab] id=${String(e.id || '').slice(0, 8)} kind=${e.kind || '-'} status=${e.status || 'unknown'}${e.status === 'done' ? '' : ` stage=${m ? m[1] : '-'} error=${String(m ? m[2] : e.error || '-').replace(/\s+/g, ' ').slice(0, 300)}`} spent_usd=${Number(e.spent_usd) || 0}`;
}

// { ok, line } for one result object (null: the run uploaded none).
export function labVerdict(result) {
  if (!result || typeof result !== 'object') return { ok: false, line: '[lab] no result.json: the experiment job wrote nothing (see its log)' };
  if (result.status !== 'done') return { ok: false, line: verdictLine(result) };
  const tests = result.code && result.code.tests;
  if (result.kind === 'code' && tests && tests.passed === false) {
    const failing = String(tests.summary || '').split('\n').filter((l) => /^not ok|^# fail/.test(l)).slice(0, 3).join(' | ');
    return { ok: false, line: `[lab] id=${String(result.id || '').slice(0, 8)} kind=code status=done stage=test error=the lab's test run failed${failing ? `: ${failing.slice(0, 240)}` : ''}` };
  }
  return { ok: true, line: verdictLine(result) };
}

export function main(file = 'lab-out/result.json') {
  let result = null;
  try { result = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { result = null; }
  const v = labVerdict(result);
  console.log(v.line);
  return v.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv[2]));
