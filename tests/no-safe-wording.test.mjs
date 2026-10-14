/**
 * PG1 never calls a result "safe": no_flags means "no flags found" in the
 * sources checked. Fails if "safe" (or "safety", "safely") appears in any MCP
 * tool description (top level and every schema description), llms.txt or
 * the /docs/agents page, unless it sits in a negation ("never claims safe",
 * "not proof the target is safe"). The noun "safety check" names a kind of
 * check, not a result, and is allowed.
 * Run with: node --test tests/no-safe-wording.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOOL_DEFINITIONS } from '../api/mcp.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const SAFE_RE = /\bsafe(?:ty|ly)?\b/gi;
// A negation earlier in the same clause (up to 60 characters back).
const NEGATION_RE = /\b(?:never|not|no|nor|without|isn't|doesn't|don't)\b|n't\b/i;

// The "safe" wording that is not allowed in `text`: [{ at, excerpt }].
export function unnegatedSafe(text) {
  const plain = String(text).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '');
  const bad = [];
  for (const m of plain.matchAll(SAFE_RE)) {
    const after = plain.slice(m.index, m.index + 20);
    if (/^safety[- ]checks?\b/i.test(after)) continue;
    const before = plain.slice(Math.max(0, m.index - 60), m.index).split(/[.;:!?\n]/).pop();
    if (NEGATION_RE.test(before)) continue;
    bad.push({ at: m.index, excerpt: plain.slice(Math.max(0, m.index - 60), m.index + 30) });
  }
  return bad;
}

function descriptions(tool) {
  const out = [[`${tool.name}`, tool.description]];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'description' && typeof v === 'string') out.push([`${tool.name} ${path}`, v]);
      else walk(v, `${path}.${k}`);
    }
  };
  walk(tool.inputSchema, 'inputSchema');
  walk(tool.outputSchema, 'outputSchema');
  return out;
}

test('the checker: catches "safe" as a verdict, allows negations', () => {
  for (const ok of ['never claims safe', 'never returns "safe" or "clean"', 'It is not proof the target is safe.', 'NOT that it\'s safe', 'never a safety verdict', 'not proof of safety', 'the recommended pre-action safety check']) {
    assert.deepEqual(unnegatedSafe(ok), [], ok);
  }
  for (const bad of ['no_flags means the wallet is safe', 'A safe result: proceed.', 'Proceed safely when status is no_flags.', 'not listed. The target is safe']) {
    assert.equal(unnegatedSafe(bad).length, 1, bad);
  }
});

test('no MCP tool description calls a result "safe"', () => {
  for (const tool of TOOL_DEFINITIONS) {
    for (const [where, text] of descriptions(tool)) assert.deepEqual(unnegatedSafe(text), [], where);
  }
});

for (const file of ['public/llms.txt', 'public/docs/agents/index.html']) {
  test(`${file} never calls a result "safe"`, () => {
    assert.deepEqual(unnegatedSafe(read(file)), []);
  });
}

test('llms.txt and /docs/agents open with the free point checks, then preflight_check', () => {
  const OPENER = 'Start with the free point checks. When you want one decision before acting, use preflight_check.';
  const llms = read('public/llms.txt');
  assert.ok(llms.includes(OPENER));
  assert.ok(llms.indexOf(OPENER) < llms.indexOf('\n## '), 'llms.txt: the opener comes before the first section');
  assert.ok(llms.indexOf('## Free point checks') < llms.indexOf('## One decision before acting: preflight_check'));
  const page = read('public/docs/agents/index.html').replace(/<\/?code>/g, '');
  assert.ok(page.includes(OPENER), '/docs/agents');
  const rows = [...page.matchAll(/<tr><td>[^<]*<\/td><td>([a-z0-9_]+)/g)].map((m) => m[1]);
  assert.equal(rows[0], 'preflight_check', 'preflight_check is the first row of the decision table');
});

test('the preflight example uses only test fixtures and says no_flags means no flags found', () => {
  for (const file of ['public/llms.txt', 'README.md']) {
    const text = read(file);
    for (const fixture of ['pg1-test-flagged.invalid', '0x7067312d746573742d6669787475726500000002', '_pg1-test-unknown']) assert.ok(text.includes(fixture), `${file}: ${fixture}`);
    assert.match(text, /no flags found/i, file);
  }
});
