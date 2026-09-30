/**
 * Tests for lib/fixtures.mjs (issue #215 part B): every fixture value is a
 * reserved/synthetic value, matching is exact-value only (with only the
 * tool's own normalisation applied), and a near-miss value is never a
 * fixture.
 * Run with: node --test tests/fixtures.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_FIXTURES, FIXTURE_TOOLS, FIXTURE_KINDS, FIXTURE_VALUES, matchFixture } from '../lib/fixtures.mjs';
import { REASON_CODES } from '../lib/reasonCodes.mjs';

const DOC_IPV4_RANGES = ['192.0.2.', '198.51.100.', '203.0.113.'];

test('fixtures: each fixture tool has exactly one FLAGGED, one CLEAN and one UNKNOWN fixture', () => {
  assert.ok(FIXTURE_TOOLS.length > 0);
  for (const tool of FIXTURE_TOOLS) {
    const kinds = TEST_FIXTURES.filter((f) => f.tool === tool).map((f) => f.kind).sort();
    assert.deepEqual(kinds, [...FIXTURE_KINDS].sort(), `${tool} must have one fixture of each kind`);
  }
});

test('fixtures: expected results are FLAGGED=flagged with real reason codes, CLEAN=no_flags, UNKNOWN=unknown', () => {
  for (const f of TEST_FIXTURES) {
    const expectedStatus = { FLAGGED: 'flagged', CLEAN: 'no_flags', UNKNOWN: 'unknown' }[f.kind];
    assert.equal(f.expected.status, expectedStatus, `${f.tool}/${f.kind}`);
    if (f.kind === 'FLAGGED') assert.ok(f.expected.reason_codes.length > 0, `${f.tool}/FLAGGED needs a reason code`);
    else assert.deepEqual(f.expected.reason_codes, []);
    for (const code of f.expected.reason_codes) assert.ok(code in REASON_CODES, `unknown reason code ${code}`);
    assert.equal(typeof f.expected.summary, 'string');
  }
});

test('fixtures: every value is reserved or synthetic', () => {
  for (const d of Object.values(FIXTURE_VALUES.domain)) assert.match(d, /\.invalid$/);
  for (const ip of Object.values(FIXTURE_VALUES.ipv4)) assert.ok(DOC_IPV4_RANGES.some((p) => ip.startsWith(p)), ip);
  for (const ip of Object.values(FIXTURE_VALUES.ipv6)) assert.match(ip, /^2001:db8:/);
  for (const id of Object.values(FIXTURE_VALUES.cve)) assert.match(id, /^CVE-0000-\d{4}$/);
  for (const addr of Object.values(FIXTURE_VALUES.wallet)) {
    assert.match(addr, /^0x[0-9a-f]{40}$/);
    assert.equal(Buffer.from(addr.slice(2, 34), 'hex').toString('ascii'), 'pg1-test-fixture');
  }
  for (const p of Object.values(FIXTURE_VALUES.product)) assert.match(p.vendor, /\.invalid$/);
});

test('fixtures: every fixture matches its own arguments', () => {
  for (const f of TEST_FIXTURES) assert.equal(matchFixture(f.tool, f.arguments), f);
});

test('fixtures: matching applies only the tool\'s own normalisation', () => {
  const w = FIXTURE_VALUES.wallet.FLAGGED;
  assert.equal(matchFixture('check_wallet_age', { address: w.toUpperCase().replace('0X', '0x') })?.kind, 'FLAGGED');
  assert.equal(matchFixture('check_wallet_age', { address: w, chain: 'Ethereum' })?.kind, 'FLAGGED');
  assert.equal(matchFixture('check_wallet_sanctions', { address: `  ${w.toUpperCase().replace('0X', '0x')} ` })?.kind, 'FLAGGED');
  assert.equal(matchFixture('check_hostname_reputation', { hostname: 'PG1-Test-Clean.invalid.' })?.kind, 'CLEAN');
  assert.equal(matchFixture('check_domain_age', { domain: 'https://PG1-test-unknown.invalid/path' })?.kind, 'UNKNOWN');
  assert.equal(matchFixture('get_cve_details', { cve_id: 'cve-0000-0001' })?.kind, 'FLAGGED');
  assert.equal(matchFixture('get_cve_batch', { cve_ids: ['cve-0000-0002'] })?.kind, 'CLEAN');
});

test('fixtures: a near-miss value (one character off) is never a fixture', () => {
  const w = FIXTURE_VALUES.wallet.FLAGGED;
  const nearWallet = w.slice(0, -1) + '4';
  assert.equal(matchFixture('check_wallet_sanctions', { address: nearWallet }), null);
  assert.equal(matchFixture('check_wallet_age', { address: nearWallet }), null);
  assert.equal(matchFixture('check_domain_age', { domain: 'pg1-test-flaged.invalid' }), null);
  assert.equal(matchFixture('check_hostname_reputation', { hostname: 'pg1-test-flagged.invalie' }), null);
  // A subdomain is a different hostname for check_hostname_reputation.
  assert.equal(matchFixture('check_hostname_reputation', { hostname: 'www.pg1-test-flagged.invalid' }), null);
  assert.equal(matchFixture('get_ioc_context', { value: '192.0.2.2' }), null);
  assert.equal(matchFixture('get_ioc_batch', { values: ['2001:db8::4'] }), null);
  assert.equal(matchFixture('get_ioc_batch', { values: ['2001:db8::1', '2001:db8::2'] }), null);
  assert.equal(matchFixture('get_cve_details', { cve_id: 'CVE-0000-0004' }), null);
  assert.equal(matchFixture('get_cve_batch', { cve_ids: ['CVE-0000-0001', 'CVE-0000-0002'] }), null);
  assert.equal(matchFixture('get_cve_by_product', { vendor: 'pg1-test.invalid', product: 'flagge' }), null);
  // get_cve_by_product doesn't normalise case itself, so neither does the fixture match.
  assert.equal(matchFixture('get_cve_by_product', { vendor: 'PG1-test.invalid', product: 'flagged' }), null);
});

test('fixtures: an input the tool would reject is never a fixture', () => {
  assert.equal(matchFixture('check_wallet_age', { address: FIXTURE_VALUES.wallet.FLAGGED, chain: 'solana' }), null);
  assert.equal(matchFixture('check_wallet_age', { address: 123 }), null);
  assert.equal(matchFixture('get_ioc_context', {}), null);
  assert.equal(matchFixture('get_usage_status', {}), null);
  assert.equal(matchFixture('no_such_tool', { value: '192.0.2.1' }), null);
});
