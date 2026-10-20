// The one log line a lab run ends with, shared by the experiment job
// (scripts/lab-run.mjs) and the verdict job (scripts/lab-verdict.mjs).
//
// DEPENDENCY-FREE ON PURPOSE: the verdict job in .github/workflows/lab.yml
// runs with no npm install ("no secret, no npm, no network"), so this file
// and lab-verdict.mjs import node: built-ins only. On 20 Oct lab run
// c2cac715 (Actions run 39430515185) failed in that job with
// ERR_MODULE_NOT_FOUND for @x402/evm: lab-verdict.mjs imported this
// function from lab-run.mjs, which loads the lab runner and, through it,
// api/mcp.mjs. tests/lab-verdict-deps.test.mjs walks the import graph.

// "[lab] id=aef41455 kind=skill status=failed stage=build error=... spent_usd=0"
export function verdictLine(r) {
  const e = r || {};
  const m = /^(research|build|test|gate): ([\s\S]*)$/.exec(String(e.error || ''));
  return `[lab] id=${String(e.id || '').slice(0, 8)} kind=${e.kind || '-'} status=${e.status || 'unknown'}${e.status === 'done' ? '' : ` stage=${m ? m[1] : '-'} error=${String(m ? m[2] : e.error || '-').replace(/\s+/g, ' ').slice(0, 300)}`} spent_usd=${Number(e.spent_usd) || 0}`;
}
