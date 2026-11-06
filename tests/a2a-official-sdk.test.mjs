/**
 * The official A2A Python SDK (a2a-sdk on PyPI) against /api/a2a, for both
 * protocol versions (the A2A Registry probe uses the official SDK; on 6 Nov
 * 2026 it failed with PARSE because SendMessage returned a bare Task on 1.0).
 *
 * The real handler is served locally (tests/helpers/a2a-local-server.mjs)
 * and tests/sdk/official_a2a_client.py drives it with the SDK's own card
 * resolver, ClientFactory and transports (1.0 JsonRpcTransport, 0.3
 * CompatJsonRpcTransport): a plain text message, a paid skill without
 * payment (an input-required task with the x402 PaymentRequired), GetTask
 * on an unknown id (TaskNotFoundError), and an unknown skill.
 *
 * Python: $A2A_SDK_PYTHON if set, else a python3 that already has a2a-sdk,
 * else a2a-sdk==1.3.0 is installed into a cached venv in the OS temp dir.
 * The test is skipped (and says why) only if the package cannot be installed;
 * every skip reason starts with "a2a-sdk" (CI fails on such a skip).
 * Run with: node --test tests/a2a-official-sdk.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = path.join(ROOT, 'tests/sdk/official_a2a_client.py');
const SDK_SPEC = 'a2a-sdk==1.3.0';
const ORIGINAL_ENV = { ...process.env };

function hasSdk(python) {
  const r = spawnSync(python, ['-I', '-c', 'import a2a.client, httpx, google.protobuf'], { encoding: 'utf8', timeout: 60000 });
  return r.status === 0;
}

// A python with a2a-sdk, or { skip: reason }.
function resolvePython() {
  if (process.env.A2A_SDK_PYTHON) {
    return hasSdk(process.env.A2A_SDK_PYTHON) ? { python: process.env.A2A_SDK_PYTHON } : { skip: `a2a-sdk cannot be imported by A2A_SDK_PYTHON=${process.env.A2A_SDK_PYTHON}` };
  }
  if (hasSdk('python3')) return { python: 'python3' };
  const venv = path.join(os.tmpdir(), 'pg1-a2a-sdk-1.3.0');
  const venvPython = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (fs.existsSync(venvPython) && hasSdk(venvPython)) return { python: venvPython };
  // Under the CI network guard nothing is downloaded mid-test: the workflow
  // installs a2a-sdk first and passes it in A2A_SDK_PYTHON.
  if (process.env.PG1_NET_GUARD_LOG || /no-network\.mjs/.test(process.env.NODE_OPTIONS || '')) {
    return { skip: `${SDK_SPEC} is not installed and the network is blocked here (set A2A_SDK_PYTHON to a python that has it)` };
  }
  const mk = spawnSync('python3', ['-m', 'venv', venv], { encoding: 'utf8', timeout: 120000 });
  if (mk.status !== 0) return { skip: `a2a-sdk: cannot create a Python venv to install it: ${(mk.stderr || mk.error?.message || '').trim().split('\n').pop()}` };
  const pip = spawnSync(venvPython, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', SDK_SPEC], { encoding: 'utf8', timeout: 300000 });
  if (pip.status !== 0 || !hasSdk(venvPython)) return { skip: `${SDK_SPEC} could not be installed from PyPI: ${(pip.stderr || pip.error?.message || '').trim().split('\n').pop()}` };
  return { python: venvPython };
}

let server = null;
let resolved = null;

before(async () => {
  // No database or outbound calls from the handler: telemetry/logs no-op,
  // the x402 facilitator is the local server's stand-in.
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  resolved = resolvePython();
  if (resolved.skip) return;
  const { startA2aServer } = await import('./helpers/a2a-local-server.mjs');
  server = await startA2aServer();
});

after(async () => {
  if (server) await server.close();
  process.env = { ...ORIGINAL_ENV };
});

function runClient(python, base, versions) {
  return new Promise((resolve) => {
    const child = spawn(python, ['-I', CLIENT, base, ...versions], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

for (const version of ['1.0', '0.3']) {
  test(`official a2a-sdk client, A2A ${version}: card, free plain-text reply, unpaid paid skill, GetTask, unknown skill`, async (t) => {
    if (resolved.skip) {
      t.skip(resolved.skip);
      return;
    }
    const { code, stdout, stderr } = await runClient(resolved.python, server.base, [version]);
    const lines = stdout.trim().split('\n');
    t.diagnostic(lines.slice(0, -1).join('\n'));
    let summary;
    try { summary = JSON.parse(lines[lines.length - 1]); } catch { assert.fail(`no summary from the SDK client (exit ${code}):\n${stdout}\n${stderr}`); }
    assert.deepEqual(summary.results[version], { plain_text: true, paid_unpaid: true, get_task_not_found: true, unknown_skill_error: true }, stdout);
    assert.equal(summary.ok, true);
    assert.equal(code, 0, stderr);
    assert.match(stdout, new RegExp(`\\[${version.replace('.', '\\.')}\\] SDK transport: ${version === '1.0' ? 'JsonRpcTransport' : 'CompatJsonRpcTransport'}`));
  });
}
