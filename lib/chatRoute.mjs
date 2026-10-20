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
//   - 'tools' too, ahead of all the above: for the operator (the only role
//     with search_history), a question about an earlier conversation ("do
//     you remember...", "what did we say about...", "last time we...", "the
//     snippet I pasted yesterday", "the link I sent you", "you said...").
//     Its first round must call search_history, and it never gets the
//     search call afterwards.
//   - 'tools' too: when generate_video is on offer (the operator, with
//     PG1_VIDEO_ENABLED=1), a message that mentions a video, clip or
//     animation in words the strict request match in api/chat.mjs missed.
//     The model decides whether it is a request for one.
//   - 'search': a message that needs current or external information
//     (news, "latest", "today", prices, a URL when the role has no checks,
//     current versions, an explicit "search" / "look up"). The request
//     carries Google Search and no function declarations.
//   - 'chat': everything else (small talk, questions the model can answer
//     from what it knows, work on code). Plain chat: no search, no
//     function declarations. Until 20 Oct every such message went the
//     search way ("route=search reason=default"), so a rate-limited free
//     key held each reply ~19 s and then appended the "live search was
//     unavailable" footer to small talk.
// On the tools route, if the model makes no tool call, one second call with
// search is allowed for that same message (searchAfterTools).

import { parse } from 'tldts';
import { ensMentions } from './ens.mjs';
import { isRecognizedWalletAddress } from './walletAddress.mjs';
import { READ_ONLY_CHAT_TOOLS, TOOL_PLAIN_NAMES, SEARCH_HISTORY_TOOL } from './chatTools.mjs';
import { mentionsVideo } from './videoText.mjs';

export const CHAT_ROUTES = Object.freeze({ TOOLS: 'tools', SEARCH: 'search', CHAT: 'chat' });

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

// A question about how PG1's own tools are being used, for the operator-only
// get_usage_stats tool (lib/chatTools.mjs): "how many agents used our tools
// this week?", "tool usage today", "/usage"-style wording.
const USAGE_RE = /\b(?:get_usage_stats|usage\s+stats?|usage\s+statistics|tool\s+usage|usage\s+of\s+(?:our|the|pg1'?s?|my)\s+(?:tools?|mcp|api|endpoints?)|how\s+many\s+(?:agents|callers|clients|calls|requests|users)\b[^\n]{0,80}?\b(?:used?|using|call(?:ed|ing)?|hit|tools?|mcp|a2a|api|endpoints?|playground))\b/i;

// A question about an earlier conversation, for the operator-only
// search_history tool (lib/chatTools.mjs): "do you remember...", "what did
// we say about...", "last time...". Only routes to tools when the caller's
// role has search_history (chooseChatRoute's historySearch option), and
// then it wins over everything else: a name in a recall question ("do you
// remember Blanco Ekama?") is a history search, never a web search.
const HISTORY_RE = /\b(?:search_history|(?:do|did|can|could)\s+(?:you|u|ya)\s+(?:still\s+|even\s+)?(?:remember|recall)|(?:you|u)\s+remember|remember\s+(?:when|what|that\s+time|our|the\s+time)|recall\s+(?:when|what|our)|what\s+(?:did|have|had)\s+(?:we|i|you)\s+(?:\w+\s+)?(?:say|said|discuss|discussed|talk|talked|decide|decided|agree|agreed|mention|mentioned|conclude|concluded|tell|told)|last\s+time\s+(?:we|i|you)|(?:did|have|had)\s+(?:i|we|you)\s+(?:ever\s+|already\s+)?(?:tell|told|mention|mentioned|talk|talked|discuss|discussed|say|said|bring|brought)|when\s+did\s+(?:we|i|you)\s+(?:last\s+|first\s+)?(?:talk|discuss|mention|say|bring)|remind\s+me\s+(?:what|who|when|where|about|of)|(?:did|have)\s+we\s+(?:ever\s+|already\s+)?(?:talk|talked|speak|spoken|chat|chatted)\s+about|we\s+(?:talked|spoke|chatted)\s+about|you\s+(?:told|said\s+to)\s+me|(?:earlier|previous|past|prior|old|older)\s+(?:conversations?|chats?|discussions?|sessions?)|(?:conversation|chat)\s+history)\b/i;

// A reference to something from an earlier chat that HISTORY_RE's
// question forms miss: "the HTML snippet I pasted yesterday", "what was the
// link I sent you last week?", "the file I gave you", "you said...", "we
// discussed...", "from our last chat". Without it such a message went to
// web search, whose prompt has no search_history, and PG1 said it could not
// see past chats.
const SHARE_VERB = '(?:pasted|sent|shared|gave|given|showed|shown|uploaded|posted|forwarded|attached|dropped|wrote|typed|told\\s+you|mentioned|asked\\s+(?:you\\s+)?about|said|paste|send|share|give|show|upload|post|forward|attach|tell\\s+you|mention)';
const PAST_TIME = '(?:yesterday|earlier|before|previously|last\\s+(?:week|night|month|time|chat|session|conversation)|the\\s+other\\s+day|this\\s+morning|a\\s+while\\s+(?:ago|back)|(?:a\\s+few|several|\\d+|two|three|four|five)\\s+(?:days?|weeks?|months?)\\s+ago|on\\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day)';
const HISTORY_REF_RE = new RegExp([
  // "I pasted / sent / told you / mentioned ... yesterday / last week / before"
  `\\b(?:i|we)\\s+(?:had\\s+|have\\s+|already\\s+)?${SHARE_VERB}\\b[^.?!\\n]{0,80}?\\b${PAST_TIME}\\b`,
  // "the link I sent you", "the snippet I gave you", "the file we shared with you"
  `\\bthe\\s+(?:[\\w'-]+\\s+){1,4}(?:that\\s+|which\\s+)?(?:i|we)\\s+(?:had\\s+|have\\s+|already\\s+)?(?:pasted|sent|shared|gave|showed|uploaded|posted|forwarded|attached|dropped|wrote)\\s+(?:you|u|to\\s+you|with\\s+you)\\b`,
  // "you said", "you told me", "you suggested"
  '\\b(?:you|u)\\s+(?:said|told\\s+me|mentioned|suggested|recommended|promised)\\b',
  // "we discussed", "we went over", "we agreed"
  '\\bwe\\s+(?:discussed|went\\s+over|covered|agreed|decided)\\b',
  // "from our last chat", "in our previous conversation"
  '\\b(?:from|in|during|since)\\s+our\\s+(?:last|previous|earlier|other|first|old)\\s+(?:chats?|conversations?|sessions?|discussions?|talks?)\\b',
  // "search our chat history for ...", the phrasing PG1 asks for when a
  // reference reached a web-search request (HISTORY_CAPABILITY_SEARCH_TEXT)
  '\\bsearch\\s+(?:our|my|the)\\s+(?:chat\\s+|conversation\\s+)?history\\b'
].join('|'), 'i');

// Signs a message wants current information. Used only to decide whether a
// tools-route message that ran no check gets the second, search call.
const CURRENT_INFO_RE = /\b(?:news|latest|today|tonight|yesterday|this\s+(?:week|month|year)|current(?:ly)?|recent(?:ly)?|right\s+now|nowadays|breaking|trending|headlines?|announce(?:d|ment)s?|released?|price|prices|priced|market\s+cap|exchange\s+rate|weather|score|who\s+(?:is|won|are)|what\s+happened|update[sd]?|search|google|look\s+(?:it\s+)?up\s+online|on\s+the\s+web)\b|(?<![\w-])20[2-9]\d(?![\w-])/i;

// Signs a message needs a web search before it can be answered: the
// route decision (searchRouteReason). Narrower than CURRENT_INFO_RE: an
// "update" to a file or a bare year in a version string is not news.
// "today", "now" or "this week" alone is small talk ("how are you
// today?"); with an event, a price or "what's happening" it is news.
const NEEDS_CURRENT_RE = /\b(?:news|latest|newest|today'?s\s+(?:news|headlines|price|prices|rate|events?|match|game|weather)|what(?:'s|\s+is)\s+(?:happening|going\s+on|new)\s+(?:today|tonight|this\s+week|right\s+now|in\s+the\s+world)|(?:happening|going\s+on)\s+(?:today|right\s+now)\s+(?:in|with|on)|breaking|trending|headlines?|just\s+(?:announced|released|launched)|announce(?:d|ment)s?\s+(?:today|this|yesterday)|price\s+of|prices?\s+(?:of|for|today|now)|(?:current|today'?s|live)\s+(?:price|prices|rate|rates|version|release|status|score|weather|value)|how\s+much\s+is\s+(?:a|an|one|1)?\s*[\w$-]+\s+(?:worth|now|today|trading)|market\s+cap|exchange\s+rate|stock\s+price|weather|forecast|(?:who|which\s+team)\s+won|what\s+happened\b[^.?!\n]{0,40}?\b(?:today|tonight|yesterday|this\s+(?:week|month|year)|lately|recently|in\s+the\s+last)|release\s+date|(?:most\s+)?recent\s+(?:version|release|news|update)|current\s+(?:version|release)|(?:new|latest)\s+(?:version|release)\s+of|is\s+there\s+a\s+new\s+(?:version|release))\b/i;
const EXPLICIT_SEARCH_RE = /\b(?:search\s+(?:the\s+web|online|the\s+internet|for|google)|web\s+search|google\s+(?:it|for|this|that)|look\s+(?:it\s+|this\s+|that\s+)?up(?:\s+online)?|search\s+(?:it|this|that)|on\s+the\s+web|online\s+search|browse\s+(?:to|the\s+web))\b|^\s*search\b/i;

// Why a message goes the search way, or null (then plain chat). A fixed
// word for the log line, never text from the message.
export function searchRouteReason(text) {
  const t = typeof text === 'string' ? text : '';
  if (!t.trim()) return null;
  if (EXPLICIT_SEARCH_RE.test(t)) return 'explicit_search';
  if (URL_RE.test(t)) return 'url';
  if (NEEDS_CURRENT_RE.test(t)) return 'needs_current_info';
  return null;
}

// The route reason of a plain-chat message: nothing in it needs a search.
export const CHAT_ROUTE_REASON = 'no_current_info';

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
  if (USAGE_RE.test(t)) return 'usage_stats';
  if (CHECK_VERB_RE.test(t) && (CVE_RE.test(t) || HASH_RE.test(t))) return 'check_request';
  return null;
}

// A question about an earlier conversation (search_history).
export function asksAboutHistory(text) {
  return typeof text === 'string' && (HISTORY_RE.test(text) || HISTORY_REF_RE.test(text));
}

// The route reason of a recall question (search_history).
export const HISTORY_ROUTE_REASON = 'history';

// The route reason of a message about a video (generate_video).
export const VIDEO_ROUTE_REASON = 'video';

// The route for one message. `hasTools` is false when the caller's role has
// no checks (then it is always search). `historySearch` is true only when
// the role has search_history (the operator): then a question about an
// earlier conversation goes the tools way, ahead of every other signal.
// `videoTool` is true only when generate_video is on offer.
// The route reason of a message a PG1 skill fits (load_skill, lib/skills).
export const SKILL_ROUTE_REASON = 'skill';

// `skillMatch` is true when an active skill fits the message (lib/skills
// matchSkills): the tools route, so load_skill is on offer.
function searchOrChat(text) {
  const why = searchRouteReason(text);
  return why ? { route: CHAT_ROUTES.SEARCH, reason: why } : { route: CHAT_ROUTES.CHAT, reason: CHAT_ROUTE_REASON };
}

export function chooseChatRoute(text, { hasTools = true, historySearch = false, videoTool = false, skillMatch = false } = {}) {
  if (!hasTools) return searchOrChat(text);
  if (historySearch && asksAboutHistory(text)) return { route: CHAT_ROUTES.TOOLS, reason: HISTORY_ROUTE_REASON };
  const reason = toolsRouteReason(text);
  if (reason) return { route: CHAT_ROUTES.TOOLS, reason };
  if (videoTool && mentionsVideo(text)) return { route: CHAT_ROUTES.TOOLS, reason: VIDEO_ROUTE_REASON };
  if (skillMatch) return { route: CHAT_ROUTES.TOOLS, reason: SKILL_ROUTE_REASON };
  return searchOrChat(text);
}

// The tool the first model round must call, or null. A recall question
// always runs search_history first, so the answer comes from the stored
// history and never from the model deciding to skip it.
export function requiredFirstTool(route) {
  return route && route.route === CHAT_ROUTES.TOOLS && route.reason === HISTORY_ROUTE_REASON ? SEARCH_HISTORY_TOOL : null;
}

export function wantsCurrentInfo(text) {
  return typeof text === 'string' && CURRENT_INFO_RE.test(text);
}

// After the tools route: does this message get the one search call? Only
// when the model ran no check and either the message asks for current
// information or the tools round produced no answer at all. Never for a
// recall question (`route.reason` 'history'): web results are not mixed
// into a "do you remember" answer, whatever else the message says.
export function searchAfterTools(text, toolResult, route) {
  const r = toolResult || {};
  if (route && route.reason === HISTORY_ROUTE_REASON) return false;
  if (r.aborted) return false;
  if (Array.isArray(r.outcomes) && r.outcomes.length) return false;
  return wantsCurrentInfo(text) || !r.text;
}
