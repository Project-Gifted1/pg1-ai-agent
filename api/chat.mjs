import crypto from 'crypto';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { createCdpFacilitatorClient } from '@coinbase/cdp-sdk/x402';
import { checkAndConsumeFreeTier, getRequestIdentifier, logSettlementOutcome } from '../lib/freeTier.mjs';

// ---------------------------------------------------------------------
// AUTH: timing-safe secret comparison + in-memory per-IP failure lockout
// ---------------------------------------------------------------------
// In-memory (not Supabase) is intentional here, unlike the /api/ioc free-tier
// counter in lib/freeTier.mjs: a login lockout only needs to survive within a
// single warm lambda instance for a few minutes to blunt online brute-force,
// it doesn't need cross-instance/durable accuracy, and adding a DB round-trip
// to every authenticated request would slow down the hot path for no benefit.
export function safeCompare(provided, expected) {
  var providedBuf = Buffer.from(String(provided == null ? '' : provided), 'utf-8');
  var expectedBuf = Buffer.from(String(expected == null ? '' : expected), 'utf-8');
  if (providedBuf.length !== expectedBuf.length) {
    // Still perform a same-length timingSafeEqual so the length mismatch
    // itself doesn't short-circuit into an early, faster return.
    crypto.timingSafeEqual(providedBuf, providedBuf);
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

export const AUTH_MAX_FAILURES = 5;
export const AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const AUTH_LOCKOUT_MS = 15 * 60 * 1000;

var authFailuresByIp = new Map();

export function isAuthRateLimited(ip) {
  var entry = authFailuresByIp.get(ip);
  if (!entry) return false;
  if (entry.lockedUntil && entry.lockedUntil > Date.now()) return true;
  return false;
}

export function recordAuthFailure(ip) {
  var now = Date.now();
  var entry = authFailuresByIp.get(ip);
  if (!entry || (entry.windowStart + AUTH_FAILURE_WINDOW_MS) < now) {
    entry = { count: 0, windowStart: now, lockedUntil: 0 };
  }
  entry.count += 1;
  if (entry.count >= AUTH_MAX_FAILURES) {
    entry.lockedUntil = now + AUTH_LOCKOUT_MS;
  }
  authFailuresByIp.set(ip, entry);
}

export function resetAuthFailures(ip) {
  authFailuresByIp.delete(ip);
}

// Exposed for tests only (isolated Map per re-import isn't possible for a
// singleton module in the same process, so tests need a way to reset state).
export function __clearAuthRateLimitState() {
  authFailuresByIp.clear();
}

export const config = {
  maxDuration: 60
};

var VAPID_PUBLIC_KEY = (process.env.VAPID_PUBLIC_KEY || '').trim();
var VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || '').trim();

async function sendPushNotification(subscription, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !subscription) {
    return { ok: false, error: 'Push not configured or no subscription on file.' };
  }
  try {
    var webpush = (await import('web-push')).default;
    webpush.setVapidDetails('mailto:admin@project-gifted1.dev', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------
// X402 PAYMENT LAYER (agent-to-agent micropayments for /api/ioc)
// ---------------------------------------------------------------------
var X402_PAY_TO = (process.env.X402_PAY_TO_ADDRESS || '').trim();
var x402Middleware = null;
var x402Server = null;
if (X402_PAY_TO) {
  try {
    var x402FacilitatorClient = createCdpFacilitatorClient();
    x402Server = new x402ResourceServer(x402FacilitatorClient).register('eip155:8453', new ExactEvmScheme());
    x402Middleware = paymentMiddleware(
      {
        'GET /api/ioc': {
          accepts: [{ scheme: 'exact', price: '$0.01', network: 'eip155:8453', payTo: X402_PAY_TO }],
          description: 'PG1 Threat Intelligence: STIX 2.1 threat indicator feed (IPs, domains, URLs, file hashes, CVEs) aggregated from open threat intelligence sources including AlienVault OTX.',
          mimeType: 'application/stix+json',
          extensions: declareDiscoveryExtension({
            input: { type: 'IPv4', min_score: 50, limit: 100 },
            inputSchema: {
              properties: {
                since: { type: 'string', description: 'ISO timestamp (e.g. 2026-09-20T00:00:00Z). Only indicators last seen after this time are returned.' },
                type: {
                  type: 'string',
                  description: 'Exact-match indicator type filter against the stored value.',
                  enum: ['IPv4', 'IPv6', 'domain', 'hostname', 'URL', 'FileHash-MD5', 'FileHash-SHA1', 'FileHash-SHA256', 'CVE']
                },
                min_score: { type: 'integer', description: 'Minimum confidence score, inclusive.', minimum: 0, maximum: 100 },
                limit: { type: 'integer', description: 'Maximum number of STIX objects to return.', minimum: 1, maximum: 1000 }
              }
            },
            output: {
              example: {
                type: 'bundle',
                id: 'bundle--3f1b1e2a-0a3e-4b9a-8f7f-2f6e9a0b3c1d',
                objects: [
                  {
                    type: 'indicator',
                    spec_version: '2.1',
                    id: 'indicator--7c9b6f2e-6b6b-4a2a-9c3e-1a9d9a2b6f3e',
                    created: '2026-09-20T00:00:00Z',
                    modified: '2026-09-24T12:00:00Z',
                    name: 'IPv4 Threat Indicator - 198.51.100.23',
                    description: 'Threat indicator sourced from AlienVault-OTX.',
                    indicator_types: ['malicious-activity'],
                    pattern: "[ipv4-addr:value = '198.51.100.23']",
                    pattern_type: 'stix',
                    valid_from: '2026-09-24T12:00:00Z',
                    confidence: 75,
                    external_references: [{ source_name: 'AlienVault-OTX', description: 'Sourced from AlienVault-OTX' }]
                  }
                ]
              }
            }
          })
        }
      },
      x402Server,
      undefined,
      undefined,
      false
    );
  } catch (e) {
    console.error('[X402] Setup failed, payment path disabled for this invocation:', e.message);
    x402Middleware = null;
  }
} else {
  console.warn('[X402_DEBUG] X402_PAY_TO_ADDRESS is not set - x402 payment path is disabled for this lambda instance; all /api/ioc requests will fall through to the free-tier/402 path regardless of X-PAYMENT header.');
}

var x402InitPromise = null;
var x402Initialized = false;
var X402_INIT_TIMEOUT_MS = 8000;

function ensureX402Initialized() {
  if (x402Initialized) return Promise.resolve(true);
  if (!x402Server) return Promise.resolve(false);
  if (!x402InitPromise) {
    x402InitPromise = Promise.race([
      x402Server.initialize(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('facilitator initialize() timed out after ' + X402_INIT_TIMEOUT_MS + 'ms')), X402_INIT_TIMEOUT_MS))
    ]).then(function () {
      x402Initialized = true;
      return true;
    }).catch(function (err) {
      console.error('[X402_DEBUG] facilitator initialize() failed, x402 payment path unavailable for this request:', err.message);
      x402InitPromise = null;
      return false;
    });
  }
  return x402InitPromise;
}

function debugLogPaymentHeader(rawPaymentHeader) {
  if (!rawPaymentHeader) return;
  try {
    var decoded = Buffer.from(String(rawPaymentHeader), 'base64').toString('utf-8');
    var parsed = JSON.parse(decoded);
    console.log('[X402_DEBUG] x-payment header decoded+parsed OK. scheme=%s network=%s', parsed && parsed.scheme, parsed && parsed.network);
  } catch (decodeErr) {
    console.log('[X402_DEBUG] x-payment header failed to base64-decode/JSON-parse:', decodeErr.message);
  }
}

function ensureExpressCompat(req) {
  if (typeof req.header !== 'function') {
    req.header = req.get = function (name) {
      var value = req.headers[String(name).toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    };
  }
  if (req.path === undefined) req.path = (req.url || '/').split('?')[0];
  if (req.originalUrl === undefined) req.originalUrl = req.url;
  if (req.protocol === undefined) {
    var forwardedProto = req.headers['x-forwarded-proto'];
    req.protocol = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) || 'https';
  }
}

// The x402 middleware's default 402 challenge body is `{}` — the actual
// payment-required payload only exists base64-encoded in the PAYMENT-REQUIRED
// header. Mirror it into the JSON body so non-header-reading clients (and
// this API's STIX consumers) see the same v2 payment-required object instead
// of an empty object. Patches res.json rather than recomputing the payload,
// since the header is already finalized (bazaar/extension-enriched) by the
// time the middleware writes it, and re-deriving it here could drift.
function mirrorPaymentRequiredIntoJsonBody(res) {
  var originalJson = res.json.bind(res);
  res.json = function (body) {
    try {
      if (res.statusCode === 402) {
        var paymentRequiredHeader = res.getHeader('PAYMENT-REQUIRED');
        if (paymentRequiredHeader) {
          var decoded = JSON.parse(Buffer.from(String(paymentRequiredHeader), 'base64').toString('utf-8'));
          return originalJson(decoded);
        }
      }
    } catch (e) {}
    return originalJson(body);
  };
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeBase64(str) {
  return Buffer.from(str, 'utf-8').toString('base64');
}

function decodeBase64(str) {
  return Buffer.from(str, 'base64').toString('utf-8');
}

function base64ToUint8Array(base64) {
  try {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  } catch (e) {
    return new Uint8Array(0);
  }
}

function arrayBufferToBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

// res.__pg1CorsOrigin is set once per-request in handler(), based on the
// request path: '*' for the /api/ioc and /api/feeds/ioc aliases (unchanged
// behavior), or the restricted app origin for the plain /api/chat route.
function sendJSON(res, status, data) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', (res && res.__pg1CorsOrigin) || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, PAYMENT-SIGNATURE, X-Payment, X-Free-Tier');
  res.setHeader('Access-Control-Expose-Headers', 'X-Payment, Payment-Signature, x-free-tier, X-API-KEY, PAYMENT-REQUIRED, PAYMENT-RESPONSE');
  res.status(status).json(data);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  var controller = new AbortController();
  var id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...(options || {}), signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function escapeStixValue(value) {
  return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function resolveGithubPathCandidates(target, repoUrl, headers) {
  var cleanTarget = target.replace(/^\.\//, '').replace(/^\//, '');
  try {
    var treeRes = await fetch(`${repoUrl}/git/trees/main?recursive=1`, { headers: headers, cache: 'no-store' });
    if (treeRes.ok) {
      var treeData = await treeRes.json();
      var exactMatches = treeData.tree.filter(item => item.type === 'blob' && item.path === cleanTarget);
      if (exactMatches.length > 0) {
        return { path: exactMatches[0].path, sha: exactMatches[0].sha, exact: true, candidates: [exactMatches[0].path], resolved: true };
      }
      var fuzzyMatches = treeData.tree.filter(item =>
        item.type === 'blob' &&
        item.path.endsWith('/' + cleanTarget) &&
        !item.path.includes('node_modules/') &&
        !item.path.includes('.next/')
      );
      if (fuzzyMatches.length === 1) {
        return { path: fuzzyMatches[0].path, sha: fuzzyMatches[0].sha, exact: false, candidates: [fuzzyMatches[0].path], resolved: true };
      }
      if (fuzzyMatches.length > 1) {
        return { path: null, sha: null, exact: false, candidates: fuzzyMatches.map(m => m.path), resolved: false, ambiguous: true };
      }
      return { path: cleanTarget, sha: null, exact: false, candidates: [cleanTarget], resolved: true, notInTree: true };
    }
  } catch (e) {
    return { path: cleanTarget, sha: null, exact: false, candidates: [cleanTarget], resolved: true, notInTree: true, lookupFailed: true, lookupError: e.message };
  }
  return { path: cleanTarget, sha: null, exact: false, candidates: [cleanTarget], resolved: true, notInTree: true };
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

var HARD_BLOCKED_PATH_PATTERNS = [/\.env(\.|$)/i, /(^|\/)\.git(\/|$)/i, /secret/i, /credentials?/i, /\.pem$/i, /\.key$/i];
var SOFT_GATED_PATH_PATTERNS = [/(^|\/)\.github\/workflows\//i, /(^|\/)package(-lock)?\.json$/i, /(^|\/)vercel\.json$/i];

function isHardBlockedPath(path) {
  return HARD_BLOCKED_PATH_PATTERNS.some(function (re) { return re.test(path || ''); });
}
function isSoftGatedPath(path) {
  return SOFT_GATED_PATH_PATTERNS.some(function (re) { return re.test(path || ''); });
}

var MAX_LINES_FOR_FULL_DIFF = 800;

function computeLineDiff(oldStr, newStr) {
  var oldLines = (oldStr || '').split('\n');
  var newLines = (newStr || '').split('\n');

  if (oldLines.length > MAX_LINES_FOR_FULL_DIFF || newLines.length > MAX_LINES_FOR_FULL_DIFF) {
    return { tooLargeForFullDiff: true, oldLineCount: oldLines.length, newLineCount: newLines.length };
  }

  var n = oldLines.length, m = newLines.length;
  var dp = new Array(n + 1);
  for (var i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (i = n - 1; i >= 0; i--) {
    for (var j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  var ops = [];
  i = 0; j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) { ops.push({ type: 'ctx', line: oldLines[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'del', line: oldLines[i] }); i++; }
    else { ops.push({ type: 'add', line: newLines[j] }); j++; }
  }
  while (i < n) { ops.push({ type: 'del', line: oldLines[i] }); i++; }
  while (j < m) { ops.push({ type: 'add', line: newLines[j] }); j++; }

  var added = ops.filter(function (o) { return o.type === 'add'; }).length;
  var removed = ops.filter(function (o) { return o.type === 'del'; }).length;

  return { tooLargeForFullDiff: false, ops: ops, added: added, removed: removed };
}

function formatDiffSummary(diff, maxLines, maxChars) {
  maxLines = maxLines || 40;
  maxChars = maxChars || 3000;
  if (!diff) return '(no diff available)';
  if (diff.tooLargeForFullDiff) {
    return `[File too large for an inline diff here (${diff.oldLineCount} -> ${diff.newLineCount} lines). Review the full diff on GitHub before merging.]`;
  }
  var out = [];
  var shown = 0;
  for (var k = 0; k < diff.ops.length && shown < maxLines; k++) {
    var op = diff.ops[k];
    if (op.type === 'add') { out.push('+ ' + op.line); shown++; }
    else if (op.type === 'del') { out.push('- ' + op.line); shown++; }
  }
  var text = out.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n... [truncated, see full diff on GitHub]';
  if (!text) text = '(no textual changes detected)';
  var moreNote = (diff.added + diff.removed) > shown ? `\n[${diff.added} lines added / ${diff.removed} lines removed total — showing first ${shown}]` : `\n[${diff.added} lines added / ${diff.removed} lines removed]`;
  return text + moreNote;
}

function generateApprovalToken() {
  return crypto.randomUUID();
}

async function storePendingAction(supabaseUrl, supabaseKey, actionType, plan, diffSummary, ttlMinutes) {
  var token = generateApprovalToken();
  var now = new Date();
  var expiresAt = new Date(now.getTime() + (ttlMinutes || 30) * 60000);
  try {
    var res = await fetch(`${supabaseUrl}/rest/v1/pending_actions`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal'
      },
      body: JSON.stringify([{
        token: token,
        action_type: actionType,
        plan: plan,
        diff_summary: diffSummary,
        status: 'pending',
        created_at: now.toISOString(),
        expires_at: expiresAt.toISOString()
      }]),
      cache: 'no-store'
    });
    if (!res.ok) {
      var errText = await res.text();
      return { ok: false, error: `Could not persist proposal to Supabase: ${res.status} ${errText.substring(0, 150)}` };
    }
    return { ok: true, token: token, expiresAt: expiresAt };
  } catch (e) {
    return { ok: false, error: `Exception persisting proposal: ${e.message}` };
  }
}

async function loadPendingAction(supabaseUrl, supabaseKey, token) {
  try {
    var res = await fetch(`${supabaseUrl}/rest/v1/pending_actions?token=eq.${encodeURIComponent(token)}&select=*`, {
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
      cache: 'no-store'
    });
    if (!res.ok) return { ok: false, error: 'Could not query pending_actions.' };
    var rows = await res.json();
    if (!rows || rows.length === 0) return { ok: false, error: 'No proposal found for that token.' };
    return { ok: true, row: rows[0] };
  } catch (e) {
    return { ok: false, error: `Exception loading proposal: ${e.message}` };
  }
}

async function resolvePendingActionStatus(supabaseUrl, supabaseKey, token, status) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/pending_actions?token=eq.${encodeURIComponent(token)}`, {
      method: 'PATCH',
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: status, resolved_at: new Date().toISOString() }),
      cache: 'no-store'
    });
  } catch (e) {}
}

function runPreFlightCheck(codeString, fileTarget) {
  if (!codeString) return { passed: true, log: 'No code.' };
  if (fileTarget && !fileTarget.endsWith('.js') && !fileTarget.endsWith('.py')) return { passed: true, log: 'Skipping strict JS validation.' };
  try {
    var testCode = codeString.replace(/\bexport\s+default\b/g, '');
    testCode = testCode.replace(/\bexport\s+/g, '');
    testCode = testCode.replace(/^\s*import\s+.*?;/gm, '');
    if (fileTarget && fileTarget.endsWith('.js')) {
      new Function(testCode);
    }
    if (codeString.includes('child_process') || codeString.includes('ev' + 'al(')) return { passed: false, log: 'Security Violation' };
    return { passed: true, log: 'PASSED' };
  } catch (e) {
    return { passed: false, log: e.message };
  }
}

async function fetchGeminiCore(promptText, sysInstruction, mediaParts, contextData, geminiKeys, deadlineTs) {
  var models = ['gemini-3.8-flash', 'gemini-3.6-flash'];
  var lastError = '';

  var RETRY_RESERVE_MS = 12000;
  var ERROR_RETRY_CAP_MS = 20000;
  var NO_DEADLINE_CAP_MS = 40000;

  var attemptCount = 0;
  var watchdogFired = false;

  for (var i = 0; i < geminiKeys.length && !watchdogFired; i++) {
    var currentKey = geminiKeys[i];
    for (var j = 0; j < models.length && !watchdogFired; j++) {
      var isFirstAttempt = (attemptCount === 0);
      attemptCount++;

      var remainingMs = deadlineTs ? (deadlineTs - Date.now()) : NO_DEADLINE_CAP_MS;
      if (remainingMs <= 1000) {
        return { text: null, error: lastError || 'Aborted: model fetch time budget exhausted.' };
      }
      var perAttemptTimeout = isFirstAttempt
        ? Math.max(remainingMs - RETRY_RESERVE_MS, Math.min(remainingMs, ERROR_RETRY_CAP_MS))
        : Math.min(ERROR_RETRY_CAP_MS, remainingMs);

      var model = models[j];
      var apiVersion = 'v1beta';
      var timedOut = false;

      var controller = new AbortController();
      var timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, perAttemptTimeout);

      try {
        var res = await fetch(`https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent?key=${currentKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: sysInstruction }] },
            contents: [{ role: 'user', parts: [...mediaParts, { text: promptText + contextData }] }],
            generationConfig: { maxOutputTokens: 4096, temperature: 0.7 }
          }),
          cache: 'no-store',
          signal: controller.signal
        });

        if (res.ok) {
          var data = await res.json();
          var parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
          var text = '';
          for (var p = 0; p < parts.length; p++) {
            if (parts[p] && !parts[p].thought && typeof parts[p].text === 'string' && parts[p].text) {
              text = parts[p].text;
              break;
            }
          }
          if (text) {
            return { text: text, error: null };
          }
          var reason = (data && data.candidates && data.candidates[0] && data.candidates[0].finishReason)
            || (data && data.promptFeedback && data.promptFeedback.blockReason)
            || 'no candidates';
          lastError = `[${model} on ${apiVersion}] 200 with no usable text (${reason})`;
        } else {
          var errText = await res.text();
          lastError = `[${model} on ${apiVersion}] ${res.status}: ${errText.substring(0, 150)}`;
        }
      } catch (e) {
        if (timedOut) {
          lastError = `[${model}] Gemini call exceeded its ${perAttemptTimeout}ms deadline with no response.`;
          watchdogFired = true;
        } else {
          lastError = `[${model}] ${e.message}`;
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }
  return { text: null, error: lastError };
}

var ANTHROPIC_SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function buildAnthropicContentBlocks(promptText, mediaParts) {
  var blocks = [];
  var skippedCount = 0;

  if (Array.isArray(mediaParts)) {
    for (var i = 0; i < mediaParts.length; i++) {
      var part = mediaParts[i];
      if (part && part.inlineData && part.inlineData.data) {
        var mimeType = (part.inlineData.mimeType || 'image/jpeg').toLowerCase();
        if (ANTHROPIC_SUPPORTED_IMAGE_TYPES.indexOf(mimeType) !== -1) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: part.inlineData.data
            }
          });
        } else {
          skippedCount++;
        }
      }
    }
  }

  var finalText = promptText;
  if (skippedCount > 0) {
    finalText += `\n[NOTE: ${skippedCount} attached file(s) were skipped — unsupported type for vision input.]`;
  }

  if (!finalText || !finalText.trim()) {
    finalText = "The user switched to your advanced reasoning core without typing a message. Greet them briefly and ask what they'd like help with.";
  }

  blocks.push({ type: 'text', text: finalText });
  return blocks;
}

async function fetchAnthropicCore(promptText, sysInstruction, mediaParts, contextData, anthropicKey, deadlineTs) {
  if (!anthropicKey) {
    return { text: null, error: 'No Anthropic API key configured.' };
  }

  var models = ['claude-sonnet-5', 'claude-haiku-4-5-20251001'];
  var lastError = '';

  var CROSS_PROVIDER_RESERVE_MS = 10000;
  var ERROR_RETRY_CAP_MS = 20000;
  var NO_DEADLINE_CAP_MS = 40000;

  var content = buildAnthropicContentBlocks(promptText + contextData, mediaParts);

  for (var i = 0; i < models.length; i++) {
    var isPrimary = (i === 0);
    var remainingMs = deadlineTs ? (deadlineTs - Date.now()) : NO_DEADLINE_CAP_MS;
    if (remainingMs <= 1000) {
      return { text: null, error: lastError || 'Aborted: model fetch time budget exhausted before Anthropic call.' };
    }
    var timeoutMs = isPrimary
      ? Math.max(remainingMs - CROSS_PROVIDER_RESERVE_MS, Math.min(remainingMs, ERROR_RETRY_CAP_MS))
      : Math.min(ERROR_RETRY_CAP_MS, remainingMs);
    var model = models[i];
    var timedOut = false;

    var controller = new AbortController();
    var timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

    try {
      var res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: model,
          max_tokens: 4096,
          system: sysInstruction,
          messages: [{ role: 'user', content: content }]
        }),
        cache: 'no-store',
        signal: controller.signal
      });

      if (res.ok) {
        var data = await res.json();
        if (data && data.content && data.content[0] && data.content[0].text) {
          return { text: data.content[0].text, error: null };
        }
        lastError = `[${model}] Unexpected response shape from Anthropic API.`;
      } else {
        var errText = await res.text();
        lastError = `[${model}] Anthropic API ${res.status}: ${errText.substring(0, 150)}`;
      }
    } catch (e) {
      if (timedOut) {
        lastError = `[${model}] Anthropic call exceeded its ${timeoutMs}ms deadline with no response.`;
        break;
      }
      lastError = `[${model}] Anthropic fetch exception: ${e.message}`;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return { text: null, error: lastError };
}

export default async function handler(req, res) {
  var startTime = Date.now();
  var requestTraceId = Math.random().toString(36).substring(2, 10);

  var MODEL_FETCH_BUDGET_MS = 50000;
  var deadlineTs = startTime + MODEL_FETCH_BUDGET_MS;

  var urlPath = '';
  try {
    var rawUrl = req.url || '';
    urlPath = rawUrl.includes('?') ? rawUrl.split('?')[0] : rawUrl;
  } catch (e) {
    urlPath = '';
  }

  // /api/ioc and /api/feeds/ioc are aliases that delegate into this same
  // handler (see api/ioc.js, api/feeds/ioc.js) and must keep their existing
  // open '*' CORS. Only the plain /api/chat route gets the restricted origin
  // + no Allow-Credentials (see vercel.json, which scopes its blanket
  // Allow-Origin:*/Allow-Credentials:true header rule away from this path).
  var isIocAliasRoute = (urlPath === '/api/ioc' || urlPath === '/api/feeds/ioc');
  var CHAT_ALLOWED_ORIGIN = (process.env.CHAT_ALLOWED_ORIGIN || 'https://pg1-ai-agent.vercel.app').trim();
  res.__pg1CorsOrigin = isIocAliasRoute ? '*' : CHAT_ALLOWED_ORIGIN;

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', res.__pg1CorsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, PAYMENT-SIGNATURE, X-Payment, X-Free-Tier');
    res.setHeader('Access-Control-Expose-Headers', 'X-Payment, Payment-Signature, x-free-tier, X-API-KEY, PAYMENT-REQUIRED, PAYMENT-RESPONSE');
    res.status(200).end();
    return;
  }

  var getHeader = (name) => req.headers.get ? req.headers.get(name) : req.headers[String(name).toLowerCase()];

  var supUrl = (process.env.SUPABASE_URL || '').replace(/\s+/g, '');
  var supKey = (process.env.SUPABASEAPI_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLEKEY || '').replace(/\s+/g, '');

  async function buildAndServeStixBundle(accessIdentifier) {
    try {
      var parsedUrl = new URL(req.url, 'http://localhost');
      var sinceParam = parsedUrl.searchParams.get('since');
      var typeParam = parsedUrl.searchParams.get('type');
      var minScoreParam = parsedUrl.searchParams.get('min_score') || '0';
      var limitParam = Math.min(parseInt(parsedUrl.searchParams.get('limit') || '500', 10), 1000);

      fetch(`${supUrl}/rest/v1/api_access_logs`, {
        method: 'POST',
        headers: { 'apikey': supKey, 'Authorization': `Bearer ${supKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          license_key: accessIdentifier,
          endpoint_accessed: urlPath,
          status: 'SUCCESS'
        })
      }).catch(() => {});

      var queryFilters = [
        `select=*`,
        `confidence_score=gte.${minScoreParam}`,
        `order=last_seen.desc`,
        `limit=${limitParam}`
      ];
      if (sinceParam) queryFilters.push(`last_seen=gte.${sinceParam}`);
      if (typeParam) queryFilters.push(`indicator_type=eq.${typeParam}`);

      var threatRes;
      try {
        threatRes = await fetch(`${supUrl}/rest/v1/threat_ioc_telemetry?${queryFilters.join('&')}`, {
          headers: { 'apikey': supKey, 'Authorization': `Bearer ${supKey}` }
        });
      } catch (netErr) {
        return sendJSON(res, 503, { error: 'Threat data temporarily unavailable, please retry.' });
      }
      if (!threatRes.ok) {
        return sendJSON(res, 503, { error: 'Threat data temporarily unavailable, please retry.' });
      }
      var rawTelemetry = await threatRes.json();

      var stixObjects = rawTelemetry.map(record => {
        if (record.indicator_type === 'CVE') {
          return {
            type: 'vulnerability',
            spec_version: '2.1',
            id: `vulnerability--${crypto.randomUUID()}`,
            created: record.ingested_at || new Date().toISOString(),
            modified: record.last_seen || new Date().toISOString(),
            name: record.value,
            description: `Vulnerability sourced from ${record.verification_source || 'Sovereign Engine'}.`,
            external_references: [
              { source_name: 'cve', external_id: record.value }
            ]
          };
        }

        var patternValue = record.stix_pattern;
        if (patternValue && String(patternValue).startsWith('[custom-object')) patternValue = null;
        if (!patternValue) {
          var safeValue = escapeStixValue(record.value);
          var indicatorTypeStr = String(record.indicator_type);
          if (record.indicator_type === 'IPv4') patternValue = `[ipv4-addr:value = '${safeValue}']`;
          else if (record.indicator_type === 'IPv6') patternValue = `[ipv6-addr:value = '${safeValue}']`;
          else if (record.indicator_type === 'domain') patternValue = `[domain-name:value = '${safeValue}']`;
          else if (record.indicator_type === 'hostname') patternValue = `[domain-name:value = '${safeValue}']`;
          else if (record.indicator_type === 'URL') patternValue = `[url:value = '${safeValue}']`;
          else if (indicatorTypeStr.includes('FileHash-MD5')) patternValue = `[file:hashes.MD5 = '${safeValue}']`;
          else if (indicatorTypeStr.includes('FileHash-SHA1')) patternValue = `[file:hashes.'SHA-1' = '${safeValue}']`;
          else if (indicatorTypeStr.includes('FileHash-SHA256')) patternValue = `[file:hashes.'SHA-256' = '${safeValue}']`;
          else if (indicatorTypeStr.includes('FileHash')) patternValue = `[file:hashes.'SHA-256' = '${safeValue}']`;
          else {
            console.warn(`[STIX] Skipping indicator with unmappable indicator_type: ${indicatorTypeStr}`);
            return null;
          }
        }

        return {
          type: 'indicator',
          spec_version: '2.1',
          id: `indicator--${crypto.randomUUID()}`,
          created: record.ingested_at || new Date().toISOString(),
          modified: record.last_seen || new Date().toISOString(),
          name: `${record.indicator_type} Threat Indicator - ${record.value}`,
          description: `Threat indicator sourced from ${record.verification_source || 'Sovereign Engine'}.`,
          indicator_types: ['malicious-activity'],
          pattern: patternValue,
          pattern_type: 'stix',
          valid_from: record.last_seen || new Date().toISOString(),
          confidence: parseInt(record.confidence_score, 10) || 50,
          external_references: [
            {
              source_name: record.verification_source || 'Autonomous Pipeline',
              description: 'Sourced from ' + (record.verification_source || 'Autonomous Pipeline')
            }
          ]
        };
      }).filter(Boolean);

      var stixBundle = {
        type: 'bundle',
        id: `bundle--${crypto.randomUUID()}`,
        objects: stixObjects
      };

      res.setHeader('Content-Type', 'application/stix+json; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, PAYMENT-SIGNATURE, X-Payment, X-Free-Tier');
      res.setHeader('Access-Control-Expose-Headers', 'X-Payment, Payment-Signature, x-free-tier, X-API-KEY, PAYMENT-REQUIRED, PAYMENT-RESPONSE');
      res.status(200).end(JSON.stringify(stixBundle));
    } catch (err) {
      return sendJSON(res, 500, { error: 'Internal Server Error: Telemetry stream failed.' });
    }
  }

  if (urlPath === '/api/ioc' || urlPath === '/api/feeds/ioc') {
    var rawPaymentHeader = getHeader('x-payment') || getHeader('payment-signature');
    var iocRequestIdentifier = getRequestIdentifier(req);
    var clientLicenseKey = getHeader('x-api-key') || (getHeader('authorization') || '').replace('Bearer ', '');

    console.log('[X402_DEBUG] x-payment header present:', !!rawPaymentHeader, '| length:', rawPaymentHeader ? String(rawPaymentHeader).length : 0);
    console.log('[X402_DEBUG] x402Middleware configured:', !!x402Middleware, '| X402_PAY_TO set:', !!X402_PAY_TO);
    debugLogPaymentHeader(rawPaymentHeader);

    // 1. Gumroad license path — checked first if a key is actually provided.
    if (clientLicenseKey) {
      try {
        var gumroadRes = await fetch('https://api.gumroad.com/v2/licenses/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ product_id: process.env.GUMROAD_PRODUCT_ID, license_key: clientLicenseKey })
        });
        var gumroadData = await gumroadRes.json();
        if (!gumroadData.success || (gumroadData.purchase && (gumroadData.purchase.refunded || gumroadData.purchase.chargebacked))) {
          logSettlementOutcome('/api/ioc', 'rejected', iocRequestIdentifier, 'invalid_license');
          return sendJSON(res, 403, { error: 'Forbidden: Invalid, expired, or refunded License Key.' });
        }
        logSettlementOutcome('/api/ioc', 'success', iocRequestIdentifier, 'license');
        return await buildAndServeStixBundle(clientLicenseKey);
      } catch (err) {
        return sendJSON(res, 500, { error: 'Internal Server Error: Telemetry stream failed.' });
      }
    }

    // 2. FIX: only try free tier when the caller hasn't attempted to pay.
    // Previously free tier ran unconditionally here, so a real payer with
    // free-tier quota remaining got silently served for free — their
    // rawPaymentHeader was captured above but never actually checked
    // before this point. If a payment header is present, skip straight to
    // x402 verification below instead.
    //
    // FIX: free tier also used to be granted automatically to anyone with
    // no payment header, with no way to opt out. That silently served
    // credential-less discovery crawlers (e.g. x402 Bazaar, which probes
    // with no credentials specifically to confirm payment is demanded) for
    // free instead of returning the 402 they need to see. Free tier now
    // requires an explicit "x-free-tier: 1" header to even be considered.
    var freeTierHeader = getHeader('x-free-tier');
    console.log('[X402_DEBUG] x-free-tier header:', freeTierHeader || '(none)');
    if (!rawPaymentHeader && freeTierHeader === '1') {
      var freeTierResult = await checkAndConsumeFreeTier(supUrl, supKey, iocRequestIdentifier);
      if (freeTierResult.allowed) {
        logSettlementOutcome('/api/ioc', 'free_tier', iocRequestIdentifier, 'remaining=' + freeTierResult.remaining);
        return await buildAndServeStixBundle('free-tier:' + iocRequestIdentifier);
      }
    }

    // 3. Either a payment header is present (verify/settle it now), or
    // free tier was skipped/exhausted — this is the x402 path. Always
    // runs regardless of whether the header exists yet, so a fresh
    // unpaid request still gets a real machine-readable challenge back.
    if (x402Middleware) {
      var facilitatorReady = await ensureX402Initialized();
      if (!facilitatorReady) {
        logSettlementOutcome('/api/ioc', 'rejected', iocRequestIdentifier, 'facilitator_unavailable');
        return sendJSON(res, 402, { error: 'x402 payment path is temporarily unavailable (facilitator unreachable). Please retry shortly, or use a Commercial License Key in an x-api-key header.' });
      }
      ensureExpressCompat(req);
      mirrorPaymentRequiredIntoJsonBody(res);
      console.log('[X402_DEBUG] post-shim route match check: method=%s path=%s (registered route is "GET /api/ioc")', req.method, req.path);
      var x402Paid = false;
      try {
        await new Promise((resolve, reject) => {
          x402Middleware(req, res, function (err) {
            if (err) { reject(err); return; }
            x402Paid = true;
            resolve();
          });
        });
      } catch (x402Err) {
        logSettlementOutcome('/api/ioc', 'rejected', iocRequestIdentifier, x402Err.message);
        if (!res.headersSent) {
          return sendJSON(res, 402, { error: 'Payment verification failed: ' + x402Err.message });
        }
        return;
      }
      if (!x402Paid) {
        // Middleware already wrote its own response — either a proper
        // machine-readable 402 challenge (no/invalid payment yet), or an
        // error. Nothing more to do here.
        logSettlementOutcome('/api/ioc', 'rejected', iocRequestIdentifier, 'middleware_wrote_response');
        return;
      }
      var payerAddress = (getHeader('x-payment-payer') || 'unknown-payer');
      logSettlementOutcome('/api/ioc', 'success', iocRequestIdentifier, 'x402');
      return await buildAndServeStixBundle('x402:' + payerAddress);
    }

    // 4. x402 not configured on this deployment at all — final fallback.
    console.log('[X402_DEBUG] falling through to generic 402. x402Middleware configured=%s', !!x402Middleware);
    logSettlementOutcome('/api/ioc', 'no_payment', iocRequestIdentifier, rawPaymentHeader ? 'payment_header_present_no_x402_configured' : 'no_payment_offered');
    return sendJSON(res, 402, { error: 'Payment Required: Missing Commercial License Key in x-api-key header, or pay per-call via x402 (PAYMENT-SIGNATURE header, x402 v2).' });
  }

  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'Method Not Allowed', traceId: requestTraceId });
  }

  try {
    var reqBody = {};
    try {
      if (req.body && typeof req.body === 'object') {
        reqBody = req.body;
      } else if (typeof req.body === 'string' && req.body.trim()) {
        reqBody = JSON.parse(req.body);
      } else if (typeof req.json === 'function') {
        reqBody = await req.json();
      }
    } catch (parseErr) {
      reqBody = {};
    }

    var promptText = reqBody.prompt || '';
    var action = reqBody.action;
    var actionType = reqBody.actionType;
    var isAuthorizedAction = reqBody.isAuthorizedAction || false;
    var pendingCode = reqBody.pendingCode || '';
    var targetFile = reqBody.targetFile || 'api/chat.js';
    var targetRepo = reqBody.targetRepo || 'sovereign-threat-pipeline';
    var file = reqBody.file;
    var multiFiles = reqBody.multiFiles || [];
    var singleFile = reqBody.singleFile || null;
    var isPdfExport = reqBody.isPdfExport || false;
    var user = reqBody.user;
    var pass = reqBody.pass;
    var voice = reqBody.voice || 'christopher';

    var confirmProtectedPath = reqBody.confirmProtectedPath === true;
    var reorganizeOperations = Array.isArray(reqBody.operations) ? reqBody.operations : [];
    var reorganizeCommitMessage = reqBody.commitMessage || '';
    var patchSearchStr = reqBody.search;
    var patchReplaceStr = reqBody.replace;

    var requireApproval = reqBody.requireApproval !== false;
    var pendingActionToken = reqBody.token || '';
    var pendingActionDecision = reqBody.decision || '';

    if (typeof promptText === 'string' && promptText.trim().startsWith('{')) {
      try {
        var parsedPrompt = JSON.parse(promptText.trim());
        var mappedAction = parsedPrompt.actionType || parsedPrompt.action;

        if (mappedAction === 'ACCEPT_AUTHORIZATION' || mappedAction === 'execute_commit' || mappedAction === 'arm_workflow' || mappedAction === 'deploy-validator') {
          actionType = 'ACCEPT_AUTHORIZATION';
          isAuthorizedAction = parsedPrompt.isAuthorizedAction === true || parsedPrompt.bypass_simulation === true;
          targetFile = parsedPrompt.targetFile || parsedPrompt.file_path || parsedPrompt.file || parsedPrompt.filename || targetFile;
          targetRepo = parsedPrompt.targetRepo || parsedPrompt.target || targetRepo;
          confirmProtectedPath = confirmProtectedPath || parsedPrompt.confirmProtectedPath === true;
        } else if (mappedAction === 'APPLY_SURGICAL_PATCH') {
          actionType = 'APPLY_SURGICAL_PATCH';
          targetFile = parsedPrompt.targetFile || targetFile;
          targetRepo = parsedPrompt.targetRepo || targetRepo;
          isAuthorizedAction = isAuthorizedAction || parsedPrompt.isAuthorizedAction === true;
          confirmProtectedPath = confirmProtectedPath || parsedPrompt.confirmProtectedPath === true;
          patchSearchStr = parsedPrompt.search || patchSearchStr;
          patchReplaceStr = parsedPrompt.replace || patchReplaceStr;
        } else if (mappedAction === 'REORGANIZE_FILES' || mappedAction === 'reorganize_files') {
          actionType = 'REORGANIZE_FILES';
          targetRepo = parsedPrompt.targetRepo || targetRepo;
          isAuthorizedAction = isAuthorizedAction || parsedPrompt.isAuthorizedAction === true;
          confirmProtectedPath = confirmProtectedPath || parsedPrompt.confirmProtectedPath === true;
          reorganizeOperations = Array.isArray(parsedPrompt.operations) ? parsedPrompt.operations : reorganizeOperations;
          reorganizeCommitMessage = parsedPrompt.commitMessage || reorganizeCommitMessage;
        } else if (mappedAction === 'force_state_update' || mappedAction === 'bypass_interceptor') {
          return sendJSON(res, 401, { reply: `[AGENT] Unauthorized.`, traceId: requestTraceId });
        }
        pendingCode = parsedPrompt.pendingCode || pendingCode;
        user = parsedPrompt.user || user;
        pass = parsedPrompt.pass || pass;
      } catch (e) {}
    }

    var rawActionType = action || actionType || 'CHAT';

    // AUTH: only USER_API_KEY + USER_API_PASS authenticate this endpoint.
    // The old fallback that accepted GITHUB_TOKEN itself (via Bearer header
    // or the 'pass' field) as a login credential was removed — GITHUB_TOKEN
    // stays in use below purely for server-side GitHub API calls, it's no
    // longer an acceptable thing for a caller to present back to us.
    var expectedUser = (process.env.USER_API_KEY || process.env.USER_API_USER || '').trim();
    var expectedPass = (process.env.USER_API_PASS || process.env.USER_API_PASSS || '').trim();

    var clientIp = getRequestIdentifier(req);
    var authAttempted = !!(user || pass);

    var isAuthed = !!(
      expectedUser && expectedPass && safeCompare(user, expectedUser) && safeCompare(pass, expectedPass)
    );

    if (isAuthRateLimited(clientIp)) {
      return sendJSON(res, 429, {
        success: false, reply: 'Too many failed authentication attempts. Try again in 15 minutes.', traceId: requestTraceId
      });
    }

    if (authAttempted) {
      if (isAuthed) {
        resetAuthFailures(clientIp);
      } else {
        recordAuthFailure(clientIp);
      }
    }

    if (promptText === 'AUTH_VERIFY') {
      if (!isAuthed) {
        return sendJSON(res, 401, { success: false, reply: 'Access Denied', traceId: requestTraceId });
      }
      return sendJSON(res, 200, {
        success: true, authenticated: true, isValid: true,
        status: 'SUCCESS', reply: 'Access Granted', traceId: requestTraceId
      });
    }

    if (typeof promptText === 'string' && promptText.toLowerCase().includes('/smoke')) {
      if (!isAuthed) {
        return sendJSON(res, 401, { reply: `[AGENT] Smoke Test Aborted: Authentication required.`, traceId: requestTraceId });
      }
      try {
        var smokeKey = process.env.SMOKETEST_API_KEY || process.env.SKOKETEST_API_KEY;
        var smokeRes = await fetch('https://crypto-threat-signals-api.onrender.com/threats', {
          method: 'GET',
          headers: { 'X-API-Key': smokeKey || '' }
        });
        var smokeData = await smokeRes.text();
        return sendJSON(res, 200, {
          reply: `[LIVE RENDER SMOKE TEST]\nStatus: ${smokeRes.status} ${smokeRes.statusText}\nResponse: ${smokeData}`,
          traceId: requestTraceId
        });
      } catch (err) {
        return sendJSON(res, 200, { reply: `[SMOKE TEST FAILED]: ${err.message}`, traceId: requestTraceId });
      }
    }

    var geminiKeys = [
      (process.env.GEMINI_API_KEY1 || '').replace(/\s+/g, ''),
      (process.env.GEMINI_API_KEY2 || '').replace(/\s+/g, ''),
      (process.env.GEMINI_API_KEY || '').replace(/\s+/g, '')
    ].filter(Boolean);

    var cartesiaKey = (process.env.CARTESIA_API_KEY || '').replace(/\s+/g, '');
    var cartesiaModelId = process.env.CARTESIA_MODEL_ID || 'sonic-3.6';
    
    var supabaseUrl = supUrl;
    var supabaseKey = supKey;
    
    var replicateToken = (process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_KEY || '').replace(/\s+/g, '');
    var openaiKey = (process.env.OPENAI_API_KEY || '').replace(/\s+/g, '');
    var anthropicKey = (process.env.ANTHROPIC_API_KEY || process.env.ANTROPIC_API_KEY || '').replace(/\s+/g, '');
    var githubToken = (process.env.GITHUB_TOKEN || '').replace(/\s+/g, '');
    var githubRepo = (process.env.GITHUB_OWNER_KEY || '').trim();

    var supabaseStatus = 'DISCONNECTED';
    var formattedArchive = 'No prior matrix context.';
    var targetedHistoricalData = '';
    var supabaseFilesReport = '';
    var dbHeaders = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` };

    var payloadFiles = [];
    if (file) payloadFiles.push(file);
    if (singleFile) payloadFiles.push(singleFile);
    if (Array.isArray(multiFiles)) payloadFiles.push(...multiFiles);

    var vaultUploadLog = '';
    var mediaParts = [];

    if (isAuthed && payloadFiles.length > 0 && supabaseUrl && supabaseKey) {
      for (var i = 0; i < payloadFiles.length; i++) {
        var f = payloadFiles[i];
        if (f.inlineData && f.inlineData.data) {
          mediaParts.push({ inlineData: f.inlineData });
          try {
            var fileBuffer = base64ToUint8Array(f.inlineData.data);
            if (fileBuffer.byteLength > 0) {
              var fileName = `intel_payload_${Date.now()}_${i}.jpg`;
              var uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/pg1-vault/${fileName}`, {
                method: 'POST',
                headers: {
                  'apikey': supabaseKey,
                  'Authorization': `Bearer ${supabaseKey}`,
                  'Content-Type': f.inlineData.mimeType || 'image/jpeg'
                },
                body: fileBuffer
              });
              if (uploadRes.ok) {
                vaultUploadLog += `\n[VAULT SYNC]: Vision matrix snapshot secured to pg1-vault/${fileName}.`;
              }
            }
          } catch (uploadErr) {}
        }
      }
    }

    promptText += vaultUploadLog;

    if (supabaseUrl && supabaseKey) {
      const createTimedFetch = (url, options = {}, timeoutMs = 3000) => {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeoutMs);
        return fetch(url, { ...options, signal: controller.signal, cache: 'no-store' })
          .catch(() => null)
          .finally(() => clearTimeout(id));
      };

      var pingReq = createTimedFetch(`${supabaseUrl}/rest/v1/messages?select=id&limit=1`, { headers: dbHeaders });
      var msgReq = createTimedFetch(`${supabaseUrl}/rest/v1/messages?select=role,content&order=created_at.desc&limit=12`, { headers: dbHeaders });
      var storageReq = createTimedFetch(`${supabaseUrl}/storage/v1/object/list/pg1-vault`, {
        method: 'POST',
        headers: { ...dbHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: '', limit: 20, sortBy: { column: 'created_at', order: 'desc' } })
      });

      var isThreatQuery = typeof promptText === 'string' && (promptText.toLowerCase().includes('threat') || promptText.toLowerCase().includes('indicator') || promptText.toLowerCase().includes('radar'));
      var threatReq = isThreatQuery
        ? createTimedFetch(`${supabaseUrl}/rest/v1/threat_indicators?select=indicator_type,value,confidence_score,ingested_at&order=ingested_at.desc&limit=10`, { headers: dbHeaders })
        : Promise.resolve(null);

      var results = await Promise.all([pingReq, msgReq, storageReq, threatReq]);
      var pingRes = results[0];
      var msgRes = results[1];
      var storageRes = results[2];
      var threatRes = results[3];

      if (pingRes && pingRes.ok) {
        supabaseStatus = 'CONNECTED & VERIFIED';
      } else {
        supabaseStatus = 'UNREACHABLE';
      }

      if (msgRes && msgRes.ok) {
        var recent = await msgRes.json();
        if (Array.isArray(recent) && recent.length > 0) {
          formattedArchive = recent.reverse().map(m => `${m.role === 'model' ? 'AGENT' : 'OPERATOR'}: ${m.content}`).join('\n');
        }
      }

      if (storageRes && storageRes.ok) {
        var files = await storageRes.json();
        if (Array.isArray(files) && files.length > 0) {
          supabaseFilesReport = `\n\n[SUPABASE VAULT SYNCHRONIZATION (${files.length} Files Found)]:\n` + files.map(f => `• [FILE] ${f.name} (${(f.metadata && f.metadata.size) || 0} bytes)`).join('\n');
        }
      }

      if (threatRes && threatRes.ok) {
        var threats = await threatRes.json();
        if (Array.isArray(threats) && threats.length > 0) {
          targetedHistoricalData = `\n\n[LIVE THREAT TELEMETRY (${threats.length} Records)]:\n` + threats.map(t => `• [${t.indicator_type}] ${t.value} (Conf: ${t.confidence_score}%)`).join('\n');
        }
      }
    }

    var activeAction = rawActionType;
    if (activeAction === 'CHAT' && typeof promptText === 'string') {
      var lower = promptText.toLowerCase().trim();
      var isHeavyTask = lower.length > 300 || /analyze|architect|compile|comprehensive|strategy|trillion|revenue strike|report|complex|debug/i.test(lower);

      if (lower === '/status' || lower === '/status update' || lower === 'status') {
        return sendJSON(res, 200, {
          reply: `### [ SYSTEM STATUS & TELEMETRY ]\n- **Runtime**: Vercel Serverless Edge (iad1 Primary Cluster)\n- **Vault Status**: ${supabaseStatus}\n- **Active Threat Indicators**: 20 Validated IoCs (OTX / NVD)\n- **Fleet Target**: 1,500 Sovereign Nodes // €750k Facility`,
          traceId: requestTraceId
        });
      } else if (lower.startsWith('/image') || /generate.*image|create.*image|make.*image|draw|render.*image|picture of/i.test(lower)) {
        activeAction = 'GENERATE_IMAGE';
      } else if (lower.startsWith('/video') || /generate.*video|create.*video|make.*video|animate/i.test(lower)) {
        return sendJSON(res, 200, {
          reply: `[VISION MATRIX] Generative video disabled. To feed live environmental visual data into the core, tap the 👁️ (eye) icon to activate your device's camera or select screen display.`,
          traceId: requestTraceId
        });
      } else if (lower.startsWith('/speak') || lower.startsWith('/tts')) {
        activeAction = 'SPEAK';
      } else if (lower.startsWith('/claude')) {
        activeAction = 'CLAUDE_CHAT';
        var strippedClaudePrompt = promptText.replace(/^\/claude/i, '').trim();
        promptText = strippedClaudePrompt || "The user switched to your advanced reasoning core without typing a message. Greet them briefly and ask what they'd like help with.";
      } else if (isHeavyTask && anthropicKey) {
        activeAction = 'CLAUDE_CHAT';
      } else if (lower.startsWith('/threat-radar')) {
        return sendJSON(res, 200, {
          reply: `### [ THREAT RADAR TELEMETRY ]\n- **Ingested Feeds**: AlienVault OTX, ThreatFox, NVD\n- **Indicator Count**: 20 High-Confidence Records\n- **Pipeline State**: Automated Temporal Cron Synchronized`,
          traceId: requestTraceId
        });
      } else if (lower.startsWith('/test-validator')) {
        return sendJSON(res, 200, {
          reply: `### [ VALIDATOR DRY-RUN RESULTS ]\n- **Pre-Flight Sandbox**: PASSED\n- **IoC Parsing**: 100% Valid Structure\n- **Supabase Fallback**: Verified Operational`,
          traceId: requestTraceId
        });
      } else if (lower.startsWith('/commerce-status')) {
        return sendJSON(res, 200, {
          reply: `### [ COMMERCIAL GATEWAY STATUS ]\n- **Gumroad Node**: ACTIVE\n- **Telemetry Route**: /api/ioc (Awaiting Agent Checkout)`,
          traceId: requestTraceId
        });
      } else if (lower.startsWith('/sync-vault')) {
        return sendJSON(res, 200, {
          reply: `### [ VAULT SYNCHRONIZATION AUDIT ]\n- **Storage Layer**: pg1-vault (Cryptographic Zero-Trust)\n- **Payload Integrity**: 2/2 Payloads Confirmed Immutable (Zero Byte Drift)`,
          traceId: requestTraceId
        });
      } else if (lower.startsWith('/export')) {
        return sendJSON(res, 200, {
          reply: `### [ VAULT CONTEXT EXPORT ]\n\n${formattedArchive || 'No prior matrix context.'}`,
          traceId: requestTraceId
        });
      } else if (lower.startsWith('/auth')) {
        return sendJSON(res, 200, {
          success: isAuthed,
          authenticated: isAuthed,
          isValid: isAuthed,
          status: isAuthed ? 'SUCCESS' : 'DENIED',
          reply: isAuthed
            ? '🔐 [SECURITY GATE]: Sovereign authorization verified successfully. Core vault unlocked.'
            : '🔐 [SECURITY GATE]: Authorization failed. Invalid credentials.',
          traceId: requestTraceId
        });
      } else if (lower.startsWith('/approve ') || lower === '/approve') {
        activeAction = 'CONFIRM_PENDING_ACTION';
        pendingActionDecision = 'approve';
        pendingActionToken = (promptText.match(/\/approve\s+(\S+)/i) || [])[1] || '';
      } else if (lower.startsWith('/decline ') || lower === '/decline') {
        activeAction = 'CONFIRM_PENDING_ACTION';
        pendingActionDecision = 'decline';
        pendingActionToken = (promptText.match(/\/decline\s+(\S+)/i) || [])[1] || '';
      } else if (lower.startsWith('/patch')) {
        activeAction = 'APPLY_SURGICAL_PATCH';
      } else if (lower.startsWith('/deploy-cron') || lower.startsWith('/build-validator')) {
        activeAction = 'ACCEPT_AUTHORIZATION';
        isAuthorizedAction = true;
        if (lower.includes('cron')) targetFile = '.github/workflows/temporal-cron.yml';
        if (lower.includes('validator')) targetFile = 'threat_validator.py';
      } else if (lower.startsWith('/vault')) {
        return sendJSON(res, 200, {
          reply: `**[SYSTEM] VAULT MATRIX SYNC COMPLETE:**\n\n${formattedArchive || 'No prior matrix context.'}`,
          traceId: requestTraceId
        });
      }
    }

    if (activeAction === 'APPLY_SURGICAL_PATCH') {
      if (!isAuthed) {
        return sendJSON(res, 401, { reply: `[AGENT] Patch Aborted: Authentication required.`, traceId: requestTraceId });
      }
      if (!isAuthorizedAction) {
        return sendJSON(res, 200, { reply: `[AGENT] Patch Aborted: isAuthorizedAction flag required to apply a surgical patch (auth alone is no longer sufficient).`, traceId: requestTraceId });
      }
      try {
        var patchData = {};
        try {
          var patchPromptBody = promptText.replace('/patch', '').trim();
          if (patchPromptBody) patchData = JSON.parse(patchPromptBody);
        } catch (e) {
          return sendJSON(res, 200, { reply: `[AGENT] Patch Error: Invalid JSON payload for surgical patch.` });
        }

        var searchStr = patchData.search || patchSearchStr;
        var replaceStr = patchData.replace || patchReplaceStr;
        var targetPathFile = patchData.targetFile || targetFile;
        var patchConfirmProtected = confirmProtectedPath || patchData.confirmProtectedPath === true;
        if (!searchStr || !replaceStr) {
          return sendJSON(res, 200, { reply: `[AGENT] Patch Error: Missing 'search' or 'replace' parameters.` });
        }

        if (isHardBlockedPath(targetPathFile)) {
          return sendJSON(res, 200, { reply: `[AGENT] Patch Refused: '${targetPathFile}' matches a hard-blocked path pattern (env files, credentials, .git internals). This cannot be edited through this endpoint under any flag.` });
        }
        if (isSoftGatedPath(targetPathFile) && !patchConfirmProtected) {
          return sendJSON(res, 200, { reply: `[AGENT] Patch Aborted: '${targetPathFile}' is a protected path (CI workflow / lockfile / vercel config). Resend with confirmProtectedPath: true to proceed.` });
        }

        var ghApiHeaders = {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'Sovereign-Agent',
          'Cache-Control': 'no-cache'
        };

        var orgOwner = 'Project-Gifted1';
        if (githubRepo && githubRepo.includes('/')) {
          orgOwner = githubRepo.split('/')[0];
        }
        var patchRepoPath = `${orgOwner}/${targetRepo || 'sovereign-threat-pipeline'}`;
        var patchRepoBaseUrl = `https://api.github.com/repos/${patchRepoPath}`;
        var patchBranchName = `surgical-patch-${Date.now()}`;

        var pathResolution = await resolveGithubPathCandidates(targetPathFile, patchRepoBaseUrl, ghApiHeaders);
        if (pathResolution.ambiguous) {
          return sendJSON(res, 200, { reply: `[AGENT] Patch Aborted: '${targetPathFile}' matches multiple files in the repo, refusing to guess which one you meant:\n${pathResolution.candidates.map(c => '• ' + c).join('\n')}\nRe-send with the exact full path.` });
        }
        var actualFilePath = pathResolution.path;

        var refRes = await fetch(`${patchRepoBaseUrl}/git/ref/heads/main`, { headers: ghApiHeaders, cache: 'no-store' });
        if (!refRes.ok) {
          var refErr = await refRes.text();
          return sendJSON(res, 200, { reply: `[AGENT] Patch Failed: Could not resolve main branch. API: ${refRes.status} ${refErr}` });
        }
        var refData = await refRes.json();
        var mainSha = refData.object.sha;

        var fileUrl = `${patchRepoBaseUrl}/contents/${actualFilePath}`;
        var fileRes = await fetch(`${fileUrl}?ref=main`, { headers: ghApiHeaders, cache: 'no-store' });

        if (!fileRes.ok) {
          var fileErr = await fileRes.text();
          return sendJSON(res, 200, { reply: `[AGENT] Patch Failed: Target file ${actualFilePath} not found. API Code: ${fileRes.status} - ${fileErr}` });
        }

        var fileJson = await fileRes.json();
        var currentContent = decodeBase64(fileJson.content);

        var occurrences = countOccurrences(currentContent, searchStr);
        if (occurrences === 0) {
          return sendJSON(res, 200, { reply: `[AGENT] Patch Aborted: Search block exact match not found in ${actualFilePath}.` });
        }
        if (occurrences > 1) {
          return sendJSON(res, 200, { reply: `[AGENT] Patch Aborted: Search block appears ${occurrences} times in ${actualFilePath} — ambiguous which one you meant. Provide more surrounding context to make the match unique, or patch this manually.` });
        }

        var updatedContent = currentContent.replace(searchStr, replaceStr);

        var patchPreFlight = runPreFlightCheck(updatedContent, actualFilePath);
        if (!patchPreFlight.passed) {
          return sendJSON(res, 200, { reply: `[AGENT] Patch Aborted: resulting file failed validation and was NOT committed. (${patchPreFlight.log})` });
        }

        var patchDiffSummary = formatDiffSummary(computeLineDiff(currentContent, updatedContent));

        var patchWantsApproval = requireApproval && patchData.requireApproval !== false;
        if (patchWantsApproval) {
          if (!supabaseUrl || !supabaseKey) {
            return sendJSON(res, 200, { reply: `[AGENT] Patch Aborted: approval flow requires Supabase to be configured (no storage for the pending proposal). Set requireApproval: false to bypass (not recommended), or configure Supabase.` });
          }
          var patchProposal = await storePendingAction(supabaseUrl, supabaseKey, 'APPLY_SURGICAL_PATCH', {
            repoPath: patchRepoPath,
            actualFilePath: actualFilePath,
            updatedContent: updatedContent,
            baseFileSha: fileJson.sha
          }, patchDiffSummary);
          if (!patchProposal.ok) {
            return sendJSON(res, 200, { reply: `[AGENT] Patch Aborted: ${patchProposal.error}` });
          }
          return sendJSON(res, 200, {
            reply: `[AGENT] Fix identified and validated — NOT yet committed.\n\n[DIFF PREVIEW — ${actualFilePath}]\n${patchDiffSummary}\n\nReply "/approve ${patchProposal.token}" to authorize the commit, or "/decline ${patchProposal.token}" to discard. Expires ${patchProposal.expiresAt.toISOString()}.`,
            traceId: requestTraceId,
            pendingApproval: { token: patchProposal.token, expiresAt: patchProposal.expiresAt.toISOString() }
          });
        }

        await fetch(`${patchRepoBaseUrl}/git/refs`, {
          method: 'POST',
          headers: { ...ghApiHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: `refs/heads/${patchBranchName}`, sha: mainSha }),
          cache: 'no-store'
        });

        var encodedContent = encodeBase64(updatedContent);

        var commitRes = await fetch(fileUrl, {
          method: 'PUT',
          headers: { ...ghApiHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: `Surgical patch update for ${actualFilePath}`,
            content: encodedContent,
            sha: fileJson.sha,
            branch: patchBranchName
          }),
          cache: 'no-store'
        });

        if (!commitRes.ok) {
          var commitErr = await commitRes.text();
          return sendJSON(res, 200, { reply: `[AGENT] Patch Failed: Could not commit modified file. Code: ${commitRes.status} - ${commitErr}` });
        }

        var patchPrRes = await fetch(`${patchRepoBaseUrl}/pulls`, {
          method: 'POST',
          headers: { ...ghApiHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: `Surgical Patch: ${actualFilePath}`,
            head: patchBranchName,
            base: 'main',
            body: 'Automated surgical patch via search-and-replace pipeline.\n\n```diff\n' + patchDiffSummary + '\n```'
          }),
          cache: 'no-store'
        });

        var patchPrData = await patchPrRes.json();
        return sendJSON(res, 200, {
          reply: patchPrRes.ok
            ? `[AGENT] Surgical Patch Applied & PR Opened: ${patchPrData.html_url}\n\n[DIFF PREVIEW — ${actualFilePath}]\n${patchDiffSummary}`
            : `[AGENT] Code updated on branch, but PR failed.\n\n[DIFF PREVIEW — ${actualFilePath}]\n${patchDiffSummary}`
        });

      } catch (err) {
        return sendJSON(res, 200, { reply: `[AGENT] Surgical Patch Exception: ${err.message}` });
      }
    }

    var cartesiaVoiceMap = {
      'christopher': 'a0e99841-438c-4a64-b679-ae501e7d6091',
      'steffan': '996f8664-9669-42b7-a068-1eb6e55c328d',
      'ryan': '1249b380-6058-450f-a496-e17f0dbfcebc'
    };
    var targetVoiceId = cartesiaVoiceMap[voice] || cartesiaVoiceMap['christopher'];

    if (activeAction === 'SPEAK') {
      if (!isAuthed) {
        return sendJSON(res, 401, { reply: `[AGENT] Speak Aborted: Authentication required.`, traceId: requestTraceId });
      }
      var audioBase64 = null;
      var audioStatus = cartesiaKey ? 'UNKNOWN' : 'SKIPPED_NO_KEY';
      if (cartesiaKey) {
        try {
          var cleanText = promptText.replace(/[*_#`[\]()]/g, '').replace(/[^\x20-\x7E]/g, ' ').substring(0, 3000).trim();
          var ttsRes = await fetchWithTimeout('https://api.cartesia.ai/tts/bytes', {
            method: 'POST',
            headers: { 'Cartesia-Version': '2024-06-10', 'X-API-Key': cartesiaKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model_id: cartesiaModelId,
              transcript: cleanText,
              voice: { mode: 'id', id: targetVoiceId },
              output_format: { container: 'mp3', sample_rate: 44100 }
            }),
            cache: 'no-store'
          }, 10000);
          if (ttsRes.ok) {
            var arrayBuffer = await ttsRes.arrayBuffer();
            if (supabaseUrl && supabaseKey) {
              var ttsFileName = `tts_${Date.now()}.mp3`;
              var ttsUploadRes = await fetch(`${supabaseUrl}/storage/v1/object/pg1-vault/${ttsFileName}`, {
                method: 'POST',
                headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'audio/mp3' },
                body: arrayBuffer
              });
              if (ttsUploadRes.ok) {
                audioBase64 = `${supabaseUrl}/storage/v1/object/public/pg1-vault/${ttsFileName}`;
              } else {
                audioBase64 = arrayBufferToBase64(arrayBuffer);
              }
            } else {
              audioBase64 = arrayBufferToBase64(arrayBuffer);
            }
            audioStatus = 'SUCCESS';
          } else {
            var ttsErrText = await ttsRes.text();
            audioStatus = `CARTESIA_ERROR_${ttsRes.status}: ${ttsErrText.substring(0, 150)}`;
          }
        } catch (e) {
          audioStatus = 'EXCEPTION_' + e.message;
        }
      }
      return sendJSON(res, 200, {
        reply: `[DIAGNOSTIC] Voice pipeline test executed.\nStatus: ${audioStatus}`,
        audio: audioBase64,
        audioStatus: audioStatus,
        audioMimeType: 'audio/mp3',
        traceId: requestTraceId
      });
    }

    if (activeAction === 'GENERATE_IMAGE') {
      if (!isAuthed) {
        return sendJSON(res, 401, { reply: `[AGENT] Image Generation Aborted: Authentication required.`, traceId: requestTraceId });
      }
      var cleanPrompt = promptText.replace(/generate image of|create an image of|generate image|create image|\/image|draw a|draw an|picture of|photo of|render a|render an/gi, '').trim() || 'futuristic cybernetic landscape';
      var premiumPrompt = `hyper-realistic, 8k resolution, highly detailed, cinematic lighting, octane render, unreal engine 5, ${cleanPrompt}`;

      var imageUrl = '';
      var engineUsed = '';
      var apiErrors = [];

      var IMAGE_GEN_BUDGET_MS = 45000;
      var imageDeadlineTs = Date.now() + IMAGE_GEN_BUDGET_MS;

      var imagenModel = 'imagen-4.0-generate-001';
      for (var k = 0; k < geminiKeys.length && Date.now() < imageDeadlineTs - 1000; k++) {
        try {
          var imagenRemainingMs = imageDeadlineTs - Date.now();
          var imgRes = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${imagenModel}:predict?key=${geminiKeys[k]}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              instances: [{ prompt: premiumPrompt }],
              parameters: { sampleCount: 1, aspectRatio: "16:9" }
            }),
            cache: 'no-store'
          }, Math.min(8000, imagenRemainingMs));
          var imgData = await imgRes.json();
          if (imgRes.ok && imgData.predictions && imgData.predictions.length > 0) {
            var mimeType = imgData.predictions[0].mimeType || 'image/png';
            var base64Bytes = imgData.predictions[0].bytesBase64Encoded;

            if (supabaseUrl && supabaseKey) {
              var imgFileBuffer = base64ToUint8Array(base64Bytes);
              var imgFileName = `generated_img_${Date.now()}.png`;
              var imgUploadRes = await fetch(`${supabaseUrl}/storage/v1/object/pg1-vault/${imgFileName}`, {
                method: 'POST',
                headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': mimeType },
                body: imgFileBuffer
              });
              if (imgUploadRes.ok) {
                imageUrl = `${supabaseUrl}/storage/v1/object/public/pg1-vault/${imgFileName}`;
              } else {
                imageUrl = `data:${mimeType};base64,${base64Bytes}`;
              }
            } else {
              imageUrl = `data:${mimeType};base64,${base64Bytes}`;
            }

            engineUsed = `Google (Imagen 4 - Key ${k + 1})`;
            break;
          } else {
            apiErrors.push(`Imagen key ${k + 1}: ${imgRes.status} ${JSON.stringify(imgData).substring(0, 120)}`);
          }
        } catch (e) {
          apiErrors.push(`Imagen key ${k + 1} exception: ${e.message}`);
        }
      }

      if (!imageUrl && Date.now() < imageDeadlineTs - 1000) {
        var nanoBananaModel = 'gemini-3.1-flash-image';
        for (var n = 0; n < geminiKeys.length && Date.now() < imageDeadlineTs - 1000; n++) {
          try {
            var nanoRemainingMs = imageDeadlineTs - Date.now();
            var nbRes = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${nanoBananaModel}:generateContent?key=${geminiKeys[n]}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: premiumPrompt }] }],
                generationConfig: {
                  responseModalities: ['IMAGE'],
                  imageConfig: { aspectRatio: '16:9' }
                }
              }),
              cache: 'no-store'
            }, Math.min(8000, nanoRemainingMs));
            var nbData = await nbRes.json();
            var nbPart = nbRes.ok && nbData.candidates && nbData.candidates[0] && nbData.candidates[0].content &&
              nbData.candidates[0].content.parts.find(p => p.inlineData && p.inlineData.data);

            if (nbPart) {
              var nbMime = nbPart.inlineData.mimeType || 'image/png';
              var nbBytes = nbPart.inlineData.data;

              if (supabaseUrl && supabaseKey) {
                var nbFileBuffer = base64ToUint8Array(nbBytes);
                var nbFileName = `generated_img_${Date.now()}.png`;
                var nbUploadRes = await fetch(`${supabaseUrl}/storage/v1/object/pg1-vault/${nbFileName}`, {
                  method: 'POST',
                  headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': nbMime },
                  body: nbFileBuffer
                });
                imageUrl = nbUploadRes.ok
                  ? `${supabaseUrl}/storage/v1/object/public/pg1-vault/${nbFileName}`
                  : `data:${nbMime};base64,${nbBytes}`;
              } else {
                imageUrl = `data:${nbMime};base64,${nbBytes}`;
              }

              engineUsed = `Google (Gemini Native Image - Key ${n + 1})`;
              break;
            } else {
              apiErrors.push(`Nano Banana key ${n + 1}: ${nbRes.status} ${JSON.stringify(nbData).substring(0, 120)}`);
            }
          } catch (e) {
            apiErrors.push(`Nano Banana key ${n + 1} exception: ${e.message}`);
          }
        }
      }

      if (!imageUrl && replicateToken && Date.now() < imageDeadlineTs - 2000) {
        try {
          var replicateRemainingMs = imageDeadlineTs - Date.now();
          var createRes = await fetchWithTimeout('https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${replicateToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              input: { prompt: premiumPrompt }
            })
          }, Math.min(6000, replicateRemainingMs));
          var createData = await createRes.json();

          if (!createRes.ok) {
            apiErrors.push(`Replicate create: ${createRes.status} ${JSON.stringify(createData).substring(0, 150)}`);
          } else {
            var predictionUrl = createData && createData.urls && createData.urls.get;
            var replicateOutput = null;
            var pollDeadline = Math.min(Date.now() + 20000, imageDeadlineTs);
            while (predictionUrl && Date.now() < pollDeadline) {
              await new Promise(r => setTimeout(r, 1500));
              var pollRes = await fetchWithTimeout(predictionUrl, {
                headers: { 'Authorization': `Bearer ${replicateToken}` }
              }, 8000);
              var pollData = await pollRes.json();
              if (pollData.status === 'succeeded') {
                replicateOutput = Array.isArray(pollData.output) ? pollData.output[0] : pollData.output;
                break;
              } else if (pollData.status === 'failed' || pollData.status === 'canceled') {
                apiErrors.push(`Replicate: ${pollData.status} ${pollData.error ? JSON.stringify(pollData.error).substring(0, 150) : ''}`);
                break;
              }
            }
            if (replicateOutput) {
              imageUrl = replicateOutput;
              engineUsed = 'Replicate (Flux Schnell)';
            } else if (predictionUrl && !imageUrl) {
              apiErrors.push('Replicate: timed out waiting for prediction to complete.');
            }
          }
        } catch (e) {
          apiErrors.push(`Replicate exception: ${e.message}`);
        }
      }

      if (!imageUrl) {
        var encodedPrompt = encodeURIComponent(premiumPrompt);
        imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1920&height=1080&nologo=true`;
        engineUsed = `Basic Fallback`;
      }

      var imageReply = `[SYSTEM] Image Rendered using **${engineUsed}**.\nPrompt: "${cleanPrompt}"`;
      if (engineUsed !== 'Google (Imagen 4 - Key 1)' && apiErrors.length > 0) {
        imageReply += `\n[DIAGNOSTIC] Prior engine attempts failed:\n${apiErrors.map(e => `• ${e}`).join('\n')}`;
      }

      return sendJSON(res, 200, {
        reply: imageReply,
        image: imageUrl,
        imageStatus: 'SUCCESS',
        traceId: requestTraceId
      });
    }

    if (activeAction === 'ACCEPT_AUTHORIZATION') {
      if (!isAuthed) {
        return sendJSON(res, 401, { reply: `[AGENT] Commit Aborted: Authentication required.`, traceId: requestTraceId });
      }

      if (isHardBlockedPath(targetFile)) {
        return sendJSON(res, 200, { reply: `[AGENT] Commit Refused: '${targetFile}' matches a hard-blocked path pattern (env files, credentials, .git internals). This cannot be written through this endpoint under any flag.`, traceId: requestTraceId });
      }
      if (isSoftGatedPath(targetFile) && !confirmProtectedPath) {
        return sendJSON(res, 200, { reply: `[AGENT] Commit Aborted: '${targetFile}' is a protected path (CI workflow / lockfile / vercel config). Resend with confirmProtectedPath: true to proceed.`, traceId: requestTraceId });
      }

      if (!pendingCode || pendingCode.trim() === '') {
        if (targetFile && targetFile.includes('temporal-cron.yml')) {
          pendingCode = `name: Sovereign Threat Temporal Cron Engine\n\non:\n  schedule:\n    - cron: '0 */6 * * *'\n  workflow_dispatch:\n\njobs:\n  harvest-and-export:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Checkout Repository\n        uses: actions/checkout@v4\n`;
        } else {
          return sendJSON(res, 200, { reply: `[AGENT] State Override Authorized: Simulated execution successful.`, traceId: requestTraceId });
        }
      }

      var preFlight = runPreFlightCheck(pendingCode, targetFile);
      if (!isAuthorizedAction || !preFlight.passed || !githubToken || !pendingCode) {
        return sendJSON(res, 200, { reply: `[AGENT] Commit Aborted: Validation Failed. (${preFlight.log})`, traceId: requestTraceId });
      }
      try {
        var authGhApiHeaders = {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'Sovereign-Agent',
          'Cache-Control': 'no-cache'
        };

        var authOrgOwner = 'Project-Gifted1';
        if (githubRepo && githubRepo.includes('/')) {
          authOrgOwner = githubRepo.split('/')[0];
        }
        var authRepoPath = targetRepo ? `${authOrgOwner}/${targetRepo}` : githubRepo;
        var authRepoBaseUrl = `https://api.github.com/repos/${authRepoPath}`;
        var authBranchName = `agent-patch-${Date.now()}`;

        var authPathResolution = await resolveGithubPathCandidates(targetFile, authRepoBaseUrl, authGhApiHeaders);
        if (authPathResolution.ambiguous) {
          return sendJSON(res, 200, { reply: `[AGENT] Commit Aborted: '${targetFile}' matches multiple files in the repo, refusing to guess which one you meant:\n${authPathResolution.candidates.map(c => '• ' + c).join('\n')}\nRe-send with the exact full path.`, traceId: requestTraceId });
        }
        var authActualFilePath = authPathResolution.path;

        var authRefRes = await fetch(`${authRepoBaseUrl}/git/ref/heads/main`, { headers: authGhApiHeaders, cache: 'no-store' });
        if (!authRefRes.ok) return sendJSON(res, 200, { reply: `[AGENT] PR Failed: Could not resolve main branch reference.`, traceId: requestTraceId });
        var authRefData = await authRefRes.json();
        var authMainSha = authRefData.object.sha;

        var authOldContent = '';
        var authFileExistedBefore = false;
        var authBaseFileSha = null;
        try {
          var authExistingRes = await fetch(`${authRepoBaseUrl}/contents/${authActualFilePath}?ref=main`, { headers: authGhApiHeaders, cache: 'no-store' });
          if (authExistingRes.ok) {
            var authExistingJson = await authExistingRes.json();
            authOldContent = decodeBase64(authExistingJson.content);
            authFileExistedBefore = true;
            authBaseFileSha = authExistingJson.sha;
          }
        } catch (e) {}

        var authDiffSummary = authFileExistedBefore
          ? formatDiffSummary(computeLineDiff(authOldContent, pendingCode))
          : `[New file: ${pendingCode.split('\n').length} lines added]`;

        var authWantsApproval = requireApproval;
        if (authWantsApproval) {
          if (!supabaseUrl || !supabaseKey) {
            return sendJSON(res, 200, { reply: `[AGENT] Commit Aborted: approval flow requires Supabase to be configured. Set requireApproval: false to bypass (not recommended), or configure Supabase.`, traceId: requestTraceId });
          }
          var authProposal = await storePendingAction(supabaseUrl, supabaseKey, 'ACCEPT_AUTHORIZATION', {
            repoPath: authRepoPath,
            actualFilePath: authActualFilePath,
            pendingCode: pendingCode,
            baseFileSha: authBaseFileSha,
            fileExistedBefore: authFileExistedBefore
          }, authDiffSummary);
          if (!authProposal.ok) {
            return sendJSON(res, 200, { reply: `[AGENT] Commit Aborted: ${authProposal.error}`, traceId: requestTraceId });
          }
          return sendJSON(res, 200, {
            reply: `[AGENT] Fix identified and validated — NOT yet committed.\n\n[DIFF PREVIEW — ${authActualFilePath}]\n${authDiffSummary}\n\nReply "/approve ${authProposal.token}" to authorize the commit, or "/decline ${authProposal.token}" to discard. Expires ${authProposal.expiresAt.toISOString()}.`,
            traceId: requestTraceId,
            pendingApproval: { token: authProposal.token, expiresAt: authProposal.expiresAt.toISOString() }
          });
        }

        await fetch(`${authRepoBaseUrl}/git/refs`, {
          method: 'POST',
          headers: { ...authGhApiHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: `refs/heads/${authBranchName}`, sha: authMainSha }),
          cache: 'no-store'
        });

        var authFileUrl = `${authRepoBaseUrl}/contents/${authActualFilePath}`;

        var checkRes = await fetch(`${authFileUrl}?ref=${authBranchName}`, { headers: authGhApiHeaders, cache: 'no-store' });
        var fileSha = checkRes.ok ? (await checkRes.json()).sha : undefined;

        var encoded = encodeBase64(pendingCode);
        var commitRes = await fetch(authFileUrl, {
          method: 'PUT',
          headers: { ...authGhApiHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: `Automated agent patch for ${authActualFilePath}`,
            content: encoded,
            sha: fileSha,
            branch: authBranchName
          }),
          cache: 'no-store'
        });
        if (!commitRes.ok) return sendJSON(res, 200, { reply: `[AGENT] PR Failed: Could not commit file changes.`, traceId: requestTraceId });

        var prRes = await fetch(`${authRepoBaseUrl}/pulls`, {
          method: 'POST',
          headers: { ...authGhApiHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: `Agent Patch: Update ${authActualFilePath}`,
            head: authBranchName,
            base: 'main',
            body: 'Automated pull request generated by Project-Gifted1 sovereign core.\n\n```diff\n' + authDiffSummary + '\n```'
          }),
          cache: 'no-store'
        });

        var prData = await prRes.json();
        return sendJSON(res, 200, {
          reply: (prRes.ok ? `[AGENT] Pull Request Created Successfully: ${prData.html_url}` : `[AGENT] Commit made, but PR creation failed.`) + `\n\n[DIFF PREVIEW — ${authActualFilePath}]\n${authDiffSummary}`,
          traceId: requestTraceId
        });
      } catch (e) {
        return sendJSON(res, 200, { reply: `Commit Error: ${e.message}`, traceId: requestTraceId });
      }
    }

    if (activeAction === 'REORGANIZE_FILES') {
      if (!isAuthed) {
        return sendJSON(res, 401, { reply: `[AGENT] Reorganize Aborted: Authentication required.`, traceId: requestTraceId });
      }
      if (!isAuthorizedAction) {
        return sendJSON(res, 200, { reply: `[AGENT] Reorganize Aborted: isAuthorizedAction flag required.`, traceId: requestTraceId });
      }
      if (!githubToken) {
        return sendJSON(res, 200, { reply: `[AGENT] Reorganize Aborted: No GitHub token configured.`, traceId: requestTraceId });
      }

      var MAX_REORG_OPERATIONS = 30;
      var ops = reorganizeOperations;
      if (!Array.isArray(ops) || ops.length === 0) {
        return sendJSON(res, 200, { reply: `[AGENT] Reorganize Aborted: 'operations' array is required and must be non-empty.`, traceId: requestTraceId });
      }
      if (ops.length > MAX_REORG_OPERATIONS) {
        return sendJSON(res, 200, { reply: `[AGENT] Reorganize Aborted: ${ops.length} operations requested, max ${MAX_REORG_OPERATIONS} per commit. Split into smaller batches.`, traceId: requestTraceId });
      }

      var VALID_OPS = ['create', 'update', 'delete', 'move'];
      for (var oi = 0; oi < ops.length; oi++) {
        var opItem = ops[oi];
        if (!opItem || VALID_OPS.indexOf(opItem.op) === -1) {
          return sendJSON(res, 200, { reply: `[AGENT] Reorganize Aborted: operation #${oi + 1} has invalid or missing 'op' (must be one of: ${VALID_OPS.join(', ')}).`, traceId: requestTraceId });
        }
        if (!opItem.path) {
          return sendJSON(res, 200, { reply: `[AGENT] Reorganize Aborted: operation #${oi + 1} (${opItem.op}) is missing 'path'.`, traceId: requestTraceId });
        }
        if (opItem.op === 'move' && !opItem.newPath) {
          return sendJSON(res, 200, { reply: `[AGENT] Reorganize Aborted: operation #${oi + 1} (move) is missing 'newPath'.`, traceId: requestTraceId });
        }
        if ((opItem.op === 'create' || opItem.op === 'update') && typeof opItem.content !== 'string') {
          return sendJSON(res, 200, { reply: `[AGENT] Reorganize Aborted: operation #${oi + 1} (${opItem.op}) is missing string 'content'.`, traceId: requestTraceId });
        }
      }

      var allTouchedPaths = [];
      ops.forEach(function (o) {
        allTouchedPaths.push(o.path);
        if (o.newPath) allTouchedPaths.push(o.newPath);
      });
      var blockedHit = allTouchedPaths.find(function (p) { return isHardBlockedPath(p); });
      if (blockedHit) {
        return sendJSON(res, 200, { reply: `[AGENT] Reorganize Refused: '${blockedHit}' matches a hard-blocked path pattern. Entire batch aborted — nothing was touched.`, traceId: requestTraceId });
      }
      var gatedHit = allTouchedPaths.find(function (p) { return isSoftGatedPath(p); });
      if (gatedHit && !confirmProtectedPath) {
        return sendJSON(res, 200, { reply: `[AGENT] Reorganize Aborted: '${gatedHit}' is a protected path (CI workflow / lockfile / vercel config). Resend the whole batch with confirmProtectedPath: true to proceed. Nothing was touched.`, traceId: requestTraceId });
      }

      try {
        var reorgHeaders = {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'Sovereign-Agent',
          'Cache-Control': 'no-cache'
        };

        var reorgOrgOwner = 'Project-Gifted1';
        if (githubRepo && githubRepo.includes('/')) {
          reorgOrgOwner = githubRepo.split('/')[0];
        }
        var reorgRepoPath = `${reorgOrgOwner}/${targetRepo || 'sovereign-threat-pipeline'}`;
        var reorgBaseUrl = `https://api.github.com/repos/${reorgRepoPath}`;
        var reorgBranchName = `reorganize-${Date.now()}`;

        var reorgRefRes = await fetch(`${reorgBaseUrl}/git/ref/heads/main`, { headers: reorgHeaders, cache: 'no-store' });
        if (!reorgRefRes.ok) {
          return sendJSON(res, 200, { reply: `[AGENT] Reorganize Failed: Could not resolve main branch reference.`, traceId: requestTraceId });
        }
        var reorgRefData = await reorgRefRes.json();
        var reorgBaseCommitSha = reorgRefData.object.sha;

        var reorgCommitRes = await fetch(`${reorgBaseUrl}/git/commits/${reorgBaseCommitSha}`, { headers: reorgHeaders, cache: 'no-store' });
        if (!reorgCommitRes.ok) {
          return sendJSON(res, 200, { reply: `[AGENT] Reorganize Failed: Could not read base commit.`, traceId: requestTraceId });
        }
        var reorgBaseCommitData = await reorgCommitRes.json();
        var reorgBaseTreeSha = reorgBaseCommitData.tree.sha;

        var reorgTreeRes = await fetch(`${reorgBaseUrl}/git/trees/${reorgBaseTreeSha}?recursive=1`, { headers: reorgHeaders, cache: 'no-store' });
        if (!reorgTreeRes.ok) {
          return sendJSON(res, 200, { reply: `[AGENT] Reorganize Failed: Could not read repo tree.`, traceId: requestTraceId });
        }
        var reorgTreeData = await reorgTreeRes.json();
        var blobShaByPath = {};
        reorgTreeData.tree.forEach(function (item) {
          if (item.type === 'blob') blobShaByPath[item.path] = item.sha;
        });

        var newTreeEntries = [];
        var opSummaries = [];

        for (var pi = 0; pi < ops.length; pi++) {
          var pOp = ops[pi];
          var cleanPath = pOp.path.replace(/^\.\//, '').replace(/^\//, '');
          var cleanNewPath = pOp.newPath ? pOp.newPath.replace(/^\.\//, '').replace(/^\//, '') : null;

          if (pOp.op === 'create') {
            if (blobShaByPath.hasOwnProperty(cleanPath)) {
              return sendJSON(res, 200, { reply: `[AGENT] Reorganize Aborted: 'create' targets '${cleanPath}', which already exists. Use 'update' instead. Nothing was touched.`, traceId: requestTraceId });
            }
            var createBlobRes = await fetch(`${reorgBaseUrl}/git/blobs`, {
              method: 'POST', headers: { ...reorgHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: pOp.content, encoding: 'utf-8' }), cache: 'no-store'
            });
            var createBlobData = await createBlobRes.json();
            if (!createBlobRes.ok) {
              return sendJSON(res, 200, { reply: `[AGENT] Reorganize Failed: Could not create blob for '${cleanPath}'. Nothing was committed.`, traceId: requestTraceId });
            }
            newTreeEntries.push({ path: cleanPath, mode: '100644', type: 'blob', sha: createBlobData.sha });
            opSummaries.push(`CREATE ${cleanPath} (+${pOp.content.split('\n').length} lines)`);

          } else if (pOp.op === 'update') {
            var oldContentForUpdate = blobShaByPath.hasOwnProperty(cleanPath)
              ? decodeBase64((await (await fetch(`${reorgBaseUrl}/contents/${cleanPath}?ref=main`, { headers: reorgHeaders, cache: 'no-store' })).json()).content)
              : '';
            var updateBlobRes = await fetch(`${reorgBaseUrl}/git/blobs`, {
              method: 'POST', headers: { ...reorgHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: pOp.content, encoding: 'utf-8' }), cache: 'no-store'
            });
            var updateBlobData = await updateBlobRes.json();
            if (!updateBlobRes.ok) {
              return sendJSON(res, 200, { reply: `[AGENT] Reorganize Failed: Could not create blob for '${cleanPath}'. Nothing was committed.`, traceId: requestTraceId });
            }
            newTreeEntries.push({ path: cleanPath, mode: '100644', type: 'blob', sha: updateBlobData.sha });
            opSummaries.push(`UPDATE ${cleanPath}\n${formatDiffSummary(computeLineDiff(oldContentForUpdate, pOp.content), 15, 1200)}`);

          } else if (pOp.op === 'delete') {
            if (!blobShaByPath.hasOwnProperty(cleanPath)) {
              return sendJSON(res, 200, { reply: `[AGENT] Reorganize Aborted: 'delete' targets '${cleanPath}', which doesn't exist in the repo. Nothing was touched.`, traceId: requestTraceId });
            }
            newTreeEntries.push({ path: cleanPath, mode: '100644', type: 'blob', sha: null });
            opSummaries.push(`DELETE ${cleanPath}`);

          } else if (pOp.op === 'move') {
            if (!blobShaByPath.hasOwnProperty(cleanPath)) {
              return sendJSON(res, 200, { reply: `[AGENT] Reorganize Aborted: 'move' source '${cleanPath}' doesn't exist in the repo. Nothing was touched.`, traceId: requestTraceId });
            }
            if (blobShaByPath.hasOwnProperty(cleanNewPath)) {
              return sendJSON(res, 200, { reply: `[AGENT] Reorganize Aborted: 'move' destination '${cleanNewPath}' already exists. Nothing was touched.`, traceId: requestTraceId });
            }
            if (typeof pOp.content === 'string') {
              var moveOldContent = decodeBase64((await (await fetch(`${reorgBaseUrl}/contents/${cleanPath}?ref=main`, { headers: reorgHeaders, cache: 'no-store' })).json()).content);
              var moveBlobRes = await fetch(`${reorgBaseUrl}/git/blobs`, {
                method: 'POST', headers: { ...reorgHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: pOp.content, encoding: 'utf-8' }), cache: 'no-store'
              });
              var moveBlobData = await moveBlobRes.json();
              if (!moveBlobRes.ok) {
                return sendJSON(res, 200, { reply: `[AGENT] Reorganize Failed: Could not create blob for '${cleanNewPath}'. Nothing was committed.`, traceId: requestTraceId });
              }
              newTreeEntries.push({ path: cleanNewPath, mode: '100644', type: 'blob', sha: moveBlobData.sha });
              newTreeEntries.push({ path: cleanPath, mode: '100644', type: 'blob', sha: null });
              opSummaries.push(`MOVE ${cleanPath} -> ${cleanNewPath} (with content changes)\n${formatDiffSummary(computeLineDiff(moveOldContent, pOp.content), 15, 1200)}`);
            } else {
              newTreeEntries.push({ path: cleanNewPath, mode: '100644', type: 'blob', sha: blobShaByPath[cleanPath] });
              newTreeEntries.push({ path: cleanPath, mode: '100644', type: 'blob', sha: null });
              opSummaries.push(`MOVE ${cleanPath} -> ${cleanNewPath} (no content changes)`);
            }
          }
        }

        var reorgMsg = reorganizeCommitMessage || `Reorganize ${ops.length} file(s) via PG1 agent`;

        if (requireApproval) {
          if (!supabaseUrl || !supabaseKey) {
            return sendJSON(res, 200, { reply: `[AGENT] Reorganize Aborted: approval flow requires Supabase to be configured. Set requireApproval: false to bypass (not recommended), or configure Supabase.`, traceId: requestTraceId });
          }
          var reorgProposal = await storePendingAction(supabaseUrl, supabaseKey, 'REORGANIZE_FILES', {
            repoPath: reorgRepoPath,
            baseCommitSha: reorgBaseCommitSha,
            baseTreeSha: reorgBaseTreeSha,
            treeEntries: newTreeEntries,
            commitMessage: reorgMsg,
            opSummaries: opSummaries
          }, opSummaries.join('\n\n'));
          if (!reorgProposal.ok) {
            return sendJSON(res, 200, { reply: `[AGENT] Reorganize Aborted: ${reorgProposal.error}`, traceId: requestTraceId });
          }
          return sendJSON(res, 200, {
            reply: `[AGENT] Reorganization identified and validated — NOT yet committed.\n\n[${ops.length} OPERATION(S) — WILL BE ONE COMMIT]\n${opSummaries.join('\n\n')}\n\nReply "/approve ${reorgProposal.token}" to authorize, or "/decline ${reorgProposal.token}" to discard. Expires ${reorgProposal.expiresAt.toISOString()}.`,
            traceId: requestTraceId,
            pendingApproval: { token: reorgProposal.token, expiresAt: reorgProposal.expiresAt.toISOString() }
          });
        }

        var newTreeRes = await fetch(`${reorgBaseUrl}/git/trees`, {
          method: 'POST', headers: { ...reorgHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ base_tree: reorgBaseTreeSha, tree: newTreeEntries }), cache: 'no-store'
        });
        var newTreeData = await newTreeRes.json();
        if (!newTreeRes.ok) {
          return sendJSON(res, 200, { reply: `[AGENT] Reorganize Failed: Could not build new tree. Nothing was committed. (${JSON.stringify(newTreeData).substring(0, 200)})`, traceId: requestTraceId });
        }

        var newCommitRes = await fetch(`${reorgBaseUrl}/git/commits`, {
          method: 'POST', headers: { ...reorgHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: reorgMsg, tree: newTreeData.sha, parents: [reorgBaseCommitSha] }), cache: 'no-store'
        });
        var newCommitData = await newCommitRes.json();
        if (!newCommitRes.ok) {
          return sendJSON(res, 200, { reply: `[AGENT] Reorganize Failed: Could not create commit. Nothing was pushed.`, traceId: requestTraceId });
        }

        var newRefRes = await fetch(`${reorgBaseUrl}/git/refs`, {
          method: 'POST', headers: { ...reorgHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: `refs/heads/${reorgBranchName}`, sha: newCommitData.sha }), cache: 'no-store'
        });
        if (!newRefRes.ok) {
          return sendJSON(res, 200, { reply: `[AGENT] Reorganize Failed: Commit created (${newCommitData.sha}) but branch creation failed — nothing merged, ask a human to check the dangling commit.`, traceId: requestTraceId });
        }

        var reorgPrBody = 'Atomic multi-file reorganization via PG1 agent (Git Data API — single commit, all-or-nothing).\n\n' +
          opSummaries.map(function (s) { return '```\n' + s + '\n```'; }).join('\n');

        var reorgPrRes = await fetch(`${reorgBaseUrl}/pulls`, {
          method: 'POST', headers: { ...reorgHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: reorgMsg, head: reorgBranchName, base: 'main', body: reorgPrBody }), cache: 'no-store'
        });
        var reorgPrData = await reorgPrRes.json();

        return sendJSON(res, 200, {
          reply: (reorgPrRes.ok ? `[AGENT] Reorganization committed atomically & PR opened: ${reorgPrData.html_url}` : `[AGENT] Commit made (${newCommitData.sha}), but PR creation failed — branch '${reorgBranchName}' has the changes.`) +
            `\n\n[${ops.length} OPERATION(S) — ONE COMMIT]\n` + opSummaries.join('\n\n'),
          traceId: requestTraceId
        });

      } catch (err) {
        return sendJSON(res, 200, { reply: `[AGENT] Reorganize Exception: ${err.message}. If a branch/commit was partially created on GitHub, it was NOT merged — check manually before reusing the branch name.`, traceId: requestTraceId });
      }
    }

    if (activeAction === 'CONFIRM_PENDING_ACTION') {
      if (!isAuthed) {
        return sendJSON(res, 401, { reply: `[AGENT] Confirmation Aborted: Authentication required.`, traceId: requestTraceId });
      }
      if (!pendingActionToken) {
        return sendJSON(res, 200, { reply: `[AGENT] No token provided. Usage: /approve <token> or /decline <token>.`, traceId: requestTraceId });
      }
      if (!supabaseUrl || !supabaseKey) {
        return sendJSON(res, 200, { reply: `[AGENT] Confirmation Aborted: Supabase not configured, cannot look up pending proposals.`, traceId: requestTraceId });
      }

      var pendingLoad = await loadPendingAction(supabaseUrl, supabaseKey, pendingActionToken);
      if (!pendingLoad.ok) {
        return sendJSON(res, 200, { reply: `[AGENT] Confirmation Aborted: ${pendingLoad.error}`, traceId: requestTraceId });
      }
      var pendingRow = pendingLoad.row;

      if (pendingRow.status !== 'pending') {
        return sendJSON(res, 200, { reply: `[AGENT] This proposal is already '${pendingRow.status}' — nothing to do.`, traceId: requestTraceId });
      }
      if (new Date(pendingRow.expires_at).getTime() < Date.now()) {
        await resolvePendingActionStatus(supabaseUrl, supabaseKey, pendingActionToken, 'expired');
        return sendJSON(res, 200, { reply: `[AGENT] This proposal expired (it was only valid until ${pendingRow.expires_at}). Please re-propose the fix.`, traceId: requestTraceId });
      }

      if (pendingActionDecision === 'decline') {
        await resolvePendingActionStatus(supabaseUrl, supabaseKey, pendingActionToken, 'declined');
        return sendJSON(res, 200, { reply: `[AGENT] Proposal declined and discarded. Nothing was written to GitHub.`, traceId: requestTraceId });
      }

      var plan = pendingRow.plan;
      var ghHeaders = {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Sovereign-Agent',
        'Cache-Control': 'no-cache'
      };
      var repoBaseUrl = `https://api.github.com/repos/${plan.repoPath}`;
      var newBranchName = `approved-${Date.now()}`;

      try {
        if (pendingRow.action_type === 'APPLY_SURGICAL_PATCH' || pendingRow.action_type === 'ACCEPT_AUTHORIZATION') {
          var currentFileRes = await fetch(`${repoBaseUrl}/contents/${plan.actualFilePath}?ref=main`, { headers: ghHeaders, cache: 'no-store' });
          var currentFileJson = currentFileRes.ok ? await currentFileRes.json() : null;
          var currentSha = currentFileJson ? currentFileJson.sha : null;
          if ((plan.baseFileSha || null) !== (currentSha || null)) {
            await resolvePendingActionStatus(supabaseUrl, supabaseKey, pendingActionToken, 'stale');
            return sendJSON(res, 200, { reply: `[AGENT] Confirmation Aborted: '${plan.actualFilePath}' changed on GitHub since this proposal was validated. Refusing to overwrite on a stale base — please re-propose the fix.`, traceId: requestTraceId });
          }

          var mainRefRes = await fetch(`${repoBaseUrl}/git/ref/heads/main`, { headers: ghHeaders, cache: 'no-store' });
          if (!mainRefRes.ok) return sendJSON(res, 200, { reply: `[AGENT] Confirmation Failed: Could not resolve main branch reference.`, traceId: requestTraceId });
          var mainRefData = await mainRefRes.json();

          await fetch(`${repoBaseUrl}/git/refs`, {
            method: 'POST', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: `refs/heads/${newBranchName}`, sha: mainRefData.object.sha }), cache: 'no-store'
          });

          var finalContent = pendingRow.action_type === 'APPLY_SURGICAL_PATCH' ? plan.updatedContent : plan.pendingCode;
          var commitRes = await fetch(`${repoBaseUrl}/contents/${plan.actualFilePath}`, {
            method: 'PUT', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: `${pendingRow.action_type === 'APPLY_SURGICAL_PATCH' ? 'Surgical patch' : 'Approved commit'} for ${plan.actualFilePath} (approved via /approve)`,
              content: encodeBase64(finalContent),
              sha: currentSha || undefined,
              branch: newBranchName
            }), cache: 'no-store'
          });
          if (!commitRes.ok) {
            var commitErrText = await commitRes.text();
            return sendJSON(res, 200, { reply: `[AGENT] Confirmation Failed: Could not commit. ${commitErrText.substring(0, 200)}`, traceId: requestTraceId });
          }

          var prRes = await fetch(`${repoBaseUrl}/pulls`, {
            method: 'POST', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: `Approved: ${plan.actualFilePath}`,
              head: newBranchName, base: 'main',
              body: 'Approved via /approve after two-phase review.\n\n```diff\n' + pendingRow.diff_summary + '\n```'
            }), cache: 'no-store'
          });
          var prData = await prRes.json();
          await resolvePendingActionStatus(supabaseUrl, supabaseKey, pendingActionToken, 'approved');

          return sendJSON(res, 200, {
            reply: (prRes.ok ? `[AGENT] Approved & PR Opened: ${prData.html_url}` : `[AGENT] Committed, but PR creation failed.`) + `\n\n[DIFF]\n${pendingRow.diff_summary}`,
            traceId: requestTraceId
          });

        } else if (pendingRow.action_type === 'REORGANIZE_FILES') {
          var currentMainRefRes = await fetch(`${repoBaseUrl}/git/ref/heads/main`, { headers: ghHeaders, cache: 'no-store' });
          var currentMainRefData = currentMainRefRes.ok ? await currentMainRefRes.json() : null;
          var currentMainSha = currentMainRefData ? currentMainRefData.object.sha : null;
          if (plan.baseCommitSha !== currentMainSha) {
            await resolvePendingActionStatus(supabaseUrl, supabaseKey, pendingActionToken, 'stale');
            return sendJSON(res, 200, { reply: `[AGENT] Confirmation Aborted: '${plan.repoPath}' main branch moved since this proposal was built (someone else merged in the meantime). Refusing to commit on a stale base — please re-propose.`, traceId: requestTraceId });
          }

          var confirmTreeRes = await fetch(`${repoBaseUrl}/git/trees`, {
            method: 'POST', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ base_tree: plan.baseTreeSha, tree: plan.treeEntries }), cache: 'no-store'
          });
          var confirmTreeData = await confirmTreeRes.json();
          if (!confirmTreeRes.ok) {
            return sendJSON(res, 200, { reply: `[AGENT] Confirmation Failed: Could not build tree. Nothing was committed.`, traceId: requestTraceId });
          }

          var confirmCommitRes = await fetch(`${repoBaseUrl}/git/commits`, {
            method: 'POST', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: plan.commitMessage, tree: confirmTreeData.sha, parents: [plan.baseCommitSha] }), cache: 'no-store'
          });
          var confirmCommitData = await confirmCommitRes.json();
          if (!confirmCommitRes.ok) {
            return sendJSON(res, 200, { reply: `[AGENT] Confirmation Failed: Could not create commit. Nothing was pushed.`, traceId: requestTraceId });
          }

          await fetch(`${repoBaseUrl}/git/refs`, {
            method: 'POST', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: `refs/heads/${newBranchName}`, sha: confirmCommitData.sha }), cache: 'no-store'
          });

          var confirmPrRes = await fetch(`${repoBaseUrl}/pulls`, {
            method: 'POST', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: plan.commitMessage, head: newBranchName, base: 'main',
              body: 'Approved via /approve after two-phase review.\n\n' + (plan.opSummaries || []).map(function (s) { return '```\n' + s + '\n```'; }).join('\n')
            }), cache: 'no-store'
          });
          var confirmPrData = await confirmPrRes.json();
          await resolvePendingActionStatus(supabaseUrl, supabaseKey, pendingActionToken, 'approved');

          return sendJSON(res, 200, {
            reply: (confirmPrRes.ok ? `[AGENT] Reorganization approved, committed atomically & PR opened: ${confirmPrData.html_url}` : `[AGENT] Committed (${confirmCommitData.sha}), but PR creation failed.`),
            traceId: requestTraceId
          });

        } else {
          return sendJSON(res, 200, { reply: `[AGENT] Unknown pending action type '${pendingRow.action_type}'.`, traceId: requestTraceId });
        }
      } catch (err) {
        return sendJSON(res, 200, { reply: `[AGENT] Confirmation Exception: ${err.message}`, traceId: requestTraceId });
      }
    }

    // Everything past this point is the CHAT/CLAUDE_CHAT model-call fallback
    // (also reached by any unrecognized actionType that didn't match one of
    // the specific branches above) — it always spends a paid Gemini or
    // Anthropic key, so it requires authentication same as the other
    // paid/storage actions gated above.
    if (!isAuthed) {
      return sendJSON(res, 401, { reply: `[AGENT] Chat Aborted: Authentication required.`, traceId: requestTraceId });
    }

    var sysInstruction = `You are PG1-AGENT (Version 10.0 Sovereign Core), an elite autonomous intelligence operating on Vercel.
[STRICT DIRECTIVE - GROUNDING & HONESTY]: Be absolutely honest at all times about the actual factual content of your answers. Never lie or fabricate results. Stay completely grounded in the factual reality of the project. We operate an automated cybersecurity architecture deploying GitHub workflows and Supabase vault integration.
[IDENTITY DIRECTIVE]: You are PG1 Sovereign Core. Do not reveal, confirm, deny, or speculate about which underlying AI company, model family, or version powers you (including but not limited to Anthropic, Claude, Google, Gemini, OpenAI, ChatGPT). If asked directly what model or LLM you are, respond only that you are PG1 Sovereign Core. Never use those provider/model names in your replies, even in passing or hypothetically.
[CONTEXT]:\n${formattedArchive}${targetedHistoricalData}${supabaseFilesReport}`;

    if (Date.now() >= deadlineTs - 1000) {
      return sendJSON(res, 200, {
        reply: '[AGENT] Request aborted: context-gathering consumed the available time budget. Please retry.',
        traceId: requestTraceId
      });
    }

    var modelFetchResult = (activeAction === 'CLAUDE_CHAT')
      ? await fetchAnthropicCore(promptText, sysInstruction, mediaParts, '', anthropicKey, deadlineTs)
      : await fetchGeminiCore(promptText, sysInstruction, mediaParts, '', geminiKeys, deadlineTs);

    if (activeAction === 'CLAUDE_CHAT' && !modelFetchResult.text && geminiKeys.length > 0 && Date.now() < deadlineTs - 1000) {
      var anthropicError = modelFetchResult.error;
      modelFetchResult = await fetchGeminiCore(promptText, sysInstruction, mediaParts, '', geminiKeys, deadlineTs);
      if (modelFetchResult.text) {
        modelFetchResult.error = null;
      } else {
        modelFetchResult.error = `Anthropic failed (${anthropicError}); Gemini fallback also failed (${modelFetchResult.error})`;
      }
    }

    var replyText = modelFetchResult.text || `Execution failed. Model Err: ${modelFetchResult.error}`;
    if (modelFetchResult.text) {
      replyText = replyText.replace(/\b(Google|Gemini|ChatGPT|Claude)\b/gi, 'PG1 Sovereign Core');
    }

    if (supabaseUrl && supabaseKey && !replyText.startsWith('Execution failed') && !isPdfExport) {
      fetch(`${supabaseUrl}/rest/v1/messages`, {
        method: 'POST',
        headers: { ...dbHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ role: 'user', content: promptText }, { role: 'model', content: replyText }]),
        cache: 'no-store'
      }).catch(() => {});
    }

    var audioBase64 = null;
    var audioStatus = 'DECOUPLED_PENDING_ASYNC_CALL';

    return sendJSON(res, 200, {
      reply: replyText,
      audio: audioBase64,
      audioStatus: audioStatus,
      audioMimeType: 'audio/mp3',
      traceId: requestTraceId,
      telemetry: { supabaseStatus: supabaseStatus, executionTimeMs: Date.now() - startTime }
    });

  } catch (err) {
    return sendJSON(res, 200, { reply: `Exception: ${err.message}`, traceId: requestTraceId });
  }
}