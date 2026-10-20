import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryOf } from '../lib/requestQuery.mjs';
import statusHandler from '../api/status.mjs';
import preflightHandler from '../api/preflight.mjs';
import watchlistsHandler from '../api/watchlists.mjs';

// A request whose req.query getter is the legacy url.parse() one: reading it
// fails the test, as the DEP0169 warning would show in production.
function vercelReq(url, extra = {}) {
  const req = { method: 'GET', headers: {}, url, ...extra };
  Object.defineProperty(req, 'query', { get() { throw new Error('req.query read (url.parse, DEP0169)'); } });
  return req;
}
function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: undefined };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.getHeader = (k) => r.headers[k.toLowerCase()];
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.end = (b) => { if (b !== undefined) r.body = b; return r; };
  return r;
}

test('queryOf reads req.url with the WHATWG URL parser', () => {
  assert.deepEqual(queryOf({ url: '/api/status?format=json&x=%20a' }), { format: 'json', x: ' a' });
  assert.deepEqual(queryOf({ url: '/api/watchlists?id=1&id=2' }), { id: '1' });
  assert.deepEqual(queryOf({ url: '/api/preflight' }), {});
  assert.deepEqual(queryOf({ query: { id: 'x' } }), { id: 'x' });
  assert.deepEqual(queryOf({ url: '/a', query: { id: 'x' } }), { id: 'x' });
  assert.deepEqual(queryOf({}), {});
  assert.deepEqual(queryOf(null), {});
});

test('/api/status, /api/preflight and /api/watchlists never read the url.parse() req.query', async () => {
  const s = fakeRes();
  await statusHandler(vercelReq('/api/status?format=json'), s);
  assert.equal(s.statusCode, 200);
  assert.equal(typeof s.body, 'object');

  const p = fakeRes();
  await preflightHandler(vercelReq('/api/preflight?action=nothing'), p);
  assert.ok(p.statusCode >= 200 && p.statusCode < 500, `preflight answered ${p.statusCode}`);

  const w = fakeRes();
  await watchlistsHandler(vercelReq('/api/watchlists?id=00000000-0000-4000-8000-000000000000', { headers: { authorization: 'Bearer nope' } }), w);
  assert.ok([401, 403, 404, 503].includes(w.statusCode), `watchlists answered ${w.statusCode}`);
});
