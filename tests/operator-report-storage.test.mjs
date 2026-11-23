/**
 * The operator reports through the REAL save / load path (fix for the
 * 22 Nov 2026 daily report, whose card showed only section titles).
 *
 * The cause: lib/operator/store.mjs addReport scrubbed the card with
 * scrubDeep (lib/autonomous/state.mjs), which keeps 4 levels and stores
 * anything deeper as null. A card is card > sections > section > groups >
 * group > rows, so every group's rows and empty text were saved as null and
 * the page drew only the headings. Fixed with a report-card depth
 * (REPORT_CARD_DEPTH); cards already saved that way are shown with the full
 * report text instead.
 *
 * Here a daily and a weekly report are saved with createOperatorStore into
 * the real pg1_operator_reports table (Postgres via PGlite behind a
 * PostgREST stand-in) and read back the three ways the app reads them (the
 * chat inbox, /report, the latest report): every section's rows, the
 * empty-state texts and the approvals survive, and the card is identical to
 * the one built. The PDF copy has every line, identifiers included.
 * Run with: node --test tests/operator-report-storage.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, pgRest } from './helpers/pgrest.mjs';
import { pdfText } from './helpers/pdfText.mjs';
import { createOperatorStore, reportCardFromRow, reportCardDamaged, REPORT_CARD_DEPTH } from '../lib/operator/store.mjs';
import { buildDailyReport, buildWeeklyReport, publishReport } from '../lib/operator/reports.mjs';
import { reportCardResult } from '../lib/operator/chat.mjs';
import { scrubDeep } from '../lib/autonomous/state.mjs';
import { renderPdf } from '../lib/pdf/render.mjs';

const SUP = 'https://supabase.test';
const NOW = Date.UTC(2026, 10, 22, 7, 15);
const iso = (ms) => new Date(ms).toISOString();
const APPROVALS = [
  { id: '11111111-1111-4111-8111-111111111111', source: 'task', kind: 'listing', title: 'MCP registry lists 1.20.0; live is 1.22.0', reason: 'Listing out of date.', approvable: true },
  { id: '22222222-2222-4222-8222-222222222222', source: 'task', kind: 'pricing', title: 'Review the price of check_wallet_age', reason: 'worst-case cost per call is not known', approvable: false },
  { id: '33333333-3333-4333-8333-333333333333', source: 'action', kind: 'self_heal', title: 'Self-heal draft PR #402', reason: 'CI run failed', approvable: true }
];

function daily(over = {}) {
  return {
    kind: 'daily', now: NOW, from: iso(NOW - 86400000), to: iso(NOW), mode: 'on',
    usage: { ok: true, yesterday: { day: '2026-11-21', real: 126, probe: 40 }, previous: { day: '2026-11-20', real: 125, probe: 30 }, avg7: 90.9, avg7_days: 7 },
    last24: { ok: true, summary: { real_tool_calls: 126, distinct_real_callers_estimate: 3 }, payments: { payment_requests: 25, payments_settled: 2, revenue_usd: 0.02 }, errors: { by_fault: { pg1: 6, caller: 1, unclassified: 0 } }, own: {} },
    chain: { ok: false, reason: 'the chain check is not on this deployment' },
    deploys: { ok: true, list: [{ id: 'dpl_1', state: 'READY', created_at: iso(NOW - 3600000), message: 'Fix check_wallet_age errors (#410)' }] },
    autonomy: { ok: true, rows: [{ actor: 'pg1', action: 'code:merge_low_risk', decision: 'allowed' }] },
    autonomous: { ok: true, rows: [{ type: 'lab_autopilot', status: 'done', result: 'started an experiment' }] },
    plans: { ok: true, tasks: [{ kind: 'fix', title: 'Fix check_wallet_age: 6 upstream_error errors', status: 'lab_running' }] },
    approvals: { ok: true, list: APPROVALS },
    ...over
  };
}

function weekly(over = {}) {
  return {
    kind: 'weekly', now: NOW, from: iso(NOW - 7 * 86400000), to: iso(NOW), mode: 'on',
    trend: { ok: true, week: { real: 700, probe: 90, days: 7 }, previous: { real: 600, days: 7 } },
    demand: { ok: true, unknown_tools: [{ name: 'get_token_risk', real: 4, probe: 2 }], unknown_methods: [{ method: 'server/discover', real: 4, probe: 0 }], a2a: { real: 3, probe: 1 } },
    funnel: { ok: true, free_checks_used: 300, callers_hit_free_limit: 4, payment_requests: 25, payments_settled: 2, revenue_usd: 0.02 },
    discovery: { agent_card_fetches: { ok: true, count: 42 }, registry: { ok: true, listed: '1.20.0', live: '1.22.0', matches: false } },
    experiments: { ok: true, list: [{ kind: 'code', goal: 'Fix check_wallet_age', status: 'done', gate: { pass: true } }] },
    proposals: { ok: true, list: [] },
    tasks: { ok: true, list: [] },
    approvals: { ok: true, list: APPROVALS },
    ...over
  };
}

async function realStore() {
  const db = await makeDb(['20261104120000_pg1_autonomous.sql', '20261113120000_pg1_operator.sql']);
  return { db, store: createOperatorStore({ supUrl: SUP, supKey: 'k', fetchImpl: pgRest(db, { base: SUP }) }) };
}

// The card the page draws, as JSON (what the browser receives).
const asJson = (x) => JSON.parse(JSON.stringify(x));

function assertCardsMatch(loaded, built, label) {
  assert.deepEqual(asJson(loaded), asJson({ ...built.card, approvals: built.approvals }), `${label}: the reloaded card is the card that was built`);
  for (const sec of loaded.sections) {
    assert.ok(Array.isArray(sec.groups) && sec.groups.length, `${label}/${sec.id}: groups`);
    for (const g of sec.groups) {
      assert.ok(Array.isArray(g.rows), `${label}/${sec.id}: rows is an array`);
      assert.ok(g.rows.length || g.empty, `${label}/${sec.id}: rows or an empty-state text`);
      for (const r of g.rows) assert.ok(typeof r.label === 'string' && typeof r.value === 'string', `${label}/${sec.id}: row label and value`);
    }
  }
}

test('the cause: the old depth limit stores every group\'s rows as null; the report depth keeps them', () => {
  const built = buildDailyReport(daily());
  const old = scrubDeep(built.card);
  assert.equal(old.sections[0].groups[0].rows, null, 'scrubDeep(card) with its default depth loses the rows');
  assert.equal(reportCardDamaged(old), true);
  const kept = scrubDeep(built.card, [], 0, REPORT_CARD_DEPTH);
  assert.deepEqual(asJson(kept), asJson(built.card));
  assert.equal(reportCardDamaged(kept), false);
});

test('daily report: saved and reloaded through the real table, every row, empty text and approval survives', async () => {
  const { store } = await realStore();
  const built = buildDailyReport(daily());
  const saved = await store.addReport({ kind: 'daily', period_start: iso(NOW - 86400000), period_end: iso(NOW), title: built.title, markdown: built.markdown, card: built.card, approvals: built.approvals });
  assert.ok(saved.id);
  // The chat inbox (api/watches.mjs auto_inbox).
  const [inbox] = await store.undeliveredReports(5);
  const fromInbox = reportCardFromRow(inbox);
  assert.equal(fromInbox.damaged, false);
  assertCardsMatch(fromInbox.card, built, 'inbox');
  assert.deepEqual(fromInbox.card.sections.map((s) => s.title), ['Usage (real)', 'Payments (24 h)', 'Errors by fault (24 h)', 'Deploys (24 h)', 'PG1 on its own (24 h)', 'Next']);
  assert.equal(fromInbox.card.sections.find((s) => s.id === 'usage').groups[0].rows[0].value, '126');
  assert.equal(fromInbox.card.sections.find((s) => s.id === 'next').groups[0].rows[0].label, 'Fix check_wallet_age: 6 upstream_error errors');
  assert.equal(fromInbox.card.approvals.length, 3);
  assert.equal(fromInbox.card.approvals[1].approvable, false);
  assert.equal(fromInbox.card.approvals_status, 'ok');
  // /report today (lib/operator/chat.mjs) and the latest report.
  const latest = await store.latestReport('daily');
  assertCardsMatch(reportCardResult(latest).usage, built, '/report');
  assert.equal(latest.markdown, built.markdown);
});

test('daily report with empty sections and approvals not read: the empty-state texts survive', async () => {
  const { store } = await realStore();
  const built = buildDailyReport(daily({
    deploys: { ok: true, list: [] },
    plans: { ok: true, tasks: [] },
    usage: { ok: false, reason: 'the usage report could not be read' },
    approvals: { ok: false, reason: 'the approvals could not be read' }
  }));
  await store.addReport({ kind: 'daily', period_start: iso(NOW - 86400000), period_end: iso(NOW), title: built.title, markdown: built.markdown, card: built.card, approvals: built.approvals });
  const { card } = reportCardFromRow((await store.undeliveredReports(5))[0]);
  assertCardsMatch(card, built, 'empty');
  const group = (id) => card.sections.find((s) => s.id === id).groups[0];
  assert.equal(group('deploys').empty, 'No production deploys.');
  assert.deepEqual(group('deploys').rows, []);
  assert.equal(group('next').empty, 'No open tasks.');
  assert.equal(group('usage').rows[0].value, 'not read');
  assert.equal(card.approvals_status, 'not_read');
  assert.equal(card.approvals_reason, 'the approvals could not be read');
  assert.deepEqual(card.approvals, []);
});

test('weekly report: saved and reloaded, every section\'s rows, "None this week." and approvals survive', async () => {
  const { store } = await realStore();
  const built = buildWeeklyReport(weekly({ experiments: { ok: true, list: [] } }));
  await store.addReport({ kind: 'weekly', period_start: iso(NOW - 7 * 86400000), period_end: iso(NOW), title: built.title, markdown: built.markdown, card: built.card, approvals: built.approvals });
  const row = await store.latestReport('weekly');
  const { card, damaged } = reportCardFromRow(row);
  assert.equal(damaged, false);
  assertCardsMatch(card, built, 'weekly');
  assert.equal(card.sections.find((s) => s.id === 'experiments').groups[0].empty, 'None this week.');
  assert.equal(card.sections.find((s) => s.id === 'discovery').groups[0].rows[0].value, '42');
  assert.equal(card.approvals.length, 3);
});

test('publishReport saves the card the same way (the scheduled path)', async () => {
  const { store } = await realStore();
  const data = daily();
  const built = buildDailyReport(data);
  const out = await publishReport({ built, data, opStore: store, makePdf: async () => null, push: null });
  assert.ok(out.id);
  assertCardsMatch(reportCardFromRow((await store.undeliveredReports(5))[0]).card, built, 'publish');
});

test('a card saved before the fix is shown with the full report text, never as bare headings', async () => {
  const { db, store } = await realStore();
  const built = buildDailyReport(daily());
  // Exactly what the old addReport stored.
  await db.query(`insert into public.pg1_operator_reports (kind, period_start, period_end, title, markdown, card, approvals) values ('daily', $1, $2, $3, $4, $5, $6)`, [iso(NOW - 86400000), iso(NOW), built.title, built.markdown, JSON.stringify(scrubDeep(built.card)), JSON.stringify(scrubDeep(built.approvals))]);
  const row = (await store.undeliveredReports(5))[0];
  const { card, damaged } = reportCardFromRow(row);
  assert.equal(damaged, true);
  assert.deepEqual(card.sections, [], 'no headings without rows');
  assert.equal(card.approvals.length, 3, 'the approvals (own column) were never lost');
  assert.match(card.note, /full report is in the text/);
});

test('the PDF copy in the media library has every line of the report, identifiers included', async () => {
  for (const built of [buildDailyReport(daily()), buildWeeklyReport(weekly())]) {
    const r = await renderPdf({ title: built.title, subtitle: built.kind === 'daily' ? 'Daily report' : 'Weekly report', markdown: built.markdown.replace(/^# [^\n]*\n/, '') });
    assert.equal(r.truncated, false);
    const { text } = await pdfText(r.bytes);
    // Compared without spaces: the PDF lays out code runs as separate words.
    const flat = text.replace(/\s+/g, '');
    const lines = built.markdown.split('\n').slice(1).filter((l) => l.trim()).map((l) => l.replace(/^#+ |^\s*- /, '').replace(/[`*]/g, '').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)').replace(/\s+/g, ' ').trim());
    const missing = lines.filter((l) => !flat.includes(l.replace(/\s+/g, '')));
    assert.deepEqual(missing, [], `${built.kind}: lines missing from the PDF`);
    assert.ok(flat.includes('check_wallet_age'), 'underscores in identifiers are kept (not read as italics)');
  }
});

test('the daily report\'s errors section names the telemetry rows dropped (or "not read"), and it survives a save', async () => {
  const { store } = await realStore();
  const built = buildDailyReport(daily({ telemetryDrops: { ok: true, rows: 4, records: 2, first: '2026-11-22T10:02:00Z', last: '2026-11-22T10:20:00Z' } }));
  assert.match(built.markdown, /- Telemetry rows dropped: 4 \(between 22 Nov 10:02 and 22 Nov 10:20; usage figures are short by that many rows\)/);
  await store.addReport({ kind: 'daily', period_start: iso(NOW - 86400000), period_end: iso(NOW), title: built.title, markdown: built.markdown, card: built.card, approvals: built.approvals });
  const { card } = reportCardFromRow((await store.undeliveredReports(5))[0]);
  const drop = card.sections.find((s) => s.id === 'errors').groups[0].rows.find((r) => r.label === 'Telemetry rows dropped');
  assert.equal(drop.value, '4');
  assert.equal(drop.warn, true);
  const none = buildDailyReport(daily({ telemetryDrops: { ok: true, rows: 0, records: 0, first: null, last: null } }));
  assert.match(none.markdown, /- Telemetry rows dropped: none/);
  const unread = buildDailyReport(daily({ telemetryDrops: { ok: false, reason: 'the drop log is not set up yet (migration 20261123120000)' } }));
  assert.match(unread.markdown, /- Telemetry rows dropped: not read \(the drop log is not set up yet/);
});
