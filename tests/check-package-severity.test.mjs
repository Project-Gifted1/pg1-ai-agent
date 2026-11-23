/**
 * check_package 1.24.0: known vulnerabilities by severity. Fixtures only, no
 * network (the result builder and the OSV summary are called directly).
 *   - lodash@4.17.21 with the three advisories of the 3 Nov 2026 evidence
 *     (GHSA-r5fr-rjxr-66jc HIGH, two MODERATE): flagged, with
 *     PACKAGE_KNOWN_VULNERABILITIES_HIGH, highest_severity HIGH and
 *     vulnerability_count 3 (it read "no_flags" before);
 *   - MODERATE only: no_flags, PACKAGE_KNOWN_VULNERABILITIES kept, and the
 *     summary sentence;
 *   - CVSS v3.1 and v4.0 vectors parsed to base scores; a score decides
 *     over a label; an unknown severity is mentioned, never flags alone;
 *   - fixed_version_suggestion: the lowest version fixing every advisory;
 *   - never "safe" or "clean".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeOsvVulns, buildPackageResult, firstFixedVersion, compareVersions, severityOf, levelForScore } from '../lib/packageCheck.mjs';
import { cvssBaseScore, severityForScore } from '../lib/cvss.mjs';
import { REASON_CODES, INFORMATIONAL_REASON_CODES } from '../lib/reasonCodes.mjs';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const LODASH = JSON.parse(readFileSync(new URL('./fixtures/osv-lodash-4.17.21.json', import.meta.url), 'utf8'));
const registry = (name, versions = ['4.17.20', '4.17.21']) => ({ result: 'ok', fetchedAt: '2026-11-23T11:59:00Z', cached: false, data: { exists: true, canonical_name: name, versions, latest_version: versions.at(-1), latest_published: '2021-02-20T15:42:16Z', first_published: '2012-04-23T16:37:11Z', deprecated: {}, install_scripts: {} } });
function check({ name = 'lodash', version = '4.17.21', vulns }) {
  const scope = { ecosystem: 'npm', name, version };
  const osv = { result: 'ok', fetchedAt: '2026-11-23T11:59:00Z', cached: false, ...summarizeOsvVulns(vulns, scope) };
  return buildPackageResult({ ecosystem: 'npm', name, lookupName: name, version }, { registry: registry(name), osv, osvScope: 'version', lookalike: null, nowMs: NOW });
}
const codes = (r) => r.reasons.map((x) => x.code);
const range = (introduced, fixed) => [{ package: { ecosystem: 'npm', name: 'pg1-synthetic' }, ranges: [{ type: 'SEMVER', events: [{ introduced }, ...(fixed ? [{ fixed }] : [])] }] }];

test('lodash@4.17.21 (the 3 Nov evidence): flagged, PACKAGE_KNOWN_VULNERABILITIES_HIGH, highest HIGH, 3 vulnerabilities', () => {
  const r = check({ vulns: LODASH.vulns });
  assert.equal(r.status, 'flagged');
  assert.deepEqual(codes(r), ['PACKAGE_KNOWN_VULNERABILITIES_HIGH', 'PACKAGE_KNOWN_VULNERABILITIES']);
  assert.equal(r.highest_severity, 'HIGH');
  assert.equal(r.vulnerability_count, 3);
  assert.deepEqual(r.vulnerabilities.map((v) => [v.id, v.severity, v.severity_level]), [
    ['GHSA-f23m-r3pf-42rh', 'MODERATE', 'MODERATE'],
    ['GHSA-r5fr-rjxr-66jc', 'HIGH', 'HIGH'],
    ['GHSA-xxjr-mmjv-4gpg', 'MODERATE', 'MODERATE']
  ]);
  assert.match(r.reasons[0].message, /1 known vulnerability of severity HIGH or CRITICAL \(GHSA-r5fr-rjxr-66jc HIGH\)/);
  assert.equal(r.fixed_version_suggestion, null, 'the fixture lists no fixed versions, so none is suggested');
  assert.equal(r.summary, 'flagged: 3 known vulnerabilities, highest HIGH; no fixed version is listed for every advisory');
  assert.ok(!/\b(safe|clean)\b/i.test(JSON.stringify(r)));
});

test('the new reason code flags; the old one stays informational', () => {
  assert.ok(REASON_CODES.PACKAGE_KNOWN_VULNERABILITIES_HIGH);
  assert.match(REASON_CODES.PACKAGE_KNOWN_VULNERABILITIES_HIGH, /HIGH or CRITICAL/);
  assert.ok(!INFORMATIONAL_REASON_CODES.includes('PACKAGE_KNOWN_VULNERABILITIES_HIGH'));
  assert.ok(INFORMATIONAL_REASON_CODES.includes('PACKAGE_KNOWN_VULNERABILITIES'));
});

test('MODERATE only: no_flags, the reason kept, and the summary says so with the fix to consider', () => {
  const vulns = [
    { id: 'GHSA-1111-2222-3333', database_specific: { severity: 'MODERATE' }, affected: range('0', '4.17.23') },
    { id: 'GHSA-4444-5555-6666', database_specific: { severity: 'LOW' }, affected: range('4.0.0', '4.17.22') }
  ];
  const r = check({ name: 'pg1-synthetic', vulns });
  assert.equal(r.status, 'no_flags');
  assert.deepEqual(codes(r), ['PACKAGE_KNOWN_VULNERABILITIES']);
  assert.equal(r.highest_severity, 'MODERATE');
  assert.equal(r.vulnerability_count, 2);
  assert.equal(r.fixed_version_suggestion, '4.17.23');
  assert.equal(r.summary, 'no_flags: 2 known vulnerabilities, highest MODERATE; consider 4.17.23 if available');
  assert.ok(!/\b(safe|clean)\b/i.test(JSON.stringify(r)));
});

test('CVSS vectors: v3.1 and v4.0 base scores; the score decides over a label', () => {
  assert.deepEqual(cvssBaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), { version: '3.1', score: 9.8 });
  assert.deepEqual(cvssBaseScore('CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N'), { version: '3.1', score: 5.9 });
  assert.deepEqual(cvssBaseScore('CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:L/A:N'), { version: '3.1', score: 6.4 });
  assert.deepEqual(cvssBaseScore('CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H'), { version: '3.0', score: 7.8 });
  assert.deepEqual(cvssBaseScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'), { version: '4.0', score: 9.3 });
  assert.deepEqual(cvssBaseScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:H/SC:N/SI:N/SA:N'), { version: '4.0', score: 8.7 });
  assert.deepEqual(cvssBaseScore('CVSS:4.0/AV:L/AC:L/AT:N/PR:L/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'), { version: '4.0', score: 8.5 });
  assert.equal(cvssBaseScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N').score, 0);
  for (const bad of ['', 'CVSS:3.1/AV:N', 'CVSS:3.1/AV:Q/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 'CVSS:2.0/AV:N/AC:L/Au:N/C:P/I:P/A:P', 'CVSS:4.0/AV:N/AC:L', 'not a vector']) assert.equal(cvssBaseScore(bad), null, bad);
  assert.equal(levelForScore(7.0), 'HIGH'); assert.equal(levelForScore(6.9), 'MODERATE'); assert.equal(levelForScore(9.0), 'CRITICAL'); assert.equal(levelForScore(3.9), 'LOW');
  assert.equal(severityForScore(7), 'HIGH');
  // A HIGH score under a MODERATE label: the score decides, and it flags.
  const s = severityOf({ id: 'GHSA-x', database_specific: { severity: 'MODERATE' }, severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N' }] });
  assert.equal(s.cvss_score, 7.5); assert.equal(s.severity_level, 'HIGH'); assert.equal(s.severity, 'MODERATE', 'the label is kept as given');
  const r = check({ name: 'pg1-synthetic', vulns: [{ id: 'GHSA-x', database_specific: { severity: 'MODERATE' }, severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N' }] }] });
  assert.equal(r.status, 'flagged'); assert.equal(r.highest_severity, 'CRITICAL');
  // A label alone (no score): HIGH or CRITICAL flags.
  assert.equal(check({ name: 'pg1-synthetic', vulns: [{ id: 'GHSA-y', database_specific: { severity: 'CRITICAL' } }] }).status, 'flagged');
  assert.equal(severityOf({ database_specific: { severity: 'medium' } }).severity_level, 'MODERATE');
});

test('unknown severity: mentioned, never flags on its own', () => {
  const r = check({ name: 'pg1-synthetic', vulns: [{ id: 'PYSEC-2026-9', database_specific: { severity: 'bogus' } }, { id: 'GHSA-zzzz-zzzz-zzzz', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:X' }] }] });
  assert.equal(r.status, 'no_flags');
  assert.equal(r.highest_severity, null);
  assert.equal(r.vulnerability_count, 2);
  assert.match(r.reasons[0].message, /2 known vulnerabilities in the advisory databases checked, highest of unknown severity \(2 of unknown severity\)/);
  assert.equal(r.summary, 'no_flags: 2 known vulnerabilities, highest unknown; no fixed version is listed for every advisory');
  const mixed = check({ name: 'pg1-synthetic', vulns: [{ id: 'GHSA-a', database_specific: { severity: 'LOW' } }, { id: 'GHSA-b' }] });
  assert.equal(mixed.status, 'no_flags');
  assert.match(mixed.summary, /highest LOW \(1 of unknown severity\)/);
});

test('fixed_version_suggestion: the lowest version that fixes every listed advisory, else null', () => {
  const vulns = [
    { id: 'GHSA-a', database_specific: { severity: 'LOW' }, affected: range('0', '4.17.12') },
    { id: 'GHSA-b', database_specific: { severity: 'MODERATE' }, affected: [{ package: { ecosystem: 'npm', name: 'pg1-synthetic' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '3.10.0' }, { introduced: '4.0.0' }, { fixed: '4.17.22' }] }] }] },
    { id: 'GHSA-c', database_specific: { severity: 'LOW' }, affected: range('4.17.0', '4.17.21') }
  ];
  const r = check({ name: 'pg1-synthetic', version: '4.17.20', vulns });
  // GHSA-a's only fix (4.17.12) is older than the version checked: no fix after it.
  assert.deepEqual(r.vulnerabilities.map((v) => [v.id, v.fixed_version]), [['GHSA-a', null], ['GHSA-b', '4.17.22'], ['GHSA-c', '4.17.21']]);
  assert.equal(r.fixed_version_suggestion, null, 'GHSA-a lists no fix after 4.17.20');
  const all = check({ name: 'pg1-synthetic', version: '4.17.20', vulns: vulns.slice(1) });
  assert.equal(all.fixed_version_suggestion, '4.17.22');
  assert.equal(firstFixedVersion(vulns[1], { ecosystem: 'npm', name: 'pg1-synthetic', version: '3.5.0' }), '3.10.0');
  assert.equal(firstFixedVersion(vulns[1], { ecosystem: 'npm', name: 'other-package', version: '3.5.0' }), null, 'only this package\'s ranges');
  assert.equal(firstFixedVersion(vulns[1], { ecosystem: 'pypi', name: 'pg1-synthetic', version: '3.5.0' }), null, 'only this ecosystem');
  assert.ok(compareVersions('4.17.10', '4.17.9') > 0);
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0);
  assert.ok(compareVersions('2.0', '2.0.0') === 0);
  assert.ok(compareVersions('1.0.post1', '1.0') > 0);
});
