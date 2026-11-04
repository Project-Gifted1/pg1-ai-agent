/**
 * Replies keep their digits.
 *
 * Production, 4 Nov (request cjxd10o3): the free chain fell through to
 * Cloudflare Workers AI (@cf/meta/llama-4-scout) and the reply came back
 * with every digit gone ("pg-ai-agent", "PG", "awesome-aa", "issue #",
 * "the last  hours"). The cause: Cloudflare's OpenAI-compatible stream sends
 * a token that is only digits as a JSON number ("content": 233), and
 * lib/aiRouter.mjs callOpenAiCompat kept string deltas only. It now keeps
 * them (compatContentText), for the stream and a whole message, and the film
 * planner's compatible call reads them the same way.
 *
 * Also here: the #403 usage-figure check (lib/usageClaims.mjs) acts only on
 * figures that claim something about PG1's usage, traffic, callers,
 * payments or revenue, never on digits in names, paths, URLs, dates,
 * versions, issue numbers, code or command names, and never changes PG1's
 * own reply text.
 * Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callOpenAiCompat, compatContentText } from '../lib/aiRouter.mjs';
import { extractUsageClaims, checkUsageClaims, prepareUsageTurn, usageTurnNotes, usageFactsBlock, USAGE_FIGURES_DIRECTIVE, CLAIM_CHECK_DIRECTIVE } from '../lib/usageClaims.mjs';
import { createReplySecretGuard } from '../lib/secretGuard.mjs';
import { secretEnvValues } from '../lib/handoff.mjs';
import { createReplyScrubber, scrubIdentity, stripTranscriptLabels } from '../lib/chatStream.mjs';
import { whiteLabel } from '../lib/whiteLabel.mjs';
import { noInfraNames } from '../lib/infraNames.mjs';

// The reply as it should have read (the operator's report of 4 Nov, digits back).
const REPLY = 'The pull request is open in pg1-ai-agent. It adds one line to docs/a2a-discovery.md, directly under the line that says PG1 has not registered anywhere:\n\n'
  + '> Listing status (4 Nov 2026): submitted to ai-boost/awesome-a2a as issue #233 (https://github.com/ai-boost/awesome-a2a/issues/233), waiting for the maintainers.\n\n'
  + 'PG1 has not registered anywhere else. /autonomy shows the current autonomy mode and the last 24 hours of the audit log.';
// What production showed.
const STRIPPED = REPLY.replace(/\d/g, '');

// How a Llama tokenizer splits it: words, and each digit its own token. A
// digit token is what Cloudflare sends as a JSON number.
function cloudflareTokens(text) {
  return text.match(/\d|[^\d]{1,6}/g).map((t) => (/^\d$/.test(t) ? Number(t) : t));
}
function cloudflareStream(text) {
  const lines = cloudflareTokens(text).map((tok, i) => `data: ${JSON.stringify({ id: 'a556f5a2ec85ef13-LHR', model: '@cf/meta/llama-4-scout-17b-16e-instruct', choices: [{ index: 0, delta: { content: tok }, finish_reason: null }] })}\n\n`);
  return lines.join('') + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9942, completion_tokens: 136 } })}\n\ndata: [DONE]\n\n`;
}
const candidate = { provider: 'cloudflare', url: 'https://api.cloudflare.test/client/v4/accounts/x/ai/v1/chat/completions', key: 'cf-test-key' };

test('the Cloudflare stream sends digit tokens as JSON numbers; the reply keeps every digit (the 4 Nov reply comes back unchanged)', async () => {
  const body = cloudflareStream(REPLY);
  assert.match(body, /"content":2[,}]/, 'the fixture really sends numbers');
  const r = await callOpenAiCompat({ candidate, model: '@cf/meta/llama-4-scout-17b-16e-instruct', system: 's', prompt: 'p', env: {}, log: () => {}, fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(r.ok, true);
  assert.equal(r.text, REPLY);
  assert.notEqual(r.text, STRIPPED);
  for (const s of ['pg1-ai-agent', 'a2a-discovery.md', 'PG1', '4 Nov 2026', 'awesome-a2a', '#233', 'issues/233', '24 hours']) assert.ok(r.text.includes(s), s);
});

test('a zero token and a whole answer that is a number are kept too; a non-streamed answer is read the same way', async () => {
  const zero = 'data: {"choices":[{"delta":{"content":"In "}}]}\n\ndata: {"choices":[{"delta":{"content":2}}]}\n\ndata: {"choices":[{"delta":{"content":0}}]}\n\ndata: {"choices":[{"delta":{"content":" days"}}]}\n\ndata: [DONE]\n\n';
  const r = await callOpenAiCompat({ candidate, model: 'm', system: 's', prompt: 'p', env: {}, log: () => {}, fetchImpl: async () => new Response(zero, { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(r.text, 'In 20 days');
  const json = { choices: [{ message: { role: 'assistant', content: 233 }, finish_reason: 'stop' }] };
  const j = await callOpenAiCompat({ candidate, model: 'm', system: 's', prompt: 'p', env: {}, log: () => {}, fetchImpl: async () => new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } }) });
  assert.equal(j.ok, true);
  assert.equal(j.text, '233');
  assert.equal(compatContentText([{ type: 'text', text: 'PG' }, { type: 'text', text: 1 }]), 'PG1');
  assert.equal(compatContentText([{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'shown' }]), 'shown');
  assert.equal(compatContentText(null), '');
  assert.equal(compatContentText({ a: 1 }), '');
});

test('the reply passes every reply guard unchanged (secret guard, identity, transcript labels, white label, infra names, the stream scrubber)', () => {
  const env = { USER_API_PASS: 'a-real-looking-password-1', GEMINI_API_KEY: 'AIzaSyD-test-key-123456789012345', PG1_DAILY_SPEND_CAP_USD: '5', PG1_PAID_CALL_WORST_CASE_USD: '0.004' };
  const guarded = createReplySecretGuard({ envValues: secretEnvValues(env), env })(REPLY);
  assert.equal(guarded.text, REPLY);
  assert.deepEqual(guarded.removed, []);
  assert.equal(stripTranscriptLabels(scrubIdentity(REPLY)), REPLY);
  assert.equal(whiteLabel(REPLY), REPLY);
  assert.equal(noInfraNames(REPLY), REPLY);
  let out = '';
  const scrub = createReplyScrubber((t) => { out += t; }, { redact: (t) => createReplySecretGuard({ envValues: secretEnvValues(env), env })(t) });
  for (const tok of cloudflareTokens(REPLY)) scrub.push(String(tok));
  scrub.flush();
  assert.equal(out, REPLY);
});

test('the usage-figure check (#403) leaves the reply alone: no figure in it is a usage claim, and nothing is added under it', async () => {
  assert.deepEqual(extractUsageClaims(REPLY), []);
  // Even as a pasted message from another agent it holds no usage claim.
  const turn = await prepareUsageTurn({ isOperator: true, promptText: `Grok said:\n${REPLY}`, getStats: async () => null });
  assert.equal(turn, null);
  assert.equal(usageTurnNotes(null, REPLY), '');
});

test('a made-up usage figure is still caught: "40,000 lookups a day" against 542 real calls a week', async () => {
  const stats = { period: '7d', summary: { real_tool_calls: 542, distinct_real_callers_estimate: 9, settled_revenue_usd: 0 }, traffic: { per_day: Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-${29 + i > 31 ? String(i - 2).padStart(2, '0') : 29 + i}`, real: 77, probe: 3 })), mcp_requests: { total: 600, real: 560, probe: 40 } }, payments: { payment_requests: 3, payments_settled: 0, revenue_usd: 0 } };
  const pasted = 'Grok said: PG1 now serves 40,000 lookups a day and is used by 1,200 agents. Release 1.21.1 shipped on 4 Nov 2026 (see issue #233, https://github.com/ai-boost/awesome-a2a/issues/233).';
  const claims = extractUsageClaims(pasted);
  assert.deepEqual(claims.map((c) => c.text), ['40,000 lookups a day', '1,200 agents']);
  const rows = checkUsageClaims(claims, stats);
  assert.equal(rows[0].matches, false);
  assert.equal(rows[0].real, 77.43);
  assert.equal(rows[1].matches, false);
  const turn = await prepareUsageTurn({ isOperator: true, promptText: pasted, getStats: async () => stats });
  const note = usageTurnNotes(turn, 'reply');
  assert.match(note, /\| 40,000 lookups a day \| 77\.4 a day/);
  assert.match(note, /\*\*no, does not match\*\*/);
  assert.match(note, /2 of 2 figures do not match the report/);
});

test('digits in names, paths, URLs, dates, versions, issue and PR numbers, code and command names are never usage figures', () => {
  const never = [
    'PG1 supports x402 calls and a2a requests.',
    'issue #233 checks were filed',
    'PR #404 checks passed',
    'v1.21 requests are faster',
    'Release 1.21.1 users can update',
    'docs/500-calls.md lists them',
    'https://example.com/stats/500/requests a day',
    'On 4 Nov 2026 users signed up',
    'Nov 4, 2026 agents',
    'see `500 requests a day` in the code',
    '```\nconst limit = 500 requests a day;\n```',
    'CVE-2024-1234 checks',
    'ERC-8004 agents',
    '/usage 7d lookups'
  ];
  for (const t of never) assert.deepEqual(extractUsageClaims(t), [], t);
});

test('the usage directives say "no figure" means usage figures only, and name what is never a figure', () => {
  const unread = usageFactsBlock(null);
  for (const d of [unread, USAGE_FIGURES_DIRECTIVE, CLAIM_CHECK_DIRECTIVE]) {
    assert.match(d, /Every other number stays exactly as written: names \(PG1, a2a, x402\), file paths, URLs, dates, version numbers, issue and PR numbers, code and command names are never figures\./);
  }
  assert.doesNotMatch(unread, /figure at all/);
});
