/**
 * Issue #197 Phase 1(d): triple-backtick fenced code blocks in
 * public/index.html's formatMarkdown() must render as a clean <pre><code>
 * block, not leak stray backticks (the reported "``text" artifact caused by
 * the old single-backtick-only inline-code regex matching into the fence).
 *
 * formatMarkdown()/escapeHTML() are pure string functions with no DOM
 * dependency, so this extracts their source directly out of the shipped
 * HTML (no browser/jsdom needed) and evaluates them in a plain vm context.
 *
 * Run with: node --test tests/format-markdown-codefence.test.mjs
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
  const bodyStart = i;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return html.slice(start, i + 1);
}

const source = extractFunction('escapeHTML') + '\n' + extractFunction('formatMarkdown');
const context = {};
vm.createContext(context);
vm.runInContext(source + '\nthis.formatMarkdown = formatMarkdown;', context);
const formatMarkdown = context.formatMarkdown;

test('a fenced code block renders as <pre><code> with no stray backticks', () => {
  const out = formatMarkdown('before\n```js\nconst x = 1;\n```\nafter');
  assert.doesNotMatch(out, /`/, 'no backtick characters should survive into the rendered HTML');
  assert.match(out, /<pre[^>]*><code[^>]*>const x = 1;\n?<\/code><\/pre>/);
  assert.match(out, /^before/);
  assert.match(out, /after$/);
});

test('inline single-backtick code still renders normally outside fences', () => {
  const out = formatMarkdown('use `npm install` to set up');
  assert.match(out, /<span[^>]*>npm install<\/span>/);
});

test('a fenced block is not mangled by the bold/link/slash-command passes', () => {
  const out = formatMarkdown('```\n**not bold** [/not-a-command] https://not-a-link.example\n```');
  assert.doesNotMatch(out, /<strong/);
  assert.doesNotMatch(out, /onclick="triggerHaptic\(30\)/);
  assert.doesNotMatch(out, /<a href/);
  assert.match(out, /\*\*not bold\*\*/);
});
