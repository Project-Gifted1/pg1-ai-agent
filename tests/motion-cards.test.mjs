// The data behind the lab card (lib/lab/card.mjs) and the threat radar
// (lib/threatRadar.mjs): every pose, fill, stage, blip and count comes from
// the real row or the real read, nothing invented.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labCardView, labStage, labRequiredStages, clipWords } from '../lib/lab/card.mjs';
import { buildThreatRadar, threatRadarLead, radarDays, irelandTime, bearing, ring, KEV_URL, radarTallyText } from '../lib/threatRadar.mjs';
import { isReservedTestIndicator, rowSource } from '../lib/sourcePolicy.mjs';
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

test('labCardView: each kind has its required stages, and the track always agrees with the status', () => {
  assert.deepEqual(labRequiredStages('research'), ['research']);
  assert.deepEqual(labRequiredStages('skill'), ['build', 'test', 'gate']);
  assert.deepEqual(labRequiredStages('code', 'build x'), ['research', 'build', 'test', 'gate']);
  assert.deepEqual(labRequiredStages('code', '[foundry] tool x'), ['research', 'build', 'test'], 'a Foundry build is gated by /foundry approve');
  // queued: nothing runs yet, so no stage is active
  assert.deepEqual(states(labCardView({ status: 'queued', kind: 'code' })), ['todo', 'todo', 'todo', 'todo']);
  assert.deepEqual(states(labCardView({ status: 'queued', kind: 'research' })), ['todo', 'skipped', 'skipped', 'skipped']);
  assert.equal(labCardView({ status: 'queued', kind: 'code' }).stage, null);
  // running: the first required stage, then test while the gate waits on CI
  assert.deepEqual(states(labCardView({ status: 'running', kind: 'code' })), ['current', 'todo', 'todo', 'todo']);
  assert.deepEqual(states(labCardView({ status: 'running', kind: 'skill' })), ['skipped', 'current', 'todo', 'todo']);
  assert.deepEqual(states(labCardView({ status: 'running', kind: 'code', candidate: { type: 'code' }, gate: { pass: false, pending: true, checks: [] } })), ['done', 'done', 'current', 'todo']);
  // done: every required stage done, for every kind
  assert.deepEqual(states(labCardView({ status: 'done', kind: 'research' })), ['done', 'skipped', 'skipped', 'skipped']);
  assert.deepEqual(states(labCardView({ status: 'done', kind: 'code', candidate: { type: 'code' }, gate: { pass: true, checks: [] } })), ['done', 'done', 'done', 'done']);
  assert.deepEqual(states(labCardView({ status: 'done', kind: 'skill', candidate: {}, gate: { pass: true, checks: [] } })), ['skipped', 'done', 'done', 'done']);
  // even a done row with no candidate shows all its stages done, never
  // "research and build green" under a done status
  assert.deepEqual(states(labCardView({ status: 'done', kind: 'code' })), ['done', 'done', 'done', 'done']);
  // failed: the stage named in the error, the earlier ones done, the rest
  // not reached (empty dots, never "skipped")
  assert.deepEqual(states(labCardView({ status: 'failed', kind: 'code', error: 'research: the model returned no findings (empty answer)' })), ['failed', 'todo', 'todo', 'todo']);
  assert.deepEqual(states(labCardView({ status: 'failed', kind: 'code', error: 'build: Refused: blocked path' })), ['done', 'failed', 'todo', 'todo']);
  assert.deepEqual(states(labCardView({ status: 'failed', kind: 'code', error: 'test: the lab test run failed' })), ['done', 'done', 'failed', 'todo']);
  assert.deepEqual(states(labCardView({ status: 'failed', kind: 'skill', candidate: {}, gate: { pass: false, checks: [{ name: 'evals', ok: false }] }, error: 'gate: evals' })), ['skipped', 'done', 'done', 'failed']);
  assert.deepEqual(states(labCardView({ status: 'failed', kind: 'code', error: 'no result from the runner: no artifact' })), ['failed', 'todo', 'todo', 'todo']);
  assert.deepEqual(states(labCardView({ status: 'over_budget', kind: 'code', error: 'build: the next call could cost up to $0.30' })), ['done', 'failed', 'todo', 'todo']);
  assert.deepEqual(states(labCardView({ status: 'stopped', kind: 'code' })), ['todo', 'todo', 'todo', 'todo']);
  assert.equal(labStage({}), 'research');
});

test('labCardView: "over budget" only past the budget; a stop below it is "near budget" with its threshold', () => {
  const near = labCardView({ id: '55555555-1111-4111-8111-111111111111', kind: 'research', status: 'over_budget', spent_usd: 1.94, budget_usd: 2, budget_stop: { spent_usd: 1.94, next_call_worst_usd: 0.07, threshold_usd: 1.93, budget_usd: 2 } });
  assert.equal(near.label, 'near budget');
  assert.equal(near.threshold_usd, 1.93);
  assert.equal(near.pose, 'over_budget');
  assert.equal(labCardView({ status: 'over_budget', spent_usd: 1.94, budget_usd: 2 }).label, 'near budget', 'no stored threshold: still not "over"');
  assert.equal(labCardView({ status: 'over_budget', spent_usd: 2.05, budget_usd: 2 }).label, 'over budget');
  assert.equal(labCardView({ status: 'over_budget', spent_usd: 2, budget_usd: 2 }).label, 'near budget', 'exactly at the budget is not over it');
  assert.equal(labCardView({ status: 'done', spent_usd: 1, budget_usd: 2 }).threshold_usd, null);
});

test('labCardView: titles are cut on a word with an ellipsis; /lab status cards carry their own Report (and Stop) buttons', () => {
  assert.equal(clipWords('Prototype sanitized demand tracking for MCP queries (aggregated counters per tool)', 60), 'Prototype sanitized demand tracking for MCP queries…');
  assert.equal(clipWords('short goal', 60), 'short goal');
  const long = labCardView({ id: 'e2f6594e-bc44-4c68-89ed-b917d2ea96e3', goal: `${'word '.repeat(40)}end`, status: 'done' });
  assert.ok(long.goal.endsWith('…') && long.goal.length <= 120 && !/\bwor…$/.test(long.goal));
  assert.equal(labCardView({ id: 'e2981021-4070-40fd-b160-e012feec0449', status: 'done' }).actions, undefined, 'no buttons unless asked');
  assert.deepEqual(labCardView({ id: 'e2981021-4070-40fd-b160-e012feec0449', status: 'done' }, { actions: true }).actions, [{ label: 'Lab report e2981021', command: '/lab report e2981021' }]);
  assert.deepEqual(labCardView({ id: '7c1d22aa-4070-40fd-b160-e012feec0449', status: 'running' }, { actions: true }).actions.map((a) => a.command), ['/lab report 7c1d22aa', '/lab stop 7c1d22aa']);
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
    // a test fixture (reserved domain) never reaches live findings
    { value: 'evil.example', indicator_type: 'domain', verification_source: 'NVD', ingested_at: iso(NOW - 2 * DAY) },
    { value: 'https://bad.test/x', indicator_type: 'url', verification_source: 'NVD', ingested_at: iso(NOW - 2 * DAY) },
    // a domain labelled NVD is not NVD's (NVD publishes CVE records only):
    // attributed to no feed, so not served while "other" sources are off
    { value: '198.18.0.7', indicator_type: 'IPv4', verification_source: 'NVD', ingested_at: iso(NOW - 2 * DAY) },
    { value: 'CVE-2026-0003', indicator_type: 'CVE', verification_source: 'NVD', ingested_at: iso(NOW - 30 * DAY) },
    // a locked source is never shown, even if the query returned it
    { value: 'CVE-2026-0004', indicator_type: 'CVE', verification_source: 'AlienVault OTX', ingested_at: iso(NOW - 3600e3) }
  ];
  const kev = { vulnerabilities: [{ cveID: 'CVE-2026-0002', dateAdded: '2026-10-15' }, { cveID: 'CVE-2026-0009', dateAdded: '2026-10-13' }, { cveID: 'CVE-2020-0001', dateAdded: '2021-01-01' }] };
  const w = world({ rows, kev });
  const v = await buildThreatRadar({ supUrl: 'https://db.test', supKey: 'k', fetchImpl: w.fetchImpl, env: {}, now: NOW });
  const by = Object.fromEntries(v.findings.map((f) => [f.value, f]));
  assert.deepEqual(Object.keys(by).sort(), ['CVE-2026-0001', 'CVE-2026-0002', 'CVE-2026-0009']);
  assert.equal(by['CVE-2026-0001'].status, 'no_flags');
  assert.equal(by['CVE-2026-0002'].status, 'flagged');
  assert.equal(by['CVE-2026-0002'].kev, true);
  assert.equal(by['CVE-2026-0009'].source, 'CISA KEV');
  assert.equal(by['CVE-2026-0001'].source, 'NVD');
  assert.deepEqual(v.counts, { flagged: 2, unknown: 0, no_flags: 1 });
  const nvd = v.feeds.find((f) => f.id === 'nvd');
  assert.equal(nvd.total, 2);
  assert.deepEqual(nvd.per_day, [0, 0, 0, 0, 1, 0, 1]);
  // The feeds' totals and the findings reconcile: CVE-2026-0002 is in NVD
  // and on the KEV catalog, one finding.
  assert.deepEqual(v.tally, { feed_items: 4, unique: 3, in_several_feeds: 1, repeats: 0, shown: 3 });
  assert.equal(v.tally_text, '4 new items in the feeds, 3 unique: 1 was in more than one feed.');
  assert.deepEqual(v.feeds.find((f) => f.id === 'kev').per_day, [0, 0, 0, 1, 0, 1, 0]);
  assert.equal(v.as_of, '16 Oct 2026, 09:46');
  assert.ok(w.calls.some((u) => u.includes('verification_source')), 'the source policy filter is in the query');
  assert.match(threatRadarLead(v), /data as of 16 Oct 2026, 09:46 \(Ireland\): 3 recent findings, 2 flagged/);
  assert.ok(!JSON.stringify(v).includes('.example') && !JSON.stringify(v).includes('bad.test'), 'no fixture domain anywhere in the view');
  // With "other" sources switched on, the mislabelled row is shown under
  // its real attribution, never as NVD.
  const other = await buildThreatRadar({ supUrl: 'https://db.test', supKey: 'k', fetchImpl: world({ rows, kev }).fetchImpl, env: { SOURCE_OTHER_ENABLED: 'true' }, now: NOW });
  assert.equal(other.findings.find((f) => f.value === '198.18.0.7').source, 'Other sources');
  assert.equal(other.feeds.find((f) => f.id === 'nvd').total, 2, 'NVD counts only what NVD published');
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

test('fixture indicators are recognised wherever they appear; a label is believed only for what that feed publishes', () => {
  for (const v of ['evil.example', 'agent.evil.example', 'https://evil.example/path', 'x@evil.example', 'example.com', 'www.example.org', 'pg1-test-flagged.invalid', 'a.test', 'localhost', '192.0.2.10', '198.51.100.3', '203.0.113.9', '2001:db8::1', 'CVE-0000-0001', '0x7067312d746573742d6669787475726500000001']) assert.equal(isReservedTestIndicator(v), true, v);
  for (const v of ['CVE-2026-41001', 'nvd.nist.gov', 'examples.com', 'example.co.uk', 'testing.io', '8.8.8.8', '198.18.0.7', '0xabc']) assert.equal(isReservedTestIndicator(v), false, v);
  assert.equal(rowSource({ value: 'CVE-2026-1234', verification_source: 'NVD' }), 'nvd');
  assert.equal(rowSource({ value: 'evil.example', verification_source: 'NVD' }), 'other');
  assert.equal(rowSource({ value: '1.2.3.4', verification_source: 'Blocklist.de' }), 'blocklist_de');
});

test('radar tally: equal counts say so; duplicates and repeats are explained; a cap is named', () => {
  assert.equal(radarTallyText({ feed_items: 0, unique: 0 }), '');
  assert.equal(radarTallyText({ feed_items: 5, unique: 5, in_several_feeds: 0, repeats: 0, shown: 5 }), '5 new items in the feeds, each a finding.');
  assert.equal(radarTallyText({ feed_items: 12, unique: 10, in_several_feeds: 2, repeats: 0, shown: 10 }), '12 new items in the feeds, 10 unique: 2 were in more than one feed.');
  assert.equal(radarTallyText({ feed_items: 40, unique: 30, in_several_feeds: 1, repeats: 9, shown: 24 }), '40 new items in the feeds, 30 unique: 1 was in more than one feed, 9 were repeats within a feed. Showing the newest 24.');
});
