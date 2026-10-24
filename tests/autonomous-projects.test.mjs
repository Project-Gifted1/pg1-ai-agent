/**
 * Projects (lib/autonomous/projects.mjs): /mission add project "<goal>";
 * PG1 researches it, builds it as a draft pull request, waits for CI,
 * fixes failures (at most twice), and asks for review once, at the end.
 * Free engines only; it writes only new files under lib/projects/,
 * tests/projects/ and docs/projects/; never merges or deploys.
 *
 * GitHub and the engines are mocked here.
 * Run with: node --test tests/autonomous-projects.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProjectStep, projectFiles, projectSlug, PROJECT_FIX_ROUNDS } from '../lib/autonomous/projects.mjs';
import { parseMissionCommand } from '../lib/autonomous/missions.mjs';
import { ACTION_TYPES } from '../lib/autonomous/state.mjs';

const BRIEF = JSON.stringify({ title: 'Roman numerals', summary: 'Convert numbers to Roman numerals and back.', approach: 'Two pure functions.', risks: 'None.', files: [{ name: 'roman.mjs', purpose: 'the conversions' }], tests: 'round trips' });
const BUILD = JSON.stringify({ files: [{ name: 'roman.mjs', content: 'export const toRoman = (n) => "I".repeat(n);\n' }], test: { content: 'import { test } from "node:test";\n' }, doc: '# Roman numerals\n' });
const FIX = JSON.stringify({ files: [{ name: 'roman.mjs', content: 'export const toRoman = (n) => n === 4 ? "IV" : "I".repeat(n);\n' }], test: null, why: 'four' });

function fakeGithub({ ci = ['success'] } = {}) {
  const calls = []; let ciIndex = 0; const files = new Map();
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(String(url)); const path = u.pathname; const method = opts.method || 'GET';
    calls.push(`${method} ${path}`);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === '/repos/Project-Gifted1/pg1-ai-agent' && method === 'GET') return json({ default_branch: 'main' });
    if (path.endsWith('/git/ref/heads/main')) return json({ object: { sha: 'base' } });
    if (path.endsWith('/git/refs') && method === 'POST') return json({ ref: JSON.parse(opts.body).ref });
    if (path.includes('/contents/') && method === 'PUT') { const p = decodeURIComponent(path.split('/contents/')[1]); files.set(p, Buffer.from(JSON.parse(opts.body).content, 'base64').toString()); return json({ commit: { sha: `sha${files.size}-${calls.length}` } }); }
    if (path.includes('/contents/') && method === 'GET') { const p = decodeURIComponent(path.split('/contents/')[1]); return files.has(p) ? json({ sha: 'f', content: Buffer.from(files.get(p)).toString('base64') }) : json({ message: 'Not Found' }, 404); }
    if (path.endsWith('/pulls') && method === 'POST') { const b = JSON.parse(opts.body); assert.equal(b.draft, true, 'always a draft'); return json({ number: 77, html_url: 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/77' }); }
    if (path.includes('/check-runs')) { const c = ci[Math.min(ciIndex++, ci.length - 1)]; return json({ check_runs: c === 'pending' ? [{ name: 'npm test', status: 'in_progress' }] : [{ name: 'npm test', status: 'completed', conclusion: c, output: { summary: c === 'failure' ? 'AssertionError: toRoman(4) should be IV' : 'ok' } }] }); }
    if (/merge|deploy/.test(path)) throw new Error('never merges or deploys');
    return json({ message: 'unexpected' }, 500);
  };
  return { fetchImpl, calls, files };
}

async function drive(mission, { gh, replies, maxTicks = 12 }) {
  const results = [];
  let m = { ...mission };
  for (let i = 0; i < maxTicks; i++) {
    const out = await runProjectStep(m, { env: { GITHUB_TOKEN: 'gh-test' }, fetchImpl: gh.fetchImpl, textFn: async () => ({ ok: true, text: replies.shift() || '{}' }), update: async (patch) => { m = { ...m, ...patch }; }, now: () => Date.parse('2026-10-24T12:00:00Z') + i * 600000 });
    results.push(out);
    if (m.stage === 'done' || m.stage === 'failed') break;
  }
  return { m, results };
}

test('/mission add project "<goal>" makes a project mission, run by its own action type', () => {
  assert.deepEqual(parseMissionCommand('/mission add project "a Roman numeral converter"'), { sub: 'add', kind: 'project', goal: 'a Roman numeral converter', schedule: '' });
  assert.ok(ACTION_TYPES.project_work);
});

test('research, build (a draft PR), tests pass: one approval card at the end, and no notice before it', async () => {
  const gh = fakeGithub({ ci: ['pending', 'success'] });
  const { m, results } = await drive({ id: 'abc123', goal: 'a Roman numeral converter', stage: 'research', project: {} }, { gh, replies: [BRIEF, BUILD] });
  assert.equal(m.stage, 'done');
  assert.deepEqual(results.map((r) => !!r.needsApproval), [false, false, false, false, true], 'asks once, at the end');
  assert.deepEqual(results.map((r) => !!r.alert), [false, false, false, false, true], 'notifies once, at the end');
  const last = results.at(-1);
  assert.equal(last.needsApproval.kind, 'project_review');
  assert.match(last.result, /tests passed/);
  assert.equal(last.link, 'https://github.com/Project-Gifted1/pg1-ai-agent/pull/77');
  const slug = projectSlug('a Roman numeral converter', 'abc123');
  assert.deepEqual([...gh.files.keys()].sort(), [`docs/projects/${slug}.md`, `lib/projects/${slug}/roman.mjs`, `tests/projects/${slug}.test.mjs`].sort());
  assert.ok(!gh.calls.some((c) => /merge/.test(c)), 'never merges');
});

test('a failing test is fixed and tested again; after the fix rounds it goes to review saying so', async () => {
  const gh = fakeGithub({ ci: ['failure', 'success'] });
  const ok = await drive({ id: 'fix111', goal: 'roman numerals', stage: 'research', project: {} }, { gh, replies: [BRIEF, BUILD, FIX] });
  assert.equal(ok.m.project.fixes, 1);
  assert.equal(ok.m.project.tests, 'passed');
  assert.match([...gh.files.values()].join('\n'), /IV/, 'the fix was committed');
  const gh2 = fakeGithub({ ci: ['failure'] });
  const bad = await drive({ id: 'fail22', goal: 'roman numerals', stage: 'research', project: {} }, { gh: gh2, replies: [BRIEF, BUILD, FIX, FIX], maxTicks: 20 });
  assert.equal(bad.m.project.fixes, PROJECT_FIX_ROUNDS);
  assert.match(bad.m.project.tests, /failing after 2 fixes/);
  assert.equal(bad.results.at(-1).needsApproval.kind, 'project_review');
});

test('it writes only new project files, with no network, child processes, environment or eval', () => {
  const slug = 'x-1';
  assert.ok(projectFiles(slug, JSON.parse(BUILD)).files);
  assert.match(projectFiles(slug, { files: [{ name: '../../api/chat.mjs', content: 'x' }], test: { content: 't' } }).error, /not usable/);
  assert.match(projectFiles(slug, { files: [{ name: 'a.mjs', content: 'await fetch("https://x")' }], test: { content: 't' } }).error, /network/);
  assert.match(projectFiles(slug, { files: [{ name: 'a.mjs', content: 'process.env.KEY' }], test: { content: 't' } }).error, /environment/);
  assert.match(projectFiles(slug, { files: [{ name: 'a.mjs', content: 'x' }] }).error, /no test file/);
});

test('a refusal stops the project and is not retried; no free engine means it waits for the next tick', async () => {
  const gh = fakeGithub();
  let m = { id: 'r1', goal: 'x', stage: 'research', project: {} };
  const refused = await runProjectStep(m, { env: {}, fetchImpl: gh.fetchImpl, textFn: async () => ({ ok: false, refused: true }), update: async (p) => { m = { ...m, ...p }; } });
  assert.equal(refused.refused, true);
  assert.equal(m.stage, 'failed');
  let m2 = { id: 'r2', goal: 'x', stage: 'research', project: {} };
  const waiting = await runProjectStep(m2, { env: {}, fetchImpl: gh.fetchImpl, textFn: async () => ({ ok: false, reason: 'quota' }), update: async (p) => { m2 = { ...m2, ...p }; } });
  assert.match(waiting.result, /waits for the next tick/);
  assert.equal(m2.stage, 'research');
});
