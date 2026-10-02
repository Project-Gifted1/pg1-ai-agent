/**
 * Conversation mode in a real browser (Chromium via Playwright).
 *
 * The Node tests in tests/voice-conversation.test.mjs drive the controller
 * with fakes and never touch the page's globals, which is how PR #236
 * shipped a module that threw "root is not defined" the moment the switch
 * was tapped on a phone. This test loads the actual page from public/ over
 * HTTP, with:
 *
 *  - a fake microphone (--use-fake-device-for-media-stream playing a silent
 *    WAV, --use-fake-ui-for-media-stream so no permission prompt), so the
 *    real getUserMedia / AudioContext / AudioWorklet path runs;
 *  - the real Silero VAD: onnxruntime-web and the model served from
 *    public/voice/ exactly as deployed (same URLs, same content types as
 *    vercel.json), so a broken wasm or model load fails here;
 *  - a stubbed SpeechRecognition (there is no speech service in a test
 *    browser) that the test feeds a transcript through;
 *  - a stub /api that signs the operator in and records what gets sent.
 *
 * It asserts: no page errors, no console errors, the Listening indicator
 * appears, a transcript followed by silence is auto-sent exactly once, and
 * switching off ends the microphone tracks. Three ways round:
 *
 *  - desktop-like: the mic stream and the recogniser share the microphone;
 *  - Android-like: an Android user agent, and a recogniser that fails with
 *    audio-capture whenever a page mic stream is live (Pixel 9a, Chrome:
 *    the system speech service and getUserMedia cannot both have the mic).
 *    The page must not hold a stream while recognising;
 *  - the same contention without the platform hint: the module has to
 *    notice the audio-capture error, let go of the stream and carry on.
 *
 * The Android scenario speaks the way Android Chrome's recogniser does:
 * every update carries the whole phrase heard so far (cumulative interims,
 * then cumulative finals), the session ends after the final, and the next
 * session hands the same final back again. Exactly one clean message must
 * come of it, in conversation mode and through the plain mic (dictation)
 * button, where the composer is checked instead of the request.
 *
 * The operator-only diagnostics line and the hands-off composer are
 * checked along the way.
 *
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: npm run test:browser   (or: node --test tests/browser/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');

let chromium = null;
let skip = false;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  skip = 'playwright is not installed (npm install)';
}
if (chromium && !existsSync(chromium.executablePath())) {
  skip = `Chromium is not installed at ${chromium.executablePath()} (npx playwright install chromium)`;
}

// Content types as the deployed app serves them (vercel.json for the voice
// binaries; Vercel's defaults for the rest).
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

// Serves public/ as the deployed origin does, and stubs the API routes the
// page calls. Every request is logged so the test can see what was sent
// and that nothing 404ed.
function startStubServer() {
  const log = { requests: [], missing: [] };
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch (e) { parsed = null; }
      log.requests.push({ method: req.method, path: url.pathname, body: parsed });
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/health') return json(res, 200, { status: 'ok' });
        if (url.pathname === '/api/errors') return json(res, 200, { errors: [], ok: true });
        if (url.pathname === '/api/handoffs') return json(res, 200, { handoffs: [] });
        if (url.pathname === '/api/chat') {
          if (parsed && parsed.prompt === 'AUTH_VERIFY') return json(res, 200, { authenticated: true });
          if (parsed && parsed.action === 'SPEAK') return json(res, 200, { audioStatus: 'SUCCESS' });
          return json(res, 200, { reply: 'Threat level is low. Nothing needs your attention.' });
        }
        log.missing.push(url.pathname);
        return json(res, 404, { error: 'not stubbed' });
      }
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = normalize(join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) {
        log.missing.push(url.pathname);
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not found');
      }
      const data = readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Length': data.length });
      res.end(data);
    });
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      resolveServer({ server, log, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// A silent 16 kHz mono 16-bit WAV for the fake microphone: the operator is
// quiet, so the only "speech" is the transcript the test feeds in.
function writeSilentWav(dir, seconds = 2) {
  const sampleRate = 16000;
  const samples = sampleRate * seconds;
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  const file = join(dir, 'silence.wav');
  writeFileSync(file, buf);
  return file;
}

// Installed before any page script: a SpeechRecognition the test can speak
// through, and a getUserMedia wrapper that keeps the streams it hands out.
// With `contention` set, the recogniser fails with audio-capture whenever a
// page mic stream is live, as on Android.
const PAGE_HOOKS = (contention) => `(() => {
  const T = window.__pg1Test = { instances: [], events: [], streams: [], contention: ${contention ? 'true' : 'false'} };
  const micIsTaken = () => T.streams.some((s) => s.getAudioTracks().some((tr) => tr.readyState === 'live'));
  class FakeSpeechRecognition {
    constructor() {
      this.continuous = false; this.interimResults = false; this.lang = '';
      this.onresult = null; this.onend = null; this.onerror = null; this.onstart = null;
      this.onspeechstart = null; this.onspeechend = null;
      this.running = false;
      T.instances.push(this);
    }
    start() {
      if (this.running) throw new DOMException('recognition has already started', 'InvalidStateError');
      this.running = true; T.events.push('start');
      if (this.onstart) this.onstart();
      if (T.contention && micIsTaken()) {
        setTimeout(() => {
          if (!this.running) return;
          T.events.push('error:audio-capture');
          if (this.onerror) this.onerror({ error: 'audio-capture', message: 'Audio capture failed.' });
          this.running = false;
          if (this.onend) this.onend();
        }, 30);
      }
    }
    stop() {
      T.events.push('stop');
      if (!this.running) return;
      this.running = false;
      setTimeout(() => { if (this.onend) this.onend(); }, 0);
    }
    abort() {
      T.events.push('abort');
      if (!this.running) return;
      this.running = false;
      setTimeout(() => { if (this.onend) this.onend(); }, 0);
    }
  }
  const current = () => T.instances.filter((x) => x.running).pop();
  const deliver = (r, text, isFinal) => {
    const alternatives = [{ transcript: text, confidence: 0.92 }];
    alternatives.isFinal = !!isFinal;
    r.onresult({ resultIndex: 0, results: [alternatives] });
  };
  // Delivers a result to whichever recogniser is running.
  T.hear = (text, isFinal) => {
    const r = current();
    if (!r || !r.onresult) return false;
    if (r.onspeechstart) r.onspeechstart();
    deliver(r, text, isFinal);
    if (isFinal && r.onspeechend) r.onspeechend();
    return true;
  };
  // Speaks a phrase the way Android Chrome's recogniser delivers one: the
  // whole phrase heard so far on every update, word by word as interims,
  // then again as finals ("what's", "what's in", "what's in my error log"),
  // after which the session ends on its own.
  T.speakAndroid = (text) => {
    const r = current();
    if (!r || !r.onresult) return false;
    const words = text.split(' ');
    if (r.onspeechstart) r.onspeechstart();
    for (let i = 1; i <= words.length; i++) deliver(r, words.slice(0, i).join(' '), false);
    for (const cut of [1, Math.ceil(words.length / 2), words.length]) deliver(r, words.slice(0, cut).join(' '), true);
    if (r.onspeechend) r.onspeechend();
    r.running = false; T.events.push('end');
    setTimeout(() => { if (r.onend) r.onend(); }, 0);
    return true;
  };
  // The running session ends on its own.
  T.endSession = () => {
    const r = current();
    if (!r) return false;
    r.running = false; T.events.push('end');
    setTimeout(() => { if (r.onend) r.onend(); }, 0);
    return true;
  };
  T.continuous = () => { const r = current(); return r ? r.continuous : null; };
  T.running = () => T.instances.filter((x) => x.running).length;
  T.liveTracks = () => T.streams.flatMap((s) => s.getAudioTracks().filter((tr) => tr.readyState === 'live')).length;
  window.SpeechRecognition = FakeSpeechRecognition;
  window.webkitSpeechRecognition = FakeSpeechRecognition;
  const md = navigator.mediaDevices;
  const getUserMedia = md.getUserMedia.bind(md);
  md.getUserMedia = async (constraints) => {
    const stream = await getUserMedia(constraints);
    T.streams.push(stream);
    return stream;
  };
})();`;

const TRANSCRIPT = 'what is the threat level today';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

const SCENARIOS = [
  { name: 'desktop-like: the mic stream and the recogniser share the microphone', contention: false, android: false, expectMode: 'shared' },
  { name: 'Android-like: an Android user agent and a recogniser that cannot share the mic', contention: true, android: true, expectMode: 'exclusive' },
  { name: 'contention without the platform hint: the recogniser fails with audio-capture while our stream is open', contention: true, android: false, expectMode: 'exclusive' }
];

for (const scenario of SCENARIOS) {
  test(`conversation mode in Chromium, ${scenario.name}: a transcript then silence is sent once, off ends the mic`, { skip, timeout: 180000 }, async (t) => {
    await runScenario(t, scenario);
  });
}

async function runScenario(t, scenario) {
  const { server, log, origin } = await startStubServer();
  const tmp = mkdtempSync(join(tmpdir(), 'pg1-voice-'));
  const wav = writeSilentWav(tmp);
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      '--autoplay-policy=no-user-gesture-required'
    ]
  });
  t.after(async () => {
    await browser.close();
    await new Promise((r) => server.close(r));
    rmSync(tmp, { recursive: true, force: true });
  });

  // A phone-sized page, like the Pixel 9a the bug was seen on.
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    permissions: ['microphone'],
    ...(scenario.android ? { userAgent: ANDROID_UA } : {})
  });
  await context.addInitScript(PAGE_HOOKS(scenario.contention));
  const page = await context.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  const consoleWarnings = [];
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
    else if (msg.type() === 'warning') consoleWarnings.push(msg.text());
  });
  page.on('requestfailed', (req) => consoleErrors.push(`request failed: ${req.url()} ${req.failure() && req.failure().errorText}`));

  await page.goto(origin + '/', { waitUntil: 'load' });
  assert.equal(await page.evaluate(() => typeof PG1Voice), 'object', 'public/voice/conversation.js loaded as a plain script');
  if (scenario.android) assert.ok(await page.evaluate(() => /Android/.test(navigator.userAgent)), 'the page sees an Android user agent');

  // Through the operator gate (the stub accepts anyone).
  await page.fill('#auth-user', 'operator');
  await page.fill('#auth-pass', 'passkey');
  await page.press('#auth-pass', 'Enter');
  await page.waitForSelector('#auth-modal', { state: 'hidden' });

  // The composer has the keyboard; conversation mode must take it away.
  await page.focus('#prompt-input');
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'prompt-input');

  // Tap the conversation switch.
  const toggle = page.locator('#converse-btn');
  await toggle.tap();
  // Either it is listening, or the page gave up (the switch went back to
  // off): the latter fails here with the toast and the error log, which on
  // the unfixed module read "root is not defined".
  const outcome = await page.waitForFunction(() => {
    const s = document.getElementById('converse-status');
    const label = s && s.querySelector('.converse-label');
    if (s && !s.hidden && label && label.textContent === 'Listening') return 'listening';
    const btn = document.getElementById('converse-btn');
    if (btn.getAttribute('aria-checked') === 'false' && !btn.hasAttribute('aria-busy')) return 'failed';
    return null;
  }, null, { timeout: 60000 }).then((h) => h.jsonValue());
  if (outcome !== 'listening') {
    const why = await page.evaluate(() => ({ toast: document.getElementById('status-toast').textContent, errors: getErrorLog().map((e) => e.message) }));
    assert.fail(`conversation mode did not start: toast "${why.toast}", errors ${JSON.stringify(why.errors)}, page errors ${JSON.stringify(pageErrors)}`);
  }

  assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'the switch is on');
  assert.equal(await page.locator('#converse-announcer').textContent(), 'Conversation on. Listening.');
  assert.ok(await page.locator('#converse-status').isVisible(), 'the Listening indicator is shown');
  assert.notEqual(await page.evaluate(() => document.activeElement && document.activeElement.id), 'prompt-input', 'the composer was blurred: no keyboard over a hands-free conversation');
  assert.deepEqual(pageErrors, [], 'no page errors while starting');
  assert.deepEqual(consoleErrors, [], 'no console errors while starting');
  const toastText = await page.locator('#status-toast').textContent();
  assert.doesNotMatch(toastText || '', /not defined|could not start|not available/i, `no error toast (got "${toastText}")`);

  // Under contention the module has to let go of its stream and restart the
  // recogniser; with the platform hint it never opens one.
  await page.waitForFunction((mode) => getConversation().micMode === mode && window.__pg1Test.running() === 1, scenario.expectMode, { timeout: 15000 });
  const started = await page.evaluate(() => ({
    vad: getConversation().vadName,
    state: getConversation().state,
    mode: getConversation().micMode,
    streams: window.__pg1Test.streams.length,
    live: window.__pg1Test.liveTracks(),
    recognisers: window.__pg1Test.running(),
    events: window.__pg1Test.events.slice(),
    note: document.getElementById('converse-note').hidden
  }));
  assert.equal(started.state, 'listening');
  assert.equal(started.mode, scenario.expectMode);
  assert.equal(started.recognisers, 1, 'the recogniser is running');
  if (scenario.expectMode === 'shared') {
    assert.equal(started.streams, 1, 'one microphone stream was opened');
    assert.equal(started.live, 1, 'its audio track is live beside the recogniser');
    assert.ok(!started.events.includes('error:audio-capture'));
  } else {
    assert.equal(started.live, 0, 'no page mic stream is live while the recogniser has the microphone');
    if (scenario.android) {
      assert.equal(started.streams, 0, 'Android: no stream of our own was ever opened while listening');
      assert.ok(!started.events.includes('error:audio-capture'), 'so the recogniser never failed');
    } else {
      assert.equal(started.streams, 1, 'the shared attempt opened one stream');
      assert.ok(started.events.includes('error:audio-capture'), 'which the recogniser could not live with');
    }
  }
  assert.equal(started.note, true, 'one failure is retried quietly: no status line');
  // The real Silero model on the real onnxruntime-web, from /voice/.
  assert.equal(started.vad, 'silero', `Silero loaded from public/voice (warnings: ${JSON.stringify(consoleWarnings)})`);
  assert.ok(log.requests.some((r) => r.path === '/voice/ort.wasm.min.js'), 'the runtime was fetched');
  assert.ok(log.requests.some((r) => r.path === '/voice/ort-wasm-simd-threaded.wasm'), 'the wasm binary was fetched');
  assert.ok(log.requests.some((r) => r.path === '/voice/silero_vad_v5.onnx'), 'the model was fetched');

  // Voice diagnostics: off by default, on from the drawer, nothing stored.
  assert.equal(await page.locator('#converse-diag').isHidden(), true, 'the diagnostics line is off by default');
  const storedBefore = await page.evaluate(() => Object.keys(localStorage).sort());
  await page.evaluate(() => openDrawer());
  await page.locator('#voice-diag-btn').tap();
  await page.evaluate(() => closeDrawer());
  assert.equal(await page.getAttribute('#voice-diag-btn', 'aria-checked'), 'true');
  await page.waitForFunction(() => !document.getElementById('converse-diag').hidden);
  const diag = await page.locator('#converse-diag').textContent();
  const expectErr = scenario.contention && !scenario.android ? 'audio-capture' : 'none';
  const expectMic = scenario.expectMode === 'shared' ? 'open' : 'closed';
  assert.match(diag, new RegExp(`^${scenario.expectMode} mic \\| rec running \\| last \\S+ \\| err ${expectErr} \\| heard "" \\| turn "" \\| vad (-|\\d\\.\\d\\d) \\| mic ${expectMic}$`), `diagnostics line: "${diag}"`);
  // Exclusive: one utterance per recogniser session. Shared: it runs on.
  assert.equal(await page.evaluate(() => window.__pg1Test.continuous()), scenario.expectMode === 'shared', `continuous recognition is for shared mode only (${scenario.expectMode})`);
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).sort()), storedBefore, 'nothing was stored');

  // The operator says something, the recogniser finalises it, then silence
  // (the silent microphone, or no further result): the turn is sent.
  const directives = () => log.requests.filter((r) => r.path === '/api/chat' && r.body && !r.body.action && r.body.prompt !== 'AUTH_VERIFY');
  assert.equal(directives().length, 0, 'nothing has been sent yet');
  assert.ok(await page.evaluate((text) => window.__pg1Test.hear(text.slice(0, 11), false), TRANSCRIPT), 'an interim result reached the recogniser');
  assert.match(await page.locator('#converse-diag').textContent(), /\| heard "what is the" \| turn "what is the" \|/, 'the interim text shows in the diagnostics line, as heard and as the turn');
  if (scenario.android) {
    // Android: the whole phrase on every update, as interims then finals.
    assert.ok(await page.evaluate((text) => window.__pg1Test.speakAndroid(text), TRANSCRIPT), 'the Android-pattern results reached the recogniser');
  } else {
    assert.ok(await page.evaluate((text) => window.__pg1Test.hear(text, true), TRANSCRIPT), 'the final transcript reached the recogniser');
  }
  const deadline = Date.now() + 15000;
  while (directives().length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(directives().length, 1, 'the transcript was auto-sent');
  assert.equal(directives()[0].body.prompt, TRANSCRIPT, 'as one clean phrase, not stacked');
  const sentAt = Date.now();
  if (scenario.android) {
    // The next session hands the same final back, then a late interim:
    // neither is the next turn.
    await page.waitForFunction(() => window.__pg1Test.running() === 1, null, { timeout: 5000 });
    assert.ok(await page.evaluate((text) => window.__pg1Test.hear(text, true) && window.__pg1Test.hear(text.slice(0, 7), false) && window.__pg1Test.endSession(), TRANSCRIPT), 'the repeated final reached the restarted recogniser');
    assert.ok(Date.now() - sentAt < 2500, 'the repeat arrived soon after the send, as it does on the phone');
  }

  // It shows as the operator's message, once and whole, the composer is
  // empty again and unfocused, and the conversation is back to listening
  // once the reply is in.
  await page.waitForFunction((text) => {
    const bubbles = Array.from(document.querySelectorAll('#chat-container .message-bubble.user .message-text'));
    return bubbles.some((b) => b.textContent.includes(text));
  }, TRANSCRIPT);
  const userMessages = await page.evaluate(() => Array.from(document.querySelectorAll('#chat-container .message-bubble.user .message-text')).map((b) => b.textContent.trim()));
  assert.deepEqual(userMessages, [TRANSCRIPT], 'one message, with the phrase once');
  assert.equal(await page.inputValue('#prompt-input'), '', 'the composer was cleared by the send');
  assert.notEqual(await page.evaluate(() => document.activeElement && document.activeElement.id), 'prompt-input', 'the send did not focus the composer');
  await page.waitForFunction(() => {
    const label = document.querySelector('#converse-status .converse-label');
    return label && label.textContent === 'Listening' && !document.querySelector('#chat-container .message-bubble.pending');
  });
  // Nothing is sent twice: not from the recogniser's flush, not from a
  // restart, not from the reply being read out.
  await new Promise((r) => setTimeout(r, Math.max(0, 2500 - (Date.now() - sentAt))));
  assert.equal(directives().length, 1, 'sent exactly once');
  assert.deepEqual(await page.evaluate(() => Array.from(document.querySelectorAll('#chat-container .message-bubble.user .message-text')).map((b) => b.textContent.trim())), [TRANSCRIPT], 'still one message');
  assert.equal(await page.evaluate(() => window.__pg1Test.running()), 1, 'listening again for the next turn');
  assert.equal(await page.evaluate(() => window.__pg1Test.liveTracks()), scenario.expectMode === 'shared' ? 1 : 0, 'the mic stream is as it should be for the mode');
  assert.equal(await page.locator('#converse-note').isHidden(), true, 'no persistent error was reported');

  // Off: the switch, the indicator, the microphone and the recogniser.
  await toggle.tap();
  await page.waitForFunction(() => document.getElementById('converse-btn').getAttribute('aria-checked') === 'false');
  const stopped = await page.evaluate(() => ({
    hidden: document.getElementById('converse-status').hidden,
    diagHidden: document.getElementById('converse-diag').hidden,
    announcer: document.getElementById('converse-announcer').textContent,
    tracks: window.__pg1Test.streams.flatMap((s) => s.getTracks().map((tr) => tr.readyState)),
    recognisers: window.__pg1Test.running(),
    on: getConversation().on
  }));
  assert.equal(stopped.on, false);
  assert.equal(stopped.hidden, true, 'the indicator is hidden');
  assert.equal(stopped.diagHidden, true, 'and so is the diagnostics line');
  assert.equal(stopped.announcer, 'Conversation off.');
  assert.ok(stopped.tracks.every((s) => s === 'ended'), `every microphone track ended (${stopped.tracks})`);
  if (scenario.expectMode === 'shared' || !scenario.android) assert.ok(stopped.tracks.length > 0, 'a stream was opened in this scenario');
  assert.equal(stopped.recognisers, 0, 'the recogniser was stopped');

  // The plain mic button (dictation) hears the same Android pattern: the
  // composer ends up with the phrase once, after whatever it already held.
  const mic = page.locator('#mic-btn');
  await mic.tap();
  await page.waitForFunction(() => document.getElementById('mic-btn').classList.contains('mic-active'));
  assert.equal(await page.evaluate(() => window.__pg1Test.running()), 1, 'dictation started its recogniser');
  assert.ok(await page.evaluate(() => window.__pg1Test.speakAndroid('open the vault')), 'the Android-pattern results reached dictation');
  await page.waitForFunction(() => !document.getElementById('mic-btn').classList.contains('mic-active'));
  assert.equal(await page.inputValue('#prompt-input'), 'open the vault', 'dictated once, not stacked');
  await mic.tap();
  await page.waitForFunction(() => document.getElementById('mic-btn').classList.contains('mic-active'));
  assert.ok(await page.evaluate(() => window.__pg1Test.speakAndroid('and the error log')));
  await page.waitForFunction(() => !document.getElementById('mic-btn').classList.contains('mic-active'));
  assert.equal(await page.inputValue('#prompt-input'), 'open the vault and the error log', 'a second press adds to what the composer held');
  assert.equal(directives().length, 1, 'dictation sends nothing by itself');

  // Nothing broke along the way, and nothing was logged as an error.
  assert.deepEqual(pageErrors, [], 'no page errors');
  assert.deepEqual(consoleErrors, [], 'no console errors');
  assert.deepEqual(log.missing, [], 'every URL the page asked for exists');
  const errorLog = await page.evaluate(() => getErrorLog().map((e) => e.message));
  assert.deepEqual(errorLog, [], 'the page recorded no errors');
}
