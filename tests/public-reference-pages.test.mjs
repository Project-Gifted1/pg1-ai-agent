/**
 * The public reference pages /docs/reason-codes (generated from
 * lib/reasonCodes.mjs) and /docs/testing (generated from the README's
 * "Test your integration" section), and the rule that public surfaces never
 * link into the private GitHub repo, where outsiders get a 404.
 *
 * Covers: each committed page is exactly what scripts/build-docs.mjs makes
 * from its source today; the reason-code table is the full frozen list in
 * order, with each code's kind; every table row, fixture and code block of
 * the README section is on /docs/testing; the same strict CSP as
 * /playground, no inline scripts, styles or handlers, nothing third-party;
 * no provider or vendor names; llms.txt points at both pages; and no public
 * surface links github.com/Project-Gifted1/pg1-ai-agent. MCP tool
 * descriptions are exempt until the licensing update (they are pinned by
 * hash in tests/integration-guide-discovery.test.mjs).
 *
 * Run with: node --test tests/public-reference-pages.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOC_PAGES, buildPage, DOCS_CSP, markdownSection } from '../scripts/build-docs.mjs';
import { REASON_CODES, INFORMATIONAL_REASON_CODES, INCOMPLETE_REASON_CODES } from '../lib/reasonCodes.mjs';
import { TEST_FIXTURES } from '../lib/fixtures.mjs';
import { PROVIDER_NAME_RE } from '../lib/playground.mjs';
import { TOOLS } from '../api/mcp.mjs';
import { decodeHtml, pageCodeBlocks, mdCodeBlocks } from './helpers/doc-page.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const BASE_URL = 'https://pg1-ai-agent.vercel.app';
const VERCEL = JSON.parse(read('vercel.json'));
const LLMS = read('public/llms.txt');

const REASONS = DOC_PAGES.find((p) => p.route === '/docs/reason-codes');
const TESTING = DOC_PAGES.find((p) => p.route === '/docs/testing');
const README_SECTION = markdownSection(read('README.md'), 'Test your integration');

// Same list as tests/docs-pages.test.mjs.
const FORBIDDEN_NAMES = /ofac|treasury|metamask|eth-phishing-detect|rdap|alchemy|supabase|gumroad|alienvault|mitre|gemini|google|anthropic|claude|openai|gpt-|vercel|coinbase|\bllm\b|\bmodel\b|cloudflare|uptimerobot/i;

// Any link into the private repo: github.com/Project-Gifted1/pg1-ai-agent,
// with or without a path, any case.
const PRIVATE_REPO_LINK = /github\.com\/Project-Gifted1\/pg1-ai-agent\b[^\s"'<>)]*/gi;

const pageText = (html) => decodeHtml(html.replace(/<[^>]+>/g, ''));
const strip = (s) => s.replace(/`/g, '').replace(/\*\*?/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();

test('both pages are published by scripts/build-docs.mjs, with a rewrite each', () => {
  assert.ok(REASONS, '/docs/reason-codes is not in DOC_PAGES');
  assert.ok(TESTING, '/docs/testing is not in DOC_PAGES');
  assert.equal(REASONS.source, 'lib/reasonCodes.mjs');
  assert.equal(REASONS.output, 'public/docs/reason-codes/index.html');
  assert.equal(TESTING.source, 'README.md');
  assert.equal(TESTING.section, 'Test your integration');
  assert.equal(TESTING.output, 'public/docs/testing/index.html');
  for (const page of [REASONS, TESTING]) {
    const rewrite = VERCEL.rewrites.find((r) => r.source === page.route);
    assert.ok(rewrite, `vercel.json has no rewrite for ${page.route}`);
    assert.equal(`public${rewrite.destination}`, page.output);
    assert.match(read(page.output), new RegExp(`<link rel="canonical" href="${BASE_URL}${page.route}">`));
  }
});

test('drift: each committed page is exactly what the generator makes from its source today (run npm run docs:build)', () => {
  for (const page of [REASONS, TESTING]) {
    assert.equal(read(page.output), buildPage(page), `${page.output} is stale: run npm run docs:build`);
  }
});

test('/docs/reason-codes lists every code in lib/reasonCodes.mjs, in order, with its kind and meaning', () => {
  const html = read(REASONS.output);
  const tbody = html.match(/<thead><tr><th scope="col">Code<\/th><th scope="col">Kind<\/th><th scope="col">Meaning<\/th><\/tr><\/thead>\n<tbody>\n([\s\S]*?)\n<\/tbody>/);
  assert.ok(tbody, 'reason-code table not found');
  const rows = [...tbody[1].matchAll(/<tr><td><code>([A-Z0-9_]+)<\/code><\/td><td>(\w+)<\/td><td>(.*?)<\/td><\/tr>/g)]
    .map(([, code, kind, meaning]) => [code, kind, decodeHtml(meaning)]);
  const expected = Object.entries(REASON_CODES).map(([code, meaning]) => [
    code,
    INFORMATIONAL_REASON_CODES.includes(code) ? 'Informational' : INCOMPLETE_REASON_CODES.includes(code) ? 'Incomplete' : 'Warning',
    meaning
  ]);
  assert.deepEqual(rows, expected);
  assert.equal(tbody[1].split('\n').length, Object.keys(REASON_CODES).length, 'no rows beyond the frozen list');
  assert.doesNotMatch(pageText(html), /\bsafe\b/i);
});

test('/docs/reason-codes names exactly the codes the fixtures can return, and links /docs/testing', () => {
  const html = read(REASONS.output);
  const para = pageText(html.match(/<h2 id="test-inputs">Test inputs<\/h2>\n<p>([\s\S]*?)<\/p>/)[1]);
  const withFixture = new Set(TEST_FIXTURES.flatMap((f) => f.expected.reason_codes));
  const [covered, uncovered] = para.split('No test input returns');
  for (const code of Object.keys(REASON_CODES)) {
    assert.equal(covered.includes(code), withFixture.has(code), `${code} in the "they return" list`);
    assert.equal((uncovered || '').includes(code), !withFixture.has(code), `${code} in the "no test input" list`);
  }
  assert.match(html, /<a href="\/docs\/testing">Test your integration<\/a>/);
});

test('/docs/testing has every heading, table cell and code block of the README section, and every fixture', () => {
  const html = read(TESTING.output);
  const text = pageText(html);
  for (const [, h] of README_SECTION.matchAll(/^#{1,3} (.+)$/gm)) assert.ok(text.includes(strip(h)), `heading missing: ${h}`);
  const tableLines = README_SECTION.split('\n').filter((l) => l.startsWith('|') && !/^\|[\s|:-]+\|$/.test(l.trim()));
  assert.equal(tableLines.length, TEST_FIXTURES.length + 1, 'header plus one row per fixture');
  for (const line of tableLines) {
    for (const cell of line.slice(1, -1).split('|')) assert.ok(text.includes(strip(cell)), `table cell missing: ${cell}`);
  }
  for (const f of TEST_FIXTURES) {
    assert.ok(text.includes(JSON.stringify(f.arguments)), `fixture arguments missing: ${f.tool}/${f.kind}`);
    assert.ok(text.includes(f.expected.summary), `fixture result missing: ${f.tool}/${f.kind}`);
  }
  const md = mdCodeBlocks(README_SECTION);
  assert.ok(md.length >= 4, `found ${md.length} code blocks`);
  assert.deepEqual(pageCodeBlocks(html), md);
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const [, a] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(a), `#${a} has no target`);
});

test('/docs/testing leaves out the README notes for editors and links nothing in the repo', () => {
  const readme = read('README.md');
  const raw = readme.slice(readme.indexOf('## Test your integration'), readme.indexOf('\n## ', readme.indexOf('## Test your integration') + 1));
  assert.match(raw, /<!--[\s\S]*?\/docs\/testing[\s\S]*?-->/, 'the README section says it is published');
  const html = read(TESTING.output);
  assert.doesNotMatch(html.slice(html.indexOf('<body>')), /<!--|npm run docs:build|lib\/fixtures\.mjs/);
  // Repo-relative links would 404 on the site.
  assert.doesNotMatch(README_SECTION, /\]\((?!https:\/\/|\/|#)[^)]+\)/, 'no repo-relative links in the section');
});

test('a strict Content-Security-Policy, same as /playground, and no inline scripts, styles or handlers', () => {
  const pgCsp = VERCEL.headers.find((h) => h.source === '/playground').headers.find((h) => h.key === 'Content-Security-Policy').value;
  for (const page of [REASONS, TESTING]) {
    const entry = VERCEL.headers.find((h) => h.source === page.route);
    assert.ok(entry, `headers for ${page.route}`);
    const get = (k) => (entry.headers.find((h) => h.key === k) || {}).value;
    assert.equal(get('Content-Security-Policy'), pgCsp);
    assert.equal(get('X-Content-Type-Options'), 'nosniff');
    assert.equal(get('Referrer-Policy'), 'no-referrer');
    assert.equal(get('X-Frame-Options'), 'DENY');

    const html = read(page.output);
    const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
    assert.ok(meta);
    assert.equal(meta[1], DOCS_CSP);
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    assert.match(scripts[0][1], /^ src="\/docs\/docs\.js" defer$/);
    assert.equal(scripts[0][2], '', 'no inline script body');
    assert.doesNotMatch(html, /<style\b|\sstyle="|\son[a-z]+=|javascript:/i);
    for (const [, url] of html.matchAll(/\s(?:src|href)="([^"#][^"]*)"/g)) {
      if (url === `${BASE_URL}${page.route}`) continue; // canonical
      assert.match(url, /^\/[a-z]/, `${page.route}: ${url} is not a same-origin path`);
    }
  }
});

test('no provider, data-vendor or model names on either page or in its source text', () => {
  for (const [name, src] of [
    ['reason-codes page', read(REASONS.output)],
    ['testing page', read(TESTING.output)],
    ['README section', README_SECTION],
    ['reason-code meanings', Object.values(REASON_CODES).join('\n')]
  ]) {
    const scrubbed = src.split(BASE_URL).join('');
    const hit = scrubbed.match(PROVIDER_NAME_RE) || scrubbed.match(FORBIDDEN_NAMES);
    assert.equal(hit, null, `${name}: ${hit && hit[0]}`);
  }
});

test('llms.txt points at /docs/reason-codes and /docs/testing', () => {
  const meta = LLMS.match(/^## Response metadata\n([\s\S]*?)(?=^## )/m)[1];
  assert.match(meta, /Full reason-code list: https:\/\/pg1-ai-agent\.vercel\.app\/docs\/reason-codes$/m);
  const testing = LLMS.match(/^## Test your integration\n([\s\S]*?)(?=^## )/m)[1];
  assert.match(testing, /Full table: https:\/\/pg1-ai-agent\.vercel\.app\/docs\/testing\n/);
});

// Every public surface: the discovery files, every file the site serves
// from public/ (llms.txt, /about, /playground, the /docs pages, the agent
// card, openapi.json, ...), and what the public endpoints return.
function publicFiles(dir = 'public') {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return publicFiles(rel);
    return /\.(html|css|js|mjs|json|txt|webmanifest|svg|md|xml)$/.test(e.name) || !e.name.includes('.') ? [rel] : [];
  });
}

test('no public surface links into the private repo (MCP tool descriptions aside)', () => {
  const files = publicFiles();
  for (const required of ['public/llms.txt', 'public/about/index.html', 'public/playground/index.html', 'public/docs/crypto-alert-bot/index.html',
    'public/docs/reason-codes/index.html', 'public/docs/testing/index.html', 'public/.well-known/agent-card.json', 'public/openapi.json']) {
    assert.ok(files.includes(required), `${required} is scanned`);
  }
  // The public endpoints' own source: their responses (agent card URL, MCP
  // initialize, errors, playground cards) are built here.
  const sources = [...files, 'api/a2a.mjs', 'api/playground.mjs', 'api/health.mjs', 'api/mcp.mjs', 'lib/playground.mjs', 'lib/fixtures.mjs', 'lib/reasonCodes.mjs', 'lib/responseMeta.mjs', 'lib/invalidInput.mjs'];

  // Exempt until the licensing update: links inside MCP tool descriptions.
  const descriptions = [];
  const collect = (v) => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (k === 'description' && typeof x === 'string' ? descriptions.push(x) : collect(x));
  };
  collect(TOOLS);
  const exempt = new Set(descriptions.flatMap((d) => d.match(PRIVATE_REPO_LINK) || []));

  const hits = [];
  for (const rel of sources) {
    for (const link of read(rel).match(PRIVATE_REPO_LINK) || []) {
      if (rel === 'api/mcp.mjs' && exempt.has(link)) continue;
      hits.push(`${rel}: ${link}`);
    }
  }
  assert.deepEqual(hits, []);
});
