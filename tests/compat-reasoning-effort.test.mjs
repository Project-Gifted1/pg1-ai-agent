// The backup cores (AI gateway, OpenRouter, OpenAI) run gpt-5-mini, a
// reasoning model. At the provider's default effort a ~10k-token chat
// prompt can think past the 20 s per-call cap and return nothing (request
// h47kxyr6, 16 Oct 2026: all three backups timed out with 0 output tokens
// after the main core was out of quota). Chat replies ask for low effort.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callOpenAiCompat, compatReasoningFields } from '../lib/aiRouter.mjs';

const ok = (text = 'hello') => new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { status: 200 });

test('gpt-5 backups ask for low reasoning effort, in each provider\'s own field', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return ok(); };
  for (const [provider, model] of [['gateway', 'openai/gpt-5-mini'], ['openrouter', 'openai/gpt-5-mini'], ['openai', 'gpt-5-mini']]) {
    const r = await callOpenAiCompat({ candidate: { provider, url: `https://${provider}.test/v1/chat/completions`, key: 'k' }, model, system: 's', prompt: 'p', fetchImpl, env: {} });
    assert.equal(r.ok, true);
  }
  assert.equal(sent[0].reasoning_effort, 'low');
  assert.deepEqual(sent[1].reasoning, { effort: 'low' });
  assert.equal(sent[1].reasoning_effort, undefined, 'OpenRouter gets its own field only');
  assert.equal(sent[2].reasoning_effort, 'low');
  for (const b of sent) assert.equal(b.max_completion_tokens, 4096);
});

test('non-reasoning models get no reasoning field; PG1_COMPAT_REASONING_EFFORT overrides; junk falls back to low', () => {
  assert.deepEqual(compatReasoningFields('gateway', 'anthropic/claude-haiku-5-5', {}), {});
  assert.deepEqual(compatReasoningFields('openai', 'gpt-5', { PG1_COMPAT_REASONING_EFFORT: 'minimal' }), { reasoning_effort: 'minimal' });
  assert.deepEqual(compatReasoningFields('openrouter', 'openai/gpt-5', { PG1_COMPAT_REASONING_EFFORT: 'minimal' }), { reasoning: { effort: 'low' } });
  assert.deepEqual(compatReasoningFields('openai', 'gpt-5-mini', { PG1_COMPAT_REASONING_EFFORT: 'ludicrous' }), { reasoning_effort: 'low' });
});

test('a call that runs past its cap still says "timed out" (the log line the operator reads)', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
  const r = await callOpenAiCompat({ candidate: { provider: 'gateway', url: 'https://gateway.test/v1', key: 'k' }, model: 'openai/gpt-5-mini', system: 's', prompt: 'p', fetchImpl, timeoutMs: 20, env: {} });
  assert.deepEqual([r.ok, r.status, r.detail], [false, null, 'timed out']);
});
