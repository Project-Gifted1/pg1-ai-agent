/**
 * Issue #201 follow-up: on Android Chrome, aeroplane mode left the status
 * light GREEN even though a message genuinely failed and was logged (the ➕
 * badge appeared). navigator.onLine and the 'offline' event can't be
 * trusted alone on mobile - so the fix makes an actual failed request the
 * source of truth instead:
 *
 *  1. Any request that fails with a network-type category (offline/network/
 *     timeout, as classified by classifyFetchFailure()) marks the light RED
 *     immediately via logError() -> markNetworkDown(), regardless of what
 *     navigator.onLine claims.
 *  2. checkApiHealth() itself returns RED (not amber) when the /api/health
 *     fetch is rejected/times out (a network failure), and AMBER only when
 *     the server actually answered but reported/implied it's unhealthy.
 *  3. While red, a fast 15s recheck loop (paused while the tab is hidden)
 *     polls /api/health and returns to green/amber as soon as it succeeds.
 *  4. flashStatus()'s 2.5s revert-to-idle never overwrites a red state with
 *     green - it paints whatever the last-known health state actually is.
 *
 * These extract the exact shipped function/const source from
 * public/index.html, matching the pattern used by
 * tests/error-log-polish-client.test.mjs.
 *
 * Run with: node --test tests/status-light-network-detection.test.mjs
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
  let start = source.indexOf(marker);
  if (start === -1) throw new Error(`function ${name} not found in public/index.html`);
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
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

function extractDeclaration(source, keyword, name) {
  const re = new RegExp(`${keyword} ${name} = [^;]+;`);
  const match = source.match(re);
  if (!match) throw new Error(`${keyword} ${name} not found in public/index.html`);
  return match[0];
}

// Stitches together the full shipped chain: logError -> markNetworkDown ->
// startRedRecheck, plus checkApiHealth/refreshStatusLight/flashStatus, so
// tests exercise the real interaction instead of re-implementing it.
function loadNetworkDetection({ navigatorStub, fetchStub, initialVisibility = 'visible' }) {
  const errorLogKeyDecl = extractDeclaration(html, 'const', 'ERROR_LOG_KEY');
  const maxEntriesDecl = extractDeclaration(html, 'const', 'MAX_ERROR_LOG_ENTRIES');
  const connectivitySetDecl = extractDeclaration(html, 'const', 'CONNECTIVITY_ERROR_CATEGORIES');
  const timeoutDecl = extractDeclaration(html, 'const', 'HEALTH_CHECK_TIMEOUT_MS');
  const redIntervalDecl = extractDeclaration(html, 'const', 'RED_RECHECK_INTERVAL_MS');
  const lastHealthStateDecl = extractDeclaration(html, 'let', 'lastHealthState');

  const getErrorLogSource = extractFunction(html, 'getErrorLog');
  const logErrorSource = extractFunction(html, 'logError');
  const colorSource = extractFunction(html, 'healthStateColor');
  const labelSource = extractFunction(html, 'healthStateLabel');
  const renderSource = extractFunction(html, 'renderIdleStatus');
  const checkSource = extractFunction(html, 'checkApiHealth');
  const startRedSource = extractFunction(html, 'startRedRecheck');
  const stopRedSource = extractFunction(html, 'stopRedRecheck');
  const markNetworkDownSource = extractFunction(html, 'markNetworkDown');
  const refreshSource = extractFunction(html, 'refreshStatusLight');
  const flashStatusSource = extractFunction(html, 'flashStatus');

  const fakeStatusEl = { innerHTML: '', style: {} };
  const fakeDocument = { visibilityState: initialVisibility, getElementById: () => fakeStatusEl };

  let nextIntervalId = 1;
  const activeIntervals = new Map();
  const fakeSetInterval = (fn, ms) => {
    const id = nextIntervalId++;
    activeIntervals.set(id, { fn, ms });
    return id;
  };
  const fakeClearInterval = (id) => { activeIntervals.delete(id); };

  let nextTimeoutId = 1;
  const timeoutCalls = [];
  const fakeSetTimeout = (fn, ms) => {
    const id = nextTimeoutId++;
    timeoutCalls.push({ id, fn, ms });
    return id;
  };
  const fakeClearTimeout = () => {};

  const localStorageBacking = new Map();
  const fakeLocalStorage = {
    getItem: (k) => (localStorageBacking.has(k) ? localStorageBacking.get(k) : null),
    setItem: (k, v) => { localStorageBacking.set(k, String(v)); },
    removeItem: (k) => { localStorageBacking.delete(k); }
  };

  const factory = new Function(
    'navigator', 'document', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'localStorage',
    `let redRecheckTimerId = null;
     ${timeoutDecl}
     ${redIntervalDecl}
     ${lastHealthStateDecl}
     ${errorLogKeyDecl}
     ${maxEntriesDecl}
     ${connectivitySetDecl}
     ${getErrorLogSource}
     ${colorSource}
     ${labelSource}
     ${renderSource}
     ${checkSource}
     ${startRedSource}
     ${stopRedSource}
     ${markNetworkDownSource}
     ${refreshSource}
     ${logErrorSource}
     ${flashStatusSource}
     return {
       logError, flashStatus, refreshStatusLight, markNetworkDown, checkApiHealth,
       getLastHealthState: () => lastHealthState,
       setLastHealthState: (s) => { lastHealthState = s; },
       getRedTimerId: () => redRecheckTimerId,
     };`
  );

  const api = factory(
    navigatorStub, fakeDocument, fetchStub, AbortController, fakeSetTimeout, fakeClearTimeout,
    fakeSetInterval, fakeClearInterval, fakeLocalStorage
  );

  return { ...api, statusEl: fakeStatusEl, fakeDocument, activeIntervals, timeoutCalls };
}

// --- 1. logError()/markNetworkDown(): a real failed request beats navigator.onLine ---

test('logError with an "offline" category marks the light red immediately, even though navigator.onLine is still true (Android aeroplane-mode bug)', () => {
  const fetchStub = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
  const api = loadNetworkDetection({ navigatorStub: { onLine: true }, fetchStub });
  api.setLastHealthState('green');

  api.logError('Offline: message not sent. Check your connection and try again.', 'submitDirective', 'offline');

  assert.equal(api.getLastHealthState(), 'red');
  assert.match(api.statusEl.innerHTML, /OFFLINE/);
});

test('logError with a "network" or "timeout" category also marks the light red', () => {
  const fetchStub = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });

  const apiNetwork = loadNetworkDetection({ navigatorStub: { onLine: true }, fetchStub });
  apiNetwork.setLastHealthState('green');
  apiNetwork.logError('Speech request failed', 'status', 'network');
  assert.equal(apiNetwork.getLastHealthState(), 'red');

  const apiTimeout = loadNetworkDetection({ navigatorStub: { onLine: true }, fetchStub });
  apiTimeout.setLastHealthState('green');
  apiTimeout.logError('No reply after 75s', 'submitDirective', 'timeout');
  assert.equal(apiTimeout.getLastHealthState(), 'red');
});

test('logError with a real code-bug category (http_5xx/js_error) leaves the health state untouched', () => {
  const fetchStub = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
  const api = loadNetworkDetection({ navigatorStub: { onLine: true }, fetchStub });
  api.setLastHealthState('green');

  api.logError('Server exception', 'CHAT', 'http_5xx');
  assert.equal(api.getLastHealthState(), 'green');

  api.logError('Unexpected token < in JSON', 'window', 'js_error');
  assert.equal(api.getLastHealthState(), 'green');
});

test('markNetworkDown starts the 15s red-recheck loop immediately, without waiting for the next poll', () => {
  const fetchStub = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
  const api = loadNetworkDetection({ navigatorStub: { onLine: true }, fetchStub });

  api.markNetworkDown();

  assert.equal(api.getLastHealthState(), 'red');
  assert.notEqual(api.getRedTimerId(), null);
  const [interval] = api.activeIntervals.values();
  assert.equal(interval.ms, 15000);
});

test('markNetworkDown does not start the recheck loop while the tab is hidden', () => {
  const fetchStub = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
  const api = loadNetworkDetection({ navigatorStub: { onLine: true }, fetchStub, initialVisibility: 'hidden' });

  api.markNetworkDown();

  assert.equal(api.getLastHealthState(), 'red');
  assert.equal(api.getRedTimerId(), null);
  assert.equal(api.activeIntervals.size, 0);
});

// --- 2. checkApiHealth(): red for a network failure, amber only when the server answered unhealthy ---

test('checkApiHealth: red when the /api/health fetch is rejected (network down), never amber', async () => {
  const fetchStub = async () => { throw new TypeError('Failed to fetch'); };
  const api = loadNetworkDetection({ navigatorStub: { onLine: true }, fetchStub });
  assert.equal(await api.checkApiHealth(), 'red');
});

test('checkApiHealth: amber when the server actually answers but reports an unhealthy status', async () => {
  const fetchStub = async () => ({ ok: false, json: async () => ({ status: 'degraded' }) });
  const api = loadNetworkDetection({ navigatorStub: { onLine: true }, fetchStub });
  assert.equal(await api.checkApiHealth(), 'amber');
});

test('checkApiHealth: never green when the fetch fails', async () => {
  const fetchStub = async () => { throw new Error('timeout'); };
  const api = loadNetworkDetection({ navigatorStub: { onLine: true }, fetchStub });
  assert.notEqual(await api.checkApiHealth(), 'green');
});

// --- 3. refreshStatusLight(): manages the red-recheck loop based on outcome ---

test('refreshStatusLight starts the red-recheck loop when the health check comes back red', async () => {
  const fetchStub = async () => { throw new Error('network down'); };
  const api = loadNetworkDetection({ navigatorStub: { onLine: true }, fetchStub });

  await api.refreshStatusLight();

  assert.equal(api.getLastHealthState(), 'red');
  assert.notEqual(api.getRedTimerId(), null);
});

test('refreshStatusLight stops the red-recheck loop once the health check recovers', async () => {
  let shouldFail = true;
  const fetchStub = async () => {
    if (shouldFail) throw new Error('network down');
    return { ok: true, json: async () => ({ status: 'ok' }) };
  };
  const api = loadNetworkDetection({ navigatorStub: { onLine: true }, fetchStub });

  await api.refreshStatusLight();
  assert.equal(api.getLastHealthState(), 'red');
  assert.notEqual(api.getRedTimerId(), null);

  shouldFail = false;
  await api.refreshStatusLight();

  assert.equal(api.getLastHealthState(), 'green');
  assert.equal(api.getRedTimerId(), null);
  assert.equal(api.activeIntervals.size, 0);
});

test('the red-recheck loop fires refreshStatusLight every 15s and self-clears on recovery', async () => {
  let shouldFail = true;
  const fetchStub = async () => {
    if (shouldFail) throw new Error('network down');
    return { ok: true, json: async () => ({ status: 'ok' }) };
  };
  const api = loadNetworkDetection({ navigatorStub: { onLine: true }, fetchStub });

  api.markNetworkDown();
  const [interval] = api.activeIntervals.values();
  assert.equal(interval.ms, 15000);

  shouldFail = false;
  await interval.fn(); // simulate the 15s tick firing (calls refreshStatusLight)

  assert.equal(api.getLastHealthState(), 'green');
  assert.equal(api.getRedTimerId(), null);
});

// --- 4. flashStatus(): the 2.5s revert must not overwrite red with green ---

test('flashStatus: reverting after a genuine offline failure still shows red, not the stale green light', () => {
  const fetchStub = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
  const api = loadNetworkDetection({ navigatorStub: { onLine: true }, fetchStub });
  api.setLastHealthState('green');

  api.flashStatus('Offline: message not sent. Check your connection and try again.', true, 'offline');
  assert.equal(api.getLastHealthState(), 'red');

  const revert = api.timeoutCalls.find((c) => c.ms === 2500);
  assert.ok(revert, 'flashStatus must schedule a 2.5s revert');
  revert.fn();

  assert.match(api.statusEl.innerHTML, /OFFLINE/);
  assert.doesNotMatch(api.statusEl.innerHTML, /ACTIVE \| API LINKED/);
});

test('flashStatus: reverting after an unrelated, non-network error still shows the real (green) health state', () => {
  const fetchStub = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
  const api = loadNetworkDetection({ navigatorStub: { onLine: true }, fetchStub });
  api.setLastHealthState('green');

  api.flashStatus('AUDIO DECODE ERROR', true, 'js_error');
  assert.equal(api.getLastHealthState(), 'green');

  const revert = api.timeoutCalls.find((c) => c.ms === 2500);
  assert.ok(revert);
  revert.fn();

  assert.match(api.statusEl.innerHTML, /ACTIVE \| API LINKED/);
});

// --- Wiring guard: the 'online'/'offline' listeners must call the right functions ---

test('the offline browser event is wired to markNetworkDown (not just setting state inline)', () => {
  assert.match(html, /window\.addEventListener\('offline',\s*markNetworkDown\)/);
});

test('the online browser event is wired to an immediate refreshStatusLight() recheck', () => {
  assert.match(html, /window\.addEventListener\('online',\s*refreshStatusLight\)/);
});

test('handleVisibilityChange also stops the red-recheck loop when the tab becomes hidden', () => {
  const visibilitySource = extractFunction(html, 'handleVisibilityChange');
  assert.match(visibilitySource, /stopRedRecheck\(\)/);
});
