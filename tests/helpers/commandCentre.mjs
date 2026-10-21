// A stand-in PG1 server for the Command Centre browser tests (PR A): it
// serves public/ and answers /api/chat (/help with the command panel, a
// reply with check result cards built from the real fixture outcomes) and
// /api/errors (a list of server error rows) with no network and no keys.

import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { helpLead, helpText } from '../../lib/commands/registry.mjs';
import { createToolExecutor, summarizeOutcome } from '../../lib/chatTools.mjs';
import { FIXTURE_VALUES } from '../../lib/fixtures.mjs';
import { buildThreatRadar, threatRadarLead, KEV_URL } from '../../lib/threatRadar.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.css': 'text/css; charset=utf-8' };

// Check cards: one flagged wallet alone, and three checks in one reply.
export async function checkCards() {
  const execute = createToolExecutor({ role: 'operator', log: () => {} });
  const run = async (name, args, ms) => summarizeOutcome({ ...(await execute({ id: name, name, args })), ms });
  const W = FIXTURE_VALUES.wallet;
  const D = FIXTURE_VALUES.domain;
  return {
    single: [await run('check_wallet_sanctions', { address: W.FLAGGED }, 412)],
    many: [
      await run('check_domain_age', { domain: D.CLEAN }, 287),
      await run('check_hostname_reputation', { hostname: D.FLAGGED }, 301),
      await run('check_wallet_sanctions', { address: W.UNKNOWN }, 5012)
    ]
  };
}

// The threat radar from seeded feed rows (NVD) and the known exploited
// catalog: two actively exploited CVEs, the rest with no flags.
export async function radarView(now = Date.now()) {
  const iso = (h) => new Date(now - h * 3600e3).toISOString();
  const rows = [['CVE-2026-41001', 2], ['CVE-2026-40877', 9], ['CVE-2026-40512', 31], ['CVE-2026-39990', 53], ['CVE-2026-39101', 84], ['CVE-2026-38420', 98], ['CVE-2026-37007', 134]]
    .map(([value, h]) => ({ value, indicator_type: 'CVE', verification_source: 'NVD', ingested_at: iso(h) }));
  const kev = { vulnerabilities: [{ cveID: 'CVE-2026-40877', dateAdded: '2026-10-15' }, { cveID: 'CVE-2026-38420', dateAdded: '2026-10-12' }] };
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u === KEV_URL) return new Response(JSON.stringify(kev), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/rest/v1/threat_ioc_telemetry')) return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('[]', { status: 404 });
  };
  return buildThreatRadar({ supUrl: 'https://db.test', supKey: 'k', fetchImpl, env: {}, now });
}

// A fake credential in an upstream message (the log must never show it),
// built at runtime so no scanner mistakes it for a real one.
export const FAKE_AUTH = ['Authorization: Be', 'arer sk-', 'ant-api03-', 'SECRET'.repeat(3)].join('');

// Server error rows as /api/errors lists them (newest first).
export function errorRows(now = Date.now()) {
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  return [
    { id: 'e1', source: 'server', route: '/api/chat', reason: 'ai_unavailable', category: 'http_5xx', message: `Every engine was busy (router: 429 on the free engines). ${FAKE_AUTH}`, count: 12, first_seen: iso(50 * 60000), last_seen: iso(2 * 60000), time: iso(2 * 60000), resolved: false, request_id: 'req7f3a91c2' },
    { id: 'e2', source: 'server', route: '/api/mcp:check_wallet_age', reason: 'upstream', category: 'upstream', message: 'Block explorer did not answer within 8 s', count: 3, first_seen: iso(3 * 3600000), last_seen: iso(40 * 60000), time: iso(40 * 60000), resolved: false, request_id: 'req19bb04de' },
    { id: 'e3', source: 'server', route: 'film render', reason: 'film', category: 'js_error', message: "TypeError: Cannot read properties of undefined (reading 'shots')\n    at planCuts (lib/film/cuts.mjs:88:21)\n    at renderFull (lib/film/pipeline.mjs:412:9)", count: 1, first_seen: iso(5 * 3600000), last_seen: iso(5 * 3600000), time: iso(5 * 3600000), resolved: false, request_id: 'req55c0aa10' },
    { id: 'e4', source: 'client', route: null, reason: 'network', category: 'network', message: 'Offline: message not sent.', count: 2, first_seen: iso(7 * 3600000), last_seen: iso(6 * 3600000), time: iso(6 * 3600000), resolved: false, request_id: null }
  ];
}

// legacyHelp: /help answers as before PR A (the bullet list), for the
// before screenshots.
export function startCommandCentreServer({ publicDir, cards = { single: [], many: [] }, errors = [], legacyHelp = false, radar = null } = {}) {
  const log = { prompts: [], resolved: [], paths: [] };
  const rows = errors.map((r) => ({ ...r }));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    log.paths.push(url.pathname);
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch (e) { parsed = null; }
      const json = (status, b) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/health') return json(200, { status: 'ok' });
        if (url.pathname === '/api/errors') {
          if (parsed && parsed.op === 'resolve') { log.resolved.push(parsed.id); const r = rows.find((x) => x.id === parsed.id); if (r) r.resolved = true; return json(200, { ok: true }); }
          if (parsed && parsed.op === 'list') return json(200, { ok: true, errors: rows });
          return json(200, { ok: true });
        }
        if (url.pathname === '/api/handoffs') return json(200, { handoffs: [] });
        if (url.pathname === '/api/threads') return json(200, { threads: [] });
        if (url.pathname === '/api/watches') return json(200, { ok: true, reports: [] });
        if (url.pathname === '/api/chat') {
          if (parsed && parsed.prompt === 'AUTH_VERIFY') return json(200, { authenticated: true });
          if (parsed && parsed.action === 'SPEAK') return json(200, { reply: 'ok' });
          const prompt = String((parsed && parsed.prompt) || '');
          log.prompts.push(prompt);
          if (prompt === '/help') return json(200, legacyHelp ? { reply: helpText() } : { reply: helpLead(), commandPanel: true, helpText: helpText() });
          if (prompt === '/threat-radar' && radar) return json(200, { reply: threatRadarLead(radar), threatRadar: radar });
          if (prompt === 'check that wallet') return json(200, { reply: 'One wallet checked: it is on a sanctions list.', toolResults: cards.single });
          if (prompt === 'check these three') return json(200, { reply: 'Three checks ran. One hostname is flagged; one domain could not be checked.', toolResults: cards.many });
          return json(200, { reply: `Ran ${prompt}.` });
        }
        return json(404, { error: 'not stubbed' });
      }
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = normalize(join(publicDir, rel));
      if (!file.startsWith(publicDir) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      const data = readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Length': data.length });
      res.end(data);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, log, origin: `http://127.0.0.1:${server.address().port}` })));
}

// A signed-in phone page (dark), ready for commands.
export async function openPhonePage(browser, origin, { width = 380, height = 844, routeReplyFont, reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', reducedMotion });
  if (routeReplyFont) await routeReplyFont(context);
  await context.addInitScript(() => { try { localStorage.setItem('pg1_theme', 'dark'); } catch (e) {} });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String((err && err.message) || err)));
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });
  return { context, page, errors };
}

export async function sendAndSettle(page, text) {
  const n = await page.locator('#chat-container .message-bubble:not(.user)').count();
  await page.fill('#prompt-input', text);
  await page.click('.execute-btn');
  await page.waitForFunction((k) => {
    const b = document.querySelectorAll('#chat-container .message-bubble:not(.user)');
    return b.length > k && !b[b.length - 1].classList.contains('pending');
  }, n);
  return page.locator('#chat-container .message-bubble:not(.user)').nth(n);
}
