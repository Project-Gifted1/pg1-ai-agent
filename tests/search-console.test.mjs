/**
 * Google Search Console verification and the sitemap.
 *
 * Covers: "/" and /playground both carry the exact verification meta tag in
 * the served HTML's <head> (not written by a script); public/sitemap.xml is
 * well-formed XML that lists only the public pages, each served by a file in
 * public/ (through a rewrite where one is needed); robots.txt points at the
 * sitemap and blocks none of those pages; vercel.json serves sitemap.xml as
 * application/xml.
 *
 * Run with: node --test tests/search-console.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const BASE_URL = 'https://pg1-ai-agent.vercel.app';
const VERCEL = JSON.parse(read('vercel.json'));
const TAG = '<meta name="google-site-verification" content="uGL_2UHMj5e5ZTkPFZfQ4QqRIzZSEO2UtchPRE1nfPA" />';

const PAGES = ['/', '/playground', '/about', '/docs/crypto-alert-bot', '/docs/reason-codes', '/docs/testing'];

// The public/ file a route is served from: a rewrite's destination, or the
// route itself as a directory index.
function servedFile(route) {
  const rewrite = (VERCEL.rewrites || []).find((r) => r.source === route);
  const dest = rewrite ? rewrite.destination : (route.endsWith('/') ? `${route}index.html` : `${route}/index.html`);
  return path.join('public', dest);
}

// Minimal XML well-formedness check: one declaration, balanced and properly
// nested elements, a single root, no stray text outside it.
function parseXml(xml) {
  let rest = xml.replace(/^﻿/, '');
  const decl = rest.match(/^<\?xml\s[^?]*\?>/);
  assert.ok(decl, 'starts with an XML declaration');
  rest = rest.slice(decl[0].length);
  const stack = [];
  let roots = 0;
  const TOKEN = /<!--[\s\S]*?-->|<\/([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  let m;
  while ((m = TOKEN.exec(rest))) {
    const [, close, open, , selfClose, text, stray] = m;
    if (stray) assert.fail(`malformed markup at offset ${m.index}`);
    if (text !== undefined) {
      if (!stack.length) assert.equal(text.trim(), '', 'no text outside the root element');
      assert.doesNotMatch(text, /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i, 'no unescaped &');
      continue;
    }
    if (open) {
      if (!stack.length) roots += 1;
      if (!selfClose) stack.push(open);
    } else if (close) {
      assert.equal(stack.pop(), close, `</${close}> closes the open element`);
    }
  }
  assert.deepEqual(stack, [], 'every element is closed');
  assert.equal(roots, 1, 'exactly one root element');
}

for (const [route, rel] of [['/', 'public/index.html'], ['/playground', servedFile('/playground')]]) {
  test(`${route} has the exact verification tag in its static <head>`, () => {
    assert.equal(rel, route === '/' ? 'public/index.html' : 'public/playground/index.html');
    const html = read(rel);
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
    assert.ok(head.includes(TAG), `${rel} <head> has the tag`);
    assert.equal(html.split('google-site-verification').length - 1, 1, 'one verification tag, no other');
    // Outside any <script>: present in the HTML as served, not injected.
    const scriptless = head.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    assert.ok(scriptless.includes(TAG), 'the tag is not inside a script');
  });
}

test('sitemap.xml is well-formed and lists exactly the public pages, playground included', () => {
  const xml = read('public/sitemap.xml');
  parseXml(xml);
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, PAGES.map((p) => BASE_URL + p));
  assert.ok(locs.includes(`${BASE_URL}/playground`));
  assert.ok(!locs.some((u) => /llms\.txt|\/api\//.test(u)), 'no non-page URLs');
  for (const route of PAGES) {
    assert.ok(fs.existsSync(path.join(ROOT, route === '/' ? 'public/index.html' : servedFile(route))), `${route} is served from a file in public/`);
  }
});

test('robots.txt names the sitemap and blocks none of the listed pages', () => {
  const robots = read('public/robots.txt');
  assert.match(robots, /^Sitemap: https:\/\/pg1-ai-agent\.vercel\.app\/sitemap\.xml$/m);
  const disallowed = [...robots.matchAll(/^Disallow:\s*(\S*)\s*$/gim)].map((m) => m[1]).filter(Boolean);
  for (const route of [...PAGES, '/sitemap.xml']) {
    assert.ok(!disallowed.some((d) => route.startsWith(d)), `${route} is not disallowed`);
  }
});

test('vercel.json serves sitemap.xml as application/xml and adds no auth or robots block to the pages', () => {
  const entry = VERCEL.headers.find((h) => h.source === '/sitemap.xml');
  assert.ok(entry, 'a header rule for /sitemap.xml');
  assert.deepEqual(entry.headers.find((h) => h.key.toLowerCase() === 'content-type'), { key: 'Content-Type', value: 'application/xml' });
  for (const rule of VERCEL.headers) {
    for (const h of rule.headers) {
      assert.notEqual(h.key.toLowerCase(), 'x-robots-tag', `${rule.source} sets X-Robots-Tag`);
      assert.notEqual(h.key.toLowerCase(), 'www-authenticate', `${rule.source} asks for auth`);
    }
  }
  for (const r of [...(VERCEL.rewrites || []), ...(VERCEL.redirects || [])]) {
    assert.notEqual(r.source, '/sitemap.xml', 'nothing rewrites or redirects sitemap.xml');
    assert.notEqual(r.source, '/', 'nothing rewrites or redirects /');
  }
});
