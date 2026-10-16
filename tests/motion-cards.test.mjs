// The data behind the lab card (lib/lab/card.mjs) and the threat radar
// (lib/threatRadar.mjs): every pose, fill, stage, blip and count comes from
// the real row or the real read, nothing invented.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labCardView, labStage } from '../lib/lab/card.mjs';
import { buildThreatRadar, threatRadarLead, radarDays, irelandTime, bearing, ring, KEV_URL } from '../lib/threatRadar.mjs';
import { handleLabCommand } from '../lib/lab/chat.mjs';
import { namesProvider } from '../lib/whiteLabel.mjs';

const states = (v) => v.stages.map((s) => s.state);

test('labCardView: the pose follows the status', () => {
  for (const [status, pose] of [['queued', 'queued'], ['running', 'running'], ['done', 'done'], ['failed', 'failed'], ['timeout', 'failed'], ['over_budget', 'over_budget'], ['stopped', 'stopped']]) {
    assert.equal(labCardView({ id: 'a'.repeat(36), status, budget_usd: 2 }).pose, pose, status);
  }
});

test('labCardView: the beaker is spend over the cap, red from 90%', () => {
  assert.deepEqual([labCardView({ spent_usd: 0.5, budget_usd: 2 }).fill, labCardView({ spent_usd: 0.5, budget_usd: 2 }).high], [0.25, false]);
  assert.equal(labCardView({ spent_usd: 1.79, budget_usd: 2 }).high, false);
  assert.equal(labCardView({ spent_usd: 1.8, budget_usd: 2 }).high, true);
  assert.equal(labCardView({ spent_usd: 3, budget_usd: 2 }).fill, 1);
  assert.equal(labCardView({ spent_usd: 1, budget_usd: 0 }).fill, 0);
});

test('labCardView: the stage track shows where the experiment really is', () => {
  assert.deepEqual(states(labCardView({ status: 'queued', kind: 'code' })), ['current', 'todo', 'todo', 'todo']);
  assert.deepEqual(states(labCardView({ status: 'running', kind: 'code' })), ['current', 'todo', 'todo', 'todo']);
  assert.deepEqual(states(labCardView({ status: 'done', kind: 'research' })), ['done', 'skipped', 'skipped', 'skipped']);
  assert.deepEqual(states(labCardView({ status: 'failed', kind: 'code' })), ['failed', 'skipped', 'skipped', 'skipped']);
  assert.deepEqual(states(labCardView({ status: 'done', kind: 'code', candidate: { type: 'code' } })), ['done', 'done', 'todo', 'todo']);
  assert.deepEqual(states(labCardView({ status: 'done', kind: 'code', candidate: {}, gate: { pass: false, pending: true, checks: [] } })), ['done', 'done', 'current', 'todo']);
  assert.deepEqual(states(labCardView({ status: 'done', kind: 'skill', candidate: {}, gate: { pass: true, checks: [] } })), ['done', 'done', 'done', 'done']);
  assert.deepEqual(states(labCardView({ status: 'done', kind: 'skill', candidate: {}, gate: { pass: false, checks: [] } })), ['done', 'done', 'done', 'failed']);
  assert.equal(labStage({}), 'research');
});

test('/lab report and /lab status carry the lab card', async () => {
  const row = { id: '12345678-1111-4111-8111-111111111111', kind: 'research', goal: 'g', status: 'over_budget', budget_usd: 2, spent_usd: 1.95, promoted_stage: 'none', created_at: '2026-10-16T08:00:00Z' };
  const fetchImpl = async (url) => new Response(JSON.stringify([row]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const report = await handleLabCommand({ text: `/lab report ${row.id.slice(0, 8)}`, env: {}, supUrl: 'https://db.test', supKey: 'k', fetchImpl, isOperator: true });
  assert.equal(report.labCards.length, 1);
  assert.equal(report.labCards[0].pose, 'over_budget');
  assert.equal(report.labCards[0].high, true);
  const status = await handleLabCommand({ text: '/lab status', env: {}, supUrl: 'https://db.test', supKey: 'k', fetchImpl, isOperator: true });
  assert.equal(status.labCards[0].id8, '12345678');
});

const NOW = Date.UTC(2026, 9, 16, 8, 46, 0);
const DAY = 86400000;
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
function world({ rows = [], kev = { vulnerabilities: [] }, kevStatus = 200, feedStatus = 200 } = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url) => {
    calls.push(String(url));
    if (String(url) === KEV_URL) return json(kev, kevStatus);
    if (String(url).includes('/rest/v1/threat_ioc_telemetry')) return json(rows, feedStatus);
    return json([], 404);
  } };
}

test('radar: Ireland days, Ireland time, stable bearings, age as distance', () => {
  assert.deepEqual(radarDays(NOW), ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
  assert.equal(irelandTime(NOW), '16 Oct 2026, 09:46');
  assert.equal(bearing('CVE-2026-1234'), bearing('CVE-2026-1234'));
  assert.ok(ring(NOW, NOW) < ring(NOW - 3 * DAY, NOW) && ring(NOW - 3 * DAY, NOW) < ring(NOW - 6 * DAY, NOW));
});

test('radar: findings take their status from the known exploited catalog', async () => {
  const iso = (ms) => new Date(ms).toISOString();
  const rows = [
    { value: 'CVE-2026-0001', indicator_type: 'CVE', verification_source: 'NVD', ingested_at: iso(NOW - 3600e3) },
    { value: 'CVE-2026-0002', indicator_type: 'CVE', verification_source: 'NVD', ingested_at: iso(NOW - 1.5 * DAY) },
    { value: 'bad.example', indicator_type: 'domain', verification_source: 'NVD', ingested_at: iso(NOW - 2 * DAY) },
    { value: 'CVE-2026-0003', indicator_type: 'CVE', verification_source: 'NVD', ingested_at: iso(NOW - 30 * DAY) },
    // a locked source is never shown, even if the query returned it
    { value: 'CVE-2026-0004', indicator_type: 'CVE', verification_source: 'AlienVault OTX', ingested_at: iso(NOW - 3600e3) }
  ];
  const kev = { vulnerabilities: [{ cveID: 'CVE-2026-0002', dateAdded: '2026-10-15' }, { cveID: 'CVE-2026-0009', dateAdded: '2026-10-13' }, { cveID: 'CVE-2020-0001', dateAdded: '2021-01-01' }] };
  const w = world({ rows, kev });
  const v = await buildThreatRadar({ supUrl: 'https://db.test', supKey: 'k', fetchImpl: w.fetchImpl, env: {}, now: NOW });
  const by = Object.fromEntries(v.findings.map((f) => [f.value, f]));
  assert.deepEqual(Object.keys(by).sort(), ['CVE-2026-0001', 'CVE-2026-0002', 'CVE-2026-0009', 'bad.example']);
  assert.equal(by['CVE-2026-0001'].status, 'no_flags');
  assert.equal(by['CVE-2026-0002'].status, 'flagged');
  assert.equal(by['CVE-2026-0002'].kev, true);
  assert.equal(by['CVE-2026-0009'].source, 'CISA KEV');
  assert.equal(by['bad.example'].status, 'unknown');
  assert.deepEqual(v.counts, { flagged: 2, unknown: 1, no_flags: 1 });
  const nvd = v.feeds.find((f) => f.id === 'nvd');
  assert.equal(nvd.total, 3);
  assert.deepEqual(nvd.per_day, [0, 0, 0, 0, 2, 0, 1]);
  assert.deepEqual(v.feeds.find((f) => f.id === 'kev').per_day, [0, 0, 0, 1, 0, 1, 0]);
  assert.equal(v.as_of, '16 Oct 2026, 09:46');
  assert.ok(w.calls.some((u) => u.includes('verification_source')), 'the source policy filter is in the query');
  assert.match(threatRadarLead(v), /data as of 16 Oct 2026, 09:46 \(Ireland\): 4 recent findings, 2 flagged/);
  assert.equal(namesProvider(JSON.stringify(v) + threatRadarLead(v)), false, 'white label: no provider names');
});

test('radar: an unreadable catalog makes CVEs unknown, never no_flags; a failed feed says so', async () => {
  const rows = [{ value: 'CVE-2026-0001', indicator_type: 'CVE', verification_source: 'NVD', ingested_at: new Date(NOW - 3600e3).toISOString() }];
  const v = await buildThreatRadar({ supUrl: 'https://db.test', supKey: 'k', fetchImpl: world({ rows, kevStatus: 503 }).fetchImpl, env: {}, now: NOW });
  assert.equal(v.kev, 'error');
  assert.equal(v.findings[0].status, 'unknown');
  assert.equal(v.feeds.find((f) => f.id === 'kev').error, 'could not be read');
  const down = await buildThreatRadar({ supUrl: 'https://db.test', supKey: 'k', fetchImpl: world({ feedStatus: 500 }).fetchImpl, env: {}, now: NOW });
  assert.equal(down.feeds.find((f) => f.id === 'nvd').error, 'could not be read');
  assert.equal(down.findings.length, 0);
  const none = await buildThreatRadar({ fetchImpl: world().fetchImpl, env: {}, now: NOW });
  assert.equal(none.feeds[0].error, 'not configured on this deployment');
});
