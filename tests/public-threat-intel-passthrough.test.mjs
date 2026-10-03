/**
 * Public threat-intel data is never withheld.
 *
 * The reply secret guard (lib/secretGuard.mjs) runs on every chat reply, and
 * the trace and result cards (#243) go through redactTraceText. PG1's
 * normal output is full of long, random-looking public values: wallet
 * addresses (EIP-55 mixed case), EIP-7702 delegate addresses, tx hashes,
 * MD5/SHA-1/SHA-256 file hashes, CVE IDs, defanged URLs and domains (a
 * phishing URL with a fake login in it too) and base64 IOC payloads. These
 * tests pin that all of them pass through untouched: in a normal reply
 * (JSON and streamed), in a check_wallet_age result card with a delegation
 * (the card, its raw JSON, the trace row and what the model reads back), on
 * a "what's broken?" turn, and in a reply to an attached image. Only real
 * secrets are withheld: provider key formats, JWTs, private keys and the
 * deployment's own env values.
 *
 * Run with: node --test tests/public-threat-intel-passthrough.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { createSseParser, redactTraceText } from '../lib/chatStream.mjs';
import { createReplySecretGuard, SECRET_WITHHELD, SECRET_WITHHELD_NOTE } from '../lib/secretGuard.mjs';
import { redactLeakedSecrets } from '../lib/visionInput.mjs';
import { secretEnvValues } from '../lib/handoff.mjs';
import { FAKE } from './fixtures/fake-secrets.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

// vitalik.eth, EIP-55 checksummed.
const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
// An EIP-7702 delegate (lowercase, as check_wallet_age reports it).
const DELEGATE = '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b';
// PG1's x402 payTo address.
const PAY_TO = '0x897583A6da146826ecA90e5c24158bC226C29d53';
const TX_HASH = '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060';
const SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
const MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
const CVE = 'CVE-2024-3094';
const DEFANGED_URL = 'hxxps://wallet-connect-secure[.]example[.]com/claim?id=42';
const DEFANGED_PHISH = 'hxxp://paypal.com:signin@login-verify[.]example';
const DEFANGED_DOMAIN = 'wallet-connect-secure[.]example[.]com';
const B64_PAYLOAD = 'cG93ZXJzaGVsbCAtbm9wIC13IGhpZGRlbiAtZW5jIEpBQmpBRDBBYmdCbEFIY0FMUUJ2QUdJQQ==';
const SOLANA = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';

const PUBLIC_VALUES = { VITALIK, DELEGATE, PAY_TO, TX_HASH, SHA256, SHA1, MD5, CVE, DEFANGED_URL, DEFANGED_PHISH, DEFANGED_DOMAIN, B64_PAYLOAD, SOLANA };

const IOC_REPLY = [
  `Wallet ${VITALIK} (vitalik.eth) is about 10 years old on base and has an EIP-7702 delegation to ${DELEGATE}.`,
  `PG1's payTo address is ${PAY_TO}.`,
  `The transaction ${TX_HASH} sent funds to it.`,
  `The dropper has SHA-256 ${SHA256}, SHA-1 ${SHA1} and MD5 ${MD5}.`,
  `It exploits ${CVE} (the xz backdoor).`,
  `It phones home to ${DEFANGED_URL} and ${DEFANGED_PHISH}; block ${DEFANGED_DOMAIN}.`,
  `The decoded stage is base64 ${B64_PAYLOAD}.`,
  `A related Solana wallet is ${SOLANA}.`
].join('\n');

// A realistic deployment: real secrets set under the names the server reads,
// and the public payTo address in its own env var.
function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  for (const k of Object.keys(process.env)) {
    if (/^(GEMINI|CARTESIA|REPLICATE|ANTHROPIC|ANTROPIC|OPENAI|GITHUB|SUPABASE|USER_API|VERCEL|PG1_|ALCHEMY|X402)/.test(k)) delete process.env[k];
  }
  process.env.USER_API_KEY = 'test-operator';
  process.env.USER_API_PASS = 'test-secret-pass';
  process.env.GEMINI_API_KEY = FAKE.googleKey;
  process.env.ANTHROPIC_API_KEY = FAKE.anthropicKey;
  process.env.CARTESIA_API_KEY = FAKE.longToken;
  process.env.GITHUB_TOKEN = FAKE.githubPat;
  process.env.ALCHEMY_API_KEY = FAKE.envSecretValue + '-alchemy-0001';
  process.env.X402_PAY_TO_ADDRESS = PAY_TO;
}

beforeEach(() => {
  resetEnv();
  __clearAuthRateLimitState();
});

after(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

let ipSeq = 0;
const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.66.0.${++ipSeq}` }, body });
const authed = (extra) => ({ user: 'test-operator', pass: 'test-secret-pass', ...extra });

function makeRes() {
  const listeners = {};
  return {
    statusCode: null, headers: {}, chunks: [], body: null,
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    write(c) { this.chunks.push(String(c)); return true; },
    end() { return this; },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }
  };
}

function eventsOf(res) {
  const out = [];
  const parser = createSseParser(({ data }) => out.push(JSON.parse(data)));
  parser.push(res.chunks.join(''));
  parser.end();
  return out;
}

const streamedText = (events) => events.filter((e) => e.type === 'text').map((e) => e.text).join('');

function assertAllPublicValues(text, where) {
  for (const [name, value] of Object.entries(PUBLIC_VALUES)) {
    assert.ok(text.includes(value), `${where}: ${name} was altered or withheld`);
  }
  assert.ok(!text.includes(SECRET_WITHHELD), `${where}: something was withheld`);
  assert.ok(!text.includes('[removed]'), `${where}: something was removed`);
}

// Gemini, streamed or not: the first request answers with `calls` (if any),
// a request carrying function responses answers with `finalText`.
const geminiText = (text) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
const geminiCalls = (calls) => ({ candidates: [{ content: { parts: calls.map(([name, args]) => ({ functionCall: { name, args }, thoughtSignature: 'sig-' + name })) } }] });

function installFetch({ calls = [], finalText, alchemy }) {
  const seen = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    seen.push({ url: u, body });
    if (u.includes('generativelanguage.googleapis.com')) {
      const hasResponses = (body.contents || []).some((c) => (c.parts || []).some((p) => p.functionResponse));
      const payload = (calls.length && !hasResponses) ? geminiCalls(calls) : geminiText(finalText);
      if (u.includes('streamGenerateContent')) return new Response(`data: ${JSON.stringify(payload)}\n\n`);
      return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
    }
    if (alchemy && u.includes('.g.alchemy.com/v2/')) return alchemy(body);
    throw new Error('Unexpected network call in test: ' + u);
  };
  return seen;
}

// check_wallet_age upstream for vitalik.eth: first seen in 2015, and its
// code is an EIP-7702 delegation designator pointing at DELEGATE.
const DELEGATION_CODE = '0xef0100' + DELEGATE.slice(2);
function vitalikAlchemy(body) {
  const reply = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'Content-Type': 'application/json' } });
  if (body.method === 'eth_getCode') return reply(DELEGATION_CODE);
  if (body.method === 'alchemy_getAssetTransfers') {
    return reply({ transfers: [{ metadata: { blockTimestamp: '2015-08-07T00:00:00.000Z' }, blockNum: '0x1' }] });
  }
  throw new Error('unexpected alchemy method: ' + body.method);
}

// ---------------------------------------------------------------------------
// The detectors themselves.

test('the reply guard leaves every public value untouched, with the deployment\'s real secrets and env names loaded', () => {
  const env = { ...process.env };
  for (const errorSummary of [false, true]) {
    const guard = createReplySecretGuard({ envValues: secretEnvValues(env), env, errorSummary });
    assert.deepEqual(guard(IOC_REPLY), { text: IOC_REPLY, removed: [] }, `errorSummary=${errorSummary}`);
  }
});

test('the trace and card redactor and the image backstop leave every public value untouched too', () => {
  const envValues = secretEnvValues(process.env);
  for (const line of IOC_REPLY.split('\n')) {
    assert.equal(redactTraceText(line, envValues, 1000, { publicData: true }), line);
    assert.deepEqual(redactLeakedSecrets(line, envValues), { text: line, removed: [], redacted: false });
  }
});

test('real secrets are still withheld right next to public values', () => {
  const env = { ...process.env };
  const guard = createReplySecretGuard({ envValues: secretEnvValues(env), env });
  const mixed = `${VITALIK} with ${FAKE.googleKey}, ${FAKE.supabaseJwt}, ${FAKE.privateKeyBlock}, ${FAKE.awsAccessKeyId}, ${process.env.ALCHEMY_API_KEY}, postgres://pg1_fixture:${FAKE.dbPassword}@db.example.invalid:5432/pg1 and ALCHEMY_API_KEY, then ${SHA256}.`;
  const { text } = guard(mixed);
  for (const secret of [FAKE.googleKey, FAKE.supabaseJwt, 'PG1TESTFIXTURE', FAKE.awsAccessKeyId, process.env.ALCHEMY_API_KEY, FAKE.dbPassword, 'ALCHEMY_API_KEY']) {
    assert.ok(!text.includes(secret), `withheld: ${secret.slice(0, 12)}`);
  }
  assert.ok(text.startsWith(VITALIK) && text.includes(SHA256), text);
});

// ---------------------------------------------------------------------------
// A normal reply, end to end.

test('a normal reply full of IOCs reaches the operator untouched (JSON path), with no withheld note', async () => {
  installFetch({ finalText: IOC_REPLY });
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'summarise this incident for me' })), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reply, IOC_REPLY);
  assert.ok(!res.body.reply.includes(SECRET_WITHHELD_NOTE));
});

test('the same reply streamed: every chunk boundary, nothing withheld', async () => {
  installFetch({ finalText: IOC_REPLY });
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'summarise this incident for me', stream: true })), res);
  const events = eventsOf(res);
  assert.equal(streamedText(events), IOC_REPLY);
  assert.equal(events[events.length - 1].type, 'done');
});

test('on a "what\'s broken?" turn, where engine names are swapped, the IOCs still pass untouched', async () => {
  installFetch({ finalText: IOC_REPLY });
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: "what's broken?" })), res);
  assertAllPublicValues(res.body.reply, 'error-summary reply');
  assert.equal(res.body.reply, IOC_REPLY);
});

// ---------------------------------------------------------------------------
// A #243 tool result card: vitalik.eth wallet age with its delegate.

const CARD_FINAL = `vitalik.eth (${VITALIK}) was first seen in 2015 and is delegated to ${DELEGATE} under EIP-7702. For reference, PG1's payTo is ${PAY_TO}; related: tx ${TX_HASH}, SHA-256 ${SHA256}, ${CVE}, ${DEFANGED_URL}.`;

test('streamed: the vitalik.eth wallet-age card, its raw JSON, the trace and the reply keep every address and IOC whole', async () => {
  const seen = installFetch({ calls: [['check_wallet_age', { address: VITALIK }]], finalText: CARD_FINAL, alchemy: vitalikAlchemy });
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'how old is vitalik.eth, 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045?', stream: true })), res);
  const events = eventsOf(res);

  const card = events.find((e) => e.type === 'tool_result');
  assert.ok(card, 'a result card was sent');
  assert.equal(card.tool, 'check_wallet_age');
  const cardJson = JSON.stringify(card);
  assert.ok(!cardJson.includes('[removed]') && !cardJson.includes(SECRET_WITHHELD), cardJson);
  assert.ok(cardJson.toLowerCase().includes(VITALIK.toLowerCase()), 'the wallet address is in the card');
  assert.ok(cardJson.includes(DELEGATE), 'the delegate address is in the card');
  const raw = typeof card.raw === 'string' ? JSON.parse(card.raw) : card.raw;
  assert.equal(raw.delegated, true);
  assert.equal(raw.delegate_address, DELEGATE);

  const traceRows = JSON.stringify(events.filter((e) => e.type === 'step' || e.type === 'step_done'));
  assert.ok(!traceRows.includes('[removed]') && !traceRows.includes(SECRET_WITHHELD), traceRows);

  // What the model read back: the tool result with the delegate whole.
  const answerRound = seen.filter((c) => c.url.includes('generativelanguage.googleapis.com')).pop();
  const fr = answerRound.body.contents.flatMap((c) => c.parts || []).find((p) => p.functionResponse);
  const frJson = JSON.stringify(fr.functionResponse.response);
  assert.ok(frJson.includes(DELEGATE) && frJson.toLowerCase().includes(VITALIK.toLowerCase()), frJson);
  assert.ok(!frJson.includes(SECRET_WITHHELD));
  // ...and never the Alchemy key that fetched it.
  assert.ok(!JSON.stringify(answerRound.body).includes(process.env.ALCHEMY_API_KEY));

  assert.equal(streamedText(events), CARD_FINAL);
});

test('JSON path: the same card in toolResults and the same reply, untouched', async () => {
  installFetch({ calls: [['check_wallet_age', { address: VITALIK }]], finalText: CARD_FINAL, alchemy: vitalikAlchemy });
  const res = makeRes();
  // The operator gives the address with the name, as in the streamed test:
  // an address the model supplied for a name on its own is refused (see
  // tests/chat-tools.test.mjs, ENS).
  await chatHandler(makeReq(authed({ prompt: 'how old is vitalik.eth, 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045?' })), res);
  assert.equal(res.body.reply, CARD_FINAL);
  assert.equal(res.body.toolResults.length, 1);
  const cardJson = JSON.stringify(res.body.toolResults[0]);
  assert.ok(cardJson.includes(DELEGATE) && cardJson.toLowerCase().includes(VITALIK.toLowerCase()), cardJson);
  assert.ok(!cardJson.includes('[removed]') && !cardJson.includes(SECRET_WITHHELD));
});

// ---------------------------------------------------------------------------
// A reply to an attached image (the image backstop also runs).

test('a reply describing a screenshot of IOCs keeps them, while a key in the same screenshot is still replaced', async () => {
  const png = { inlineData: { mimeType: 'image/png', data: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64') } };
  installFetch({ finalText: `${IOC_REPLY}\nThe settings panel also shows ${FAKE.openaiKey}.` });
  const res = makeRes();
  await chatHandler(makeReq(authed({ prompt: 'what is in this screenshot?', multiFiles: [png] })), res);
  assertAllPublicValues(res.body.reply.replace(/\n\n[^\n]*$/, ''), 'image reply');
  assert.ok(res.body.reply.startsWith(IOC_REPLY), 'every IOC line is unchanged');
  assert.ok(!res.body.reply.includes(FAKE.openaiKey), 'the key is replaced');
});
