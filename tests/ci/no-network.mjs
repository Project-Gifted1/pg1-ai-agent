/**
 * Network guard for CI: fails the test run if any test opens a connection
 * to anything other than this machine.
 *
 * Loaded into every Node process of the run with
 *   NODE_OPTIONS=--import=./tests/ci/no-network.mjs
 * (.github/workflows/tests.yml sets it; locally: the same, before npm test).
 *
 * - Node: every TCP/TLS connection (net, tls, http, https, undici and the
 *   built-in fetch) goes through net.Socket.prototype.connect. A connection
 *   to a host that is not loopback is refused with ECONNREFUSED-style error
 *   instead of being made.
 * - Chromium (tests/browser/): Playwright's chromium.launch() gets a proxy
 *   that refuses every request. Chromium never sends loopback traffic to a
 *   proxy, so the locally served pages and stubs still work, and requests
 *   a test fulfils with context.route() never reach it.
 *
 * Every refused attempt is printed to stderr, appended to the file named by
 * PG1_NET_GUARD_LOG (one JSON line each), and makes the process exit
 * non-zero, so the test file fails even if the code under test swallows the
 * connection error.
 */

import net from 'node:net';
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const LOG = process.env.PG1_NET_GUARD_LOG || '';
const LOOPBACK_NAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);

export function isLoopback(host) {
  const h = String(host ?? 'localhost').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '' || LOOPBACK_NAMES.has(h) || h.endsWith('.localhost')) return true;
  if (net.isIPv4(h)) return h.startsWith('127.');
  if (net.isIPv6(h)) return h === '::1' || /^::ffff:127\./.test(h);
  return false;
}

let violations = 0;
function record(kind, target) {
  violations++;
  const line = { kind, target, file: process.argv[1] || '', pid: process.pid };
  process.stderr.write(`\n[no-network] BLOCKED ${kind} connection to ${target} (${line.file}). Tests must use mocks/fixtures, not live services.\n`);
  if (LOG) {
    try { appendFileSync(LOG, JSON.stringify(line) + '\n'); } catch {}
  }
}
process.on('exit', (code) => {
  if (violations && code === 0) process.exitCode = 1;
});

// --- Node sockets -----------------------------------------------------------

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  let opts = args[0];
  if (Array.isArray(opts)) opts = opts[0]; // internal normalized form
  let host;
  let port;
  let path;
  if (opts && typeof opts === 'object') {
    ({ host, port, path } = opts);
  } else if (typeof opts === 'string' && !/^\d+$/.test(opts)) {
    path = opts;
  } else {
    port = opts;
    host = typeof args[1] === 'string' ? args[1] : undefined;
  }
  if (path || isLoopback(host)) return originalConnect.apply(this, args);

  const target = `${host}:${port}`;
  record('tcp', target);
  const err = Object.assign(new Error(`connect ECONNREFUSED ${target} (blocked by tests/ci/no-network.mjs)`), {
    code: 'ECONNREFUSED', syscall: 'connect', address: host, port
  });
  process.nextTick(() => this.destroy(err));
  return this;
};

// --- Chromium via Playwright --------------------------------------------------

let proxyUrl = null;
function denyProxy() {
  if (proxyUrl) return proxyUrl;
  proxyUrl = new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      record('browser', req.headers.host || req.url);
      res.writeHead(403, { 'content-type': 'text/plain' }).end('blocked by tests/ci/no-network.mjs');
    });
    server.on('connect', (req, socket) => {
      record('browser', req.url);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    server.on('connection', (s) => s.unref());
    server.listen(0, '127.0.0.1', () => {
      server.unref();
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
  return proxyUrl;
}

if (/\.browser\.test\.[cm]?js$/.test(process.argv[1] || '')) {
  let playwright = null;
  try { playwright = createRequire(`${process.cwd()}/`)('playwright'); } catch {}
  // Playwright sends loopback through the proxy too unless this is set;
  // with it, Chromium's own rule applies and loopback goes direct.
  process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
  for (const type of playwright ? [playwright.chromium] : []) {
    const launch = type.launch.bind(type);
    type.launch = async (options = {}) => launch({ ...options, proxy: { server: await denyProxy() } });
  }
}
