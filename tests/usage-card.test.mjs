// lib/usageCard.mjs (the /usage card's sections and formatting) and
// lib/storageUsage.mjs (its Storage section, read through
// public.pg1_storage_usage()). The page side is in
// tests/browser/usage-card.browser.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDb, pgRest } from './helpers/pgrest.mjs';

const { formatDateTime, formatDateRange, formatDay, relativeTime, formatCount, formatUsd, formatPercent, formatBytes, usageCardView, usageLead, DASH } = await import('../lib/usageCard.mjs');
const { getStorageUsage, shapeStorageUsage, storageLimits } = await import('../lib/storageUsage.mjs');
const { aggregateUsage, usagePeriodRange } = await import('../lib/usageStats.mjs');
const { summarizeOutcome } = await import('../lib/chatTools.mjs');

const ROOT = new URL('..', import.meta.url).pathname;

test('dates: Ireland time, one format, summer and winter; ranges; relative hints', () => {
  assert.equal(formatDateTime(Date.UTC(2026, 9, 15, 8, 46, 31, 999)), '15 Oct 2026, 09:46', 'IST is UTC+1');
  assert.equal(formatDateTime('2026-12-01T08:46:00Z'), '1 Dec 2026, 08:46', 'GMT in winter');
  assert.equal(formatDateTime('2026-09-03T23:30:00Z'), '4 Sep 2026, 00:30', 'the Ireland date, not the UTC one; Sep, not Sept');
  assert.equal(formatDateTime('nonsense'), DASH);
  assert.equal(formatDateRange('2026-10-08T00:00:00+01:00', '2026-10-15T09:46:00+01:00'), '8 Oct – 15 Oct 2026');
  assert.equal(formatDateRange('2025-12-28T12:00:00Z', '2026-01-03T12:00:00Z'), '28 Dec 2025 – 3 Jan 2026');
  assert.equal(formatDateRange('2026-10-14T08:46:00Z', '2026-10-15T08:46:00Z', { withTime: true }), '14 Oct, 09:46 – 15 Oct 2026, 09:46');
  assert.equal(formatDay('2026-10-15'), 'Thu 15 Oct');
  const now = Date.UTC(2026, 9, 15, 12);
  assert.equal(relativeTime(now - 20e3, now), 'just now');
  assert.equal(relativeTime(now - 5 * 60e3, now), '5 min ago');
  assert.equal(relativeTime(now - 2 * 3600e3, now), '2h ago');
  assert.equal(relativeTime(now - 3 * 86400e3, now), '3 days ago');
  assert.equal(relativeTime(now - 60 * 86400e3, now), '');
});

test('numbers: separators, $0.00, one-decimal percentages, sizes; zero is 0 and missing is —', () => {
  assert.equal(formatCount(1234567), '1,234,567');
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(null), DASH);
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(1234.5), '$1,234.50');
  assert.equal(formatUsd(0.004), '<$0.01');
  assert.equal(formatUsd(-0.02), '-$0.02');
  assert.equal(formatPercent(1, 3), '33.3%');
  assert.equal(formatPercent(0, 5), '0.0%');
  assert.equal(formatPercent(3, 0), DASH, 'no denominator');
  assert.equal(formatBytes(900), '900 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(187_400_000), '178.7 MB');
  assert.equal(formatBytes(1024 ** 3), '1.0 GB');
  assert.equal(formatBytes(undefined), DASH);
});

test('the card: six sections in order, no raw JSON, ISO date or provider name; long lists fold', () => {
  const now = Date.UTC(2026, 9, 15, 8, 46);
  const rows = [];
  for (let i = 0; i < 9; i++) rows.push({ created_at: '2026-10-14T10:00:00Z', is_fixture: false, event_type: 'initialize', endpoint: '/api/mcp', client_name: `client-${i}`, caller_hash: String(i).repeat(32), status: 'ok' });
  const r = { ...aggregateUsage(rows, { period: '7d', now }), generated_at: new Date(now).toISOString() };
  const buckets = [{ name: 'pg1-media', bytes: 900 * 1024 ** 2, objects: 3 }, ...Array.from({ length: 6 }, (_, i) => ({ name: `b${i}`, bytes: 10 - i, objects: 1 }))];
  const storage = shapeStorageUsage({ database_bytes: 5 * 1024 ** 2, buckets }, {});
  const view = usageCardView(r, { now, jobs: { summary: [] }, storage });
  assert.deepEqual(view.sections.map((s) => s.title), ['Period', 'Calls and callers', 'Revenue and 402s', 'Top tools', 'Errors', 'Storage']);
  const all = JSON.stringify(view);
  assert.doesNotMatch(all, /\d{4}-\d{2}-\d{2}T|UTC|request_id|supabase|gemini|anthropic|openai/i);
  const period = view.sections[0].groups[0].rows;
  assert.deepEqual(period.map((x) => x.value), ['Last 7 days', '9 Oct – 15 Oct 2026', '15 Oct 2026, 09:46']);
  assert.equal(period[2].at, now, 'the page adds the relative hint from this instant');
  assert.equal(view.sections[1].groups.find((g) => g.title === 'Top clients').rows.length, 5);
  const byBucket = view.sections[5].groups.find((g) => g.title === 'By bucket');
  assert.equal(byBucket.rows.length, 5);
  assert.equal(byBucket.more.length, 2, 'the rest behind "Show 2 more"');
  const jobs = view.sections[2].groups.find((g) => g.title === 'A2A jobs');
  assert.equal(jobs.empty, 'No accepted jobs in this period.');
  const files = view.sections[5].groups.find((g) => !g.title).rows[1];
  assert.deepEqual([files.label, files.value, files.sub, files.bar, files.warn], ['File storage', '900.0 MB', 'of 1.0 GB · 87.9%', 87.9, true]);
  // Over 80%: a warning group comes first.
  const warning = view.sections[5].groups[0];
  assert.equal(warning.title, 'Warning');
  assert.equal(warning.rows[0].label, 'File storage');
  // No storage figures: a plain sentence, not an error dump.
  assert.equal(usageCardView(r, { now, storage: null }).sections[5].groups[0].empty, 'Storage figures are not available right now.');
  // The chat tool's card (no extras) has no Storage section.
  assert.equal(usageCardView(r, { now }).sections.length, 5);
  assert.equal(usageLead(r), '**Usage, last 7 days:** 0 real tool calls from about 0 distinct callers, $0.00 settled. The full breakdown is in the card below.');
  const card = summarizeOutcome({ id: 'u', name: 'get_usage_stats', ok: true, args: { period: '7d' }, result: r, checks: [], request_id: 'x' });
  assert.equal(card.usage.sections.length, 5, 'summarizeOutcome carries the card view');
});

test('per-day buckets and the period start are Ireland days', () => {
  const range = usagePeriodRange('7d', Date.UTC(2026, 9, 13, 23, 30));
  assert.equal(range.from, '2026-10-07T23:00:00.000Z', 'midnight in Dublin (IST)');
  assert.equal(range.days.at(-1), '2026-10-14', '00:30 on 14 Oct in Dublin');
  const winter = usagePeriodRange('7d', Date.UTC(2026, 11, 13, 12));
  assert.equal(winter.from, '2026-12-07T00:00:00.000Z');
  assert.equal(winter.days.length, 7);
});

test('storage: the function returns sizes only, service role only; missing or failing gives null; limits', async () => {
  const sql = readFileSync(`${ROOT}supabase/migrations/20261029120000_pg1_storage_usage.sql`, 'utf8');
  assert.match(sql, /security definer\s+set search_path = ''/);
  assert.match(sql, /revoke all on function public\.pg1_storage_usage\(\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.pg1_storage_usage\(\) to service_role;/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\bname\b(?!', b\.bucket_id)|drop |delete |truncate /i, 'no object names, nothing destructive');
  const db = await makeDb(['20261029120000_pg1_storage_usage.sql']);
  const fetchImpl = pgRest(db, {});
  const empty = await getStorageUsage({ supUrl: 'https://supabase.test', supKey: 'k', fetchImpl, env: {} });
  assert.ok(empty.database_bytes > 0);
  assert.deepEqual(empty.buckets, [], 'no storage schema: no buckets, still the database size');
  await db.exec(`create schema storage; create table storage.objects (bucket_id text, name text, metadata jsonb);
    insert into storage.objects values ('pg1-media', 'secret/path.png', '{"size": 1048576}'), ('pg1-media', 'b', '{"size": 524288}'), ('documents', 'c', '{"size": 100}');`);
  const s = await getStorageUsage({ supUrl: 'https://supabase.test', supKey: 'k', fetchImpl, env: {} });
  assert.deepEqual(s.buckets, [{ name: 'pg1-media', bytes: 1572864, objects: 2 }, { name: 'documents', bytes: 100, objects: 1 }]);
  assert.equal(s.files_bytes, 1572964);
  assert.doesNotMatch(JSON.stringify(s), /secret\/path/);
  assert.equal(await getStorageUsage({ supUrl: '', supKey: '' }), null);
  assert.equal(await getStorageUsage({ supUrl: 'https://x', supKey: 'k', fetchImpl: async () => new Response('{}', { status: 404 }) }), null, 'function not applied yet');
  assert.equal(await getStorageUsage({ supUrl: 'https://x', supKey: 'k', fetchImpl: async () => { throw new Error('down'); } }), null);
  assert.deepEqual(storageLimits({}), { database: 500 * 1024 ** 2, files: 1024 ** 3 });
  assert.deepEqual(storageLimits({ PG1_DB_LIMIT_MB: '8192', PG1_STORAGE_LIMIT_MB: '0' }), { database: 8192 * 1024 ** 2, files: null });
});
