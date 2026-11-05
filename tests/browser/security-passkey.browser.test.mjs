/**
 * Passkey sign-in in a real browser: Chromium via Playwright as a Pixel 7
 * (Android Chrome's user agent, touch, phone viewport), with Chrome's own
 * virtual authenticator (CDP WebAuthn: a platform passkey with user
 * verification, like the phone's fingerprint). The page is public/ as
 * deployed; /api/security and /api/chat are the real handlers
 * (api/security.mjs, api/chat.mjs) on the suite's memory store, so the
 * WebAuthn checks, the cookie and the password refusal are the server's.
 *
 *   1. The gate offers "Sign in with passkey" first; with no passkey yet the
 *      password signs in and the server sets the session cookie (httpOnly,
 *      Secure, SameSite=Strict); from then on no request carries the
 *      password.
 *   2. "/security passkey add" makes a passkey on the phone; "/security
 *      passkeys" lists it.
 *   3. A reload resumes the session from the cookie, no gate.
 *   4. Without the cookie: the password is refused ("Password sign-in is
 *      off"), the passkey button signs in.
 * Writes docs/screenshots/security-passkey-gate-412.png for the PR.
 * Skipped (not failed) when Playwright or its Chromium is not installed.
 * Run with: node --import ./tests/helpers/spend-cap.mjs --test tests/browser/security-passkey.browser.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReplyFont } from '../helpers/replyFont.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');
const SHOTS_DIR = join(ROOT, 'docs', 'screenshots');

let chromium = null;
let devices = null;
let skip = false;
try {
  ({ chromium, devices } = await import('playwright'));
} catch (e) {
  skip = 'playwright is not installed (npm install)';
}
if (chromium && !existsSync(chromium.executablePath())) skip = `Chromium is not installed at ${chromium.executablePath()}`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.css': 'text/css; charset=utf-8' };
const OPERATOR = { user: 'gift', pass: 'correct horse battery staple' };

// The handlers take an express-like res; this wraps Node's.
function adapt(res) {
  const a = {
    setHeader: (k, v) => res.setHeader(k, v),
    getHeader: (k) => res.getHeader(k),
    status(c) { res.statusCode = c; return a; },
    json(b) { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(b)); return a; },
    end(x) { res.end(x); return a; },
    write: (...x) => res.write(...x),
    on: (...x) => res.on(...x)
  };
  return a;
}

async function startServer() {
  const { default: chatHandler } = await import('../../api/chat.mjs');
  const { createSecurityHandler } = await import('../../api/security.mjs');
  const security = createSecurityHandler({ push: null });
  const log = { bodies: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch (e) { parsed = null; }
      const json = (status, b) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (url.pathname.startsWith('/api/')) {
        log.bodies.push({ path: url.pathname, body: parsed || {}, cookie: !!req.headers.cookie });
        const r = { method: req.method, url: req.url, headers: req.headers, socket: req.socket, body: parsed };
        try {
          if (url.pathname === '/api/security') return await security(r, adapt(res));
          if (url.pathname === '/api/chat') {
            // A JSON reply (the page asks for a live trace; this test is
            // about the sign-in, not the stream).
            if (parsed) delete parsed.stream;
            return await chatHandler(r, adapt(res));
          }
        } catch (e) {
          return json(500, { error: String(e && e.message) });
        }
        if (url.pathname === '/api/health') return json(200, { status: 'ok' });
        return json(404, { error: 'not stubbed' });
      }
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = normalize(join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      const data = readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Length': data.length });
      res.end(data);
    });
  });
  // localhost, not 127.0.0.1: an IP address is not a valid WebAuthn RP ID.
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, log, origin: `http://localhost:${server.address().port}` };
}

async function lastReply(page) {
  return page.locator('#chat-container .message-bubble:not(.user):not(.pending)').last().innerText();
}

async function send(page, text) {
  await page.fill('#prompt-input', text);
  await page.press('#prompt-input', 'Enter');
}

test('passkey sign-in on Android Chrome: add a passkey from a password session, then the passkey is the way in', { skip, timeout: 120000 }, async () => {
  const saved = { ...process.env };
  process.env.USER_API_KEY = OPERATOR.user;
  process.env.USER_API_PASS = OPERATOR.pass;
  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASEAPI_KEY', 'PG1_PASSWORD_RECOVERY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) delete process.env[k];
  const { __clearAuthRateLimitState } = await import('../../api/chat.mjs');
  __clearAuthRateLimitState();
  const { server, log, origin } = await startServer();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ ...devices['Pixel 7'], colorScheme: 'dark' });
    // The reply font from a local copy (CI blocks the network).
    await routeReplyFont(context);
    await context.addInitScript(() => { try { localStorage.setItem('pg1_theme', 'dark'); } catch (e) {} });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    assert.match(await page.evaluate(() => navigator.userAgent).catch(() => devices['Pixel 7'].userAgent), /Android/);

    // Chrome's virtual authenticator: a platform passkey (the phone's own)
    // that verifies the user.
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true }
    });

    await page.goto(origin + '/');
    await page.waitForSelector('#auth-modal', { state: 'visible' });
    const passkeyBtn = page.locator('#passkey-signin-btn');
    await passkeyBtn.waitFor({ state: 'visible' });
    assert.equal((await passkeyBtn.innerText()).trim(), 'Sign in with passkey');
    assert.equal(await page.evaluate(() => typeof PG1Passkey === 'object' && PG1Passkey.supported()), true);
    // The passkey button comes before the password form.
    const order = await page.evaluate(() => {
      const b = document.getElementById('passkey-signin-btn');
      const p = document.getElementById('auth-pass');
      return !!(b.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    assert.equal(order, true);
    mkdirSync(SHOTS_DIR, { recursive: true });
    await page.screenshot({ path: join(SHOTS_DIR, 'security-passkey-gate-412.png') });

    // 1. No passkey yet: the password signs in, and the server sets the cookie.
    await page.fill('#auth-user', OPERATOR.user);
    await page.fill('#auth-pass', OPERATOR.pass);
    await page.press('#auth-pass', 'Enter');
    await page.waitForSelector('#auth-modal', { state: 'hidden' });
    const cookies = await context.cookies();
    const sc = cookies.find((c) => c.name === '__Host-pg1_session');
    assert.ok(sc, 'session cookie set');
    assert.equal(sc.httpOnly, true);
    assert.equal(sc.secure, true);
    assert.equal(sc.sameSite, 'Strict');
    assert.ok(sc.expires - Date.now() / 1000 <= 12 * 3600 + 5, 'at most 12 hours');
    assert.equal(await page.evaluate(() => document.cookie.includes('pg1_session')), false, 'the page cannot read it');

    // 2. Add a passkey on this phone.
    const signedInAt = log.bodies.length;
    await send(page, '/security passkey add');
    await page.waitForFunction(() => /Passkey added/.test(document.getElementById('chat-container').innerText), null, { timeout: 15000 });
    assert.match(await lastReply(page), /From now on, sign-in needs a passkey/);
    const creds = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    assert.equal(creds.credentials.length, 1);
    assert.equal(creds.credentials[0].isResidentCredential, true);
    assert.equal(creds.credentials[0].rpId, 'localhost');

    await send(page, '/security passkeys');
    await page.waitForFunction(() => /1 passkey\./.test(document.getElementById('chat-container').innerText), null, { timeout: 15000 });
    assert.match(await lastReply(page), /Android phone/);
    // After the cookie, no request carried the password.
    const after = log.bodies.slice(signedInAt);
    assert.ok(after.length >= 3);
    for (const b of after) {
      assert.equal('pass' in b.body, false, `${b.path} sent no password`);
      assert.equal(b.cookie, true, `${b.path} sent the cookie`);
    }

    // 3. A reload resumes the session from the cookie.
    await page.reload();
    await page.waitForSelector('#auth-modal', { state: 'hidden', timeout: 10000 });

    // 4. Without the cookie: the gate; the password alone is refused.
    await context.clearCookies();
    await page.reload();
    await page.waitForSelector('#auth-modal', { state: 'visible' });
    await page.waitForFunction(() => /Sign in with your passkey/.test(document.getElementById('auth-msg').textContent));
    await page.fill('#auth-user', OPERATOR.user);
    await page.fill('#auth-pass', OPERATOR.pass);
    await page.press('#auth-pass', 'Enter');
    await page.waitForFunction(() => /Password sign-in is off/.test(document.getElementById('auth-msg').textContent));
    assert.equal(await page.locator('#auth-modal').isVisible(), true);
    assert.equal((await context.cookies()).some((c) => c.name === '__Host-pg1_session'), false);

    // The passkey signs in.
    await passkeyBtn.tap();
    await page.waitForSelector('#auth-modal', { state: 'hidden', timeout: 15000 });
    assert.ok((await context.cookies()).some((c) => c.name === '__Host-pg1_session'), 'a new session cookie');
    await send(page, '/security passkeys');
    await page.waitForFunction(() => document.querySelectorAll('#chat-container .message-bubble').length && /last used 20\d\d-/.test(document.getElementById('chat-container').innerText), null, { timeout: 15000 });

    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
    server.close();
    __clearAuthRateLimitState();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
