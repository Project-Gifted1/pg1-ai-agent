/**
 * The 5/day free tier is automatic and shared (lib/freeTier.mjs): a new
 * caller gets FREE_TIER_DAILY_LIMIT free paid calls before the first payment
 * challenge on every paid route (/api/mcp tools/call, /api/a2a paid skills,
 * GET/POST /api/ioc), and all of them spend ONE counter per caller. It used
 * to need an "X-Free-Tier: 1" header that browsers and MCP clients never
 * send, so callers went straight to the 402.
 *
 * Also: X-Free-Tier: 0 opts out (the 402 at once, counter untouched); a
 * caller offering a payment is never served free; HEAD never spends a call;
 * a browser gets PG1's own 402 page (lib/paywallPage.mjs) while JSON
 * clients get the exact same 402 as before.
 *
 * X402_PAY_TO_ADDRESS is unset, so the challenge is the deployment's
 * fallback one (MCP / A2A: PaymentRequired with no accepts; /api/ioc: the
 * generic 402); tests/phase2-funnel.test.mjs covers the paid x402 paths.
 *
 * Run with: node --test tests/free-tier-routes.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';

// These tests exercise the paid /api/ioc gate, so the feed is made paid
// (it is free by default while it holds no current data; tests/feed-pricing.test.mjs).
process.env.PG1_FEED_PAID = 'true';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function baseEnv() {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.TELEMETRY_IP_SALT = 'free-tier-routes-salt';
  delete process.env.X402_PAY_TO_ADDRESS;
  delete process.env.GUMROAD_PRODUCT_ID;
  delete process.env.USER_API_KEY;
  delete process.env.USER_API_PASS;
}
baseEnv();

const { default: mcpHandler } = await import('../api/mcp.mjs');
const { default: a2aHandler } = await import('../api/a2a.mjs');
const { default: chatHandler } = await import('../api/chat.mjs');
const { FREE_TIER_DAILY_LIMIT, freeTierOptedOut, isFreeTierSkippedUserAgent, freeTierKey } = await import('../lib/freeTier.mjs');
const { pg1Paywall, renderPaywallPage } = await import('../lib/paywallPage.mjs');

let counters;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function installFetch() {
  counters = new Map();
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = (options.method || 'GET').toUpperCase();
    if (url.hostname === 'services.nvd.nist.gov') {
      return json({ vulnerabilities: [{ cve: { id: 'CVE-2021-44228', published: '2021-12-10T00:00:00Z', descriptions: [{ lang: 'en', value: 'Log4Shell' }], metrics: {} } }] });
    }
    if (url.hostname === 'www.cisa.gov') return json({ vulnerabilities: [] });
    if (url.pathname === '/rest/v1/free_tier_usage') {
      const id = decodeURIComponent((url.searchParams.get('identifier') || '').replace(/^eq\./, ''));
      if (method === 'GET') return json(counters.has(id) ? [{ request_count: counters.get(id) }] : []);
      if (method === 'PATCH') { counters.set(id, JSON.parse(options.body).request_count); return new Response(null, { status: 204 }); }
      if (method === 'POST') { const b = JSON.parse(options.body); counters.set(b.identifier, b.request_count); return new Response(null, { status: 201 }); }
    }
    if (url.pathname === '/rest/v1/threat_ioc_telemetry') {
      return json([{ indicator_type: 'CVE', value: 'CVE-2021-44228', confidence_score: 90, last_seen: '2026-10-01T00:00:00Z', ingested_at: '2026-10-01T00:00:00Z', verification_source: 'NVD' }]);
    }
    if (url.pathname.startsWith('/rest/v1/')) return json([]);
    throw new Error(`unexpected fetch in test: ${url.hostname}${url.pathname}`);
  };
}

beforeEach(() => { baseEnv(); installFetch(); });
after(() => { process.env = { ...ORIGINAL_ENV }; global.fetch = ORIGINAL_FETCH; });

function makeRes() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; },
    end(b) { if (typeof b === 'string') { try { this.body = JSON.parse(b); } catch { this.body = b; } } return this; }
  };
}

let ipCounter = 0;
const newCaller = () => `203.0.113.${++ipCounter}`;

// One paid call on each route. Returns { served, challenged, remaining }.
const ROUTES = {
  async mcp(ip, headers = {}) {
    const res = makeRes();
    await mcpHandler({ method: 'POST', headers: { 'x-forwarded-for': ip, ...headers }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_cve_details', arguments: { cve_id: 'CVE-2021-44228' } } } }, res);
    const result = res.body.result || {};
    const challenged = result.isError === true && result.structuredContent && result.structuredContent.x402Version === 2;
    return { served: res.statusCode === 200 && !result.isError, challenged, remaining: res.headers['X-Free-Tier-Remaining'] };
  },
  async a2a(ip, headers = {}) {
    const res = makeRes();
    await a2aHandler({ method: 'POST', headers: { 'x-forwarded-for': ip, ...headers }, query: {}, body: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: 'm', parts: [{ kind: 'data', data: { skill: 'get_cve_details', arguments: { cve_id: 'CVE-2021-44228' } } }] } } } }, res);
    const state = res.body.result && res.body.result.status.state;
    return { served: state === 'completed', challenged: state === 'input-required', remaining: res.headers['X-Free-Tier-Remaining'] };
  },
  async ioc(ip, headers = {}, method = 'GET') {
    const res = makeRes();
    await chatHandler({ method, url: '/api/ioc', headers: { 'x-forwarded-for': ip, ...headers }, socket: { remoteAddress: ip }, body: null }, res);
    return { served: res.statusCode === 200 && res.body && res.body.type === 'bundle', challenged: res.statusCode === 402, remaining: res.headers['X-Free-Tier-Remaining'] };
  }
};

for (const [name, call] of Object.entries(ROUTES)) {
  test(`${name}: a new caller with no headers gets ${FREE_TIER_DAILY_LIMIT} free paid calls before the first payment challenge`, async () => {
    const ip = newCaller();
    for (let i = 1; i <= FREE_TIER_DAILY_LIMIT; i++) {
      const r = await call(ip);
      assert.equal(r.served, true, `call ${i} served free`);
      assert.equal(r.challenged, false, `call ${i} not challenged`);
      assert.equal(r.remaining, String(FREE_TIER_DAILY_LIMIT - i), `call ${i} remaining header`);
    }
    const sixth = await call(ip);
    assert.equal(sixth.served, false);
    assert.equal(sixth.challenged, true, 'the 6th call gets the payment challenge');
    assert.equal(sixth.remaining, '0');
    assert.equal(counters.get(freeTierKey(ip)), FREE_TIER_DAILY_LIMIT);
  });

  test(`${name}: X-Free-Tier: 0 skips the free tier and gets the challenge at once, counter untouched`, async () => {
    const ip = newCaller();
    const r = await call(ip, { 'x-free-tier': '0' });
    assert.equal(r.challenged, true);
    assert.equal(counters.has(freeTierKey(ip)), false);
  });

  test(`${name}: a caller offering a payment is never served free`, async () => {
    const ip = newCaller();
    const r = await call(ip, { 'payment-signature': 'not-a-valid-payment' });
    assert.equal(r.served, false);
    assert.equal(counters.has(freeTierKey(ip)), false);
  });
}

test('one counter per caller, shared by /api/mcp, /api/a2a and /api/ioc', async () => {
  const ip = newCaller();
  const order = ['mcp', 'a2a', 'ioc', 'mcp', 'a2a'];
  for (const [i, route] of order.entries()) {
    const r = await ROUTES[route](ip);
    assert.equal(r.served, true, `${route} call ${i + 1} served free`);
    assert.equal(r.remaining, String(FREE_TIER_DAILY_LIMIT - i - 1), `${route} call ${i + 1} remaining`);
  }
  for (const route of ['mcp', 'a2a', 'ioc']) {
    const r = await ROUTES[route](ip);
    assert.equal(r.challenged, true, `${route} challenges once the shared quota is spent`);
  }
  assert.equal(counters.get(freeTierKey(ip)), FREE_TIER_DAILY_LIMIT);
});

test('another caller keeps its own 5', async () => {
  const a = newCaller();
  for (let i = 0; i < FREE_TIER_DAILY_LIMIT; i++) await ROUTES.mcp(a);
  assert.equal((await ROUTES.mcp(a)).challenged, true);
  assert.equal((await ROUTES.ioc(newCaller())).served, true);
});

for (const [name, call] of Object.entries(ROUTES)) {
  test(`${name}: an x402 scanner or crawler (by User-Agent) gets the challenge at once, counter untouched`, async () => {
    const ip = newCaller();
    for (const ua of ['x402scan/1.0', 'Mozilla/5.0 (compatible; Googlebot/2.1)']) {
      const r = await call(ip, { 'user-agent': ua });
      assert.equal(r.challenged, true, ua);
    }
    assert.equal(counters.has(freeTierKey(ip)), false);
  });
}

test('scanner User-Agents skip the free tier; browsers and plain HTTP clients do not', () => {
  for (const ua of ['x402scan/1.0', 'Googlebot/2.1', 'UptimeRobot/2.0', 'some-crawler', 'x402-bazaar-indexer']) assert.equal(isFreeTierSkippedUserAgent(ua), true, ua);
  for (const ua of ['Mozilla/5.0 (X11; Linux x86_64) Chrome/130 Safari/537.36', 'node', 'curl/8.5.0', 'python-httpx/0.27', 'Claude-User/1.0', 'mcp-remote/0.1', 'Go-http-client/1.1', undefined]) assert.equal(isFreeTierSkippedUserAgent(ua), false, String(ua));
});

test('HEAD /api/ioc never spends a free call', async () => {
  const ip = newCaller();
  const r = await ROUTES.ioc(ip, {}, 'HEAD');
  assert.equal(r.challenged, true);
  assert.equal(counters.has(freeTierKey(ip)), false);
});

test('freeTierOptedOut: only an explicit no', () => {
  for (const v of ['0', 'false', 'No', ' off ']) assert.equal(freeTierOptedOut(v), true, v);
  for (const v of [undefined, '', '1', 'true', 'yes']) assert.equal(freeTierOptedOut(v), false, String(v));
});

// ---------------------------------------------------------------------
// The browser 402 page
// ---------------------------------------------------------------------

const PAYMENT_REQUIRED = {
  x402Version: 2,
  error: 'Payment required',
  resource: { url: 'https://pg1-ai-agent.vercel.app/api/ioc?type=CVE&x=<script>', description: 'feed', mimeType: 'application/stix+json' },
  accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x000000000000000000000000000000000000dEaD' }]
};

test('the PG1 402 page: what the endpoint is, the free allowance, the price, how agents pay; no placeholder, no script', () => {
  const html = renderPaywallPage(PAYMENT_REQUIRED);
  assert.match(html, /<title>PG1 Threat Intelligence: payment required<\/title>/);
  assert.match(html, /STIX 2\.1 bundle of CVE records from NIST NVD/);
  assert.match(html, new RegExp(`${FREE_TIER_DAILY_LIMIT} free calls`));
  assert.match(html, /0\.01 USD/);
  assert.match(html, /USDC on Base/);
  assert.match(html, /PAYMENT-SIGNATURE/);
  assert.match(html, /\/api\/mcp/);
  assert.match(html, /\/api\/a2a/);
  assert.doesNotMatch(html, /Note to developers|@x402\/paywall/);
  assert.doesNotMatch(html, /<script/i);
});

function stubFacilitator() {
  return {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }], extensions: [] }),
    verify: async () => ({ isValid: false, invalidReason: 'stub' }),
    settle: async () => ({ success: false })
  };
}

function expressReq(headers) {
  return {
    method: 'GET', path: '/api/ioc', url: '/api/ioc', originalUrl: '/api/ioc', protocol: 'https',
    headers: { host: 'pg1-ai-agent.vercel.app', ...headers },
    header(name) { return this.headers[String(name).toLowerCase()]; },
    get(name) { return this.header(name); },
    query: {}
  };
}

function expressRes() {
  const headers = {};
  return {
    statusCode: 200, headers, body: undefined,
    setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; }, getHeaders() { return headers; }, removeHeader(k) { delete headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.done(); return this; },
    send(b) { this.body = b; this.done(); return this; },
    end(b) { if (b !== undefined) this.body = b; this.done(); return this; },
    write() {}, writeHead() {}, flushHeaders() {}, done() {}
  };
}

async function runGate(paywall, headers) {
  const server = new x402ResourceServer(stubFacilitator()).register('eip155:8453', new ExactEvmScheme());
  await server.initialize();
  const cfg = { accepts: [{ scheme: 'exact', price: '$0.01', network: 'eip155:8453', payTo: '0x000000000000000000000000000000000000dEaD' }], description: 'test', mimeType: 'application/stix+json' };
  const mw = paymentMiddleware({ 'GET /api/ioc': cfg }, server, undefined, paywall, false);
  const res = expressRes();
  await new Promise((resolve) => { res.done = resolve; mw(expressReq(headers), res, resolve); });
  return res;
}

const BROWSER = { accept: 'text/html,application/xhtml+xml', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130' };

test('a browser gets PG1\'s 402 page with the same PAYMENT-REQUIRED header; an agent gets the unchanged JSON 402', async () => {
  const browser = await runGate(pg1Paywall, BROWSER);
  assert.equal(browser.statusCode, 402);
  const html = String(browser.body);
  assert.match(html, /PG1 Threat Intelligence/);
  assert.doesNotMatch(html, /Note to developers/);

  const before = await runGate(undefined, BROWSER);
  assert.match(String(before.body), /Note to developers/, 'the library placeholder this replaces');
  const header = (res) => res.headers['PAYMENT-REQUIRED'] || res.headers['payment-required'];
  assert.ok(header(browser));
  assert.deepEqual(JSON.parse(Buffer.from(header(browser), 'base64')).accepts, JSON.parse(Buffer.from(header(before), 'base64')).accepts);

  const agentWith = await runGate(pg1Paywall, { accept: 'application/json' });
  const agentWithout = await runGate(undefined, { accept: 'application/json' });
  assert.equal(agentWith.statusCode, 402);
  assert.deepEqual(agentWith.body, agentWithout.body, 'JSON body unchanged');
  assert.equal(header(agentWith), header(agentWithout), 'PAYMENT-REQUIRED header unchanged');
});
