/**
 * Issue #201 "Error-log polish" (client side, public/index.html):
 *
 *  2. classifyFetchFailure() sorts a failure into one of the six reason
 *     categories (offline/network/timeout/http_4xx/http_5xx/js_error).
 *  3. FIX is hidden (and suggestFixForError() refuses to run) for
 *     offline/network/timeout entries - they aren't code bugs.
 *  4. buildDirectiveErrorDisplay() replaces "Exception: Failed to fetch"
 *     with a friendlier offline/network message, with no "Exception:"
 *     prefix, while leaving every other failure's own message and prefix
 *     untouched.
 *  5. The live status light (checkApiHealth/renderIdleStatus) reports
 *     green/amber/red from navigator.onLine and a light /api/health check.
 *  6. The ERROR LOG modal shows only unresolved entries by default, with a
 *     "Show resolved" toggle revealing history; resolved entries never show
 *     FIX or RESOLVE.
 *
 * These extract the exact shipped function/const source from
 * public/index.html (rather than re-implementing the logic), matching the
 * pattern used by tests/error-log-and-suggest-fix.test.mjs.
 *
 * Run with: node --test tests/error-log-polish-client.test.mjs
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
  // Keep the "async " keyword if this is an async function declaration -
  // otherwise `await` inside it is a syntax error once extracted on its own.
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

// --- classifyFetchFailure / buildDirectiveErrorDisplay ---

function loadClassifier(navigatorStub) {
  const source = extractFunction(html, 'classifyFetchFailure');
  const factory = new Function('navigator', `${source}\nreturn classifyFetchFailure;`);
  return factory(navigatorStub);
}

function loadDirectiveErrorDisplay(navigatorStub) {
  const classifySource = extractFunction(html, 'classifyFetchFailure');
  const displaySource = extractFunction(html, 'buildDirectiveErrorDisplay');
  const factory = new Function('navigator', `${classifySource}\n${displaySource}\nreturn buildDirectiveErrorDisplay;`);
  return factory(navigatorStub);
}

test('classifyFetchFailure: AbortError is always timeout, regardless of status', () => {
  const classify = loadClassifier({ onLine: true });
  const err = new Error('aborted');
  err.name = 'AbortError';
  assert.equal(classify(err, null), 'timeout');
  assert.equal(classify(err, 500), 'timeout');
});

test('classifyFetchFailure: a real HTTP status wins when there is one', () => {
  const classify = loadClassifier({ onLine: true });
  assert.equal(classify(null, 404), 'http_4xx');
  assert.equal(classify(null, 429), 'http_4xx');
  assert.equal(classify(null, 500), 'http_5xx');
  assert.equal(classify(null, 503), 'http_5xx');
});

test('classifyFetchFailure: a "Failed to fetch" TypeError is offline when navigator.onLine is false', () => {
  const classify = loadClassifier({ onLine: false });
  const err = new TypeError('Failed to fetch');
  assert.equal(classify(err, null), 'offline');
});

test('classifyFetchFailure: the same "Failed to fetch" TypeError is network when still online', () => {
  const classify = loadClassifier({ onLine: true });
  const err = new TypeError('Failed to fetch');
  assert.equal(classify(err, null), 'network');
});

test('classifyFetchFailure: anything else (a decode error, a plain exception) is js_error', () => {
  const classify = loadClassifier({ onLine: true });
  assert.equal(classify(new Error('Unexpected token < in JSON'), null), 'js_error');
  assert.equal(classify(null, null), 'js_error');
});

test('buildDirectiveErrorDisplay: offline/network failures get the friendly message with no "Exception:" prefix', () => {
  const build = loadDirectiveErrorDisplay({ onLine: false });
  const result = build(new TypeError('Failed to fetch'), null, 75);
  assert.equal(result.text, 'Offline: message not sent. Check your connection and try again.');
  assert.equal(result.category, 'offline');
  assert.equal(result.prefixed, false);
});

test('buildDirectiveErrorDisplay: a timeout keeps its own message and the "Exception:" prefix', () => {
  const build = loadDirectiveErrorDisplay({ onLine: true });
  const err = new Error('aborted');
  err.name = 'AbortError';
  const result = build(err, null, 75);
  assert.match(result.text, /No reply after 75s/);
  assert.equal(result.category, 'timeout');
  assert.equal(result.prefixed, true);
});

test('buildDirectiveErrorDisplay: a real HTTP error keeps its own message and the "Exception:" prefix', () => {
  const build = loadDirectiveErrorDisplay({ onLine: true });
  const err = new Error('Attachment too large for the server (over the 4.5 MB upload limit). Send a smaller file or a screenshot instead.');
  const result = build(err, 413, 75);
  assert.equal(result.category, 'http_4xx');
  assert.equal(result.prefixed, true);
  assert.match(result.text, /Attachment too large/);
});

// --- Live status light ---

function loadStatusLight(navigatorStub, fetchStub) {
  const colorSource = extractFunction(html, 'healthStateColor');
  const labelSource = extractFunction(html, 'healthStateLabel');
  const renderSource = extractFunction(html, 'renderIdleStatus');
  const checkSource = extractFunction(html, 'checkApiHealth');
  const lastHealthStateDecl = extractDeclaration(html, 'let', 'lastHealthState');
  const timeoutDecl = extractDeclaration(html, 'const', 'HEALTH_CHECK_TIMEOUT_MS');
  const factory = new Function(
    'navigator', 'document', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout',
    `${timeoutDecl}\n${lastHealthStateDecl}\n${colorSource}\n${labelSource}\n${renderSource}\n${checkSource}\nreturn { checkApiHealth, renderIdleStatus, getLastHealthState: () => lastHealthState, setLastHealthState: (s) => { lastHealthState = s; } };`
  );
  const fakeStatusEl = { innerHTML: '', style: {} };
  const fakeDocument = { getElementById: () => fakeStatusEl };
  return { ...factory(navigatorStub, fakeDocument, fetchStub, AbortController, setTimeout, clearTimeout), statusEl: fakeStatusEl };
}

test('checkApiHealth: red immediately when navigator.onLine is false (no fetch)', async () => {
  let fetchCalled = false;
  const fetchStub = async () => { fetchCalled = true; return { ok: true, json: async () => ({ status: 'ok' }) }; };
  const { checkApiHealth } = loadStatusLight({ onLine: false }, fetchStub);
  const state = await checkApiHealth();
  assert.equal(state, 'red');
  assert.equal(fetchCalled, false);
});

test('checkApiHealth: green when online and /api/health answers ok', async () => {
  const fetchStub = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
  const { checkApiHealth } = loadStatusLight({ onLine: true }, fetchStub);
  assert.equal(await checkApiHealth(), 'green');
});

test('checkApiHealth: amber when reachable but the health check itself is not ok', async () => {
  const fetchStub = async () => ({ ok: false, json: async () => ({ status: 'degraded' }) });
  const { checkApiHealth } = loadStatusLight({ onLine: true }, fetchStub);
  assert.equal(await checkApiHealth(), 'amber');
});

test('checkApiHealth: red (not amber) when online but the health fetch itself throws (unreachable/timeout) - issue #201 follow-up', async () => {
  const fetchStub = async () => { throw new Error('network down'); };
  const { checkApiHealth } = loadStatusLight({ onLine: true }, fetchStub);
  assert.equal(await checkApiHealth(), 'red');
});

test('renderIdleStatus paints the status dot/label matching the last-known health state', () => {
  const fetchStub = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
  const { renderIdleStatus, setLastHealthState, statusEl } = loadStatusLight({ onLine: true }, fetchStub);

  setLastHealthState('red');
  renderIdleStatus();
  assert.match(statusEl.innerHTML, /OFFLINE/);

  setLastHealthState('amber');
  renderIdleStatus();
  assert.match(statusEl.innerHTML, /DEGRADED/);

  setLastHealthState('green');
  renderIdleStatus();
  assert.match(statusEl.innerHTML, /ACTIVE \| API LINKED/);
});

// --- Status light polling: 120s interval, paused while tab hidden ---

function loadStatusPolling(navigatorStub, fetchStub, initialVisibility = 'visible') {
  const colorSource = extractFunction(html, 'healthStateColor');
  const labelSource = extractFunction(html, 'healthStateLabel');
  const renderSource = extractFunction(html, 'renderIdleStatus');
  const checkSource = extractFunction(html, 'checkApiHealth');
  const refreshSource = extractFunction(html, 'refreshStatusLight');
  const startSource = extractFunction(html, 'startStatusPolling');
  const stopSource = extractFunction(html, 'stopStatusPolling');
  const startRedSource = extractFunction(html, 'startRedRecheck');
  const stopRedSource = extractFunction(html, 'stopRedRecheck');
  const visibilitySource = extractFunction(html, 'handleVisibilityChange');
  const lastHealthStateDecl = extractDeclaration(html, 'let', 'lastHealthState');
  const timeoutDecl = extractDeclaration(html, 'const', 'HEALTH_CHECK_TIMEOUT_MS');
  const pollIntervalDecl = extractDeclaration(html, 'const', 'STATUS_POLL_INTERVAL_MS');
  const redIntervalDecl = extractDeclaration(html, 'const', 'RED_RECHECK_INTERVAL_MS');

  const fakeStatusEl = { innerHTML: '', style: {} };
  let nextTimerId = 1;
  const activeTimers = new Set();
  const intervalCalls = [];
  const fakeSetInterval = (fn, ms) => {
    const id = nextTimerId++;
    intervalCalls.push({ id, fn, ms });
    activeTimers.add(id);
    return id;
  };
  const fakeClearInterval = (id) => { activeTimers.delete(id); };
  const fakeDocument = {
    visibilityState: initialVisibility,
    getElementById: () => fakeStatusEl,
  };

  const factory = new Function(
    'navigator', 'document', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    `let statusPollTimerId = null;
     let redRecheckTimerId = null;
     ${timeoutDecl}
     ${pollIntervalDecl}
     ${redIntervalDecl}
     ${lastHealthStateDecl}
     ${colorSource}
     ${labelSource}
     ${renderSource}
     ${checkSource}
     ${startRedSource}
     ${stopRedSource}
     ${refreshSource}
     ${startSource}
     ${stopSource}
     ${visibilitySource}
     return {
       startStatusPolling, stopStatusPolling, handleVisibilityChange, refreshStatusLight,
       getLastHealthState: () => lastHealthState,
       getTimerId: () => statusPollTimerId,
       getRedTimerId: () => redRecheckTimerId,
     };`
  );

  const api = factory(navigatorStub, fakeDocument, fetchStub, AbortController, setTimeout, clearTimeout, fakeSetInterval, fakeClearInterval);
  return { ...api, statusEl: fakeStatusEl, fakeDocument, intervalCalls, activeTimers, pollIntervalMs: 120000 };
}

test('startStatusPolling polls /api/health every 120s (not 30s)', () => {
  const fetchStub = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
  const { startStatusPolling, intervalCalls } = loadStatusPolling({ onLine: true }, fetchStub);

  startStatusPolling();
  assert.equal(intervalCalls.length, 1);
  assert.equal(intervalCalls[0].ms, 120000);
});

test('startStatusPolling is idempotent: calling it twice only schedules one timer', () => {
  const fetchStub = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
  const { startStatusPolling, intervalCalls } = loadStatusPolling({ onLine: true }, fetchStub);

  startStatusPolling();
  startStatusPolling();
  assert.equal(intervalCalls.length, 1);
});

test('handleVisibilityChange stops polling when the tab becomes hidden', () => {
  const fetchStub = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
  const { startStatusPolling, handleVisibilityChange, getTimerId, fakeDocument, activeTimers } =
    loadStatusPolling({ onLine: true }, fetchStub);

  startStatusPolling();
  assert.notEqual(getTimerId(), null);

  fakeDocument.visibilityState = 'hidden';
  handleVisibilityChange();

  assert.equal(getTimerId(), null);
  assert.equal(activeTimers.size, 0);
});

test('handleVisibilityChange does an immediate health check and resumes polling when the tab becomes visible again', async () => {
  let fetchCalls = 0;
  const fetchStub = async () => { fetchCalls++; return { ok: true, json: async () => ({ status: 'ok' }) }; };
  const { handleVisibilityChange, getTimerId, fakeDocument, intervalCalls } =
    loadStatusPolling({ onLine: true }, fetchStub, 'hidden');

  // Tab starts hidden: no polling should be running.
  assert.equal(getTimerId(), null);

  fakeDocument.visibilityState = 'visible';
  handleVisibilityChange();
  // refreshStatusLight() is async; let its fetch settle.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(fetchCalls, 1);
  assert.notEqual(getTimerId(), null);
  assert.equal(intervalCalls.length, 1);
  assert.equal(intervalCalls[0].ms, 120000);
});

// --- ERROR LOG timeline (PR A): open problems first, dismissed ones muted,
// FIX gating, grouping of repeats, the filter row, no secret on screen ---

function makeStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

function loadErrorLogRows() {
  const fns = ['escapeHTML', 'errorSeverity', 'errorArea', 'scrubErrorText', 'errorSummary', 'errorKey', 'readErrorSet', 'writeErrorSet', 'groupErrorEntries', 'errorRepeatText', 'errorTimeText', 'errorFixable', 'applyErrorLogFilter', 'renderErrorLogRows', 'errorDetailsText'];
  const decls = [
    extractDeclaration(html, 'const', 'CONNECTIVITY_ERROR_CATEGORIES'),
    extractDeclaration(html, 'const', 'ERROR_DISMISSED_KEY'),
    extractDeclaration(html, 'const', 'ERROR_CLEARED_KEY'),
    extractDeclaration(html, 'const', 'ERROR_SEVERITY'),
    extractDeclaration(html, 'const', 'ERROR_TONE'),
    extractDeclaration(html, 'let', 'errorLogFilter'),
    extractDeclaration(html, 'let', 'currentErrorLogEntries'),
    extractDeclaration(html, 'let', 'allErrorLogEntries')
  ];
  const factory = new Function(
    'document', 'localStorage',
    `${decls.join('\n')}\n${fns.map((f) => extractFunction(html, f)).join('\n')}\n` +
    `return { applyErrorLogFilter, errorDetailsText, errorRepeatText, groupErrorEntries, setFilter: (f) => { errorLogFilter = f; }, setAllEntries: (e) => { allErrorLogEntries = e; }, getCurrentEntries: () => currentErrorLogEntries };`
  );
  const fakeContainer = { innerHTML: '' };
  const fakeDocument = { getElementById: (id) => (id === 'error-log-list' ? fakeContainer : null) };
  const store = makeStore();
  return { ...factory(fakeDocument, store), container: fakeContainer, store };
}

function sampleEntries() {
  return [
    { message: 'first failure', context: 'submitDirective', category: 'offline', time: '2026-09-30T05:06:00.000Z', count: 1, id: 'row-1', resolved: false },
    { message: 'server exception', context: 'CHAT', category: 'http_5xx', time: '2026-09-30T05:00:00.000Z', count: 3, id: 'row-2', resolved: false },
    { message: 'old, fixed now', context: 'CHAT', category: 'http_5xx', time: '2026-09-29T05:00:00.000Z', count: 1, id: 'row-3', resolved: true }
  ];
}

const cardsOf = (htmlText) => htmlText.split('<li data-tone=').slice(1);

test('ERROR LOG: open entries first, newest first; a resolved one is shown muted as Dismissed, with no FIX', () => {
  const { applyErrorLogFilter, setAllEntries, getCurrentEntries, container } = loadErrorLogRows();
  setAllEntries(sampleEntries());
  applyErrorLogFilter();
  assert.deepEqual(getCurrentEntries().map((e) => e.id), ['row-1', 'row-2', 'row-3']);
  const cards = cardsOf(container.innerHTML);
  assert.match(cards[2], /is-muted/);
  assert.match(cards[2], />Dismissed</);
  assert.ok(!cards[2].includes('>FIX<'), 'a resolved entry never shows FIX');
});

test('FIX is hidden for offline/network/timeout entries, shown for a real code-bug category', () => {
  const { applyErrorLogFilter, setAllEntries, container } = loadErrorLogRows();
  setAllEntries([
    { message: 'a', context: 'submitDirective', category: 'offline', time: '2026-09-30T05:06:04.000Z', count: 1, id: 'row-1', resolved: false },
    { message: 'b', context: 'submitDirective', category: 'network', time: '2026-09-30T05:06:03.000Z', count: 1, id: 'row-2', resolved: false },
    { message: 'c', context: 'submitDirective', category: 'timeout', time: '2026-09-30T05:06:02.000Z', count: 1, id: 'row-3', resolved: false },
    { message: 'd', context: 'CHAT', category: 'http_5xx', time: '2026-09-30T05:06:01.000Z', count: 1, id: 'row-4', resolved: false }
  ]);
  applyErrorLogFilter();
  const items = cardsOf(container.innerHTML);
  assert.equal(items.length, 4);
  assert.ok(!items[0].includes('>FIX<'), 'offline entry must not show FIX');
  assert.ok(!items[1].includes('>FIX<'), 'network entry must not show FIX');
  assert.ok(!items[2].includes('>FIX<'), 'timeout entry must not show FIX');
  assert.ok(items[3].includes('>FIX<'), 'a real http_5xx code-bug entry must still show FIX');
  for (const item of items) assert.match(item, /Copy details/);
});

test('repeats of one failure are one card with their count; the filter row narrows the list', () => {
  const { applyErrorLogFilter, setAllEntries, setFilter, getCurrentEntries, errorRepeatText } = loadErrorLogRows();
  const now = Date.now();
  const at = (m) => new Date(now - m * 60000).toISOString();
  setAllEntries([
    ...Array.from({ length: 12 }, (_, i) => ({ message: 'TypeError: x is undefined', context: 'promise', category: 'js_error', time: at(i * 4), count: 1, id: null, resolved: false })),
    { message: 'upstream down', context: 'tool', route: '/api/mcp:check_domain_age', category: 'upstream', time: at(3), count: 1, id: 'u1', resolved: false }
  ]);
  applyErrorLogFilter();
  const list = getCurrentEntries();
  assert.equal(list.length, 2);
  const grouped = list.find((e) => e.category === 'js_error');
  assert.equal(grouped.count, 12);
  assert.equal(errorRepeatText(grouped, now), '×12 in the last hour');
  setFilter('warnings'); applyErrorLogFilter();
  assert.deepEqual(getCurrentEntries().map((e) => e.category), ['upstream']);
  setFilter('errors'); applyErrorLogFilter();
  assert.deepEqual(getCurrentEntries().map((e) => e.category), ['js_error']);
  setFilter('fixable'); applyErrorLogFilter();
  assert.deepEqual(getCurrentEntries().map((e) => e.category), ['js_error'], 'an upstream outage is not fixable');
});

test('no key, token or password reaches the card or Copy details', () => {
  const { applyErrorLogFilter, setAllEntries, container, errorDetailsText, getCurrentEntries } = loadErrorLogRows();
  setAllEntries([{ message: 'call failed: Authorization: Bearer abcdefghijklmnop123 key=AIzaSyA1234567890abcdefghijk ghp_abcdefghijklmnopqrstuvwxyz012345 password=hunter22', context: 'CHAT', category: 'http_5xx', time: '2026-09-30T05:06:00.000Z', count: 1, id: 'r', resolved: false, requestId: 'req123' }]);
  applyErrorLogFilter();
  const text = container.innerHTML + errorDetailsText(getCurrentEntries()[0]);
  for (const secret of ['abcdefghijklmnop123', 'AIzaSyA', 'ghp_abc', 'hunter22']) assert.ok(!text.includes(secret), secret);
  assert.match(text, /\[secret withheld\]/);
  assert.match(errorDetailsText(getCurrentEntries()[0]), /request_id: req123/);
});

// --- syncErrorLogToServer: sends the real client-side occurrence time and
// category with each synced entry (issue #201 error-log polish item 1 - a
// live test found a failure logged offline showed the *sync* time, minutes
// later, instead of when it actually happened).

function makeFakeLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); }
  };
}

function loadSyncErrorLogToServer(localStorage, sessionUser, sessionPass, fetchStub) {
  const errorLogKeyDecl = extractDeclaration(html, 'const', 'ERROR_LOG_KEY');
  const maxEntriesDecl = extractDeclaration(html, 'const', 'MAX_ERROR_LOG_ENTRIES');
  const syncedKeyDecl = extractDeclaration(html, 'const', 'ERROR_LOG_SYNCED_KEY');
  const getErrorLogSource = extractFunction(html, 'getErrorLog');
  const syncSource = extractFunction(html, 'syncErrorLogToServer');
  const factory = new Function(
    'localStorage', 'fetch', 'sessionUser', 'sessionPass',
    `${errorLogKeyDecl}\n${maxEntriesDecl}\n${syncedKeyDecl}\n${getErrorLogSource}\n${syncSource}\nreturn syncErrorLogToServer;`
  );
  return factory(localStorage, fetchStub, sessionUser, sessionPass);
}

test('syncErrorLogToServer sends each entry\'s real occurrence time and category, not the sync time', async () => {
  const localStorage = makeFakeLocalStorage({
    pg1_error_log: JSON.stringify([
      { time: '2026-09-30T05:06:00.000Z', message: 'Offline: message not sent. Check your connection and try again.', context: 'submitDirective', category: 'offline' }
    ])
  });
  let sentBody = null;
  const fetchStub = async (url, options) => { sentBody = JSON.parse(options.body); return { ok: true, json: async () => ({}) }; };
  const sync = loadSyncErrorLogToServer(localStorage, 'op-user', 'op-pass', fetchStub);

  await sync();

  assert.ok(sentBody);
  assert.equal(sentBody.entries.length, 1);
  assert.equal(sentBody.entries[0].time, '2026-09-30T05:06:00.000Z');
  assert.equal(sentBody.entries[0].category, 'offline');
  assert.equal(sentBody.entries[0].context, 'submitDirective');
});

test('syncErrorLogToServer does nothing when not logged in (no user/pass)', async () => {
  const localStorage = makeFakeLocalStorage({
    pg1_error_log: JSON.stringify([{ time: '2026-09-30T05:06:00.000Z', message: 'x', context: 'status', category: 'js_error' }])
  });
  let called = false;
  const fetchStub = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const sync = loadSyncErrorLogToServer(localStorage, null, null, fetchStub);

  await sync();

  assert.equal(called, false);
});

