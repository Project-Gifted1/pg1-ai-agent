/**
 * Tests for lib/domainExtraction.mjs — extractRegistrableDomain()
 * Run with: node --test tests/domain-extraction.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRegistrableDomain } from '../lib/domainExtraction.mjs';

test('extracts the registrable domain from a bare domain', () => {
  assert.equal(extractRegistrableDomain('example.com'), 'example.com');
});

test('extracts the registrable domain from a subdomain', () => {
  assert.equal(extractRegistrableDomain('sub.example.com'), 'example.com');
});

test('extracts the registrable domain from a full URL with path/query', () => {
  assert.equal(extractRegistrableDomain('https://sub.example.co.uk/path?x=1'), 'example.co.uk');
});

test('is public-suffix-aware for multi-part TLDs', () => {
  assert.equal(extractRegistrableDomain('www.example.co.uk'), 'example.co.uk');
});

test('trims surrounding whitespace', () => {
  assert.equal(extractRegistrableDomain('  example.com  '), 'example.com');
});

test('returns null for input with no valid registrable domain', () => {
  assert.equal(extractRegistrableDomain('not a valid domain !!'), null);
});

test('returns null for empty/nullish input', () => {
  assert.equal(extractRegistrableDomain(''), null);
  assert.equal(extractRegistrableDomain(undefined), null);
  assert.equal(extractRegistrableDomain(null), null);
});
