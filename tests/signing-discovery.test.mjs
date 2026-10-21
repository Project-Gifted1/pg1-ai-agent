// Finding PG1's signing key from a signed result (an outside integrator
// could not find where the public key for kid a3f2fbf9d8188a3c lives):
//
//   - every signature block carries jwks_url (MCP, A2A, REST), additively,
//     outside the signed bytes, so every earlier signature still verifies;
//   - every response that carries a signature has
//     Link: <.../.well-known/pg1-signing-key>; rel="jwks";
//   - /.well-known/jwks.json serves the same JWKS, headers included;
//   - the canonical JSON is RFC 8785 (JCS) for I-JSON (the RFC's examples);
//   - the worked example in the docs is rebuilt byte for byte;
//   - the 10-line Node and Python verifiers in the docs verify a real signed
//     fixture result fetched by kid from a JWKS URL, and reject a tampered
//     one;
//   - the agent card, openapi.json, llms.txt and /docs/agents point to the key.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';

const ORIGINAL_ENV = { ...process.env };
const SEED = crypto.randomBytes(32).toString('base64url');
const signing = await import('../lib/signing.mjs');
const { default: mcpHandler } = await import('../api/mcp.mjs');
const { default: a2aHandler } = await import('../api/a2a.mjs');
const { default: preflightHandler } = await import('../api/preflight.mjs');
const { default: signingKeyHandler } = await import('../api/signing-key.mjs');
const { FIXTURE_VALUES } = await import('../lib/fixtures.mjs');
const example = await import('../scripts/signing-example.mjs');
const { verifyPg1 } = await import('../public/docs/verify-pg1.mjs');

const JWKS_URL = 'https://pg1-ai-agent.vercel.app/.well-known/pg1-signing-key';
const LINK = `<${JWKS_URL}>; rel="jwks"`;
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, PG1_SIGNING_KEY: SEED, TELEMETRY_IP_SALT: 'signing-discovery-salt' };
  delete process.env.PG1_SIGNING_KEY_ID;
  delete process.env.PG1_SIGNING_PREVIOUS_JWKS;
});
after(() => { process.env = { ...ORIGINAL_ENV }; });

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    send(p) { this.body = p; return this; },
    end() { return this; }
  };
}
let ipN = 0;
const freshIp = () => `100.64.77.${(ipN += 1) % 250}`;
async function callMcp(name, args) {
  const res = makeRes();
  await mcpHandler({ method: 'POST', headers: { 'x-forwarded-for': freshIp() }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } }, res);
  return res;
}
async function callA2a(skill, args) {
  const res = makeRes();
  await a2aHandler({ method: 'POST', headers: { 'x-forwarded-for': freshIp() }, query: {}, body: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: 'm1', parts: [{ kind: 'data', data: { skill, arguments: args } }] } } } }, res);
  return res;
}
// A real signed fixture result over MCP: { result, signature, args }.
async function signedFixture() {
  const args = { address: FIXTURE_VALUES.wallet.FLAGGED };
  const r = await callMcp('check_wallet_sanctions', args);
  return { result: JSON.parse(r.body.result.content[0].text), signature: r.body.result._meta['pg1/signature'], args, res: r };
}

// A local JWKS server (CI blocks every host but this machine).
async function jwksServer(jwks) {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/jwk-set+json' }); res.end(JSON.stringify(jwks)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/.well-known/pg1-signing-key`, close: () => new Promise((r) => server.close(r)) };
}

// --- 1. jwks_url on every signature, outside the signed bytes ---------------------------

test('MCP: result._meta["pg1/signature"].jwks_url, the Link header, and the signature still verifies', async () => {
  const { result, signature, args, res } = await signedFixture();
  assert.equal(signature.jwks_url, JWKS_URL);
  assert.equal(res.headers.link, LINK);
  assert.deepEqual(Object.keys(signature).sort(), ['alg', 'jwks_url', 'kid', 'request_hash', 'sig', 'sources', 'timestamp', 'version']);
  assert.equal(signing.verifySignedResult({ result, signature, jwks: signing.publicJwks(), tool: 'check_wallet_sanctions', args }).valid, true);
  // Additive: a verifier that drops jwks_url (an older SDK) still verifies.
  const { jwks_url: _u, ...old } = signature;
  assert.equal(signing.verifySignedResult({ result, signature: old, jwks: signing.publicJwks() }).valid, true);
  // Not signed: changing it does not break the signature (it is pinned by the verifier, not trusted).
  assert.equal(signing.verifySignedResult({ result, signature: { ...signature, jwks_url: 'https://elsewhere.example/jwks' }, jwks: signing.publicJwks() }).valid, true);
});

test('A2A: metadata["pg1.signature"].jwks_url and the Link header', async () => {
  const args = { domain: FIXTURE_VALUES.domain.CLEAN };
  const res = await callA2a('check_domain_age', args);
  const sig = res.body.result.metadata['pg1.signature'];
  assert.equal(sig.jwks_url, JWKS_URL);
  assert.equal(res.headers.link, LINK);
  assert.match(res.headers['access-control-expose-headers'], /\bLink\b/);
  const data = res.body.result.artifacts[0].parts[0].data;
  assert.equal(signing.verifySignedResult({ result: data, signature: sig, jwks: signing.publicJwks(), tool: 'check_domain_age', args }).valid, true);
});

test('REST: the top-level signature.jwks_url and the Link header', async () => {
  const db = new Map();
  const ORIGINAL_FETCH = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/free_tier_usage')) {
      if ((opts.method || 'GET') === 'GET') return new Response(JSON.stringify(db.has('n') ? [{ request_count: db.get('n') }] : []));
      db.set('n', (db.get('n') || 0) + 1);
      return new Response('', { status: 201 });
    }
    if (u.includes('/rest/v1/')) return new Response('', { status: 201 });
    throw new Error('unexpected fetch ' + u);
  };
  try {
    process.env.SUPABASE_URL = 'https://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
    const body = { action: 'open', target: FIXTURE_VALUES.domain.FLAGGED };
    const r = makeRes();
    await preflightHandler({ method: 'POST', headers: { 'x-forwarded-for': freshIp() }, body }, r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.signature.jwks_url, JWKS_URL);
    assert.equal(r.headers.link, LINK);
    const { signature, ...rest } = r.body;
    assert.equal(signing.verifySignedResult({ result: rest, signature, jwks: signing.publicJwks(), tool: 'preflight_check', args: body }).valid, true);
    await new Promise((done) => setTimeout(done, 100));
  } finally { globalThis.fetch = ORIGINAL_FETCH; }
});

test('no signing key: nothing is signed and no Link header is sent', async () => {
  delete process.env.PG1_SIGNING_KEY;
  const r = await callMcp('check_wallet_sanctions', { address: FIXTURE_VALUES.wallet.FLAGGED });
  assert.equal((r.body.result._meta || {})['pg1/signature'], undefined);
  assert.equal(r.headers.link, undefined);
  const a = await callA2a('check_domain_age', { domain: FIXTURE_VALUES.domain.CLEAN });
  assert.equal(a.headers.link, undefined);
});

test('addJwksLink keeps a Link value already set and never repeats itself', () => {
  const r = makeRes();
  r.setHeader('Link', '<https://x.example/next>; rel="next"');
  signing.addJwksLink(r);
  signing.addJwksLink(r);
  assert.equal(r.headers.link, `<https://x.example/next>; rel="next", ${LINK}`);
});

// --- 2. /.well-known/jwks.json --------------------------------------------------------

test('/.well-known/jwks.json is the same handler as /.well-known/pg1-signing-key: same content, content type and cache', () => {
  const rewrites = JSON.parse(read('vercel.json')).rewrites;
  const dest = (src) => (rewrites.find((r) => r.source === src) || {}).destination;
  assert.equal(dest('/.well-known/jwks.json'), '/api/signing-key');
  assert.equal(dest('/.well-known/jwks.json'), dest('/.well-known/pg1-signing-key'));
  const r = makeRes();
  signingKeyHandler({ method: 'GET', headers: {} }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['content-type'], 'application/jwk-set+json');
  assert.equal(r.headers['cache-control'], 'public, max-age=300');
  assert.equal(r.headers['access-control-allow-origin'], '*');
  assert.deepEqual(r.body, signing.publicJwks());
  // No static file shadows the route.
  assert.throws(() => read('public/.well-known/jwks.json'));
});

// --- 3. the canonical JSON is RFC 8785 for I-JSON ----------------------------------------

test('canonicalJson matches RFC 8785 (JCS): the RFC\'s worked example, key sorting by UTF-16 code units, and number forms', () => {
  // RFC 8785 section 3.2.4 (input as parsed JSON).
  const input = JSON.parse('{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}');
  assert.equal(signing.canonicalJson(input), '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}');
  // RFC 8785 section 3.2.3: sorting by UTF-16 code units.
  const sorted = JSON.parse('{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}');
  // Read the order from the string: re-parsing would move the integer-like key "1" first.
  const keys = [...signing.canonicalJson(sorted).matchAll(/(?:^\{|,)("(?:[^"\\]|\\.)*"):/g)].map((m) => JSON.parse(m[1]));
  assert.deepEqual(keys.map((k) => k.codePointAt(0).toString(16)), ['d', '31', '80', 'f6', '20ac', '1f600', 'fb33']);
  // RFC 8785 appendix B (a sample of the number table).
  for (const [n, s] of [[0, '0'], [-0, '0'], [5e-324, '5e-324'], [1.7976931348623157e308, '1.7976931348623157e+308'], [9007199254740992, '9007199254740992'], [1e21, '1e+21'], [1e-7, '1e-7'], [0.000001, '0.000001'], [295147905179352830000, '295147905179352830000']]) {
    assert.equal(signing.canonicalJson(n), s, String(n));
  }
  assert.equal(signing.canonicalJson({ b: [1, { d: 1, c: 2 }], a: 'x y' }), '{"a":"x y","b":[1,{"c":2,"d":1}]}', 'nested, no whitespace');
});

test('request_hash is the lowercase hex SHA-256 of the canonical {arguments, tool}', async () => {
  const { signature, args } = await signedFixture();
  const expected = crypto.createHash('sha256').update(`{"arguments":{"address":"${args.address}"},"tool":"check_wallet_sanctions"}`, 'utf8').digest('hex');
  assert.equal(signature.request_hash, expected);
  assert.match(signature.sig, /^[A-Za-z0-9_-]{86}$/, 'base64url, no padding, 64 bytes');
});

// --- 4. the worked example and the offline verifiers --------------------------------------

test('the worked example is rebuilt byte for byte and verifies against the example key, never the production key', async () => {
  const { example: ex, jwks } = await example.buildSigningExample();
  assert.equal(read(example.EXAMPLE_FILE), JSON.stringify(ex, null, 2) + '\n', 'run node scripts/signing-example.mjs');
  assert.equal(read(example.EXAMPLE_JWKS_FILE), JSON.stringify(jwks, null, 2) + '\n', 'run node scripts/signing-example.mjs');
  assert.equal(ex.signature.kid, 'pg1-docs-example');
  assert.equal(signing.verifySignedResult({ result: ex.result, signature: ex.signature, jwks, tool: ex.request.tool, args: ex.request.arguments }).valid, true);
  assert.equal(ex.result.test_fixture, true);
  assert.equal(ex.result.status, 'flagged');
  // The README (and so /docs/agents) shows this exact signature block.
  assert.ok(read('README.md').includes(JSON.stringify(ex.signature, null, 2)), 'README signature block is the committed example');
});

test('the docs show the verifier files verbatim, each at most 10 lines', () => {
  const readme = read('README.md');
  for (const [file, lang] of [['public/docs/verify-pg1.mjs', 'js'], ['public/docs/verify_pg1.py', 'python']]) {
    const code = read(file).replace(/\n$/, '');
    assert.ok(code.split('\n').length <= 10, `${file} is ${code.split('\n').length} lines`);
    assert.ok(readme.includes('```' + lang + '\n' + code + '\n```'), `${file} is in the README as a ${lang} block`);
  }
});

test('Node verifier: fetches the JWKS, picks the key by kid, verifies a real signed fixture result, rejects tampering', async () => {
  const { result, signature } = await signedFixture();
  const srv = await jwksServer(signing.publicJwks());
  try {
    assert.equal(await verifyPg1(result, signature, srv.url), true);
    assert.equal(await verifyPg1({ ...result, status: 'no_flags' }, signature, srv.url), false, 'tampered result');
    assert.equal(await verifyPg1(result, { ...signature, kid: 'nope' }, srv.url), false, 'unknown kid');
    assert.equal(await verifyPg1({ ...result, signature }, signature, srv.url), true, 'a REST body with its own signature field');
  } finally { await srv.close(); }
  const exSrv = await jwksServer(JSON.parse(read(example.EXAMPLE_JWKS_FILE)));
  try {
    const ex = JSON.parse(read(example.EXAMPLE_FILE));
    assert.equal(await verifyPg1(ex.result, ex.signature, exSrv.url), true, 'the worked example');
  } finally { await exSrv.close(); }
});

test('Python verifier: the same, against a real signed fixture result', async (t) => {
  const probe = spawnSync('python3', ['-I', '-c', 'import cryptography'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    // CI installs python3-cryptography (.github/workflows/tests.yml), so
    // there this check must run.
    if (process.env.CI) assert.fail('python3 with the cryptography package is required in CI');
    return t.skip('python3 with the cryptography package is not installed');
  }
  const { result, signature } = await signedFixture();
  const ex = JSON.parse(read(example.EXAMPLE_FILE));
  const srv = await jwksServer(signing.publicJwks());
  const exSrv = await jwksServer(JSON.parse(read(example.EXAMPLE_JWKS_FILE)));
  try {
    const code = [
      'import json, sys',
      read('public/docs/verify_pg1.py'),
      'd = json.load(sys.stdin)',
      'print(json.dumps([verify_pg1(d["r"], d["s"], d["u"]), verify_pg1(dict(d["r"], status="no_flags"), d["s"], d["u"]), verify_pg1(d["r"], dict(d["s"], kid="nope"), d["u"]), verify_pg1(d["er"], d["es"], d["eu"])]))'
    ].join('\n');
    // The spawned process must not send 127.0.0.1 through a proxy.
    const env = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    const input = JSON.stringify({ r: result, s: signature, u: srv.url, er: ex.result, es: ex.signature, eu: exSrv.url });
    const run = await new Promise((resolve) => {
      const p = spawn('python3', ['-I', '-c', code], { env });
      let out = ''; let err = '';
      p.stdout.on('data', (c) => { out += c; });
      p.stderr.on('data', (c) => { err += c; });
      p.on('close', (status) => resolve({ status, out, err }));
      p.stdin.end(input);
    });
    assert.equal(run.status, 0, run.err);
    assert.deepEqual(JSON.parse(run.out), [true, false, false, true]);
  } finally { await srv.close(); await exSrv.close(); }
});

// --- 5. where the key is referenced -------------------------------------------------------

test('the agent card, openapi.json, llms.txt and /docs/agents point to the key URL', () => {
  const card = JSON.parse(read('public/.well-known/agent-card.json'));
  const ext = card.capabilities.extensions.find((e) => e.params && e.params.jwks_url);
  assert.ok(ext, 'a capabilities.extensions entry with params.jwks_url');
  assert.equal(ext.params.jwks_url, JWKS_URL);
  assert.equal(ext.params.jwks_alias_url, 'https://pg1-ai-agent.vercel.app/.well-known/jwks.json');
  assert.equal(ext.required, false);
  const api = JSON.parse(read('public/openapi.json'));
  assert.equal(api['x-pg1-signing'].jwks_url, JWKS_URL);
  const llms = read('public/llms.txt');
  for (const s of [JWKS_URL, '/.well-known/jwks.json', 'rel="jwks"', 'jwks_url', 'a3f2fbf9d8188a3c', 'RFC 8785', 'request_hash: lowercase hex SHA-256', 'verify-pg1.mjs', 'verify_pg1.py']) assert.ok(llms.includes(s), `llms.txt: ${s}`);
  const page = read('public/docs/agents/index.html');
  for (const s of ['/.well-known/jwks.json', 'rel=&quot;jwks&quot;', 'pg1-docs-example', 'RFC 8785', 'verifyPg1', 'verify_pg1']) assert.ok(page.includes(s), `/docs/agents: ${s}`);
  // The new text never says "safe".
  const readme = read('README.md');
  const section = readme.slice(readme.indexOf('### Verify a result'), readme.indexOf('Watchlist webhooks are signed separately'));
  const llmsSection = llms.slice(llms.indexOf('## Signed results'), llms.indexOf('## Watchlists'));
  for (const text of [section, llmsSection]) assert.doesNotMatch(text, /\bsafe\b/i);
});
