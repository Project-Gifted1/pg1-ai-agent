// The /usage reply text (api/chat.mjs via lib/chatTools.mjs usageReport),
// built from a lib/usageStats.mjs report. The layout is fixed:
//
//   ## Usage · <period>            title line
//   ### Summary                    then short sections, each a heading
//   ### Traffic                    and a few short lines, in this order
//   ### Tools
//   ### Payments
//   ### Errors
//   ### Clients
//   [^note]: ...                   footnote (small muted text in the chat)
//
// MCP requests and tool calls are always labelled as such, so a client's
// request total can never be read as tool calls. Distinct callers is always
// "about N" and marked as an estimate. Client and unknown tool names are
// untrusted text that was reduced before it was stored (letters, digits and
// . _ - / @ + ( ) only), shown in code chips and never followed.

import { usagePeriodText, usdText } from './usageStats.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDay(isoDay) {
  const d = new Date(`${String(isoDay).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(isoDay);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const n = (v) => (Number.isFinite(v) ? v : 0);
const plural = (count, one, many = `${one}s`) => `${n(count)} ${n(count) === 1 ? one : many}`;
const chip = (name) => `\`${String(name).replace(/`/g, '')}\``;
const joinOr = (items, none = 'none') => (items.length ? items.join(' · ') : none);
const split = (s) => `${n(s && s.total)} (real ${n(s && s.real)}, probe ${n(s && s.probe)})`;

// Days to list one by one; a 30-day period shows the median and the spikes.
const MAX_LISTED_DAYS = 7;

function trafficLines(t) {
  const lines = [
    `MCP requests: ${split(t.mcp_requests)}`,
    `Tool calls: ${split(t.tool_calls)}`,
    `By route (requests): ${joinOr((t.by_route || []).slice(0, 4).map((r) => `${r.route} ${n(r.requests)}`))}`
  ];
  const days = Array.isArray(t.per_day) ? t.per_day : [];
  const spikes = days.filter((d) => d.spike);
  if (days.length && days.length <= MAX_LISTED_DAYS) {
    lines.push(`Per day (real + probe): ${days.map((d) => `${shortDay(d.day)} ${n(d.real)}+${n(d.probe)}${d.spike ? ' (spike)' : ''}`).join(' · ')}`);
  } else if (days.length) {
    lines.push(`Per day: median ${n(t.per_day_median)} requests; spikes: ${joinOr(spikes.slice(0, 5).map((d) => `${shortDay(d.day)} ${n(d.total)} (real ${n(d.real)}, probe ${n(d.probe)})`))}`);
  }
  const reasons = t.probe_callers_by_reason || {};
  const probeParts = [['known_crawler', 'known crawler'], ['unknown_tools_only', 'unknown tools only'], ['probe_only_activity', 'listing only']]
    .filter(([key]) => n(reasons[key])).map(([key, label]) => `${label} ${n(reasons[key])}`);
  if (probeParts.length) lines.push(`Probe callers: ${probeParts.join(' · ')}`);
  if (days.length && days.length <= MAX_LISTED_DAYS) {
    lines.push(`Spikes (over ${n(t.spike_threshold)} a day, 3x the median): ${spikes.length ? spikes.map((d) => shortDay(d.day)).join(', ') : 'none'}`);
  }
  return lines;
}

function toolLines(tools, servedBy, iocLookups) {
  if (!Array.isArray(tools) || !tools.length) return ['No real tool calls in this period.'];
  const lines = tools.slice(0, 5).map((t) => `${chip(t.tool)} ${plural(t.calls, 'call')} · ${t.pricing === 'free' ? 'free' : 'paid'}`);
  if (servedBy) lines.push(`Served: free ${n(servedBy.free)} · free tier ${n(servedBy.free_tier)} · paid ${n(servedBy.paid)}`);
  if (iocLookups && n(iocLookups.total)) lines.push(`Indicator lookups with a record found: ${n(iocLookups.found)} of ${n(iocLookups.total)}`);
  return lines;
}

function paymentLines(p) {
  const lines = [
    `Free checks used: ${n(p.free_checks_used)} (free tools ${n(p.free_tool_calls)}, free tier ${n(p.free_tier_calls)})`,
    `Hit the free limit: ${plural(p.callers_hit_free_limit, 'caller')}`,
    `Shown a payment request, never served: ${plural(p.callers_challenged_never_served, 'caller')}`,
    `Payment requests issued (402): ${n(p.payment_requests)}`,
    `Payments settled: ${n(p.payments_settled)} · ${usdText(p.revenue_usd)}${n(p.settlement_failures) ? ` · ${plural(p.settlement_failures, 'failed settlement')}` : ''}`
  ];
  const byRoute = Array.isArray(p.free_tier_calls_by_route) ? p.free_tier_calls_by_route : [];
  if (byRoute.length) lines.push(`Free tier by route (one 5/day counter): ${byRoute.map((r) => `${r.route} ${n(r.calls)}`).join(' · ')}`);
  if (n(p.ioc_feed_x402_calls)) lines.push(`STIX feed paid with x402: ${plural(p.ioc_feed_x402_calls, 'call')} (settled by the payment middleware, not in the revenue above)`);
  return lines;
}

const toolLabel = (tool) => (String(tool).startsWith('(') ? tool : chip(tool));

function unknownToolLines(e) {
  const u = e.unknown_tool_calls || {};
  if (!n(u.total)) return [];
  const names = Array.isArray(e.unrecognised_tools) ? e.unrecognised_tools.slice(0, 5).map((x) => `${chip(x.name)} ${n(x.count)}`) : [];
  return [`Unknown tools asked for (caller mistakes, not errors): ${split(u)}${names.length ? ` · ${names.join(' · ')}` : ''}`];
}

function errorLines(e) {
  if (!n(e.total)) return [`No errors.${n(e.rate_limited) ? ` Rate limited: ${n(e.rate_limited)}.` : ''}`, ...unknownToolLines(e)];
  const f = e.by_fault || {};
  const lines = [
    `Total: ${n(e.total)} (real ${n(e.by_class && e.by_class.real)}, probe ${n(e.by_class && e.by_class.probe)})${n(e.rate_limited) ? ` · rate limited ${n(e.rate_limited)}` : ''}`,
    `Whose fault: PG1 or its sources ${n(f.pg1)} · caller input ${n(f.caller)}${n(f.unclassified) ? ` · unclassified ${n(f.unclassified)}` : ''}`,
    `Top (tool, type, real+probe): ${joinOr((e.breakdown || []).slice(0, 4).map((r) => `${toolLabel(r.tool)} ${r.type} ${n(r.real)}+${n(r.probe)}`))}`
  ];
  return [...lines, ...unknownToolLines(e)];
}

function clientLines(clients) {
  if (!Array.isArray(clients) || !clients.length) return ['No MCP client names reported.'];
  return clients.slice(0, 5).map((c) => `${chip(c.name)} ${plural(c.requests, 'request')} · ${plural(c.tool_calls, 'tool call')}${c.class === 'probe' ? ' · probe' : ''}`);
}

export function formatUsageReport(r) {
  const s = r.summary || {};
  const t = r.traffic || {};
  const section = (title, lines) => [`### ${title}`, ...lines].join('\n');
  const notes = ['Fixture calls excluded; distinct callers is an estimate from hashed IPs.'];
  if (r.truncated) notes.push('The period has more rows than were read, so counts are a lower bound.');
  if (r.schema === 'legacy') notes.push('The telemetry table predates the latest migration: MCP requests other than initialize and tool calls, unrecognised tool names and settled amounts are not recorded yet.');
  return [
    `## Usage · ${usagePeriodText(r.period)}`,
    section('Summary', [
      `Real tool calls: ${n(s.real_tool_calls)}`,
      `Distinct real callers: about ${n(s.distinct_real_callers_estimate)} (estimated)`,
      `Payment requests (402): ${n(s.payment_requests)}`,
      `Settled revenue: ${usdText(s.settled_revenue_usd)}`
    ]),
    section('Traffic', trafficLines(t)),
    section('Tools', toolLines(r.tools, r.served_by, r.ioc_lookups)),
    section('Payments', paymentLines(r.payments || {})),
    section('Errors', errorLines(r.errors || {})),
    section('Clients', clientLines(r.clients)),
    `[^note]: ${notes.join(' ')}`
  ].join('\n\n');
}
