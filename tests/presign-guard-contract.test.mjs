/**
 * The presign-guard integration (unlimited access, licence key) calls
 * check_wallet_sanctions, check_domain_age, check_hostname_reputation and
 * check_wallet_age. Their contract is frozen at the v1.14.0 release in
 * tests/fixtures/presign-guard-tools-v1.14.0.json, and later releases may
 * only ADD to it:
 *   - the four tool names stay listed;
 *   - every v1.14.0 input property keeps its type and enum, and no input
 *     becomes newly required;
 *   - every v1.14.0 output property keeps its type and enum, and nothing
 *     required in v1.14.0 stops being required;
 *   - a real response (same upstream data as the fixture was recorded with)
 *     still carries every key the v1.14.0 response carried, on /api/mcp
 *     structuredContent and in the /api/a2a artifact alike.
 * A rename, a removal or a narrowed type fails here; a new field does not.
 * Never edit the fixture to make this pass.
 * Run with: node --test tests/presign-guard-contract.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import mcpHandler, { TOOL_DEFINITIONS } from '../api/mcp.mjs';
import a2aHandler from '../api/a2a.mjs';

const FROZEN = JSON.parse(readFileSync(new URL('./fixtures/presign-guard-tools-v1.14.0.json', import.meta.url), 'utf8')).tools;
const TOOL_NAMES = ['check_wallet_sanctions', 'check_domain_age', 'check_hostname_reputation', 'check_wallet_age'];

const asList = (t) => (Array.isArray(t) ? [...t].sort() : [t]);

function assertWidened(path, before, now) {
  assert.ok(now, `${path} was removed`);
  if (before.type !== undefined) {
    const lost = asList(before.type).filter((t) => !asList(now.type).includes(t));
    assert.deepEqual(lost, [], `${path} no longer accepts type(s) ${lost.join(', ')}`);
  }
  if (before.enum !== undefined) {
    assert.ok(Array.isArray(now.enum) || now.enum === undefined, `${path} enum changed shape`);
    if (now.enum) {
      const lost = before.enum.filter((v) => !now.enum.includes(v));
      assert.deepEqual(lost, [], `${path} lost enum value(s) ${lost.join(', ')}`);
    }
  }
  if (before.properties) {
    for (const [k, v] of Object.entries(before.properties)) assertWidened(`${path}.${k}`, v, now.properties?.[k]);
  }
  if (before.items) assertWidened(`${path}[]`, before.items, now.items);
}

test('the four tools are still defined and listed under the same names', () => {
  for (const name of TOOL_NAMES) {
    assert.ok(FROZEN[name], `fixture covers ${name}`);
    assert.ok(TOOL_DEFINITIONS.some((d) => d.name === name), `${name} is still defined`);
  }
});

for (const name of TOOL_NAMES) {
  test(`${name}: input schema only widened since v1.14.0, no newly required input`, () => {
    const now = TOOL_DEFINITIONS.find((d) => d.name === name).inputSchema;
    const before = FROZEN[name].inputSchema;
    assertWidened(`${name}.input`, before, now);
    const newlyRequired = (now.required || []).filter((k) => !(before.required || []).includes(k));
    assert.deepEqual(newlyRequired, [], `${name} now requires ${newlyRequired.join(', ')}`);
  });

  test(`${name}: output schema only added to since v1.14.0`, () => {
    const now = TOOL_DEFINITIONS.find((d) => d.name === name).outputSchema;
    const before = FROZEN[name].outputSchema;
    assertWidened(`${name}.output`, before, now);
    const dropped = (before.required || []).filter((k) => !(now.required || []).includes(k));
    assert.deepEqual(dropped, [], `${name} no longer guarantees ${dropped.join(', ')}`);
  });
}

// The upstream data the fixture's responseKeys were recorded with.
const LISTED = '0x' + '11'.repeat(20);
const DELEGATED = '0x' + '22'.repeat(20);
function withUpstreams(t) {
  const saved = { fetch: global.fetch, env: { ...process.env } };
  Object.assign(process.env, { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ALCHEMY_API_KEY: 'alch' });
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const j = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('sanctioned_wallets?select=updated_at')) return j([{ updated_at: '2026-10-01T00:00:00Z' }]);
    if (u.includes('sanctioned_wallets?address_normalized=')) {
      return j(u.includes(LISTED) ? [{ address: LISTED, address_normalized: LISTED, sdn_name: 'TEST ENTRY', currency: 'ETH', programs: ['CYBER2'], sdn_uid: 123, updated_at: '2026-10-01T00:00:00Z' }] : []);
    }
    if (u.includes('data.iana.org/rdap/dns.json')) return j({ services: [[['com'], ['https://rdap.test/']]] });
    if (u.startsWith('https://rdap.test/domain/')) return j({ events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: '2030-01-01T00:00:00Z' }], entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Reg Inc']]] }] });
    if (u.includes('phishing_list_meta')) return j([{ source: 'eth-phishing-detect', tolerance: 3, synced_at: '2026-10-01T00:00:00Z' }]);
    if (u.includes('phishing_domains?list_type=eq.fuzzylist')) return j([{ domain: 'metamask.io' }]);
    if (u.includes('phishing_domains?domain=in.')) return j(u.includes('evil-drainer.com') ? [{ domain: 'evil-drainer.com', list_type: 'blocklist', source: 'eth-phishing-detect', synced_at: '2026-10-01T00:00:00Z' }] : []);
    if (u.includes('wallet_first_seen')) return opts.method === 'POST' ? j(null, 201) : j([]);
    if (u.includes('alchemy')) {
      const body = JSON.parse(opts.body);
      if (body.method === 'eth_getCode') return j({ jsonrpc: '2.0', id: body.id, result: (body.params[0].toLowerCase() === DELEGATED && body.id !== 3) ? '0xef0100' + 'ab'.repeat(20) : '0x' });
      return j({ jsonrpc: '2.0', id: body.id, result: { transfers: [{ blockNum: '0x10', metadata: { blockTimestamp: '2025-01-01T00:00:00.000Z' } }] } });
    }
    return j({}, 404);
  };
  t.after(() => {
    global.fetch = saved.fetch;
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k];
    Object.assign(process.env, saved.env);
  });
}

function makeRes() {
  return { statusCode: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, end() { return this; } };
}

let ip = 0;
for (const name of TOOL_NAMES) {
  for (const [argsJson, keys] of Object.entries(FROZEN[name].responseKeys)) {
    test(`${name} ${argsJson}: every v1.14.0 response key is still there (mcp and a2a)`, async (t) => {
      withUpstreams(t);
      const args = JSON.parse(argsJson);
      const headers = { 'x-forwarded-for': `198.19.0.${++ip}` };
      const m = makeRes();
      await mcpHandler({ method: 'POST', headers, query: {}, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } }, m);
      const sc = m.body?.result?.structuredContent;
      assert.ok(sc && !m.body.result.isError, `mcp answered: ${JSON.stringify(m.body).slice(0, 300)}`);
      assert.deepEqual(keys.filter((k) => !(k in sc)), [], 'mcp structuredContent lost keys');
      assert.deepEqual(JSON.parse(m.body.result.content[0].text), sc, 'content[0].text mirrors structuredContent');

      const a = makeRes();
      await a2aHandler({ method: 'POST', headers, query: {}, body: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: 'm', parts: [{ kind: 'data', data: { skill: name, arguments: args } }] } } } }, a);
      const data = a.body?.result?.artifacts?.[0]?.parts?.[0]?.data;
      assert.ok(data, `a2a answered: ${JSON.stringify(a.body).slice(0, 300)}`);
      assert.deepEqual(keys.filter((k) => !(k in data)), [], 'a2a artifact lost keys');
    });
  }
}
