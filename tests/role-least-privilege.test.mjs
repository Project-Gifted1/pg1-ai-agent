/**
 * A missing or unknown role is the least-privileged role, never the
 * operator. 'operator' is only ever set from the authenticated chat session
 * (api/chat.mjs sessionRole); lib/chatTools.mjs has no default role.
 *
 * Covered:
 *   - resolveChatRole / chatToolPolicy / chatToolsForRole / createToolExecutor
 *     with undefined, null, empty, unknown and prototype-key roles;
 *   - unauthenticated (and wrong-password) chat requests get a 401 for every
 *     operator command, including /usage, /export and /vault, and never load
 *     the operator's stored context or the telemetry table;
 *   - /help and /auth stay public;
 *   - the authenticated operator still gets the operator commands, the
 *     stored context and get_usage_stats.
 *
 * Run with: node --test tests/role-least-privilege.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.X402_PAY_TO_ADDRESS;

const { default: chatHandler, __clearAuthRateLimitState, isOperatorCommand } = await import('../api/chat.mjs');
const {
  resolveChatRole, chatToolPolicy, chatToolsForRole, createToolExecutor, CHAT_TOOL_ROLES, LEAST_PRIVILEGED_ROLE,
  READ_ONLY_CHAT_TOOLS, OPERATOR_ONLY_CHAT_TOOLS, USAGE_STATS_TOOL
} = await import('../lib/chatTools.mjs');

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const ARCHIVE_MARKER = 'PRIVATE OPERATOR NOTE 7731';

const UNKNOWN_ROLES = [undefined, null, '', 'nobody', 'public', 'Operator', 'OPERATOR', ' operator', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 42, {}, ['operator']];

function resetEnv() {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  process.env.GEMINI_API_KEY = 'stub-gemini-key';
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER_KEY', 'CARTESIA_API_KEY', 'REPLICATE_API_TOKEN', 'OPENAI_API_KEY']) delete process.env[k];
}

beforeEach(() => {
  resetEnv();
  __clearAuthRateLimitState();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

// Every network call is recorded. Supabase answers with the operator's
// archive (so a leak would show), Gemini with a plain reply. (A 401 still
// writes its own pg1_errors row - a write, not a read of stored context.)
function installFetch() {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (u.includes('/rest/v1/messages?select=role')) return Response.json([{ role: 'user', content: ARCHIVE_MARKER }]);
    if (u.includes('/rest/v1/agent_telemetry') && (options.method || 'GET') === 'GET') return Response.json([]);
    if (u.includes('generativelanguage.googleapis.com')) {
      return Response.json({ candidates: [{ content: { parts: [{ text: 'About 0 distinct callers.' }] } }] });
    }
    if (u.includes('/rest/v1/') || u.includes('/storage/v1/')) return Response.json([]);
    throw new Error('Unexpected network call in test: ' + u);
  };
  return calls;
}

let ipSeq = 0;
const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.55.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}` }, body });

function makeRes() {
  return {
    statusCode: null, headers: {}, jsonBody: null, chunks: [],
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; },
    end() { return this; },
    on() {}
  };
}

async function chat(body) {
  const res = makeRes();
  await chatHandler(makeReq(body), res);
  return res;
}

const OPERATOR = { user: 'test-operator', pass: 'test-secret-pass' };

// --- lib/chatTools.mjs ---------------------------------------------------------

test('resolveChatRole: only an exact known role is kept; anything else is the least-privileged role', () => {
  assert.equal(LEAST_PRIVILEGED_ROLE, 'guest');
  assert.equal(resolveChatRole('operator'), 'operator');
  assert.equal(resolveChatRole('guest'), 'guest');
  for (const role of UNKNOWN_ROLES) assert.equal(resolveChatRole(role), 'guest', String(role));
});

test('chatToolPolicy and chatToolsForRole: a missing or unknown role gets the guest policy and no operator tool', () => {
  const guestNames = chatToolsForRole('guest').map((t) => t.name);
  for (const role of UNKNOWN_ROLES) {
    assert.equal(chatToolPolicy(role), CHAT_TOOL_ROLES.guest, String(role));
    assert.equal(chatToolPolicy(role).licensed, false, `${String(role)}: keeps the anonymous rate limit`);
    const names = chatToolsForRole(role).map((t) => t.name);
    assert.deepEqual(names, guestNames, String(role));
    for (const op of OPERATOR_ONLY_CHAT_TOOLS) assert.ok(!names.includes(op), `${String(role)} never gets ${op}`);
  }
  const operatorNames = chatToolsForRole('operator').map((t) => t.name);
  assert.deepEqual(operatorNames, [...READ_ONLY_CHAT_TOOLS, ...OPERATOR_ONLY_CHAT_TOOLS]);
});

test('createToolExecutor has no default role: without one it runs as guest', async () => {
  let statsReads = 0;
  const seen = [];
  const logs = [];
  const execute = createToolExecutor({
    log: (l) => logs.push(l), record: () => {}, fixtures: () => null,
    usageStats: async () => { statsReads++; return {}; },
    run: async (name, args, ctx) => { seen.push({ name, ctx }); return { status: 'no_flags', reasons: [], checks: [] }; }
  });

  const usage = await execute({ id: '1', name: USAGE_STATS_TOOL, args: { period: '7d' } });
  assert.equal(usage.ok, false);
  assert.equal(usage.code, 'not_available');
  assert.equal(statsReads, 0, 'the stats reader is never called');

  const paidCheck = await execute({ id: '2', name: 'get_cve_details', args: { cve_id: 'CVE-2024-3094' } });
  assert.equal(paidCheck.code, 'not_available', 'operator-only read tools are refused too');

  const free = await execute({ id: '3', name: 'check_domain_age', args: { domain: 'example.com' } });
  assert.equal(free.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ctx.licensed, false, 'no operator rate-limit exemption');
  assert.ok(logs.every((l) => / role=guest /.test(l)), 'logged as guest');
});

test('createToolExecutor with any unknown role (prototype keys included) never throws and never runs operator tools', async () => {
  for (const role of UNKNOWN_ROLES) {
    let statsReads = 0;
    const execute = createToolExecutor({ role, log: () => {}, record: () => {}, usageStats: async () => { statsReads++; return {}; } });
    const out = await execute({ id: 'x', name: USAGE_STATS_TOOL, args: {} });
    assert.equal(out.code, 'not_available', String(role));
    assert.equal(statsReads, 0, String(role));
  }
});

test('the authenticated operator role still runs get_usage_stats', async () => {
  let statsReads = 0;
  const execute = createToolExecutor({ role: 'operator', log: () => {}, record: () => {}, usageStats: async () => { statsReads++; return { period: '7d', total_calls: 0, distinct_callers_estimate: 0 }; } });
  const out = await execute({ id: 'x', name: USAGE_STATS_TOOL, args: { period: '7d' } });
  assert.equal(out.ok, true);
  assert.equal(statsReads, 1);
});

// --- api/chat.mjs: commands ----------------------------------------------------

const OPERATOR_COMMANDS = [
  '/usage', '/usage 30d', '/status', 'status', '/status update', '/export', '/vault', '/sync-vault', '/threat-radar',
  '/commerce-status', '/test-validator', '/image a cat', '/video a cat', '/speak hello', '/tts hello', '/core hello',
  '/claude hello', '/approve tok123', '/decline tok123', '/patch {}', '/deploy-cron', '/build-validator', '/USAGE', '/unknown-command'
];

test('isOperatorCommand: every slash command but /help and /auth, plus the bare "status" keyword', () => {
  for (const c of OPERATOR_COMMANDS) assert.equal(isOperatorCommand(c.toLowerCase()), true, c);
  for (const c of ['/help', 'help', '/auth', '/auth now', 'check example.com', 'what is the status of my order?']) assert.equal(isOperatorCommand(c), false, c);
});

for (const [label, creds] of [['no credentials', {}], ['wrong password', { user: 'test-operator', pass: 'nope' }], ['a body claiming the operator role', { role: 'operator', sessionRole: 'operator', isOperator: true }]]) {
  test(`${label}: every operator command is a 401, with no stored context or telemetry read`, async () => {
    for (const prompt of OPERATOR_COMMANDS) {
      __clearAuthRateLimitState();
      const calls = installFetch();
      const res = await chat({ prompt, ...creds });
      assert.equal(res.statusCode, 401, prompt);
      assert.match(res.jsonBody.reply, /Authentication required/, prompt);
      assert.ok(!JSON.stringify(res.jsonBody).includes(ARCHIVE_MARKER), `${prompt}: no archive`);
      assert.equal(res.jsonBody.toolResults, undefined, prompt);
      assert.ok(!calls.some((c) => c.url.includes('/rest/v1/messages') || c.url.includes('/storage/v1/') || c.url.includes('/rest/v1/pg1_errors?select=')), `${prompt}: no stored-context read`);
      assert.ok(!calls.some((c) => c.url.includes('/rest/v1/agent_telemetry')), `${prompt}: no telemetry read`);
      assert.ok(!calls.some((c) => c.url.includes('generativelanguage.googleapis.com')), `${prompt}: no model call`);
    }
  });
}

test('without the operator session, a usage question never reaches a model with get_usage_stats', async () => {
  const calls = installFetch();
  const res = await chat({ prompt: 'how many agents used our tools this week?', role: 'operator' });
  assert.equal(res.statusCode, 401);
  assert.ok(!calls.some((c) => c.url.includes('generativelanguage.googleapis.com')));
});

test('/help and /auth stay public, and load none of the operator\'s stored context', async () => {
  const calls = installFetch();
  const help = await chat({ prompt: '/help' });
  assert.equal(help.statusCode, 200);
  assert.match(help.jsonBody.reply, /PG1 COMMANDS/);
  const auth = await chat({ prompt: '/auth' });
  assert.equal(auth.statusCode, 200);
  assert.equal(auth.jsonBody.authenticated, false);
  assert.ok(!calls.some((c) => c.url.includes('/rest/v1/messages') || c.url.includes('/storage/v1/') || c.url.includes('/rest/v1/pg1_errors?select=')), 'no stored-context read for a guest');
});

// --- api/chat.mjs: the authenticated operator still can -------------------------

test('authenticated operator: /status, /export, /vault and /usage all work', async () => {
  installFetch();
  const status = await chat({ prompt: '/status', ...OPERATOR });
  assert.equal(status.statusCode, 200);
  assert.match(status.jsonBody.reply, /SYSTEM STATUS/);

  for (const prompt of ['/export', '/vault']) {
    const res = await chat({ prompt, ...OPERATOR });
    assert.equal(res.statusCode, 200, prompt);
    assert.ok(res.jsonBody.reply.includes(ARCHIVE_MARKER), `${prompt}: the operator gets their own archive`);
  }

  const calls = installFetch();
  const usage = await chat({ prompt: '/usage 7d', ...OPERATOR });
  assert.equal(usage.statusCode, 200);
  assert.match(usage.jsonBody.reply, /USAGE · the last 7 days/);
  assert.equal(usage.jsonBody.toolResults[0].tool, USAGE_STATS_TOOL);
  assert.equal(usage.jsonBody.toolResults[0].status, 'report');
  assert.ok(calls.some((c) => c.url.includes('/rest/v1/agent_telemetry') && c.method === 'GET'));
});

test('authenticated operator: a usage question offers the model get_usage_stats', async () => {
  const calls = installFetch();
  const res = await chat({ prompt: 'how many agents used our tools this week?', ...OPERATOR });
  assert.equal(res.statusCode, 200);
  const gem = calls.filter((c) => c.url.includes('generativelanguage.googleapis.com'));
  assert.ok(gem.length >= 1);
  const decls = (gem[0].body.tools || []).flatMap((t) => t.functionDeclarations || []).map((d) => d.name);
  assert.ok(decls.includes(USAGE_STATS_TOOL), 'operator model gets get_usage_stats');
});
