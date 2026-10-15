/**
 * The fallback router's rules on the routes outside PG1 Studio
 * (docs/director-mode.md A1, A2):
 *
 *  - research (lib/lab/runner.mjs): Gemini with Google Search, then Claude
 *    with its web search tool on a capacity failure; a refusal or a bad
 *    request stops;
 *  - /image (lib/imageEngines.mjs): a content-safety refusal stops, the
 *    next engine is never asked; an outage still falls through;
 *  - capacity alerts without push keys are only logged (no database call).
 *
 * Run with: node --test tests/router-wiring.test.mjs
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { labModelCall, LAB_WEB_SEARCH_TOOL } from '../lib/lab/runner.mjs';
import { createBudgetMeter } from '../lib/lab/policy.mjs';
import { generateImage } from '../lib/imageEngines.mjs';
import { createCapacityAlerts, __resetAlerts } from '../lib/router/alerts.mjs';
import { ROUTING_CHAINS } from '../lib/capabilities/registry.mjs';
import { routedFetch, json } from './helpers/filmDb.mjs';

const LAB = { PG1_LAB_GEMINI_API_KEY: 'lab-gemini', PG1_LAB_ANTHROPIC_API_KEY: 'lab-anthropic' };
const meter = () => createBudgetMeter({ budgetUsd: 5 });
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models/';
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const claudeAnswer = () => json({
  model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 },
  content: [
    { type: 'server_tool_use', id: 'st1', name: 'web_search', input: { query: 'q' } },
    { type: 'web_search_tool_result', tool_use_id: 'st1', content: [{ type: 'web_search_result', url: 'https://example.org/a', title: 'A' }] },
    { type: 'text', text: 'Found it.', citations: [{ type: 'web_search_result_location', url: 'https://example.org/b', title: 'B', cited_text: 'x' }] }
  ]
});

beforeEach(() => __resetAlerts());

describe('research: ROUTING_CHAINS.research', () => {
  test('the chain is Gemini, then Claude', () => {
    assert.deepEqual(ROUTING_CHAINS.research.map((s) => s.provider), ['gemini_paid', 'anthropic']);
  });

  test('Gemini out of quota: Claude researches with the web search tool; sources from the results and the citations', async () => {
    const f = routedFetch([
      [GEMINI, () => json({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).' } }, 429)],
      [ANTHROPIC, claudeAnswer]
    ]);
    const out = await labModelCall({ env: LAB, fetchImpl: f, meter: meter(), system: 's', prompt: 'p', search: true });
    assert.equal(out.text, 'Found it.');
    assert.deepEqual(out.sources, [{ url: 'https://example.org/a', title: 'A' }, { url: 'https://example.org/b', title: 'B' }]);
    const sent = f.calls.find((c) => c.url === ANTHROPIC);
    assert.deepEqual(sent.body.tools, [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }]);
    assert.deepEqual(LAB_WEB_SEARCH_TOOL, sent.body.tools[0]);
    assert.equal(sent.body.fallbacks, 'default');
    assert.equal(sent.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  });

  test('a Gemini refusal or a bad request stops: Claude is never asked', async () => {
    for (const answer of [
      () => json({ error: { code: 400, message: 'Request blocked by safety filter: PROHIBITED_CONTENT' } }, 400),
      () => json({ error: { code: 400, message: 'Invalid JSON payload received.' } }, 400)
    ]) {
      const f = routedFetch([[GEMINI, answer], [ANTHROPIC, claudeAnswer]]);
      await assert.rejects(labModelCall({ env: LAB, fetchImpl: f, meter: meter(), system: 's', prompt: 'p', search: true }));
      assert.ok(!f.calls.some((c) => c.url === ANTHROPIC));
    }
  });

  test('no Gemini key: Claude researches', async () => {
    const f = routedFetch([[ANTHROPIC, claudeAnswer]]);
    const out = await labModelCall({ env: { PG1_LAB_ANTHROPIC_API_KEY: 'k' }, fetchImpl: f, meter: meter(), system: 's', prompt: 'p', search: true });
    assert.equal(out.text, 'Found it.');
  });
});

describe('/image: ROUTING_CHAINS.image', () => {
  const blocked = () => json({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } });
  test('a refusal stops: the secondary and tertiary engines are never asked', async () => {
    const f = routedFetch([[GEMINI, blocked], ['https://api.replicate.com/', () => json({ id: 'x', status: 'succeeded', output: 'https://replicate.delivery/a.png' }, 201)]]);
    const out = await generateImage({ prompt: 'x', geminiKeys: ['k1'], tertiaryToken: 'r8', fetchImpl: f, budgetMs: 10000 });
    assert.equal(out.ok, false);
    assert.equal(out.refused, true);
    assert.equal(f.calls.filter((c) => c.url.startsWith(GEMINI)).length, 1);
    assert.ok(!f.calls.some((c) => c.url.includes('replicate')));
  });

  test('an outage still falls through to the next engine', async () => {
    const f = routedFetch([[GEMINI, () => new Response('down', { status: 503 })], ['https://api.replicate.com/', () => json({ id: 'x', status: 'succeeded', output: 'https://replicate.delivery/a.png' }, 201)]]);
    const out = await generateImage({ prompt: 'x', geminiKeys: ['k1'], tertiaryToken: 'r8', fetchImpl: f, budgetMs: 10000 });
    assert.equal(out.ok, true);
    assert.equal(out.slot, 'tertiary');
  });
});

test('capacity alerts without push keys: logged once per hour, the database never asked', async () => {
  const logs = [];
  const f = routedFetch([]);
  const alert = createCapacityAlerts({ env: {}, store: { subscriptions: async () => [] }, supUrl: 'https://supabase.test', supKey: 'k', fetchImpl: f, log: (l) => logs.push(l) });
  await alert({ engine: 'replicate', kind: 'billing' });
  await alert({ engine: 'replicate', kind: 'billing' });
  assert.equal(logs.length, 1);
  assert.equal(f.calls.length, 0);
});
