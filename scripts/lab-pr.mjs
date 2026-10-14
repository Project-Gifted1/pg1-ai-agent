// Job 3 of .github/workflows/lab.yml: on a FRESH checkout (no code from
// the experiment ever ran in this job), commits a code experiment's files
// to branch lab/<id>, pushes it with PG1_LAB_GITHUB_TOKEN and opens a DRAFT
// pull request. Nothing else: it never merges, never approves, never
// touches another branch. Paths are checked again here. The PR is opened
// only when the lab's own test run passed; the repository's CI then runs on
// the PR and is the evidence the promotion gate reads. With the built-in
// token (PG1_LAB_PR_TOKEN=builtin) GitHub starts no workflow for the push or
// the PR, so the body tells the operator how to start CI; until then the
// gate finds no "npm test" check and fails closed.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { applyPatch } from './lab-apply.mjs';

export async function openDraftPr({ env = process.env, dir = 'lab-out', fetchImpl = globalThis.fetch, git = (args) => execFileSync('git', args, { stdio: 'pipe' }).toString() } = {}) {
  const result = JSON.parse(readFileSync(`${dir}/result.json`, 'utf8'));
  const patch = JSON.parse(readFileSync(`${dir}/patch.json`, 'utf8'));
  let tests = { passed: false, summary: 'no test result' };
  try { tests = JSON.parse(readFileSync(`${dir}/test.json`, 'utf8')); } catch (e) { /* stays failed */ }
  result.code = { ...(result.code || {}), tests };
  const save = () => writeFileSync(`${dir}/result.json`, JSON.stringify(result, null, 2));
  if (!tests.passed) { save(); return { opened: false, reason: 'tests failed' }; }
  const token = String(env.PG1_LAB_GITHUB_TOKEN || '').trim();
  const repo = String(env.GITHUB_REPOSITORY || '');
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) { save(); return { opened: false, reason: 'not configured' }; }
  const branch = `lab/${String(result.id).slice(0, 8)}`;
  if (!/^lab\/[0-9a-f]{8}$/.test(branch)) throw new Error('bad branch');
  applyPatch(patch);
  git(['checkout', '-b', branch]);
  git(['add', '--', ...patch.map((f) => f.path)]);
  git(['-c', 'user.name=PG1 lab', '-c', 'user.email=pg1-lab@users.noreply.github.com', 'commit', '-m', String(result.code.title || `lab ${branch}`).slice(0, 100)]);
  git(['push', `https://x-access-token:${token}@github.com/${repo}.git`, `HEAD:refs/heads/${branch}`]);
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/pulls`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'PG1-lab' },
    body: JSON.stringify({
      title: String(result.code.title || branch).slice(0, 120), head: branch, base: env.LAB_BASE || 'main', draft: true,
      body: `Draft opened by the PG1 lab, experiment \`${result.id}\`. **PG1 never merges lab pull requests**: the operator reviews and decides.\n\n**Goal:** ${String(result.goal || '').slice(0, 500)}\n\n**Summary:** ${String(result.code.summary || '').slice(0, 2000)}\n\nLab test run: passed.\n\n${env.PG1_LAB_PR_TOKEN === 'builtin' ? '**CI has not started:** this PR was opened with the built-in GITHUB_TOKEN, which never triggers workflows. Close and reopen it (or push a commit) to run Tests; the promotion gate waits for the \`npm test\` check.\n\n' : ''}\`\`\`\n${String(tests.summary || '').slice(-1500)}\n\`\`\``
    })
  });
  const pr = await res.json().catch(() => ({}));
  if (res.ok && pr.html_url) result.code = { ...result.code, pr_url: pr.html_url, pr_number: pr.number, head_sha: pr.head && pr.head.sha };
  else result.code = { ...result.code, pr_error: `GitHub ${res.status}` };
  save();
  return { opened: !!(res.ok && pr.html_url), url: pr.html_url };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  openDraftPr().then((r) => console.log(r.opened ? `draft PR: ${r.url}` : `no PR: ${r.reason}`), (e) => { console.error('lab PR failed', e && e.message); process.exit(1); });
}
