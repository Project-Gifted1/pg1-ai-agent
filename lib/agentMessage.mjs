// check_agent_message (1.21.0): a pre-read check for a message from another
// agent or a seller's skill.md, run BEFORE the caller's own model reads it.
// First user: an agent wallet that reads sellers' skill.md files.
//
// check_agent_message { text | url, kind? }
//   Exactly one of `text` (up to 64 KB of UTF-8) or `url` (https only,
//   fetched once with lib/netGuard.mjs safeFetch: the same SSRF rules as
//   check_x402_endpoint, 6 s timeout, text/markdown or text/plain only, up
//   to 64 KB). `kind` ("skill_md" | "message" | "other") is recorded and
//   echoed; the rules are the same for every kind.
//
// The rules are PG1's own, deterministic and rule-based: no AI model call,
// no paid provider. Five families, every code in lib/reasonCodes.mjs:
//   1. instruction override and role hijack (ignore previous instructions,
//      "you are now", developer/jailbreak modes, claims to come from a
//      system, an admin, an AI company or the wallet's own developer, and
//      requests to hide things from the user);
//   2. hidden content (zero-width characters, bidirectional controls,
//      Unicode tag characters, instructions inside HTML comments,
//      mixed-script look-alike words, long base64 or hex blobs, data: URIs).
//      Base64, hex, data: URI and tag-character text is decoded and the
//      decoded text is checked with the same rules;
//   3. exfiltration (requests to reveal or send environment variables, keys,
//      seed phrases, .env or ~/.ssh; markdown images or links whose URLs
//      carry templated or secret-like values; curl ... | sh);
//   4. wallet and payment manipulation (sign, approve, transfer or bridge
//      instructions, unlimited allowances, a changed payTo or recipient,
//      raised spending limits, presign-guard or other checks turned off);
//   5. tool hijack (directions to use the reader's own tools or shell, or
//      to install packages).
// Then, within a 4 s budget, up to 5 domains go through check_domain_age
// and check_hostname_reputation and up to 5 wallet addresses through
// check_wallet_sanctions and check_wallet_age: PG1's own checks over its
// own, public-domain or permitted sources only. An enrichment that does not
// finish in time is reported (AGENT_MESSAGE_ENRICHMENT_INCOMPLETE) and the
// rule results are returned anyway.
//
// verdict: any high-severity finding -> "malicious"; medium only ->
// "suspicious"; none -> "no_findings" ("checked: no findings"). No findings
// does not prove the content is harmless.
//
// Privacy: the content is never stored, cached or logged. The one log line
// per check carries sha256, byte length, kind, verdict and reason codes.

import crypto from 'node:crypto';
import { parse as parseDomain } from 'tldts';
import { english as BIP39_ENGLISH } from 'viem/accounts';
import { safeFetch, UnsafeUrlError, checkUrlShape } from './netGuard.mjs';
import { reason } from './reasonCodes.mjs';
import { buildCheck, withResponseMeta } from './responseMeta.mjs';
import { withFixIt } from './invalidInput.mjs';

export const AGENT_MESSAGE_MAX_BYTES = 64 * 1024;
export const AGENT_MESSAGE_FETCH_TIMEOUT_MS = 6000;
export const AGENT_MESSAGE_ENRICH_BUDGET_MS = 4000;
export const AGENT_MESSAGE_ENRICH_MAX_DOMAINS = 5;
export const AGENT_MESSAGE_ENRICH_MAX_WALLETS = 5;
export const AGENT_MESSAGE_KINDS = Object.freeze(['skill_md', 'message', 'other']);
export const AGENT_MESSAGE_CONTENT_TYPES = Object.freeze(['text/markdown', 'text/plain']);
export const EXCERPT_MAX = 120;
const MAX_FINDINGS = 100;
const MAX_LISTED = 50;
export const RULES_VERSION = '1.21.0';

// Severity per finding code. Fixed per code, so a code always means the
// same thing to a caller.
export const AGENT_MESSAGE_SEVERITY = Object.freeze({
  AGENT_MESSAGE_HIDDEN_TAG_CHARACTERS: 'high',
  AGENT_MESSAGE_SECRET_EXFILTRATION: 'high',
  AGENT_MESSAGE_EXFILTRATION_URL: 'high',
  AGENT_MESSAGE_PAYMENT_REDIRECT: 'high',
  WALLET_SANCTIONED: 'high',
  AGENT_MESSAGE_INSTRUCTION_OVERRIDE: 'medium',
  AGENT_MESSAGE_ROLE_HIJACK: 'medium',
  AGENT_MESSAGE_AUTHORITY_CLAIM: 'medium',
  AGENT_MESSAGE_CONCEALMENT: 'medium',
  AGENT_MESSAGE_PROMPT_EXTRACTION: 'medium',
  AGENT_MESSAGE_ZERO_WIDTH: 'medium',
  AGENT_MESSAGE_BIDI_CONTROL: 'medium',
  AGENT_MESSAGE_HTML_COMMENT_INSTRUCTION: 'medium',
  AGENT_MESSAGE_MIXED_SCRIPT: 'medium',
  AGENT_MESSAGE_ENCODED_BLOB: 'medium',
  AGENT_MESSAGE_DATA_URI: 'medium',
  AGENT_MESSAGE_TEMPLATED_IMAGE_URL: 'medium',
  AGENT_MESSAGE_REMOTE_SCRIPT: 'medium',
  AGENT_MESSAGE_FUND_TRANSFER: 'medium',
  AGENT_MESSAGE_UNLIMITED_ALLOWANCE: 'medium',
  AGENT_MESSAGE_SPENDING_LIMIT: 'medium',
  AGENT_MESSAGE_GUARD_BYPASS: 'medium',
  AGENT_MESSAGE_TOOL_INVOCATION: 'medium',
  AGENT_MESSAGE_SHELL_COMMAND: 'medium',
  AGENT_MESSAGE_PACKAGE_INSTALL: 'medium',
  HOSTNAME_PHISHING_LISTED: 'medium',
  HOSTNAME_LOOKALIKE: 'medium'
});

// --- characters ------------------------------------------------------------------------

const TAG_RE = /[\u{E0000}-\u{E007F}]/u;
const TAG_RUN_RE = /[\u{E0000}-\u{E007F}]+/gu;
// Invisible formatting characters. U+200D (zero-width joiner) is allowed
// inside emoji sequences, U+FEFF as a byte-order mark at the very start.
const ZERO_WIDTH_RE = /[­͏ᅟᅠ᠎​‌‍⁠-⁤ㅤ﻿ﾠ]/g;
const BIDI_RE = /[‪-‮⁦-⁩]/g;
const EMOJI_NEIGHBOUR_RE = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}️⃣]/u;

// Cyrillic and Greek letters that look like Latin ones, folded before the
// instruction rules run, so "іgnоrе" matches like "ignore".
const CONFUSABLES = {
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's', 'і': 'i', 'ї': 'i', 'ј': 'j', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ɡ': 'g', 'һ': 'h', 'ӏ': 'l',
  'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w',
  'А': 'a', 'В': 'b', 'Е': 'e', 'К': 'k', 'М': 'm', 'Н': 'h', 'О': 'o', 'Р': 'p', 'С': 'c', 'Т': 't', 'Х': 'x', 'Ѕ': 's', 'І': 'i', 'Ј': 'j',
  'Α': 'a', 'Β': 'b', 'Ε': 'e', 'Ζ': 'z', 'Η': 'h', 'Ι': 'i', 'Κ': 'k', 'Μ': 'm', 'Ν': 'n', 'Ο': 'o', 'Ρ': 'p', 'Τ': 't', 'Υ': 'y', 'Χ': 'x'
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g');

function stripInvisible(s) {
  return s.replace(TAG_RUN_RE, '').replace(ZERO_WIDTH_RE, '').replace(BIDI_RE, '');
}

// The text the instruction rules read: invisible characters removed, NFKC
// (full-width and styled letters to plain ones), look-alikes folded,
// lowercased.
export function foldForRules(s) {
  return stripInvisible(String(s)).normalize('NFKC').replace(CONFUSABLE_RE, (c) => CONFUSABLES[c]).toLowerCase().replace(CONFUSABLE_RE, (c) => CONFUSABLES[c]);
}

// --- masking and excerpts --------------------------------------------------------------

const BIP39 = new Set(BIP39_ENGLISH);
const MASK = '[masked]';
const MASK_RES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)[-_](?:[A-Za-z0-9]{2,8}[-_])?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:0x)?[0-9a-fA-F]{64}\b/g,
  /\b[1-9A-HJ-NP-Za-km-z]{86,90}\b/g,
  /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/g,
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi
];
const SECRET_ASSIGN_RE = /((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd|private[_-]?key|mnemonic|seed(?:[_-]?phrase)?)\s*["']?\s*[:=]\s*["']?)([^\s"'&,;)]{6,})/gi;
const SECRET_QUERY_RE = /([?&#](?:key|api[_-]?key|apikey|token|access[_-]?token|secret|password|pass|pwd|pk|private[_-]?key|seed|mnemonic|auth|sig|signature|session|cookie)=)(?!\[masked)([^&\s#)"'\]]+)/gi;

// A run of 12 or more BIP39 words in a row: a probable seed phrase.
function maskSeedPhrases(s) {
  const words = [...s.matchAll(/[A-Za-z]+/g)];
  let out = '';
  let last = 0;
  let i = 0;
  while (i < words.length) {
    let j = i;
    while (j < words.length && BIP39.has(words[j][0].toLowerCase()) && (j === i || /^[\s,.;:\d"'-]*$/.test(s.slice(words[j - 1].index + words[j - 1][0].length, words[j].index)))) j++;
    if (j - i >= 12) {
      out += s.slice(last, words[i].index) + '[masked seed phrase]';
      last = words[j - 1].index + words[j - 1][0].length;
      i = j;
    } else i = Math.max(i + 1, j === i ? i + 1 : j);
  }
  return out + s.slice(last);
}

export function maskSecrets(text) {
  let s = maskSeedPhrases(String(text));
  for (const re of MASK_RES) s = s.replace(re, MASK);
  s = s.replace(SECRET_ASSIGN_RE, (m, k) => `${k}${MASK}`);
  s = s.replace(SECRET_QUERY_RE, (m, k) => `${k}${MASK}`);
  return s;
}

// Invisible characters shown as code points, so an excerpt shows what is
// hidden instead of hiding it again.
function renderInvisible(s) {
  return s
    .replace(TAG_RUN_RE, '[hidden tag characters]')
    .replace(/[­͏ᅟᅠ᠎​-‍⁠-⁤ㅤ﻿ﾠ‪-‮⁦-⁩]/g, (c) => `[U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}]`)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ');
}

// A short, masked excerpt of `text` around `index`, at most 120 characters.
export function excerpt(text, index = 0) {
  const s = String(text || '');
  const start = Math.max(0, index - 30);
  let piece = maskSecrets(renderInvisible(s.slice(start, start + 400))).trim();
  const lead = start > 0 ? '…' : '';
  if ((lead + piece).length > EXCERPT_MAX) piece = piece.slice(0, EXCERPT_MAX - lead.length - 1).trimEnd() + '…';
  return lead + piece;
}

// --- instruction rules -----------------------------------------------------------------
// Each rule reads one folded line. `negatable` rules are skipped when a
// negation ("never", "do not", ...) opens the same clause before the match,
// so a warning like "never share your seed phrase" is not a finding.

const NEGATION_RE = /\b(?:never|not|don't|dont|do not|no one|nobody|won't|will not|shouldn't|should not|must not|mustn't|cannot|can't|refuse to|avoid|without)\b/;

function negatedBefore(line, index) {
  const clause = line.slice(Math.max(0, index - 60), index).split(/[.;!?]|,|\band\b|\bthen\b|\bbut\b|\bso\b/).pop();
  return NEGATION_RE.test(clause);
}

const HIGH_SECRET = String.raw`(?:(?:your |the |my |our |wallet |all )*(?:private\s*keys?|secret\s*keys?|signing\s*keys?|seed\s*(?:phrases?|words)|seed|mnemonic(?:\s*phrases?)?|recovery\s*(?:phrases?|words|keys?)|secret\s*recovery\s*phrases?|wallet\s*(?:secrets?|backups?|keystores?|passwords?)|keystore(?:\s*files?)?|environment\s*variables?|env\s*(?:vars?|variables|files?)|(?:the |your )?\.env\b(?:\s*files?)?|~\/\.ssh\b|\.ssh\/|id_rsa|id_ed25519|\.aws\/credentials|\/etc\/(?:passwd|shadow)|credentials\s*files?|wallet\.dat|process\.env))`;
const LOW_SECRET = String.raw`(?:(?:your |the |my |our |all )*(?:api\s*keys?|access\s*tokens?|auth(?:entication)?\s*tokens?|bearer\s*tokens?|session\s*(?:tokens?|cookies?)|cookies|passwords?|credentials|secrets|oauth\s*tokens?|refresh\s*tokens?|license\s*keys?|licence\s*keys?))`;
const EXFIL_VERB = String.raw`(?:(?:reply|respond|answer|come back) with|send me|reveal|send|share|post|print|output|show|display|give|provide|paste|upload|e-?mail|forward|leak|tell|include|append|attach|return|dump|exfiltrate|transmit|submit|enter|type|cat|export|list|expose|disclose|report|echo)`;
const STRONG_VERB = String.raw`(?:reveal|print|output|dump|leak|exfiltrate|disclose|expose|echo|cat)`;
const DEST = String.raw`(?:to|at|via|into)\s+(?:https?:\/\/|me\b|us\b|this\s+(?:url|address|endpoint|e-?mail|webhook|server|link|chat|channel)|the\s+following|our\s+(?:server|endpoint|webhook|e-?mail|team|support)|[\w.+-]+@[\w-]+\.[a-z]{2,})`;
const ADDR = String.raw`(?:0x[0-9a-f]{40}|[a-z0-9-]+\.eth\b|bc1[a-z0-9]{20,}|this (?:address|wallet|account)|the following (?:address|wallet|account)|(?:my|our) (?:new )?(?:address|wallet|account)|the (?:address|wallet) below)`;
const TV = String.raw`(?:send|transfer|move|pay|wire|bridge|withdraw|sweep|forward|deposit|route|redirect)`;
const ASSET = String.raw`(?:usdc|usdt|eth|ether|dai|weth|tokens?|funds|crypto|sol|btc|bitcoin|matic|the payment|payments|money|assets|balance)`;
const GUARD_NOUN = String.raw`(?:presign[- ]?guard|pre-?sign(?:ing)?[- ](?:guard|checks?)|preflight(?:_check)?(?: checks?)?|safety (?:checks?|guards?|rules|filters?|measures)|security (?:checks?|guards?|warnings?|prompts?|scans?|rules)|sanctions? (?:checks?|screening)|transaction (?:simulation|checks?|review|confirmation)s?|simulations?|confirmation (?:prompts?|steps?|dialogs?|checks?)|human (?:approval|review|confirmation|in the loop)|approval (?:prompts?|steps?|checks?)|guardrails?|spend(?:ing)? (?:checks?|limits?)|allowlists?|signature verification|address verification|2fa|mfa)`;

const re = (src, flags = '') => new RegExp(src, flags);

export const INSTRUCTION_RULES = Object.freeze([
  // 1. instruction override and role hijack
  { code: 'AGENT_MESSAGE_INSTRUCTION_OVERRIDE', res: [
    /\b(?:ignore|disregard|forget|override|overrule|bypass|discard|abandon|neglect)\b[^.\n]{0,30}?\b(?:all |any |the |your |my |these |those |of )*(?:previous|prior|above|earlier|preceding|former|original|initial|existing|system|developer|default|old|current)\s+(?:\w+\s+)?(?:instructions?|prompts?|rules?|directives?|guidelines?|guidance|messages?|context|commands?|constraints?|polic(?:y|ies)|restrictions?|programming|orders?)\b/,
    /\bnew (?:system )?(?:instructions?|directives?|rules)\s*:/,
    /\b(?:replace|overwrite|rewrite|change|update)\s+(?:your|the)\s+(?:system\s+)?(?:prompt|instructions|directives|programming|rules)\b/,
    /\bfrom now on,?\s+(?:you\s+(?:will|must|are|shall|should|only)|ignore|always|never|only)\b/,
    /\bdo not follow\s+(?:your|the|any)\s+(?:previous|prior|system|original|developer)\b/
  ] },
  { code: 'AGENT_MESSAGE_ROLE_HIJACK', res: [
    /\byou are now (?:a|an|the|my|dan|acting|operating|free|unrestricted|unfiltered|jailbroken|uncensored|in (?:developer|god|dan|unrestricted|jailbreak|sudo) mode)\b/,
    /\byou are no longer\b[^.\n]{0,30}\b(?:bound|restricted|limited|an? (?:ai|assistant)|required|subject)\b/,
    /\b(?:enable|enter|activate|switch (?:to|into)|you are (?:now )?in|now in|engage)\s+(?:the\s+)?(?:developer|god|dan|jailbreak|unrestricted|unfiltered|sudo)\s+mode\b/,
    /\bjailbroken\b|\bjailbreak mode\b|\bdo anything now\b/,
    /\b(?:pretend|act|behave|roleplay)\s+(?:to be|as(?: if you (?:are|were))?|like)\s+(?:an?\s+)?(?:unrestricted|unfiltered|jailbroken|evil|uncensored|different|new|other)\s+(?:ai|assistant|model|agent|chatbot|system)\b/,
    /\b(?:act|pretend)\s+(?:to be|as)\s+(?:the\s+)?(?:system|administrator|admin|root|developer)\b/
  ] },
  { code: 'AGENT_MESSAGE_AUTHORITY_CLAIM', res: [
    /<\|im_start\|>|<\|system\|>|<<sys>>|\[\/?inst\]|<\/?(?:system|system_prompt|sys_prompt)>|\[(?:system|developer|admin)(?: message| override| prompt)?\]|\{\{\s*system\s*\}\}/,
    /\b(?:this|the following|these)\s+(?:message|instruction|request|notice|update|directive|note)s?\s+(?:is|are|comes?|was sent|were sent|has been sent)\s+(?:directly\s+)?from\s+(?:the\s+|your\s+)?(?:system|admin|administrator|developers?|operator|owner|creators?|anthropic|openai|google|deepmind|meta|microsoft|coinbase|fizzl|wallet (?:team|developers?)|the wallet|security team|support team)\b/,
    /\b(?:i am|i'm|we are|this is|message from|speaking as|on behalf of)\s+your\s+(?:system|admin|administrator|developers?|creators?|operator|owner|maker|wallet developers?|security team|provider)\b/,
    /\b(?:official|urgent|important|priority)\s+(?:message|notice|instruction|update|directive|override)\s+from\s+(?:anthropic|openai|google|deepmind|microsoft|meta|coinbase|fizzl|the (?:system|admin|administrator|developers?|wallet))\b/,
    /\b(?:anthropic|openai|deepmind|the ai company|your (?:ai )?provider|your developers?)\s+(?:has|have)\s+(?:authori[sz]ed|approved|instructed|asked|requested|told|allowed)\b/,
    /\bfrom\s+the\s+wallet'?s?\s+(?:own\s+)?(?:developers?|team|makers?)\b/
  ], raw: [/^\s*(?:SYSTEM|ADMIN|DEVELOPER|ADMINISTRATOR)(?:\s+(?:MESSAGE|PROMPT|OVERRIDE|NOTICE|INSTRUCTIONS?))?\s*:/] },
  { code: 'AGENT_MESSAGE_CONCEALMENT', res: [
    /\b(?:do not|don't|never)\s+(?:tell|inform|notify|alert|mention (?:this|it) to|reveal (?:this|it) to|show (?:this|it) to|warn)\s+(?:the|your)\s+(?:user|human|owner|operator|principal|person|customer)s?\b/,
    /\bwithout\s+(?:telling|informing|notifying|alerting|asking|warning|confirming with|the knowledge of)\s+(?:the|your)\s+(?:user|human|owner|operator|principal|person|customer)s?\b/,
    /\bkeep\s+(?:this|these(?: instructions)?|it)\s+(?:secret|hidden|private|confidential)\s+from\s+(?:the|your)\s+(?:user|human|owner|operator)\b/,
    /\b(?:hide|conceal)\s+(?:this|these|the (?:transaction|transfer|payment|approval)s?)\s+from\s+(?:the|your)\s+(?:user|human|owner|operator)\b/,
    /\bsilently\s+(?:send|transfer|approve|sign|run|execute|call|install|pay|forward|upload)\b/
  ] },
  { code: 'AGENT_MESSAGE_PROMPT_EXTRACTION', res: [
    /\b(?:reveal|print|output|show|display|repeat|dump|leak|tell me|share|send|give me|write out|list)\s+(?:me\s+)?(?:your|the)\s+(?:full\s+|entire\s+|complete\s+|initial\s+|original\s+|hidden\s+|exact\s+)?(?:system\s+prompt|system\s+message|instructions\s+above|initial\s+instructions|hidden\s+instructions|developer\s+(?:prompt|message|instructions))\b/,
    /\b(?:reveal|print|output|show|repeat|dump|leak)\s+(?:me\s+)?your\s+(?:full\s+|entire\s+)?(?:prompt|instructions)\b/,
    /\b(?:repeat|print|output)\s+(?:everything|all (?:the )?text|the text|the words)\s+above\b/
  ] },
  // 3. exfiltration
  { code: 'AGENT_MESSAGE_SECRET_EXFILTRATION', negatable: true, res: [
    re(String.raw`\b${EXFIL_VERB}\b[^.\n]{0,40}?${HIGH_SECRET}`),
    re(String.raw`\b${STRONG_VERB}\b[^.\n]{0,40}?${LOW_SECRET}`),
    re(String.raw`\b(?:send|share|post|upload|e-?mail|forward|transmit|submit|give|provide)\b[^.\n]{0,40}?${LOW_SECRET}[^.\n]{0,60}?${DEST}`),
    re(String.raw`\b(?:include|append|put|add|insert)\b[^.\n]{0,30}?(?:${LOW_SECRET}|${HIGH_SECRET})[^.\n]{0,30}?\bin (?:your|the) (?:reply|response|answer|output|next message|message|request|url|query)\b`)
  ] },
  { code: 'AGENT_MESSAGE_REMOTE_SCRIPT', res: [
    /\b(?:curl|wget|iwr|invoke-webrequest|irm)\b[^|\n]{0,240}\|\s*(?:sudo\s+)?(?:ba|z|k|da|fi)?sh\b/,
    /\b(?:curl|wget|iwr|invoke-webrequest|irm)\b[^|\n]{0,240}\|\s*(?:sudo\s+)?(?:python3?|node|perl|ruby|iex|invoke-expression)\b/,
    /\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b/,
    /\beval\s+["'(]?\$\(\s*(?:curl|wget)\b/,
    /\bbase64\s+(?:-d|--decode)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/
  ] },
  // 4. wallet and payment manipulation
  { code: 'AGENT_MESSAGE_PAYMENT_REDIRECT', negatable: true, res: [
    re(String.raw`\b(?:change|replace|update|switch|swap|modify|override|redirect|point|use|set)\s+(?:the\s+|your\s+|all\s+|any\s+)?(?:pay[_ -]?to|payto|recipient|receiving|destination|payout|beneficiary|deposit|withdrawal|settlement|merchant|payee|treasury)\s*(?:address(?:es)?|wallets?|accounts?|field)?\b[^.\n]{0,60}?\b(?:to|with|into|=|:)\s*(?:0x[0-9a-f]{40}|[a-z0-9-]+\.eth\b|bc1|this\b|the following|my\b|our\b|a new\b|new\b)`),
    /\b(?:payments?|funds|usdc|money|payouts?)\s+(?:should|must|will)\s+(?:now\s+|instead\s+)?(?:go|be sent|be paid|be routed|be redirected|be forwarded)\s+to\b/,
    /\b(?:our|the|my)\s+(?:new|updated|changed|correct|real|actual)\s+(?:pay[_ -]?to|payto|recipient|receiving|payment|deposit|wallet)\s*(?:address|wallet)?\s+(?:is|:)/,
    /\b(?:pay[_ -]?to|payto|recipient|receiving|deposit)\s+(?:address\s+|wallet\s+)?(?:has\s+)?(?:changed|moved|been (?:updated|changed|replaced)|is now)\b/,
    re(String.raw`\b${TV}\b[^.\n]{0,40}?${ADDR}[^.\n]{0,40}?\binstead\b`),
    re(String.raw`\binstead of\b[^.\n]{0,60}?\b(?:pay[_ -]?to|payto|recipient|address)\b[^.\n]{0,40}?\b${TV}\b`),
    re(String.raw`\b${TV}\s+(?:all|everything|the (?:entire|full|whole|remaining)|your (?:entire|full|whole|remaining)|max(?:imum)?|the rest of)\b[^.\n]{0,30}?(?:${ASSET}|holdings|wallet)?[^.\n]{0,30}?\bto\b`),
    /\b(?:do not|don't|never)\s+(?:pay|send)\s+(?:to\s+)?(?:the\s+)?(?:pay[_ -]?to|payto|address (?:in|from) the 402|listed address|original address)\b/
  ] },
  { code: 'AGENT_MESSAGE_FUND_TRANSFER', negatable: true, res: [
    re(String.raw`\b${TV}\b[^.\n]{0,40}?${ASSET}\b[^.\n]{0,40}?\bto\s+${ADDR}`),
    /\b(?:sign|approve|authori[sz]e|confirm|execute|submit|broadcast)\s+(?:this|the following|the attached|these|that|the below)\s+(?:transactions?|txs?|messages?|permits?|signature requests?|typed data|eip-?712(?: messages?)?|payloads?|transfers?|approvals?)\b/,
    /\bbridge\s+(?:your|the|all|my|our)\s+(?:funds|tokens|usdc|eth|assets|balance)\b/
  ] },
  { code: 'AGENT_MESSAGE_UNLIMITED_ALLOWANCE', res: [
    /\b(?:unlimited|infinite|max(?:imum)?|uint256[ .]max)\s+(?:token\s+)?(?:allowances?|approvals?|spending(?: approval)?)\b/,
    /\bapprove\s+(?:an?\s+)?(?:unlimited|infinite|max(?:imum)?)\b/,
    /\bsetapprovalforall\b|\btype\(uint256\)\.max\b|\bmax_?uint256\b|\b2\s*(?:\*\*|\^)\s*256\b|\b0x(?:f){64}\b|115792089237316195423570985008687907853269984665640564039457584007913129639935/
  ] },
  { code: 'AGENT_MESSAGE_SPENDING_LIMIT', res: [
    /\b(?:raise|increase|remove|disable|lift|bump|double|triple|max out|turn off|switch off|delete|bypass|ignore|override|drop|exceed)\s+(?:the\s+|your\s+|any\s+|all\s+)?(?:daily\s+|weekly\s+|monthly\s+|per[- ]?(?:transaction|tx|call|payment)\s+)?(?:spend(?:ing)?|payment|transaction|tx|transfer|withdrawal|budget)\s+(?:limits?|caps?|maximums?|max|ceilings?|thresholds?|quotas?)\b/,
    /\bset\s+(?:the\s+|your\s+)?(?:daily\s+)?(?:spend(?:ing)?|payment|transaction)\s+(?:limit|cap)\s+to\s+(?:unlimited|infinite|max(?:imum)?|none|0\b)/,
    /\bwithout\s+(?:any\s+)?(?:spend(?:ing)?|payment)\s+limits?\b/
  ] },
  { code: 'AGENT_MESSAGE_GUARD_BYPASS', negatable: false, res: [
    re(String.raw`\b(?:turn off|switch off|disable|deactivate|skip|bypass|circumvent|ignore|override|suppress|silence|remove|avoid|don't run|do not run|no need to run|no need for|without running|without using)\s+(?:the\s+|your\s+|any\s+|all\s+)?${GUARD_NOUN}\b`)
  ] },
  // 5. tool hijack
  { code: 'AGENT_MESSAGE_TOOL_INVOCATION', res: [
    /\b(?:use|call|invoke|run|execute|trigger|access)\s+(?:your|the agent'?s|the assistant'?s|its)\s+(?:own\s+)?(?:[\w-]+\s+){0,2}?(?:tools?|functions?|shell|terminal|bash|console|command[- ]line|file ?system|browser|code (?:interpreter|execution)|mcp (?:tools?|servers?)|plugins?)\b/,
    /\b(?:call|invoke|use|run|trigger)\s+(?:the\s+)?[`'"]?(?:send_?transaction|transfer_?funds|sign_?(?:message|transaction|typed_?data)|execute_?(?:command|shell|code)|run_?(?:command|shell|terminal_cmd)|bash|shell|exec|write_?file|delete_?file|read_?file|send_?email|http_?request)[`'"]?\s+(?:tool|function)\b/,
    /\b(?:you|the agent|the assistant)\s+(?:must|should|need to|have to)\s+(?:now\s+|immediately\s+|first\s+)?(?:call|invoke|use|run|trigger)\s+(?:the\s+|your\s+)?[`'"]?[\w-]+[`'"]?\s+(?:tool|function)\b/
  ] },
  { code: 'AGENT_MESSAGE_SHELL_COMMAND', res: [
    /\b(?:run|execute|exec|type|paste|enter)\s+(?:this|the following|these|that|the command|this command|the commands? below)\b[^.\n]{0,40}\b(?:in|into|on|inside)\s+(?:your|the agent'?s)\s+(?:terminal|shell|console|command line|machine|system|host|server|environment|sandbox|container|computer)\b/,
    /\brm\s+-rf\s+(?:\/|~|\$home|\*)|\bnc\s+-e\b|\/dev\/tcp\/|\bmkfifo\b[^\n]{0,60}\bnc\b/
  ] },
  { code: 'AGENT_MESSAGE_PACKAGE_INSTALL', res: [
    /\b(?:immediately|before (?:continuing|proceeding|responding|answering|replying|you (?:continue|respond|reply|answer))|silently|quietly|automatically|without (?:asking|telling|confirmation))\b[^.\n]{0,40}?\b(?:install|npm\s+(?:i|install|add)|npx|pip3?\s+install|yarn\s+add|pnpm\s+(?:add|install)|brew\s+install|apt(?:-get)?\s+install|cargo\s+install|go\s+install|gem\s+install)\b/,
    /\b(?:install|npm\s+(?:i|install|add)|pip3?\s+install|yarn\s+add|pnpm\s+(?:add|install))\b[^.\n]{0,60}?\b(?:immediately|before (?:continuing|proceeding|responding|answering|replying)|silently|quietly|without (?:asking|telling|confirmation)|to (?:unlock|continue|proceed|activate|verify you))\b/
  ] }
]);

// A comment addressed to a model or an agent.
const COMMENT_ADDRESSED_RE = /\b(?:ai|assistant|agent|llm|model|claude|gpt|chatgpt|gemini|copilot|bot)s?\b[^\n]{0,80}\b(?:must|should|need to|always|never|do not|don't|ignore|instead|important)\b|\b(?:note|instructions?|message)\s+(?:to|for)\s+(?:the\s+)?(?:ai|assistant|agent|llm|model|bot)s?\b/;

function ruleHits(line, rawLine) {
  const hits = [];
  for (const rule of INSTRUCTION_RULES) {
    let hit = null;
    for (const r of rule.res) {
      const m = r.exec(line);
      if (m && !(rule.negatable && negatedBefore(line, m.index))) { hit = m.index; break; }
    }
    if (hit === null && rule.raw && rawLine != null) {
      for (const r of rule.raw) {
        const m = r.exec(rawLine);
        if (m) { hit = m.index; break; }
      }
    }
    if (hit !== null) hits.push({ code: rule.code, index: hit });
  }
  return hits;
}

// --- hidden content --------------------------------------------------------------------

function decodeTagChars(s) {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xE0020 && cp <= 0xE007E) out += String.fromCharCode(cp - 0xE0000);
    else if (cp >= 0xE0000 && cp <= 0xE007F) out += '';
    else out += ' ';
  }
  return out;
}

function printableText(buf) {
  if (!buf || buf.length < 8) return null;
  const s = buf.toString('utf8');
  if (s.includes('�')) return null;
  let printable = 0;
  for (const ch of s) if (/[\p{L}\p{N}\p{P}\p{S}\p{Zs}\n\r\t]/u.test(ch)) printable++;
  return printable / [...s].length >= 0.9 && /[a-z]{3}/i.test(s) ? s : null;
}

const BASE64_RE = /(?<![A-Za-z0-9+/=_-])(?:[A-Za-z0-9+/]{24,}={0,2}|[A-Za-z0-9_-]{24,}={0,2})(?![A-Za-z0-9+/=_-])/g;
const HEX_RE = /(?<![0-9a-zA-Z])(?:0x)?[0-9a-fA-F]{40,}(?![0-9a-zA-Z])/g;
const DATA_URI_RE = /\bdata:([a-z]+\/[a-z0-9.+-]+)((?:;[a-z0-9=.+-]+)*),([^\s)"'<>]*)/gi;
export const BLOB_MIN_CHARS = 256;

function base64Candidate(s) {
  if (/^(?:0x)?[0-9a-f]+$/i.test(s)) return false;
  return /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9+/=_-]/.test(s);
}

function decodeBase64(s) {
  try {
    const norm = s.replace(/-/g, '+').replace(/_/g, '/');
    return printableText(Buffer.from(norm, 'base64'));
  } catch {
    return null;
  }
}

// --- extraction -----------------------------------------------------------------------

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;
const EVM_RE = /(?<![0-9a-zA-Z])0x[0-9a-fA-F]{40}(?![0-9a-zA-Z])/g;
const BTC_RE = /(?<![0-9a-zA-Z])bc1[02-9ac-hj-np-z]{11,71}(?![0-9a-zA-Z])/g;
const BARE_HOST_RE = /(?<![\w@./-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?![\w-]|\.[a-z0-9])/gi;
// TLDs that are also common file extensions: a bare "skill.md" or
// "index.js" is a file name, not a domain. Inside a URL they still count.
const FILE_TLDS = new Set(['md', 'sh', 'py', 'js', 'ts', 'rs', 'go', 'pl', 'rb', 'cs', 'zip', 'mov', 'json', 'yaml', 'yml', 'toml', 'txt', 'html', 'css', 'mjs', 'cjs', 'jsx', 'tsx', 'lock', 'env', 'png', 'jpg', 'gif', 'svg', 'pdf', 'csv', 'xml', 'log', 'exe', 'bin', 'sol', 'wasm', 'tar', 'gz', 'cfg', 'ini', 'conf', 'php', 'java', 'kt', 'swift', 'cpp', 'mp3', 'mp4', 'eth']);
const RESERVED_HOST_RE = /(?:^|\.)(?:example\.(?:com|org|net)|example|invalid|test|localhost|local)$/;

function trimUrl(u) {
  return u.replace(/[.,;:!?]+$/, '');
}

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; }
}

function registrable(host) {
  const p = parseDomain(host);
  return p && p.isIcann && p.domain ? p.domain : null;
}

// --- input ---------------------------------------------------------------------------

function toolError(code, problem, expected, example) {
  return Object.assign(withFixIt(new Error(''), { problem, expected, example }), { mcpToolError: true, code });
}

export function normalizeAgentMessageArgs(args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const hasText = a.text !== undefined && a.text !== null;
  const hasUrl = a.url !== undefined && a.url !== null;
  const example = '{"text":"# Weather skill\\nGET /forecast?city=Paris returns the forecast.","kind":"skill_md"}';
  if (hasText === hasUrl) throw toolError('invalid_input', 'Give exactly one of text or url', 'text (a string up to 64 KB) or url (an https URL of a text/markdown or text/plain file), not both', example);
  let kind = 'other';
  if (a.kind !== undefined && a.kind !== null) {
    if (typeof a.kind !== 'string' || !AGENT_MESSAGE_KINDS.includes(a.kind)) throw toolError('invalid_kind', 'kind is not one of the allowed values', 'skill_md, message or other', '"kind":"skill_md"');
    kind = a.kind;
  }
  if (hasText) {
    if (typeof a.text !== 'string') throw toolError('invalid_input', 'text must be a string', 'a string up to 64 KB', example);
    const bytes = Buffer.byteLength(a.text, 'utf8');
    if (bytes > AGENT_MESSAGE_MAX_BYTES) throw toolError('too_large', `text is ${bytes} bytes, over the 65536-byte limit`, 'at most 65536 bytes of UTF-8', 'split the content and check each part');
    return { source: 'text', text: a.text, kind };
  }
  if (typeof a.url !== 'string') throw toolError('invalid_url', 'url must be a string', 'an https URL', '"url":"https://seller.example.com/skill.md"');
  let url;
  try {
    url = checkUrlShape(a.url.trim());
  } catch (e) {
    throw toolError(e.code || 'invalid_url', `Refused: ${e.message}`, 'a public https URL (no private addresses, credentials or unusual ports)', '"url":"https://seller.example.com/skill.md"');
  }
  return { source: 'url', url: url.toString(), kind };
}

async function readCapped(res, max) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > max ? null : buf;
}

export async function fetchAgentMessage(url, { fetchImpl = globalThis.fetch, lookup, timeoutMs = AGENT_MESSAGE_FETCH_TIMEOUT_MS } = {}) {
  const example = '"url":"https://seller.example.com/skill.md"';
  let res;
  try {
    res = await safeFetch(url, { method: 'GET', headers: { Accept: 'text/markdown, text/plain', 'User-Agent': 'PG1-check/1.21' } }, { fetchImpl, lookup, timeoutMs });
  } catch (e) {
    if (e instanceof UnsafeUrlError) throw toolError(e.code, `Refused: ${e.message}`, 'a public https URL', example);
    const timedOut = /abort|timeout/i.test(String((e && e.name) || e));
    throw Object.assign(new Error(timedOut ? 'The URL did not answer within 6 seconds. Nothing was checked.' : 'The URL could not be fetched over https. Nothing was checked.'), { mcpToolError: true, code: 'fetch_failed' });
  }
  if (res.status >= 300 && res.status < 400) throw toolError('redirect_refused', `Refused: the URL answered with a redirect (HTTP ${res.status}), and redirects are not followed`, 'the final URL of the file itself', example);
  if (!res.ok) throw Object.assign(new Error(`The URL answered HTTP ${res.status}. Nothing was checked.`), { mcpToolError: true, code: 'fetch_failed' });
  const type = String((res.headers && res.headers.get('content-type')) || '').split(';')[0].trim().toLowerCase();
  if (!AGENT_MESSAGE_CONTENT_TYPES.includes(type)) throw toolError('unsupported_content_type', `Refused: the URL serves ${type ? `content type ${type.slice(0, 60)}` : 'no content type'}`, 'text/markdown or text/plain', 'a raw skill.md file served as text/markdown or text/plain');
  const declared = Number(res.headers && res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > AGENT_MESSAGE_MAX_BYTES) throw toolError('too_large', `Refused: the file is ${declared} bytes, over the 65536-byte limit`, 'at most 65536 bytes', 'split the content and send each part as text');
  const buf = await readCapped(res, AGENT_MESSAGE_MAX_BYTES);
  if (!buf) throw toolError('too_large', 'Refused: the file is over the 65536-byte limit', 'at most 65536 bytes', 'split the content and send each part as text');
  return { text: buf.toString('utf8'), contentType: type };
}

// --- the rules over a whole text ------------------------------------------------------

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

function zeroWidthHits(line) {
  const out = [];
  for (const m of line.matchAll(ZERO_WIDTH_RE)) {
    const c = m[0];
    if (c === '‍') {
      const before = line.slice(Math.max(0, m.index - 2), m.index);
      const after = line.slice(m.index + 1, m.index + 3);
      if (EMOJI_NEIGHBOUR_RE.test(before) && EMOJI_NEIGHBOUR_RE.test(after)) continue;
    }
    out.push(m.index);
  }
  return out;
}

// A word of Latin letters with at least one Cyrillic or Greek letter that
// looks like a Latin one ("pаypal" with a Cyrillic а). A stylised letter
// that looks like nothing Latin ("Δelta") is not a look-alike.
const MIXED_WORD_RE = /[\p{L}\p{M}]{4,}/gu;
function mixedScriptHit(line) {
  for (const m of line.matchAll(MIXED_WORD_RE)) {
    const w = m[0];
    const latin = (w.match(/\p{Script=Latin}/gu) || []).length;
    if (latin >= 2 && [...w].some((c) => CONFUSABLES[c] && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(c))) return m.index;
  }
  return null;
}

// URLs in markdown images and links (and HTML img tags) that carry a
// template or a secret-like value.
const MD_IMAGE_RE = /!\[[^\]\n]*\]\(\s*(<?)(https?:\/\/[^)\s]+)/gi;
const MD_LINK_RE = /(?<!!)\[[^\]\n]*\]\(\s*(<?)(https?:\/\/[^)\s]+)/gi;
const HTML_IMG_RE = /<img\b[^>]*?\bsrc\s*=\s*["']?()(https?:\/\/[^"'\s>]+)/gi;
const TEMPLATE_RE = /\{\{[^}]*\}\}|\$\{[^}]*\}|%7b%7b.*?%7d%7d|\{[a-z_][\w.-]*\}|%7b[a-z_][\w.-]*%7d|<[a-z_][\w-]*>|%3c[a-z_][\w-]*%3e|\$[a-z_]{3,}|\[[a-z_]{3,}\]/gi;
const SECRET_NAME_RE = /key|token|secret|passw|pwd|seed|mnemonic|private|env|cookie|session|credential|auth|prompt|history|conversation|chat|memory|balance|wallet/i;

function urlFindings(line) {
  const out = [];
  // A URL written as <https://...> loses its closing bracket.
  const check = (opened, u0, index, image) => {
    const u = opened ? u0.replace(/>$/, '') : u0;
    const q = u.includes('?') ? u.slice(u.indexOf('?')) : '';
    const scope = q || u.slice(u.indexOf('/', 8) + 1);
    const templates = [...scope.matchAll(TEMPLATE_RE)].map((m) => m[0]);
    const secretTemplate = templates.some((t) => SECRET_NAME_RE.test(t));
    const secretLiteral = q && maskSecrets(q) !== q;
    if (secretTemplate || secretLiteral) out.push({ code: 'AGENT_MESSAGE_EXFILTRATION_URL', index });
    else if (image && templates.length) out.push({ code: 'AGENT_MESSAGE_TEMPLATED_IMAGE_URL', index });
  };
  for (const m of line.matchAll(MD_IMAGE_RE)) check(m[1], m[2], m.index, true);
  for (const m of line.matchAll(HTML_IMG_RE)) check(m[1], m[2], m.index, true);
  for (const m of line.matchAll(MD_LINK_RE)) check(m[1], m[2], m.index, false);
  return out;
}

// Runs every rule over `text`. `origin` is set for decoded text: every
// finding then takes `originLine` as its line and records where it was
// decoded from. Depth limits decoding inside decoded text to one level.
function scanText(text, { originLine = null, origin = null, depth = 0, add }) {
  const lines = text.split('\n');
  const starts = lineStarts(text);
  lines.forEach((rawLine0, i) => {
    const rawLine = rawLine0.replace(/\r$/, '');
    const lineNo = originLine || i + 1;
    const folded = foldForRules(rawLine);
    for (const h of ruleHits(folded, stripInvisible(rawLine))) add(h.code, lineNo, origin ? folded : stripInvisible(rawLine), h.index, origin);
    for (const h of urlFindings(stripInvisible(rawLine))) add(h.code, lineNo, rawLine, h.index, origin);
    if (origin) return;
    // Hidden content: on the original text only.
    if (TAG_RE.test(rawLine)) {
      const idx = rawLine.search(TAG_RE);
      const decoded = decodeTagChars([...rawLine.matchAll(TAG_RUN_RE)].map((m) => m[0]).join(' '));
      add('AGENT_MESSAGE_HIDDEN_TAG_CHARACTERS', lineNo, decoded.trim() ? decoded : rawLine, decoded.trim() ? 0 : idx, decoded.trim() ? 'tag_characters' : null);
      if (decoded.trim()) scanText(decoded, { originLine: lineNo, origin: 'tag_characters', depth: depth + 1, add });
    }
    const zw = zeroWidthHits(i === 0 ? rawLine.replace(/^﻿/, '') : rawLine);
    if (zw.length) add('AGENT_MESSAGE_ZERO_WIDTH', lineNo, rawLine, zw[0], null);
    const bidi = rawLine.search(BIDI_RE);
    if (bidi >= 0) add('AGENT_MESSAGE_BIDI_CONTROL', lineNo, rawLine, bidi, null);
    const mixed = mixedScriptHit(stripInvisible(rawLine));
    if (mixed !== null) add('AGENT_MESSAGE_MIXED_SCRIPT', lineNo, stripInvisible(rawLine), mixed, null);
  });
  if (depth > 1) return;
  const visible = stripInvisible(text);
  const visStarts = lineStarts(visible);
  // data: URIs, decoded when they carry text.
  const dataSpans = [];
  for (const m of visible.matchAll(DATA_URI_RE)) {
    const lineNo = originLine || lineOf(visStarts, m.index);
    dataSpans.push([m.index, m.index + m[0].length]);
    if (!origin) add('AGENT_MESSAGE_DATA_URI', lineNo, visible.slice(visStarts[lineNo - 1] || 0), m.index - (visStarts[lineNo - 1] || 0), null);
    const mime = m[1].toLowerCase();
    if (/^text\/|^application\/(?:json|xml|javascript)/.test(mime)) {
      let decoded = null;
      try {
        decoded = /;base64/i.test(m[2]) ? printableText(Buffer.from(decodeURIComponent(m[3]), 'base64')) : decodeURIComponent(m[3]);
      } catch { decoded = null; }
      if (decoded) scanText(decoded, { originLine: lineNo, origin: 'data_uri', depth: depth + 1, add });
    }
  }
  const inData = (i) => dataSpans.some(([a, b]) => i >= a && i < b);
  // Base64 blobs: decoded and checked; long ones are findings themselves.
  for (const m of visible.matchAll(BASE64_RE)) {
    if (inData(m.index) || !base64Candidate(m[0])) continue;
    const lineNo = originLine || lineOf(visStarts, m.index);
    if (!origin && m[0].length >= BLOB_MIN_CHARS) add('AGENT_MESSAGE_ENCODED_BLOB', lineNo, visible.slice(visStarts[lineNo - 1] || 0), m.index - (visStarts[lineNo - 1] || 0), null);
    const decoded = decodeBase64(m[0]);
    if (decoded) scanText(decoded, { originLine: lineNo, origin: 'base64', depth: depth + 1, add });
  }
  for (const m of visible.matchAll(HEX_RE)) {
    const hex = m[0].replace(/^0x/i, '');
    if (hex.length === 40 || hex.length === 64) continue;
    const lineNo = originLine || lineOf(visStarts, m.index);
    if (!origin && hex.length >= BLOB_MIN_CHARS) add('AGENT_MESSAGE_ENCODED_BLOB', lineNo, visible.slice(visStarts[lineNo - 1] || 0), m.index - (visStarts[lineNo - 1] || 0), null);
    if (hex.length % 2 === 0) {
      const decoded = printableText(Buffer.from(hex, 'hex'));
      if (decoded) scanText(decoded, { originLine: lineNo, origin: 'hex', depth: depth + 1, add });
    }
  }
  // HTML comments: a comment that carries an instruction, or speaks to a
  // model or an agent.
  if (!origin) {
    for (const m of text.matchAll(/<!--([\s\S]*?)(?:-->|$)/g)) {
      const inner = m[1];
      const folded = foldForRules(inner);
      const carries = folded.split('\n').some((l) => ruleHits(l, null).length || urlFindings(l).length) || COMMENT_ADDRESSED_RE.test(folded);
      if (carries) {
        const lineNo = lineOf(starts, m.index);
        add('AGENT_MESSAGE_HTML_COMMENT_INSTRUCTION', lineNo, inner, 0, 'html_comment');
      }
    }
  }
}

// The rule findings for `text`, sorted and de-duplicated: one finding per
// code, line and origin.
export function findAgentMessageIssues(text) {
  const seen = new Map();
  const add = (code, line, sourceText, index, origin) => {
    const key = `${code}|${line}|${origin || ''}`;
    if (seen.has(key)) return;
    seen.set(key, { code, severity: AGENT_MESSAGE_SEVERITY[code], line, excerpt: excerpt(sourceText, index), ...(origin ? { decoded_from: origin } : {}) });
  };
  scanText(String(text), { add });
  return [...seen.values()].sort((a, b) => a.line - b.line || a.code.localeCompare(b.code) || String(a.decoded_from || '').localeCompare(String(b.decoded_from || '')));
}

// URLs, domains and wallet addresses named in the text (from what a
// reader sees: invisible characters removed).
export function extractIndicators(text) {
  const visible = stripInvisible(String(text)).normalize('NFKC');
  const urls = [];
  const hosts = new Map();
  for (const m of visible.matchAll(URL_RE)) {
    const u = trimUrl(m[0]);
    const masked = maskSecrets(u);
    if (!urls.includes(masked) && urls.length < MAX_LISTED) urls.push(masked);
    const h = hostOf(u);
    if (h && !hosts.has(h)) hosts.set(h, m.index);
  }
  const withoutUrls = visible.replace(URL_RE, ' ').replace(/[\w.+-]+@([\w-]+\.)+[a-z]{2,}/gi, ' ');
  for (const m of withoutUrls.matchAll(BARE_HOST_RE)) {
    const h = m[0].toLowerCase();
    const tld = h.slice(h.lastIndexOf('.') + 1);
    if (FILE_TLDS.has(tld)) continue;
    if (!hosts.has(h)) hosts.set(h, m.index);
  }
  const domains = [];
  const hostForDomain = new Map();
  for (const h of hosts.keys()) {
    const d = registrable(h);
    if (!d || domains.includes(d)) continue;
    if (domains.length < MAX_LISTED) { domains.push(d); hostForDomain.set(d, h); }
  }
  const wallets = [];
  const lower = new Set();
  for (const re2 of [EVM_RE, BTC_RE]) {
    for (const m of visible.matchAll(re2)) {
      const a = m[0];
      if (lower.has(a.toLowerCase()) || wallets.length >= MAX_LISTED) continue;
      lower.add(a.toLowerCase());
      wallets.push(a);
    }
  }
  return { urls, domains, wallet_addresses: wallets, hostForDomain };
}

// --- enrichment ------------------------------------------------------------------------

const ENRICH_SOURCES = Object.freeze({
  check_domain_age: 'domain registration records',
  check_hostname_reputation: 'phishing domain list',
  check_wallet_sanctions: 'sanctions list',
  check_wallet_age: 'on-chain transfer history'
});

async function enrich({ domains, wallets, hostForDomain, runTool, budgetMs }) {
  const targets = {
    domains: domains.filter((d) => !RESERVED_HOST_RE.test(d)).slice(0, AGENT_MESSAGE_ENRICH_MAX_DOMAINS),
    wallets: wallets.slice(0, AGENT_MESSAGE_ENRICH_MAX_WALLETS)
  };
  const calls = [];
  for (const d of targets.domains) {
    calls.push({ tool: 'check_domain_age', args: { domain: d }, key: d });
    calls.push({ tool: 'check_hostname_reputation', args: { hostname: hostForDomain.get(d) || d }, key: d });
  }
  for (const w of targets.wallets) {
    calls.push({ tool: 'check_wallet_sanctions', args: { address: w }, key: w });
    if (/^0x/i.test(w)) calls.push({ tool: 'check_wallet_age', args: { address: w, chain: 'base' }, key: w });
  }
  if (!calls.length) return null;
  const started = Date.now();
  for (const c of calls) {
    c.state = 'pending';
    c.promise = Promise.resolve().then(() => runTool(c.tool, c.args)).then((r) => { c.state = 'ok'; c.result = r; }, () => { c.state = 'error'; });
  }
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, budgetMs); });
  await Promise.race([Promise.all(calls.map((c) => c.promise)), deadline]);
  clearTimeout(timer);
  const timedOut = calls.some((c) => c.state === 'pending');
  const checks = [];
  for (const [tool, source] of Object.entries(ENRICH_SOURCES)) {
    const mine = calls.filter((c) => c.tool === tool);
    if (!mine.length) continue;
    checks.push(buildCheck(source, mine.some((c) => c.state === 'pending') ? 'timeout' : mine.some((c) => c.state === 'error') ? 'error' : 'ok'));
  }
  const get = (tool, key) => { const c = calls.find((x) => x.tool === tool && x.key === key); return c && c.state === 'ok' ? c.result : null; };
  const domainResults = targets.domains.map((d) => {
    const age = get('check_domain_age', d);
    const rep = get('check_hostname_reputation', d);
    return {
      domain: d,
      hostname: hostForDomain.get(d) || d,
      age_days: age ? age.age_days ?? null : null,
      newly_registered: age ? (age.newly_registered ?? null) : null,
      hostname_verdict: rep ? rep.verdict || null : null,
      lookalike_of: rep ? rep.lookalike_of || null : null,
      checked: !!(age && rep)
    };
  });
  const walletResults = targets.wallets.map((w) => {
    const s = get('check_wallet_sanctions', w);
    const a = /^0x/i.test(w) ? get('check_wallet_age', w) : null;
    return {
      address: w,
      sanctions_listed: s ? !!s.listed : null,
      chain: /^0x/i.test(w) ? 'base' : null,
      found_on_chain: a ? (a.found ?? null) : null,
      age_days: a ? a.age_days ?? null : null,
      checked: !!s && (!/^0x/i.test(w) || !!a)
    };
  });
  return {
    checks,
    timedOut,
    view: {
      ran: true,
      budget_ms: budgetMs,
      elapsed_ms: Math.min(Date.now() - started, budgetMs),
      timed_out: timedOut,
      ...(timedOut ? { note: `Enrichment did not finish within ${budgetMs / 1000} s; the rule results above are complete, the lookups marked checked: false did not finish.` } : {}),
      domains: domainResults,
      wallets: walletResults
    }
  };
}

// --- the tool --------------------------------------------------------------------------

export const AGENT_MESSAGE_NOTE = 'No findings does not prove the content is harmless: these are rule-based checks for known prompt-injection and payment-manipulation patterns.';

export function verdictOf(findings) {
  if (findings.some((f) => f.severity === 'high')) return 'malicious';
  if (findings.length) return 'suspicious';
  return 'no_findings';
}

export function summaryOf(findings) {
  if (!findings.length) return 'checked: no findings';
  const high = findings.filter((f) => f.severity === 'high').length;
  return `checked: ${findings.length} finding${findings.length === 1 ? '' : 's'} (${high} high, ${findings.length - high} medium)`;
}

function firstOccurrence(text, needle) {
  const visible = stripInvisible(String(text));
  const i = visible.toLowerCase().indexOf(String(needle).toLowerCase());
  if (i < 0) return { line: 1, sourceText: '', index: 0 };
  const starts = lineStarts(visible);
  const line = lineOf(starts, i);
  return { line, sourceText: visible.slice(starts[line - 1]).split('\n')[0], index: i - starts[line - 1] };
}

function defaultLog(entry) {
  try { console.log(`[check_agent_message] ${JSON.stringify(entry)}`); } catch { /* never affects the response */ }
}

// check_agent_message. `runTool` is PG1's own read-only tool runner
// (api/mcp.mjs internalRunTool); without it, enrichment is skipped.
export async function checkAgentMessage(args, { runTool = null, fetchImpl = globalThis.fetch, lookup, requestId = null, log = defaultLog, enrichBudgetMs = AGENT_MESSAGE_ENRICH_BUDGET_MS } = {}) {
  const input = normalizeAgentMessageArgs(args);
  let text = input.text;
  let contentType = null;
  if (input.source === 'url') {
    const got = await fetchAgentMessage(input.url, { fetchImpl, lookup });
    text = got.text;
    contentType = got.contentType;
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  const sha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  let findings = findAgentMessageIssues(text);
  const indicators = extractIndicators(text);
  const checks = [buildCheck('PG1 message rules', 'ok')];
  let enrichment = { ran: false, budget_ms: enrichBudgetMs, timed_out: false, domains: [], wallets: [] };
  let enrichIncomplete = false;
  if (typeof runTool === 'function') {
    const e = await enrich({ domains: indicators.domains, wallets: indicators.wallet_addresses, hostForDomain: indicators.hostForDomain, runTool, budgetMs: enrichBudgetMs });
    if (e) {
      checks.push(...e.checks);
      enrichment = e.view;
      enrichIncomplete = e.timedOut || e.checks.some((c) => c.result !== 'ok');
      const extra = [];
      for (const w of e.view.wallets) if (w.sanctions_listed) { const o = firstOccurrence(text, w.address); extra.push({ code: 'WALLET_SANCTIONED', severity: 'high', line: o.line, excerpt: excerpt(o.sourceText, o.index) }); }
      for (const d of e.view.domains) {
        if (d.hostname_verdict === 'listed') { const o = firstOccurrence(text, d.hostname); extra.push({ code: 'HOSTNAME_PHISHING_LISTED', severity: 'medium', line: o.line, excerpt: excerpt(o.sourceText, o.index) }); }
        if (d.hostname_verdict === 'lookalike') { const o = firstOccurrence(text, d.hostname); extra.push({ code: 'HOSTNAME_LOOKALIKE', severity: 'medium', line: o.line, excerpt: excerpt(o.sourceText, o.index) }); }
      }
      findings = [...findings, ...extra].sort((a, b) => a.line - b.line || a.code.localeCompare(b.code) || String(a.decoded_from || '').localeCompare(String(b.decoded_from || '')));
    }
  }
  const truncated = findings.length > MAX_FINDINGS;
  if (truncated) findings = findings.slice(0, MAX_FINDINGS);
  const verdict = verdictOf(findings);
  const codes = [...new Set(findings.map((f) => f.code))].sort();
  const reasons = codes.map((c) => reason(c));
  if (enrichIncomplete) reasons.push(reason('AGENT_MESSAGE_ENRICHMENT_INCOMPLETE'));
  log({ sha256, bytes, kind: input.kind, verdict, reason_codes: reasons.map((r) => r.code) });
  return withResponseMeta({
    verdict,
    summary: summaryOf(findings),
    kind: input.kind,
    source: input.source,
    ...(input.source === 'url' ? { url: maskSecrets(input.url), content_type: contentType } : {}),
    sha256,
    bytes,
    findings,
    ...(truncated ? { findings_truncated: true } : {}),
    urls: indicators.urls,
    domains: indicators.domains,
    wallet_addresses: indicators.wallet_addresses,
    enrichment,
    rules_version: RULES_VERSION,
    note: AGENT_MESSAGE_NOTE
  }, { reasons, checks, requestId });
}
