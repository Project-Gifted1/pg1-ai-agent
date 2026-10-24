/**
 * OpenRouter and both Replicate keys are used (24 Oct): OpenRouter was never
 * planned while PG1_DAILY_SPEND_CAP_USD blocked paid calls, not even its
 * free (:free) models; only the first Replicate key was ever tried.
 *
 * - With paid calls blocked, OpenRouter is still planned for operator
 *   content with its free models only ($0, never counted toward a cap);
 *   never for customer data.
 * - With the cap above $0 its paid models are planned too.
 * - Replicate: a job the first key cannot start (402, 401) is tried once
 *   with the second key (REPLICATE_KEY), and polled with that key.
 * - /keys shows both Replicate keys and says whether paid calls may run.
 *
 * Run with: node --test tests/paid-keys-use.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { planRoute, TASKS, DATA, estimateCost, __resetRouterState } from '../lib/aiRouter.mjs';
import { replicateRun } from '../lib/film/providers.mjs';
import { keysStatus, __resetKeysCache } from '../lib/keysStatus.mjs';

beforeEach(() => { if (typeof __resetRouterState === 'function') __resetRouterState(); __resetKeysCache(); });

const ENV = { OPENROUTER_API_KEY: 'or-key', GEMINI_API_KEY_FREE: 'free-key' };

test('paid calls blocked: OpenRouter is planned with its free models only, for operator content only', () => {
  const plan = planRoute(TASKS.LIGHT, { env: { ...ENV }, dataClass: DATA.OPERATOR });
  const or = plan.find((c) => c.provider === 'openrouter');
  assert.ok(or, 'OpenRouter is in the plan');
  assert.equal(or.freeOnly, true);
  assert.deepEqual(or.models, [], 'no paid model');
  assert.ok(or.freeModels.length && or.freeModels.every((m) => /:free$/.test(m) && !/deepseek/i.test(m)));
  assert.equal(planRoute(TASKS.LIGHT, { env: { ...ENV }, dataClass: DATA.CUSTOMER }).some((c) => c.provider === 'openrouter'), false, 'never customer data');
  assert.equal(estimateCost({ provider: 'openrouter', model: 'qwen/qwen3-235b-a22b:free', inputTokens: 5000, outputTokens: 2000 }), 0);
});

test('with the daily cap above $0, OpenRouter plans its paid models too', () => {
  const plan = planRoute(TASKS.LIGHT, { env: { ...ENV, PG1_DAILY_SPEND_CAP_USD: '3' }, dataClass: DATA.OPERATOR });
  const or = plan.find((c) => c.provider === 'openrouter');
  assert.ok(or && or.models.length > 0, 'paid models planned');
  assert.equal(or.freeOnly, undefined);
});

test('Replicate: a job the first key cannot start (out of credit) runs on the second key, polled with that key', async () => {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    const auth = (opts.headers && opts.headers.Authorization) || '';
    seen.push([String(url).replace('https://api.replicate.com/v1', ''), auth]);
    const json = (status, b) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
    if (String(url).endsWith('/predictions') && auth === 'Bearer key-one') return json(402, { detail: 'You have insufficient credit to run this model.' });
    if (String(url).endsWith('/predictions')) return json(201, { id: 'p1', status: 'starting' });
    return json(200, { id: 'p1', status: 'succeeded', output: ['https://replicate.delivery/out.png'] });
  };
  const out = await replicateRun({ env: { REPLICATE_API_TOKEN: 'key-one', REPLICATE_KEY: 'key-two', PG1_DAILY_SPEND_CAP_USD: '5' }, model: 'black-forest-labs/flux-schnell', input: { prompt: 'x' }, fetchImpl, sleep: async () => {}, pollMs: 1 });
  assert.equal(out.url, 'https://replicate.delivery/out.png');
  assert.deepEqual(seen.map((s) => s[1]), ['Bearer key-one', 'Bearer key-two', 'Bearer key-two']);
});

test('/keys shows both Replicate keys and whether paid calls may run', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('replicate.com/v1/account')) return new Response(JSON.stringify({ username: 'pg1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 401 });
  };
  const rows = await keysStatus({ env: { REPLICATE_API_TOKEN: 'key-one', REPLICATE_KEY: 'key-two' }, fetchImpl, fresh: true });
  const r1 = rows.find((r) => r.engine === 'replicate'); const r2 = rows.find((r) => r.engine === 'replicate_2');
  assert.equal(r1.state, 'working'); assert.equal(r2.state, 'working');
  assert.match(r2.note, /paid calls blocked: PG1_DAILY_SPEND_CAP_USD is \$0/);
  const capped = await keysStatus({ env: { REPLICATE_API_TOKEN: 'key-one', PG1_DAILY_SPEND_CAP_USD: '4' }, fetchImpl, fresh: true });
  assert.match(capped.find((r) => r.engine === 'replicate').note, /paid calls allowed up to \$4\.00 a day/);
  assert.equal(capped.find((r) => r.engine === 'replicate_2').set, false, 'one key: the second row says missing');
});
