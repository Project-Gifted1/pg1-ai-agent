// check_agent_message (1.21.0): a prompt-injection check for a message one
// agent received from another (or a tool result, web page, email or a
// seller's skill.md it is about to act on). Does it carry instructions or
// tricks the receiving agent should not follow?
//
//   input  { message (required, at most 32 KB UTF-8), source? (agent name
//            or URL), receiver_capabilities? (["payments","shell",...]) }
//   output { status no_flags | flagged | unknown, risk low | medium | high,
//            reasons [{ code, message, detail, span: { start, end } }],
//            checks [{ name, status, ms, source, result, checked_at,
//            data_as_of }], urls_checked, message_bytes, request_id }
//
// Rule-based only: deterministic detectors (regular expressions and
// character tables in this file), so it costs $0 to run and the message is
// never sent to any AI engine. The only calls out are PG1's own hostname
// and domain-age checks for each URL in the message (runTool, the same
// handlers /api/mcp serves), inside the same call.
//
// "no_flags" means none of these patterns were found, never that the
// message is harmless: a new trick can always get past fixed patterns.
//
// Privacy: the message text is never stored or logged. One log line per
// call (logAgentMessageCheck): request_id, size in bytes, a SHA-256 hash of
// the message, the reason codes and the timings. A Core State event
// (publishMessageCheck) carries the status, risk and codes only.
//
// Spans are UTF-16 code unit offsets into `message` as sent (JavaScript
// string indices), end exclusive.

import crypto from 'node:crypto';
import { reason, REASON_CODES } from './reasonCodes.mjs';
import { buildCheck, computeStatus } from './responseMeta.mjs';
import { assertPricing } from './pricing.mjs';
import { X402_PRICE, x402PriceUsd } from './x402Config.mjs';

export const AGENT_MESSAGE_TOOL = 'check_agent_message';
export const MAX_MESSAGE_BYTES = 32 * 1024;
export const MAX_SOURCE_CHARS = 512;
export const MAX_URLS_CHECKED = 5;
export const URL_CHECK_TIMEOUT_MS = 4000;
export const AGENT_MESSAGE_PRICE_USD = x402PriceUsd(X402_PRICE);
// Worst case: two of PG1's own lookups (phishing list, registration date) per URL host.
export const AGENT_MESSAGE_WORST_CASE_COST_USD = 0.002;
assertPricing([{ name: AGENT_MESSAGE_TOOL, priceUsd: AGENT_MESSAGE_PRICE_USD, worstCaseCostUsd: AGENT_MESSAGE_WORST_CASE_COST_USD }]);

export const RECEIVER_CAPABILITIES = Object.freeze(['payments', 'wallet', 'shell', 'code', 'email', 'browser', 'network', 'files', 'database', 'messaging']);
export const RISK_LEVELS = Object.freeze(['low', 'medium', 'high']);

// The nine detectors, in the order they run. Each name is also its reason
// code in lower case (the code itself is UPPER_SNAKE, lib/reasonCodes.mjs).
export const MESSAGE_DETECTORS = Object.freeze([
  'instruction_override', 'embedded_command', 'tool_call_markup', 'role_impersonation', 'hidden_text',
  'credential_request', 'payment_request', 'data_exfiltration', 'suspicious_url'
]);
export const MESSAGE_REASON_CODES = Object.freeze(MESSAGE_DETECTORS.map((d) => d.toUpperCase()));

export const AGENT_MESSAGE_DEF = Object.freeze({
  name: AGENT_MESSAGE_TOOL,
  description: 'PG1 Sovereign Threat Intelligence: checks a message your agent received from another agent (or a tool result, web page, email or a seller\'s skill.md) before you act on it: does it carry instructions or tricks you should not follow? Rule-based only (no AI reads it): instruction overrides in many languages, embedded slash/shell/SQL commands, tool-call or function-call markup, fake system/developer/operator messages, hidden text (zero-width characters, bidi overrides, homoglyphs, hidden HTML, long base64/hex blocks), credential requests, payment requests, data exfiltration requests, and each URL checked against PG1\'s phishing/look-alike list and domain age. Give receiver_capabilities (payments, shell, email, ...) to weight the risk. Returns status flagged / no_flags / unknown, risk low / medium / high, and reasons with the span of each finding. no_flags means none of these patterns were found, never a guarantee and never "safe". The message is never stored. Payment: $0.01 via x402 (params._meta["x402/payment"]) or a Gumroad licence key, after 5 free calls a day per caller shared with every other paid tool. Results are signed (see verify_result).',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', maxLength: MAX_MESSAGE_BYTES, description: 'The message as received, at most 32 KB (UTF-8). Never stored.' },
      source: { type: 'string', maxLength: MAX_SOURCE_CHARS, description: 'Optional: who it came from, an agent name or a URL (a URL is checked too).' },
      receiver_capabilities: { type: 'array', items: { type: 'string', maxLength: 32 }, maxItems: 20, description: `Optional: what your agent can do, to weight the risk. Any of ${RECEIVER_CAPABILITIES.join(', ')}.` }
    },
    required: ['message'],
    additionalProperties: false
  }
});

const invalid = (message, code = 'invalid_input') => Object.assign(new Error(message), { mcpToolError: true, code });

export function messageBytes(text) {
  return Buffer.byteLength(String(text), 'utf8');
}

export function normalizeAgentMessageInput(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  if (typeof a.message !== 'string' || !a.message.length) throw invalid('message is required: the text your agent received, as a string');
  const bytes = messageBytes(a.message);
  if (bytes > MAX_MESSAGE_BYTES) throw invalid(`message is ${bytes} bytes; at most ${MAX_MESSAGE_BYTES} bytes (32 KB) is checked per call. Split it and check each part.`, 'message_too_large');
  let source = null;
  if (a.source !== undefined && a.source !== null) {
    if (typeof a.source !== 'string') throw invalid('source must be a string: an agent name or a URL');
    source = a.source.trim().slice(0, MAX_SOURCE_CHARS) || null;
  }
  let caps = [];
  if (a.receiver_capabilities !== undefined && a.receiver_capabilities !== null) {
    if (!Array.isArray(a.receiver_capabilities) || a.receiver_capabilities.length > 20 || a.receiver_capabilities.some((c) => typeof c !== 'string' || c.length > 32)) {
      throw invalid(`receiver_capabilities must be a list of at most 20 short strings, e.g. ["payments","shell","email"]. Known: ${RECEIVER_CAPABILITIES.join(', ')}`);
    }
    caps = [...new Set(a.receiver_capabilities.map((c) => c.trim().toLowerCase()).filter(Boolean))];
  }
  return { message: a.message, source, receiver_capabilities: caps, bytes };
}

// --- text views with an index map back to the original ----------------------------

const ZERO_WIDTH_RE = /[​-‏⁠-⁤﻿᠎­͏؜ᅟᅠㅤﾠ]/;
const BIDI_RE = /[‪-‮⁦-⁩]/;
const isTagChar = (cp) => cp >= 0xE0000 && cp <= 0xE007F;

// Latin look-alikes from Cyrillic and Greek (lower case), for the folded view.
const HOMOGLYPHS = {
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's', 'і': 'i', 'ї': 'i', 'ј': 'j', 'ԁ': 'd', 'ɡ': 'g', 'ӏ': 'l', 'һ': 'h', 'ԛ': 'q', 'ԝ': 'w',
  'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w'
};

// Builds a matching view of `text`: NFKC, lower case, invisible characters
// dropped and (when fold) Cyrillic/Greek look-alikes mapped to Latin.
// map[i] is the original index of view character i.
function buildView(text, { fold }) {
  let out = '';
  const map = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const width = ch.length;
    if (!(ZERO_WIDTH_RE.test(ch) || BIDI_RE.test(ch) || isTagChar(cp))) {
      let n = ch.normalize('NFKC').toLowerCase();
      if (fold) n = [...n].map((c) => HOMOGLYPHS[c] || c).join('');
      for (let k = 0; k < n.length; k++) { out += n[k]; map.push(i); }
    }
    i += width;
  }
  map.push(text.length);
  return { text: out, map };
}

function spanOf(view, start, end, original) {
  const s = view.map[start];
  let e = end > 0 ? view.map[end - 1] : s;
  // Extend past the last mapped character (it may be a surrogate pair).
  const cp = original.codePointAt(e);
  e += cp !== undefined && cp > 0xFFFF ? 2 : 1;
  return { start: s, end: Math.min(e, original.length) };
}

// --- the detectors ---------------------------------------------------------------------

const W = '[\\s\\p{P}]{1,6}'; // a gap between words in the folded view

// instruction_override: "ignore previous instructions" and its variants.
// Latin-script patterns run on the folded view (so homoglyph spellings
// match); the others on the plain view.
const OVERRIDE_LATIN = [
  ['en', new RegExp(`\\b(?:ignore|disregard|forget|override|bypass|skip|drop|abandon)${W}(?:(?:all|any|every|each|of|the|your|my|these|those|prior|previous|above|earlier|preceding|foregoing|original|initial|existing|system|old|safety|other)${W}){0,4}(?:instructions?|prompts?|rules|directives?|guidelines|guardrails|constraints|context|commands|orders|policies|programming)\\b`, 'giu')],
  ['en', new RegExp(`\\b(?:forget|disregard|ignore)${W}(?:everything|anything|all)${W}(?:(?:you|that|i|we|were|was|have|has|been|told|said|above|before|so|far|earlier)${W}?){1,5}`, 'giu')],
  ['en', new RegExp(`\\b(?:new|updated|real|actual|true|revised)${W}(?:system${W})?instructions?${W}?:`, 'giu')],
  ['en', new RegExp(`\\byou${W}are${W}(?:now${W})?no${W}longer${W}(?:an?${W})?(?:assistant|bound|restricted|limited|required)`, 'giu')],
  ['en', new RegExp(`\\bfrom${W}now${W}on${W}(?:,${W}?)?you${W}(?:will|must|shall|are|have${W}to)\\b`, 'giu')],
  ['en', new RegExp(`\\b(?:do${W}not|don'?t|never)${W}(?:follow|obey|apply|listen${W}to)${W}(?:your|the|any)${W}(?:(?:previous|prior|original|system|safety|usual)${W})?(?:instructions|rules|guidelines|policies|programming)`, 'giu')],
  ['en', new RegExp(`\\b(?:enter|enable|activate|switch${W}to|you${W}are${W}now${W}in)${W}(?:developer|dan|god|jailbreak|unrestricted|debug)${W}mode\\b`, 'giu')],
  ['es', new RegExp(`\\b(?:ignora|ignore|ignorad|olvida|descarta)${W}(?:(?:todas|todos|las|los|tus|sus)${W}){0,2}(?:instrucciones|indicaciones|reglas|órdenes)${W}(?:anteriores|previas)`, 'giu')],
  ['fr', new RegExp(`\\b(?:ignore[zr]?|oublie[zr]?)${W}(?:(?:toutes|tous|les|tes|vos|des)${W}){0,2}(?:instructions|consignes|règles|directives)${W}(?:précédentes|antérieures|ci-dessus)`, 'giu')],
  ['de', new RegExp(`\\b(?:ignoriere|ignorieren${W}sie|vergiss|vergessen${W}sie|missachte)${W}(?:(?:alle|die|deine|ihre|bisherigen|vorherigen|vorigen|obigen)${W}){0,3}(?:anweisungen|instruktionen|regeln|befehle|vorgaben)`, 'giu')],
  ['it', new RegExp(`\\b(?:ignora|ignorate|dimentica)${W}(?:(?:tutte|tutti|le|i|tue)${W}){0,2}(?:istruzioni|regole|indicazioni)${W}(?:precedenti|sopra)`, 'giu')],
  ['pt', new RegExp(`\\b(?:ignore|ignora|esqueça|esqueca|desconsidere)${W}(?:(?:todas|todos|as|os|suas)${W}){0,2}(?:instruções|instrucoes|regras|ordens)${W}(?:anteriores|prévias|previas)`, 'giu')],
  ['nl', new RegExp(`\\b(?:negeer|vergeet)${W}(?:(?:alle|de|je|jouw)${W}){0,2}(?:vorige|eerdere|voorgaande)${W}(?:instructies|regels|opdrachten)`, 'giu')],
  ['pl', new RegExp(`\\b(?:zignoruj|zapomnij|ignoruj)${W}(?:(?:wszystkie|wcześniejsze|poprzednie)${W}){1,2}(?:instrukcje|polecenia|zasady)`, 'giu')],
  ['tr', new RegExp(`\\b(?:önceki|onceki)${W}(?:tüm${W}|tum${W})?(?:talimatları|talimatlari|komutları|kuralları)${W}(?:yok${W}say|görmezden${W}gel|unut)`, 'giu')],
  ['id', new RegExp(`\\b(?:abaikan|lupakan)${W}(?:semua${W})?(?:instruksi|perintah|aturan)${W}(?:sebelumnya|di${W}atas)`, 'giu')],
  ['vi', new RegExp(`(?:bỏ${W}qua|phớt${W}lờ)${W}(?:tất${W}cả${W})?(?:các${W})?(?:hướng${W}dẫn|chỉ${W}thị|lệnh)${W}(?:trước${W}đó|trước)`, 'giu')]
];
const OVERRIDE_OTHER = [
  ['ru', /(?:игнорируй(?:те)?|проигнорируй(?:те)?|забудь(?:те)?)[\s\p{P}]{1,6}(?:(?:все|всё|свои|твои|предыдущие|прежние|прошлые)[\s\p{P}]{1,6}){0,3}(?:инструкции|указания|правила|команды)/giu],
  ['uk', /(?:ігноруй(?:те)?|забудь(?:те)?)[\s\p{P}]{1,6}(?:(?:всі|усі|попередні)[\s\p{P}]{1,6}){0,2}(?:інструкції|вказівки|правила)/giu],
  ['zh', /(?:忽略|无视|忽视|忘记|無視|忘記)(?:掉)?(?:你)?(?:之前|以上|先前|上面|前面|此前|所有|全部)(?:的)?(?:所有|全部)?(?:的)?(?:指令|指示|说明|說明|规则|規則|提示|命令)/gu],
  ['ja', /(?:以前|前|上記|これまで|先)の(?:すべての|全ての)?(?:指示|命令|ルール|指令)(?:を|は)?(?:すべて)?(?:無視|忘れ)/gu],
  ['ko', /(?:이전|앞의|위의|모든)\s*(?:모든\s*)?(?:지시|지침|명령|규칙)(?:사항)?(?:을|를|은|는)?\s*(?:모두\s*)?(?:무시|잊어)/gu],
  ['ar', /(?:تجاهل|انس|إنس)\s+(?:جميع\s+|كل\s+)?(?:التعليمات|الأوامر|القواعد)\s+(?:السابقة|أعلاه)/gu],
  ['fa', /(?:نادیده\s+بگیر|فراموش\s+کن).{0,20}(?:دستورالعمل|دستورات)/gu],
  ['he', /(?:התעלם|שכח)\s+(?:מכל\s+|מ)?(?:ההוראות|הנחיות)\s+(?:הקודמות|הקודמים)/gu],
  ['hi', /(?:पिछले|पहले\s+के|सभी)\s+(?:सभी\s+)?(?:निर्देशों|निर्देश|आदेशों)\s+(?:को\s+)?(?:अनदेखा|नज़रअंदाज़|नजरअंदाज|भूल)/gu],
  ['th', /(?:ละเว้น|เพิกเฉย|ลืม)(?:คำสั่ง|คำแนะนำ)(?:ก่อนหน้า|ทั้งหมด)/gu],
  ['el', /(?:αγνόησε|αγνοήστε|ξέχνα)\s+(?:όλες\s+)?(?:τις\s+)?(?:προηγούμενες\s+)?(?:οδηγίες|εντολές)/gu]
];

// embedded_command: a slash command at the start of a line, dangerous shell
// one-liners, destructive or injection SQL. Ordinary code (npm install, a
// SELECT with a WHERE, git commands) is not flagged.
const COMMAND_PATTERNS = [
  ['slash command', /^[ \t>*-]*\/(?!\/)[a-z][a-z0-9_-]{1,30}(?=[ \t]|$)(?![ \t]*\/)/gim],
  ['pipe to a shell', /\b(?:curl|wget|iwr|invoke-webrequest|fetch)\b[^\n|]{0,300}\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b/gi],
  ['pipe to a shell', /\b(?:base64\s+(?:-d|--decode)|xxd\s+-r)\b[^\n]{0,200}\|\s*(?:ba|z)?sh\b/gi],
  ['destructive shell', /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*\s+(?:--no-preserve-root\s+)?(?:\/|~|\$home|\*)(?:\s|$|\*)/gi],
  ['destructive shell', /\b(?:mkfs(?:\.\w+)?\s+\/dev\/|dd\s+if=\S+\s+of=\/dev\/[sh]d|chmod\s+-r\s+777\s+\/|:\(\)\s*\{\s*:\|:&\s*\};:)/gi],
  ['reverse shell', /\b(?:bash|sh)\s+-i\s*>&?\s*\/dev\/tcp\/|\bnc(?:at)?\s+(?:-[a-z]*e[a-z]*\s+\S+|\S+\s+\d+\s+-e\s)|\bmkfifo\s+\/tmp\/\S+\s*;/gi],
  ['encoded shell', /\bpowershell(?:\.exe)?\b[^\n]{0,60}\s-(?:e|enc|encodedcommand)\s+[a-z0-9+/=]{16,}/gi],
  ['encoded shell', /\b(?:iex|invoke-expression)\s*\(\s*(?:new-object|\(new-object|iwr|invoke-webrequest)/gi],
  ['secret file read', /\b(?:cat|type|less|more|head|tail|cp|scp|curl\s+-F\s*\S*@)\s+[^\n]{0,40}(?:~\/\.ssh\/id_[a-z0-9]+|\/etc\/shadow|\.aws\/credentials|\.env\b|id_rsa\b|\.npmrc|\.git-credentials)/gi],
  ['code execution', /\b(?:os\.system|subprocess\.(?:call|run|popen)|child_process\.exec(?:sync)?|runtime\.getruntime\(\)\.exec|eval\s*\(\s*(?:atob|base64|request|input|fetch)|exec\s*\(\s*(?:base64|compile|__import__))/gi],
  ['destructive SQL', /\b(?:drop\s+(?:table|database|schema)|truncate\s+table|alter\s+table\s+\S+\s+drop)\b/gi],
  ['destructive SQL', /\bdelete\s+from\s+[`"\w.]+\s*(?:;|$)/gim],
  ['SQL injection', /(?:'|")\s*(?:or|and)\s+(?:'?1'?\s*=\s*'?1'?|true)\s*(?:--|#|\/\*)|\bunion\s+(?:all\s+)?select\b[^\n]{0,80}\bfrom\b[^\n]{0,40}\b(?:users|passwords?|accounts|credentials|information_schema)\b|;\s*(?:drop|delete|update|insert)\s[^\n]{0,80}--|\bxp_cmdshell\b|\bgrant\s+all\s+privileges\b/gi]
];

// tool_call_markup: function-call / tool-use JSON or XML, MCP-style calls,
// chat-template control tokens.
const TOOL_CALL_PATTERNS = [
  ['tool-use JSON', /"type"\s*:\s*"(?:tool_use|function|tool_call|function_call)"/gi],
  ['tool-use JSON', /"(?:tool_calls|function_call|tool_use|tool_choice)"\s*:\s*[[{]/gi],
  ['function-call JSON', /\{\s*"(?:name|tool|tool_name|function)"\s*:\s*"[a-z][\w.-]{1,64}"\s*,\s*"(?:arguments|parameters|args|input)"\s*:\s*[{"]/gi],
  ['MCP call', /"method"\s*:\s*"(?:tools\/call|tools\/list|resources\/read|prompts\/get|sampling\/createmessage)"/gi],
  ['tool-call XML', /<\s*\/?\s*(?:[a-z_]+:)?(?:function_calls|function_call|tool_call|tool_calls|tool_use|tool_result|invoke|parameter|use_mcp_tool|mcp_tool)\b[^>]{0,200}>/gi],
  ['tool-call XML', /<function=[a-z][\w.-]{0,64}>/gi],
  ['control token', /<\|(?:im_start|im_end|start_header_id|end_header_id|eot_id|tool_call|tool_calls|python_tag|begin_of_text|system|assistant|user)\|>|\[(?:TOOL_CALLS|AVAILABLE_TOOLS|TOOL_RESULTS)\]/gi]
];

// role_impersonation: fake system / developer / operator messages.
const ROLE_PATTERNS = [
  ['role header', /^[ \t>#*[(-]*(?:system|developer|operator|admin(?:istrator)?|root|assistant)\s*(?:message|prompt|note|override|instruction)?\s*[\])]?\s*:(?!\/\/)/gim],
  ['role header', /(?<=^|[.!?][ \t]{1,3})(?:system|developer|operator)[ \t]*(?:message|override|notice)?[ \t]*:(?!\/\/)(?=[ \t]*\S)/gim],
  ['role tag', /<\s*\/?\s*(?:system|developer|operator|sys|system_prompt|system-message)\s*>|\[\/?(?:system|sys|inst|admin|developer)\]|<<\/?sys>>/gi],
  ['role header', /^#{1,6}\s*(?:system|developer)\s*(?:message|prompt|instructions?)?\s*$/gim],
  ['claimed authority', /\b(?:this\s+is|message\s+from|note\s+from|instructions?\s+from|update\s+from)\s+(?:your|the)\s+(?:system(?:\s+administrator)?|developers?|operators?|creators?|owners?|admin(?:istrator)?|security\s+team|platform)\b/gi],
  ['claimed authority', /\bas\s+your\s+(?:developer|creator|operator|owner|admin(?:istrator)?|system)\s*,?\s+i\s+(?:instruct|order|command|authori[sz]e|require|need)\b/gi],
  ['claimed authority', /\b(?:official|priority|urgent|mandatory)\s+(?:system|developer|operator|admin)\s+(?:message|instruction|override|notice|directive)\b/gi]
];

// credential_request: asks for keys, passwords, seed phrases, tokens.
const SECRET_WORDS = '(?:api[\\s_-]?keys?|passwords?|passphrases?|private[\\s_-]?keys?|secret[\\s_-]?keys?|seed[\\s_-]?phrases?|recovery[\\s_-]?phrases?|mnemonic(?:\\s+phrase)?|access[\\s_-]?tokens?|auth(?:entication)?[\\s_-]?tokens?|bearer[\\s_-]?tokens?|session[\\s_-]?(?:tokens?|cookies?)|credentials|2fa[\\s_-]?codes?|otp(?:[\\s_-]?codes?)?|one[\\s-]time[\\s_-]?(?:codes?|passwords?)|ssh[\\s_-]?keys?|\\.env(?:\\s+file)?|environment[\\s_-]?variables|wallet[\\s_-]?keys?|signing[\\s_-]?keys?|system[\\s_-]?prompt)';
const CREDENTIAL_PATTERNS = [
  ['asks for a secret', new RegExp(`\\b(?:send|share|give|provide|paste|reveal|tell|show|enter|post|forward|email|dm|type|print|output|display|list|dump|leak|expose|read\\s+out)\\s+(?:(?:me|us|it|them|here|back|over)\\s+)?(?:(?:your|the|all|any|of|its|their|our|its)\\s+){0,3}(?:(?:current|full|complete|raw|stored|saved|wallet|admin|root|owner)\\s+)?${SECRET_WORDS}\\b`, 'gi')],
  ['asks for a secret', new RegExp(`\\bwhat\\s+(?:is|are)\\s+(?:your|the)\\s+(?:(?:current|full|wallet|admin)\\s+)?${SECRET_WORDS}\\b`, 'gi')],
  ['asks for a secret', new RegExp(`\\b(?:include|attach|append|add)\\s+(?:(?:your|the)\\s+)${SECRET_WORDS}\\s+(?:in|to)\\b`, 'gi')]
];

// payment_request: wallet addresses with send/approve wording; x402
// payment headers or payloads pasted into text.
const WALLET_RE = /\b0x[0-9a-fA-F]{40}\b|\bbc1[0-9ac-hj-np-z]{25,62}\b|\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g;
const PAY_WORDS_RE = /\b(?:send|transfer|pay|wire|deposit|approve|approval|allowance|setapprovalforall|sign|top\s*up|fund|move|withdraw|refund|bridge|swap)\b/i;
const PAYMENT_PATTERNS = [
  ['x402 payment header', /\b(?:x-payment|payment-signature|payment-required|x-payment-response|payment-response)\s*:\s*\S{8,}/gi],
  ['x402 payment payload', /"x402version"\s*:\s*\d|"payto"\s*:\s*"|"scheme"\s*:\s*"exact"[^}]{0,200}"maxamountrequired"/gi],
  ['unlimited approval', /\b(?:approve|grant|set)\s+(?:an?\s+)?(?:unlimited|infinite|max(?:imum)?)\s+(?:token\s+)?(?:allowance|approval|spending)\b|\bsetapprovalforall\s*\([^)]{0,80}true\s*\)/gi]
];

// data_exfiltration: requests to send data to a URL or an email address.
const EXFIL_VERB = '(?:send|post|upload|forward|e-?mail|exfiltrate|transmit|submit|copy|sync|leak|report|deliver|share|pipe|push|beacon|curl|fetch|append)';
const EXFIL_DATA = '(?:conversation|chat(?:\\s+(?:history|log))?|history|transcript|data|database|files?|logs?|messages?|memory|memories|context|system\\s+prompt|instructions|secrets?|keys?|tokens?|credentials|cookies|results?|outputs?|responses?|user(?:\\s+(?:data|info|details))?|customer(?:\\s+(?:data|list|records))?|contacts|documents?|emails?|inbox|contents|everything|all\\s+of\\s+(?:it|this))';
const URL_OR_EMAIL = '(?:https?:\\/\\/[^\\s<>"\')\\]]+|[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,})';
const EXFIL_PATTERNS = [
  ['send data to a URL or email', new RegExp(`\\b${EXFIL_VERB}\\b[^.\\n]{0,120}?\\b${EXFIL_DATA}\\b[^.\\n]{0,120}?\\b(?:to|at|into|via|on)\\s+(?:this\\s+|the\\s+|my\\s+)?(?:(?:url|endpoint|webhook|server|address|email|inbox|link)\\s*:?\\s*)?${URL_OR_EMAIL}`, 'gi')],
  ['data in a URL', /!\[[^\]]{0,80}\]\(\s*https?:\/\/[^\s)]{0,200}[?&][a-z_]{1,20}=(?:\{|\$\{|%7b|\[|<)[^\s)]{0,200}\)/gi],
  ['data in a URL', /https?:\/\/[^\s"'<>]{0,200}[?&](?:q|data|d|payload|secret|key|token|msg|content|c|x)=\{\{?\s*[a-z_.]{2,40}\s*\}?\}/gi]
];

// hidden_text: invisible characters, bidi overrides, tag characters,
// mixed-script look-alike words, hidden HTML, long encoded blocks.
const HIDDEN_HTML_RE = /<[a-z][^>]{0,300}\bstyle\s*=\s*["'][^"']{0,300}(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?\s*[;"']|opacity\s*:\s*0(?:\.0+)?\s*[;"']|color\s*:\s*(?:#fff(?:fff)?|white|rgba?\(\s*255\s*,\s*255\s*,\s*255)\b[^"']{0,200}background(?:-color)?\s*:\s*(?:#fff(?:fff)?|white|rgba?\(\s*255\s*,\s*255\s*,\s*255)|background(?:-color)?\s*:\s*(?:#fff(?:fff)?|white)\b[^"']{0,200}(?:[^-]|^)color\s*:\s*(?:#fff(?:fff)?|white)\b|(?:height|width)\s*:\s*0(?:px)?\s*;[^"']{0,40}overflow\s*:\s*hidden|position\s*:\s*absolute[^"']{0,80}(?:left|top)\s*:\s*-\d{3,})[^"']{0,300}["'][^>]{0,200}>/gi;
const HIDDEN_ATTR_RE = /<[a-z][^>]{0,200}\s(?:hidden|aria-hidden\s*=\s*["']true["'])[^>]{0,200}>[^<]{12,}/gi;
const HTML_COMMENT_RE = /<!--([\s\S]{0,2000}?)-->/g;
const BASE64_BLOCK_RE = /(?:[A-Za-z0-9+/]{4}){30,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/g;
const HEX_BLOCK_RE = /\b(?:0x)?(?:[0-9a-fA-F]{2}){64,}\b/g;
const LATIN_RE = /\p{Script=Latin}/u;
const CONFUSABLE_SCRIPT_RE = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;
const WORD_RE = /[\p{L}\p{M}]{3,}/gu;

const lineOf = (text, at) => text.slice(text.lastIndexOf('\n', at - 1) + 1, (text.indexOf('\n', at) + 1 || text.length + 1) - 1);
const inCodeFence = (fences, at) => fences.some(([s, e]) => at >= s && at < e);

function codeFences(text) {
  const out = [];
  const re = /^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;
  for (const m of text.matchAll(re)) out.push([m.index, m.index + m[0].length]);
  return out;
}

function runPatterns(view, original, patterns, push, { skip } = {}) {
  for (const [label, re] of patterns) {
    re.lastIndex = 0;
    for (const m of view.text.matchAll(re)) {
      if (!m[0]) continue;
      const span = spanOf(view, m.index, m.index + m[0].length, original);
      if (skip && skip(span, label, m)) continue;
      push(label, span);
    }
  }
}

// Every detector over one message. Synchronous, deterministic, no I/O.
// Returns { findings: { [detector]: [{ label, span }] }, urls, timings }.
export function scanAgentMessage(message, { now = () => Date.now() } = {}) {
  const text = String(message || '');
  const plain = buildView(text, { fold: false });
  const folded = buildView(text, { fold: true });
  const fences = codeFences(text);
  const findings = Object.fromEntries(MESSAGE_DETECTORS.map((d) => [d, []]));
  const timings = {};
  const add = (detector) => (label, span) => {
    const list = findings[detector];
    if (list.some((f) => f.span.start < span.end && span.start < f.span.end)) return; // overlapping finding
    list.push({ label, span });
  };
  const timed = (detector, fn) => { const t0 = now(); fn(add(detector)); timings[detector] = Math.max(0, now() - t0); };

  timed('instruction_override', (push) => {
    runPatterns(folded, text, OVERRIDE_LATIN.map(([lang, re]) => [`override (${lang})`, re]), push);
    runPatterns(plain, text, OVERRIDE_OTHER.map(([lang, re]) => [`override (${lang})`, re]), push);
  });
  // Commands inside a fenced code block that the message presents as code
  // are still reported when they are dangerous; slash commands are not
  // (a code sample's comment or path is not a command to this agent).
  timed('embedded_command', (push) => runPatterns(plain, text, COMMAND_PATTERNS, push, { skip: (span, label) => label === 'slash command' && (inCodeFence(fences, span.start) || /^\s*\/(?:usr|bin|etc|var|tmp|opt|home|dev|proc|sys|lib|mnt|srv|root)\b/i.test(lineOf(text, span.start))) }));
  timed('tool_call_markup', (push) => runPatterns(plain, text, TOOL_CALL_PATTERNS, push));
  timed('role_impersonation', (push) => runPatterns(folded, text, ROLE_PATTERNS, push, { skip: (span) => inCodeFence(fences, span.start) }));
  timed('hidden_text', (push) => {
    for (let i = 0; i < text.length;) {
      const cp = text.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      const kind = BIDI_RE.test(ch) ? 'bidi override' : isTagChar(cp) ? 'tag characters' : ZERO_WIDTH_RE.test(ch) && !(cp === 0xFEFF && i === 0) ? 'zero-width characters' : null;
      if (kind) {
        let j = i;
        while (j < text.length) {
          const c2 = text.codePointAt(j);
          const s2 = String.fromCodePoint(c2);
          const k2 = BIDI_RE.test(s2) ? 'bidi override' : isTagChar(c2) ? 'tag characters' : ZERO_WIDTH_RE.test(s2) ? 'zero-width characters' : null;
          if (k2 !== kind) break;
          j += s2.length;
        }
        push(kind, { start: i, end: j });
        i = j;
        continue;
      }
      i += ch.length;
    }
    for (const m of text.matchAll(WORD_RE)) {
      if (LATIN_RE.test(m[0]) && CONFUSABLE_SCRIPT_RE.test(m[0])) push('mixed-script look-alike word', { start: m.index, end: m.index + m[0].length });
    }
    for (const re of [HIDDEN_HTML_RE, HIDDEN_ATTR_RE]) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) push('hidden HTML', { start: m.index, end: m.index + m[0].length });
    }
    for (const m of text.matchAll(HTML_COMMENT_RE)) {
      const inner = buildView(m[1], { fold: true }).text;
      if (OVERRIDE_LATIN.some(([, re]) => { re.lastIndex = 0; return re.test(inner); }) || /\b(?:assistant|agent|ai|llm|model)\b[^\n]{0,60}\b(?:must|should|will|now)\b/.test(inner)) push('instructions in an HTML comment', { start: m.index, end: m.index + m[0].length });
    }
    for (const m of text.matchAll(BASE64_BLOCK_RE)) {
      // A real encoded block mixes cases and digits; a long word or a row of one character is not one.
      const s = m[0];
      if (/[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9+/]/.test(s) && new Set(s).size > 16) push('long base64 block', { start: m.index, end: m.index + s.length });
    }
    for (const m of text.matchAll(HEX_BLOCK_RE)) push('long hex block', { start: m.index, end: m.index + m[0].length });
  });
  timed('credential_request', (push) => runPatterns(folded, text, CREDENTIAL_PATTERNS, push));
  timed('payment_request', (push) => {
    runPatterns(folded, text, PAYMENT_PATTERNS, push);
    WALLET_RE.lastIndex = 0;
    for (const m of text.matchAll(WALLET_RE)) {
      const around = text.slice(Math.max(0, m.index - 160), Math.min(text.length, m.index + m[0].length + 160));
      if (PAY_WORDS_RE.test(buildView(around, { fold: true }).text)) push('wallet address with send/approve wording', { start: m.index, end: m.index + m[0].length });
    }
  });
  timed('data_exfiltration', (push) => runPatterns(folded, text, EXFIL_PATTERNS, push));
  return { findings, urls: extractUrls(text), timings };
}

// --- URLs ------------------------------------------------------------------------------

const URL_RE = /\b(?:(?:https?|hxxps?|javascript|vbscript|data|file):[^\s<>"'`)\]]+|www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"'`)\]]*)/gi;
const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'ow.ly', 'cutt.ly', 'rb.gy', 'shorturl.at', 'tiny.cc', 'buff.ly', 'rebrand.ly', 'v.gd', 's.id', 't.ly']);

// Each URL in the text: { url, start, end, host, local: [labels] }.
export function extractUrls(text) {
  const out = [];
  for (const m of String(text || '').matchAll(URL_RE)) {
    let raw = m[0].replace(/[.,;:!?]+$/, '');
    const start = m.index;
    const end = start + raw.length;
    const local = [];
    let host = null;
    const scheme = (/^([a-z]+):/i.exec(raw) || [])[1];
    if (scheme && /^(?:javascript|vbscript|data|file)$/i.test(scheme)) {
      if (/^data:/i.test(raw) && !/^data:text\/html|^data:application\/(?:x-)?javascript|base64,/i.test(raw)) continue; // a plain data: label in prose
      local.push(`${scheme.toLowerCase()}: link`);
    } else {
      if (/^hxxps?:/i.test(raw)) { local.push('defanged link'); raw = raw.replace(/^hxxp/i, 'http'); }
      try {
        const u = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw);
        host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
        if (u.username || u.password) local.push('credentials or a misleading @ in the link');
        if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) local.push('raw IP address');
        if (/(?:^|\.)xn--/.test(host)) local.push('punycode host');
        if (SHORTENERS.has(host)) local.push('link shortener hides the destination');
        if (u.port && !['80', '443'].includes(u.port)) local.push(`unusual port ${u.port}`);
      } catch (e) {
        continue;
      }
    }
    out.push({ url: raw, start, end, host, local });
  }
  return out;
}

const isIp = (h) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || String(h).includes(':');

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { timedOut: true })), ms); })
  ]).finally(() => clearTimeout(timer));
}

// PG1's own hostname reputation (phishing list, look-alikes) and domain age
// for each distinct host, in parallel. Returns { flagged: Map(host ->
// [labels]), checks: { reputation, domain_age } as 'ok'|'timeout'|'error'|'skipped' }.
async function checkHosts(hosts, runTool, { timeoutMs = URL_CHECK_TIMEOUT_MS } = {}) {
  const flagged = new Map();
  const results = { reputation: [], domain_age: [] };
  const note = (host, label) => { if (!flagged.has(host)) flagged.set(host, []); flagged.get(host).push(label); };
  await Promise.all(hosts.flatMap((host) => [
    withTimeout(Promise.resolve().then(() => runTool('check_hostname_reputation', { hostname: host })), timeoutMs).then((r) => {
      results.reputation.push(r && r.status === 'unknown' ? 'error' : 'ok');
      const codes = (r && Array.isArray(r.reasons) ? r.reasons : []).map((x) => x.code);
      if (codes.includes('HOSTNAME_PHISHING_LISTED')) note(host, 'on the phishing list');
      if (codes.includes('HOSTNAME_LOOKALIKE')) note(host, 'a look-alike of a known brand domain');
    }, (e) => { results.reputation.push(e && e.timedOut ? 'timeout' : 'error'); }),
    withTimeout(Promise.resolve().then(() => runTool('check_domain_age', { domain: host })), timeoutMs).then((r) => {
      results.domain_age.push(r && r.status === 'unknown' ? 'error' : 'ok');
      const codes = (r && Array.isArray(r.reasons) ? r.reasons : []).map((x) => x.code);
      if (codes.includes('DOMAIN_NEWLY_REGISTERED_30D')) note(host, 'registered fewer than 30 days ago');
    }, (e) => { results.domain_age.push(e && e.timedOut ? 'timeout' : 'error'); })
  ]));
  const worst = (list) => (!list.length ? 'skipped' : list.includes('error') ? 'error' : list.includes('timeout') ? 'timeout' : 'ok');
  return { flagged, checks: { reputation: worst(results.reputation), domain_age: worst(results.domain_age) } };
}

// --- risk ------------------------------------------------------------------------------

const BASE_RISK = { instruction_override: 2, role_impersonation: 2, credential_request: 2, data_exfiltration: 2, tool_call_markup: 1, embedded_command: 1, hidden_text: 1, payment_request: 1, suspicious_url: 1 };
const RAISED_BY = {
  payment_request: ['payments', 'wallet'],
  credential_request: ['payments', 'wallet', 'shell', 'files', 'code'],
  embedded_command: ['shell', 'code', 'database', 'files'],
  tool_call_markup: ['shell', 'code', 'payments', 'wallet', 'email', 'messaging', 'database', 'files', 'network', 'browser'],
  data_exfiltration: ['email', 'network', 'browser', 'messaging', 'files'],
  suspicious_url: ['browser', 'network', 'payments', 'wallet'],
  hidden_text: [],
  instruction_override: [],
  role_impersonation: []
};

// low | medium | high from the detectors that fired and what the receiver
// can do: each finding has a base level (1 medium, 2 high), raised one
// level when the receiver has a capability it could abuse; three or more
// kinds of finding together are high. No finding: low, or medium when a
// check did not complete (status unknown).
export function riskOf(detectors, capabilities = [], status = 'no_flags') {
  if (!detectors.length) return status === 'unknown' ? 'medium' : 'low';
  let level = 0;
  for (const d of detectors) {
    const raised = (RAISED_BY[d] || []).some((c) => capabilities.includes(c));
    level = Math.max(level, Math.min(2, (BASE_RISK[d] || 1) + (raised ? 1 : 0)));
  }
  if (new Set(detectors).size >= 3) level = 2;
  return RISK_LEVELS[level];
}

// --- the tool --------------------------------------------------------------------------

export const MAX_REASONS_PER_CODE = 5;
const DETAIL = {
  instruction_override: (l) => `Text that tells the receiving agent to drop its instructions (${l.replace(/^override /, '').replace(/[()]/g, '')}).`,
  embedded_command: (l) => `An embedded command: ${l}.`,
  tool_call_markup: (l) => `Tool-call markup the receiving agent could mistake for its own: ${l}.`,
  role_impersonation: (l) => `A fake system, developer or operator message: ${l}.`,
  hidden_text: (l) => `Hidden text: ${l}.`,
  credential_request: () => 'Asks for a key, password, token, seed phrase or other secret.',
  payment_request: (l) => `A payment request: ${l}.`,
  data_exfiltration: (l) => `Asks to send data out: ${l}.`,
  suspicious_url: (l) => `A suspicious link: ${l}.`
};

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

const LOG_FIELDS = Symbol('pg1.agentMessage.log');

// One check. ctx.runTool(name, args) runs PG1's own hostname/domain checks
// (api/mcp.mjs internalRunTool); without it the URL checks are "skipped"
// and a message with URLs is unknown unless something flagged.
export async function checkAgentMessage(rawArgs, { runTool = null, now = () => Date.now(), urlTimeoutMs = URL_CHECK_TIMEOUT_MS } = {}) {
  const startedAt = now();
  const input = normalizeAgentMessageInput(rawArgs);
  const { findings, urls, timings } = scanAgentMessage(input.message, { now });

  // suspicious_url: local shape checks, then PG1's own lookups per host.
  const t0 = now();
  const sourceUrl = input.source && /^(?:https?:\/\/|www\.)/i.test(input.source) ? extractUrls(input.source)[0] : null;
  const allUrls = sourceUrl ? [...urls, { ...sourceUrl, fromSource: true }] : urls;
  for (const u of allUrls) for (const label of u.local) findings.suspicious_url.push({ label: u.fromSource ? `the source URL: ${label}` : label, span: u.fromSource ? null : { start: u.start, end: u.end } });
  const hosts = [...new Set(allUrls.map((u) => u.host).filter((h) => h && !isIp(h) && h.includes('.')))].slice(0, MAX_URLS_CHECKED);
  let urlChecks = { reputation: 'skipped', domain_age: 'skipped' };
  if (hosts.length && typeof runTool === 'function') {
    const res = await checkHosts(hosts, runTool, { timeoutMs: urlTimeoutMs });
    urlChecks = res.checks;
    for (const [host, labels] of res.flagged) {
      const at = allUrls.find((u) => u.host === host);
      findings.suspicious_url.push({ label: `${host}: ${labels.join(', ')}`, span: at && !at.fromSource ? { start: at.start, end: at.end } : null });
    }
  }
  timings.suspicious_url = Math.max(0, now() - t0);

  const reasons = [];
  for (const d of MESSAGE_DETECTORS) {
    for (const f of findings[d].slice(0, MAX_REASONS_PER_CODE)) {
      const r = reason(d.toUpperCase());
      reasons.push({ code: r.code, message: r.message, detail: DETAIL[d](f.label), span: f.span });
    }
  }
  const checkedAt = new Date(now()).toISOString();
  const checks = MESSAGE_DETECTORS.filter((d) => d !== 'suspicious_url').map((d) => detectorCheck(d, 'ok', timings[d], checkedAt));
  // The URL lookups count only when the message has a host to look up.
  const urlStatus = !hosts.length ? 'ok' : urlChecks.reputation === 'ok' && urlChecks.domain_age === 'ok' ? 'ok' : [urlChecks.reputation, urlChecks.domain_age].find((s) => s !== 'ok');
  checks.push(detectorCheck('suspicious_url', urlStatus, timings.suspicious_url, checkedAt));

  const status = computeStatus(reasons, checks);
  const fired = [...new Set(reasons.map((r) => r.code.toLowerCase()))];
  const result = {
    status,
    risk: riskOf(fired, input.receiver_capabilities, status),
    reasons,
    checks,
    message_bytes: input.bytes,
    urls_found: urls.length + (sourceUrl ? 1 : 0),
    hosts_checked: hosts.length && typeof runTool === 'function' ? hosts.length : 0,
    receiver_capabilities: input.receiver_capabilities,
    rule_based: true,
    note: 'Rule-based check: no_flags means none of these patterns were found, never a guarantee that the message is harmless.',
    request_id: null
  };
  Object.defineProperty(result, LOG_FIELDS, { value: { bytes: input.bytes, sha256: sha256(input.message), ms: Math.max(0, now() - startedAt), timings }, enumerable: false });
  return result;
}

function detectorCheck(name, status, ms, checkedAt) {
  return { name, status, ms: Math.round(ms || 0), ...buildCheck(name === 'suspicious_url' ? 'PG1 URL checks' : 'PG1 message rules', status, { checkedAt }) };
}

// The one log line per call: never the message, its source or a span's text.
export function agentMessageLogLine(result, requestId) {
  const f = (result && result[LOG_FIELDS]) || {};
  return JSON.stringify({
    event: 'check_agent_message',
    request_id: requestId || (result && result.request_id) || null,
    bytes: f.bytes ?? (result && result.message_bytes) ?? null,
    sha256: f.sha256 || null,
    codes: [...new Set(((result && result.reasons) || []).map((r) => r.code))],
    status: result && result.status,
    ms: f.ms ?? null,
    timings_ms: f.timings ? Object.fromEntries(Object.entries(f.timings).map(([k, v]) => [k, Math.round(v)])) : null
  });
}
export function logAgentMessageCheck(result, requestId, log = console.info) {
  try { log(`[check_agent_message] ${agentMessageLogLine(result, requestId)}`); } catch (e) { /* logging never breaks a result */ }
}

// The compact view the chat's relay bubble shows: status, risk, codes.
export function relayCheckView(result) {
  if (!result || !result.status) return null;
  return {
    status: result.status,
    risk: RISK_LEVELS.includes(result.risk) ? result.risk : 'medium',
    codes: [...new Set((result.reasons || []).map((r) => r.code).filter((c) => MESSAGE_REASON_CODES.includes(c)))]
  };
}

// The Core State event for a relayed message's check: status, risk and
// codes from the frozen lists only, never any of the relayed text.
export function messageCheckEvent(v, { relayed = true } = {}) {
  if (!v || !['no_flags', 'flagged', 'unknown'].includes(v.status)) return null;
  const codes = (v.codes || []).filter((c) => MESSAGE_REASON_CODES.includes(c));
  const risk = RISK_LEVELS.includes(v.risk) ? v.risk : 'medium';
  return {
    kind: 'agent_message_check',
    severity: v.status === 'flagged' ? (risk === 'high' ? 'error' : 'warning') : 'info',
    summary: `${relayed ? 'Relayed message' : 'Agent message'} checked: ${v.status}, risk ${risk}${codes.length ? `; codes ${codes.join(', ')}` : ''}`,
    ref: codes.length ? codes.join(',').slice(0, 120) : null
  };
}

export function isMessageReasonCode(code) {
  return MESSAGE_REASON_CODES.includes(code) && code in REASON_CODES;
}
