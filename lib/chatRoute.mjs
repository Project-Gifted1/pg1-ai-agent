// Which kind of Gemini request a chat message gets: PG1's checks, or web
// search. Never both.
//
// Since #243 the chat offered PG1's checks as function declarations and kept
// Google Search on in the same request. The Gemini API refuses that
// combination (400 "Multiple tools are supported only when they are all
// search tools."), and the old code answered the 400 by switching search off
// for every later request in the server process, with no log line and no
// pg1_errors row. So one rejection took search away until the next cold
// start, silently.
//
// Now each message picks one route before the first model call:
//   - 'tools': the message contains or asks about a domain, hostname, URL,
//     IP address, wallet address or ENS name, or names one of PG1's checks.
//     The request carries the function declarations and no search.
//   - 'search': everything else. The request carries Google Search and no
//     function declarations; the model itself decides whether a message
//     needs a search (news, "latest", "today", prices, people, general
//     lookups), as it did before #243.
// On the tools route, if the model makes no tool call, one second call with
// search is allowed for that same message (searchAfterTools).

import { parse } from 'tldts';
import { ensMentions } from './ens.mjs';
import { isRecognizedWalletAddress } from './walletAddress.mjs';
import { READ_ONLY_CHAT_TOOLS, TOOL_PLAIN_NAMES } from './chatTools.mjs';

export const CHAT_ROUTES = Object.freeze({ TOOLS: 'tools', SEARCH: 'search' });

const URL_RE = /\b(?:https?|ftp|wss?):\/\/[^\s<>"'`]+|\bwww\.[^\s<>"'`]+/i;
// A dotted name: labels of letters, digits and hyphens, a final label of
// letters. Checked against the public suffix list below.
const HOSTNAME_RE = /(?<![\w@./-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}[a-z0-9](?![\w-]|\.[a-z0-9])/gi;
// Reserved names (RFC 2606 / 6761) are not on the public suffix list but are
// what PG1's test fixtures use (pg1-test-flagged.invalid).
const RESERVED_TLDS = new Set(['invalid', 'test', 'example', 'localhost', 'onion']);
// Real top-level domains that are far more often a file extension in a chat
// about code ("README.md", "setup.py"): such a name only counts as a
// hostname when it has more than one dot or comes in a URL.
const FILE_LIKE_TLDS = new Set(['md', 'py', 'rs', 'sh', 'pl', 'zip', 'mov', 'ps']);
const IPV4_RE = /(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\d.])/;
const IPV6_RE = /(?<![\w:])(?:[0-9a-f]{1,4}:){2,7}(?::|[0-9a-f]{1,4})(?![\w:])/i;
const EVM_RE = /\b0x[0-9a-fA-F]{40}\b/;
const WORD_RE = /[A-Za-z0-9:]{26,110}/g;
const CVE_RE = /\bCVE-\d{4}-\d{4,}\b/i;
const HASH_RE = /\b(?:[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})\b/i;
const CHECK_VERB_RE = /\b(?:check|verify|screen|scan|look\s*up|lookup|is\s+(?:it|this|that)\s+(?:safe|malicious|flagged|sanctioned|legit))\b/i;

// The checks by name: the MCP tool names, their plain names, and the few
// other ways the operator names them.
const CHECK_NAME_RE = new RegExp('\\b(?:' + [
  ...READ_ONLY_CHAT_TOOLS,
  ...READ_ONLY_CHAT_TOOLS.map((n) => TOOL_PLAIN_NAMES[n]).filter(Boolean).map((p) => p.replace(/ /g, '\\s+')),
  'sanctions?\\s+(?:check|screen(?:ing)?|list)',
  'ioc\\s+(?:context|lookup|check|batch)',
  'threat\\s+actor\\s+(?:profile|lookup)',
  'cve\\s+(?:lookup|check|details)',
  'domain\\s+(?:check|reputation)',
  'pg1\\s+(?:check|checks|tools?)'
].join('|') + ')\\b', 'i');

// Signs a message wants current information. Used only to decide whether a
// tools-route message that ran no check gets the second, search call.
const CURRENT_INFO_RE = /\b(?:news|latest|today|tonight|yesterday|this\s+(?:week|month|year)|current(?:ly)?|recent(?:ly)?|right\s+now|nowadays|breaking|trending|headlines?|announce(?:d|ment)s?|released?|price|prices|priced|market\s+cap|exchange\s+rate|weather|score|who\s+(?:is|won|are)|what\s+happened|update[sd]?|search|google|look\s+(?:it\s+)?up\s+online|on\s+the\s+web)\b|(?<![\w-])20[2-9]\d(?![\w-])/i;

function hostnameMentioned(text) {
  for (const m of text.matchAll(HOSTNAME_RE)) {
    const token = m[0].replace(/\.$/, '');
    if (/\.eth$/i.test(token)) continue; // ENS, handled on its own
    const labels = token.toLowerCase().split('.');
    const tld = labels[labels.length - 1];
    if (RESERVED_TLDS.has(tld)) return true;
    if (labels.length === 2 && FILE_LIKE_TLDS.has(tld)) continue;
    const info = parse(token);
    if (info.domain && info.isIcann && info.domainWithoutSuffix) return true;
  }
  return false;
}

function walletMentioned(text) {
  if (EVM_RE.test(text)) return true;
  for (const m of text.matchAll(WORD_RE)) {
    // A non-EVM wallet shape: long, mixed case or prefixed, never a plain
    // English word or a hex digest.
    const w = m[0];
    if (/^[a-z]+$/.test(w) || /^[0-9a-f]+$/i.test(w)) continue;
    if (/[0-9]/.test(w) && isRecognizedWalletAddress(w)) return true;
  }
  return false;
}

// Why a message goes the tools way, or null. The reason is a fixed word for
// the log line, never text from the message.
export function toolsRouteReason(text) {
  const t = typeof text === 'string' ? text : '';
  if (!t.trim()) return null;
  if (URL_RE.test(t)) return 'url';
  if (ensMentions(t).length) return 'ens_name';
  if (walletMentioned(t)) return 'wallet_address';
  if (IPV4_RE.test(t) || IPV6_RE.test(t)) return 'ip_address';
  if (hostnameMentioned(t)) return 'hostname';
  if (CHECK_NAME_RE.test(t)) return 'check_name';
  if (CHECK_VERB_RE.test(t) && (CVE_RE.test(t) || HASH_RE.test(t))) return 'check_request';
  return null;
}

// The route for one message. `hasTools` is false when the caller's role has
// no checks (then it is always search).
export function chooseChatRoute(text, { hasTools = true } = {}) {
  const reason = hasTools ? toolsRouteReason(text) : null;
  return reason ? { route: CHAT_ROUTES.TOOLS, reason } : { route: CHAT_ROUTES.SEARCH, reason: 'default' };
}

export function wantsCurrentInfo(text) {
  return typeof text === 'string' && CURRENT_INFO_RE.test(text);
}

// After the tools route: does this message get the one search call? Only
// when the model ran no check and either the message asks for current
// information or the tools round produced no answer at all.
export function searchAfterTools(text, toolResult) {
  const r = toolResult || {};
  if (r.aborted) return false;
  if (Array.isArray(r.outcomes) && r.outcomes.length) return false;
  return wantsCurrentInfo(text) || !r.text;
}
