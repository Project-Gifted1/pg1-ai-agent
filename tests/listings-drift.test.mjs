/**
 * Every public listing of PG1's tools must match the live MCP tools/list.
 * The live list is what /api/mcp answers with the default environment
 * (listedTools(): subscribe_alerts hidden while PG1_ALERTS is off). Fails if:
 *   - the version differs anywhere: server.json, the agent card, OpenAPI,
 *     MCP initialize serverInfo and GET /api/mcp, GET /api/a2a;
 *   - the README "All Available MCP Tools" table is not exactly the live
 *     tools, or the README, llms.txt, /docs/agents, the agent card or the
 *     chat's self-description leaves a live tool out, names a hidden one,
 *     or states a tool count that is not the live count;
 *   - the agent card's tool skills are not exactly the live A2A skills;
 *   - a listing describes the STIX feed as paid or as anything but NVD
 *     while the feed is free (PG1_FEED_PAID off).
 * Run with: node --test tests/listings-drift.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import mcpHandler, { listedTools, TOOL_DEFINITIONS } from '../api/mcp.mjs';
import a2aHandler, { A2A_SKILL_TOOLS, JOB_SKILL } from '../api/a2a.mjs';
import { isFeedPaid } from '../lib/x402Config.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const LIVE = listedTools({}).map((t) => t.name);
const HIDDEN = TOOL_DEFINITIONS.map((t) => t.name).filter((n) => !LIVE.includes(n));

const SERVER = JSON.parse(read('server.json'));
const CARD = JSON.parse(read('public/.well-known/agent-card.json'));
const OPENAPI = JSON.parse(read('public/openapi.json'));
const README = read('README.md');
const LLMS = read('public/llms.txt');
const AGENTS_PAGE = read('public/docs/agents/index.html');
const CHAT = read('api/chat.mjs');

// The README section from `## heading` up to the next `## `.
function section(markdown, heading) {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `README has a "## ${heading}" section`);
  const end = markdown.indexOf('\n## ', start + 1);
  return markdown.slice(start, end < 0 ? undefined : end);
}

// The README keeps one line for a retired tool, marked **Not available**, for
// callers with old configs (tests/alerts-flag.test.mjs); it is not a listing.
const README_LISTED = README.split('\n').filter((l) => !/\*\*Not available\*\*/.test(l)).join('\n');

const LISTINGS = {
  'README.md': README_LISTED,
  'public/llms.txt': LLMS,
  'public/docs/agents/index.html': AGENTS_PAGE,
  'README.md "For agents" (source of /docs/agents)': section(README, 'For agents')
};

const names = (text) => new Set([...text.matchAll(/\b(?:[a-z0-9]+_)+[a-z0-9]+\b/g)].map((m) => m[0]));

function makeRes() {
  return { statusCode: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, end() { return this; } };
}

test('the live tools/list is the default listing, with subscribe_alerts hidden', () => {
  assert.equal(LIVE.length, 20);
  assert.ok(!LIVE.includes('subscribe_alerts'));
  assert.deepEqual(HIDDEN, ['subscribe_alerts']);
});

test('one version everywhere: server.json, agent card, OpenAPI, MCP and A2A', async () => {
  const version = SERVER.version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(CARD.version, version, 'agent card');
  assert.equal(OPENAPI.info.version, version, 'openapi.json');

  const init = makeRes();
  await mcpHandler({ method: 'POST', headers: {}, query: {}, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 't', version: '1' } } } }, init);
  assert.equal(init.body.result.serverInfo.version, version, 'MCP initialize serverInfo');
  const mcpGet = makeRes();
  await mcpHandler({ method: 'GET', headers: {}, query: {} }, mcpGet);
  assert.equal(mcpGet.body.version, version, 'GET /api/mcp');
  const a2aGet = makeRes();
  await a2aHandler({ method: 'GET', headers: {}, query: {} }, a2aGet);
  assert.equal(a2aGet.body.version, version, 'GET /api/a2a');
});

test('server.json carries no tool list of its own and names no hidden tool', () => {
  assert.equal(SERVER.tools, undefined, 'the registry entry has no tools field to drift');
  for (const hidden of HIDDEN) assert.ok(!JSON.stringify(SERVER).includes(hidden), `server.json names ${hidden}`);
  assert.equal(SERVER.remotes[0].url, 'https://pg1-ai-agent.vercel.app/api/mcp');
});

test('the README tools table is exactly the live tools/list', () => {
  const table = section(README, 'All Available MCP Tools').split('\n').filter((l) => /^\| `[a-z0-9_]+` \|/.test(l));
  const rows = table.map((l) => l.match(/^\| `([a-z0-9_]+)` \|/)[1]);
  assert.deepEqual([...rows].sort(), [...LIVE].sort());
  assert.equal(new Set(rows).size, rows.length, 'no tool listed twice');
});

for (const [name, text] of Object.entries(LISTINGS)) {
  test(`${name}: every live tool named, no hidden tool named`, () => {
    const found = names(text);
    assert.deepEqual(LIVE.filter((t) => !found.has(t)), [], 'live tools missing');
    assert.deepEqual(HIDDEN.filter((t) => found.has(t)), [], 'hidden tools named');
  });

  test(`${name}: any tool count stated is the live count`, () => {
    for (const m of text.matchAll(/(\d+) (?:MCP )?tools\b/g)) assert.equal(Number(m[1]), LIVE.length, `"${m[0]}"`);
  });
}

test("the chat's self-description: live tools named, hidden ones not, the live count", () => {
  const start = CHAT.indexOf('- Public services PG1 runs');
  assert.ok(start >= 0);
  const line = CHAT.slice(start, CHAT.indexOf('\n', start));
  const found = names(line);
  assert.deepEqual(LIVE.filter((t) => !found.has(t)), []);
  assert.deepEqual(HIDDEN.filter((t) => found.has(t)), []);
  assert.match(line, new RegExp(`with ${LIVE.length} tools`));
});

test('the agent card: tool skills are exactly the live A2A skills, every one a live MCP tool', () => {
  const extra = (id) => id === JOB_SKILL || id === 'build_tool' || id.startsWith('job.');
  const toolSkills = CARD.skills.map((s) => s.id).filter((id) => !extra(id));
  assert.deepEqual([...toolSkills].sort(), A2A_SKILL_TOOLS.map((t) => t.name).sort());
  assert.deepEqual(toolSkills.filter((id) => !LIVE.includes(id)), [], 'a card skill that is not in tools/list');
  const found = names(CARD.description);
  assert.deepEqual(toolSkills.filter((id) => !found.has(id) && !/^get_cve_|^get_threat_actor/.test(id)), [], 'description leaves a skill out');
  assert.deepEqual(HIDDEN.filter((t) => JSON.stringify(CARD).includes(t)), []);
});

test('while the feed is free, every listing says so and names NVD as its only source', () => {
  assert.equal(isFeedPaid({}), false, 'the default deployment serves the feed free');
  const feedDescription = listedTools({}).find((t) => t.name === 'get_threat_indicators').description;
  assert.match(feedDescription, /NVD/);
  assert.match(feedDescription, /FREE while/);
  const outsideSourceSwitches = README.replace(section(README, 'All Available MCP Tools').split('### Data source switches')[1].split('\n## ')[0], '');
  for (const [name, text] of Object.entries({ ...LISTINGS, 'README.md': outsideSourceSwitches, 'agent card': CARD.description })) {
    assert.match(text, /NVD/, `${name} names NVD`);
    assert.match(text, /free while (?:it|the feed) holds no current data/i, `${name} says the feed is free`);
    assert.doesNotMatch(text, /402 paywall|ThreatFox|URLhaus|AlienVault|\bOTX\b|abuse\.ch/, `${name} describes a paid or non-NVD feed`);
  }
});
