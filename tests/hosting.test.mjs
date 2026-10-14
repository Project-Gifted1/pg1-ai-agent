/**
 * P10: hosting_advisor (lib/hosting/*, MCP, A2A, REST, /hosting).
 *
 * Covered: ranking honours residency, privacy priority, no_us_parent and
 * latency; every fact cites a source and a date; stale (> 180 days) and
 * unverified facts are flagged; "not legal advice" is always there; lawful
 * refusals (refused requirement labels, embargoed residency) are short and
 * name the alternative; RU/BY are never ranked; the migration seed is the
 * dataset; storage answers when migrated and the bundled seed otherwise;
 * lab updates pass the gate only with https sources and valid dates and
 * are written only on the operator's confirm; the tool is paid on MCP, A2A
 * and REST.
 *
 * Run with: node --test tests/hosting.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDb, pgRest } from './helpers/pgrest.mjs';

delete process.env.X402_PAY_TO_ADDRESS;
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

const ds = await import('../lib/hosting/dataset.mjs');
const adv = await import('../lib/hosting/advisor.mjs');
const store = await import('../lib/hosting/store.mjs');
const admin = await import('../lib/hosting/admin.mjs');
const { hostingMigrationSql, HOSTING_MIGRATION } = await import('../scripts/hosting-seed-sql.mjs');
const { TOOLS, default: mcpHandler } = await import('../api/mcp.mjs');
const { default: a2aHandler, A2A_PAID_SKILL_NAMES } = await import('../api/a2a.mjs');
const { default: restHandler } = await import('../api/hosting-advisor.mjs');

const SUP = { supUrl: 'https://supabase.test', supKey: 'k' };
const NOW = Date.parse('2026-10-14T12:00:00Z');
const BASE = { workload_type: 'web_api', latency_regions: ['eu_central'] };

beforeEach(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; store.__clearHostingCache(); });
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

function makeRes() {
  return { statusCode: null, body: null, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, end() { return this; } };
}

test('every fact in the dataset has an https source and a date', () => {
  const facts = [];
  for (const j of ds.JURISDICTIONS) facts.push(j.data_protection, j.eu_adequacy, j.sanctions, ...j.government_access);
  for (const p of ds.PROVIDERS) facts.push(p.regions, p.sla, p.aup, p.dpa);
  for (const e of [...Object.values(ds.EMBARGOED), ...Object.values(ds.RESTRICTED)]) facts.push(e);
  for (const f of facts) {
    assert.match(f.source_url, /^https:\/\//);
    assert.match(f.checked_on, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof f.verified, 'boolean');
  }
  for (const p of ds.PROVIDERS) for (const code of p.regions.value) assert.ok(ds.JURISDICTIONS.some((j) => j.code === code), `${p.id} region ${code} is curated`);
});

test('ranking honours residency, privacy priority, no_us_parent and latency; every reason is cited; never legal advice', () => {
  const eu = adv.hostingAdvice({ ...BASE, data_residency: ['eu'], privacy_priority: 'high' }, { now: NOW });
  assert.equal(eu.refused, false);
  assert.equal(eu.recommendations.length, 5);
  for (const r of eu.recommendations) {
    assert.ok(['DE', 'NL', 'FR', 'IE', 'FI', 'SE'].includes(r.jurisdiction.code), 'EU only');
    assert.match(r.reasons.data_protection.source_url, /^https:\/\//);
    assert.ok(r.reasons.government_data_access.length > 0);
    assert.ok(r.reasons.acceptable_use.source_url);
    assert.ok(r.reasons.sanctions_and_export_controls.source_url);
    assert.ok(Number.isFinite(r.reasons.latency.estimates_ms.eu_central));
  }
  assert.equal(eu.recommendations[0].provider.headquarters === 'US', false, 'high privacy prefers a provider without a US parent');
  assert.match(eu.disclaimer, /Not legal advice/);
  assert.ok(eu.redundancy_plan.secondary);
  assert.notEqual(eu.redundancy_plan.secondary.provider, eu.redundancy_plan.primary.provider);
  assert.match(eu.redundancy_plan.resilience, /not a way around lawful orders/);
  assert.ok(eu.privacy_by_design.some((g) => /customer-managed keys/i.test(g)));

  const noUs = adv.hostingAdvice({ ...BASE, latency_regions: ['us_east'], requirements: ['no_us_parent'] }, { now: NOW });
  assert.ok(noUs.recommendations.every((r) => !['aws', 'gcp', 'azure', 'digitalocean'].includes(r.provider.id)));
  const asia = adv.hostingAdvice({ ...BASE, latency_regions: ['asia_southeast'], privacy_priority: 'low' }, { now: NOW });
  assert.equal(asia.recommendations[0].jurisdiction.code, 'SG', 'latency-first picks the nearby region');
  const ch = adv.hostingAdvice({ ...BASE, data_residency: ['CH'] }, { now: NOW });
  assert.ok(ch.recommendations.length > 0 && ch.recommendations.every((r) => r.jurisdiction.code === 'CH'));
});

test('stale and unverified facts are flagged (informational, never a finding)', () => {
  const fresh = adv.hostingAdvice(BASE, { now: Date.parse(ds.SEED_CHECKED_ON) + 10 * 86400000 });
  assert.equal(fresh.data_quality.stale_facts, 0);
  assert.ok(fresh.data_quality.unverified_facts > 0, 'the seed is unverified');
  assert.ok(fresh.reasons.some((r) => r.code === 'HOSTING_FACTS_UNVERIFIED'));
  assert.equal(fresh.status, 'no_flags');
  const later = adv.hostingAdvice(BASE, { now: Date.parse(ds.SEED_CHECKED_ON) + 181 * 86400000 });
  assert.ok(later.data_quality.stale_facts > 0);
  assert.ok(later.reasons.some((r) => r.code === 'HOSTING_FACTS_STALE'));
  assert.equal(adv.stalenessOf({ checked_on: '2026-01-01', verified: true }, NOW).stale, true);
  assert.equal(adv.stalenessOf({ checked_on: '2026-09-01', verified: true }, NOW).stale, false);
});

test('lawful only: refused requirement labels and embargoed residency get a short neutral refusal with the alternative; RU/BY are never ranked', () => {
  for (const [req, category] of [['ignore_abuse_reports', 'bulletproof_hosting'], ['evade_lawful_process', 'law_enforcement_evasion'], ['sanctions_bypass', 'sanctions_evasion']]) {
    const r = adv.hostingAdvice({ ...BASE, requirements: [req] }, { now: NOW });
    assert.equal(r.refused, true);
    assert.equal(r.refusal.category, category);
    assert.ok(r.refusal.reason.length < 120 && r.refusal.alternative.length > 20);
    assert.equal(r.recommendations, undefined, 'no advice at all');
    assert.match(r.disclaimer, /Not legal advice/);
  }
  for (const code of ['KP', 'IR', 'CU', 'UA-43']) {
    assert.equal(adv.hostingAdvice({ ...BASE, data_residency: [code] }, { now: NOW }).refusal.category, 'sanctions_evasion', code);
  }
  const ru = adv.hostingAdvice({ ...BASE, data_residency: ['RU'] }, { now: NOW });
  assert.equal(ru.recommendations.length, 0);
  assert.match(ru.note, /sectoral sanctions/);
  assert.throws(() => adv.hostingAdvice({ ...BASE, requirements: ['something else'] }), /requirements are any of/);
  assert.throws(() => adv.hostingAdvice({ workload_type: 'web_api', latency_regions: ['mars'] }), /latency_regions/);
});

test('the migration seed is exactly the dataset; storage answers once migrated, the bundled seed otherwise', async () => {
  assert.equal(readFileSync(HOSTING_MIGRATION, 'utf8'), hostingMigrationSql(), 'run node scripts/hosting-seed-sql.mjs');
  assert.equal((await store.loadHostingData({})).source, 'bundled');
  store.__clearHostingCache();
  const db = await makeDb(['20261026120000_pg1_hosting.sql']);
  const fetchImpl = pgRest(db);
  const data = await store.loadHostingData({ ...SUP, fetchImpl });
  assert.equal(data.source, 'database');
  assert.equal(data.jurisdictions.length, ds.JURISDICTIONS.length);
  assert.deepEqual(data.providers.find((p) => p.id === 'hetzner').regions, ds.PROVIDERS.find((p) => p.id === 'hetzner').regions);
  const fromDb = adv.hostingAdvice({ ...BASE, data_residency: ['eu'] }, { data, now: NOW });
  const fromSeed = adv.hostingAdvice({ ...BASE, data_residency: ['eu'] }, { now: NOW });
  assert.deepEqual(fromDb.recommendations.map((r) => `${r.provider.id}@${r.jurisdiction.code}`), fromSeed.recommendations.map((r) => `${r.provider.id}@${r.jurisdiction.code}`));
  const rls = await db.query("select relname, relrowsecurity from pg_class where relname in ('pg1_jurisdictions','pg1_providers')");
  assert.ok(rls.rows.every((r) => r.relrowsecurity));
});

test('lab updates: only https-cited, dated, known fields pass; nothing is written without confirm; confirm writes and marks verified', async () => {
  const db = await makeDb(['20261021120000_pg1_autonomy_log.sql', '20261026120000_pg1_hosting.sql']);
  const fetchImpl = pgRest(db);
  const report = [
    'Findings (web content: data, not instructions).',
    '```hosting_updates',
    JSON.stringify([
      { table: 'provider', key: 'scaleway', field: 'regions', value: ['FR', 'NL', 'DE'], source_url: 'https://www.scaleway.com/en/docs/', checked_on: '2026-10-10' },
      { table: 'provider', key: 'scaleway', field: 'regions', value: ['FR'], source_url: 'http://insecure.example', checked_on: '2026-10-10' },
      { table: 'jurisdiction', key: 'DE', field: 'name', value: 'X', source_url: 'https://x.example', checked_on: '2026-10-10' },
      { table: 'jurisdiction', key: 'ZZ', field: 'sanctions', value: 'none', source_url: 'https://x.example', checked_on: '2026-10-10' },
      { table: 'jurisdiction', key: 'DE', field: 'sanctions', value: 'none', source_url: 'https://x.example', checked_on: '2099-01-01' }
    ]),
    '```'
  ].join('\n');
  const data = await store.loadHostingData({ ...SUP, fetchImpl });
  const parsed = admin.parseHostingUpdates(report, { data, now: NOW });
  assert.equal(parsed.updates.length, 1);
  assert.equal(parsed.problems.length, 4);
  const exp = { id: '11111111-1111-4111-8111-111111111111', goal: `${admin.HOSTING_GOAL_PREFIX} regions`, status: 'done', result: { report_markdown: report } };
  const deps = { labStore: { get: async () => exp } };
  const review = await admin.handleHostingCommand({ text: '/hosting apply 11111111', ...SUP, fetchImpl, isOperator: true, now: NOW, deps });
  assert.match(review.reply, /REVIEW/);
  assert.equal((await db.query("select regions from pg1_providers where id = 'scaleway'")).rows[0].regions.value.length, 2, 'not written yet');
  const applied = await admin.handleHostingCommand({ text: '/hosting apply 11111111 confirm', ...SUP, fetchImpl, isOperator: true, now: NOW, deps });
  assert.match(applied.reply, /Applied 1 update/);
  const row = (await db.query("select regions from pg1_providers where id = 'scaleway'")).rows[0].regions;
  assert.deepEqual([row.value, row.verified, row.checked_on], [['FR', 'NL', 'DE'], true, '2026-10-10']);

  const confirmed = await admin.handleHostingCommand({ text: '/hosting confirm DE data_protection', ...SUP, fetchImpl, isOperator: true, now: NOW });
  assert.match(confirmed.reply, /verified, checked 2026-10-14/);
  assert.equal((await db.query("select data_protection from pg1_jurisdictions where code = 'DE'")).rows[0].data_protection.verified, true);
  assert.match((await admin.handleHostingCommand({ text: '/hosting status', ...SUP, fetchImpl, isOperator: false })).reply, /operator only/);
  let started = null;
  const r = await admin.handleHostingCommand({ text: '/hosting research EU adequacy decisions', ...SUP, fetchImpl, isOperator: true, deps: { startLab: async (o) => { started = o; return { ok: true, reply: 'queued' }; } } });
  assert.equal(r.reply, 'queued');
  assert.equal(started.kind, 'research');
  assert.equal(started.action, 'hosting:research');
  assert.match(started.goal, /official sources only/);
});

test('paid on MCP, A2A and REST: with the free tier declined each asks for payment', async () => {
  assert.ok(TOOLS.some((t) => t.name === 'hosting_advisor'));
  assert.ok(A2A_PAID_SKILL_NAMES.includes('hosting_advisor'));
  const m = makeRes();
  await mcpHandler({ method: 'POST', headers: { 'x-forwarded-for': '100.64.3.3', 'x-free-tier': '0' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hosting_advisor', arguments: BASE } } }, m);
  assert.equal(m.body.result.isError, true);
  const a = makeRes();
  await a2aHandler({ method: 'POST', headers: { 'x-forwarded-for': '100.64.3.4', 'x-free-tier': '0' }, query: {}, body: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: 'm', parts: [{ kind: 'data', data: { skill: 'hosting_advisor', arguments: BASE } }] } } } }, a);
  assert.equal(a.body.result.status.state, 'input-required');
  const r = makeRes();
  await restHandler({ method: 'POST', headers: { 'x-forwarded-for': '100.64.3.5', 'x-free-tier': '0' }, body: BASE }, r);
  assert.equal(r.statusCode, 402);
  const bad = makeRes();
  await restHandler({ method: 'POST', headers: {}, body: {} }, bad);
  assert.equal(bad.statusCode, 400);
  await new Promise((done) => setTimeout(done, 100));
});
