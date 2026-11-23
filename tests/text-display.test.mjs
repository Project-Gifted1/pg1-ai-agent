/**
 * How PG1 shows text it did not write word for word (chat, lab cards,
 * reports): lib/textDisplay.mjs and its browser copy public/text-display.js.
 *   - underscores inside identifiers are never emphasis (the rule of
 *     lib/pdf/markdown.mjs): check_agent_message never reads
 *     "checkagentmessage", in a watch report, a reply's figures or a
 *     document heading;
 *   - text is shortened only at a word boundary, with "…";
 *   - no doubled prefix ("Improve: Improve (…)");
 *   - no stray ")" or empty "( )" when a field is missing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as lib from '../lib/textDisplay.mjs';
import * as web from '../public/text-display.js';

const COPIES = [['lib/textDisplay.mjs', lib], ['public/text-display.js', web]];

test('underscores inside identifiers are kept; emphasis at word edges is removed', async () => {
  assert.equal(lib.plainInline('Run check_agent_message on it'), 'Run check_agent_message on it');
  assert.equal(lib.plainInline('**check_agent_message** flagged _one_ line'), 'check_agent_message flagged one line');
  assert.equal(lib.plainInline('__bold__ and *it* and `check_repo_trap`'), 'bold and it and check_repo_trap');
  assert.equal(lib.plainInline('the check_mcp_server_reputation idea'), 'the check_mcp_server_reputation idea');
  // The same rule as the PDF renderer.
  const { plainText } = await import('../lib/pdf/markdown.mjs');
  for (const s of ['check_agent_message', 'a _b_ c', 'x__y__z', '**check_wallet_age**']) assert.equal(lib.plainInline(s), plainText(s).replace(/\s+/g, ' ').trim());
});

test('a watch report, reply figures and document headings keep identifiers whole', async () => {
  const src = readFileSync(new URL('../lib/watches/report.mjs', import.meta.url), 'utf8');
  assert.ok(!/replace\(\/\[\*_`\]\/g, ''\)/.test(src), 'watch reports no longer strip every underscore');
  for (const f of ['lib/replyFacts.mjs', 'lib/clientDocs.mjs']) assert.ok(!/replace\(\/\[\*_`\]\/g, ''\)/.test(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')), f);
  const { extractFigures } = await import('../lib/replyFacts.mjs');
  const figs = extractFigures('- **check_agent_message**: $0.02 per call\n- check_repo_trap: $0.05 per call');
  assert.ok(figs.some((f) => f.label === 'check_agent_message'), JSON.stringify(figs));
  assert.ok(figs.some((f) => f.label === 'check_repo_trap'), JSON.stringify(figs));
  const { offerHeading } = await import('../lib/clientDocs.mjs');
  assert.equal(offerHeading('## The **check_agent_message** package'), 'The check_agent_message package');
});

test('a lab watch report quotes its first line with identifiers whole, shortened at a word', async () => {
  const { composeReport } = await import('../lib/watches/report.mjs');
  const exp = { id: 'abcdef0123456789abcdef0123456789', kind: 'research', goal: 'g', status: 'done', spent_usd: 0, budget_usd: 2, result: { report_markdown: `## Findings\n**check_agent_message** flags hidden instructions; ${'and more words '.repeat(30)}` } };
  const r = composeReport({ target_type: 'lab', target_id: exp.id }, { state: 'done', info: { exp } });
  assert.ok(r.body.includes('check_agent_message flags hidden instructions'), r.body);
  assert.ok(!r.body.includes('checkagentmessage'));
  const quoted = /check_agent_message flags hidden instructions[^\n]*/.exec(r.body)[0];
  assert.match(quoted, /(words|more|and)…/, `shortened at a word: ${quoted}`);
});

for (const [name, T] of COPIES) {
  test(`${name}: shortened only at a word boundary, with "…"`, () => {
    const s = 'Propose check_mcp_server_reputation, a paid tool that rates MCP servers before an agent connects';
    for (const n of [12, 20, 37, 40, 41, 60, 80]) {
      const out = T.clipWords(s, n);
      assert.ok(out.endsWith('…'), out);
      assert.ok(out.length <= n || !out.slice(0, -1).includes(' '), `${n}: ${out}`);
      const body = out.slice(0, -1);
      assert.ok(s.startsWith(body), `${n}: ${out}`);
      // The cut is at the end of a word: the next character of the source is a space or punctuation.
      assert.match(s.slice(body.length, body.length + 1), /[\s,.;:)]/, `${n}: cut inside a word: ${out}`);
    }
    assert.equal(T.clipWords('check_mcp_server_reputation is new', 20), 'check_mcp_server_reputation…', 'a first word longer than n is kept whole, never cut');
    assert.equal(T.clipWords('short', 20), 'short');
    assert.equal(T.clipWords('  a   b  ', 20), 'a b');
    assert.equal(T.clipWords('The scan (one proposal) found more things', 18), 'The scan…', 'never ends inside an open bracket');
    assert.equal(T.clipWords('checkmcpserverreputation and more', 22), 'checkmcpserverreputation…', 'never "checkmcpserverreputati"');
  });

  test(`${name}: no doubled prefix; an empty field leaves no "( )"`, () => {
    assert.equal(T.withPrefix('Improve', 'Improve (server/discover): 11 method_not_found answers'), 'Improve (server/discover): 11 method_not_found answers');
    assert.equal(T.withPrefix('Improve', 'server/discover answers'), 'Improve: server/discover answers');
    assert.equal(T.withPrefix('Fix', 'Fixture loader'), 'Fix: Fixture loader', 'a longer word is not the prefix');
    assert.equal(T.withPrefix('Fix', ''), 'Fix');
    assert.equal(T.undouble('Improve: Improve (server/discover): 11 answers'), 'Improve (server/discover): 11 answers');
    assert.equal(T.undouble('Fix: the cause'), 'Fix: the cause');
    assert.equal(T.paren(''), '');
    assert.equal(T.paren(null), '');
    assert.equal(T.paren(undefined), '');
    assert.equal(T.paren('  '), '');
    assert.equal(T.paren('( )'), '');
    assert.equal(T.paren('x'), ' (x)');
    assert.equal(T.paren('model call failed (anthropic 400)'), ' (model call failed (anthropic 400))', 'a value keeps its own brackets');
  });
}

test('the two copies agree', () => {
  const cases = ['', 'a', 'one two three four five six seven', 'Improve: Improve (x): y', 'check_agent_message and check_repo_trap and more words here'];
  for (const c of cases) for (const n of [5, 10, 25]) assert.equal(web.clipWords(c, n), lib.clipWords(c, n), `${c} ${n}`);
  for (const c of cases) { assert.equal(web.undouble(c), lib.undouble(c)); assert.equal(web.paren(c), lib.paren(c)); assert.equal(web.withPrefix('Improve', c), lib.withPrefix('Improve', c)); }
});

test('lab: cards and failures are shortened at a word; goals are never "Improve: Improve"', async () => {
  const { labCardView, labFailure } = await import('../lib/lab/card.mjs');
  const long = `model call failed (free engines: ${'groq 429 rate limited; '.repeat(20)}cerebras 503 engine unavailable)`;
  const f = labFailure({ status: 'failed', kind: 'code', error: `build: ${long}` });
  assert.ok(f.message.length <= 240 && f.message.endsWith('…'), f.message);
  assert.ok(long.startsWith(f.message.slice(0, -1)));
  assert.match(long.slice(f.message.length - 1, f.message.length), /[\s;,)]/, 'cut at a word');
  const v = labCardView({ id: '82aaad40aaaabbbbccccddddeeeeffff', kind: 'code', status: 'failed', goal: 'Improve: Improve (server/discover): 11 method_not_found answers to real callers in 7 days (clearer inputs and messages). Make the inputs and error messages clearer, with tests.', error: 'build: The model proposed no usable change.' });
  assert.match(v.goal, /^Improve \(server\/discover\): 11 method_not_found/);
  assert.ok(v.goal.length <= 120 && v.goal.endsWith('…'));
  const { labGoalFor } = await import('../lib/operator/tasks.mjs');
  for (const title of ['Improve (server/discover): 11 method_not_found answers', 'Improve check_wallet_age: 12 invalid_params answers']) {
    const g = labGoalFor({ kind: 'improve', title, evidence: {} }).goal;
    assert.ok(!/^Improve: Improve/.test(g), g);
    assert.ok(g.startsWith(title), g);
  }
  assert.match(labGoalFor({ kind: 'improve', title: 'server/discover answers', evidence: {} }).goal, /^Improve: server\/discover answers\./);
  assert.match(labGoalFor({ kind: 'fix', title: 'Fix check_wallet_age: 6 errors', evidence: {} }).goal, /^Fix check_wallet_age: 6 errors\. Find/);
});

test('the lab card in the page shortens the failure at a word (window.pg1Text), never with .slice', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(!/String\(v\.failure\.message\)\.slice\(0, 240\)/.test(html));
  assert.ok(html.includes("window.pg1Text.clipWords(v.failure.message, 240)"));
  assert.ok(html.includes("import * as T from '/text-display.js'; window.pg1Text = T;"));
});
