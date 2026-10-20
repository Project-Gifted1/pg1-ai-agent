/**
 * Chat routing (lib/chatRoute.mjs), the "Live search was unavailable"
 * footer and paid search grounding (api/chat.mjs), and GitHub Models
 * discovery (lib/router/modelCatalog.mjs, lib/keysStatus.mjs).
 *
 * Production, 19-20 Oct: "[chat] route=search reason=default" on every
 * request, small talk included; a rate-limited free key held each reply
 * ~19 s and every reply got the footer. GitHub Models: "[pg1-models]
 * provider=github_models ok=false listed=0 status=200".
 *
 * Run with: node --test tests/chat-route-and-models.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { chooseChatRoute, searchRouteReason, CHAT_ROUTES } from '../lib/chatRoute.mjs';
import { __resetRouterState } from '../lib/aiRouter.mjs';
import { __resetFreeLimiters } from '../lib/router/freeLimiter.mjs';
import { __resetAlerts } from '../lib/router/alerts.mjs';
import {
  PARSERS, refreshCatalog, catalogModelIds, catalogState, defaultModels, emptyCatalogReason, MODEL_PREFERENCES, __resetModelCatalog
} from '../lib/router/modelCatalog.mjs';
import { keysStatus, STATES, __resetKeysCache } from '../lib/keysStatus.mjs';
import chatHandler, { __clearAuthRateLimitState, paidGroundingAllowed, TOOLS_OFF_NOTE } from '../api/chat.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const FREE = 'AIzaStub-free-key-route-0123456789';
const PAID = 'AQ.Stub-paid-key-route-0123456789';
const GATEWAY = 'vck_stub_gateway_route_0123456789';
const FOOTER = 'Live search was unavailable for this answer.';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const GEMINI_429 = (secs) => JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: `Please retry in ${secs}s.`, details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${secs}s` }] } });
const CAND = (text) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
// The JSON call or the streamed one (server-sent events), as the URL asks.
const geminiText = (text, url = '') => (String(url).includes('streamGenerateContent') ? new Response(`data: ${JSON.stringify(CAND(text))}\n\n`) : json(CAND(text)));

beforeEach(() => {
  __resetRouterState();
  __resetFreeLimiters();
  __resetAlerts();
  __resetModelCatalog();
  __resetKeysCache();
  __clearAuthRateLimitState();
  for (const k of Object.keys(process.env)) if (/^(GEMINI_|ANTHROPIC|ANTROPIC|OPENAI|OPENROUTER|OPEN_ROUTER|VERCEL_AI|AI_GATEWAY|GROQ|MISTRAL|GITHUB|CLOUDFLARE|SUPABASE|PG1_|CARTESIA|REPLICATE|ELEVENLABS)/.test(k)) delete process.env[k];
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

function makeReq(body) {
  return {
    method: 'POST', url: '/api/chat',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.77', authorization: 'Basic ' + Buffer.from('test-operator:test-secret-pass').toString('base64') },
    body: { user: 'test-operator', pass: 'test-secret-pass', ...body }
  };
}
function makeRes() {
  const res = { statusCode: 200, headers: {}, chunks: [], jsonBody: null, ended: false };
  res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; };
  res.getHeader = (k) => res.headers[String(k).toLowerCase()];
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.jsonBody = b; res.ended = true; return res; };
  res.writeHead = (c, h) => { res.statusCode = c; Object.assign(res.headers, h || {}); return res; };
  res.write = (c) => { res.chunks.push(String(c)); return true; };
  res.end = (c) => { if (c) { try { res.jsonBody = JSON.parse(String(c)); } catch (e) { res.chunks.push(String(c)); } } res.ended = true; return res; };
  res.flushHeaders = () => {};
  res.on = () => res;
  return res;
}
async function chat(body) {
  const res = makeRes();
  await chatHandler(makeReq(body), res);
  return res.jsonBody ? res.jsonBody.reply : res.chunks.join('');
}
const routeLog = async (fn) => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return lines.filter((l) => l.startsWith('[chat] route='));
};

// --- routing --------------------------------------------------------------------------

test('small talk routes to plain chat; news, prices, versions, URLs and explicit searches to search, with a logged reason', () => {
  for (const q of ['hi', 'hello PG1', 'how are you today?', 'thanks, that helped', 'good morning!', 'tell me a joke', 'explain what a nonce is']) {
    assert.deepEqual(chooseChatRoute(q), { route: CHAT_ROUTES.CHAT, reason: 'no_current_info' }, q);
  }
  assert.equal(searchRouteReason('what is the latest news on x402?'), 'needs_current_info');
  assert.equal(searchRouteReason('price of ETH right now'), 'needs_current_info');
  assert.equal(searchRouteReason('what is the current version of Node.js'), 'needs_current_info');
  assert.equal(searchRouteReason('please search for the Base gas fees'), 'explicit_search');
  assert.equal(searchRouteReason('look up the Pectra upgrade'), 'explicit_search');
  assert.equal(searchRouteReason('read https://example.org/post'), 'url');
  assert.equal(chooseChatRoute('latest news on x402').reason, 'needs_current_info');
});

test('the log line names the route and reason: small talk is route=chat, a news question route=search reason=needs_current_info', async () => {
  process.env.GEMINI_API_KEY_FREE = FREE;
  globalThis.fetch = async (url) => (String(url).includes('generativelanguage') ? geminiText('Hello!') : (() => { throw new Error('Unexpected ' + url); })());
  const a = await routeLog(() => chat({ prompt: 'hello, how are you?' }));
  assert.match(a[0], /^\[chat\] route=chat reason=no_current_info /);
  const b = await routeLog(() => chat({ prompt: 'what is the latest news on x402?' }));
  assert.match(b[0], /^\[chat\] route=search reason=needs_current_info /);
});

// --- the footer -----------------------------------------------------------------------

test('small talk answered by the free key: no search request, no footer (JSON and streamed)', async () => {
  process.env.GEMINI_API_KEY_FREE = FREE;
  for (const stream of [false, true]) {
    const bodies = [];
    globalThis.fetch = async (url, o = {}) => { bodies.push(JSON.parse(o.body)); return geminiText('Doing well, thanks!', url); };
    const out = await chat({ prompt: 'hey, how are you today?', ...(stream ? { stream: true } : {}) });
    assert.match(out, /Doing well/);
    assert.ok(!out.includes(FOOTER), 'no footer');
    assert.ok(bodies.every((b) => b.tools === undefined), 'no google_search on a chat-route request');
  }
});

test('a "latest news" question searches; when search works there is no footer', async () => {
  process.env.GEMINI_API_KEY_FREE = FREE;
  const bodies = [];
  globalThis.fetch = async (url, o = {}) => { bodies.push(JSON.parse(o.body)); return geminiText('Pectra shipped.'); };
  const out = await chat({ prompt: 'latest news on EIP-7702' });
  assert.equal(out, 'Pectra shipped.');
  assert.deepEqual(bodies[0].tools, [{ google_search: {} }]);
});

test('a search failure shows the footer exactly once (rate-limited search engine, backup answers)', async () => {
  process.env.GEMINI_API_KEY_FREE = FREE;
  process.env.VERCEL_AI_API_KEY = GATEWAY;
  for (const stream of [false, true]) {
    __resetRouterState();
    globalThis.fetch = async (url) => (String(url).includes('generativelanguage') ? new Response(GEMINI_429(40), { status: 429 }) : json({ choices: [{ message: { content: 'From what I know: no news.' } }] }));
    const out = await chat({ prompt: 'latest news on EIP-7702', ...(stream ? { stream: true } : {}) });
    assert.equal(out.split(FOOTER).length - 1, 1, stream ? 'streamed' : 'JSON');
  }
  assert.doesNotMatch(TOOLS_OFF_NOTE, /gemini|google|groq|openai|vercel/i, 'PG1 words only');
});

// --- paid search grounding --------------------------------------------------------------

test('paid search grounding runs only when PG1_DAILY_SPEND_CAP_USD allows it (unset or $0 = never)', async () => {
  assert.equal(paidGroundingAllowed({}), false, 'unset');
  assert.equal(paidGroundingAllowed({ PG1_DAILY_SPEND_CAP_USD: '0' }), false, '$0');
  assert.equal(paidGroundingAllowed({ PG1_DAILY_SPEND_CAP_USD: '2' }), true, 'under a $2 cap');
  process.env.GEMINI_API_KEY_PAID = PAID;
  const bodies = [];
  globalThis.fetch = async (url, o = {}) => { bodies.push(JSON.parse(o.body)); return geminiText('From what I know.'); };
  const out = await chat({ prompt: 'latest news on EIP-7702' });
  assert.ok(bodies.length && bodies.every((b) => b.tools === undefined), 'the paid key was asked without search');
  assert.equal(out.split(FOOTER).length - 1, 1, 'search withheld: footer once');
  process.env.PG1_DAILY_SPEND_CAP_USD = '3';
  bodies.length = 0;
  const out2 = await chat({ prompt: 'latest news on EIP-7702 please' });
  assert.deepEqual(bodies[0].tools, [{ google_search: {} }], 'with a cap above $0: grounded');
  assert.ok(!out2.includes(FOOTER));
});

// --- GitHub Models discovery ------------------------------------------------------------

const GH_MODEL = (id, extra = {}) => ({ id, name: id.split('/')[1], publisher: 'x', rate_limit_tier: 'low', supported_input_modalities: ['text', 'image'], supported_output_modalities: ['text'], limits: { max_input_tokens: 131072 }, ...extra });

test('the GitHub Models parser takes every catalog shape seen: a bare array, { models }, a paged envelope, ids in name, modalities in any case', () => {
  const arr = [GH_MODEL('openai/gpt-4.1'), GH_MODEL('openai/text-embedding-3-small', { supported_output_modalities: ['embeddings'] })];
  assert.deepEqual(PARSERS.github_models(arr).map((m) => m.id), ['openai/gpt-4.1'], 'embeddings left out');
  assert.equal(PARSERS.github_models({ models: arr }).length, 1);
  assert.equal(PARSERS.github_models({ data: arr }).length, 1);
  assert.equal(PARSERS.github_models({ items: arr, next: null }).length, 1);
  assert.deepEqual(PARSERS.github_models([{ name: 'openai/gpt-4o-mini', supported_input_modalities: ['TEXT'], supported_output_modalities: ['Text'] }]).map((m) => m.id), ['openai/gpt-4o-mini']);
  assert.equal(emptyCatalogReason([], true), 'empty_list');
  assert.equal(emptyCatalogReason({ message: 'x', documentation_url: 'y' }, true), 'unknown_shape:message,documentation_url');
  assert.equal(emptyCatalogReason(null, false), 'not_json');
});

test('empty GitHub Models discovery falls back to the known-good default list, and the log says why', async () => {
  const lines = [];
  await refreshCatalog('github_models', { key: 'github_pat_x', fetchImpl: async () => json([]), log: (l) => lines.push(l) });
  assert.match(lines[0], /provider=github_models ok=false listed=0 status=200 reason=empty_list fallback=defaults/);
  const ids = catalogModelIds('github_models', 'light');
  assert.deepEqual(ids, [...MODEL_PREFERENCES.github_models.light], 'the default list, best first');
  assert.ok(defaultModels('github_models').length >= ids.length);
  assert.deepEqual(catalogState('github_models'), { listed: 0, status: 200, reason: 'empty_list', fallback: true, at: catalogState('github_models').at });
  // A later good read replaces the defaults.
  lines.length = 0;
  await refreshCatalog('github_models', { key: 'github_pat_x', force: true, fetchImpl: async () => json([GH_MODEL('openai/gpt-4.1-mini')]), log: (l) => lines.push(l) });
  assert.match(lines[0], /ok=true listed=1 status=200$/);
  assert.deepEqual(catalogModelIds('github_models', 'light'), ['openai/gpt-4.1-mini']);
});

test('/keys shows the real GitHub Models state: models listed, and a token without models:read', async () => {
  const env = { GITHUB_MODELS_TOKEN: 'github_pat_keys_SECRET_0123456789' };
  const run = (catalog, call) => keysStatus({ env, fresh: true, fetchImpl: async (url) => (String(url).includes('/catalog/') ? catalog() : call()) });
  let row = (await run(() => json([GH_MODEL('openai/gpt-4.1')]), () => json({ choices: [{ message: { content: '.' } }] }))).find((r) => r.engine === 'github_models');
  assert.equal(row.state, STATES.WORKING);
  assert.match(row.note, /catalog lists 1 chat models; a free-tier call answered/);
  __resetKeysCache();
  row = (await run(() => json([]), () => json({ error: { code: 'unauthorized', message: 'The `models` permission is required to access this endpoint' } }, 403))).find((r) => r.engine === 'github_models');
  assert.equal(row.state, STATES.INVALID);
  assert.match(row.note, /catalog lists 0 models \(empty_list\); using the default model list; the token cannot call models: give it the models:read permission/);
  assert.ok(!JSON.stringify(row).includes('SECRET'));
});
