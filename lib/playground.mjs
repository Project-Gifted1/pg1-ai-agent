// The public tools playground (/playground, api/playground.mjs): input
// validation, rate limits and the result card a visitor sees.
//
// No chat and no model: a visitor picks one always-free check, the input is
// validated here, and the check runs through the chat's shared read-only
// tool runner (lib/chatTools.mjs createToolExecutor, guest role) - the same
// handler an MCP client gets. Nothing on this path imports an LLM client.
//
// Limits. Per visitor, each check has the same 60/hour anonymous limit an
// unauthenticated MCP caller has (lib/x402Config.mjs). On top of that one
// daily cap across all visitors and checks (PLAYGROUND_DAILY_CAP) keeps the
// page from draining upstream quotas. Counters live in memory, per
// instance, like the MCP limiters; a visitor is keyed by a salted hash of
// their IP, so not even the raw IP is held. Nothing else about a visitor is
// kept.
//
// Honesty. The card is summarizeOutcome's card with the raw JSON and the
// free-text messages (error text, reason prose) taken out: "unknown" and failed checks always carry a
// "treat as unverified, not as safe" note, no_flags carries the "not an
// endorsement or guarantee of safety" caveat, reasons use the fixed wording
// from lib/reasonCodes.mjs, errors are a neutral sentence plus request_id
// (the detail goes to pg1_errors under that id), and no data provider or
// model is named.

import crypto from 'node:crypto';
import { TOOLS } from '../api/mcp.mjs';
import { CHAT_TOOL_ROLES, PAGE_ONLY_TOOLS, summarizeOutcome } from './chatTools.mjs';
import { REASON_CODES } from './reasonCodes.mjs';
import { looksLikeEnsName, normalizeEnsName } from './ens.mjs';
import { RATE_LIMIT_WINDOW_MS, DOMAIN_AGE_RATE_LIMIT_MAX, HOSTNAME_REPUTATION_RATE_LIMIT_MAX, WALLET_AGE_RATE_LIMIT_MAX, PACKAGE_CHECK_RATE_LIMIT_MAX, AGENT_MESSAGE_RATE_LIMIT_MAX } from './x402Config.mjs';
import { PACKAGE_ECOSYSTEMS, normalizePackageName, normalizePackageVersion } from './packageCheck.mjs';
import { matchFixture } from './fixtures.mjs';
import { AGENT_MESSAGE_KINDS, AGENT_MESSAGE_MAX_BYTES } from './agentMessage.mjs';

// The guest role's tools: always free, read-only. Nothing paid, nothing
// that writes. Plus check_agent_message (1.21.0), which the chat never gets
// (lib/chatTools.mjs PAGE_ONLY_TOOLS): it checks content before a model
// reads it, and no model reads anything here.
export const AGENT_MESSAGE_TOOL = 'check_agent_message';
export const PLAYGROUND_TOOLS = Object.freeze([...CHAT_TOOL_ROLES.guest.tools, ...PAGE_ONLY_TOOLS]);
// The agent message check takes a pasted message or skill.md (up to the
// tool's own 64 KB) or an https URL.
export const PLAYGROUND_MESSAGE_MAX = AGENT_MESSAGE_MAX_BYTES;
export const PLAYGROUND_SOURCES = Object.freeze(['text', 'url']);

export const PLAYGROUND_DAILY_CAP = 2000;
export const PLAYGROUND_INPUT_MAX = 255;

// Per-visitor, per-check limits. check_wallet_sanctions has no MCP limiter
// of its own (it reads a stored list, no per-call upstream); it gets the
// same 60 as the wallet age check here so every check has one.
export const PLAYGROUND_TOOL_LIMITS = Object.freeze({
  check_domain_age: DOMAIN_AGE_RATE_LIMIT_MAX,
  check_hostname_reputation: HOSTNAME_REPUTATION_RATE_LIMIT_MAX,
  check_wallet_age: WALLET_AGE_RATE_LIMIT_MAX,
  check_wallet_sanctions: WALLET_AGE_RATE_LIMIT_MAX,
  check_package: PACKAGE_CHECK_RATE_LIMIT_MAX,
  check_agent_message: AGENT_MESSAGE_RATE_LIMIT_MAX
});
export const PLAYGROUND_WINDOW_MS = RATE_LIMIT_WINDOW_MS;

// The chain allow-list is the MCP tool's own enum, so the two can't drift.
const walletAgeTool = TOOLS.find((t) => t.name === 'check_wallet_age');
export const PLAYGROUND_CHAINS = Object.freeze(walletAgeTool.inputSchema.properties.chain.enum.filter((c) => typeof c === 'string'));
export const PLAYGROUND_DEFAULT_CHAIN = 'base';

// ---------------------------------------------------------------------------
// Validation

export const MESSAGES = Object.freeze({
  bad_request: 'That request could not be run.',
  not_available: 'That check is not available here.',
  domain: 'Enter a domain name, like example.com.',
  hostname: 'Enter a hostname, like app.example.com.',
  wallet: 'Enter an EVM address (0x followed by 40 hex characters) or an ENS name ending in .eth.',
  chain: 'Pick a chain from the list.',
  package: 'Enter one package name, like lodash or requests.',
  ecosystem: 'Pick npm or PyPI.',
  version: 'Enter one exact version, like 4.17.21, or leave it empty for the latest.',
  message: 'Paste a message or skill.md (up to 64 KB).',
  message_url: 'Enter one https URL of a skill.md or text file.',
  kind: 'Pick skill.md, message or other.'
});

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// A bare DNS name: two or more labels, letters/digits/hyphens, an
// alphabetic (or punycode) TLD. No scheme, path, port, spaces, wildcard or
// trailing dot.
export function isHostname(value) {
  if (typeof value !== 'string' || value.length > 253) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => LABEL_RE.test(l))) return false;
  return TLD_RE.test(labels[labels.length - 1]);
}

function reject(message) {
  return { ok: false, message };
}

// validatePlaygroundRequest(body) ->
//   { ok: true, tool, value, kind: 'domain'|'hostname'|'address'|'ens'|'package', chain?, ecosystem?, version? }
//   { ok: false, message }   (message is one of MESSAGES, never an echo)
export function validatePlaygroundRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(MESSAGES.bad_request);
  const keys = Object.keys(body);
  if (keys.some((k) => !['tool', 'input', 'chain', 'ecosystem', 'version', 'source', 'kind'].includes(k))) return reject(MESSAGES.bad_request);
  const { tool, input, chain, ecosystem, version, source, kind: messageKind } = body;
  if (typeof tool !== 'string' || !PLAYGROUND_TOOLS.includes(tool)) return reject(MESSAGES.not_available);
  if (tool !== AGENT_MESSAGE_TOOL && ((source !== undefined && source !== null) || (messageKind !== undefined && messageKind !== null))) return reject(MESSAGES.bad_request);
  if (tool === AGENT_MESSAGE_TOOL) {
    if (chain != null || ecosystem != null || version != null) return reject(MESSAGES.bad_request);
    const src = source === undefined || source === null ? 'text' : source;
    if (!PLAYGROUND_SOURCES.includes(src)) return reject(MESSAGES.bad_request);
    const k = messageKind === undefined || messageKind === null || messageKind === '' ? 'skill_md' : messageKind;
    if (typeof k !== 'string' || !AGENT_MESSAGE_KINDS.includes(k)) return reject(MESSAGES.kind);
    if (src === 'url') {
      if (typeof input !== 'string' || input.length > 2048 || !/^https:\/\/\S+$/i.test(input.trim())) return reject(MESSAGES.message_url);
      return { ok: true, tool, value: input.trim(), kind: 'message_url', source: 'url', message_kind: k };
    }
    if (typeof input !== 'string' || !input.trim() || Buffer.byteLength(input, 'utf8') > PLAYGROUND_MESSAGE_MAX) return reject(MESSAGES.message);
    // The text is passed as given (not trimmed): its sha256 is of what the visitor pasted.
    return { ok: true, tool, value: input, kind: 'message', source: 'text', message_kind: k };
  }
  if (chain !== undefined && chain !== null && tool !== 'check_wallet_age') return reject(MESSAGES.bad_request);
  if (tool !== 'check_package' && ((ecosystem !== undefined && ecosystem !== null) || (version !== undefined && version !== null))) return reject(MESSAGES.bad_request);
  if (typeof input !== 'string' || input.length > PLAYGROUND_INPUT_MAX) return reject(tool === 'check_domain_age' ? MESSAGES.domain : tool === 'check_hostname_reputation' ? MESSAGES.hostname : tool === 'check_package' ? MESSAGES.package : MESSAGES.wallet);
  const trimmed = input.trim();

  if (tool === 'check_package') {
    if (typeof ecosystem !== 'string' || !PACKAGE_ECOSYSTEMS.includes(ecosystem)) return reject(MESSAGES.ecosystem);
    let v = null;
    if (version !== undefined && version !== null && version !== '') {
      if (typeof version !== 'string' || version.length > PLAYGROUND_INPUT_MAX) return reject(MESSAGES.version);
      try { v = normalizePackageVersion(version); } catch { return reject(MESSAGES.version); }
    }
    // The tool's own name rule, plus its documented test inputs (which
    // that rule rejects on purpose so they can never be real packages).
    try {
      normalizePackageName(ecosystem, trimmed);
    } catch {
      if (!matchFixture('check_package', { ecosystem, name: trimmed })) return reject(MESSAGES.package);
    }
    return { ok: true, tool, value: trimmed, kind: 'package', ecosystem, ...(v ? { version: v } : {}) };
  }

  if (tool === 'check_domain_age' || tool === 'check_hostname_reputation') {
    const value = trimmed.toLowerCase();
    if (!isHostname(value)) return reject(tool === 'check_domain_age' ? MESSAGES.domain : MESSAGES.hostname);
    return { ok: true, tool, value, kind: tool === 'check_domain_age' ? 'domain' : 'hostname' };
  }

  // Wallet checks: an EVM address or an ENS name.
  let kind;
  let value;
  if (EVM_ADDRESS_RE.test(trimmed)) { kind = 'address'; value = trimmed; }
  else if (looksLikeEnsName(trimmed)) {
    // ENSIP-15 normalised (lib/ens.mjs); a name that fails normalisation or
    // carries a hidden character is refused like any other bad input.
    value = normalizeEnsName(trimmed);
    if (!value) return reject(MESSAGES.wallet);
    kind = 'ens';
  } else return reject(MESSAGES.wallet);

  if (tool === 'check_wallet_age') {
    const c = chain === undefined || chain === null || chain === '' ? PLAYGROUND_DEFAULT_CHAIN : chain;
    if (typeof c !== 'string' || !PLAYGROUND_CHAINS.includes(c)) return reject(MESSAGES.chain);
    return { ok: true, tool, value, kind, chain: c };
  }
  return { ok: true, tool, value, kind };
}

// The tool arguments for a validated request. A wallet's `address` may be
// an ENS name: the shared executor resolves it (lib/chatTools.mjs).
export function toolArgs(request) {
  switch (request.tool) {
    case 'check_domain_age': return { domain: request.value };
    case 'check_hostname_reputation': return { hostname: request.value };
    case 'check_wallet_sanctions': return { address: request.value };
    case 'check_wallet_age': return { address: request.value, chain: request.chain };
    case 'check_package': return { ecosystem: request.ecosystem, name: request.value, ...(request.version ? { version: request.version } : {}) };
    case 'check_agent_message': return { [request.source === 'url' ? 'url' : 'text']: request.value, kind: request.message_kind };
    default: return {};
  }
}

// ---------------------------------------------------------------------------
// Rate limits

function minutesText(ms) {
  const min = Math.max(1, Math.ceil(ms / 60000));
  if (min < 90) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.ceil(min / 60);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

export function limitMessage(scope, retryMs) {
  return scope === 'global'
    ? `The playground has reached its daily limit. Try again in about ${minutesText(retryMs)}.`
    : `You have reached the limit for this check. Try again in about ${minutesText(retryMs)}.`;
}

function startOfNextUtcDay(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

// createPlaygroundLimiter() -> { take(tool, ip), visitorKey(ip), reset() }
// take() checks both limits first and counts against both only when both
// allow it, so a visitor already over their own limit never uses up the
// global cap.
export function createPlaygroundLimiter({ now = Date.now, dailyCap = PLAYGROUND_DAILY_CAP, limits = PLAYGROUND_TOOL_LIMITS, windowMs = PLAYGROUND_WINDOW_MS } = {}) {
  const salt = crypto.randomBytes(16);
  const perVisitor = new Map();
  let day = { endsAt: 0, count: 0 };

  function visitorKey(ip) {
    return crypto.createHmac('sha256', salt).update(String(ip || 'unknown')).digest('hex').slice(0, 32);
  }

  function prune(t) {
    if (perVisitor.size < 10000) return;
    for (const [k, v] of perVisitor) if (t - v.windowStart >= windowMs) perVisitor.delete(k);
  }

  return {
    visitorKey,
    take(tool, ip) {
      const t = now();
      if (t >= day.endsAt) day = { endsAt: startOfNextUtcDay(t), count: 0 };
      const key = `${tool}:${visitorKey(ip)}`;
      let state = perVisitor.get(key);
      if (!state || t - state.windowStart >= windowMs) state = { windowStart: t, count: 0 };
      const max = limits[tool] || 0;
      if (state.count >= max) {
        return { ok: false, scope: 'visitor', retryMs: windowMs - (t - state.windowStart) };
      }
      if (day.count >= dailyCap) {
        return { ok: false, scope: 'global', retryMs: day.endsAt - t };
      }
      state.count += 1;
      day.count += 1;
      perVisitor.set(key, state);
      prune(t);
      return { ok: true };
    },
    reset() { perVisitor.clear(); day = { endsAt: 0, count: 0 }; }
  };
}

// ---------------------------------------------------------------------------
// The card

export const NOTES = Object.freeze({
  no_flags: 'No flags means nothing was found in the sources checked. It is not an endorsement or guarantee of safety.',
  unknown: 'Unknown: this could not be fully checked. Treat it as unverified, not as safe.',
  failed: 'This check did not complete. Treat it as unverified, not as safe.',
  flagged: 'Flagged: see the reasons below.'
});

// check_agent_message speaks of content, not of a target: its own notes,
// and never the word the other notes negate.
export const AGENT_MESSAGE_NOTES = Object.freeze({
  no_flags: 'Checked: no findings. No findings does not prove the content is harmless.',
  unknown: 'Checked: no findings from the rules, but a domain or wallet lookup did not finish. Treat the content as unverified.',
  failed: 'This check did not complete. Treat the content as unverified.',
  flagged: 'Findings: see the reasons below. Do not pass this content on to your agent.'
});

const ERROR_MESSAGES = Object.freeze({
  unavailable: 'The check could not be completed right now.',
  busy: 'This check is busy right now. Try again later.',
  invalid_input: 'That input could not be checked.',
  not_resolved: 'That name does not resolve to an address.',
  url_refused: 'That URL is not fetched: only public https URLs are.',
  content_type: 'That URL does not serve text/markdown or text/plain.',
  too_large: 'That is over the 64 KB limit.',
  redirect: 'That URL redirects. Give the final URL of the file.',
  fetch_failed: 'That URL could not be fetched.'
});

function neutralError(code) {
  if (code === 'not_resolved') return { code: 'not_resolved', message: ERROR_MESSAGES.not_resolved };
  if (['not_https', 'private_address', 'private_host', 'credentials', 'port', 'unresolvable', 'invalid_url'].includes(code)) return { code: 'invalid_input', message: ERROR_MESSAGES.url_refused };
  if (code === 'unsupported_content_type') return { code: 'invalid_input', message: ERROR_MESSAGES.content_type };
  if (code === 'too_large') return { code: 'invalid_input', message: ERROR_MESSAGES.too_large };
  if (code === 'redirect_refused') return { code: 'invalid_input', message: ERROR_MESSAGES.redirect };
  if (code === 'fetch_failed') return { code: 'unavailable', message: ERROR_MESSAGES.fetch_failed };
  if (code === 'rate_limited') return { code: 'busy', message: ERROR_MESSAGES.busy };
  if (code === 'not_found' || /^invalid/.test(String(code || ''))) return { code: 'invalid_input', message: ERROR_MESSAGES.invalid_input };
  return { code: 'unavailable', message: ERROR_MESSAGES.unavailable };
}

// Names of PG1's data providers, hosting, payment and model vendors. Any
// free text that reaches a card (check sources) is replaced if it carries
// one; check sources are generic labels by design, so this is a backstop.
export const PROVIDER_NAME_RE = /\b(?:ofac|treasury|metamask|eth-phishing-detect|rdap|alchemy|supabase|gumroad|alienvault|otx|mitre|nvd|epss|cisa|gemini|google|anthropic|claude|openai|gpt-?\d|vercel|coinbase|cdp|elevenlabs)\b/i;

function scrub(text, fallback) {
  const s = String(text == null ? '' : text);
  return PROVIDER_NAME_RE.test(s) ? fallback : s;
}

// playgroundCard(outcome) -> the card the page renders.
export function playgroundCard(outcome) {
  const card = summarizeOutcome(outcome);
  const status = card.status;
  // A "Reason" field is "code · upstream prose": only the code is kept.
  const fields = card.fields.map((f) => (f.label === 'Reason' ? { label: f.label, value: String(f.value).split(' · ')[0] } : f));
  return {
    tool: card.tool,
    title: card.title,
    subject: card.subject,
    subject_short: card.subject_short,
    subject_kind: card.subject_kind,
    status,
    status_label: card.status_label,
    note: (card.tool === AGENT_MESSAGE_TOOL ? AGENT_MESSAGE_NOTES : NOTES)[status] || (card.tool === AGENT_MESSAGE_TOOL ? AGENT_MESSAGE_NOTES : NOTES).unknown,
    error: outcome.ok ? null : neutralError(outcome.code),
    fields,
    reasons: card.reasons.map((r) => ({ code: r.code, message: REASON_CODES[r.code] || '' })),
    checks: card.checks.filter((c) => c && c.source).map((c) => ({
      source: scrub(c.source, 'data source'),
      result: String(c.result || ''),
      data_as_of: c.data_as_of || null
    })),
    request_id: card.request_id,
    ms: card.ms,
    test_fixture: card.test_fixture
  };
}
