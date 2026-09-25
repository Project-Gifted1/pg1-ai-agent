/**
 * Tests for lib/walletAddress.mjs — isRecognizedWalletAddress()
 * Run with: node --test tests/wallet-address-validation.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRecognizedWalletAddress } from '../lib/walletAddress.mjs';

test('accepts an EVM address (ETH/USDT-ERC20/USDC-ERC20)', () => {
  assert.equal(isRecognizedWalletAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1'), true);
  assert.equal(isRecognizedWalletAddress('0x' + '0'.repeat(40)), true);
});

test('accepts BTC/XBT legacy and P2SH base58 addresses', () => {
  assert.equal(isRecognizedWalletAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), true);
  assert.equal(isRecognizedWalletAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'), true);
});

test('accepts BTC/LTC bech32 (segwit/taproot) addresses', () => {
  assert.equal(isRecognizedWalletAddress('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'), true);
  assert.equal(isRecognizedWalletAddress('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'), true);
  assert.equal(isRecognizedWalletAddress('ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7tjthvr'), true);
});

test('accepts LTC/DOGE/DASH base58 addresses', () => {
  assert.equal(isRecognizedWalletAddress('LaMT348PWRnrqeeWArpwQPbuanpXDZGEUz'), true);
  assert.equal(isRecognizedWalletAddress('DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L'), true);
  assert.equal(isRecognizedWalletAddress('XjSD8z2ZKQ6ZzZ8zj8QpqQpqQpqQpqQpqQ'), true);
});

test('accepts BCH CashAddr format (with and without prefix)', () => {
  assert.equal(isRecognizedWalletAddress('qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'), true);
  assert.equal(isRecognizedWalletAddress('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'), true);
});

test('accepts ZEC transparent and shielded addresses', () => {
  assert.equal(isRecognizedWalletAddress('t1KctSZ9nDeCoJ23xPQ8HirW6YQ4rSjWvo9'), true);
  assert.equal(
    isRecognizedWalletAddress('zcWGguu4sMpBoUwGdkx4pVhjrkKhWtxYcQincmfR8yUABTVe9FBznsUuFEPzeCUxdCbupPHFxUZ1NUTpVJyxTr3Y6zzr7Er'),
    true
  );
});

test('accepts TRON T-addresses (TRX/USDT-TRC20)', () => {
  assert.equal(isRecognizedWalletAddress('TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'), true);
});

test('accepts Monero standard addresses (XMR)', () => {
  assert.equal(
    isRecognizedWalletAddress('48daf1rG3hE1Txapcsxh6WXNe9G8pkuVNXPYSsYFhrNqYSaXPvNZeC8HHECEHtcNCJPXCwvVFdVa1QCqFdc4kUgWiuxwmpm'),
    true
  );
});

test('accepts Solana base58 addresses (SOL/USDC-SPL)', () => {
  assert.equal(isRecognizedWalletAddress('7v91N7iZ9mNicL8WfG6cgSCKyRXydQjLh6UYBWwm6y1Q'), true);
});

test('rejects an unrecognisable string', () => {
  assert.equal(isRecognizedWalletAddress('hello'), false);
});

test('rejects an empty or whitespace-only string', () => {
  assert.equal(isRecognizedWalletAddress(''), false);
  assert.equal(isRecognizedWalletAddress('   '), false);
});

test('rejects nullish input', () => {
  assert.equal(isRecognizedWalletAddress(undefined), false);
  assert.equal(isRecognizedWalletAddress(null), false);
});

test('rejects a 0x address with the wrong hex length', () => {
  assert.equal(isRecognizedWalletAddress('0x1234'), false);
  assert.equal(isRecognizedWalletAddress('0x' + 'a'.repeat(39)), false);
  assert.equal(isRecognizedWalletAddress('0x' + 'a'.repeat(41)), false);
});

test('rejects base58 strings containing disallowed characters (0, O, I, l)', () => {
  assert.equal(isRecognizedWalletAddress('10BvBMSEYstWetqTFn5Au4m4GFg7xJaN'), false);
});
