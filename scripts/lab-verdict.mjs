// The last job of .github/workflows/lab.yml: reads the run's final
// lab-out/result.json (the pull job's copy for a code experiment, with the
// lab's own test run in code.tests) and exits 1 when the experiment did not
// end done or its tests failed, so a failed lab run shows red on GitHub and
// self-healing picks it up. Prints one line saying why. Reads files only:
// no network, no secret, no npm package: the job runs without npm install,
// so this file imports node: built-ins and lab-verdict-line.mjs only (see
// tests/lab-verdict-deps.test.mjs).

import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verdictLine } from './lab-verdict-line.mjs';

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

export function main(file = 'lab-out/result.json', log = console.log) {
  if (!existsSync(file)) {
    log(`[lab] no result file at ${file}: the experiment job wrote none or its artifact was not downloaded (see the experiment job's log)`);
    return 1;
  }
  let result = null;
  try {
    result = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    log(`[lab] the result file ${file} could not be read as JSON: ${String(e && e.message).slice(0, 160)}`);
    return 1;
  }
  const v = labVerdict(result);
  log(v.line);
  return v.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv[2]));
