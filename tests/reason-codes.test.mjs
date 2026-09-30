/**
 * Tests for lib/reasonCodes.mjs (issue #215, buyer-experience upgrade part A).
 *
 * Reason codes are permanent once shipped: a code can be added, but never
 * removed or renamed, since callers may already be matching on it. This
 * pins the current code list so any future removal/rename fails loudly
 * here instead of silently breaking a caller. Also checks the two textual
 * rules that apply to every code's message: never "safe", never a vendor
 * name.
 *
 * Run with: node --test tests/reason-codes.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REASON_CODES, reason } from '../lib/reasonCodes.mjs';

// The permanent set, as of issue #215. Add new codes freely; never remove or
// rename one of these without updating every caller first.
const PERMANENT_CODES = [
  'WALLET_SANCTIONED',
  'DOMAIN_NEWLY_REGISTERED_30D',
  'HOSTNAME_PHISHING_LISTED',
  'HOSTNAME_LOOKALIKE',
  'WALLET_NO_HISTORY',
  'WALLET_AGE_PARTIAL',
  'CVE_KNOWN_EXPLOITED_KEV',
  'IOC_FOUND_IN_THREAT_FEED'
];

test('every permanent reason code is still present, unrenamed', () => {
  for (const code of PERMANENT_CODES) {
    assert.ok(code in REASON_CODES, `reason code '${code}' was removed or renamed - codes are permanent, see lib/reasonCodes.mjs`);
    assert.equal(typeof REASON_CODES[code], 'string');
    assert.ok(REASON_CODES[code].length > 0);
  }
});

test('REASON_CODES is frozen and codes are UPPER_SNAKE_CASE', () => {
  assert.ok(Object.isFrozen(REASON_CODES));
  for (const code of Object.keys(REASON_CODES)) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/, `'${code}' must be UPPER_SNAKE_CASE`);
  }
});

test('no message ever uses the word "safe" or names a vendor', () => {
  const VENDOR_NAMES = ['OFAC', 'Chainalysis', 'VirusTotal', 'Google Safe Browsing', 'Shodan'];
  for (const [code, message] of Object.entries(REASON_CODES)) {
    assert.ok(!/\bsafe\b/i.test(message), `'${code}' message must never use the word "safe": ${message}`);
    for (const vendor of VENDOR_NAMES) {
      assert.ok(!message.includes(vendor), `'${code}' message must never name a vendor ('${vendor}'): ${message}`);
    }
  }
});

test('reason() returns the frozen message by default, or a detail override', () => {
  const entry = reason('WALLET_NO_HISTORY');
  assert.deepEqual(entry, { code: 'WALLET_NO_HISTORY', message: REASON_CODES.WALLET_NO_HISTORY });

  const withDetail = reason('WALLET_NO_HISTORY', '3 matching indicators found.');
  assert.deepEqual(withDetail, { code: 'WALLET_NO_HISTORY', message: '3 matching indicators found.' });
});

test('reason() throws on an unknown code instead of silently accepting it', () => {
  assert.throws(() => reason('NOT_A_REAL_CODE'), /Unknown reason code/);
});

test('check_wallet_age codes describe facts only, never an age threshold judgement', () => {
  // check_wallet_age has no age threshold anywhere in the code (callers
  // choose their own) - its two codes must read as observations, not
  // verdicts, and must not encode a specific day/age number.
  assert.ok(!/\d+\s*(day|hour|month|year)/i.test(REASON_CODES.WALLET_NO_HISTORY));
  assert.ok(!/\d+\s*(day|hour|month|year)/i.test(REASON_CODES.WALLET_AGE_PARTIAL));
});
