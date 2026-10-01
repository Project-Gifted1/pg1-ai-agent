/**
 * Empty-state greeting and the Appearance (System / Light / Dark) setting
 * in public/index.html:
 *
 *  - pickGreeting() picks from the local-time band's lines (morning 5-12,
 *    afternoon 12-17, evening 17-22, late 22-5), adds the weekend line on
 *    Saturday/Sunday outside late hours, and never repeats the last line.
 *  - renderWelcome() stores the line it showed and avoids it next time.
 *  - welcomeSubtitle() reflects errors, offline and degraded states.
 *  - setThemeSetting() saves the choice; System follows
 *    prefers-color-scheme, including a live change.
 *
 * Like the other client tests, these extract the shipped source from
 * public/index.html rather than re-implementing it.
 *
 * Run with: node --test tests/greeting-and-theme.test.mjs
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
  const braceStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`could not find end of function ${name}`);
}

function extractConst(source, name) {
  const match = source.match(new RegExp(`const ${name} = (?:'[^']*'|[^;]+);`));
  if (!match) throw new Error(`const ${name} not found in public/index.html`);
  return match[0];
}

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); }
  };
}

// --- greeting ---

const GREETING_SOURCE = [
  extractConst(html, 'GREETING_KEY'),
  extractConst(html, 'GREETINGS'),
  extractConst(html, 'WEEKEND_GREETING'),
  extractFunction(html, 'greetingBand'),
  extractFunction(html, 'greetingPool'),
  extractFunction(html, 'pickGreeting')
].join('\n');

function loadGreeting() {
  return new Function(`${GREETING_SOURCE}\nreturn { GREETINGS, WEEKEND_GREETING, greetingBand, greetingPool, pickGreeting };`)();
}

// 2026-10-01 is a Thursday; 2026-10-03 a Saturday; 2026-10-04 a Sunday.
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute);

test('greetingBand: band edges are 5, 12, 17 and 22 local time', () => {
  const { greetingBand } = loadGreeting();
  const cases = [
    [0, 'late'], [4, 'late'], [5, 'morning'], [11, 'morning'], [12, 'afternoon'],
    [16, 'afternoon'], [17, 'evening'], [21, 'evening'], [22, 'late'], [23, 'late']
  ];
  for (const [hour, band] of cases) assert.equal(greetingBand(hour), band, `hour ${hour}`);
});

test('pickGreeting: always a line from the current band on a weekday', () => {
  const { GREETINGS, pickGreeting } = loadGreeting();
  const bands = [[8, 'morning'], [14, 'afternoon'], [19, 'evening'], [23, 'late'], [2, 'late']];
  for (const [hour, band] of bands) {
    for (let r = 0; r < 1; r += 0.05) {
      const line = pickGreeting(at(1, hour), null, () => r);
      assert.ok(GREETINGS[band].includes(line), `${hour}:00 gave "${line}", not a ${band} line`);
    }
  }
});

test('pickGreeting: every line in the band can come up', () => {
  const { GREETINGS, pickGreeting } = loadGreeting();
  const seen = new Set();
  for (let r = 0; r < 1; r += 0.01) seen.add(pickGreeting(at(1, 9), null, () => r));
  assert.deepEqual([...seen].sort(), [...GREETINGS.morning].sort());
});

test('pickGreeting: never repeats the line shown last', () => {
  const { GREETINGS, greetingPool, pickGreeting } = loadGreeting();
  for (const date of [at(1, 9), at(1, 14), at(1, 19), at(1, 23), at(3, 10)]) {
    for (const last of greetingPool(date)) {
      for (let r = 0; r < 1; r += 0.02) {
        const line = pickGreeting(date, last, () => r);
        assert.notEqual(line, last);
        assert.ok(greetingPool(date).includes(line));
      }
    }
  }
  // Random runs, feeding each pick back in as the last one shown.
  let last = null;
  for (let i = 0; i < 500; i++) {
    const line = pickGreeting(at(1, 15), last);
    assert.notEqual(line, last);
    assert.ok(GREETINGS.afternoon.includes(line));
    last = line;
  }
});

test('pickGreeting: a stale last line from another band does not narrow the pool', () => {
  const { GREETINGS, pickGreeting } = loadGreeting();
  const seen = new Set();
  for (let r = 0; r < 1; r += 0.01) seen.add(pickGreeting(at(1, 9), GREETINGS.late[0], () => r));
  assert.equal(seen.size, GREETINGS.morning.length);
});

test('greetingPool: weekend line is added on Saturday and Sunday, except late', () => {
  const { WEEKEND_GREETING, greetingPool } = loadGreeting();
  for (const day of [3, 4]) {
    for (const hour of [6, 13, 18, 21]) {
      assert.ok(greetingPool(at(day, hour)).includes(WEEKEND_GREETING), `day ${day} ${hour}:00`);
    }
    for (const hour of [22, 23, 0, 3]) {
      assert.ok(!greetingPool(at(day, hour)).includes(WEEKEND_GREETING), `day ${day} ${hour}:00 is late`);
    }
  }
  for (const day of [1, 2, 5]) {
    for (const hour of [6, 13, 18]) {
      assert.ok(!greetingPool(at(day, hour)).includes(WEEKEND_GREETING), `weekday ${day} ${hour}:00`);
    }
  }
  // The weekend line is pickable, and picking it doesn't repeat it.
  const { pickGreeting } = loadGreeting();
  assert.equal(pickGreeting(at(3, 10), null, () => 0.99), WEEKEND_GREETING);
  assert.notEqual(pickGreeting(at(3, 10), WEEKEND_GREETING, () => 0.99), WEEKEND_GREETING);
});

test('renderWelcome: stores the shown line and avoids it on the next render', () => {
  const storage = memoryStorage();
  const title = { textContent: '' };
  const document = {
    getElementById: (id) => {
      if (id === 'chat-container') return { innerHTML: '', appendChild() {} };
      if (id === 'welcome-template') return { content: { cloneNode: () => ({}) } };
      if (id === 'welcome-title') return title;
      return null;
    }
  };
  const factory = new Function(
    'document', 'localStorage',
    `${GREETING_SOURCE}\nfunction refreshWelcomeSubtitle() {}\n${extractFunction(html, 'renderWelcome')}\nreturn renderWelcome;`
  );
  const renderWelcome = factory(document, storage);
  let previous = null;
  for (let i = 0; i < 50; i++) {
    renderWelcome();
    assert.equal(storage.data.pg1_last_greeting, title.textContent);
    assert.notEqual(title.textContent, previous);
    previous = title.textContent;
  }
});

// --- subtitle ---

const SUBTITLE_SOURCE = `${extractConst(html, 'PLUS_MENU_HTML')}\n${extractFunction(html, 'welcomeSubtitle')}`;
// What a screen reader hears: tags dropped (the icon is aria-hidden, the
// sr-only span is read).
const spoken = (markup) => markup.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '');

test('welcomeSubtitle: errors, offline, degraded, then all clear', () => {
  const welcomeSubtitle = new Function(`${SUBTITLE_SOURCE}\nreturn welcomeSubtitle;`)();
  assert.equal(spoken(welcomeSubtitle('green', 3)), '3 errors need a look. Open the error log from the plus menu.');
  assert.equal(spoken(welcomeSubtitle('red', 2)), '2 errors need a look. Open the error log from the plus menu.');
  assert.equal(spoken(welcomeSubtitle('green', 1)), '1 error needs a look. Open the error log from the plus menu.');
  assert.equal(welcomeSubtitle('red', 0), "Can't reach the core right now. Messages will fail until it's back.");
  assert.equal(welcomeSubtitle('amber', 0), 'Responses may be slow right now.');
  assert.equal(welcomeSubtitle('green', 0), 'PG1 is online. Ask anything, or pick a starting point.');
});

test('welcomeSubtitle: the plus menu is the header line icon, aria-hidden, with sr-only text; no emoji', () => {
  const welcomeSubtitle = new Function(`${SUBTITLE_SOURCE}\nreturn welcomeSubtitle;`)();
  const markup = welcomeSubtitle('green', 2);
  assert.match(markup, /<svg class="icon icon-inline" aria-hidden="true" focusable="false"><use href="#i-plus"\/><\/svg>/);
  assert.match(markup, /<span class="sr-only">the plus menu<\/span>\.$/);
  // the same symbol the header ➕ button uses
  assert.match(html, /id="quick-menu-btn"[^>]*>[^]*?<use href="#i-plus"\/>/);
  for (const [state, n] of [['green', 2], ['red', 0], ['amber', 0], ['green', 0]]) {
    assert.doesNotMatch(welcomeSubtitle(state, n), /\p{Extended_Pictographic}/u);
  }
});

test('refreshWelcomeSubtitle: follows the status and error count, and is a no-op without an empty state', () => {
  const textEl = { innerHTML: 'PG1 is online. Ask anything, or pick a starting point.', writes: 0 };
  let welcomeShowing = true;
  const document = { querySelector: () => (welcomeShowing ? textEl : null) };
  const factory = new Function(
    'document',
    `let lastHealthState = 'green';\nlet lastUnresolvedErrorCount = 0;\n${SUBTITLE_SOURCE}\n${extractFunction(html, 'refreshWelcomeSubtitle')}\n` +
    'return { refreshWelcomeSubtitle, set: (s, n) => { lastHealthState = s; lastUnresolvedErrorCount = n; } };'
  );
  const { refreshWelcomeSubtitle, set } = factory(document);
  set('red', 0); refreshWelcomeSubtitle();
  assert.match(textEl.innerHTML, /^Can't reach the core/);
  set('amber', 0); refreshWelcomeSubtitle();
  assert.equal(textEl.innerHTML, 'Responses may be slow right now.');
  set('amber', 4); refreshWelcomeSubtitle();
  assert.equal(spoken(textEl.innerHTML), '4 errors need a look. Open the error log from the plus menu.');
  welcomeShowing = false;
  set('green', 0);
  assert.doesNotThrow(() => refreshWelcomeSubtitle());
  assert.equal(spoken(textEl.innerHTML), '4 errors need a look. Open the error log from the plus menu.');
});

test('renderIdleStatus and updateErrorLogBadge both refresh the welcome subtitle', () => {
  for (const name of ['renderIdleStatus', 'updateErrorLogBadge']) {
    assert.match(extractFunction(html, name), /refreshWelcomeSubtitle\(\)/, name);
  }
  assert.match(extractFunction(html, 'updateErrorLogBadge'), /lastUnresolvedErrorCount = unresolvedCount/);
});

// --- theme ---

const THEME_SOURCE = [
  extractConst(html, 'THEME_KEY'),
  extractConst(html, 'THEME_SETTINGS'),
  extractConst(html, 'THEME_COLORS'),
  extractConst(html, 'THEME_MEDIA'),
  extractFunction(html, 'getThemeSetting'),
  extractFunction(html, 'resolveTheme'),
  extractFunction(html, 'applyTheme'),
  extractFunction(html, 'setThemeSetting'),
  extractFunction(html, 'watchSystemTheme')
].join('\n');

function themeSandbox({ prefersLight = false, saved } = {}) {
  const storage = memoryStorage(saved ? { pg1_theme: saved } : {});
  const media = {
    matches: prefersLight,
    listeners: [],
    addEventListener(type, fn) { if (type === 'change') this.listeners.push(fn); },
    flip(next) { this.matches = next; this.listeners.forEach((fn) => fn({ matches: next })); }
  };
  const attrs = {};
  const meta = { content: '#0a0a0b', setAttribute(k, v) { if (k === 'content') this.content = v; } };
  const radios = ['system', 'light', 'dark'].map((value) => ({ value, checked: false }));
  const document = {
    documentElement: { setAttribute: (k, v) => { attrs[k] = v; } },
    querySelector: (sel) => (sel === 'meta[name="theme-color"]' ? meta : null),
    querySelectorAll: (sel) => (sel === '#theme-control input' ? radios : [])
  };
  const window = { matchMedia: (q) => { assert.equal(q, '(prefers-color-scheme: light)'); return media; } };
  const api = new Function(
    'window', 'document', 'localStorage',
    `${THEME_SOURCE}\nreturn { getThemeSetting, resolveTheme, applyTheme, setThemeSetting, watchSystemTheme };`
  )(window, document, storage);
  return {
    ...api, storage, media, meta, radios,
    theme: () => attrs['data-theme'],
    checked: () => radios.filter((r) => r.checked).map((r) => r.value)
  };
}

test('theme: defaults to System when nothing (or junk) is saved', () => {
  assert.equal(themeSandbox().getThemeSetting(), 'system');
  assert.equal(themeSandbox({ saved: 'sepia' }).getThemeSetting(), 'system');
  assert.equal(themeSandbox({ saved: 'light' }).getThemeSetting(), 'light');
});

test('theme: Light and Dark are saved, applied, and update theme-color and the control', () => {
  const t = themeSandbox({ prefersLight: false });
  assert.equal(t.setThemeSetting('light'), 'light');
  assert.equal(t.storage.data.pg1_theme, 'light');
  assert.equal(t.theme(), 'light');
  assert.equal(t.meta.content, '#f6f6f4');
  assert.deepEqual(t.checked(), ['light']);

  assert.equal(t.setThemeSetting('dark'), 'dark');
  assert.equal(t.storage.data.pg1_theme, 'dark');
  assert.equal(t.theme(), 'dark');
  assert.equal(t.meta.content, '#0a0a0b');
  assert.deepEqual(t.checked(), ['dark']);

  // A fresh load reads the saved choice back.
  const reloaded = themeSandbox({ saved: t.storage.data.pg1_theme, prefersLight: true });
  reloaded.applyTheme(reloaded.getThemeSetting());
  assert.equal(reloaded.theme(), 'dark');
});

test('theme: System follows prefers-color-scheme, live', () => {
  const t = themeSandbox({ prefersLight: true });
  t.watchSystemTheme();
  assert.equal(t.setThemeSetting('system'), 'light');
  assert.equal(t.storage.data.pg1_theme, 'system');
  assert.deepEqual(t.checked(), ['system']);
  assert.equal(t.meta.content, '#f6f6f4');

  t.media.flip(false);
  assert.equal(t.theme(), 'dark');
  assert.equal(t.meta.content, '#0a0a0b');
  t.media.flip(true);
  assert.equal(t.theme(), 'light');
});

test('theme: an explicit choice ignores the phone switching', () => {
  const t = themeSandbox({ prefersLight: false });
  t.watchSystemTheme();
  t.setThemeSetting('dark');
  t.media.flip(true);
  assert.equal(t.theme(), 'dark');
  t.setThemeSetting('light');
  t.media.flip(false);
  assert.equal(t.theme(), 'light');
});

test('theme: the <head> script sets data-theme before first paint, from the same key', () => {
  const head = html.slice(0, html.indexOf('<style>'));
  const script = head.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script, 'expected an inline script in <head> before the stylesheet');
  const run = (saved, prefersLight) => {
    const attrs = {};
    const meta = { setAttribute(k, v) { this[k] = v; } };
    new Function('localStorage', 'window', 'document', script[1])(
      { getItem: (k) => (k === 'pg1_theme' ? saved : null) },
      { matchMedia: () => ({ matches: prefersLight }) },
      { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } }, querySelector: () => meta }
    );
    return [attrs['data-theme'], meta.content];
  };
  assert.deepEqual(run(null, true), ['light', '#f6f6f4']);
  assert.deepEqual(run(null, false), ['dark', '#0a0a0b']);
  assert.deepEqual(run('system', true), ['light', '#f6f6f4']);
  assert.deepEqual(run('dark', true), ['dark', '#0a0a0b']);
  assert.deepEqual(run('light', false), ['light', '#f6f6f4']);
});

test('theme: the light theme overrides every colour token and keeps the shield gold', () => {
  const block = (selector) => {
    const start = html.indexOf(`${selector} {`);
    assert.ok(start !== -1, `${selector} block not found`);
    return html.slice(start, html.indexOf('}', start));
  };
  const tokens = (css) => new Set([...css.matchAll(/(--[\w-]+):\s*(?:#|rgba\(|url\()/g)].map((m) => m[1]));
  const dark = tokens(block(':root'));
  const light = tokens(block(':root[data-theme="light"]'));
  for (const name of dark) assert.ok(light.has(name), `light theme is missing ${name}`);
  for (const name of ['--shadow-1', '--shadow-2', '--shadow-3']) {
    assert.match(block(':root[data-theme="light"]'), new RegExp(`${name}:`), `light theme is missing ${name}`);
  }
  // shield is filled with the bright gold in both themes
  assert.match(block(':root[data-theme="light"]'), /--gold-fill: #f3c623;/);
  assert.equal((html.match(/style="fill: var\(--gold-fill\)"/g) || []).length, 2);
});

// --- empty-state header ---

test('header: lockup and status dot hide (and the border goes) only while the empty state is up', () => {
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const when = 'body:has(#chat-container > .message-bubble.welcome:only-child)';
  assert.ok(css.includes(`${when} .brand-wrap { opacity: 0; visibility: hidden; transition: none; }`));
  assert.ok(css.includes(`${when} .app-header { border-bottom-color: transparent; }`));
  // the menu button, ➕ button and badge sit outside .brand-wrap, so they stay
  const brand = html.slice(html.indexOf('<div class="brand-wrap">'), html.indexOf('<div class="header-btn-wrap">'));
  assert.ok(brand.includes('id="header-status-dot"'));
  for (const id of ['drawer-btn', 'quick-menu-btn', 'error-log-badge']) assert.ok(!brand.includes(`id="${id}"`), id);
  // fades back in with an opacity transition (the reduced-motion rule makes it instant)
  assert.match(css, /\.brand-wrap \{[^}]*transition: opacity var\(--dur-3\)/);
  assert.match(css, /prefers-reduced-motion: reduce[^]*?transition-duration: 0\.01ms !important/);
});

// --- sign-in screen ---

test('sign-in: tagline sits under the mark, "Operator access" heads the form, sr heading kept', () => {
  const form = html.slice(html.indexOf('<form id="auth-form"'), html.indexOf('</form>'));
  assert.match(form, /<h2 id="auth-title" class="sr-only">Sign in to PG1<\/h2>/);
  const head = form.slice(form.indexOf('<div class="gate-head">'), form.indexOf('</div>'));
  assert.match(head, /<use href="#pg1-lockup"\/><\/svg>\s*<p class="gate-tagline">Sovereign Threat Intelligence<\/p>\s*$/);
  assert.ok(!head.includes('Operator access'));
  const title = form.indexOf('<h3 class="gate-form-title">Operator access</h3>');
  assert.ok(title > form.indexOf('gate-tagline') && title < form.indexOf('id="auth-user"'));
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.match(css, /\.gate-tagline \{[^}]*text-transform: uppercase;[^}]*color: var\(--gold\);/);
});

test('sign-in: no "sessions end" note; muted mono signature pinned above the safe area, hidden on short viewports', () => {
  assert.ok(!html.includes('Sessions end when you close this tab.'));
  const gate = html.slice(html.indexOf('<div id="auth-modal"'), html.indexOf('<div id="vision-modal"'));
  assert.match(gate, /<\/form>\s*<p class="gate-signature">Project-Gifted1<sup>™<\/sup><\/p>/);
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const rule = css.match(/\.gate-signature \{[^}]*\}/)[0];
  for (const decl of ['position: fixed;', 'bottom: calc(var(--safe-bottom) + var(--sp-4));', 'font-family: var(--font-mono);', 'text-transform: uppercase;', 'color: var(--text-3);']) {
    assert.ok(rule.includes(decl), decl);
  }
  assert.match(css, /@media \(max-height: 640px\) \{\s*\.gate-signature \{ display: none; \}/);
});
