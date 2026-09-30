/**
 * Issue #201 Phase 2 — error log + Suggest Fix:
 *  - logError()/getErrorLog() (public/index.html) persist a capped,
 *    most-recent-first log to localStorage.
 *  - flashStatus() logs an entry whenever it flashes a genuine error
 *    (isError !== false), and never logs anything for a non-error flash.
 *  - The silent voice-profile fallback in api/chat.mjs never calls
 *    flashStatus() at all (see voice-profile-and-library.test.mjs), so by
 *    construction it can never reach the error log either — this suite
 *    documents that contract from the client side of it.
 *  - extractPatchActionFromReply() only recognizes a well-formed
 *    APPLY_SURGICAL_PATCH JSON block, so an ordinary reply that merely
 *    mentions or contains unrelated JSON is never mistaken for one.
 *
 * These extract the exact shipped function source from public/index.html
 * (rather than re-implementing the logic), matching the pattern used by
 * voice-client-status-flash.test.mjs.
 *
 * Run with: node --test tests/error-log-and-suggest-fix.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '../public/index.html'), 'utf-8');

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`function ${name} not found in public/index.html`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error(`could not find end of function ${name}`);
  return source.slice(start, end);
}

function extractConstDeclaration(source, name) {
  const re = new RegExp(`const ${name} = [^;]+;`);
  const match = source.match(re);
  if (!match) throw new Error(`const ${name} not found in public/index.html`);
  return match[0];
}

function makeFakeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); }
  };
}

const MAX_ERROR_LOG_ENTRIES_DECL = extractConstDeclaration(html, 'MAX_ERROR_LOG_ENTRIES');
const ERROR_LOG_KEY_DECL = extractConstDeclaration(html, 'ERROR_LOG_KEY');
const ERROR_LOG_CONSTS = `${ERROR_LOG_KEY_DECL}\n${MAX_ERROR_LOG_ENTRIES_DECL}`;

// logError() now also flags the live status light red on a network-type
// category (issue #201 follow-up: Android aeroplane mode left the light
// green) - these tests only care about log persistence, so a no-op stub
// covers the call without pulling in the whole status-light chain.
const CONNECTIVITY_SET_DECL = extractConstDeclaration(html, 'CONNECTIVITY_ERROR_CATEGORIES');
const MARK_NETWORK_DOWN_STUB = 'function markNetworkDown() {}';

function loadErrorLogFns(localStorage) {
  const getErrorLogSource = extractFunction(html, 'getErrorLog');
  const logErrorSource = extractFunction(html, 'logError');
  const factory = new Function(
    'localStorage',
    `${ERROR_LOG_CONSTS}\n${CONNECTIVITY_SET_DECL}\n${MARK_NETWORK_DOWN_STUB}\n${getErrorLogSource}\n${logErrorSource}\nreturn { getErrorLog, logError };`
  );
  return factory(localStorage);
}

test('logError persists entries most-recent-first', () => {
  const localStorage = makeFakeLocalStorage();
  const { logError, getErrorLog } = loadErrorLogFns(localStorage);

  logError('first failure', 'status');
  logError('second failure', 'window');

  const log = getErrorLog();
  assert.equal(log.length, 2);
  assert.equal(log[0].message, 'second failure');
  assert.equal(log[0].context, 'window');
  assert.equal(log[1].message, 'first failure');
  assert.ok(log[0].time);
});

test('logError caps the log at 50 entries', () => {
  const localStorage = makeFakeLocalStorage();
  const { logError, getErrorLog } = loadErrorLogFns(localStorage);

  for (let i = 0; i < 60; i++) {
    logError(`failure ${i}`, 'status');
  }

  const log = getErrorLog();
  assert.equal(log.length, 50);
  assert.equal(log[0].message, 'failure 59');
  assert.equal(log[49].message, 'failure 10');
});

test('getErrorLog tolerates corrupt localStorage content', () => {
  const localStorage = makeFakeLocalStorage();
  localStorage.setItem('pg1_error_log', '{not valid json');
  const { getErrorLog } = loadErrorLogFns(localStorage);

  assert.deepEqual(getErrorLog(), []);
});

function extractLetDeclaration(source, name) {
  const re = new RegExp(`let ${name} = [^;]+;`);
  const match = source.match(re);
  if (!match) throw new Error(`let ${name} not found in public/index.html`);
  return match[0];
}

// flashStatus()'s revert-after-2.5s now repaints the live status light
// (renderIdleStatus) instead of restoring a captured snapshot, so the
// sandbox needs that function (and its lastHealthState/color/label
// dependencies) defined too, even though these tests only exercise the
// synchronous logging behavior and never wait out the timeout themselves.
function loadFlashStatus(localStorage) {
  const getErrorLogSource = extractFunction(html, 'getErrorLog');
  const logErrorSource = extractFunction(html, 'logError');
  const flashStatusSource = extractFunction(html, 'flashStatus');
  const lastHealthStateDecl = extractLetDeclaration(html, 'lastHealthState');
  const healthStateColorSource = extractFunction(html, 'healthStateColor');
  const healthStateLabelSource = extractFunction(html, 'healthStateLabel');
  const renderIdleStatusSource = extractFunction(html, 'renderIdleStatus');
  const factory = new Function(
    'localStorage', 'document',
    `${ERROR_LOG_CONSTS}\n${CONNECTIVITY_SET_DECL}\n${MARK_NETWORK_DOWN_STUB}\n${getErrorLogSource}\n${logErrorSource}\n${lastHealthStateDecl}\n${healthStateColorSource}\n${healthStateLabelSource}\n${renderIdleStatusSource}\n${flashStatusSource}\nreturn flashStatus;`
  );
  const fakeStatusEl = { innerHTML: '', style: {} };
  const fakeDocument = { getElementById: () => fakeStatusEl };
  return { flashStatus: factory(localStorage, fakeDocument), localStorage };
}

test('flashStatus logs an entry for a genuine error flash', () => {
  const localStorage = makeFakeLocalStorage();
  const { flashStatus } = loadFlashStatus(localStorage);

  flashStatus('SPEECH REQUEST FAILED');

  const log = JSON.parse(localStorage.getItem('pg1_error_log'));
  assert.equal(log.length, 1);
  assert.equal(log[0].message, 'SPEECH REQUEST FAILED');
  assert.equal(log[0].context, 'status');
});

test('flashStatus does not log a non-error flash', () => {
  const localStorage = makeFakeLocalStorage();
  const { flashStatus } = loadFlashStatus(localStorage);

  flashStatus('Voice profile switched.', false);

  assert.equal(localStorage.getItem('pg1_error_log'), null);
});

function loadExtractPatchActionFromReply() {
  const source = extractFunction(html, 'extractPatchActionFromReply');
  const factory = new Function(`${source}\nreturn extractPatchActionFromReply;`);
  return factory();
}

test('extractPatchActionFromReply parses a well-formed suggested patch', () => {
  const extractPatchActionFromReply = loadExtractPatchActionFromReply();
  const reply = 'Here is the fix:\n```json\n{"actionType":"APPLY_SURGICAL_PATCH","targetFile":"api/chat.mjs","search":"foo","replace":"bar"}\n```\n';

  const action = extractPatchActionFromReply(reply);

  assert.ok(action);
  assert.equal(action.targetFile, 'api/chat.mjs');
  assert.equal(action.search, 'foo');
  assert.equal(action.replace, 'bar');
});

test('extractPatchActionFromReply ignores unrelated JSON in a code fence', () => {
  const extractPatchActionFromReply = loadExtractPatchActionFromReply();
  const reply = 'Example config:\n```json\n{"foo": "bar"}\n```\n';

  assert.equal(extractPatchActionFromReply(reply), null);
});

test('extractPatchActionFromReply requires all three fields, not just the action type', () => {
  const extractPatchActionFromReply = loadExtractPatchActionFromReply();
  const reply = '```json\n{"actionType":"APPLY_SURGICAL_PATCH","targetFile":"api/chat.mjs"}\n```';

  assert.equal(extractPatchActionFromReply(reply), null);
});

test('extractPatchActionFromReply returns null for plain prose with no code fence', () => {
  const extractPatchActionFromReply = loadExtractPatchActionFromReply();

  assert.equal(extractPatchActionFromReply('I cannot find an exact fix for this without more context.'), null);
});
