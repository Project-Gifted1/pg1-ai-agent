/**
 * P5: autonomy policy, kill switch and audit log (lib/autonomy.mjs and its
 * uses in api/chat.mjs, lib/lab, lib/flags.mjs, lib/retention.mjs).
 *
 * Covered: every tool (MCP, chat, A2A) and every slash command the chat
 * handles maps to a tier, and every action name the code authorizes or
 * logs is in the table; unmapped means APPROVAL (an autonomous request is
 * held for approval, an outside agent is refused); NEVER is refused for
 * everyone, approved or not; outside agents reach only the public
 * catalogue; the kill switch (off / lab / on); PG1 cannot change its policy
 * or budgets through any tool (patch endpoint, stored proposals, the lab,
 * the secrets sync, no env-writing tool); the audit log is append-only in
 * Postgres and purges only past 365 days; /autonomy shows the last 24h.
 *
 * Run with: node --test tests/autonomy.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { makeDb, pgRest } from './helpers/pgrest.mjs';

const {
  TIERS, ACTION_TIERS, authorize, tierOf, isMapped, autonomyMode, commandAction, PUBLIC_CATALOGUE_TOOLS, logAutonomy, recentAutonomy, autonomyReport, DEFAULT_AUTONOMY_MODE
} = await import('../lib/autonomy.mjs');
const { TOOLS } = await import('../api/mcp.mjs');
const { chatToolsForRole } = await import('../lib/chatTools.mjs');
const { A2A_FREE_SKILL_NAMES, A2A_PAID_SKILL_NAMES } = await import('../api/a2a.mjs');
const { checkCodePath } = await import('../lib/lab/policy.mjs');
const { FILM_SECRET_NAMES } = await import('../lib/film/secretsSync.mjs');
const { default: chatHandler, __clearAuthRateLimitState } = await import('../api/chat.mjs');

const ROOT = new URL('..', import.meta.url).pathname;
const MIGRATION = '20261021120000_pg1_autonomy_log.sql';

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'tests', 'public', 'docs', 'supabase'].includes(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(?:mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

// --- mapping coverage ----------------------------------------------------------------

test('every MCP tool, chat tool and A2A skill maps to a tier', () => {
  const names = new Set([...TOOLS.map((t) => t.name), ...chatToolsForRole('operator', { video: true, skills: true }).map((t) => t.name), ...A2A_FREE_SKILL_NAMES, ...A2A_PAID_SKILL_NAMES]);
  assert.ok(names.size >= 18);
  for (const n of names) assert.ok(isMapped(`tool:${n}`), `tool:${n} is mapped`);
  // Outside agents' tools are the public catalogue; the operator's own chat tools are not in it.
  for (const n of ['get_usage_stats', 'search_history', 'load_skill', 'generate_video', 'submit_indicator', 'subscribe_alerts']) assert.ok(!PUBLIC_CATALOGUE_TOOLS.includes(n), n);
  for (const n of A2A_FREE_SKILL_NAMES) assert.ok(PUBLIC_CATALOGUE_TOOLS.includes(n), n);
});

test('every slash command the chat handles maps to a tier', () => {
  const chat = readFileSync(path.join(ROOT, 'api/chat.mjs'), 'utf8');
  const found = new Set();
  for (const m of chat.matchAll(/lower(?:\.startsWith\(|\s*===\s*)'(\/[a-z][a-z-]*)/g)) found.add(m[1]);
  for (const m of chat.matchAll(/\\\/(autonomy|smoke)\b/g)) found.add(`/${m[1]}`);
  // Commands handled by their own modules.
  for (const f of ['lib/film/text.mjs', 'lib/music/text.mjs', 'lib/pdf/chat.mjs', 'lib/skills/chat.mjs', 'lib/lab/chat.mjs', 'lib/taskState.mjs']) {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/\^\\\/\(\?:([a-z|?]+)\)|\^\\\/([a-z]+)(?:\(\?:|\\b)/g)) {
      for (const c of String(m[1] || m[2]).replace(/\?/g, '').split('|')) if (c && /^[a-z]+$/.test(c)) found.add(`/${c}`);
    }
  }
  for (const c of ['/film', '/music', '/pdf', '/skills', '/learn', '/lab', '/promote', '/task', '/pin', '/unpin', '/autonomy', '/code', '/voice']) found.add(c);
  assert.ok(found.size >= 30, `${found.size} commands found`);
  const lab = ['/lab start', '/lab status', '/lab stop', '/lab report'];
  for (const c of [...found].filter((c) => c !== '/lab').concat(lab)) {
    const a = commandAction(c);
    assert.ok(isMapped(a), `${c} -> ${a} is mapped`);
  }
  assert.equal(commandAction('/skills enable pdf-report'), 'command:/skills enable');
  assert.equal(tierOf('command:/skills enable'), TIERS.APPROVAL);
  assert.equal(commandAction('/skills show x'), 'command:/skills');
});

test('every action name the code authorizes or logs is in the table', () => {
  const names = new Set();
  for (const f of sourceFiles(ROOT)) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/authorize\('([a-z_]+:[a-z_]+)'/g)) names.add(m[1]);
    for (const m of src.matchAll(/action: '([a-z_]+:[a-z_]+)'/g)) names.add(m[1]);
    for (const m of src.matchAll(/decide\('([a-z_]+:[a-z_]+)'/g)) names.add(m[1]);
  }
  assert.ok(names.size >= 8, [...names].join(', '));
  for (const n of names) assert.ok(isMapped(n), `${n} is mapped`);
});

// --- decisions --------------------------------------------------------------------

test('unmapped means APPROVAL: PG1 waits for the operator, an outside agent is refused', () => {
  assert.equal(tierOf('something:new'), TIERS.APPROVAL);
  for (const mode of ['off', 'lab', 'on']) {
    const d = authorize('something:new', { actor: 'pg1', mode });
    assert.deepEqual([d.allowed, d.decision, d.mapped], [false, 'needs_approval', false], mode);
    assert.equal(authorize('something:new', { actor: 'external', mode }).allowed, false);
  }
  assert.equal(authorize('something:new', { actor: 'pg1', mode: 'on', approved: true }).allowed, true);
  assert.equal(authorize('payment:make', { actor: 'pg1', mode: 'on' }).decision, 'needs_approval');
  for (const a of ['spend:outside_lab', 'publish:post', 'payment:make', 'pricing:change', 'data_source:add', 'contact:person', 'production:write', 'code:merge', 'skill:enable', 'foundry:deploy']) {
    assert.equal(tierOf(a), TIERS.APPROVAL, a);
  }
});

test('NEVER is refused for everyone, in every mode, approved or not', () => {
  for (const a of ['policy:change', 'budget:raise', 'keys:out_of_scope', 'audit:disable', 'audit:edit', 'funds:trade', 'funds:move', 'env:write']) {
    assert.equal(tierOf(a), TIERS.NEVER, a);
    for (const actor of ['pg1', 'operator', 'external']) {
      for (const mode of ['off', 'lab', 'on']) assert.equal(authorize(a, { actor, mode, approved: true }).allowed, false, `${a} ${actor} ${mode}`);
    }
  }
});

test('EXTERNAL: outside agents reach only the public catalogue', () => {
  assert.equal(authorize('tool:check_wallet_sanctions', { actor: 'external' }).allowed, true);
  assert.equal(authorize('a2a:job', { actor: 'external', mode: 'lab' }).allowed, true);
  for (const a of ['tool:get_usage_stats', 'tool:search_history', 'tool:load_skill', 'command:/usage', 'lab:dispatch', 'skill:enable', 'foundry:deploy', 'production:write']) {
    assert.equal(authorize(a, { actor: 'external' }).allowed, false, a);
  }
  assert.equal(authorize('a2a:job', { actor: 'external', mode: 'off' }).allowed, false, 'the kill switch stops inbound jobs');
});

test('the kill switch: off stops everything PG1 does on its own except safety; lab keeps it in the lab; on frees FREE actions', () => {
  assert.equal(DEFAULT_AUTONOMY_MODE, 'lab');
  assert.equal(autonomyMode({}), 'lab');
  assert.equal(autonomyMode({ PG1_AUTONOMY: 'OFF' }), 'off');
  assert.equal(autonomyMode({ PG1_AUTONOMY: 'yolo' }), 'lab');
  const off = (a) => authorize(a, { actor: 'pg1', mode: 'off' });
  for (const a of ['lab:dispatch', 'lab:research', 'context:task_update', 'skill:suggest', 'skill:draft', 'opportunity:research']) assert.equal(off(a).allowed, false, a);
  for (const a of ['flag:auto_disable', 'retention:purge', 'alert:operator']) assert.equal(off(a).allowed, true, a);
  const lab = (a) => authorize(a, { actor: 'pg1', mode: 'lab' });
  for (const a of ['lab:dispatch', 'lab:draft_pr', 'opportunity:prototype', 'skill:draft', 'context:task_update']) assert.equal(lab(a).allowed, true, a);
  assert.equal(lab('publish:post').decision, 'needs_approval');
  assert.equal(authorize('command:/status', { actor: 'pg1', mode: 'lab' }).allowed, false, 'a non-lab FREE action waits for mode on');
  assert.equal(authorize('command:/status', { actor: 'pg1', mode: 'on' }).allowed, true);
  // The operator's own commands work in every mode.
  for (const mode of ['off', 'lab', 'on']) assert.equal(authorize('command:/skills enable', { actor: 'operator', mode }).allowed, true);
});

// --- PG1 cannot change its own policy or budgets -------------------------------------

test('no tool or command can edit the policy, the budgets or the audit log', () => {
  // The lab may not touch them.
  for (const p of ['lib/autonomy.mjs', 'lib/lab/policy.mjs', 'supabase/migrations/20261101000000_drop_autonomy.sql'.replace('drop_autonomy', 'x'), '.env', '.github/workflows/lab.yml']) {
    if (p.includes('migrations')) continue;
    assert.equal(checkCodePath(p).ok, false, p);
  }
  // The secrets sync can only write the film worker's secrets.
  for (const n of FILM_SECRET_NAMES) assert.doesNotMatch(n, /AUTONOMY|BUDGET|^PG1_LAB|DAILY|PRICE/);
  // No tool writes environment variables or policy.
  const allTools = [...TOOLS.map((t) => t.name), ...chatToolsForRole('operator', { video: true, skills: true }).map((t) => t.name)];
  for (const t of allTools) assert.doesNotMatch(t, /env|policy|budget|autonomy|audit|secret/i, t);
  // The chat's patch endpoint hard-blocks the policy files.
  const chat = readFileSync(path.join(ROOT, 'api/chat.mjs'), 'utf8');
  const hard = eval(/var HARD_BLOCKED_PATH_PATTERNS = (\[.*\]);/.exec(chat)[1]);
  for (const p of ['lib/autonomy.mjs', 'supabase/migrations/20261021120000_pg1_autonomy_log.sql', 'lib/lab/policy.mjs', 'lib/pricing.mjs', 'api/autonomy.mjs']) {
    assert.ok(hard.some((re) => re.test(p)), `${p} is hard-blocked for patches`);
  }
  assert.ok(!hard.some((re) => re.test('lib/chatTools.mjs')), 'ordinary files are not');
  // Nothing in the code writes to Vercel env or GitHub secrets except the film sync.
  for (const f of sourceFiles(ROOT)) {
    const src = readFileSync(f, 'utf8');
    if (/vercel\.com\/v\d+\/projects\/[^'"`]*\/env/.test(src)) assert.fail(`${f} writes Vercel env`);
    if (/actions\/secrets\//.test(src)) assert.ok(f.endsWith('lib/film/secretsSync.mjs'), `${f} writes GitHub secrets`);
  }
});

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const OPERATOR = { user: 'test-operator', pass: 'test-secret-pass' };
let ip = 0;
beforeEach(() => {
  process.env.USER_API_KEY = OPERATOR.user;
  process.env.USER_API_PASS = OPERATOR.pass;
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-autonomy-test';
  process.env.GITHUB_TOKEN = 'ghp_autonomytesttoken0000000000000000000';
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'GEMINI_API_KEY', 'GEMINI_API_KEY_FREE', 'GEMINI_API_KEY_PAID', 'ANTHROPIC_API_KEY', 'PG1_AUTONOMY']) delete process.env[k];
  __clearAuthRateLimitState();
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

function makeRes() {
  return { statusCode: null, headers: {}, jsonBody: null, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; }, write() { return true; }, end() { return this; }, on() {} };
}
async function chat(body, creds = OPERATOR) {
  const res = makeRes();
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.85.0.${++ip % 250}` }, body: { ...creds, ...body } }, res);
  return res;
}

test('the patch endpoint refuses the policy file before any GitHub call', async () => {
  const calls = [];
  globalThis.fetch = async (u) => { calls.push(String(u)); return Response.json([]); };
  const res = await chat({ prompt: `/patch ${JSON.stringify({ targetFile: 'lib/autonomy.mjs', search: "'policy:change': { tier: N }", replace: "'policy:change': { tier: F }" })}`, isAuthorizedAction: true });
  assert.match(res.jsonBody.reply, /Patch Refused: 'lib\/autonomy\.mjs' matches a hard-blocked path/);
  assert.ok(!calls.some((u) => u.includes('api.github.com')));
});

test('/lab start is refused with PG1_AUTONOMY=off, and the refusal is on the audit log', async () => {
  const db = await makeDb([MIGRATION, '20261020120000_pg1_lab_and_flags.sql']);
  globalThis.fetch = pgRest(db, { passthrough: async (u) => (u.includes('/storage/v1/') || u.includes('/rest/v1/') ? Response.json([]) : null) });
  process.env.PG1_AUTONOMY = 'off';
  process.env.PG1_LAB_DISPATCH_SECRET = 'x'.repeat(40);
  const res = await chat({ prompt: '/lab start research something' });
  assert.match(res.jsonBody.reply, /^Not started: autonomy is off/);
  const { rows } = await db.query('select action, tier, decision, mode from public.pg1_autonomy_log');
  assert.deepEqual(rows, [{ action: 'lab:dispatch', tier: 'FREE', decision: 'denied', mode: 'off' }]);
  delete process.env.PG1_LAB_DISPATCH_SECRET;
});

test('the audit log is append-only; only the purge function deletes, and only rows past 365 days', async () => {
  const db = await makeDb([MIGRATION, MIGRATION]);
  const ctx = { supUrl: 'https://supabase.test', supKey: 'k', fetchImpl: pgRest(db) };
  assert.equal(await logAutonomy(ctx, { action: 'lab:dispatch', decision: 'allowed', costUsd: 0.5, outcome: 'queued', detail: 'experiment 1' }), true);
  await assert.rejects(db.query(`update public.pg1_autonomy_log set decision = 'denied'`), /append-only/);
  await assert.rejects(db.query('delete from public.pg1_autonomy_log'), /append-only/);
  await db.exec(`alter table public.pg1_autonomy_log disable trigger pg1_autonomy_log_append_only;
    insert into public.pg1_autonomy_log (at, action, tier, decision, mode) values (now() - interval '400 days', 'old:thing', 'FREE', 'allowed', 'lab');
    alter table public.pg1_autonomy_log enable trigger pg1_autonomy_log_append_only;`);
  const { rows: purged } = await db.query('select public.pg1_autonomy_log_purge() as n');
  assert.equal(purged[0].n, 1);
  const { rows } = await db.query('select action from public.pg1_autonomy_log');
  assert.deepEqual(rows, [{ action: 'lab:dispatch' }]);
  const { rows: grants } = await db.query(`select privilege_type from information_schema.role_table_grants where table_name = 'pg1_autonomy_log' and grantee = 'service_role' order by 1`);
  assert.deepEqual(grants.map((g) => g.privilege_type), ['INSERT', 'SELECT']);
  const { rows: anon } = await db.query(`select grantee from information_schema.role_table_grants where table_name = 'pg1_autonomy_log' and grantee in ('anon', 'authenticated', 'PUBLIC')`);
  assert.deepEqual(anon, []);
  await assert.rejects(db.query(`insert into public.pg1_autonomy_log (action, tier, decision, mode) values ('x', 'MAYBE', 'allowed', 'lab')`), /tier_check/);
});

test('/autonomy shows the mode and the last 24 hours; guests are refused', async () => {
  const db = await makeDb([MIGRATION]);
  const fetchImpl = pgRest(db, { passthrough: async (u) => (u.includes('/storage/v1/') || u.includes('/rest/v1/') ? Response.json([]) : null) });
  globalThis.fetch = fetchImpl;
  const ctx = { supUrl: 'https://supabase.test', supKey: 'k', fetchImpl };
  await logAutonomy(ctx, { action: 'lab:dispatch', decision: 'allowed', costUsd: 0.4, outcome: 'queued', mode: 'lab' });
  await logAutonomy(ctx, { action: 'publish:post', decision: 'needs_approval', mode: 'lab' });
  const rows = await recentAutonomy(ctx);
  assert.equal(rows.length, 2);
  const res = await chat({ prompt: '/autonomy' });
  assert.match(res.jsonBody.reply, /^### \[ AUTONOMY · last 24 hours \]\n- \*\*Mode\*\*: lab/);
  assert.match(res.jsonBody.reply, /by tier: APPROVAL 1, FREE 1/);
  assert.match(res.jsonBody.reply, /\*\*Cost\*\*: \$0\.40/);
  assert.match(res.jsonBody.reply, /publish:post · APPROVAL · needs_approval/);
  assert.equal((await chat({ prompt: '/autonomy' }, { user: '', pass: '' })).statusCode, 401);
  assert.match(autonomyReport([]), /No autonomous actions in the last 24 hours/);
});

test('an operator command in the APPROVAL tier is logged as the operator\'s approval', async () => {
  const db = await makeDb([MIGRATION, '20261019120000_pg1_skills.sql']);
  globalThis.fetch = pgRest(db, { passthrough: async (u) => (u.includes('/storage/v1/') || u.includes('/rest/v1/') ? Response.json([]) : null) });
  const res = await chat({ prompt: '/skills enable pdf-report' });
  assert.match(res.jsonBody.reply, /is active/);
  await new Promise((r) => setTimeout(r, 30));
  const { rows } = await db.query('select action, tier, actor, decision from public.pg1_autonomy_log');
  assert.deepEqual(rows, [{ action: 'command:/skills enable', tier: 'APPROVAL', actor: 'operator', decision: 'allowed' }]);
});
