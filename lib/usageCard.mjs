// The /usage card (and the get_usage_stats card in chat): one card in
// sections, built here from a lib/usageStats.mjs report and drawn by the
// page (public/index.html, usageCardHtml) as two-column rows. Everything
// is formatted here so the page shows one style everywhere:
//
//   dates    Ireland time (Europe/Dublin): "15 Oct 2026, 09:46"; ranges
//            "8 Oct – 15 Oct 2026"; the "Updated" row carries its instant so
//            the page can add "2h ago". No ISO strings, UTC or milliseconds.
//   numbers  thousands separators; money $1,234.56 (under a cent: <$0.01);
//            percentages to one decimal; a count of zero is "0", a figure
//            that does not exist (no denominator, not measured) is "—".
//   sizes    B, KB, MB, GB with one decimal (1024-based), "used of limit",
//            a percentage and a bar where a limit exists.
//
// Sections, in order: period, calls and callers, revenue and 402s, top
// tools, errors, storage. A section's rows are { label, value, sub?, mono?,
// bar?, tag? }; long lists keep their first rows and put the rest behind
// "Show N more". No raw JSON, request ids or provider names reach the card;
// client and unknown tool names are untrusted text (reduced before storage)
// and are escaped by the page.

import { usagePeriodText, USAGE_TIME_ZONE } from './usageStats.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DASH = '—';
const LIST_ROWS = 5;

const parts = new Intl.DateTimeFormat('en-GB', { timeZone: USAGE_TIME_ZONE, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function dublin(ms) {
  const p = Object.fromEntries(parts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month) - 1, d: Number(p.day), hh: p.hour, mm: p.minute };
}
const toMs = (v) => (typeof v === 'number' ? v : Date.parse(v));

// "15 Oct 2026, 09:46" (Ireland time).
export function formatDateTime(value) {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return DASH;
  const t = dublin(ms);
  return `${t.d} ${MONTHS[t.m]} ${t.y}, ${t.hh}:${t.mm}`;
}

// "8 Oct – 15 Oct 2026"; across years "28 Dec 2025 – 3 Jan 2026"; with
// times (a 24-hour period) "14 Oct, 09:46 – 15 Oct 2026, 09:46".
export function formatDateRange(from, to, { withTime = false } = {}) {
  const a = toMs(from);
  const b = toMs(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return DASH;
  const x = dublin(a);
  const y = dublin(b);
  const day = (t, year) => `${t.d} ${MONTHS[t.m]}${year ? ` ${t.y}` : ''}`;
  const time = (t) => (withTime ? `, ${t.hh}:${t.mm}` : '');
  return `${day(x, x.y !== y.y)}${time(x)} – ${day(y, true)}${time(y)}`;
}

// "Wed 8 Oct" for a per-day row (the day key is an Ireland date).
export function formatDay(isoDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDay || ''));
  if (!m) return DASH;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

// "just now", "5 min ago", "2h ago", "3 days ago"; beyond 30 days, nothing.
export function relativeTime(value, now = Date.now()) {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const days = Math.floor(s / 86400);
  return days <= 30 ? `${days} day${days === 1 ? '' : 's'} ago` : '';
}

const intFmt = new Intl.NumberFormat('en-IE', { maximumFractionDigits: 0 });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function formatCount(v) {
  return isNum(v) ? intFmt.format(Math.round(v)) : DASH;
}

const usdFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function formatUsd(v) {
  if (!isNum(v)) return DASH;
  if (v !== 0 && Math.abs(v) < 0.005) return `${v < 0 ? '-' : ''}<$0.01`;
  return `${v < 0 ? '-' : ''}$${usdFmt.format(Math.abs(v))}`;
}

// part / whole as "42.0%"; no whole (0 or missing) is "—".
export function formatPercent(part, whole) {
  if (!isNum(part) || !isNum(whole) || whole <= 0) return DASH;
  return `${((part / whole) * 100).toFixed(1)}%`;
}

export function formatBytes(v) {
  if (!isNum(v) || v < 0) return DASH;
  if (v < 1024) return `${Math.round(v)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = v / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

const plural = (n, one, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;
const num = (v) => (isNum(v) ? v : 0);
const row = (label, value, extra = {}) => ({ label, value, ...extra });
const realProbe = (s) => `real ${formatCount(num(s && s.real))} · probe ${formatCount(num(s && s.probe))}`;
const ACRONYMS = /\b(cve|pdf|a2a|ioc|ip|mcp|url|api|stix)\b/gi;
const readable = (s) => { const t = String(s || '').replace(/_/g, ' ').trim().replace(ACRONYMS, (m) => m.toUpperCase()); return t ? t[0].toUpperCase() + t.slice(1) : DASH; };

// A list group: the first LIST_ROWS rows, the rest behind "Show N more".
function listGroup(title, rows, empty) {
  if (!rows.length) return { title, rows: [], empty };
  return { title, rows: rows.slice(0, LIST_ROWS), more: rows.slice(LIST_ROWS) };
}

function periodSection(r, now) {
  const p = r.period || '7d';
  const words = usagePeriodText(p);
  const updated = toMs(r.generated_at || r.to || now);
  return {
    id: 'period',
    title: 'Period',
    groups: [{ rows: [
      row('Window', (w => w[0].toUpperCase() + w.slice(1))(words.replace(/^the /, ''))),
      row('Dates', formatDateRange(r.from, r.to, { withTime: p === '24h' })),
      row('Updated', formatDateTime(updated), { at: Number.isFinite(updated) ? updated : undefined })
    ] }]
  };
}

function callsSection(r) {
  const s = r.summary || {};
  const t = r.traffic || {};
  const reasons = t.probe_callers_by_reason || {};
  const probeTotal = num(reasons.known_crawler) + num(reasons.unknown_tools_only) + num(reasons.probe_only_activity);
  const main = [
    row('Real tool calls', formatCount(num(s.real_tool_calls))),
    row('Distinct real callers', `about ${formatCount(num(s.distinct_real_callers_estimate))}`, { sub: 'estimate from hashed IPs' }),
    row('MCP requests', formatCount(num(t.mcp_requests && t.mcp_requests.total)), { sub: realProbe(t.mcp_requests) }),
    row('Tool calls, all routes', formatCount(num(t.tool_calls && t.tool_calls.total)), { sub: realProbe(t.tool_calls) })
  ];
  if (probeTotal) {
    const bits = [['known_crawler', 'crawlers'], ['probe_only_activity', 'listing only'], ['unknown_tools_only', 'unknown tools only']]
      .filter(([k]) => num(reasons[k])).map(([k, label]) => `${label} ${formatCount(num(reasons[k]))}`);
    main.push(row('Probe callers', formatCount(probeTotal), { sub: bits.join(' · ') }));
  }
  const groups = [{ rows: main }];
  groups.push(listGroup('By route', (t.by_route || []).map((x) => row(x.route, formatCount(num(x.requests)), { mono: true, sub: plural(num(x.tool_calls), 'tool call') })), 'No requests.'));
  const days = Array.isArray(t.per_day) ? t.per_day : [];
  if (days.length) {
    const dayRows = [...days].reverse().map((d) => row(formatDay(d.day), formatCount(num(d.real) + num(d.probe)), { sub: realProbe(d), tag: d.spike ? 'spike' : undefined }));
    const g = days.length > 7 ? { title: 'Per day', rows: dayRows.slice(0, 7), more: dayRows.slice(7) } : { title: 'Per day', rows: dayRows };
    g.note = `Newest first. A spike is a day over ${formatCount(num(t.spike_threshold))} requests (3× the median).`;
    groups.push(g);
  }
  groups.push(listGroup('Top clients', (r.clients || []).map((c) => row(c.name, plural(num(c.requests), 'request'), { mono: true, sub: `${plural(num(c.tool_calls), 'tool call')}${c.class === 'probe' ? ' · probe' : ''}` })), 'No client names reported.'));
  return { id: 'calls', title: 'Calls and callers', groups };
}

function revenueSection(r, jobs) {
  const p = r.payments || {};
  const main = [
    row('Settled revenue', formatUsd(num(p.revenue_usd)), { sub: plural(num(p.payments_settled), 'payment') }),
    row('Payment requests (402)', formatCount(num(p.payment_requests))),
    row('Paid after a 402', formatPercent(num(p.payments_settled), num(p.payment_requests))),
    row('Free checks used', formatCount(num(p.free_checks_used)), { sub: `free tools ${formatCount(num(p.free_tool_calls))} · free tier ${formatCount(num(p.free_tier_calls))}` }),
    row('Hit the free limit', plural(num(p.callers_hit_free_limit), 'caller')),
    row('Shown a 402, never paid', plural(num(p.callers_challenged_never_served), 'caller'))
  ];
  if (num(p.settlement_failures)) main.push(row('Failed settlements', formatCount(num(p.settlement_failures))));
  if (num(p.ioc_feed_x402_calls)) main.push(row('Feed calls paid with x402', formatCount(num(p.ioc_feed_x402_calls)), { sub: 'settled separately, not in revenue above' }));
  const groups = [{ rows: main }];
  if (jobs) {
    if (jobs.error) groups.push({ title: 'A2A jobs', rows: [], empty: 'Job figures could not be read right now.' });
    else {
      const summary = Array.isArray(jobs.summary) ? jobs.summary : [];
      groups.push(listGroup('A2A jobs', summary.map((j) => row(readable(j.job_type), formatUsd(j.revenue_usd), {
        sub: `${plural(j.jobs, 'job')} · ${j.success_rate == null ? `${DASH} success` : `${(j.success_rate * 100).toFixed(1)}% success`} · margin ${formatUsd(j.margin_usd)}`
      })), 'No accepted jobs in this period.'));
    }
  }
  return { id: 'revenue', title: 'Revenue and 402s', groups };
}

function toolsSection(r) {
  const realCalls = num(r.summary && r.summary.real_tool_calls);
  const groups = [listGroup(null, (r.tools || []).map((x) => row(x.tool, formatCount(num(x.calls)), { mono: true, sub: `${x.pricing === 'free' ? 'free' : 'paid'} · ${formatPercent(num(x.calls), realCalls)} of real calls` })), 'No real tool calls in this period.')];
  const sb = r.served_by;
  if (sb) groups.push({ title: 'Served', rows: [row('Free', formatCount(num(sb.free))), row('Free tier', formatCount(num(sb.free_tier))), row('Paid', formatCount(num(sb.paid)))] });
  const ioc = r.ioc_lookups;
  if (ioc && num(ioc.total)) groups[groups.length - 1].rows.push(row('Indicator lookups with a record', `${formatCount(num(ioc.found))} of ${formatCount(num(ioc.total))}`));
  return { id: 'tools', title: 'Top tools', groups };
}

function errorsSection(r) {
  const e = r.errors || {};
  const f = e.by_fault || {};
  const main = [row('Errors', formatCount(num(e.total)), { sub: realProbe(e.by_class) }), row('Rate limited', formatCount(num(e.rate_limited)))];
  const groups = [{ rows: main }];
  if (num(e.total)) {
    const fault = [row('PG1 or its sources', formatCount(num(f.pg1))), row('Caller input', formatCount(num(f.caller)))];
    if (num(f.unclassified)) fault.push(row('Unclassified', formatCount(num(f.unclassified))));
    groups.push({ title: 'Whose fault', rows: fault });
  }
  if (num(e.total)) groups.push(listGroup('Top errors', (e.breakdown || []).map((x) => row(x.tool, formatCount(num(x.errors)), { mono: !String(x.tool).startsWith('('), sub: `${readable(x.type).toLowerCase()} · ${realProbe(x)}` })), 'None.'));
  const u = e.unknown_tool_calls || {};
  if (num(u.total)) {
    const g = listGroup('Unknown tools asked for', (e.unrecognised_tools || []).map((x) => row(x.name, formatCount(num(x.count)), { mono: true })), 'None named.');
    g.note = `${formatCount(num(u.total))} calls (${realProbe(u)}): caller mistakes, not errors.`;
    groups.push(g);
  }
  return { id: 'errors', title: 'Errors', groups };
}

function usedOf(used, limit) {
  if (!isNum(limit) || limit <= 0) return row(null, formatBytes(used));
  const pct = (used / limit) * 100;
  return row(null, formatBytes(used), { sub: `of ${formatBytes(limit)} · ${pct.toFixed(1)}%`, bar: Math.min(100, Math.max(0, Math.round(pct * 10) / 10)), warn: pct >= 80 });
}

function storageSection(storage) {
  if (!storage) return { id: 'storage', title: 'Storage', groups: [{ rows: [], empty: 'Storage figures are not available right now.' }] };
  const db = { ...usedOf(storage.database_bytes, storage.limits && storage.limits.database), label: 'Database' };
  const files = { ...usedOf(storage.files_bytes, storage.limits && storage.limits.files), label: 'File storage' };
  const groups = [{ rows: [db, files] }];
  if (storage.buckets && storage.buckets.length) groups.push(listGroup('By bucket', storage.buckets.map((b) => row(b.name, formatBytes(b.bytes), { mono: true, sub: plural(b.objects, 'file') })), 'No files.'));
  return { id: 'storage', title: 'Storage', groups };
}

// The card. `jobs` ({ summary } from lib/a2aJobs/admin.mjs a2aJobsSummary,
// or { error: true }) and `storage` (from
// lib/storageUsage.mjs, null when not available) are added by /usage; the
// chat tool's card leaves them out (undefined) and has no such sections.
export function usageCardView(r, { now = Date.now(), jobs, storage } = {}) {
  const report = r && typeof r === 'object' ? r : {};
  const sections = [periodSection(report, now), callsSection(report), revenueSection(report, jobs), toolsSection(report), errorsSection(report)];
  if (storage !== undefined) sections.push(storageSection(storage));
  const notes = ['Fixture calls excluded. Caller counts are estimates from hashed IPs.'];
  if (report.truncated) notes.push('More rows than could be read: counts are a lower bound.');
  if (report.schema === 'legacy') notes.push('Some figures (MCP methods, unknown tool names, settled amounts) are not recorded yet.');
  return { title: 'Usage', sections, note: notes.join(' ') };
}

// The one line above the card in the chat.
export function usageLead(r) {
  const s = (r && r.summary) || {};
  const words = usagePeriodText(r && r.period);
  return `**Usage, ${words.replace(/^the /, '')}:** ${plural(num(s.real_tool_calls), 'real tool call')} from about ${formatCount(num(s.distinct_real_callers_estimate))} distinct ${num(s.distinct_real_callers_estimate) === 1 ? 'caller' : 'callers'}, ${formatUsd(num(s.settled_revenue_usd))} settled. The full breakdown is in the card below.`;
}

// What the card said, as short "[card]" lines (at most 4, each under 200
// characters; lib/contextWindow.mjs MAX_CARD_LINE_CHARS) for the chat's
// history and saved chats, which keep text only: a follow-up question
// ("and compared to last week?") still has the figures.
export function usageContextLines(r) {
  const s = (r && r.summary) || {};
  const t = (r && r.traffic) || {};
  const p = (r && r.payments) || {};
  const e = (r && r.errors) || {};
  const words = usagePeriodText(r && r.period).replace(/^the /, '');
  const cut = (line) => (line.length > 199 ? `${line.slice(0, 198)}…` : line);
  const tools = (r && Array.isArray(r.tools) ? r.tools : []).slice(0, 4).map((x) => `${x.tool} ${formatCount(num(x.calls))}`).join(', ');
  return [
    `[card] Usage ${words}: real tool calls ${formatCount(num(s.real_tool_calls))}, about ${formatCount(num(s.distinct_real_callers_estimate))} distinct real callers (estimate)`,
    `[card] Usage traffic: MCP requests ${formatCount(num(t.mcp_requests && t.mcp_requests.total))} (${realProbe(t.mcp_requests)}), tool calls ${formatCount(num(t.tool_calls && t.tool_calls.total))} (${realProbe(t.tool_calls)})`,
    `[card] Usage revenue: settled ${formatUsd(num(p.revenue_usd))} from ${plural(num(p.payments_settled), 'payment')}, 402s ${formatCount(num(p.payment_requests))}, free checks ${formatCount(num(p.free_checks_used))}`,
    `[card] Usage tools and errors: ${tools || 'no real tool calls'}; errors ${formatCount(num(e.total))}, rate limited ${formatCount(num(e.rate_limited))}`
  ].map(cut);
}
