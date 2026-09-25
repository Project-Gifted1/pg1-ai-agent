/**
 * Tests for api/mcp.mjs — check_wallet_sanctions and check_domain_age
 * tools/call behavior (issue #106): invalid-address MCP tool errors,
 * check_domain_age found/available/reason_code fields.
 * Run with: node --test tests/mcp-tools.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/mcp.mjs';

function makeReq(body) {
  return { method: 'POST', headers: {}, body };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    setHeader() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    }
  };
  return res;
}

async function callTool(name, args) {
  const req = makeReq({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const res = makeRes();
  await handler(req, res);
  return res;
}

test('check_wallet_sanctions: rejects "hello" as invalid_address (isError, no listed field)', async () => {
  const res = await callTool('check_wallet_sanctions', { address: 'hello' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.code, 'invalid_address');
  assert.equal(parsed.listed, undefined);
});

test('check_wallet_sanctions: rejects empty string as invalid_address', async () => {
  const res = await callTool('check_wallet_sanctions', { address: '' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.code, 'invalid_address');
});

test('check_wallet_sanctions: rejects a 0x address with the wrong hex length as invalid_address', async () => {
  const res = await callTool('check_wallet_sanctions', { address: '0x1234' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.code, 'invalid_address');
});

test('check_domain_age: unsupported TLD returns found:false, available:false, reason_code unsupported_tld', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('data.iana.org/rdap/dns.json')) {
      return { ok: true, json: async () => ({ services: [[['com'], ['https://rdap.example/com/']]] }) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const res = await callTool('check_domain_age', { domain: 'example.doesnotexisttld' });
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.found, false);
  assert.equal(parsed.available, false);
  assert.equal(parsed.reason_code, 'unsupported_tld');
  assert.equal(res.body.result.structuredContent.reason_code, 'unsupported_tld');
});

test('check_domain_age: successful RDAP lookup returns found:true and available:true', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('data.iana.org/rdap/dns.json')) {
      return { ok: true, json: async () => ({ services: [[['com'], ['https://rdap.example/com/']]] }) };
    }
    if (String(url).startsWith('https://rdap.example/com/domain/')) {
      return {
        ok: true,
        json: async () => ({
          events: [
            { eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' },
            { eventAction: 'expiration', eventDate: '2030-01-01T00:00:00Z' }
          ],
          entities: []
        })
      };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const res = await callTool('check_domain_age', { domain: 'example.com' });
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body.result.content[0].text);
  assert.equal(parsed.found, true);
  assert.equal(parsed.available, true);
  assert.equal(parsed.reason_code, undefined);
  assert.equal(res.body.result.structuredContent.found, true);
});
