/**
 * UI refresh security guarantees (public/index.html):
 *
 *  1. Security Gate form: method="post", no action URL, and the submit
 *     handler always calls preventDefault() first - so the page never
 *     reloads and the passkey can never appear in a URL. The inputs also
 *     carry no name attribute, so even a native submit would send nothing.
 *  2. formatMarkdown(): model text is HTML-escaped before any markdown
 *     transform, including the new tables, lists and headings - a reply
 *     containing <script>, <img onerror> or a javascript: link renders as
 *     plain text.
 *
 * Like the other client tests, this extracts the exact shipped source from
 * public/index.html rather than re-implementing it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

function openingTag(idAttr) {
  const idx = html.indexOf(idAttr);
  assert.ok(idx !== -1, `${idAttr} not found`);
  const start = html.lastIndexOf('<', idx);
  const end = html.indexOf('>', idx);
  return html.slice(start, end + 1);
}

// --- Security Gate form --------------------------------------------------

test('Security Gate is a POST form with no action URL, wired to handleAuthSubmit', () => {
  const form = openingTag('id="auth-form"');
  assert.match(form, /^<form\b/);
  assert.match(form, /\smethod="post"/i);
  assert.doesNotMatch(form, /\saction\s*=/i, 'the form must not have an action URL');
  assert.match(form, /\sonsubmit="handleAuthSubmit\(event\)"/);
});

test('Security Gate inputs have no name attribute and the passkey is a password field', () => {
  const user = openingTag('id="auth-user"');
  const pass = openingTag('id="auth-pass"');
  assert.doesNotMatch(user, /\sname\s*=/i);
  assert.doesNotMatch(pass, /\sname\s*=/i);
  assert.match(pass, /\stype="password"/);
  assert.match(pass, /autocomplete="current-password"/);
});

test('Security Gate submit button is type=submit inside the form', () => {
  const formStart = html.indexOf('id="auth-form"');
  const formEnd = html.indexOf('</form>', formStart);
  const formHtml = html.slice(formStart, formEnd);
  assert.match(formHtml, /<button type="submit" class="matrix-submit">Sign in<\/button>/);
  const submitButtons = formHtml.match(/type="submit"/g) || [];
  assert.equal(submitButtons.length, 1, 'only one submit button in the form');
});

test('the show/hide passkey toggle is a plain button, so it can never submit the form', () => {
  const toggle = openingTag('onclick="togglePasskeyVisibility(this)"');
  assert.match(toggle, /^<button type="button"/);
  assert.match(toggle, /aria-label="Show passkey"/);
  assert.match(toggle, /aria-controls="auth-pass"/);
});

test('the Security Gate fields have visible labels and no duplicate placeholders', () => {
  assert.doesNotMatch(openingTag('id="auth-user"'), /placeholder=/);
  assert.doesNotMatch(openingTag('id="auth-pass"'), /placeholder=/);
  assert.match(html, /<span class="field-label">Operator ID<\/span>/);
  assert.match(html, /<label class="field-label" for="auth-pass">Passkey<\/label>/);
});

function runAuthSubmit({ verifyThrows = false, hapticThrows = false } = {}) {
  const calls = [];
  const context = {
    triggerHaptic: () => { calls.push('haptic'); if (hapticThrows) throw new Error('no vibrate'); },
    verifyAuth: () => { calls.push('verifyAuth'); if (verifyThrows) throw new Error('boom'); }
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('handleAuthSubmit') + '\nthis.handleAuthSubmit = handleAuthSubmit;', context);
  const event = { preventDefault: () => calls.push('preventDefault') };
  let threw = null;
  try {
    context.handleAuthSubmit(event);
  } catch (e) {
    threw = e;
  }
  return { calls, threw };
}

test('handleAuthSubmit calls preventDefault before anything else, then verifyAuth', () => {
  const { calls, threw } = runAuthSubmit();
  assert.equal(threw, null);
  assert.equal(calls[0], 'preventDefault');
  assert.ok(calls.includes('verifyAuth'));
});

test('handleAuthSubmit has already prevented the native submit even if a later step throws', () => {
  for (const opts of [{ verifyThrows: true }, { hapticThrows: true }]) {
    const { calls } = runAuthSubmit(opts);
    assert.equal(calls[0], 'preventDefault', `preventDefault must run first (${JSON.stringify(opts)})`);
  }
});

// --- formatMarkdown escaping ---------------------------------------------

const mdContext = {};
vm.createContext(mdContext);
vm.runInContext(extractFunction('escapeHTML') + '\n' + extractFunction('formatMarkdown') + '\nthis.formatMarkdown = formatMarkdown;', mdContext);
const formatMarkdown = mdContext.formatMarkdown;

// No real tag that could run script may appear in the output: no <script>,
// no <img>/<a> pointing anywhere but http(s), and no inline event handler
// attribute on any tag (none of these inputs contain a slash-command chip or
// code fence, the only places formatMarkdown emits its own onclick).
function assertInert(out, label) {
  assert.doesNotMatch(out, /<script/i, `${label}: <script> tag leaked`);
  assert.doesNotMatch(out, /<img/i, `${label}: <img> tag leaked`);
  assert.doesNotMatch(out, /<[a-z][^>]*\son[a-z]+\s*=/i, `${label}: event-handler attribute leaked`);
  assert.doesNotMatch(out, /href\s*=\s*["']?\s*javascript:/i, `${label}: javascript: href leaked`);
  assert.doesNotMatch(out, /<a\s/i, `${label}: unexpected link`);
}

test('a <script> tag in a reply renders as plain text', () => {
  const out = formatMarkdown('hello <script>alert(1)</script> world');
  assertInert(out, 'script');
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('an <img onerror> in a reply renders as plain text', () => {
  const out = formatMarkdown('look <img src=x onerror=alert(1)> here');
  assertInert(out, 'img onerror');
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('a javascript: markdown link or image renders as plain text', () => {
  const link = formatMarkdown('[click me](javascript:alert(1))');
  assertInert(link, 'javascript link');
  assert.match(link, /\[click me\]\(javascript:alert\(1\)\)/);

  const img = formatMarkdown('![x](javascript:alert(1))');
  assertInert(img, 'javascript image');
  assert.match(img, /!\[x\]\(javascript:alert\(1\)\)/);
});

test('hostile HTML inside a table is escaped in every cell', () => {
  const out = formatMarkdown('| <script>a()</script> | <img src=x onerror=b()> |\n| --- | --- |\n| [x](javascript:c()) | <svg onload=d()> |');
  assert.match(out, /<table class="md-table">/, 'the table itself should still render');
  assertInert(out, 'table');
  assert.doesNotMatch(out, /<svg/i);
  assert.match(out, /<th scope="col">&lt;script&gt;a\(\)&lt;\/script&gt;<\/th>/);
  assert.match(out, /<td>&lt;svg onload=d\(\)&gt;<\/td>/);
});

test('hostile HTML inside lists is escaped', () => {
  const out = formatMarkdown('- <script>a()</script>\n- <img src=x onerror=b()>\n1. [x](javascript:c())\n2. <iframe src=javascript:d()>');
  assert.match(out, /<ul class="md-list">/);
  assert.match(out, /<ol class="md-list">/);
  assertInert(out, 'lists');
  assert.doesNotMatch(out, /<iframe/i);
  assert.match(out, /<li>&lt;script&gt;a\(\)&lt;\/script&gt;<\/li>/);
});

test('hostile HTML inside headings is escaped', () => {
  const out = formatMarkdown('# <script>a()</script>\n## <img src=x onerror=b()>\n### [x](javascript:c())');
  assert.match(out, /class="md-h md-h1"/);
  assert.match(out, /class="md-h md-h2"/);
  assert.match(out, /class="md-h md-h3"/);
  assertInert(out, 'headings');
});

test('an auto-linked URL cannot break out of its href attribute', () => {
  const out = formatMarkdown('see https://example.com/"onmouseover="alert(1) now');
  assert.doesNotMatch(out, /<[a-z][^>]*\son[a-z]+\s*=/i);
  const hrefs = [...out.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  for (const href of hrefs) assert.match(href, /^https:\/\/example\.com\//);
});

test('tables, lists and headings still render for ordinary replies', () => {
  const out = formatMarkdown('## Summary\nIntro line\n- one\n- two\n\n| A | B |\n|---|:-:|\n| 1 | 2 |\nafter');
  assert.match(out, /<div class="md-h md-h2" role="heading" aria-level="4">Summary<\/div>/);
  assert.match(out, /<ul class="md-list"><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(out, /<thead><tr><th scope="col">A<\/th><th scope="col">B<\/th><\/tr><\/thead>/);
  assert.match(out, /<tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody>/);
  assert.match(out, /after$/);
});
