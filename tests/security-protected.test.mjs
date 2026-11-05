/**
 * The sign-in's files are off limits to PG1's own changes:
 *   - the lab may not write any of them (lib/lab/policy.mjs checkCodePath,
 *     its CODE_BLOCKED list);
 *   - the operator loop never auto-merges a PR that touches one
 *     (lib/operator/merge.mjs PROTECTED_PATHS), so a person reviews it.
 * Every file under lib/security/, public/security/, api/security.mjs, the
 * migration, these tests and the helpers that pick the test store or play
 * the passkey are checked by name, so a new file there is covered too.
 * Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { checkCodePath } from '../lib/lab/policy.mjs';
import { PROTECTED_PATHS, SECURITY_PATHS } from '../lib/operator/merge.mjs';

const ROOT = new URL('..', import.meta.url);
const list = (dir, re = /./) => readdirSync(new URL(dir, ROOT)).filter((f) => re.test(f)).map((f) => `${dir}${f}`);

const SECURITY_FILES = [
  ...list('lib/security/'),
  ...list('public/security/'),
  'api/security.mjs',
  'supabase/migrations/20261114120000_pg1_operator_security.sql',
  ...list('tests/', /^security-.*\.test\.mjs$/),
  ...list('tests/browser/', /^security-.*\.test\.mjs$/),
  'tests/helpers/security-store.mjs',
  'tests/helpers/softAuthenticator.mjs',
  'tests/helpers/spend-cap.mjs'
];

test('the sign-in files exist as listed', () => {
  for (const f of ['lib/security/auth.mjs', 'lib/security/webauthn.mjs', 'lib/security/cbor.mjs', 'lib/security/sessions.mjs', 'lib/security/store.mjs', 'lib/security/alerts.mjs', 'lib/security/chat.mjs', 'lib/security/compare.mjs', 'public/security/passkey.js']) {
    assert.ok(SECURITY_FILES.includes(f), f);
  }
  assert.ok(SECURITY_FILES.some((f) => f.startsWith('tests/browser/security-')), 'the browser test is listed');
});

test('the lab may not write a sign-in file (CODE_BLOCKED)', () => {
  for (const f of SECURITY_FILES) {
    const r = checkCodePath(f);
    assert.equal(r.ok, false, `${f} is writable by the lab`);
    assert.equal(r.reason, 'blocked path', f);
  }
  // Not by a sibling name either.
  for (const f of ['lib/security/new-helper.mjs', 'public/security/other.js', 'tests/security-extra.test.mjs', 'tests/browser/security-more.browser.test.mjs']) assert.equal(checkCodePath(f).ok, false, f);
  // An ordinary lib file still is writable: the list is not a blanket ban.
  assert.equal(checkCodePath('lib/usageStats.mjs').ok, true);
});

test('the operator loop never auto-merges a change to a sign-in file (PROTECTED_PATHS)', () => {
  for (const f of SECURITY_FILES) {
    assert.ok(PROTECTED_PATHS.some((re) => re.test(f)), `${f} is not protected`);
  }
  for (const re of SECURITY_PATHS) assert.ok(PROTECTED_PATHS.includes(re), String(re));
  // Each file is protected by name, not only by the generic auth|session
  // pattern.
  for (const f of SECURITY_FILES) assert.ok(SECURITY_PATHS.some((re) => re.test(f)), `${f} is not in SECURITY_PATHS`);
});
