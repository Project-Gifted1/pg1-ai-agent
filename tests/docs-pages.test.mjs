/**
 * The public integration-guide pages under /docs (public/docs/), generated
 * from docs/integrations/*.md by scripts/build-docs.mjs.
 *
 * Covers: the committed page is exactly what the generator makes from the
 * Markdown today (so the two cannot drift); every code block, heading and
 * table of the Markdown is on the page, verbatim; each code block has a
 * copy button; the same strict CSP as /playground, no inline scripts,
 * styles or handlers, nothing third-party, no cookies, storage, analytics
 * or network requests; links from /about and the /playground footer; no
 * provider, vendor or personal names.
 *
 * The guide's facts (endpoints, fields, tool names) are checked against the
 * code for both the Markdown and this page in
 * tests/crypto-alert-bot-guide.test.mjs.
 *
 * Run with: node --test tests/docs-pages.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOC_PAGES, buildPage, DOCS_CSP } from '../scripts/build-docs.mjs';
import { PROVIDER_NAME_RE } from '../lib/playground.mjs';
import { decodeHtml, pageCodeBlocks, mdCodeBlocks } from './helpers/doc-page.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const BASE_URL = 'https://pg1-ai-agent.vercel.app';
const PAGE = DOC_PAGES.find((p) => p.route === '/docs/crypto-alert-bot');
const HTML = read(PAGE.output);
const MD = read(PAGE.source);
const CSS = read('public/docs/docs.css');
const JS = read('public/docs/docs.js');

// The /playground list plus hosting/model words: none may appear on a
// public docs page (the site's own domain aside).
const FORBIDDEN_NAMES = /ofac|treasury|metamask|eth-phishing-detect|rdap|alchemy|supabase|gumroad|alienvault|mitre|gemini|google|anthropic|claude|openai|gpt-|vercel|coinbase|\bllm\b|\bmodel\b|cloudflare|uptimerobot/i;

test('the crypto alert bot guide is published at /docs/crypto-alert-bot from the Markdown source', () => {
  assert.equal(PAGE.source, 'docs/integrations/crypto-alert-bot.md');
  assert.equal(PAGE.output, 'public/docs/crypto-alert-bot/index.html');
  const vercel = JSON.parse(read('vercel.json'));
  assert.ok(vercel.rewrites.some((r) => r.source === '/docs/crypto-alert-bot' && r.destination === '/docs/crypto-alert-bot/index.html'));
});

test('the committed page is exactly what scripts/build-docs.mjs makes from the Markdown (run npm run docs:build)', () => {
  for (const page of DOC_PAGES) {
    assert.equal(read(page.output), buildPage(page), `${page.output} is stale: run npm run docs:build`);
  }
});

test('every code block of the Markdown is on the page, verbatim and in order, each with a copy button', () => {
  const md = mdCodeBlocks(MD);
  const page = pageCodeBlocks(HTML);
  assert.ok(md.length >= 10, `found ${md.length} code blocks`);
  assert.deepEqual(page, md);
  const blocks = HTML.match(/<div class="code">[\s\S]*?<\/pre><\/div>/g);
  assert.equal(blocks.length, md.length);
  for (const b of blocks) assert.match(b, /<button type="button" class="copy" data-copy hidden>Copy<\/button>/);
});

test('every heading and table row of the Markdown is on the page, and the in-page links resolve', () => {
  const text = decodeHtml(HTML.replace(/<[^>]+>/g, ''));
  const strip = (s) => s.replace(/`/g, '').replace(/\*\*?/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
  for (const [, h] of MD.matchAll(/^#{1,3} (.+)$/gm)) assert.ok(text.includes(strip(h)), `heading missing: ${h}`);
  for (const line of MD.split('\n').filter((l) => l.startsWith('|') && !/^\|[\s|:-]+\|$/.test(l.trim()))) {
    for (const cell of line.slice(1, -1).split('|')) assert.ok(text.includes(strip(cell)), `table cell missing: ${cell}`);
  }
  const ids = new Set([...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const anchors = [...HTML.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(anchors.length >= 9);
  for (const a of anchors) assert.ok(ids.has(a), `#${a} has no target`);
  // Links written in the Markdown use GitHub's anchors; the page keeps them.
  for (const [, a] of MD.matchAll(/\]\(#([^)]+)\)/g)) assert.ok(ids.has(a), `#${a} from the Markdown has no target`);
});

test('the page is presented as a general example, with no personal names', () => {
  assert.match(MD, /^# Example: a Telegram alert bot that screens wallets with PG1$/m);
  assert.match(HTML, /<h1>Example: a Telegram alert bot that screens wallets with PG1<\/h1>/);
  assert.match(HTML, /<title>Example: a Telegram alert bot that screens wallets with PG1 · PG1<\/title>/);
  for (const src of [MD, HTML]) {
    assert.doesNotMatch(src, /gikewun|@gmail|\bmy bot\b|\bour bot\b|\bhis\b|\bher\b|Project-Gifted1\/|github\.com/i);
  }
});

test('a strict Content-Security-Policy, same as /playground (vercel.json headers and the page itself)', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const pgCsp = vercel.headers.find((h) => h.source === '/playground').headers.find((h) => h.key === 'Content-Security-Policy').value;
  for (const source of ['/docs/crypto-alert-bot', '/docs/(.*)']) {
    const entry = vercel.headers.find((h) => h.source === source);
    assert.ok(entry, `headers for ${source}`);
    const get = (k) => (entry.headers.find((h) => h.key === k) || {}).value;
    assert.equal(get('Content-Security-Policy'), pgCsp);
    assert.match(get('Content-Security-Policy'), /default-src 'self'; script-src 'self'; style-src 'self';/);
    assert.match(get('Content-Security-Policy'), /object-src 'none'/);
    assert.match(get('Content-Security-Policy'), /frame-ancestors 'none'/);
    assert.doesNotMatch(get('Content-Security-Policy'), /unsafe-inline|unsafe-eval|https?:|\*/);
    assert.equal(get('X-Content-Type-Options'), 'nosniff');
    assert.equal(get('Referrer-Policy'), 'no-referrer');
    assert.equal(get('X-Frame-Options'), 'DENY');
  }
  const meta = HTML.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(meta);
  assert.equal(meta[1], DOCS_CSP);
  assert.equal(pgCsp.replace("; frame-ancestors 'none'", ''), DOCS_CSP, 'the page meta matches the header (frame-ancestors is header-only)');
});

test('no inline scripts, styles or handlers, and nothing third-party', () => {
  const scripts = [...HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0][1], /^ src="\/docs\/docs\.js" defer$/);
  assert.equal(scripts[0][2], '', 'no inline script body');
  assert.doesNotMatch(HTML, /<style\b|\sstyle="|\son[a-z]+=|javascript:/i);
  const links = [...HTML.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]);
  assert.deepEqual(links.filter((l) => /stylesheet/.test(l)), ['<link rel="stylesheet" href="/docs/docs.css">']);
  // No resource is loaded from anywhere but this origin. URLs in the text
  // are the documented API (shown as code, never fetched).
  for (const [, url] of HTML.matchAll(/\s(?:src|href)="([^"#][^"]*)"/g)) {
    if (url === `${BASE_URL}${PAGE.route}`) continue; // canonical
    assert.match(url, /^\/[a-z]/, `${url} is not a same-origin path`);
  }
  assert.doesNotMatch(CSS, /@import|url\(\s*['"]?https?:/i);
  assert.doesNotMatch(JS, /\bon[a-z]+="|innerHTML|eval\(|new Function/i);
});

test('no cookies, no browser storage, no analytics, no network requests', () => {
  const stripComments = (src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const js = stripComments(JS);
  assert.doesNotMatch(js, /document\.cookie|localStorage|sessionStorage|indexedDB|navigator\.sendBeacon|gtag|analytics|plausible|posthog|segment|fetch\(|XMLHttpRequest|WebSocket|EventSource|import\(/i);
  assert.doesNotMatch(HTML.replace(/<pre[\s\S]*?<\/pre>/g, ''), /document\.cookie|localStorage|analytics|gtag|plausible|posthog/i);
  assert.match(js, /navigator\.clipboard/);
  assert.match(js, /\[data-copy\]/);
});

test('/about has an "Integration guides" line and the /playground footer links to the guide', () => {
  const about = read('public/about/index.html');
  const line = about.match(/<p>Integration guides: ([\s\S]*?)<\/p>/);
  assert.ok(line, '/about should have an "Integration guides" line');
  assert.match(line[1], /<a href="\/docs\/crypto-alert-bot">Example: a Telegram alert bot that screens wallets with PG1<\/a>/);

  const playground = read('public/playground/index.html');
  const footer = playground.match(/<footer>([\s\S]*?)<\/footer>/)[1];
  assert.match(footer, /href="\/docs\/crypto-alert-bot"/);
  assert.match(footer, /href="\/about"/);

  const footerPage = HTML.match(/<footer>([\s\S]*?)<\/footer>/)[1];
  assert.match(footerPage, /href="\/playground"/);
  assert.match(footerPage, /href="\/about"/);
});

// llms.txt, the agent card and openapi.json link the page (see
// tests/integration-guide-discovery.test.mjs); server.json never does.
test('server.json does not link the page', () => {
  assert.doesNotMatch(read('server.json'), /docs\/crypto-alert-bot|Integration guides/);
});

test('no provider, data-vendor or model names on the page, its CSS or its script', () => {
  for (const [name, src] of [['page', HTML.split(BASE_URL).join('')], ['markdown', MD.split(BASE_URL).join('')], ['css', CSS], ['js', JS]]) {
    const hit = src.match(PROVIDER_NAME_RE) || src.match(FORBIDDEN_NAMES);
    assert.equal(hit, null, `${name}: ${hit && hit[0]}`);
  }
});
