// /usage verify (signed-in operator only, read-only, never spends): PG1
// checks its own usage and revenue figures against sources it does not
// write itself.
//
//   traffic   agent_telemetry rows per Ireland day and route (tool_call,
//             mcp_request and initialize: one row per recorded request on
//             /api/mcp, /api/ioc, /api/preflight and /api/a2a) against the
//             hosting platform's own request counts for the same routes
//             (Vercel observability, POST /v2/observability/query, metric
//             vercel.request.count grouped by request_path and
//             request_method, daily buckets in Europe/Dublin). Only the
//             methods telemetry records are counted on the Vercel side
//             (COUNTED_METHODS). A day whose gap is over GAP_LIMIT (5%) is
//             flagged "telemetry may be dropping rows"; pg1_errors is
//             read for telemetry insert failures in the same window.
//   revenue   settled settlement rows (is_fixture false) against the USDC
//             (Base mainnet, eip155:8453, the asset lib/x402Config.mjs
//             settles in) the x402 payTo address (X402_PAY_TO_ADDRESS)
//             received, read with alchemy_getAssetTransfers on the chain RPC
//             PG1 already has (ALCHEMY_API_KEY). A transfer counts as
//             received only when its block is at or below the chain's
//             finalized block; newer ones are listed as awaiting finality
//             and never counted. Rows and transfers are matched one to one
//             by amount (exact, in USDC base units) and time (within
//             MATCH_WINDOW_MS, nearest first).
//   licence   Gumroad sales for the configured product ids
//             (GUMROAD_PRODUCT_ID, comma-separated) in the period, with
//             GUMROAD_ACCESS_TOKEN. Without them: licence sales are paused /
//             not configured, said so, not counted.
//
// A source that cannot be read is named, with why, and the rest is still
// checked. No gap is ever filled with an estimate: a missing figure is
// null, shown as "not read". The verdict is "Figures verified" only when
// every source was read and everything matches; it is never "safe".
//
// Nothing here writes, pays, signs or spends: every call is a read
// (PostgREST GET, an observability query, eth_* / alchemy_* reads, the
// Gumroad sales list).

import { getDefaultAsset } from '@x402/evm';
import { X402_NETWORK, X402_NETWORK_NAME, X402_ASSET_SYMBOL } from './x402Config.mjs';
import { usagePeriodRange, usageDayOf, USAGE_TIME_ZONE } from './usageStats.mjs';
import { TELEMETRY_FAILURE_ROUTE } from './telemetry.mjs';

export const VERIFY_ROUTES = Object.freeze(['/api/mcp', '/api/ioc', '/api/preflight', '/api/a2a']);
// The request methods telemetry records on each route: an MCP JSON-RPC
// POST (plain GET / HEAD health checks are not recorded), the STIX feed
// on GET or POST (HEAD is not), an A2A message/send POST, a preflight
// call. OPTIONS (CORS) and DELETE (MCP session end) are never recorded.
export const COUNTED_METHODS = Object.freeze({
  '/api/mcp': Object.freeze(['POST']),
  '/api/ioc': Object.freeze(['GET', 'POST']),
  '/api/preflight': Object.freeze(['GET', 'POST']),
  '/api/a2a': Object.freeze(['POST'])
});
// The telemetry rows that stand for one request (a settlement row is a
// second row for a request that already has its tool_call row).
const REQUEST_EVENTS = new Set(['tool_call', 'mcp_request', 'initialize']);
export const GAP_LIMIT = 0.05;
export const MATCH_WINDOW_MS = 15 * 60 * 1000;
// Both sides are read up to the same instant, a few minutes back, so the
// platform's ingest delay does not show up as a gap today.
export const SETTLE_LAG_MS = 5 * 60 * 1000;
const USDC_DECIMALS = 6;
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;
const MAX_TRANSFER_PAGES = 20;
const READ_TIMEOUT_MS = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const TX_LINK_BASE = 'https://basescan.org/tx/';

export class SourceUnreadable extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

async function timed(fetchImpl, url, opts = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), READ_TIMEOUT_MS) : null;
  try {
    return await fetchImpl(url, { ...opts, signal: controller ? controller.signal : undefined });
  } catch (err) {
    throw new SourceUnreadable(err && err.name === 'AbortError' ? 'no answer in time' : 'could not be reached');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function jsonOf(res, what) {
  if (!res || !res.ok) throw new SourceUnreadable(`${what} answered HTTP ${res ? res.status : '?'}`);
  try {
    return await res.json();
  } catch {
    throw new SourceUnreadable(`${what} sent an answer that is not JSON`);
  }
}

function supabaseCreds(env) {
  const supUrl = String(env.SUPABASE_URL || '').replace(/\s+/g, '');
  const supKey = String(env.SUPABASEAPI_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLEKEY || '').replace(/\s+/g, '');
  return supUrl && supKey ? { supUrl, supKey } : null;
}

// The window: the last 7 Ireland days (as /usage 7d), up to `to`.
export function verifyRange(now = Date.now()) {
  const to = now - SETTLE_LAG_MS;
  const r = usagePeriodRange('7d', to);
  return { period: '7d', days: r.days, from: r.from, to: new Date(to).toISOString() };
}

function emptyRoutes() {
  return Object.fromEntries(VERIFY_ROUTES.map((r) => [r, 0]));
}
function emptyDays(days) {
  return new Map(days.map((d) => [d, emptyRoutes()]));
}

// ---------------------------------------------------------------------------
// Sources.

async function readRows(fetchImpl, url, headers) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const res = await timed(fetchImpl, url, { method: 'GET', headers: { ...headers, 'Range-Unit': 'items', Range: `${offset}-${offset + PAGE_SIZE - 1}` } });
    const batch = await jsonOf(res, 'The database');
    if (!Array.isArray(batch)) throw new SourceUnreadable('The database sent an unexpected answer');
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

// Telemetry: request rows per day and route (every row, fixture and own
// traffic included: they are real requests the platform counted too), the
// settled settlement rows (fixtures left out: no money moves), and the
// telemetry insert failures logged in the window.
export async function readTelemetry({ env = process.env, range, fetchImpl = fetch }) {
  const creds = supabaseCreds(env);
  if (!creds) throw new SourceUnreadable('the database is not configured');
  const headers = { apikey: creds.supKey, Authorization: `Bearer ${creds.supKey}`, Accept: 'application/json' };
  const from = encodeURIComponent(range.from);
  const to = encodeURIComponent(range.to);
  const routes = `(${VERIFY_ROUTES.map((r) => `"${r}"`).join(',')})`;
  const reqUrl = `${creds.supUrl}/rest/v1/agent_telemetry?select=created_at,event_type,endpoint&endpoint=in.${encodeURIComponent(routes)}&event_type=in.(tool_call,mcp_request,initialize)&created_at=gte.${from}&created_at=lt.${to}&order=created_at.asc`;
  const settledUrl = `${creds.supUrl}/rest/v1/agent_telemetry?select=created_at,endpoint,tool_name,amount_usd&event_type=eq.settlement&status=eq.settled&is_fixture=eq.false&created_at=gte.${from}&created_at=lt.${to}&order=created_at.asc`;
  const errUrl = `${creds.supUrl}/rest/v1/pg1_errors?select=reason,count,first_seen,last_seen&route=eq.${encodeURIComponent(TELEMETRY_FAILURE_ROUTE)}&last_seen=gte.${from}&order=last_seen.desc&limit=50`;

  const [requests, settled] = await Promise.all([readRows(fetchImpl, reqUrl, headers), readRows(fetchImpl, settledUrl, headers)]);
  const perDay = emptyDays(range.days);
  for (const row of requests.rows) {
    if (!REQUEST_EVENTS.has(row.event_type) || !VERIFY_ROUTES.includes(row.endpoint)) continue;
    const day = perDay.get(usageDayOf(Date.parse(row.created_at)));
    if (day) day[row.endpoint]++;
  }
  // The error log is a separate read: if only it fails, the counts stand
  // and the failure check says it was not read.
  let failures = null;
  try {
    const res = await timed(fetchImpl, errUrl, { method: 'GET', headers });
    const rows = await jsonOf(res, 'The error log');
    failures = Array.isArray(rows)
      ? rows.filter((r) => /^telemetry_insert_/.test(String(r.reason || ''))).map((r) => ({ reason: String(r.reason), count: Number(r.count) || 1, first_seen: r.first_seen, last_seen: r.last_seen }))
      : null;
  } catch {
    failures = null;
  }
  return {
    perDay,
    truncated: requests.truncated || settled.truncated,
    settled: settled.rows.map((r) => ({ at: r.created_at, endpoint: r.endpoint, tool: r.tool_name || null, amount_usd: Number(r.amount_usd) })).filter((r) => Number.isFinite(r.amount_usd)),
    settledWithoutAmount: settled.rows.filter((r) => !Number.isFinite(Number(r.amount_usd)) || r.amount_usd === null).length,
    failures
  };
}

export function vercelProjectId(env = process.env) {
  return String(env.PG1_VERCEL_PROJECT_ID || env.VERCEL_PROJECT_ID || '').trim();
}

// The platform's request counts per Ireland day and route, for the methods
// telemetry records.
export async function readVercelCounts({ env = process.env, range, fetchImpl = fetch }) {
  const token = String(env.VERCEL_TOKEN || '').replace(/\s+/g, '');
  const team = String(env.VERCEL_TEAM_ID || '').trim();
  const project = vercelProjectId(env);
  if (!token) throw new SourceUnreadable('no platform API token is set (VERCEL_TOKEN)');
  if (!/^team_[A-Za-z0-9]+$/.test(team)) throw new SourceUnreadable('no team id is set (VERCEL_TEAM_ID)');
  if (!/^prj_[A-Za-z0-9]+$/.test(project)) throw new SourceUnreadable('no project id is set (PG1_VERCEL_PROJECT_ID)');
  const body = {
    metric: 'vercel.request.count',
    scope: { type: 'project', ownerId: team, projectIds: [project] },
    startTime: range.from,
    endTime: range.to,
    granularity: { days: 1 },
    bucketTimezone: USAGE_TIME_ZONE,
    groupBy: ['request_path', 'request_method'],
    filter: `request_path in (${VERIFY_ROUTES.map((r) => `'${r}'`).join(',')})`,
    limit: 100
  };
  const res = await timed(fetchImpl, `https://api.vercel.com/v2/observability/query?teamId=${team}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store'
  });
  const out = await jsonOf(res, 'The platform API');
  const data = out && Array.isArray(out.data) ? out.data : null;
  if (!data) throw new SourceUnreadable('the platform API sent no request counts');
  const perDay = emptyDays(range.days);
  for (const d of data) {
    const route = d.request_path;
    const method = String(d.request_method || '').toUpperCase();
    if (!VERIFY_ROUTES.includes(route) || !COUNTED_METHODS[route].includes(method)) continue;
    const n = Number(d.vercel_request_count_sum);
    if (!Number.isFinite(n)) continue;
    const day = perDay.get(usageDayOf(Date.parse(d.timestamp)));
    if (day) day[route] += n;
  }
  return { perDay };
}

export function payToAddress(env = process.env) {
  const a = String(env.X402_PAY_TO_ADDRESS || '').trim();
  return /^0x[0-9a-fA-F]{40}$/.test(a) ? a : '';
}
export function settlementAsset() {
  const a = getDefaultAsset(X402_NETWORK);
  return { address: a.asset, decimals: Number.isInteger(a.decimals) ? a.decimals : USDC_DECIMALS, symbol: X402_ASSET_SYMBOL };
}

async function rpc(fetchImpl, url, method, params) {
  const res = await timed(fetchImpl, url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const out = await jsonOf(res, 'The chain RPC');
  if (!out || out.error || out.result === undefined) throw new SourceUnreadable('the chain RPC answered with an error');
  return out.result;
}

// "0x0f4240" -> 1000000n; anything else -> null.
function hexBig(v) {
  try {
    return typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v) : null;
  } catch {
    return null;
  }
}

// USDC received by the payTo address in the window, newest first, each
// with its block, time, amount and whether it is final.
export async function readChainTransfers({ env = process.env, range, fetchImpl = fetch }) {
  const payTo = payToAddress(env);
  if (!payTo) throw new SourceUnreadable('no x402 payTo address is set (X402_PAY_TO_ADDRESS)');
  const key = String(env.ALCHEMY_API_KEY || '').trim();
  if (!key) throw new SourceUnreadable('no chain RPC key is set (ALCHEMY_API_KEY)');
  if (X402_NETWORK !== 'eip155:8453') throw new SourceUnreadable(`the settlement network ${X402_NETWORK} is not Base mainnet`);
  const url = `https://base-mainnet.g.alchemy.com/v2/${key}`;
  const asset = settlementAsset();
  const finalizedBlock = await rpc(fetchImpl, url, 'eth_getBlockByNumber', ['finalized', false]);
  const finalized = hexBig(finalizedBlock && finalizedBlock.number);
  if (finalized === null) throw new SourceUnreadable('the chain RPC gave no finalized block');
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  const transfers = [];
  let pageKey;
  let complete = false;
  for (let page = 0; page < MAX_TRANSFER_PAGES; page++) {
    const params = { fromBlock: '0x0', toBlock: 'latest', toAddress: payTo, contractAddresses: [asset.address], category: ['erc20'], withMetadata: true, excludeZeroValue: true, order: 'desc', maxCount: '0x3e8' };
    if (pageKey) params.pageKey = pageKey;
    const out = await rpc(fetchImpl, url, 'alchemy_getAssetTransfers', [params]);
    const list = out && Array.isArray(out.transfers) ? out.transfers : null;
    if (!list) throw new SourceUnreadable('the chain RPC sent no transfer list');
    let older = false;
    for (const t of list) {
      const at = Date.parse(t && t.metadata && t.metadata.blockTimestamp);
      if (!Number.isFinite(at)) continue;
      if (at < fromMs) { older = true; break; }
      if (at >= toMs) continue;
      const raw = hexBig(t.rawContract && t.rawContract.value);
      const block = hexBig(t.blockNum);
      if (raw === null || block === null || !/^0x[0-9a-fA-F]{64}$/.test(String(t.hash || '').split(':')[0])) continue;
      if (String(t.rawContract && t.rawContract.address || '').toLowerCase() !== asset.address.toLowerCase()) continue;
      transfers.push({
        hash: String(t.hash).split(':')[0],
        from: String(t.from || ''),
        at: new Date(at).toISOString(),
        block: Number(block),
        raw: raw.toString(),
        amount_usd: Number(raw) / 10 ** asset.decimals,
        final: block <= finalized
      });
    }
    pageKey = out.pageKey;
    if (older || !pageKey) { complete = true; break; }
  }
  if (!complete) throw new SourceUnreadable('more transfers than could be read in one check');
  return { payTo, asset, finalizedBlock: Number(finalized), transfers };
}

// Licence sales in the window, or why they were not read.
export function gumroadProductIds(env = process.env) {
  return String(env.GUMROAD_PRODUCT_ID || '').split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_=-]{2,64}$/.test(s));
}

export async function readLicenceSales({ env = process.env, range, fetchImpl = fetch }) {
  const products = gumroadProductIds(env);
  const token = String(env.GUMROAD_ACCESS_TOKEN || '').trim();
  if (!products.length || !token) {
    return { status: 'not_configured', products: products.length, note: `Licence sales are paused and not configured for reading (${!products.length ? 'no product id' : 'no sales token, GUMROAD_ACCESS_TOKEN'}), so no licence revenue was read.` };
  }
  const after = new Date(Date.parse(range.from) - DAY_MS).toISOString().slice(0, 10);
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  const sales = [];
  for (const product of products) {
    let pageKey = '';
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ access_token: token, product_id: product, after });
      if (pageKey) q.set('page_key', pageKey);
      const res = await timed(fetchImpl, `https://api.gumroad.com/v2/sales?${q}`, { method: 'GET' });
      const out = await jsonOf(res, 'The licence store');
      if (!out || out.success !== true || !Array.isArray(out.sales)) throw new SourceUnreadable('the licence store did not list sales');
      for (const s of out.sales) {
        const at = Date.parse(s.created_at);
        if (!Number.isFinite(at) || at < fromMs || at >= toMs) continue;
        if (s.refunded === true || s.chargebacked === true) continue;
        const cents = Number(s.price);
        sales.push({ product, at: new Date(at).toISOString(), amount: Number.isFinite(cents) ? cents / 100 : null, currency: String(s.currency || 'usd').toUpperCase() });
      }
      pageKey = out.next_page_key || '';
      if (!pageKey) break;
    }
  }
  return { status: 'read', products: products.length, count: sales.length, sales };
}

// ---------------------------------------------------------------------------
// Comparison.

const sumRoutes = (r) => VERIFY_ROUTES.reduce((n, k) => n + (r ? r[k] : 0), 0);

// Gap as a share of the platform's count: positive when telemetry has
// fewer rows than the platform counted requests.
export function gapShare(telemetry, platform) {
  if (!Number.isFinite(telemetry) || !Number.isFinite(platform)) return null;
  if (platform === 0) return telemetry === 0 ? 0 : -1;
  return (platform - telemetry) / platform;
}

export function compareTraffic(days, tele, vercel) {
  return days.map((day) => {
    const t = tele ? tele.perDay.get(day) : null;
    const v = vercel ? vercel.perDay.get(day) : null;
    const routes = VERIFY_ROUTES.map((route) => {
      const tn = t ? t[route] : null;
      const vn = v ? v[route] : null;
      const g = tn === null || vn === null ? null : gapShare(tn, vn);
      return { route, telemetry: tn, platform: vn, gap: g, flagged: g !== null && Math.abs(g) > GAP_LIMIT };
    });
    const tt = t ? sumRoutes(t) : null;
    const vt = v ? sumRoutes(v) : null;
    const gap = tt === null || vt === null ? null : gapShare(tt, vt);
    return { day, telemetry: tt, platform: vt, gap, flagged: gap !== null && Math.abs(gap) > GAP_LIMIT, routes };
  });
}

const microUsd = (usd) => Math.round(Number(usd) * 10 ** USDC_DECIMALS);

// One to one: each settled row takes the nearest unmatched final transfer
// of exactly the same amount within MATCH_WINDOW_MS.
export function matchSettlements(settled, transfers) {
  const pool = transfers.filter((t) => t.final).map((t) => ({ ...t, taken: false }));
  const matched = [];
  const unmatchedSettled = [];
  for (const row of [...settled].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const at = Date.parse(row.at);
    const want = microUsd(row.amount_usd);
    let best = null;
    for (const t of pool) {
      if (t.taken || Number(t.raw) !== want) continue;
      const d = Math.abs(Date.parse(t.at) - at);
      if (d <= MATCH_WINDOW_MS && (!best || d < best.d)) best = { t, d };
    }
    if (best) {
      best.t.taken = true;
      matched.push({ settled: row, transfer: stripTaken(best.t) });
    } else unmatchedSettled.push(row);
  }
  return { matched, unmatchedSettled, unmatchedTransfers: pool.filter((t) => !t.taken).map(stripTaken) };
}
function stripTaken(t) {
  const { taken, ...rest } = t;
  return rest;
}

const sumUsd = (list, pick = (x) => x.amount_usd) => Math.round(list.reduce((n, x) => n + (Number(pick(x)) || 0), 0) * 1e6) / 1e6;

async function attempt(name, fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, reason: err instanceof SourceUnreadable ? err.reason : 'could not be read' };
  }
}

// The whole check. Each source is read on its own; one that fails is
// named with its reason and the rest still run.
export async function verifyUsage({ env = process.env, now = Date.now(), fetchImpl = fetch } = {}) {
  const range = verifyRange(now);
  const [tele, vercel, chain, licence] = await Promise.all([
    attempt('telemetry', () => readTelemetry({ env, range, fetchImpl })),
    attempt('platform', () => readVercelCounts({ env, range, fetchImpl })),
    attempt('chain', () => readChainTransfers({ env, range, fetchImpl })),
    attempt('licence', () => readLicenceSales({ env, range, fetchImpl }))
  ]);
  const t = tele.ok ? tele.value : null;
  const v = vercel.ok ? vercel.value : null;
  const c = chain.ok ? chain.value : null;
  const traffic = { days: compareTraffic(range.days, t, v), truncated: !!(t && t.truncated) };
  const totalsT = t ? traffic.days.reduce((n, d) => n + d.telemetry, 0) : null;
  const totalsV = v ? traffic.days.reduce((n, d) => n + d.platform, 0) : null;
  traffic.telemetry_total = totalsT;
  traffic.platform_total = totalsV;
  traffic.gap = totalsT === null || totalsV === null ? null : gapShare(totalsT, totalsV);

  let revenue = null;
  if (t || c) {
    const settled = t ? t.settled : null;
    const finals = c ? c.transfers.filter((x) => x.final) : null;
    const pending = c ? c.transfers.filter((x) => !x.final) : null;
    const m = settled && c ? matchSettlements(settled, c.transfers) : null;
    revenue = {
      settled_count: settled ? settled.length : null,
      settled_usd: settled ? sumUsd(settled) : null,
      settled_without_amount: t ? t.settledWithoutAmount : null,
      received_count: finals ? finals.length : null,
      received_usd: finals ? sumUsd(finals) : null,
      pending: pending || [],
      transfers: finals || [],
      matched: m ? m.matched : null,
      unmatched_settled: m ? m.unmatchedSettled : null,
      unmatched_transfers: m ? m.unmatchedTransfers : null,
      pay_to: c ? c.payTo : payToAddress(env) || null,
      asset: settlementAsset().symbol,
      network: X402_NETWORK_NAME
    };
  }
  const sources = {
    telemetry: tele.ok ? { ok: true, truncated: !!t.truncated } : { ok: false, reason: tele.reason },
    telemetry_failures: t ? (t.failures === null ? { ok: false, reason: 'the error log could not be read' } : { ok: true }) : { ok: false, reason: tele.ok ? '' : 'telemetry could not be read' },
    platform: vercel.ok ? { ok: true } : { ok: false, reason: vercel.reason },
    chain: chain.ok ? { ok: true } : { ok: false, reason: chain.reason },
    licence: licence.ok ? { ok: true, status: licence.value.status } : { ok: false, reason: licence.reason }
  };
  const report = {
    period: range.period,
    range: { from: range.from, to: range.to, days: range.days },
    generated_at: new Date(now).toISOString(),
    sources,
    traffic,
    telemetry_failures: t && t.failures ? t.failures : t && t.failures === null ? null : [],
    revenue,
    licence: licence.ok ? licence.value : null
  };
  report.verdict = verifyVerdict(report);
  return report;
}

// ---------------------------------------------------------------------------
// Wording. Money as "0.01 USD" in text (no "$" before digits in a chat
// reply); the card formats its own.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dayLabel(isoDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDay || ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : String(isoDay || '');
}
const dublinFmt = new Intl.DateTimeFormat('en-GB', { timeZone: USAGE_TIME_ZONE, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function timeLabel(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? dublinFmt.format(new Date(ms)).replace(',', '') : '—';
}
export function usd(n) {
  if (!Number.isFinite(n)) return 'not read';
  const v = Math.round(n * 1e6) / 1e6;
  const s = v.toFixed(6).replace(/0{1,4}$/, '');
  return `${s} USD`;
}
const count = (n) => (Number.isFinite(n) ? n.toLocaleString('en-GB') : 'not read');
const pct = (g) => (g === null || g === undefined ? '—' : g === -1 ? 'platform counted none' : `${(Math.abs(g) * 100).toFixed(1)}%${g < 0 ? ' more in telemetry' : ''}`);
const SOURCE_NAMES = { telemetry: 'Telemetry (agent_telemetry)', telemetry_failures: 'Telemetry error log (pg1_errors)', platform: 'Server request counts (Vercel)', chain: `Chain (${X402_ASSET_SYMBOL} on ${X402_NETWORK_NAME})`, licence: 'Licence sales (Gumroad)' };
export function shortHash(h) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(h)) ? `${h.slice(0, 10)}…${h.slice(-6)}` : String(h || '');
}

// "Figures verified", or what does not match and where, or what was not
// read. Never "safe".
export function verifyVerdict(report) {
  const problems = [];
  const unread = [];
  const s = report.sources || {};
  for (const key of ['telemetry', 'platform', 'chain']) if (s[key] && !s[key].ok) unread.push(`${SOURCE_NAMES[key]}: ${s[key].reason}`);
  if (s.licence && !s.licence.ok) unread.push(`${SOURCE_NAMES.licence}: ${s.licence.reason}`);
  if (s.telemetry && s.telemetry.ok && s.telemetry_failures && !s.telemetry_failures.ok) unread.push(`${SOURCE_NAMES.telemetry_failures}: ${s.telemetry_failures.reason}`);
  const traffic = report.traffic || {};
  if (traffic.truncated) unread.push('Telemetry: more rows than could be read, so its counts are incomplete');
  const flaggedDays = (traffic.days || []).filter((d) => d.flagged);
  if (flaggedDays.length) {
    const routes = [...new Set(flaggedDays.flatMap((d) => d.routes.filter((r) => r.flagged).map((r) => r.route)))];
    problems.push(`Traffic: telemetry and server counts differ by more than 5% on ${flaggedDays.map((d) => dayLabel(d.day)).join(', ')}${routes.length ? ` (${routes.join(', ')})` : ''}; telemetry may be dropping rows`);
  }
  const fails = report.telemetry_failures || [];
  if (fails.length) problems.push(`Telemetry: ${fails.reduce((n, f) => n + f.count, 0)} logged insert failure${fails.reduce((n, f) => n + f.count, 0) === 1 ? '' : 's'} (${[...new Set(fails.map((f) => f.reason))].join(', ')})`);
  const r = report.revenue;
  if (r && r.unmatched_settled && r.unmatched_settled.length) problems.push(`Revenue: ${r.unmatched_settled.length} settled payment${r.unmatched_settled.length === 1 ? '' : 's'} in telemetry (${usd(sumUsd(r.unmatched_settled))}) with no matching transfer on chain`);
  if (r && r.unmatched_transfers && r.unmatched_transfers.length) problems.push(`Revenue: ${r.unmatched_transfers.length} on-chain transfer${r.unmatched_transfers.length === 1 ? '' : 's'} (${usd(sumUsd(r.unmatched_transfers))}) with no settled row in telemetry`);
  if (r && r.settled_without_amount) problems.push(`Revenue: ${r.settled_without_amount} settled row${r.settled_without_amount === 1 ? '' : 's'} with no amount recorded`);
  const status = problems.length ? 'mismatch' : unread.length ? 'incomplete' : 'verified';
  let line;
  if (status === 'verified') line = 'Figures verified';
  else if (status === 'mismatch') line = `Does not match: ${problems.join('. ')}${unread.length ? `. Not checked: ${unread.map((u) => u.split(':')[0]).join(', ')}` : ''}`;
  else line = `Not fully verified: ${unread.map((u) => u.split(':')[0]).join(', ')} could not be read; everything that was read matches`;
  return { status, line, problems, unread };
}

// The /usage verify reply (and /pdf usage verify): verdict line first.
export function verifyReport(report) {
  const r = report || {};
  const v = r.verdict || verifyVerdict(r);
  const range = r.range || {};
  const lines = [`**${v.line}.**`, '', `## Usage verify · last 7 days`, `Period: ${dayLabel((range.days || [])[0])} – ${dayLabel((range.days || []).slice(-1)[0])} (Ireland time), up to ${timeLabel(range.to)}. Read-only: nothing was paid or spent.`];

  lines.push('', '### Sources');
  for (const [key, name] of Object.entries(SOURCE_NAMES)) {
    const s = (r.sources || {})[key];
    if (!s) continue;
    if (key === 'licence' && s.ok && s.status === 'not_configured') lines.push(`- ${name}: not configured (licence sales paused)`);
    else lines.push(`- ${name}: ${s.ok ? 'read' : `could not be read (${s.reason || 'not read'})`}`);
  }

  const traffic = r.traffic || {};
  lines.push('', '### Telemetry vs server requests', '| Day | Telemetry | Server | Gap |', '|---|---:|---:|---:|');
  for (const d of traffic.days || []) lines.push(`| ${dayLabel(d.day)} | ${count(d.telemetry)} | ${count(d.platform)} | ${pct(d.gap)}${d.flagged ? ' (flagged: telemetry may be dropping rows)' : ''} |`);
  lines.push(`| **Total** | ${count(traffic.telemetry_total)} | ${count(traffic.platform_total)} | ${pct(traffic.gap)} |`);
  const flaggedRoutes = (traffic.days || []).flatMap((d) => d.routes.filter((x) => x.flagged).map((x) => `${dayLabel(d.day)} ${x.route}: telemetry ${count(x.telemetry)}, server ${count(x.platform)}`));
  if (flaggedRoutes.length) lines.push('', `Routes over 5%: ${flaggedRoutes.join(' · ')}`);
  lines.push('', `Counted: telemetry tool_call, mcp_request and initialize rows; server POST on /api/mcp and /api/a2a, GET and POST on /api/ioc and /api/preflight (health checks, HEAD and OPTIONS are not recorded by telemetry).`);
  if (r.telemetry_failures === null) lines.push('Telemetry insert failures: the error log could not be read.');
  else lines.push(`Telemetry insert failures logged: ${(r.telemetry_failures || []).length ? r.telemetry_failures.map((f) => `${f.reason} ×${f.count} (last ${timeLabel(f.last_seen)})`).join(', ') : 'none'}.`);

  const rev = r.revenue;
  lines.push('', `### Revenue vs chain (${X402_ASSET_SYMBOL} on ${X402_NETWORK_NAME})`);
  if (!rev) lines.push('Neither telemetry nor the chain could be read, so no revenue figure is shown.');
  else {
    lines.push(`- Settled in telemetry: ${rev.settled_count === null ? 'not read' : `${rev.settled_count} (${usd(rev.settled_usd)})`}`);
    lines.push(`- Received on chain (final): ${rev.received_count === null ? 'not read' : `${rev.received_count} (${usd(rev.received_usd)})`}`);
    lines.push(`- Matched: ${rev.matched === null ? 'not checked' : `${rev.matched.length} (${usd(sumUsd(rev.matched, (x) => x.transfer.amount_usd))})`}`);
    lines.push(`- Settled with no transfer: ${rev.unmatched_settled === null ? 'not checked' : rev.unmatched_settled.length}`);
    lines.push(`- Transfers with no settled row: ${rev.unmatched_transfers === null ? 'not checked' : rev.unmatched_transfers.length}`);
    if (rev.pending.length) lines.push(`- Awaiting finality (not counted as received): ${rev.pending.length}`);
    if (rev.transfers.length) {
      const matchedHashes = new Set((rev.matched || []).map((m) => m.transfer.hash));
      lines.push('', '| Time | Amount | Transaction | Matched |', '|---|---:|---|---|');
      for (const t of rev.transfers) lines.push(`| ${timeLabel(t.at)} | ${usd(t.amount_usd)} | [${shortHash(t.hash)}](${TX_LINK_BASE}${t.hash}) | ${rev.matched === null ? 'not checked' : matchedHashes.has(t.hash) ? 'yes' : 'no settled row'} |`);
    }
    if (rev.unmatched_settled && rev.unmatched_settled.length) {
      lines.push('', 'Settled rows with no transfer: ' + rev.unmatched_settled.map((s) => `${timeLabel(s.at)} ${usd(s.amount_usd)} (${s.endpoint || 'unknown route'})`).join(' · '));
    }
  }

  const lic = r.licence;
  lines.push('', '### Licence revenue');
  if (!lic) lines.push(`Licence sales could not be read (${((r.sources || {}).licence || {}).reason || 'not read'}).`);
  else if (lic.status === 'not_configured') lines.push(lic.note);
  else {
    const byCur = {};
    for (const s of lic.sales) if (Number.isFinite(s.amount)) byCur[s.currency] = (byCur[s.currency] || 0) + s.amount;
    lines.push(`${lic.count} sale${lic.count === 1 ? '' : 's'} across ${lic.products} product${lic.products === 1 ? '' : 's'}${Object.keys(byCur).length ? ` (${Object.entries(byCur).map(([c, a]) => `${a.toFixed(2)} ${c}`).join(', ')})` : ''}.`);
  }
  lines.push('', 'Every figure above was read from its source just now; a source that could not be read shows no figure, never an estimate.');
  return lines.join('\n');
}

// The card (drawn by public/index.html usageCardHtml): sections of rows.
export function verifyCardView(report) {
  const r = report || {};
  const v = r.verdict || verifyVerdict(r);
  const row = (label, value, extra = {}) => ({ label, value: String(value), ...extra });
  const sections = [];
  const verdictRows = [row('Verdict', v.status === 'verified' ? 'Figures verified' : v.status === 'mismatch' ? 'Does not match' : 'Not fully verified', { tag: v.status === 'verified' ? '' : 'check', warn: v.status !== 'verified' })];
  for (const p of v.problems) verdictRows.push(row(p.split(':')[0], 'mismatch', { sub: p.split(':').slice(1).join(':').trim(), warn: true }));
  for (const u of v.unread) verdictRows.push(row(u.split(':')[0], 'not read', { sub: u.split(':').slice(1).join(':').trim(), warn: true }));
  sections.push({ id: 'verdict', title: 'Verdict', groups: [{ rows: verdictRows }] });

  const traffic = r.traffic || {};
  const dayRows = (traffic.days || []).map((d) => row(dayLabel(d.day), `${count(d.telemetry)} / ${count(d.platform)}`, {
    sub: d.flagged ? `telemetry / server · gap ${pct(d.gap)} · telemetry may be dropping rows` : `telemetry / server · gap ${pct(d.gap)}`,
    tag: d.flagged ? 'gap' : '', warn: d.flagged
  }));
  const routeRows = VERIFY_ROUTES.map((route) => {
    const total = (side) => {
      let n = 0;
      for (const d of traffic.days || []) {
        const x = d.routes.find((y) => y.route === route);
        if (!x || x[side] === null) return null;
        n += x[side];
      }
      return n;
    };
    const tn = total('telemetry');
    const vn = total('platform');
    return row(route, `${count(tn)} / ${count(vn)}`, { mono: true, sub: `telemetry / server · gap ${pct(tn === null || vn === null ? null : gapShare(tn, vn))}` });
  });
  const failRow = r.telemetry_failures === null
    ? row('Insert failures logged', 'not read', { warn: true })
    : row('Insert failures logged', count((r.telemetry_failures || []).reduce((n, f) => n + f.count, 0)), { warn: (r.telemetry_failures || []).length > 0, sub: (r.telemetry_failures || []).map((f) => f.reason).join(', ') });
  sections.push({ id: 'traffic', title: 'Telemetry vs server', groups: [
    { rows: [row('Total', `${count(traffic.telemetry_total)} / ${count(traffic.platform_total)}`, { sub: `telemetry / server · gap ${pct(traffic.gap)}` }), failRow] },
    { title: 'Per day', rows: dayRows },
    { title: 'By route', rows: routeRows, note: 'Server: POST on /api/mcp and /api/a2a, GET and POST on /api/ioc and /api/preflight.' }
  ] });

  const rev = r.revenue;
  if (rev) {
    const matchedHashes = new Set((rev.matched || []).map((m) => m.transfer.hash));
    const txRows = rev.transfers.map((t) => row(timeLabel(t.at), usd(t.amount_usd), { mono: true, sub: `${shortHash(t.hash)} · ${rev.matched === null ? 'not checked' : matchedHashes.has(t.hash) ? 'matched' : 'no settled row'}`, href: `${TX_LINK_BASE}${t.hash}`, warn: rev.matched !== null && !matchedHashes.has(t.hash) }));
    const groups = [{ rows: [
      row('Settled in telemetry', rev.settled_count === null ? 'not read' : usd(rev.settled_usd), { sub: rev.settled_count === null ? '' : `${rev.settled_count} payment${rev.settled_count === 1 ? '' : 's'}` }),
      row('Received on chain', rev.received_count === null ? 'not read' : usd(rev.received_usd), { sub: rev.received_count === null ? '' : `${rev.received_count} final transfer${rev.received_count === 1 ? '' : 's'}` }),
      row('Matched', rev.matched === null ? 'not checked' : String(rev.matched.length)),
      row('Settled, no transfer', rev.unmatched_settled === null ? 'not checked' : String(rev.unmatched_settled.length), { warn: !!(rev.unmatched_settled && rev.unmatched_settled.length) }),
      row('Transfer, no settled row', rev.unmatched_transfers === null ? 'not checked' : String(rev.unmatched_transfers.length), { warn: !!(rev.unmatched_transfers && rev.unmatched_transfers.length) })
    ].concat(rev.pending.length ? [row('Awaiting finality', String(rev.pending.length), { sub: 'not counted as received' })] : []) }];
    groups.push({ title: 'Transfers received', rows: txRows.slice(0, 5), more: txRows.slice(5), empty: rev.received_count === null ? 'Chain not read.' : 'No transfers in the period.' });
    if (rev.unmatched_settled && rev.unmatched_settled.length) groups.push({ title: 'Settled rows with no transfer', rows: rev.unmatched_settled.slice(0, 5).map((s) => row(timeLabel(s.at), usd(s.amount_usd), { sub: s.endpoint || '', warn: true })), more: rev.unmatched_settled.slice(5).map((s) => row(timeLabel(s.at), usd(s.amount_usd), { sub: s.endpoint || '', warn: true })) });
    sections.push({ id: 'revenue', title: `Revenue vs chain (${X402_ASSET_SYMBOL} on ${X402_NETWORK_NAME})`, groups });
  } else {
    sections.push({ id: 'revenue', title: 'Revenue vs chain', groups: [{ rows: [], empty: 'Neither telemetry nor the chain could be read.' }] });
  }

  const lic = r.licence;
  sections.push({ id: 'licence', title: 'Licence revenue', groups: [{ rows: lic && lic.status === 'read' ? [row('Sales', count(lic.count), { sub: `${lic.products} product${lic.products === 1 ? '' : 's'}` })] : [], empty: lic ? lic.note || 'No sales.' : `Licence sales could not be read (${((r.sources || {}).licence || {}).reason || 'not read'}).` }] });

  return { title: 'Usage verify', sections, note: 'Read-only: nothing was paid or spent. A figure a source did not give is "not read", never an estimate. On-chain transfers count as received only once final.' };
}

// The [card] lines for the chat's history (each under 200 characters).
export function verifyContextLines(report) {
  const r = report || {};
  const v = r.verdict || verifyVerdict(r);
  const t = r.traffic || {};
  const rev = r.revenue || {};
  const cut = (line) => (line.length > 199 ? `${line.slice(0, 198)}…` : line);
  return [
    `[card] Usage verify 7 days: ${v.line}`,
    `[card] Verify traffic: telemetry ${count(t.telemetry_total)}, server ${count(t.platform_total)}, gap ${pct(t.gap)}`,
    `[card] Verify revenue: settled ${rev.settled_count == null ? 'not read' : `${rev.settled_count} (${usd(rev.settled_usd)})`}, on chain ${rev.received_count == null ? 'not read' : `${rev.received_count} (${usd(rev.received_usd)})`}`
  ].map(cut);
}

// The chat reply above the card: the verdict first, then one line per
// check. The full tables are in the card and in /pdf usage verify.
export function verifyLead(report) {
  const r = report || {};
  const v = r.verdict || verifyVerdict(r);
  const t = r.traffic || {};
  const rev = r.revenue;
  const lic = r.licence;
  const lines = [`**${v.line}.**`, ''];
  lines.push(`- Traffic, last 7 days: telemetry ${count(t.telemetry_total)}, server ${count(t.platform_total)}${t.gap === null || t.gap === undefined ? '' : ` (gap ${pct(t.gap)})`}.`);
  if (!rev) lines.push('- Revenue: neither telemetry nor the chain could be read, so no figure is shown.');
  else lines.push(`- Revenue: settled in telemetry ${rev.settled_count === null ? 'not read' : `${rev.settled_count} (${usd(rev.settled_usd)})`}; received on chain ${rev.received_count === null ? 'not read' : `${rev.received_count} (${usd(rev.received_usd)})`}; matched ${rev.matched === null ? 'not checked' : rev.matched.length}.`);
  lines.push(`- Licence: ${lic ? (lic.status === 'read' ? `${lic.count} sale${lic.count === 1 ? '' : 's'}` : 'sales paused / not configured') : 'could not be read'}.`);
  lines.push('', 'Read-only: nothing was paid or spent. The full breakdown is in the card below; `/pdf usage verify` makes it a PDF.');
  return lines.join('\n');
}
