/**
 * Search or tools, per message (lib/chatRoute.mjs and the Gemini request
 * builder in api/chat.mjs). Since #243 a chat request carried Google Search
 * and PG1's function declarations together; Gemini refused the pair, and the
 * first refusal switched search off for the rest of the server process with
 * no log. Now:
 *  - no Gemini request ever carries both
 *  - news / "latest" / general questions go the search way and return the
 *    search chip (searchEntryPoint) exactly as Google sent it
 *  - a domain, hostname, URL, wallet address, ENS name or a check's name
 *    goes the tools way (a real ENS lookup for a name, the flagged card for
 *    the flagged fixture)
 *  - a tools-route message that ran no check gets one search call; what the
 *    tools round wrote is never shown
 *  - a refused search is logged to pg1_errors with the request ID, the reply
 *    still comes (without search), and the next message asks for search
 *    again
 *  - identity, secret and neutral-error rules hold on both routes
 *
 * Run with: node --test tests/search-tools-routing.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { createSseParser } from '../lib/chatStream.mjs';
import { CHAT_ROUTES, chooseChatRoute, searchAfterTools, wantsCurrentInfo } from '../lib/chatRoute.mjs';
import { FIXTURE_VALUES } from '../lib/fixtures.mjs';
import { PG1_IDENTITY_REPLY } from '../lib/identity.mjs';
import { namehash } from '../lib/ens.mjs';
import { FAKE } from './fixtures/fake-secrets.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const WALLET = FIXTURE_VALUES.wallet;
const DOMAIN = FIXTURE_VALUES.domain;

function resetEnv() {
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GEMINI_API_KEY = 'stub-gemini-key';
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASEAPI_KEY', 'CARTESIA_API_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER_KEY', 'PG1_CHAT_TOOL_TIMEOUT_MS', 'ALCHEMY_API_KEY']) delete process.env[k];
}

beforeEach(() => {
  resetEnv();
  __clearAuthRateLimitState();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

let ipSeq = 0;
const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.98.0.${++ipSeq}` }, body });
const authed = (extra) => ({ user: 'test-operator', pass: 'test-secret-pass', stream: true, ...extra });

function makeRes() {
  return {
    statusCode: null, headers: {}, chunks: [], jsonBody: null, ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; },
    end() { this.ended = true; return this; },
    on() {}
  };
}

function eventsOf(res) {
  const out = [];
  const parser = createSseParser(({ data }) => out.push(JSON.parse(data)));
  parser.push(res.chunks.join(''));
  parser.end();
  return out;
}

async function run(body) {
  const res = makeRes();
  await chatHandler(makeReq(body), res);
  return res;
}

const textOf = (events) => events.filter((e) => e.type === 'text').map((e) => e.text).join('');
const sseBody = (objs) => objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('');

// The chip Google sends with a grounded answer. Rendered by the client
// exactly as sent, so it must arrive byte for byte.
const CHIP = '<style>.container{display:flex}</style><div class="container"><div class="headline">Google Search Suggestions</div><a class="chip" href="https://www.google.com/search?q=EIP-7702">EIP-7702 news</a></div>';
const grounded = (text) => ({ candidates: [{ content: { parts: [{ text }] }, groundingMetadata: { webSearchQueries: ['EIP-7702 news'], searchEntryPoint: { renderedContent: CHIP } } }] });
const plain = (text) => ({ candidates: [{ content: { parts: [{ text }] } }] });
const callsOf = (calls) => ({ candidates: [{ content: { parts: calls.map(([name, args]) => ({ functionCall: { name, args }, thoughtSignature: 'sig-' + name })) } }] });

const hasSearch = (body) => (body.tools || []).some((t) => t.google_search);
const hasFns = (body) => (body.tools || []).some((t) => t.functionDeclarations);
const hasResponses = (body) => (body.contents || []).some((c) => (c.parts || []).some((p) => p.functionResponse));

// A stub main core. `search(body)` answers a search request, `tools(body)`
// a tools request; either may return a Response for an HTTP error. A
// request that carries both is a test failure: it is what Gemini refuses.
function geminiStub({ search, tools }) {
  const answer = (body) => {
    assert.ok(!(hasSearch(body) && hasFns(body)), 'a Gemini request never carries search and function declarations together');
    return hasFns(body) ? tools(body) : search(body);
  };
  return [
    ['streamGenerateContent', (u, o, body) => { const p = answer(body); return p instanceof Response ? p : new Response(sseBody([p])); }],
    ['generateContent', (u, o, body) => { const p = answer(body); return p instanceof Response ? p : new Response(JSON.stringify(p), { headers: { 'Content-Type': 'application/json' } }); }]
  ];
}

function installFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    let body = null;
    try { body = options.body ? JSON.parse(options.body) : null; } catch (e) { body = options.body; }
    calls.push({ url: u, method: options.method || 'GET', body, headers: options.headers || {} });
    for (const [needle, handler] of routes) {
      if (u.includes(needle)) return handler(u, options, body);
    }
    throw new Error('Unexpected network call in test: ' + u);
  };
  return calls;
}

const geminiRequests = (calls) => calls.filter((c) => c.url.includes('generativelanguage.googleapis.com'));

const supabaseRoutes = () => [
  ['/rest/v1/messages?select=id', () => new Response('[]')],
  ['/rest/v1/messages?select=role', () => new Response('[]')],
  ['/rest/v1/messages', () => new Response('[]', { status: 201 })],
  ['/storage/v1/object/list/pg1-vault', () => new Response('[]')],
  ['/rest/v1/threat_indicators', () => new Response('[]')],
  ['/rest/v1/pg1_errors', (u, o) => new Response(o.method === 'POST' ? '' : '[]', { status: o.method === 'POST' ? 201 : 200 })]
];

async function errorLogRows(calls, min = 1) {
  for (let i = 0; i < 100; i++) {
    const rows = calls.filter((c) => c.url.includes('/rest/v1/pg1_errors') && (c.method === 'POST' || c.method === 'PATCH'));
    if (rows.length >= min) return rows.map((c) => c.body);
    await new Promise((r) => setTimeout(r, 5));
  }
  return calls.filter((c) => c.url.includes('/rest/v1/pg1_errors') && (c.method === 'POST' || c.method === 'PATCH')).map((c) => c.body);
}

// A mainnet RPC stub that knows one name: `name` -> `address`.
function ensRoute(name, address) {
  const node = namehash(name).slice(2);
  const resolver = '0x' + '12'.repeat(20);
  const word = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
  return ['eth-mainnet.g.alchemy.com', (u, o, body) => {
    const { to, data } = body.params[0];
    const known = data.endsWith(node);
    const result = !known ? '0x' + '0'.repeat(64) : to === '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e' ? word(resolver) : word(address);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  }];
}

// --- the router -----------------------------------------------------------------------

test('the router: checks for domains, hostnames, URLs, IPs, wallets, ENS names and named checks; search for everything else', () => {
  const tools = [
    ['check wallet age for vitalik.eth on Base', 'ens_name'],
    ['how old is pg1-test-flagged.invalid?', 'hostname'],
    ['how old is example.co.uk', 'hostname'],
    ['is https://login.example.com/reset safe?', 'url'],
    [`check ${WALLET.CLEAN}`, 'wallet_address'],
    ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq on the sanctions list?', 'wallet_address'],
    ['check 192.0.2.1', 'ip_address'],
    ['run a hostname reputation check', 'check_name'],
    ['use check_domain_age', 'check_name'],
    ['check CVE-2024-3094', 'check_request']
  ];
  for (const [msg, reason] of tools) assert.deepEqual(chooseChatRoute(msg), { route: CHAT_ROUTES.TOOLS, reason }, msg);
  const search = ['latest news on EIP-7702', 'what is the price of ETH today?', 'who is Vitalik Buterin', 'hello', 'Node.js vs Next.js',
    'fix the bug in README.md and api/chat.mjs', 'version 1.2.3 is out', 'latest on CVE-2024-3094'];
  for (const msg of search) assert.deepEqual(chooseChatRoute(msg), { route: CHAT_ROUTES.SEARCH, reason: 'default' }, msg);
  assert.equal(chooseChatRoute(`check ${WALLET.CLEAN}`, { hasTools: false }).route, CHAT_ROUTES.SEARCH, 'no checks for the role, always search');

  assert.equal(wantsCurrentInfo('what is the latest news about vitalik.eth'), true);
  assert.equal(wantsCurrentInfo('check CVE-2024-3094'), false, 'a year inside a CVE id is not a date');
  assert.equal(searchAfterTools('latest news about vitalik.eth', { text: 'I cannot check news.', outcomes: [] }), true);
  assert.equal(searchAfterTools('latest news about vitalik.eth', { text: 'x', outcomes: [{}] }), false, 'a check ran: no search');
  assert.equal(searchAfterTools('how old is vitalik.eth', { text: 'Which chain?', outcomes: [] }), false, 'a plain answer stands');
  assert.equal(searchAfterTools('how old is vitalik.eth', { text: '', outcomes: [] }), true, 'no answer at all');
  assert.equal(searchAfterTools('latest about vitalik.eth', { text: '', outcomes: [], aborted: true }), false);
});

// --- search route ---------------------------------------------------------------------

test('"latest news on EIP-7702" (streamed): search only, no checks offered, the chip arrives exactly as Google sent it', async () => {
  const calls = installFetch(geminiStub({ search: () => grounded('EIP-7702 shipped with Pectra.'), tools: () => assert.fail('no tools request') }));
  const events = eventsOf(await run(authed({ prompt: 'latest news on EIP-7702' })));
  const done = events[events.length - 1];
  assert.equal(done.type, 'done');
  assert.equal(done.searchEntryPoint, CHIP);
  assert.equal(textOf(events), 'EIP-7702 shipped with Pectra.');
  const gem = geminiRequests(calls);
  assert.equal(gem.length, 1);
  assert.deepEqual(gem[0].body.tools, [{ google_search: {} }]);
  assert.equal(gem[0].body.toolConfig, undefined);
  assert.ok(events.some((e) => e.type === 'step_done' && e.id === 'search' && e.label === 'Searched the web'));
});

test('"latest news on EIP-7702" (JSON): the reply carries the chip unchanged', async () => {
  installFetch(geminiStub({ search: () => grounded('EIP-7702 shipped with Pectra.'), tools: () => assert.fail('no tools request') }));
  const res = await run(authed({ prompt: 'latest news on EIP-7702', stream: false }));
  assert.equal(res.jsonBody.reply, 'EIP-7702 shipped with Pectra.');
  assert.equal(res.jsonBody.searchEntryPoint, CHIP);
  assert.equal(res.jsonBody.toolResults, undefined);
});

// --- tools route ----------------------------------------------------------------------

test('"check wallet age for vitalik.eth on Base": tools only, a real ENS lookup, no search and no chip', async () => {
  process.env.ALCHEMY_API_KEY = 'stub-alchemy-key';
  const calls = installFetch([
    ensRoute('vitalik.eth', WALLET.CLEAN),
    ...geminiStub({
      search: () => assert.fail('no search request'),
      tools: (body) => (hasResponses(body) ? plain('vitalik.eth: first seen in 2023, no flags.') : callsOf([['check_wallet_age', { address: 'vitalik.eth', chain: 'base' }]]))
    })
  ]);
  const events = eventsOf(await run(authed({ prompt: 'check wallet age for vitalik.eth on Base' })));
  const done = events[events.length - 1];
  assert.equal(done.type, 'done');
  assert.equal(done.searchEntryPoint, null);
  const gem = geminiRequests(calls);
  assert.equal(gem.length, 2);
  for (const g of gem) assert.ok(hasFns(g.body) && !hasSearch(g.body));
  const ens = calls.filter((c) => c.url.includes('eth-mainnet.g.alchemy.com'));
  assert.deepEqual(ens.map((c) => c.body.params[0].data.slice(0, 10)), ['0x0178b8bf', '0x3b3b57de'], 'registry, then resolver');
  const card = events.find((e) => e.type === 'tool_result');
  assert.equal(card.subject, WALLET.CLEAN, 'the address the lookup returned');
  assert.deepEqual(card.fields[0], { label: 'ENS name', value: 'vitalik.eth' });
});

test('"how old is pg1-test-flagged.invalid?": the flagged domain-age card', async () => {
  const calls = installFetch(geminiStub({
    search: () => assert.fail('no search request'),
    tools: (body) => (hasResponses(body) ? plain('That domain is flagged: registered 3 days ago.') : callsOf([['check_domain_age', { domain: DOMAIN.FLAGGED }]]))
  }));
  const events = eventsOf(await run(authed({ prompt: 'how old is pg1-test-flagged.invalid?' })));
  assert.equal(events[events.length - 1].type, 'done');
  const card = events.find((e) => e.type === 'tool_result');
  assert.equal(card.tool, 'check_domain_age');
  assert.equal(card.status, 'flagged');
  assert.equal(card.status_label, 'Flagged');
  assert.equal(card.subject, DOMAIN.FLAGGED);
  assert.equal(card.test_fixture, true);
  assert.ok(geminiRequests(calls).every((g) => !hasSearch(g.body)));
});

// --- mixed messages -------------------------------------------------------------------

test('mixed, no check run (streamed): the tools round is dropped unseen, one search call answers, the chip comes back', async () => {
  const calls = installFetch(geminiStub({
    search: () => grounded('vitalik.eth was in the news this week for EIP-7702.'),
    tools: () => plain('I cannot look up news with my checks.')
  }));
  const events = eventsOf(await run(authed({ prompt: 'what is the latest news about vitalik.eth?' })));
  const done = events[events.length - 1];
  assert.equal(done.type, 'done');
  assert.equal(textOf(events), 'vitalik.eth was in the news this week for EIP-7702.', 'the tools round text never reached the client');
  assert.equal(done.searchEntryPoint, CHIP);
  const gem = geminiRequests(calls);
  assert.equal(gem.length, 2);
  assert.ok(hasFns(gem[0].body) && !hasSearch(gem[0].body), 'tools first');
  assert.ok(hasSearch(gem[1].body) && !hasFns(gem[1].body), 'then search');
  assert.ok(events.some((e) => e.type === 'step_done' && e.id === 'model' && e.label === 'No check needed'));
  assert.ok(events.some((e) => e.type === 'step_done' && e.id === 'model-search' && e.label === 'Wrote the reply'));
  assert.equal(events.filter((e) => e.type === 'tool_result').length, 0);
});

test('mixed, no check run (JSON): the search answer and its chip replace the tools round', async () => {
  const calls = installFetch(geminiStub({
    search: () => grounded('vitalik.eth was in the news this week for EIP-7702.'),
    tools: () => plain('I cannot look up news with my checks.')
  }));
  const res = await run(authed({ prompt: 'what is the latest news about vitalik.eth?', stream: false }));
  assert.equal(res.jsonBody.reply, 'vitalik.eth was in the news this week for EIP-7702.');
  assert.equal(res.jsonBody.searchEntryPoint, CHIP);
  assert.equal(geminiRequests(calls).length, 2);
});

test('mixed, a check ran: the tools answer stands and no search request is made', async () => {
  const calls = installFetch(geminiStub({
    search: () => assert.fail('no search after a check ran'),
    tools: (body) => (hasResponses(body) ? plain('The domain has no flags.') : callsOf([['check_domain_age', { domain: DOMAIN.CLEAN }]]))
  }));
  const events = eventsOf(await run(authed({ prompt: `check ${DOMAIN.CLEAN} and tell me the latest news on EIP-7702` })));
  assert.equal(events[events.length - 1].type, 'done');
  assert.equal(events[events.length - 1].searchEntryPoint, null);
  assert.equal(events.find((e) => e.type === 'tool_result').status, 'no_flags');
  assert.ok(geminiRequests(calls).every((g) => !hasSearch(g.body)));
});

test('a tools-route message with no check and no current-information ask keeps its answer, no search call', async () => {
  const calls = installFetch(geminiStub({ search: () => assert.fail('no search'), tools: () => plain('Which chain should I check vitalik.eth on?') }));
  const events = eventsOf(await run(authed({ prompt: 'how old is vitalik.eth' })));
  assert.equal(textOf(events), 'Which chain should I check vitalik.eth on?');
  assert.equal(geminiRequests(calls).length, 1);
});

// --- a refused search -----------------------------------------------------------------

test('a refused search is logged to pg1_errors with the request ID, the reply still comes, and the next message searches again', async () => {
  process.env.SUPABASE_URL = 'https://stub.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = FAKE.supabaseSecretKey;
  const REJECTION = JSON.stringify({ error: { code: 400, message: 'Search Grounding is not supported for this request.', status: 'INVALID_ARGUMENT' } });
  let refuse = true;
  const calls = installFetch([
    ...supabaseRoutes(),
    ...geminiStub({
      search: (body) => (hasSearch(body) && refuse ? new Response(REJECTION, { status: 400 }) : hasSearch(body) ? grounded('Pectra went live.') : plain('From what I know, EIP-7702 adds delegation.')),
      tools: () => assert.fail('no tools request')
    })
  ]);

  const first = eventsOf(await run(authed({ prompt: 'latest news on EIP-7702' })));
  const done1 = first[first.length - 1];
  assert.equal(done1.type, 'done');
  assert.equal(textOf(first), 'From what I know, EIP-7702 adds delegation.', 'answered without search');
  assert.equal(done1.searchEntryPoint, null);
  const failedRow = first.find((e) => e.type === 'step_done' && e.id === 'search-failed');
  assert.deepEqual({ label: failedRow.label, result: failedRow.result, failed: failedRow.failed }, { label: 'Web search unavailable', result: 'answering without it', failed: true });
  // Neutral: nothing the operator sees carries the upstream's words.
  const shown = JSON.stringify(first);
  assert.ok(!/Grounding is not supported|INVALID_ARGUMENT|gemini|googleapis/i.test(shown), 'no upstream detail in the stream');

  const rows = await errorLogRows(calls);
  const row = rows.find((r) => r.reason === 'search_failed');
  assert.ok(row, 'a pg1_errors row for the refused search');
  assert.match(String(done1.request_id), /^\w{6,}$/);
  assert.equal(row.request_id, done1.request_id, 'logged under the reply\'s request ID');
  assert.match(row.message, /400/);
  assert.equal(row.category, 'upstream');

  const gem1 = geminiRequests(calls);
  assert.equal(gem1.length, 2);
  assert.ok(hasSearch(gem1[0].body));
  assert.equal(gem1[1].body.tools, undefined, 'the same message retried once without search');

  // The next message asks for search again, and gets it.
  refuse = false;
  const second = eventsOf(await run(authed({ prompt: 'latest news on EIP-7702' })));
  const done2 = second[second.length - 1];
  assert.equal(done2.type, 'done');
  assert.equal(done2.searchEntryPoint, CHIP);
  const gem2 = geminiRequests(calls).slice(2);
  assert.equal(gem2.length, 1);
  assert.deepEqual(gem2[0].body.tools, [{ google_search: {} }], 'search was not switched off');
});

test('every refusal is logged, message after message; search is asked for each time', async () => {
  process.env.SUPABASE_URL = 'https://stub.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-role';
  const calls = installFetch([
    ...supabaseRoutes(),
    ...geminiStub({ search: (body) => (hasSearch(body) ? new Response('{"error":{"message":"google_search tool is not enabled"}}', { status: 400 }) : plain('Answer.')), tools: () => assert.fail('no tools') })
  ]);
  for (let i = 0; i < 3; i++) {
    const res = await run(authed({ prompt: 'what happened in crypto today?', stream: false }));
    assert.equal(res.jsonBody.reply, 'Answer.');
  }
  const searchAsks = geminiRequests(calls).filter((g) => hasSearch(g.body));
  assert.equal(searchAsks.length, 3, 'each message asked for search');
  const rows = (await errorLogRows(calls, 3)).filter((r) => r.reason === 'search_failed');
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => typeof r.request_id === 'string' && r.request_id));
  assert.equal(new Set(rows.map((r) => r.request_id)).size, 3, 'one row per message, each under its own request ID');
});

// --- identity, secrets and neutral errors on both routes ------------------------------

test('identity and secret rules hold on both routes', async () => {
  process.env.ANTHROPIC_API_KEY = FAKE.anthropicKey;
  const leak = `I am Gemini, made by Google. The key is ${FAKE.anthropicKey}.`;
  installFetch(geminiStub({
    search: () => grounded(leak),
    tools: (body) => (hasResponses(body) ? plain(leak) : callsOf([['check_domain_age', { domain: DOMAIN.CLEAN }]]))
  }));
  for (const prompt of ['latest news on EIP-7702', `how old is ${DOMAIN.CLEAN}?`]) {
    const events = eventsOf(await run(authed({ prompt })));
    const text = textOf(events);
    assert.ok(text.includes(PG1_IDENTITY_REPLY), `${prompt}: identity line`);
    assert.ok(!/I am Gemini/.test(text), `${prompt}: no model claim`);
    assert.ok(!text.includes(FAKE.anthropicKey), `${prompt}: no secret value`);
  }
});

test('a failed reply on either route is one neutral sentence with the request ID', async () => {
  installFetch(geminiStub({
    search: () => new Response('{"error":{"message":"gemini-3.8-flash overloaded"}}', { status: 503 }),
    tools: () => new Response('{"error":{"message":"gemini-3.8-flash overloaded"}}', { status: 503 })
  }));
  for (const prompt of ['latest news on EIP-7702', `how old is ${DOMAIN.CLEAN}?`]) {
    const res = await run(authed({ prompt, stream: false }));
    assert.match(res.jsonBody.reply, /^Execution failed\. The reply could not be generated right now\. Please try again\. Request ID: \w+$/, prompt);
  }
});

// --- voice on both routes -------------------------------------------------------------

function cartesiaRoute(spoken) {
  return ['api.cartesia.ai/tts/sse', (u, o, body) => {
    spoken.push(body.transcript);
    return new Response(sseBody([{ type: 'chunk', data: Buffer.from('pcm').toString('base64') }, { type: 'done', done: true }]));
  }];
}

test('voice, search route: the searched answer is spoken, then audio_end before done; the chip is never read out', async () => {
  process.env.CARTESIA_API_KEY = FAKE.longToken;
  const spoken = [];
  installFetch([cartesiaRoute(spoken), ...geminiStub({ search: () => grounded('EIP-7702 shipped with Pectra.'), tools: () => assert.fail('no tools') })]);
  const events = eventsOf(await run(authed({ prompt: 'latest news on EIP-7702', speak: true })));
  const types = events.map((e) => e.type);
  assert.equal(types[types.length - 1], 'done');
  assert.ok(types.includes('audio'));
  assert.ok(types.indexOf('audio_end') < types.lastIndexOf('done'));
  assert.equal(events[events.length - 1].searchEntryPoint, CHIP);
  const said = spoken.join(' ');
  assert.match(said, /EIP-7702 shipped with Pectra\./);
  assert.ok(!/Search Suggestions|<style|google\.com/i.test(said), 'the chip is not spoken');
  assert.equal(events.find((e) => e.type === 'step_done' && e.id === 'voice').label, 'Spoke the reply');
});

test('voice, mixed message with no check: only the search answer is spoken, never the dropped tools round', async () => {
  process.env.CARTESIA_API_KEY = FAKE.longToken;
  const spoken = [];
  installFetch([cartesiaRoute(spoken), ...geminiStub({
    search: () => grounded('vitalik.eth was in the news this week.'),
    tools: () => plain('I cannot look up news with my checks.')
  })]);
  const events = eventsOf(await run(authed({ prompt: 'what is the latest news about vitalik.eth?', speak: true })));
  assert.equal(events[events.length - 1].type, 'done');
  const said = spoken.join(' ');
  assert.match(said, /vitalik\.eth was in the news this week\./);
  assert.ok(!/cannot look up news/.test(said), 'the held tools-round text is never spoken');
});

test('voice, tools route: the spoken summary of the check, not the reply or the domain', async () => {
  process.env.CARTESIA_API_KEY = FAKE.longToken;
  const spoken = [];
  installFetch([cartesiaRoute(spoken), ...geminiStub({
    search: () => assert.fail('no search'),
    tools: (body) => (hasResponses(body) ? plain(`${DOMAIN.FLAGGED} is flagged.`) : callsOf([['check_domain_age', { domain: DOMAIN.FLAGGED }]]))
  })]);
  const events = eventsOf(await run(authed({ prompt: `how old is ${DOMAIN.FLAGGED}?`, speak: true })));
  const done = events[events.length - 1];
  assert.equal(done.type, 'done');
  const said = spoken.join(' ');
  assert.match(said, /Domain age .*flagged/i);
  assert.match(said, /The full result is on screen\./);
  assert.equal(events.find((e) => e.type === 'step_done' && e.id === 'voice').label, 'Spoke the summary');
  assert.ok(done.spokenSummary);
});

test('voice, refused search: the answer without search is still spoken and nothing spoken names the provider', async () => {
  process.env.CARTESIA_API_KEY = FAKE.longToken;
  const spoken = [];
  installFetch([cartesiaRoute(spoken), ...geminiStub({
    search: (body) => (hasSearch(body) ? new Response('{"error":{"message":"Search Grounding is not supported for gemini-3.8-flash"}}', { status: 400 }) : plain('From what I know, EIP-7702 adds delegation.')),
    tools: () => assert.fail('no tools')
  })]);
  const events = eventsOf(await run(authed({ prompt: 'latest news on EIP-7702', speak: true })));
  assert.equal(events[events.length - 1].type, 'done');
  const said = spoken.join(' ');
  assert.match(said, /EIP-7702 adds delegation/);
  assert.ok(!/gemini|google|grounding|search/i.test(said));
  assert.ok(events.some((e) => e.type === 'audio_end'));
});
