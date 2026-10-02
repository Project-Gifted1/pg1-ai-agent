/**
 * Approval diff previews ("[DIFF PREVIEW — file]" replies from
 * APPLY_SURGICAL_PATCH / ACCEPT_AUTHORIZATION, "[DIFF]" after /approve,
 * REORGANIZE_FILES "UPDATE file" blocks, and ```diff fences) must render as
 * a diff: removed and added lines keep their -/+ marker and get distinct
 * classes, instead of formatMarkdown's list pass turning both into
 * identical bullets.
 *
 * Same approach as format-markdown-codefence.test.mjs: the pure string
 * functions are pulled out of the shipped HTML and run in a vm context.
 *
 * Run with: node --test tests/approval-diff-render.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '../public/index.html'), 'utf-8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `function ${name} not found in public/index.html`);
  let depth = 0;
  let i = html.indexOf('{', start);
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return html.slice(start, i + 1);
}

const source = ['escapeHTML', 'renderDiffBlock', 'formatMarkdown'].map(extractFunction).join('\n');
const context = {};
vm.createContext(context);
vm.runInContext(source + '\nthis.formatMarkdown = formatMarkdown; this.renderDiffBlock = renderDiffBlock;', context);
const { formatMarkdown, renderDiffBlock } = context;

const lineOf = (out, kind) => [...out.matchAll(new RegExp(`<span class="diff-line diff-${kind}">(.*?)</span>(?=<span class="diff-line|</code>)`, 'g'))].map((m) => m[1]);

test('an approval diff preview renders as a diff block, not a bullet list', () => {
  const reply = '[AGENT] Fix identified and validated — NOT yet committed.\n\n[DIFF PREVIEW — api/x.mjs]\n- const a = 1;\n+ const a = 2;\n[1 lines added / 1 lines removed]\n\nReply "/approve T" to authorize.';
  const out = formatMarkdown(reply);
  assert.doesNotMatch(out, /<ul|<li/, 'diff lines must not become list items');
  assert.match(out, /<div class="diff-block" role="group" aria-label="DIFF PREVIEW — api\/x\.mjs">/);
  assert.match(out, /<div class="diff-head">\[DIFF PREVIEW — api\/x\.mjs\]<\/div>/);
  assert.deepEqual(lineOf(out, 'del'), ['<span class="sr-only diff-sr">removed: </span><span class="diff-mark" aria-hidden="true">-</span> const a = 1;']);
  assert.deepEqual(lineOf(out, 'add'), ['<span class="sr-only diff-sr">added: </span><span class="diff-mark" aria-hidden="true">+</span> const a = 2;']);
  assert.deepEqual(lineOf(out, 'meta'), ['[1 lines added / 1 lines removed]']);
  assert.match(out, /Reply &quot;\/approve T&quot; to authorize\.$/, 'text after the diff is still formatted normally');
});

test('removed, added, context and hunk-header lines each get their own class', () => {
  const out = formatMarkdown('```diff\n@@ -1,3 +1,3 @@\n keep me\n-old line\n+new line\n```');
  assert.deepEqual(lineOf(out, 'hunk'), ['@@ -1,3 +1,3 @@']);
  assert.deepEqual(lineOf(out, 'ctx'), ['<span class="diff-mark" aria-hidden="true"> </span>keep me']);
  assert.deepEqual(lineOf(out, 'del'), ['<span class="sr-only diff-sr">removed: </span><span class="diff-mark" aria-hidden="true">-</span>old line']);
  assert.deepEqual(lineOf(out, 'add'), ['<span class="sr-only diff-sr">added: </span><span class="diff-mark" aria-hidden="true">+</span>new line']);
  assert.doesNotMatch(out, /`/);
});

test('HTML and markdown inside diff lines come out escaped and literal', () => {
  const reply = '[DIFF PREVIEW — public/a.html]\n- <img src=x onerror="alert(1)">\n+ **bold** [link](https://evil.example) `code` <script>x()</script>\n+ - [ /status ] nested bullet\n[2 lines added / 1 lines removed]';
  const out = formatMarkdown(reply);
  assert.doesNotMatch(out, /<img|<script|<strong|<a |md-code-inline|cmd-chip|<ul|<li/);
  assert.match(out, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(out, /\*\*bold\*\* \[link\]\(https:\/\/evil\.example\) `code` &lt;script&gt;x\(\)&lt;\/script&gt;/);
  assert.match(out, /aria-hidden="true">\+<\/span> - \[ \/status \] nested bullet/);
});

test('[DIFF] after /approve and REORGANIZE_FILES UPDATE blocks are diffs too', () => {
  const approved = formatMarkdown('[AGENT] Approved & PR Opened: https://github.com/o/r/pull/1\n\n[DIFF]\n- a\n+ b\n[1 lines added / 1 lines removed]');
  assert.equal(lineOf(approved, 'del').length, 1);
  assert.equal(lineOf(approved, 'add').length, 1);
  const reorg = formatMarkdown('[1 OPERATION(S) — WILL BE ONE COMMIT]\nUPDATE lib/x.mjs\n- a\n+ b\n[1 lines added / 1 lines removed]');
  assert.match(reorg, /<div class="diff-head">UPDATE lib\/x\.mjs<\/div>/);
  assert.equal(lineOf(reorg, 'add').length, 1);
});

test('ordinary "- " lists outside a diff still render as lists', () => {
  const out = formatMarkdown('Things:\n- one\n- two');
  assert.match(out, /<ul class="md-list"><li>one<\/li><li>two<\/li><\/ul>/);
  assert.doesNotMatch(out, /diff-block/);
});

test('renderDiffBlock never adds markup from line content (expects pre-escaped input)', () => {
  const out = renderDiffBlock(['-&lt;b&gt;x&lt;/b&gt;'], '');
  assert.match(out, /aria-label="Diff"/);
  assert.match(out, /aria-hidden="true">-<\/span>&lt;b&gt;x&lt;\/b&gt;<\/span>/);
});
