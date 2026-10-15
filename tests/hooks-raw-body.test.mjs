/**
 * Webhook signatures over the exact raw body (api/hooks/github.mjs,
 * api/hooks/vercel.mjs, api/hooks/lab.mjs, lib/watches/signatures.mjs).
 *
 * Production refused every GitHub delivery with
 * "[hooks] rejected source=github reason=bad_signature" although the secret
 * matched: the routes were default (req, res) handlers, and Vercel's Node
 * helpers read and JSON-parse the body before such a handler runs, so the
 * bytes GitHub signed were gone. The routes are now Web handlers (POST,
 * no default export), which Vercel runs without those helpers.
 *
 * Covered: GitHub's own documented test vector verifies (secret padded with
 * whitespace and a newline, upper- or lower-case hex) and a one-digit change
 * fails; a GitHub-style signed delivery whose JSON would not survive
 * re-stringifying is accepted end to end through the route module, and a
 * tampered one is refused; the same for a Vercel-signed delivery; the routes
 * export POST and no default; a body Vercel's helpers already consumed is
 * refused as no_raw_body, never verified against an empty or rebuilt body;
 * an over-size body is 413 and a GET is 405.
 *
 * Run with: node --test tests/hooks-raw-body.test.mjs
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { PassThrough, Readable } from 'node:stream';

const { verifyGithubSignature, verifyVercelSignature, readRawBody } = await import('../lib/watches/signatures.mjs');
const { asWebHandler } = await import('../lib/watches/hooks.mjs');
const githubRoute = await import('../api/hooks/github.mjs');
const vercelRoute = await import('../api/hooks/vercel.mjs');
const labRoute = await import('../api/hooks/lab.mjs');

// Test-only HMAC keys (not credentials). GH_DOC_* is the example from
// GitHub's "Validating webhook deliveries" docs.
const GH_DOC_SECRET = "It's a Secret to Everybody";
const GH_DOC_BODY = 'Hello, World!';
const GH_DOC_SIG = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
const GH_SECRET = `gh-raw-${crypto.randomBytes(8).toString('hex')}`;
const VC_SECRET = `vc-raw-${crypto.randomBytes(8).toString('hex')}`;

// A GitHub ping delivery as sent: pretty-printed, with a non-ASCII escape
// and an escaped slash. JSON.stringify(JSON.parse(raw)) is different bytes.
const GH_PING = `{
  "zen": "Approachable is better than simple. \\u2014 caf\\u00e9",
  "hook_id": 512340001,
  "hook": {
    "type": "Repository",
    "id": 512340001,
    "active": true,
    "events": ["check_suite", "pull_request", "workflow_run"],
    "config": { "content_type": "json", "insecure_ssl": "0", "url": "https:\\/\\/pg1.example\\/api\\/hooks\\/github" }
  },
  "repository": { "full_name": "Project-Gifted1/pg1-ai-agent" }
}
`;

const ENV_KEYS = ['GITHUB_WEBHOOK_SECRET', 'VERCEL_WEBHOOK_SECRET'];
const saved = {};
let logs;
let warn;
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // As pasted into the dashboard: trailing newline and stray spaces.
  process.env.GITHUB_WEBHOOK_SECRET = `  ${GH_SECRET}\r\n`;
  process.env.VERCEL_WEBHOOK_SECRET = `${VC_SECRET}\n`;
  logs = [];
  warn = console.warn;
  console.warn = (...a) => logs.push(a.join(' '));
});
afterEach(() => {
  console.warn = warn;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const hmac = (algo, secret, body) => crypto.createHmac(algo, secret).update(body).digest('hex');

function githubDelivery(raw, { event = 'ping', secret = GH_SECRET, body = raw } = {}) {
  return new Request('https://pg1.example/api/hooks/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'GitHub-Hookshot/abc1234',
      'x-github-event': event,
      'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958',
      'x-hub-signature': `sha1=${hmac('sha1', secret, raw)}`,
      'x-hub-signature-256': `sha256=${hmac('sha256', secret, raw)}`
    },
    body
  });
}

test('GitHub\'s documented test vector verifies; the secret is trimmed and the hex compared as bytes', () => {
  const raw = Buffer.from(GH_DOC_BODY);
  const req = (sig) => ({ headers: { 'x-hub-signature-256': sig } });
  assert.deepEqual(verifyGithubSignature(req(GH_DOC_SIG), raw, { GITHUB_WEBHOOK_SECRET: GH_DOC_SECRET }), { ok: true });
  assert.deepEqual(verifyGithubSignature(req(GH_DOC_SIG), raw, { GITHUB_WEBHOOK_SECRET: `\t${GH_DOC_SECRET} \n` }), { ok: true }, 'whitespace and newline around the secret are ignored');
  assert.deepEqual(verifyGithubSignature(req(`sha256=${GH_DOC_SIG.slice(7).toUpperCase()}`), raw, { GITHUB_WEBHOOK_SECRET: GH_DOC_SECRET }), { ok: true }, 'upper-case hex');
  const flipped = GH_DOC_SIG.slice(0, -1) + (GH_DOC_SIG.endsWith('7') ? '8' : '7');
  assert.equal(verifyGithubSignature(req(flipped), raw, { GITHUB_WEBHOOK_SECRET: GH_DOC_SECRET }).reason, 'bad_signature');
  assert.equal(verifyGithubSignature(req(GH_DOC_SIG.slice(0, -2)), raw, { GITHUB_WEBHOOK_SECRET: GH_DOC_SECRET }).reason, 'malformed', 'a short signature never reaches the compare');
  assert.equal(verifyGithubSignature(req(GH_DOC_SIG), Buffer.from(`${GH_DOC_BODY}\n`), { GITHUB_WEBHOOK_SECRET: GH_DOC_SECRET }).reason, 'bad_signature', 'one extra byte fails');
  assert.equal(verifyGithubSignature(req(GH_DOC_SIG), null, { GITHUB_WEBHOOK_SECRET: GH_DOC_SECRET }).reason, 'no_raw_body');
});

test('the hook routes are Web handlers: POST, and no default (req, res) export Vercel would parse the body for', () => {
  for (const [name, mod] of [['github', githubRoute], ['vercel', vercelRoute], ['lab', labRoute]]) {
    assert.equal(typeof mod.POST, 'function', `${name} exports POST`);
    assert.equal(mod.default, undefined, `${name} has no default export`);
  }
});

test('/api/hooks/github accepts a GitHub-signed delivery over its exact bytes and refuses a tampered one', async () => {
  const raw = Buffer.from(GH_PING);
  assert.notEqual(hmac('sha256', GH_SECRET, JSON.stringify(JSON.parse(GH_PING))), hmac('sha256', GH_SECRET, raw), 'precondition: re-stringifying changes the signature');

  const ok = await githubRoute.POST(githubDelivery(raw));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, pong: true });
  assert.equal(ok.headers.get('cache-control'), 'no-store');

  const tampered = await githubRoute.POST(githubDelivery(raw, { body: GH_PING.replace('512340001', '512340002') }));
  assert.equal(tampered.status, 401);
  const wrongSecret = await githubRoute.POST(githubDelivery(raw, { secret: 'not-the-secret' }));
  assert.equal(wrongSecret.status, 401);
  assert.deepEqual(logs, ['[hooks] rejected source=github reason=bad_signature', '[hooks] rejected source=github reason=bad_signature']);
});

test('/api/hooks/vercel accepts a Vercel-signed delivery over its exact bytes and refuses a tampered one', async () => {
  const raw = `{"id":"evt_9k2Lw","type":"project.created","createdAt":1792000000000,\n "payload": {"project": {"id": "prj_abc123", "name": "caf\\u00e9"}}}`;
  const send = (body, sig) => vercelRoute.POST(new Request('https://pg1.example/api/hooks/vercel', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vercel-signature': sig },
    body
  }));
  const ok = await send(raw, hmac('sha1', VC_SECRET, Buffer.from(raw)));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, handled: 0 });
  assert.equal((await send(raw, hmac('sha1', VC_SECRET, JSON.stringify(JSON.parse(raw))))).status, 401, 'a signature over re-stringified JSON is not the one Vercel sends');
  assert.equal((await send(raw.replace('prj_abc123', 'prj_abc124'), hmac('sha1', VC_SECRET, Buffer.from(raw)))).status, 401);
  assert.deepEqual(logs, ['[hooks] rejected source=vercel reason=bad_signature', '[hooks] rejected source=vercel reason=bad_signature']);
  const req = { headers: { 'x-vercel-signature': hmac('sha1', VC_SECRET, Buffer.from(raw)) } };
  assert.deepEqual(verifyVercelSignature(req, Buffer.from(raw), { VERCEL_WEBHOOK_SECRET: ` ${VC_SECRET}\n` }), { ok: true }, 'secret trimmed');
});

// What a default (req, res) export gets on Vercel: @vercel/node's helpers
// read the stream into a Buffer, then hand the handler a req whose own
// stream is ended and whose read/'data'/'end' are redirected to a copy
// (restoreBody in @vercel/node), with req.body a lazy JSON.parse.
function vercelHelpersReq(req, body) {
  const copy = new PassThrough();
  const on = copy.on.bind(copy);
  const originalOn = req.on.bind(req);
  req.read = copy.read.bind(copy);
  req.on = req.addListener = (name, cb) => (name === 'data' || name === 'end' ? on(name, cb) : originalOn(name, cb));
  copy.end(body);
  let parsed;
  Object.defineProperty(req, 'body', { get() { return (parsed ??= JSON.parse(body.toString())); } });
}

test('a body Vercel\'s Node helpers already consumed is refused as no_raw_body, never checked against an empty or rebuilt body', async () => {
  const seen = await new Promise((resolve, reject) => {
    const srv = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        vercelHelpersReq(req, Buffer.concat(chunks));
        const raw = await readRawBody(req);
        resolve({ raw, verdict: verifyGithubSignature(req, raw) });
      } catch (e) { reject(e); }
      res.end();
      srv.close();
    });
    srv.listen(0, '127.0.0.1', () => {
      const raw = Buffer.from(GH_PING);
      const r = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'POST', path: '/', headers: { 'content-type': 'application/json', 'content-length': raw.length, 'x-hub-signature-256': `sha256=${hmac('sha256', GH_SECRET, raw)}` } });
      r.on('error', reject);
      r.end(raw);
    });
  });
  assert.equal(seen.raw, null);
  assert.deepEqual(seen.verdict, { ok: false, reason: 'no_raw_body' });

  // A stream that is still "readable" but was drained elsewhere.
  const drained = Readable.from([]);
  drained.headers = { 'content-length': '42' };
  assert.equal(await readRawBody(drained), null, 'a declared body that yields no bytes is not an empty body');
  const empty = Readable.from([]);
  empty.headers = { 'content-length': '0' };
  assert.equal((await readRawBody(empty)).length, 0, 'a really empty body stays empty');
});

test('the Web handler refuses an over-size body (413) and a GET (405)', async () => {
  const handler = asWebHandler(async (req, res) => {
    try { await readRawBody(req, { maxBytes: 8 }); } catch (e) { return res.status(413).json({ error: 'too large' }); }
    return res.status(200).json({ ok: true });
  }, { maxBytes: 8 });
  assert.equal((await handler(new Request('https://x.example/', { method: 'POST', body: '0123456789' }))).status, 413);
  assert.equal((await handler(new Request('https://x.example/', { method: 'POST', body: '0123' }))).status, 200);
  const get = await githubRoute.POST(new Request('https://pg1.example/api/hooks/github', { method: 'GET' }));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
});
