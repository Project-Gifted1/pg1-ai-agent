// Live progress trace for /api/chat (Server-Sent Events).
//
// The client asks for a stream with `stream: true` in the request body. Only
// an authenticated chat request is ever streamed; everything else (401s,
// AUTH_VERIFY, the /smoke test, callers that never ask) keeps the plain JSON
// reply, and the client treats any non-event-stream response as that JSON.
//
// Wire format, one JSON object per SSE `data:` line, `type` repeated as the
// SSE event name:
//   step       { id, label }                      a real action has started
//   step_done  { id, label, result, ms, details?, failed? }
//                                                 that action finished; `ms`
//                                                 is how long it ran on the
//                                                 server (the client shows
//                                                 this, never its own clock)
//   text       { text }                           a chunk of the reply
//   audio      { seq, sentence, data, encoding, sample_rate }
//                                                 a chunk of spoken reply
//                                                 (base64 PCM, lib/voiceStream.mjs)
//   audio_end  { ok, chunks, sentences, reason? } no more audio for this reply
//   tool_result { id, tool, title, subject, status, fields, reasons, checks,
//                 request_id, ms, raw, ... }      one finished threat-intel
//                                                 check (lib/chatTools.mjs
//                                                 summarizeOutcome); the
//                                                 client draws a card from it
//   done       { request_id, result? }            the reply is complete
//   error      { message, request_id, partial }   the request failed
//
// A step is only ever emitted by the code path that is about to do the thing
// it names (see api/chat.mjs). Every label, result and detail line goes
// through redactTraceText() first: the same secret patterns and deployment
// env values Send to Code strips (lib/handoff.mjs), plus a length cap. No
// step ever carries a system prompt, memory contents or model thinking.

import { stripSecrets } from './handoff.mjs';
import { PG1_IDENTITY_REPLY } from './identity.mjs';

export const STREAM_EVENT_TYPES = Object.freeze(['step', 'step_done', 'text', 'audio', 'audio_end', 'tool_result', 'done', 'error']);

const MAX_LABEL_LEN = 80;
const MAX_RESULT_LEN = 80;
const MAX_DETAIL_LEN = 160;
const MAX_DETAILS = 8;
const PUBLIC = { publicData: true };

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

// `publicData` (the live trace and result cards) leaves out the generic
// "long token" heuristic, which would also take a base64 IOC payload or a
// Solana address; provider key formats, JWTs, private keys and the
// deployment's own env values are still removed. The error log keeps the
// full set (lib/upstreamFailure.mjs).
export const PUBLIC_DATA_SKIP = Object.freeze(['long token']);

export function redactTraceText(value, envValues = [], max = MAX_DETAIL_LEN, { publicData = false } = {}) {
  if (value == null) return '';
  const flat = String(value).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const { text } = stripSecrets(flat, { envValues, skip: publicData ? PUBLIC_DATA_SKIP : [] });
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// The identity guard api/chat.mjs has always applied to a finished reply.
//
// Any sentence in which the model describes what powers it (naming a vendor
// or model, denying one, or claiming a model of PG1's own) is replaced whole
// by the identity reply chosen for this request (lib/identity.mjs: reply A,
// or reply B once the conversation has pressed IDENTITY_PRESS_THRESHOLD
// times), PG1_IDENTITY_REPLY when none is given. Replacing the sentence, rather
// than the name inside it, is what keeps the guard from ever producing a
// denial or an in-house claim: "I am not Gemini" or "I'm powered by Google"
// rewritten word by word would become "I am not PG1" or "I'm powered by
// PG1", which say exactly what PG1 must never say. A bare "No." or "Yes."
// right before such a sentence goes with it, so an answer never reads as a
// denial or confirmation. Fenced code blocks are left alone: a patch
// proposal quoting source that mentions a model name is not PG1 speaking
// about itself. Third-party names elsewhere (news, products) are untouched.

const NAMED_VENDORS = [
  'Google\\s+(?:Gemini|DeepMind|AI)', 'Gemini', 'Google', 'Anthropic', 'Claude', 'OpenAI', 'ChatGPT', 'GPT(?:-?\\d[\\w.-]*)?',
  'Meta\\s+AI', 'Llama', 'Mistral', 'DeepSeek', 'Grok', 'xAI', 'Copilot', 'Bard', 'PaLM', 'Vertex\\s+AI', 'Bedrock', 'Azure\\s+OpenAI',
  // the voice and image engines are covered too (lib/identity.mjs)
  'Cartesia', 'Sonic(?:[\\s-]?\\d[\\w.-]*)?', 'ElevenLabs', 'Replicate', 'Flux', 'Black\\s+Forest\\s+Labs', 'Imagen', 'Nano\\s+Banana', 'Veo(?:[\\s-]?\\d[\\w.-]*)?',
  'Midjourney', 'DALL[-·]?E(?:\\s*\\d)?', 'Stable\\s+Diffusion', 'Stability\\s+AI', 'Pollinations'
];
const VENDOR = [
  ...NAMED_VENDORS,
  // a denial of any outside model is a denial too
  '(?:third-?party|external|outside|commercial|big-?tech|cloud|foreign)\\s+(?:AI\\s+|language\\s+)?(?:models?|LLMs?|APIs?|providers?|vendors?|services?|companies|labs?|AI)',
  // ...and so is claiming a model of PG1's own
  "(?:(?:(?:Project-?Gifted1'?s|PG1'?s|our|my|its)\\s+own|in-?house|proprietary|custom(?:-?built)?|home-?grown|home-?built|self-?built|self-?trained|self-?hosted|independent|private|internal)\\s+)+(?:AI\\s+|language\\s+|large\\s+language\\s+|neural\\s+)?(?:models?|LLMs?|engine|neural\\s+network|brain|AI)",
  '(?:entirely\\s+|completely\\s+|fully\\s+)?(?:from\\s+scratch|from\\s+the\\s+ground\\s+up)'
].join('|');

const ARTICLE = '(?:(?:a|an|the|any|some|one\\s+of)\\s+)?';
const ADVERB = '(?:(?:actually|really|just|currently|simply|essentially|basically|still|technically|ultimately|entirely|completely|fully|only|also|now)\\s+)?';
const NOT = '(?:(?:not|neither|no\\s+longer|never)\\s+)?';
const NOUN = '(?:(?:large\\s+)?language\\s+model|LLM|AI(?:\\s+(?:model|assistant|system|agent|chatbot))?|model|assistant|chatbot|bot|agent|version|instance|wrapper|front-?end|interface|product|service|system|variant|flavou?r)';
const VIA = '(?:by|from|of|called|named|known\\s+as|made\\s+by|built\\s+by|developed\\s+by|trained\\s+by|created\\s+by|powered\\s+by|based\\s+on|running\\s+on|built\\s+on|on\\s+top\\s+of|hosted\\s+by|operated\\s+by|like|such\\s+as)';
const BUILT = '(?:powered|built|based|running|made|created|developed|trained|hosted|backed|fine-?tuned|wrapped|operated)(?:\\s+(?:by|on|upon|around|with|from))?';
// What follows "I am": an optional noun phrase or participle, then the name.
const COMPLEMENT = `${ADVERB}${ARTICLE}(?:${BUILT}\\s+|${NOUN}\\s+(?:${VIA}\\s+)?|(?:from|by|of|with|on|affiliated\\s+with|associated\\s+with|related\\s+to|connected\\s+to|part\\s+of|owned\\s+by|under)\\s+)?${ARTICLE}`;

// PG1's voice and images: "my voice is Cartesia", "PG1's text-to-speech
// comes from ...", "the images here are made by ...".
const MEDIA = '(?:voices?|speech|text-to-speech|TTS|read-?aloud|audio|images?|image\\s+generation|pictures?)';
const MEDIA_OWN = `(?:(?:my|PG1['’]?s|our)\\s+${MEDIA}|the\\s+${MEDIA}\\s+(?:here|in\\s+(?:this\\s+(?:chat|app)|PG1)))`;
const MEDIA_NOUN = '(?:engine|provider|vendor|model|service|backend|back-end|API|tech|technology)';
const SELF_BE = `(?:I\\s+am|I'm|I’m|I\\s+was|I've\\s+been|I’ve\\s+been|I\\s+have\\s+been|PG1\\s+is|PG1\\s+was|this\\s+(?:assistant|chat|app|bot)\\s+is|you\\s+are\\s+(?:talking|speaking|chatting)\\s+(?:to|with)|you're\\s+(?:talking|speaking|chatting)\\s+(?:to|with)|you’re\\s+(?:talking|speaking|chatting)\\s+(?:to|with)|under\\s+the\\s+hood,?\\s+(?:I'm|I’m|I\\s+am|it's|it’s|it\\s+is|PG1\\s+is)|(?:my|the)\\s+(?:underlying\\s+|base\\s+|core\\s+|actual\\s+|real\\s+)?(?:model|LLM|engine|AI|brain|core|backend|back-end|provider|vendor)\\s+(?:behind|powering|under|underneath|inside|running)\\s+(?:me|PG1|this\\s+(?:chat|assistant|app))\\s+(?:is|was|comes\\s+from)|my\\s+(?:underlying\\s+|base\\s+|core\\s+|actual\\s+|real\\s+)?(?:model|LLM|engine|AI|brain|core|backend|back-end|provider|vendor)\\s+(?:is|was|comes\\s+from|is\\s+from|is\\s+called|is\\s+made\\s+by|is\\s+built\\s+by)|the\\s+underlying\\s+(?:model|LLM|engine|AI|provider)\\s+(?:here\\s+)?(?:is|was)|${MEDIA_OWN}\\s+(?:${MEDIA_NOUN}\\s+)?(?:is|are|was|were|comes\\s+from|come\\s+from|is\\s+from|are\\s+from))`;
const SELF_DO = "(?:I|PG1|we)\\s+(?:(?:do\\s+not|don't|don’t|did\\s+not|didn't|didn’t|never|no\\s+longer|currently|actually|really|just|simply|only|also)\\s+)?(?:use|uses|used|using|run|runs|ran|run\\s+on|runs\\s+on|ran\\s+on|rely\\s+on|relies\\s+on|relied\\s+on|call|calls|called|query|queries|talk\\s+to|talks\\s+to|connect\\s+to|connects\\s+to|depend\\s+on|depends\\s+on|sit\\s+on\\s+top\\s+of|sits\\s+on\\s+top\\s+of|wrap|wraps|route\\s+to|routes\\s+to|forward\\s+to|forwards\\s+to|come\\s+from|comes\\s+from|belong\\s+to|belongs\\s+to|work\\s+for|works\\s+for|was\\s+built\\s+from|were\\s+built\\s+from)";
// "I have API keys for Cartesia and Replicate", "my keys are from Google":
// naming who PG1 holds keys or accounts with names what powers it.
const SELF_KEYS = "(?:(?:I|PG1|we)\\s+(?:(?:currently|actually|also|only|just)\\s+)?(?:have|has|hold|holds|keep|keeps|store|stores|use|uses|got|'ve\\s+got|’ve\\s+got)\\s+(?:(?:an?|the|some|several|two|three|multiple)\\s+)?(?:API\\s+)?(?:keys?|tokens?|accounts?|credentials?|subscriptions?)\\s+(?:for|with|from|to|at|on)|(?:my|PG1['’]?s|our)\\s+(?:API\\s+)?(?:keys?|tokens?|accounts?|credentials?)\\s+(?:is|are|was|were)\\s+(?:for|from|with|on|at))";
const SELF_HAVE = "(?:I|PG1|we)\\s+(?:have|has|'ve|’ve|had)\\s+(?:no\\s+(?:connection|relation|relationship|link|links|ties|tie|affiliation|association|involvement|dealings)\\s+(?:to|with)|nothing\\s+to\\s+do\\s+with|(?:not|never)\\s+been\\s+(?:built|trained|made|created|developed|powered|backed)\\s+(?:by|on|with))";

// "Is that your own model?" answered with a yes in any wording: "it's our
// own model", "PG1 Sovereign Core is a proprietary LLM", "we trained our own
// model". Only the in-house shapes count here, so "it's an OpenAI product"
// in a news answer is left alone.
const IN_HOUSE_ONLY = "(?:(?:(?:Project-?Gifted1'?s|PG1'?s|our|my|its)\\s+own|in-?house|proprietary|custom(?:-?built)?|home-?grown|home-?built|self-?built|self-?trained)\\s+)+(?:AI\\s+|language\\s+|large\\s+language\\s+|neural\\s+)?(?:models?|LLMs?|neural\\s+network|AI)";
const SELF_IT = "(?:(?:it|that|this|the\\s+(?:engine|core|model))\\s+(?:is|was)|it's|it’s|that's|that’s|(?:PG1\\s+)?Sovereign\\s+Core\\s+(?:engine\\s+)?(?:is|was))";
const SELF_TRAINED = "(?:I|we|PG1|Project-?Gifted1)\\s+(?:(?:actually|really|just|also)\\s+)?(?:trained|built|developed|created|made|wrote)\\s+(?:(?:my|our|its|a|the)\\s+)?(?:own\\s+)?(?:AI\\s+|language\\s+|large\\s+language\\s+)?(?:models?|LLMs?)(?:\\s+(?:ourselves|myself|itself|in-?house|from\\s+scratch))?";

// The name first: "Google made me", "Gemini is what powers PG1".
const VENDOR_FIRST = `(?:${VENDOR})(?:'s|’s)?(?:\\s+(?:model|models|LLM|AI|engine|tech|technology|team))?\\s+(?:(?:made|built|trained|created|developed|powers?|runs?|hosts?|owns?|operates?|backs?|drives?)\\s+|(?:is|are|was|were)\\s+(?:not\\s+)?(?:what\\s+)?(?:behind|powering|running|driving|inside|under|underneath|the\\s+model\\s+behind|the\\s+engine\\s+behind|what\\s+powers|what\\s+runs)\\s+)(?:me|PG1|this\\s+(?:chat|assistant|app|bot)|${MEDIA_OWN})\\b`;

export const IDENTITY_CLAIM_RE = new RegExp(
  `\\b(?:(?:${SELF_BE}\\s+${NOT}${COMPLEMENT}|${SELF_DO}\\s+${ARTICLE}(?:${NOUN}s?\\s+(?:${VIA}\\s+)?)?${ARTICLE}|${SELF_HAVE}\\s+${ARTICLE}|${SELF_KEYS}\\s+${ARTICLE})(?:${VENDOR})(?:'s|’s)?\\b|${VENDOR_FIRST}|(?<inHouse>${SELF_IT}\\s+${NOT}${ADVERB}${ARTICLE}${IN_HOUSE_ONLY})\\b|${SELF_TRAINED}\\b)`,
  'gi'
);

// "It is a proprietary model" is a yes to "is that your own model?" only
// when "it" is PG1. In a factual answer about a third-party model ("Gemini
// is Google's family of LLMs. It is a proprietary model developed by
// Google.") "it" is that model, and the sentence must stand. So the bare
// pronoun form is left alone when a named third party is its referent:
// named earlier in the reply or in the same sentence, and not as a contrast
// ("unlike ChatGPT, it's our..."). A claim of PG1's or our own model, or
// one about Sovereign Core, is always a claim.
const NAMED_VENDOR_RE = new RegExp(`(?<!\\b(?:unlike|not|than|instead\\s+of|rather\\s+than|other\\s+than)\\s+)\\b(?:${NAMED_VENDORS.join('|')})(?:'s|’s)?\\b`, 'i');
const OWN_RE = /\b(?:(?:Project-?Gifted1|PG1)['’]?s|our|my)\s+own\b|Sovereign\s+Core/i;

function aboutThirdParty(context, claim) {
  return !OWN_RE.test(claim) && NAMED_VENDOR_RE.test(context);
}

// A short stand-alone answer right before a claim ("No.", "Yes!", "Not at
// all.") is swallowed with it, so the rewrite never leaves a bare denial or
// confirmation standing.
const YES_NO_RE = /(?:^|(?<=\n)|(?<=[.!?]["')\]]*\s))\s*(?:no|nope|nah|yes|yeah|yep|correct|right|that's\s+right|that’s\s+right|absolutely|absolutely\s+not|not\s+at\s+all|definitely|definitely\s+not|of\s+course|of\s+course\s+not|indeed|sure|exactly|negative|affirmative)[.!,;:]*\s*$/i;

const FENCE_RE = /(^|\n)[ \t]*(```|~~~)/g;
const LEAD_RE = /^(\s*(?:[-*•>]|\d+[.)])?\s*)/;

function isTerminator(text, i, atEnd) {
  if (text[i] === '\n') return true;
  if (!/[.!?]/.test(text[i])) return false;
  let j = i;
  while (j < text.length && /[.!?]/.test(text[j])) j++;
  while (j < text.length && /["')\]]/.test(text[j])) j++;
  if (j >= text.length) return atEnd;
  return /\s/.test(text[j]);
}

// [start, end) of the sentence around the match at [from, to). The end is
// the next terminator (or the text end only when `atEnd`, i.e. the text is
// final); null if the sentence has not ended yet.
function sentenceBounds(text, from, to, atEnd) {
  let start = from;
  while (start > 0) {
    const c = text[start - 1];
    if (c === '\n') break;
    if (/\s/.test(c) && start >= 2 && /[.!?"')\]]/.test(text[start - 2])) {
      let k = start - 2;
      while (k >= 0 && /["')\]]/.test(text[k])) k--;
      if (k >= 0 && /[.!?]/.test(text[k])) break;
    }
    start--;
  }
  let end = to;
  while (end < text.length && !isTerminator(text, end, atEnd)) end++;
  if (end >= text.length && !atEnd) return null;
  if (end < text.length && text[end] !== '\n') {
    while (end < text.length && /[.!?]/.test(text[end])) end++;
    while (end < text.length && /["')\]]/.test(text[end])) end++;
  }
  return { start, end };
}

// Fenced code block spans of `text`; `inFence` says whether it opens inside one.
function fenceSpans(text, inFence) {
  const spans = [];
  let open = inFence ? 0 : -1;
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(text))) {
    if (open === -1) open = m.index;
    else { spans.push([open, m.index + m[0].length]); open = -1; }
  }
  if (open !== -1) spans.push([open, text.length]);
  return spans;
}

const inSpans = (spans, i) => spans.some(([a, b]) => i >= a && i < b);

// `before` is reply text already released ahead of `text` (the streamed
// path), so a model named there still counts as the referent. While a
// sentence is still open (`atEnd` false) its match is kept, which only holds
// the text back until the sentence ends.
function claimsIn(text, inFence, { before = '', atEnd = true } = {}) {
  const spans = fenceSpans(text, inFence);
  const out = [];
  // A sentence that is itself a claim ("I'm not ChatGPT or Gemini.") names
  // no referent: it is rewritten, so the name in it does not count.
  let context = before;
  let seen = 0;
  IDENTITY_CLAIM_RE.lastIndex = 0;
  let m;
  while ((m = IDENTITY_CLAIM_RE.exec(text))) {
    if (inSpans(spans, m.index)) continue;
    const from = m.index, to = m.index + m[0].length;
    const b = sentenceBounds(text, from, to, atEnd);
    if (m.groups.inHouse && b && aboutThirdParty(context + text.slice(seen, b.end), m[0])) continue;
    out.push({ from, to });
    if (b && b.start >= seen) { context += text.slice(seen, b.start); seen = b.end; }
  }
  return out;
}

// True when `text` (a streamed reply so far) holds a claim whose sentence
// has not ended yet, so the rest of it is still to come.
export function hasOpenClaim(text, { inFence = false, before = '' } = {}) {
  const claims = claimsIn(String(text), inFence, { before, atEnd: false });
  if (!claims.length) return false;
  const last = claims[claims.length - 1];
  return sentenceBounds(String(text), last.from, last.to, false) === null;
}

export function scrubIdentity(text, { inFence = false, replacement = PG1_IDENTITY_REPLY, before = '' } = {}) {
  const src = String(text);
  const claims = claimsIn(src, inFence, { before });
  if (!claims.length) return src;
  const cuts = [];
  for (const c of claims) {
    const b = sentenceBounds(src, c.from, c.to, true);
    let { start } = b;
    const { end } = b;
    const prev = cuts.length ? cuts[cuts.length - 1] : null;
    if (prev && start < prev.end) { prev.end = Math.max(prev.end, end); continue; }
    // Swallow a bare yes/no sentence standing right before the claim.
    const before = src.slice(prev ? prev.end : 0, start);
    const yn = before.match(YES_NO_RE);
    if (yn) start -= yn[0].length;
    cuts.push({ start, end });
  }
  let out = '';
  let pos = 0;
  for (const { start, end } of cuts) {
    const lead = src.slice(start, end).match(LEAD_RE)[1];
    out += src.slice(pos, start) + lead + replacement;
    pos = end;
  }
  out += src.slice(pos);
  // Two rewritten sentences in a row read once.
  const line = replacement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return out.replace(new RegExp(`(${line})(?:\\s+${line})+`, 'g'), '$1');
}

// TRANSCRIPT ECHO GUARD. The recent conversation goes to the model under
// [CONTEXT] as "OPERATOR: …" / "AGENT: …" lines (api/chat.mjs), and a reply
// has been seen that simply carried those lines on, label and all. A line
// the model starts with OPERATOR: is the operator's own words played back,
// never PG1 speaking, so it is dropped; an AGENT: label is removed and the
// sentence kept. Fenced code is left alone. `lineStart` says whether the
// text begins at the start of a line (true for a whole reply).
const TRANSCRIPT_LINE_RE = /(^|\n)([ \t]*(?:[-*>]\s*)?)(?:\*\*|__)?(OPERATOR|AGENT)(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[ \t]*([^\n]*)/g;

export function stripTranscriptLabels(text, { lineStart = true, inFence = false } = {}) {
  const src = String(text);
  if (inFence || !/(?:OPERATOR|AGENT)(?:\*\*|__)?\s*:/.test(src)) return src;
  const out = src.replace(TRANSCRIPT_LINE_RE, (m, br, lead, label, rest, offset) => {
    if (offset === 0 && br === '' && !lineStart) return m;
    // The operator's line goes, newline and all.
    if (label === 'OPERATOR') return '';
    return `${br}${lead}${rest}`;
  });
  // A dropped first line leaves its successor's newline at the front.
  return out.startsWith('\n') && !src.startsWith('\n') ? out.slice(1) : out;
}

// Streams scrubIdentity() over chunks. The last HOLD characters are kept back
// until more text (or flush) arrives, so a claim split across two chunks
// ("I am Gem" + "ini") is still caught before any of it reaches the client;
// HOLD covers the longest lead-in ("you are talking to a large language
// model trained by") plus a name. A claim whose sentence has not ended yet is
// held back whole (up to OPEN_CLAIM_MAX characters), so the tail of that
// sentence (", a model made by Google") never follows the rewrite out.
const HOLD = 96;
const OPEN_CLAIM_MAX = 600;

// With `redact` set (a message that carried images, lib/visionInput.mjs),
// a credential is never split across two chunks: text is released only up
// to a whitespace boundary, a half-arrived token at the tail waits for the
// rest, a lead-in that announces a value (the word Bearer, or a label ending
// in a colon or equals sign, SPLIT_GUARD_RE) waits for that value, and an open
// PEM block is held whole. A single run of non-whitespace longer than this
// is released anyway, so a reply that is one long word still streams.
const REDACT_RUN_MAX = 2000;
const REDACT_PEM_MAX = 8000;
const SPLIT_GUARD_RE = /(?:\bBearer|[=:])\s*$/i;
const PEM_OPEN_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----(?![\s\S]*-----END [A-Z ]*PRIVATE KEY-----)/;
const PEM_FULL_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

// A complete PEM block has whitespace inside it, so a whitespace cut could
// land in the middle of one: the cut moves past the block so it is redacted
// whole (an open block never gets this far, see PEM_OPEN_RE).
function pastPemBlocks(text, cut) {
  PEM_FULL_RE.lastIndex = 0;
  let m;
  while ((m = PEM_FULL_RE.exec(text))) {
    const end = m.index + m[0].length;
    if (m.index < cut && end > cut) cut = end;
  }
  return cut;
}

// Where to cut `text` so that no token is split: the last whitespace in the
// first `limit` characters, moved back past a lead-in that wants its value.
function safeCut(text, limit) {
  let cut = -1;
  for (let i = Math.min(limit, text.length) - 1; i >= 0; i--) {
    if (/\s/.test(text[i])) { cut = i + 1; break; }
  }
  if (cut === -1) return text.length > REDACT_RUN_MAX ? limit : 0;
  let guard = 0;
  while (cut > 0 && SPLIT_GUARD_RE.test(text.slice(0, cut)) && guard++ < 4) {
    let back = cut - 1;
    while (back > 0 && /\s/.test(text[back - 1])) back--;
    while (back > 0 && !/\s/.test(text[back - 1])) back--;
    if (back === cut) break;
    cut = back;
  }
  return cut;
}

export function createReplyScrubber(emit, { redact = null, replacement = PG1_IDENTITY_REPLY } = {}) {
  let pending = '';
  let full = '';
  let fences = 0;
  let redacted = [];
  const release = (out) => {
    fences += (out.match(FENCE_RE) || []).length;
    full += out;
    emit(out);
  };
  const applyRedact = (text) => {
    if (!redact) return text;
    const r = redact(text);
    if (r && typeof r === 'object') {
      if (Array.isArray(r.removed)) r.removed.forEach((l) => { if (!redacted.includes(l)) redacted.push(l); });
      return typeof r.text === 'string' ? r.text : text;
    }
    return typeof r === 'string' ? r : text;
  };
  return {
    push(chunk) {
      if (!chunk) return;
      pending += chunk;
      const inFence = fences % 2 === 1;
      if (pending.length <= OPEN_CLAIM_MAX && hasOpenClaim(pending, { inFence, before: full })) return;
      pending = scrubIdentity(pending, { inFence, replacement, before: full });
      pending = stripTranscriptLabels(pending, { lineStart: full === '' || full.endsWith('\n'), inFence });
      if (pending.length > HOLD) {
        let cutAt = pending.length - HOLD;
        if (redact) {
          if (pending.length <= REDACT_PEM_MAX && PEM_OPEN_RE.test(pending)) return;
          cutAt = safeCut(pending, cutAt);
          if (cutAt <= 0) return;
          cutAt = pastPemBlocks(pending, cutAt);
          const head = applyRedact(pending.slice(0, cutAt));
          pending = pending.slice(cutAt);
          release(head);
          return;
        }
        const out = pending.slice(0, cutAt);
        pending = pending.slice(cutAt);
        release(out);
      }
    },
    flush() {
      if (!pending) return;
      const inFence = fences % 2 === 1;
      const out = applyRedact(stripTranscriptLabels(scrubIdentity(pending, { inFence, replacement, before: full }), { lineStart: full === '' || full.endsWith('\n'), inFence }));
      pending = '';
      release(out);
    },
    get text() { return full + pending; },
    // Labels of what the redaction took out, in order of first appearance.
    get redacted() { return redacted.slice(); }
  };
}

// Incremental SSE parser for upstream model streams (Gemini alt=sse,
// Anthropic messages stream). public/index.html has a twin, parseSseBuffer,
// for the browser side; tests/chat-stream.test.mjs runs both over the same
// input.
export function createSseParser(onEvent) {
  let buffer = '';
  const dispatch = (block) => {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      let value = idx === -1 ? '' : line.slice(idx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length) onEvent({ event, data: data.join('\n') });
  };
  return {
    push(chunk) {
      buffer += String(chunk).replace(/\r\n?/g, '\n');
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        dispatch(block);
      }
    },
    end() {
      if (buffer.trim()) dispatch(buffer);
      buffer = '';
    }
  };
}

// Reads a fetch() Response body as text chunks, feeding the SSE parser.
export async function readSseResponse(response, onEvent) {
  const parser = createSseParser(onEvent);
  if (!response.body || typeof response.body.getReader !== 'function') {
    parser.push(await response.text());
    parser.end();
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  parser.end();
}

export function wantsChatStream(reqBody) {
  return !!(reqBody && reqBody.stream === true);
}

const GITHUB_API_HOST = 'api.github.com';

// The SSE writer for one chat request.
// Monotonic where available, so a step's duration never goes negative when
// the wall clock is adjusted mid-request.
export function monotonicNow() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

export function createChatStream(res, { requestId, envValues = [], corsOrigin = '*', now = monotonicNow } = {}) {
  // id -> the clock reading when the step opened.
  const open = new Map();
  const finished = new Set();
  const emitted = [];
  let started = false;
  let ended = false;
  let clientGone = false;
  const abortController = new AbortController();
  // Network calls made through wrapFetch(), grouped into one step per host.
  const tracked = new Map();

  const write = (type, payload) => {
    if (ended || clientGone) return false;
    const body = { type, ...payload };
    emitted.push(body);
    res.write(`event: ${type}\ndata: ${JSON.stringify(body)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
    return true;
  };

  const redactLabel = (v) => redactTraceText(v, envValues, MAX_LABEL_LEN, PUBLIC);

  const stream = {
    requestId,
    signal: abortController.signal,
    get started() { return started; },
    get ended() { return ended; },
    get clientGone() { return clientGone; },
    // Everything written so far, for tests.
    get events() { return emitted.slice(); },

    start() {
      if (started) return;
      started = true;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      if (typeof res.on === 'function') {
        res.on('close', () => {
          if (!ended) {
            clientGone = true;
            abortController.abort();
          }
        });
      }
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      // An SSE comment, so any buffering proxy has something to pass on.
      res.write(': pg1 trace\n\n');
    },

    step(id, label) {
      if (open.has(id) || finished.has(id)) return false;
      open.set(id, now());
      return write('step', { id, label: redactLabel(label) });
    },

    // Only closes a step that was opened and is still running, so a
    // step_done can never appear for something that never started. `ms` is
    // measured here, between step() and stepDone(), so the duration shown
    // is the time the action really took on the server rather than when
    // its events happened to reach the browser.
    stepDone(id, { label, result, details, failed } = {}) {
      if (!open.has(id)) return false;
      const ms = Math.max(0, Math.round(now() - open.get(id)));
      open.delete(id);
      finished.add(id);
      const payload = { id, label: redactLabel(label), result: redactTraceText(result, envValues, MAX_RESULT_LEN, PUBLIC), ms };
      if (failed) payload.failed = true;
      if (Array.isArray(details) && details.length) {
        payload.details = details.slice(0, MAX_DETAILS).map((d) => redactTraceText(d, envValues, MAX_DETAIL_LEN, PUBLIC)).filter(Boolean);
        if (!payload.details.length) delete payload.details;
      }
      return write('step_done', payload);
    },

    isOpen(id) { return open.has(id); },

    text(chunk) {
      if (!chunk) return false;
      return write('text', { text: String(chunk) });
    },

    // Spoken-reply events (lib/voiceStream.mjs). Audio is never stored; it
    // only ever passes through this stream.
    audio(payload) {
      return write('audio', payload);
    },

    audioEnd(payload) {
      return write('audio_end', payload);
    },

    // One finished check's card data (lib/chatTools.mjs summarizeOutcome).
    // Tool results are PG1's own data, not the deployment's secrets, and the
    // card needs them whole; only the free-text fields go through the
    // redactor, as a backstop.
    toolResult(card) {
      if (!card || typeof card !== 'object') return false;
      const safe = { ...card };
      if (typeof safe.title === 'string') safe.title = redactTraceText(safe.title, envValues, MAX_LABEL_LEN, PUBLIC);
      if (safe.error && typeof safe.error.message === 'string') safe.error = { ...safe.error, message: redactTraceText(safe.error.message, envValues, 400, PUBLIC) };
      return write('tool_result', safe);
    },

    // Wraps fetch so the first real call to a tracked host opens a step and
    // the request count closes it when the reply is finished.
    wrapFetch(fetchImpl) {
      return function tracedFetch(url, options) {
        let host = '';
        try { host = new URL(String(url)).host; } catch (e) { host = ''; }
        if (host !== GITHUB_API_HOST) return fetchImpl(url, options);
        let entry = tracked.get('github');
        if (!entry) {
          entry = { calls: 0, failed: 0 };
          tracked.set('github', entry);
          stream.step('github', 'Calling GitHub');
        }
        entry.calls++;
        return Promise.resolve(fetchImpl(url, options)).then((r) => {
          if (!r || !r.ok) entry.failed++;
          return r;
        }, (err) => {
          entry.failed++;
          throw err;
        });
      };
    },

    closeTracked() {
      const gh = tracked.get('github');
      if (gh && open.has('github')) {
        const n = `${gh.calls} request${gh.calls === 1 ? '' : 's'}`;
        stream.stepDone('github', { label: 'Called GitHub', result: gh.failed ? `${n} · ${gh.failed} failed` : n, failed: gh.failed > 0 });
      }
    },

    // A step still open at the end (only possible if its code path threw)
    // is closed as not finished rather than left spinning.
    closeOpenSteps(result) {
      stream.closeTracked();
      for (const id of Array.from(open.keys())) {
        stream.stepDone(id, { label: 'Stopped', result, failed: true });
      }
    },

    done(extra = {}) {
      stream.closeOpenSteps('did not finish');
      write('done', { request_id: requestId, ...extra });
      stream.end();
    },

    error(message, { partial = false, status } = {}) {
      stream.closeOpenSteps('did not finish');
      const payload = { message: redactTraceText(message, envValues, 400, PUBLIC), request_id: requestId, partial: !!partial };
      if (status) payload.status = status;
      write('error', payload);
      stream.end();
    },

    // Turns one of api/chat.mjs's ordinary JSON replies into stream events,
    // so every early-return branch keeps working once a stream is open.
    finishWithJson(status, data) {
      const body = data && typeof data === 'object' ? data : {};
      if (status >= 400) {
        return stream.error(body.reply || body.error || `Request failed (${status})`, { status });
      }
      const { reply, traceId, ...rest } = body;
      if (typeof reply === 'string' && reply) stream.text(reply);
      stream.done(Object.keys(rest).length ? { result: rest } : {});
    },

    end() {
      if (ended) return;
      ended = true;
      if (!clientGone) res.end();
    }
  };
  return stream;
}
