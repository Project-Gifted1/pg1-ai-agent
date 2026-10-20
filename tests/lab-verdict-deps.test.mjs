/**
 * The lab's verdict job runs with no npm install (.github/workflows/lab.yml:
 * "no secret, no npm, no network"). On 20 Oct lab run c2cac715 (Actions run
 * 39430515185) crashed there with ERR_MODULE_NOT_FOUND for @x402/evm,
 * because scripts/lab-verdict.mjs imported verdictLine from lab-run.mjs,
 * which pulls in the lab runner and api/mcp.mjs.
 *
 *  - the static import graph of scripts/lab-verdict.mjs reaches node:
 *    built-ins and local files that import only node: built-ins, nothing
 *    else (and the same walk does catch the packages behind lab-run.mjs);
 *  - `node scripts/lab-verdict.mjs <file>` runs in a temp copy of just those
 *    files, with no node_modules: a passed result exits 0, a failed one 1,
 *    a missing result file 1 with a clear message;
 *  - the verdict job itself stays install-free: no npm, no secret, no
 *    network call.
 *
 * Run with: node --test tests/lab-verdict-deps.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'scripts/lab-verdict.mjs');
const ID = 'c2cac715-7b09-4c67-95ec-110d993d2770';

// Every module specifier in a file: static imports and re-exports
// (`import … from`, `import '…'`, `export … from`) and literal dynamic
// imports. Comments are stripped first, so a specifier named in a comment
// does not count.
function specifiers(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  const out = new Set();
  for (const re of [/\bimport\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g, /\bexport\s+[^'"`;]*?\s+from\s+['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (const m of code.matchAll(re)) out.add(m[1]);
  }
  return [...out];
}

// The graph from one entry: { files (absolute local paths, the entry
// first), offending ([{ spec, from }]) }. Allowed: node: built-ins, and
// relative local files (walked in turn). Anything else (a package, a bare
// built-in name without node:, an absolute path) is offending.
function importGraph(entry) {
  const files = [];
  const offending = [];
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    files.push(file);
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const next = path.resolve(path.dirname(file), spec);
        if (!existsSync(next)) { offending.push({ spec, from: path.relative(ROOT, file), why: 'missing file' }); continue; }
        visit(next);
        continue;
      }
      offending.push({ spec, from: path.relative(ROOT, file) });
    }
  };
  visit(entry);
  return { files, offending };
}

test('the import graph of scripts/lab-verdict.mjs is node: built-ins and dependency-free local files only', () => {
  const g = importGraph(ENTRY);
  assert.deepEqual(g.offending, [], `the verdict job runs without npm install, but these are reachable: ${JSON.stringify(g.offending)}`);
  assert.deepEqual(g.files.map((f) => path.relative(ROOT, f)).sort(), ['scripts/lab-verdict-line.mjs', 'scripts/lab-verdict.mjs']);
  // The walk itself: it does catch the packages behind lab-run.mjs (the
  // import that crashed run 39430515185).
  const runGraph = importGraph(path.join(ROOT, 'scripts/lab-run.mjs'));
  assert.ok(runGraph.offending.length > 0, 'lab-run.mjs reaches npm packages');
  assert.ok(runGraph.files.some((f) => f.endsWith(path.join('api', 'mcp.mjs'))) || runGraph.offending.some((o) => /^@x402\//.test(o.spec)), JSON.stringify(runGraph.offending.slice(0, 5)));
  // The specifier scan: static, re-export and dynamic forms; comments ignored.
  assert.deepEqual(specifiers(`import a from 'x';\nimport 'y';\nexport { b } from "z";\nconst c = await import('w');\n// import d from 'nope'\n/* import e from 'nope2' */`).sort(), ['w', 'x', 'y', 'z']);
});

test('lab-run.mjs still exports verdictLine (re-exported from the dependency-free file)', async () => {
  const run = await import('../scripts/lab-run.mjs');
  const line = await import('../scripts/lab-verdict-line.mjs');
  assert.equal(run.verdictLine, line.verdictLine);
  assert.equal(line.verdictLine({ id: ID, kind: 'skill', status: 'failed', error: 'build: model call failed', spent_usd: 0 }), '[lab] id=c2cac715 kind=skill status=failed stage=build error=model call failed spent_usd=0');
});

test('node scripts/lab-verdict.mjs runs in a temp copy of just its files with no node_modules: passed 0, failed 1, missing file 1', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lab-verdict-'));
  for (const f of importGraph(ENTRY).files) {
    const rel = path.relative(ROOT, f);
    mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), readFileSync(f));
  }
  assert.equal(existsSync(path.join(dir, 'node_modules')), false);
  assert.equal(existsSync(path.join(dir, 'package.json')), false);
  const run = (file) => spawnSync(process.execPath, ['scripts/lab-verdict.mjs', file], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
  const write = (name, obj) => { writeFileSync(path.join(dir, name), JSON.stringify(obj)); return name; };

  const passed = run(write('passed.json', { id: ID, kind: 'research', status: 'done', spent_usd: 0.12 }));
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.stdout.trim(), '[lab] id=c2cac715 kind=research status=done spent_usd=0.12');

  const failed = run(write('failed.json', { id: ID, kind: 'skill', status: 'failed', error: 'build: model call failed (anthropic 400 out of credit)', spent_usd: 0 }));
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stdout, /^\[lab\] id=c2cac715 kind=skill status=failed stage=build error=model call failed \(anthropic 400 out of credit\) spent_usd=0$/m);

  const tests = run(write('tests.json', { id: ID, kind: 'code', status: 'done', code: { tests: { passed: false, summary: '# fail 1\nnot ok 3 - x' } } }));
  assert.equal(tests.status, 1);
  assert.match(tests.stdout, /stage=test error=the lab's test run failed/);

  const missing = run('lab-out/result.json');
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /^\[lab\] no result file at lab-out\/result\.json: the experiment job wrote none/m);

  writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  const broken = run('broken.json');
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /could not be read as JSON/);

  for (const r of [passed, failed, tests, missing, broken]) assert.doesNotMatch(r.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/);
});

test('lab.yml: the verdict job stays install-free (no npm, no secret, no network)', () => {
  const yml = readFileSync(path.join(ROOT, '.github/workflows/lab.yml'), 'utf8');
  const start = yml.indexOf('\n  verdict:');
  const rest = yml.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][\w-]*:\n/);
  // The job's steps, without its comment lines (they say "no npm").
  const job = (next >= 0 ? rest.slice(0, next) : rest).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.match(job, /run: node scripts\/lab-verdict\.mjs lab-out\/result\.json/);
  assert.doesNotMatch(job, /\bnpm\b|\byarn\b|\bpnpm\b/, 'no package install');
  assert.doesNotMatch(job, /secrets\./, 'no secret');
  assert.doesNotMatch(job, /\bcurl\b|\bwget\b|fetch\(/, 'no network call');
  assert.doesNotMatch(job, /cache:\s*npm/, 'no npm cache either');
});
