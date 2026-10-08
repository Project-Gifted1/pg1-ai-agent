/**
 * docs/integrations/crypto-alert-bot.md must only name things that exist.
 *
 * Every endpoint, tool/skill name, response field, status value, error
 * code, reason code, chain value and rate limit the guide mentions is
 * checked against this repo's code - mostly against real responses from
 * the A2A and playground handlers (fixture inputs, so nothing leaves the
 * process). The guide's request JSON is sent to the real A2A handler, its
 * example responses must have exactly the keys a real response has, and its
 * complete bot module is run against the real handler with a stub axios.
 *
 * Every check runs twice: on the Markdown, and on the published page
 * (public/docs/crypto-alert-bot/index.html, served at
 * /docs/crypto-alert-bot) read back as text, so the page can't name
 * anything the code doesn't have either.
 *
 * Run with: node --test tests/crypto-alert-bot-guide.test.mjs
 */

import { test as nodeTest, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// No upstream, no database: wallet age fails fast with upstream_unavailable
// and sanctions with an error, so nothing here makes a network call.
for (const k of ['ALCHEMY_API_KEY', 'SUPABASE_URL', 'SUPABASEAPI_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLEKEY']) delete process.env[k];

const { default: a2aHandler, A2A_SKILL_TOOLS } = await import('../api/a2a.mjs');
const { createPlaygroundHandler } = await import('../api/playground.mjs');
const { createPlaygroundLimiter, PLAYGROUND_TOOLS, PLAYGROUND_DAILY_CAP, PLAYGROUND_TOOL_LIMITS, NOTES, PROVIDER_NAME_RE } = await import('../lib/playground.mjs');
const { REASON_CODES, INFORMATIONAL_REASON_CODES, INCOMPLETE_REASON_CODES } = await import('../lib/reasonCodes.mjs');
const { FIXTURE_VALUES } = await import('../lib/fixtures.mjs');
const { WALLET_AGE_RATE_LIMIT_MAX, WALLET_SANCTIONS_RATE_LIMIT_MAX } = await import('../lib/x402Config.mjs');
const { pageAsMarkdown } = await import('./helpers/doc-page.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const GUIDE = read('docs/integrations/crypto-alert-bot.md');
const BASE_URL = 'https://pg1-ai-agent.vercel.app';
const SRC = {
  a2a: read('api/a2a.mjs'),
  mcp: read('api/mcp.mjs'),
  playground: read('api/playground.mjs') + read('lib/playground.mjs')
};
const ALL_SRC = Object.values(SRC).join('\n');

const W = FIXTURE_VALUES.wallet;
const GUIDE_TOOLS = ['check_wallet_sanctions', 'check_wallet_age'];
const ENV_VARS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
// Telegram's own Bot API field, used in the guide's sendMessage call - not
// a PG1 name.
const TELEGRAM_FIELDS = ['chat_id'];

const blocksOf = (text) => (lang) => {
  const re = new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g');
  return [...text.matchAll(re)].map((m) => m[1]);
};

// The Markdown, and the published page read back as text.
const PAGE_TEXT = pageAsMarkdown(read('public/docs/crypto-alert-bot/index.html'));
const DOCS = [
  { name: 'markdown', text: GUIDE, ip: '198.51.100.203' },
  { name: 'page', text: PAGE_TEXT, ip: '198.51.100.204' }
];

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; }
  };
}

async function a2a(body, ip = '198.51.100.200') {
  const res = makeRes();
  await a2aHandler({ method: 'POST', headers: { 'x-forwarded-for': ip }, query: {}, body }, res);
  return res;
}

function sendBody(skill, args) {
  return {
    jsonrpc: '2.0', id: 1, method: 'message/send',
    params: { message: { role: 'user', messageId: crypto.randomUUID(), parts: [{ kind: 'data', data: { skill, arguments: args } }] } }
  };
}

const resultData = (res) => res.body.result.artifacts[0].parts[0].data;

// Every key and every string value seen in a real response.
const KNOWN = new Set();
const KNOWN_HEADERS = new Set();
function collect(value) {
  if (Array.isArray(value)) return value.forEach(collect);
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { KNOWN.add(k); collect(v); }
    return;
  }
  if (typeof value === 'string') KNOWN.add(value);
}
function collectRes(res) {
  collect(res.body);
  for (const h of Object.keys(res.headers)) KNOWN_HEADERS.add(h.toLowerCase());
}

const REAL = {};

before(async () => {
  for (const skill of GUIDE_TOOLS) {
    for (const [kind, address] of Object.entries(W)) {
      for (const chain of [undefined, 'ethereum']) {
        const args = chain ? { address, chain } : { address };
        const res = await a2a(sendBody(skill, args));
        collectRes(res);
        REAL[`${skill}:${kind}`] = res;
      }
    }
  }
  collectRes(await a2a(sendBody('check_wallet_age', { address: W.CLEAN, chain: 'solana' })));
  collectRes(await a2a(sendBody('check_wallet_age', { address: 'not-an-address' })));
  collectRes(await a2a({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { parts: [] } } }));

  // A real A2A rate_limited error: one more call than the limit from one IP.
  const ip = '198.51.100.201';
  let last;
  for (let i = 0; i <= WALLET_AGE_RATE_LIMIT_MAX; i++) last = await a2a(sendBody('check_wallet_age', { address: '0x' + 'ab'.repeat(20) }), ip);
  collectRes(last);
  REAL.rateLimited = last;
  // The same for check_wallet_sanctions, which has its own /api/a2a limit.
  const sanctionsIp = '198.51.100.205';
  for (let i = 0; i <= WALLET_SANCTIONS_RATE_LIMIT_MAX; i++) last = await a2a(sendBody('check_wallet_sanctions', { address: '0x' + 'ab'.repeat(20) }), sanctionsIp);
  collectRes(last);
  REAL.sanctionsRateLimited = last;

  // Real playground responses, including a 429.
  const pg = createPlaygroundHandler({ record: () => {}, executorOptions: { log: () => {} } });
  for (const tool of GUIDE_TOOLS) {
    for (const address of Object.values(W)) {
      const res = makeRes();
      await pg({ method: 'POST', headers: { 'x-forwarded-for': '198.51.100.202' }, socket: {}, body: { tool, input: address } }, res);
      collectRes(res);
    }
  }
  const limited = createPlaygroundHandler({ limiter: createPlaygroundLimiter({ limits: { check_wallet_age: 0 } }), record: () => {} });
  const res429 = makeRes();
  await limited({ method: 'POST', headers: {}, socket: {}, body: { tool: 'check_wallet_age', input: W.CLEAN } }, res429);
  collectRes(res429);
  REAL.playground429 = res429;
  for (const body of [{ tool: 'check_wallet_age', input: 'x' }, { tool: 'get_threat_indicators', input: 'x' }]) {
    const res = makeRes();
    await pg({ method: 'POST', headers: {}, socket: {}, body }, res);
    collectRes(res);
  }

  for (const tool of A2A_SKILL_TOOLS.filter((t) => GUIDE_TOOLS.includes(t.name))) {
    Object.keys(tool.inputSchema.properties).forEach((k) => KNOWN.add(k));
    Object.keys(tool.outputSchema.properties).forEach((k) => KNOWN.add(k));
    if (tool.inputSchema.properties.chain) tool.inputSchema.properties.chain.enum.filter(Boolean).forEach((c) => KNOWN.add(c));
  }
  // The playground's request keys, exactly as its validator allows them.
  // (ecosystem and version since 1.17.0, for check_package.)
  assert.match(SRC.playground, /\['tool', 'input', 'chain', 'ecosystem', 'version'\]\.includes\(k\)/);
  ['tool', 'input', 'chain', 'ecosystem', 'version'].forEach((k) => KNOWN.add(k));
});

nodeTest('real responses used as the reference look as expected', () => {
  assert.equal(REAL.rateLimited.body.error.data.code, 'rate_limited');
  assert.equal(REAL.sanctionsRateLimited.body.error.data.code, 'rate_limited');
  assert.equal(REAL.playground429.statusCode, 429);
  assert.ok(REAL.playground429.headers['Retry-After']);
  assert.equal(resultData(REAL['check_wallet_sanctions:CLEAN']).status, 'no_flags');
});

nodeTest('the page read back as text has the same code blocks as the Markdown', () => {
  for (const lang of ['json', 'js']) assert.deepEqual(blocksOf(PAGE_TEXT)(lang), blocksOf(GUIDE)(lang));
  assert.ok(blocksOf(PAGE_TEXT)('js').some((b) => b.includes('async function onSignal')));
});

for (const doc of DOCS) {
  const GUIDE = doc.text;
  const codeBlocks = blocksOf(doc.text);
  const test = (name, fn) => nodeTest(`${name} [${doc.name}]`, fn);

  test('the only tool names in the guide are A2A skills and playground tools', () => {
    const skills = A2A_SKILL_TOOLS.map((t) => t.name);
    const named = new Set(GUIDE.match(/\b(?:check|get)_[a-z_]+\b/g));
    for (const name of named) {
      assert.ok(skills.includes(name), `${name} is not an A2A skill`);
      assert.ok(PLAYGROUND_TOOLS.includes(name), `${name} is not a playground tool`);
    }
    for (const name of GUIDE_TOOLS) assert.ok(named.has(name), `guide should cover ${name}`);
  });

  test('every endpoint in the guide exists, under the documented base URL', () => {
    const urls = GUIDE.match(/https:\/\/pg1-ai-agent[^\s`)'"]*/g) || [];
    assert.ok(urls.length > 0);
    for (const u of urls) assert.ok(u.startsWith(BASE_URL), `${u} is not under ${BASE_URL}`);

    const paths = new Set(GUIDE.match(/\/api\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*/g));
    assert.deepEqual([...paths].sort(), ['/api/a2a', '/api/playground']);
    for (const p of paths) {
      const base = path.join(ROOT, p.slice(1));
      assert.ok(fs.existsSync(base + '.mjs') || fs.existsSync(base + '.js'), `${p} has no handler`);
    }
    if (GUIDE.includes('.well-known/agent-card.json')) {
      const card = JSON.parse(read('public/.well-known/agent-card.json'));
      assert.equal(card.url, `${BASE_URL}/api/a2a`);
    }
  });

  test('every snake_case name in the guide is a real field, status or code', () => {
    const tools = new Set(GUIDE_TOOLS);
    const names = new Set(GUIDE.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g));
    const missing = [...names].filter((n) => !tools.has(n) && !TELEGRAM_FIELDS.includes(n) && !KNOWN.has(n));
    assert.deepEqual(missing, [], `not found in any real response: ${missing.join(', ')}`);
  });

  test('every JSON key in the guide is a real request or response key', () => {
    const requestKeys = ['jsonrpc', 'id', 'method', 'params'];
    for (const k of requestKeys) assert.match(SRC.a2a, new RegExp(`\\b${k}\\b`));
    const missing = [];
    for (const block of codeBlocks('json')) {
      for (const [, key] of block.matchAll(/"([^"]+)"\s*:/g)) {
        if (!KNOWN.has(key) && !requestKeys.includes(key)) missing.push(key);
      }
    }
    assert.deepEqual(missing, []);
  });

  test('backticked words in the guide are real names, headers or plain words', () => {
    const plainWords = new Set(['axios', 'true', 'false', 'null', 'eth']);
    const missing = [];
    for (const [, word] of GUIDE.matchAll(/`([A-Za-z][\w-]*)`/g)) {
      if (KNOWN.has(word) || plainWords.has(word) || ENV_VARS.includes(word) || word in REASON_CODES) continue;
      if (/-/.test(word)) {
        // A header name: must be one the code sets or reads.
        if (KNOWN_HEADERS.has(word.toLowerCase()) || ALL_SRC.toLowerCase().includes(word.toLowerCase())) continue;
      }
      if (SRC.a2a.includes(`'${word}'`)) continue; // e.g. SendMessage
      missing.push(word);
    }
    assert.deepEqual([...new Set(missing)], []);
  });

  test('upper-case codes are real reason codes, A2A literals or the two env vars', () => {
    const tokens = new Set(GUIDE.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g));
    for (const t of tokens) {
      if (/^(?:WALLET|DOMAIN|HOSTNAME|CVE|IOC)_/.test(t)) assert.ok(t in REASON_CODES, `${t} is not a reason code`);
      else assert.ok(ENV_VARS.includes(t) || SRC.a2a.includes(`'${t}'`), `${t} is unknown`);
    }
    for (const v of ENV_VARS) assert.ok(tokens.has(v), `guide should name ${v}`);
    // Reason-code effects described in the guide match lib/reasonCodes.mjs.
    assert.ok(INCOMPLETE_REASON_CODES.includes('WALLET_AGE_PARTIAL'));
    assert.ok(INFORMATIONAL_REASON_CODES.includes('WALLET_DELEGATED'));
    assert.equal(resultData(REAL['check_wallet_age:FLAGGED']).reasons[0].code, 'WALLET_NO_HISTORY');
    assert.equal(resultData(REAL['check_wallet_age:FLAGGED']).status, 'flagged');
  });

  test('the chain values in the guide are exactly the tool\'s enum', () => {
    const tool = A2A_SKILL_TOOLS.find((t) => t.name === 'check_wallet_age');
    const schema = tool.inputSchema.properties.chain;
    const chains = schema.enum.filter((c) => typeof c === 'string');
    assert.equal(schema.default, 'base');
    const line = GUIDE.split('\n').find((l) => l.startsWith('**Allowed `chain` values:**'));
    assert.ok(line, 'guide should list the allowed chain values');
    assert.deepEqual([...line.matchAll(/`([a-z]+)`/g)].map((m) => m[1]).filter((c) => c !== 'chain'), chains);
    const inCode = GUIDE.match(/const supportedChains = \[([^\]]+)\]/);
    assert.ok(inCode);
    assert.deepEqual(inCode[1].split(',').map((s) => s.trim().replace(/'/g, '')), chains);
  });

  test('limits, error codes and messages quoted in the guide match the code', () => {
    assert.equal(WALLET_AGE_RATE_LIMIT_MAX, 60);
    assert.ok(GUIDE.includes(`${WALLET_AGE_RATE_LIMIT_MAX} calls/hour per caller`));
    assert.equal(PLAYGROUND_TOOL_LIMITS.check_wallet_age, 60);
    assert.equal(PLAYGROUND_TOOL_LIMITS.check_wallet_sanctions, 60);
    assert.ok(GUIDE.includes(`${PLAYGROUND_DAILY_CAP} calls/day`));
    // check_wallet_sanctions is limited per IP at the endpoints (/api/a2a and
    // /api/mcp tools/call), not in the shared handler, and the guide states
    // the real limit. Quoted limit messages give the retry time only.
    assert.equal(WALLET_SANCTIONS_RATE_LIMIT_MAX, 120);
    assert.match(SRC.a2a, /enforceWalletSanctionsRateLimit\(identifier, licenseKey\)/);
    assert.match(GUIDE, new RegExp(`\\| \`/api/a2a\`\\s*\\| \`check_wallet_sanctions\`\\s*\\| \\*\\*${WALLET_SANCTIONS_RATE_LIMIT_MAX} calls/hour per caller\\*\\* \\(per IP, fixed one-hour window\\)\\.`));
    assert.doesNotMatch(GUIDE, /no per-caller limit|unlimited|no (rate )?limit/i);
    const sanctionsLimitMessage = REAL.sanctionsRateLimited.body.error.message;
    assert.match(sanctionsLimitMessage, /Retry in about \d+ minute/);
    assert.ok(GUIDE.includes(sanctionsLimitMessage.split(' Retry in about')[0]), 'guide should quote the real sanctions limit message');
    for (const message of [REAL.rateLimited.body.error.message, sanctionsLimitMessage]) assert.doesNotMatch(message, /licen[cs]e|gumroad|bypass/i);
    assert.ok(GUIDE.includes('Retry in about N minute(s)."`'));
    assert.doesNotMatch(GUIDE, /minute\(s\), …/);
    assert.doesNotMatch(SRC.mcp.slice(SRC.mcp.indexOf('export async function handleCheckWalletSanctions'), SRC.mcp.indexOf('// check_domain_age — free')), /RateLimit/);
    // The 10-minute found:false cache.
    assert.match(SRC.mcp, /WALLET_AGE_NOT_FOUND_CACHE_TTL_MS = 10 \* 60 \* 1000/);

    for (const code of new Set(GUIDE.match(/-320\d\d/g))) assert.ok(SRC.a2a.includes(code.slice(1)) || /SERVICE_UNAVAILABLE_CODE = -32010/.test(SRC.a2a), `${code} not used by /api/a2a`);
    assert.equal(REAL['check_wallet_sanctions:UNKNOWN'].statusCode, 503);
    assert.equal(REAL['check_wallet_sanctions:UNKNOWN'].body.error.code, -32010);
    assert.equal(REAL['check_wallet_age:UNKNOWN'].body.error.code, -32000);

    const timeoutMessage = REAL['check_wallet_age:UNKNOWN'].body.error.message;
    assert.ok(GUIDE.includes(timeoutMessage), 'guide should quote the real timeout message');
    const limitMessage = REAL.rateLimited.body.error.message;
    assert.match(limitMessage, /Retry in about \d+ minute/);
    assert.ok(GUIDE.includes(limitMessage.split(' Retry in about')[0]));
    assert.ok(GUIDE.includes('/Retry in about (\\d+) minute/'));

    assert.ok(GUIDE.includes(NOTES.no_flags), 'guide should carry the no_flags caveat word for word');
    assert.ok(NOTES.unknown.includes('unverified, not as safe') && GUIDE.includes('unverified, not as safe'));
    assert.ok(GUIDE.includes(resultData(REAL['check_wallet_sanctions:CLEAN']).disclaimer));
    assert.match(SRC.mcp, /check_wallet_age has no age threshold anywhere in this file/);
  });

  test('the guide names no data provider or vendor', () => {
    const text = GUIDE.split(BASE_URL).join('');
    const hit = text.match(PROVIDER_NAME_RE);
    assert.equal(hit, null, `vendor name in guide: ${hit && hit[0]}`);
    assert.doesNotMatch(text, /\b(?:sdn list|us treasury|alchemy|gumroad|supabase)\b/i);
  });

  test('the guide\'s request JSON works against the real A2A handler', async () => {
    const request = JSON.parse(codeBlocks('json').find((b) => b.includes('"method": "message/send"')));
    const res = await a2a(request);
    assert.equal(res.statusCode, 200);
    const data = resultData(res);
    assert.equal(data.status, 'no_flags');
    assert.equal(data.chain, request.params.message.parts[0].data.arguments.chain);
  });

  test('the guide\'s example responses have exactly the keys a real response has', () => {
    const blocks = codeBlocks('json');
    const keysOf = (o) => Object.keys(o).filter((k) => k !== 'test_fixture').sort();
    const topKeys = (block) => JSON.parse(block.replace(/"…"/g, '""'));

    const sanctions = topKeys(blocks.find((b) => b.includes('"address_normalized"')));
    assert.deepEqual(Object.keys(sanctions).sort(), keysOf(resultData(REAL['check_wallet_sanctions:CLEAN'])));
    const age = topKeys(blocks.find((b) => b.includes('"first_seen_block"')));
    assert.deepEqual(Object.keys(age).sort(), keysOf(resultData(REAL['check_wallet_age:CLEAN'])));
    const err = topKeys(blocks.find((b) => b.includes('"upstream_unavailable"')));
    assert.deepEqual(Object.keys(err.error.data).sort(), keysOf(REAL['check_wallet_age:UNKNOWN'].body.error.data));
  });

  test('the guide\'s bot module drops, allows and labels as documented', async () => {
    const code = codeBlocks('js').find((b) => b.includes('async function onSignal'));
    assert.ok(code, 'guide should contain the complete bot module');

    const telegram = [];
    const ip = doc.ip;
    const toA2a = async (url, body) => {
      assert.equal(url, '/api/a2a');
      const res = await a2a(body, ip);
      return { status: res.statusCode, data: res.body, headers: res.headers };
    };
    const axiosStub = {
      create: (opts) => {
        assert.equal(opts.baseURL, BASE_URL);
        return { post: toA2a };
      },
      post: async (url, body) => {
        assert.match(url, /^https:\/\/api\.telegram\.org\/botTEST-TOKEN\/sendMessage$/);
        assert.equal(body.chat_id, 'TEST-CHAT');
        telegram.push(body.text);
        return { status: 200, data: { ok: true } };
      }
    };
    const mod = { exports: {} };
    const fakeRequire = (name) => (name === 'axios' ? axiosStub : name === 'node:crypto' ? crypto : assert.fail(`unexpected require ${name}`));
    const fakeProcess = { env: { TELEGRAM_BOT_TOKEN: 'TEST-TOKEN', TELEGRAM_CHAT_ID: 'TEST-CHAT' } };
    const logs = [];
    const fakeConsole = { log: (m) => logs.push(m) };
    new Function('require', 'module', 'exports', 'process', 'console', code)(fakeRequire, mod, mod.exports, fakeProcess, fakeConsole);
    const { onSignal, screenWallet } = mod.exports;

    // FLAGGED: dropped, nothing posted.
    await onSignal({ address: W.FLAGGED, chain: 'base', summary: 'signal 1' });
    assert.equal(telegram.length, 0);
    assert.match(logs.at(-1), /dropped .*WALLET_SANCTIONED/);

    // CLEAN: posted with the caveat.
    await onSignal({ address: W.CLEAN, chain: 'ethereum', summary: 'signal 2' });
    assert.equal(telegram.length, 1);
    assert.ok(telegram[0].includes(NOTES.no_flags));
    assert.doesNotMatch(telegram[0], /NEW: under 7 days/);

    // UNKNOWN: posted only with the NOT VERIFIED label, never the caveat.
    await onSignal({ address: W.UNKNOWN, chain: 'base', summary: 'signal 3' });
    assert.equal(telegram.length, 2);
    assert.match(telegram[1], /NOT VERIFIED/);
    assert.match(telegram[1], /upstream_unavailable \(request_id [0-9a-f-]{36}\)/);
    assert.ok(!telegram[1].includes(NOTES.no_flags));

    // Unsupported chain: wallet age not run, so not verified.
    const v = await screenWallet(W.CLEAN, 'solana');
    assert.equal(v.action, 'unverified');
    assert.equal(v.sanctions.status, 'no_flags');

    // Rate limit: after the 60/hour budget the bot backs off and reports
    // not verified, never a pass.
    let verdict;
    for (let i = 0; i <= WALLET_AGE_RATE_LIMIT_MAX + 1; i++) {
      verdict = await screenWallet('0x' + i.toString(16).padStart(40, '0'), 'base');
      assert.notEqual(verdict.action, 'allow');
    }
    assert.equal(verdict.age.why, 'rate limited (backing off)');
  });
}
