/**
 * Tests for lib/walletAddress.mjs — normalizeWalletAddress()
 * Run with: node --test tests/wallet-address-normalization.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWalletAddress } from '../lib/walletAddress.mjs';

test('lowercases 0x-prefixed EVM addresses', () => {
  assert.equal(
    normalizeWalletAddress('0xABCDEF1234567890abcdef1234567890ABCDEF12'),
    '0xabcdef1234567890abcdef1234567890abcdef12'
  );
});

test('lowercases bc1 bech32 addresses', () => {
  assert.equal(
    normalizeWalletAddress('BC1QXY2KGDYGJRSQTZQ2N0YRF2493P83KKFJHX0WLH'),
    'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
  );
});

test('lowercases tb1/bcrt1/ltc1/tltc1/rltc1 bech32 addresses', () => {
  assert.equal(normalizeWalletAddress('TB1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4'), 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  assert.equal(normalizeWalletAddress('BCRT1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KJ6R23'), 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kj6r23');
  assert.equal(normalizeWalletAddress('LTC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7TJTHVR'), 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7tjthvr');
  assert.equal(normalizeWalletAddress('TLTC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW76KEFXK'), 'tltc1qw508d6qejxtdg4y5r3zarvary0c5xw76kefxk');
  assert.equal(normalizeWalletAddress('RLTC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7ML6PVW'), 'rltc1qw508d6qejxtdg4y5r3zarvary0c5xw7ml6pvw');
});

test('leaves case-sensitive base58 addresses unchanged', () => {
  const address = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
  assert.equal(normalizeWalletAddress(address), address);
});

test('trims surrounding whitespace', () => {
  assert.equal(normalizeWalletAddress('  0xAA  '), '0xaa');
});

test('handles empty/nullish input without throwing', () => {
  assert.equal(normalizeWalletAddress(''), '');
  assert.equal(normalizeWalletAddress(undefined), '');
  assert.equal(normalizeWalletAddress(null), '');
});
