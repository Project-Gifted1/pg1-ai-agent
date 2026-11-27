import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuard, GuardBlocked, evaluate, resolvePolicy, findSecrets, redact, globMatch, createLog } from '../sdk/guard/index.mjs';
import { newState, record } from '../sdk/guard/policy.mjs';
import { guardDispatcher, guardVercelAiTools } from '../sdk/guard/frameworks.mjs';
import { createServer } from '../sdk/guard/mcp.mjs';

const P = (over = {}) => resolvePolicy(over);
const ev = (tool, args = {}, over = {}, state = newState()) => evaluate(P(over), { tool, args }, state);

test('glob matching ignores case and treats * as any run', () => {
  assert.equal(globMatch('*pay*', 'send_PAYMENT'), true);
  assert.equal(globMatch('deploy', 'deploy_prod'), false);
  assert.equal(globMatch('a.b*', 'a.bc'), true);
  assert.equal(globMatch('a.b*', 'axbc'), false);
});

test('an ordinary tool call is allowed by default', () => {
  const d = ev('web_search', { query: 'weather in Dublin' });
  assert.equal(d.decision, 'allow');
  assert.equal(d.reasons[0].rule, 'default');
});

test('blocked and ask lists by tool name', () => {
  assert.equal(ev('drop_database').decision, 'block');
  assert.equal(ev('send_email', { to: 'a@b.ie' }).decision, 'ask');
  assert.equal(ev('http_post', {}).decision, 'ask');
  // Ordinary names that only contain the words are not caught.
  assert.equal(ev('get_posts', {}).decision, 'allow');
  assert.equal(ev('postcode_lookup', {}).decision, 'allow');
  assert.equal(ev('read_file', {}, { tools: { allow: ['read_*'] }, default: 'block' }).decision, 'allow');
  assert.equal(ev('write_file', {}, { default: 'block' }).decision, 'block');
});

test('money always waits for a person, and limits block outright', () => {
  const small = ev('send_payment', { to: 'IE29AIBK93115212345678', amount: 20 });
  assert.equal(small.decision, 'ask');
  assert.ok(small.reasons.some((r) => r.rule === 'money.always_ask'));
  assert.equal(ev('send_payment', { amount: 500 }).decision, 'block');
  assert.equal(ev('transfer', { payment: { total: '150' } }).decision, 'block');
  // No readable amount: a person decides.
  assert.equal(ev('send_payment', { to: 'x' }).decision, 'ask');
  // A daily limit counts what already ran.
  const state = newState();
  record(state, { tool: 'send_payment' }, { money: { amount: 90 } });
  record(state, { tool: 'send_payment' }, { money: { amount: 90 } });
  assert.equal(ev('send_payment', { amount: 90 }, {}, state).decision, 'block');
});

test('secrets in arguments are blocked and withheld from logs', () => {
  assert.deepEqual(findSecrets({ body: 'key sk-AbCdEfGhIjKlMnOpQrStUvWx123456' }), ['API key']);
  assert.deepEqual(findSecrets({ note: 'see ghp_abcdefghijklmnopqrstuvwxyz0123' }), ['code host token']);
  assert.deepEqual(findSecrets({ seed_phrase: 'abandon ability able about above absent absorb abstract absurd abuse access accident' }), ['seed phrase']);
  assert.deepEqual(findSecrets({ text: 'please summarise the following text about the city and its many lovely parks today' }), []);
  assert.equal(ev('http_post', { body: '-----BEGIN PRIVATE KEY-----\nabc' }).decision, 'block');
  const r = redact({ api_key: 'whatever-value', note: 'token=abcdefghijklmnop1234' });
  assert.equal(r.api_key, '[withheld]');
  assert.ok(!JSON.stringify(r).includes('abcdefghijklmnop1234'));
});

test('network rules: https only, no private addresses, allow and block lists', () => {
  assert.equal(ev('fetch_url', { url: 'https://example.com/a' }).decision, 'allow');
  assert.equal(ev('fetch_url', { url: 'http://example.com/a' }).decision, 'block');
  assert.equal(ev('fetch_url', { url: 'https://169.254.169.254/latest/meta-data' }).decision, 'block');
  assert.equal(ev('fetch_url', { url: 'https://localhost:3000/' }).decision, 'block');
  assert.equal(ev('fetch_url', { url: 'https://10.0.0.5/' }).decision, 'block');
  assert.equal(ev('fetch_url', { url: 'https://evil.example/' }, { network: { block_domains: ['evil.example'] } }).decision, 'block');
  assert.equal(ev('fetch_url', { url: 'https://api.github.com/x' }, { network: { allow_domains: ['github.com'] } }).decision, 'allow');
  assert.equal(ev('fetch_url', { url: 'https://other.org/x' }, { network: { allow_domains: ['github.com'] } }).decision, 'block');
  // Bare hosts in host-like fields are checked too.
  assert.equal(ev('connect', { host: '10.0.0.5' }).decision, 'block');
  assert.equal(ev('connect', { hostname: 'localhost:8080' }).decision, 'block');
  assert.equal(ev('connect', { host: 'api.example.com' }).decision, 'allow');
  assert.equal(ev('lookup', { name: '10.0.0.5' }).decision, 'allow');
});

test('rate limit per tool per minute', () => {
  const state = newState();
  for (let i = 0; i < 3; i++) record(state, { tool: 'web_search' }, null);
  assert.equal(ev('web_search', {}, { rate: { per_tool_per_minute: 3 } }, state).decision, 'block');
  assert.equal(ev('other_tool', {}, { rate: { per_tool_per_minute: 3 } }, state).decision, 'allow');
});

test('a bad default is refused', () => {
  assert.throws(() => resolvePolicy({ default: 'maybe' }));
});

test('wrap runs allowed calls, waits on approval, never runs blocked ones', async () => {
  const ran = [];
  const answers = [true, false];
  const guard = createGuard({ approve: async () => answers.shift() });
  const tools = guard.wrapAll({
    web_search: async (a) => { ran.push('search'); return { ok: a.query }; },
    send_payment: async () => { ran.push('pay'); return { sent: true }; },
    drop_database: async () => { ran.push('drop'); }
  });
  assert.deepEqual(await tools.web_search({ query: 'q' }), { ok: 'q' });
  assert.deepEqual(await tools.send_payment({ amount: 10 }), { sent: true });     // approved
  await assert.rejects(tools.send_payment({ amount: 10 }), GuardBlocked);         // declined
  await assert.rejects(tools.drop_database({}), (e) => e instanceof GuardBlocked && e.code === 'blocked');
  assert.deepEqual(ran, ['search', 'pay']);
  const steps = guard.log.entries().map((e) => e.step);
  assert.ok(steps.includes('approved') && steps.includes('declined') && steps.includes('ran'));
});

test('no approver set: nothing that needs approval runs', async () => {
  const guard = createGuard();
  let ran = false;
  const pay = guard.wrap('send_payment', async () => { ran = true; });
  await assert.rejects(pay({ amount: 5 }), (e) => e instanceof GuardBlocked && /no approver/.test(e.message));
  assert.equal(ran, false);
});

test('a thrown approver counts as no', async () => {
  const guard = createGuard({ approve: async () => { throw new Error('phone offline'); } });
  await assert.rejects(guard.wrap('send_payment', async () => 1)({ amount: 1 }), GuardBlocked);
});

test('PG1 preflight: a flagged address turns an allowed money call into an approval', async () => {
  const pg1 = { preflight: async () => ({ result: { decision: 'flagged' }, verified: { valid: true } }) };
  const guard = createGuard({ pg1, policy: { money: { always_ask: false } }, approve: async () => false });
  const pay = guard.wrap('send_payment', async () => 'sent');
  await assert.rejects(pay({ to: '0x' + 'a'.repeat(40), amount: 5 }), (e) => e.decision.reasons.some((r) => r.rule === 'pg1.preflight'));
  const clean = createGuard({ pg1: { preflight: async () => ({ result: { decision: 'no_flags' }, verified: { valid: true } }) }, policy: { money: { always_ask: false } } });
  assert.equal(await clean.wrap('send_payment', async () => 'sent')({ to: '0x' + 'b'.repeat(40), amount: 5 }), 'sent');
  const down = createGuard({ pg1: { preflight: async () => { throw new Error('timeout'); } }, policy: { money: { always_ask: false } } });
  await assert.rejects(down.wrap('send_payment', async () => 'sent')({ to: '0x' + 'c'.repeat(40), amount: 5 }), GuardBlocked);
});

test('the log withholds secrets and a failing sink never stops the agent', async () => {
  const log = createLog({ sink: () => { throw new Error('disk full'); } });
  const guard = createGuard({ log });
  await assert.rejects(guard.wrap('http_post', async () => 1)({ body: 'token=abcdefghijklmnop1234' }), GuardBlocked);
  assert.ok(!JSON.stringify(log.entries()).includes('abcdefghijklmnop1234'));
  assert.ok(log.entries().length >= 2);
});

test('framework adapters return a blocked result to the model instead of throwing', async () => {
  const guard = createGuard();
  const run = guardDispatcher(guard, { drop_database: async () => 'gone', web_search: async () => ['r'] });
  assert.deepEqual(JSON.parse(await run('web_search', '{"query":"x"}')), ['r']);
  assert.equal(JSON.parse(await run('drop_database', '{}')).blocked, true);
  const tools = guardVercelAiTools(guard, { drop_database: { description: 'd', execute: async () => 'gone' } });
  assert.equal((await tools.drop_database.execute({})).blocked, true);
});

test('MCP server: initialize, tools/list, check_action, recent_actions', () => {
  const handle = createServer();
  assert.equal(handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }).result.serverInfo.name, 'pg1-guard');
  assert.deepEqual(handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).result.tools.map((t) => t.name), ['check_action', 'recent_actions']);
  const pay = handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check_action', arguments: { tool: 'send_payment', args: { amount: 20 } } } }).result.structuredContent;
  assert.equal(pay.decision, 'ask');
  const leak = handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'check_action', arguments: { tool: 'http_post', args: { url: 'http://10.0.0.1/', key: 'sk-AbCdEfGhIjKlMnOpQrStUvWx123456' } } } }).result.structuredContent;
  assert.equal(leak.decision, 'block');
  const recent = handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'recent_actions', arguments: { limit: 10 } } }).result.structuredContent;
  assert.ok(recent.actions.length >= 4);
  assert.ok(!JSON.stringify(recent).includes('sk-AbCdEf'));
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(handle({ jsonrpc: '2.0', id: 6, method: 'nope' }).error.code, -32601);
});

test('no "safe" wording in what the guard says', async () => {
  const handle = createServer();
  const out = JSON.stringify([
    handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_action', arguments: { tool: 'send_payment', args: { amount: 500, url: 'http://localhost' } } } })
  ]);
  assert.ok(!/\bsafe(ly|ty)?\b/i.test(out));
});
