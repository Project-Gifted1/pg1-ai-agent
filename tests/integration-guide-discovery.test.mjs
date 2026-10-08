/**
 * The public integration guide at /docs/crypto-alert-bot is discoverable
 * from the agent-facing discovery files: an "Integration guides" section in
 * public/llms.txt, documentationUrl in the A2A agent card, and externalDocs
 * in public/openapi.json. No release goes with this: server.json and the
 * MCP tool definitions stay byte-identical to the 1.14.0 release (pinned
 * below by hash), and no version moves. The 1.15.0 licensing release has
 * since moved the versions and hashes pinned here (see
 * tests/source-policy.test.mjs for exactly what changed).
 *
 * Run with: node --test tests/integration-guide-discovery.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOC_PAGES } from '../scripts/build-docs.mjs';
import { PROVIDER_NAME_RE } from '../lib/playground.mjs';
import { TOOLS } from '../api/mcp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const BASE_URL = 'https://pg1-ai-agent.vercel.app';
const GUIDE_URL = `${BASE_URL}/docs/crypto-alert-bot`;
const LLMS = read('public/llms.txt');
const CARD = JSON.parse(read('public/.well-known/agent-card.json'));
const OPENAPI = JSON.parse(read('public/openapi.json'));
const VERCEL = JSON.parse(read('vercel.json'));

// Same list as tests/docs-pages.test.mjs, plus the bot's chat platform:
// none may appear in the text added for the guide.
const FORBIDDEN_NAMES = /ofac|treasury|metamask|eth-phishing-detect|rdap|alchemy|supabase|gumroad|alienvault|mitre|gemini|google|anthropic|claude|openai|gpt-|vercel|coinbase|\bllm\b|\bmodel\b|cloudflare|uptimerobot|telegram/i;
const noVendorNames = (label, text) => {
  const scrubbed = text.split('https://pg1-ai-agent.vercel.app').join('');
  const hit = scrubbed.match(PROVIDER_NAME_RE) || scrubbed.match(FORBIDDEN_NAMES);
  assert.equal(hit, null, `${label}: ${hit && hit[0]}`);
};

function llmsSection(heading) {
  const m = LLMS.match(new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  return m && m[1];
}

test('the guide URL is the live, committed /docs page', () => {
  const page = DOC_PAGES.find((p) => `${BASE_URL}${p.route}` === GUIDE_URL);
  assert.ok(page, `${GUIDE_URL} is not a page scripts/build-docs.mjs publishes`);
  const html = read(page.output);
  assert.match(html, new RegExp(`<link rel="canonical" href="${GUIDE_URL}">`));
  const rewrite = VERCEL.rewrites.find((r) => r.source === page.route);
  assert.ok(rewrite, `vercel.json has no rewrite for ${page.route}`);
  assert.equal(`public${rewrite.destination}`, page.output);
});

test('llms.txt has a short "Integration guides" section linking the guide', () => {
  const section = llmsSection('Integration guides');
  assert.ok(section, 'llms.txt is missing "## Integration guides"');
  const links = [...section.matchAll(/\]\((https?:[^)]+)\)/g)].map((m) => m[1]);
  assert.deepEqual(links, [GUIDE_URL]);
  assert.ok(section.trim().split('\n').length <= 3, 'keep the section short');
  noVendorNames('llms.txt Integration guides', section);
});

test('agent card documentationUrl points to the guide; nothing else in the card changes', () => {
  assert.equal(CARD.documentationUrl, GUIDE_URL);
  assert.equal(CARD.version, '1.16.0');
  assert.doesNotMatch(CARD.description, /docs\/crypto-alert-bot/, 'the spec field carries the link; the description stays as is');
});

test('openapi.json externalDocs points to the guide', () => {
  assert.equal(OPENAPI.externalDocs.url, GUIDE_URL);
  assert.equal(typeof OPENAPI.externalDocs.description, 'string');
  noVendorNames('openapi.json externalDocs', OPENAPI.externalDocs.description);
  assert.equal(OPENAPI.info.version, '1.16.0');
});

test('package version is unchanged; server version is the 1.16.0 release', () => {
  assert.equal(JSON.parse(read('package.json')).version, '1.0.3');
  assert.equal(JSON.parse(read('server.json')).version, '1.16.0');
});

test('server.json is byte-identical to the 1.15.0 release except the version (1.16.0)', () => {
  const reverted = fs.readFileSync(path.join(ROOT, 'server.json'), 'utf8').replace('"version": "1.16.0"', '"version": "1.15.0"');
  assert.equal(sha256(reverted), 'f0888cac3c000b2a8e6beded4cdfdbf8426c044ba787f48f2f57245df42d4137');
});

test('MCP tool names, descriptions and schemas are identical to the 1.15.0 release (plus check_ip_abuse and check_package, 1.16.0)', () => {
  assert.equal(TOOLS.length, 16);
  assert.equal(TOOLS[14].name, 'check_ip_abuse');
  assert.equal(TOOLS[15].name, 'check_package');
  assert.equal(sha256(JSON.stringify(TOOLS.slice(0, 14))), 'a177e3276b64a976e1b3a8412e77418e7846bf532379c8c9129882aff3488f06');
});
