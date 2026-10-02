// Low-latency spoken replies for /api/chat (PG1 voice, phase 1).
//
// When the client asks for a streamed reply with `speak: true` and voice is
// on, api/chat.mjs feeds the reply text (after the identity scrubber) into a
// voice stream from this module as it arrives:
//
//   reply text ─▶ sentence splitter ─▶ speech filter ─▶ TTS (one HTTP SSE
//   request per sentence, server-side key) ─▶ "audio" events on the chat
//   stream, numbered with `seq` so the client plays them strictly in order.
//
// Nothing here ever stores audio: the chunks go straight from the TTS
// response into the chat stream and are gone.
//
// Speech never reads out code blocks, full URLs, secrets or IDs. Each is
// replaced with a short spoken placeholder (SPEECH_PLACEHOLDERS) before any
// text leaves the server for synthesis. The secret patterns are the ones
// Send to Code strips (lib/handoff.mjs), plus the deployment's own secret
// env values.

import { stripSecrets } from './handoff.mjs';
import { readSseResponse } from './chatStream.mjs';

export const SPEECH_PLACEHOLDERS = Object.freeze({
  code: 'Code block shown on screen.',
  secret: 'a secret value',
  secretBlock: 'Secret value not read aloud.',
  table: 'Table shown on screen.',
  inlineCode: 'some code',
  id: 'an ID',
  requestId: 'a request ID',
  taskId: 'a task ID',
  more: 'The rest is on screen.'
});

// Raw 16-bit PCM keeps decoding on the phone trivial (no MP3 frame
// boundaries to worry about) and is half the size of float32.
export const VOICE_AUDIO_FORMAT = Object.freeze({ container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 });

// Same 3000-character cap the SPEAK action has always applied.
export const MAX_SPOKEN_CHARS = 3000;
// A sentence longer than this is cut at a clause or word boundary, so a
// long first sentence doesn't hold up the start of speech.
export const MAX_SENTENCE_CHARS = 240;

const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|approx|incl|fig)\.$/i;
const INITIAL = /(?:^|\s)[A-Z]\.$/;

// ---------------------------------------------------------------------------
// Speech text filter

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const URL_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`)\]]+/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TASK_ID_RE = /\bPG1-TASK-[A-Z0-9]+\b/gi;
// "request id: abc123", "trace_id=…", "Request ID k3j9x0ab", "x-request-id: …"
const REQUEST_ID_RE = /\b(?:x-)?(?:request|req|trace|correlation)[ _-]?id\b\s*[:=#]?\s*[`"']?(?=[A-Za-z0-9._:-]*\d)[A-Za-z0-9._:-]{4,}[`"']?/gi;
// req_…, msg_…, toolu_…, run_… style prefixed IDs.
const PREFIXED_ID_RE = /\b(?:req|msg|toolu|run|evt|ch|cus|pi|sess|session|trig|env|file|tx)_[A-Za-z0-9]{6,}\b/g;
// Hex runs (commit SHAs, hashes, wallet-ish values) of 12+ characters.
const HEX_ID_RE = /\b(?:0x)?[0-9a-f]{12,}\b/gi;
// Letter+digit runs of 10+ characters, e.g. a trace ID like k3j9x0ab12.
const MIXED_ID_RE = /\b(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{10,}\b/g;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function urlPlaceholder(url) {
  let host = '';
  try {
    host = new URL(/^www\./i.test(url) ? `https://${url}` : url).hostname;
  } catch (e) {
    host = '';
  }
  host = host.replace(/^www\./i, '');
  // An IP address or an odd host is as unhelpful to hear as the URL itself.
  if (!host || /^[\d.:]+$/.test(host) || host.length > 40) return 'a link';
  return `a link to ${host}`;
}

// One sentence (or block placeholder) to the text that is actually spoken.
// `envValues` are secretEnvValues(process.env) pairs; `knownIds` are values
// such as this request's trace ID that must never be spoken.
export function toSpeechText(input, { envValues = [], knownIds = [] } = {}) {
  let text = String(input == null ? '' : input).replace(CONTROL_CHARS, ' ');
  if (!text.trim()) return '';

  for (const id of knownIds) {
    if (id && String(id).length >= 4) text = text.replace(new RegExp(escapeRegExp(String(id)), 'g'), ` ${SPEECH_PLACEHOLDERS.id} `);
  }

  // Secrets first, on the raw text, so no later rewrite can break up a
  // value before it is recognised.
  text = stripSecrets(text, { envValues }).text;
  // Credentials inside a URL go with the rest of the URL below.
  text = text.replace(/:\/\/\[removed\]@/g, '://');

  // Markdown links and images: keep the words, drop the target.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (m, alt) => alt || 'an image');
  text = text.replace(/\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))*\)/g, '$1');
  text = text.replace(/<((?:https?:\/\/|www\.)[^>\s]+)>/gi, '$1');
  text = text.replace(URL_RE, (url) => ` ${urlPlaceholder(url.replace(/[.,;:!?]+$/, ''))} `);

  text = text.replace(/\[removed\]/g, ` ${SPEECH_PLACEHOLDERS.secret} `);
  // A "Bearer" left in front of a removed token reads oddly on its own.
  text = text.replace(new RegExp(`\\bBearer\\s+${escapeRegExp(SPEECH_PLACEHOLDERS.secret)}`, 'gi'), SPEECH_PLACEHOLDERS.secret);

  // Inline code: short plain words are spoken, anything longer is not.
  text = text.replace(/`([^`]*)`/g, (m, code) => {
    const c = code.trim();
    return /^[A-Za-z][A-Za-z0-9 .\-/]{0,23}$/.test(c) ? c : ` ${SPEECH_PLACEHOLDERS.inlineCode} `;
  });

  text = text.replace(TASK_ID_RE, ` ${SPEECH_PLACEHOLDERS.taskId} `);
  text = text.replace(REQUEST_ID_RE, ` ${SPEECH_PLACEHOLDERS.requestId} `);
  text = text.replace(UUID_RE, ` ${SPEECH_PLACEHOLDERS.id} `);
  text = text.replace(PREFIXED_ID_RE, ` ${SPEECH_PLACEHOLDERS.id} `);
  text = text.replace(HEX_ID_RE, (m) => (/^\d+$/.test(m) ? m : ` ${SPEECH_PLACEHOLDERS.id} `));
  text = text.replace(MIXED_ID_RE, (m) => {
    // Plain hyphenated words with a number ("x402-compatible", "sonic-3")
    // are fine to say; a dense run of letters and digits is not.
    const parts = m.split(/[-_]/);
    if (parts.length > 1 && !parts.some((p) => p.length >= 10 && /\d/.test(p) && /[A-Za-z]/.test(p))) return m;
    return ` ${SPEECH_PLACEHOLDERS.id} `;
  });

  // Markdown furniture that would otherwise be read as symbols.
  text = text
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/[*_#`|~^<>{}[\]\\]/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  // Only punctuation left (e.g. a horizontal rule) is nothing to say.
  if (!/[\p{L}\p{N}]/u.test(text)) return '';
  return text;
}

// ---------------------------------------------------------------------------
// Sentence splitter

function findSentenceEnd(text) {
  // A newline always ends a sentence (list items, headings, paragraphs).
  // Terminal punctuation ends one only when followed by whitespace, so
  // "3.5", "example.com" and "file.mjs" are never split.
  const re = /([.!?…]+)(["'”’)\]*_]*)(\s+)|\n/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[0] === '\n') return { end: m.index, next: m.index + 1 };
    const before = text.slice(0, m.index + m[1].length);
    if (m[1] === '.' && (ABBREVIATIONS.test(before) || INITIAL.test(before))) continue;
    return { end: m.index + m[1].length + m[2].length, next: m.index + m[0].length };
  }
  return null;
}

// Cut point for a sentence that has gone on too long: the last clause
// break, else the last space, never straight after "Bearer" (which would
// split a bearer token from the word that identifies it).
function forcedCut(text, max) {
  const window = text.slice(0, max);
  let idx = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(' - '));
  if (idx < max / 3) idx = window.lastIndexOf(' ');
  while (idx > 0 && /\bbearer$/i.test(window.slice(0, idx))) idx = window.lastIndexOf(' ', idx - 1);
  return idx > 0 ? idx + 1 : -1;
}

// Splits streamed reply text into units to speak. `onUnit(unit)` receives
// either { text } (a sentence, not yet filtered) or { placeholder } (a code
// block, a private-key block or a table, which is never spoken). Text is held
// back until a sentence is complete, so a chunk boundary can never split a
// sentence, a code fence or a key block.
export function createSentenceSplitter(onUnit, { maxSentenceChars = MAX_SENTENCE_CHARS } = {}) {
  let buffer = '';
  // null | 'code' | 'key'
  let block = null;
  let inTable = false;

  const emitText = (raw) => {
    const t = raw.trim();
    if (!t) return;
    if (/^\|.*\|$/.test(t) || /^\|?\s*:?-{3,}/.test(t)) {
      if (!inTable) onUnit({ placeholder: SPEECH_PLACEHOLDERS.table });
      inTable = true;
      return;
    }
    inTable = false;
    onUnit({ text: t });
  };

  const drain = (final) => {
    for (;;) {
      if (block) {
        const closeRe = block === 'code' ? /^[ \t]*(`{3,}|~{3,})[ \t]*$/m : /-----END [A-Z ]*-----/;
        // The opening fence line has already been consumed.
        const m = closeRe.exec(buffer);
        if (!m) {
          if (final) { buffer = ''; block = null; }
          return;
        }
        buffer = buffer.slice(m.index + m[0].length);
        block = null;
        continue;
      }
      const fence = /(^|\n)[ \t]*(?:`{3,}|~{3,})[^\n]*(\n|$)/.exec(buffer);
      const key = /-----BEGIN [A-Z ]*-----/.exec(buffer);
      // A fence line is only known to be complete once its newline arrived.
      const fenceStart = fence && (fence[2] === '\n' || final) ? fence.index + fence[1].length : -1;
      const keyStart = key ? key.index : -1;
      let blockStart = -1;
      let kind = null;
      if (fenceStart !== -1 && (keyStart === -1 || fenceStart < keyStart)) { blockStart = fenceStart; kind = 'code'; }
      else if (keyStart !== -1) { blockStart = keyStart; kind = 'key'; }

      const head = blockStart === -1 ? buffer : buffer.slice(0, blockStart);
      const end = findSentenceEnd(head);
      if (end) {
        emitText(head.slice(0, end.end));
        buffer = buffer.slice(end.next);
        continue;
      }
      if (blockStart !== -1) {
        emitText(head);
        onUnit({ placeholder: kind === 'code' ? SPEECH_PLACEHOLDERS.code : SPEECH_PLACEHOLDERS.secretBlock });
        inTable = false;
        block = kind;
        buffer = kind === 'code'
          ? buffer.slice(fence.index + fence[0].length)
          : buffer.slice(keyStart + key[0].length);
        continue;
      }
      // An unfinished line that might still turn into a fence, or the start
      // of a key block, is never cut or spoken early.
      if (!final && (/(^|\n)[ \t]*(`{1,2}|~{1,2})$/.test(buffer) || /-{1,5}[A-Z ]*$/.test(buffer))) return;
      if (buffer.length > maxSentenceChars) {
        const cut = forcedCut(buffer, maxSentenceChars);
        if (cut > 0) {
          emitText(buffer.slice(0, cut));
          buffer = buffer.slice(cut);
          continue;
        }
      }
      if (final) {
        emitText(buffer);
        buffer = '';
      }
      return;
    }
  };

  return {
    push(chunk) {
      if (!chunk) return;
      buffer += String(chunk).replace(/\r\n?/g, '\n');
      drain(false);
    },
    flush() {
      drain(true);
    }
  };
}

// The whole of `text` as the list of strings that would be spoken, after
// filtering, de-duplicated placeholders and the length cap. Used for the
// one-shot SPEAK action and by tests.
export function speechSegments(text, opts = {}) {
  const out = [];
  const speaker = createSpeechSplitter((s) => out.push(s), opts);
  speaker.push(text);
  speaker.flush();
  return out;
}

export function speechTextFor(text, opts = {}) {
  return speechSegments(text, opts).join(' ');
}

// Splitter + filter + cap: `onSpeech(text)` gets each string to synthesise.
export function createSpeechSplitter(onSpeech, { envValues = [], knownIds = [], maxChars = MAX_SPOKEN_CHARS, maxSentenceChars } = {}) {
  let spoken = 0;
  let capped = false;
  let last = '';
  const splitter = createSentenceSplitter((unit) => {
    if (capped) return;
    const speech = unit.placeholder ? unit.placeholder : toSpeechText(unit.text, { envValues, knownIds });
    if (!speech) return;
    // Two placeholders in a row ("Code block shown on screen." twice) say
    // nothing new.
    if (unit.placeholder && speech === last) return;
    if (spoken + speech.length > maxChars) {
      capped = true;
      onSpeech(SPEECH_PLACEHOLDERS.more);
      return;
    }
    spoken += speech.length;
    last = speech;
    onSpeech(speech);
  }, { maxSentenceChars });
  return {
    push(chunk) { splitter.push(chunk); },
    flush() { splitter.flush(); },
    get capped() { return capped; }
  };
}

// ---------------------------------------------------------------------------
// TTS over HTTP Server-Sent Events (no WebSocket: Vercel functions can't
// hold one). One POST per sentence; the response streams base64 PCM chunks.

export const CARTESIA_SSE_URL = 'https://api.cartesia.ai/tts/sse';
export const CARTESIA_VERSION = '2024-06-10';

export function createSseSynth({ apiKey, modelId, voiceId, fetchImpl = globalThis.fetch, format = VOICE_AUDIO_FORMAT, firstByteTimeoutMs = 8000 }) {
  return async function synthesize(text, { signal, onChunk } = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) return { ok: false, reason: 'aborted', chunks: 0 };
      signal.addEventListener('abort', onAbort);
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, firstByteTimeoutMs);
    let chunks = 0;
    let streamError = '';
    try {
      const res = await fetchImpl(CARTESIA_SSE_URL, {
        method: 'POST',
        headers: { 'Cartesia-Version': CARTESIA_VERSION, 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model_id: modelId,
          transcript: text,
          voice: { mode: 'id', id: voiceId },
          language: 'en',
          output_format: { ...format }
        }),
        cache: 'no-store',
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res || !res.ok) {
        // Upstream error text is never forwarded: it can name the provider
        // and echo request details.
        return { ok: false, reason: `http_${res ? res.status : 0}`, chunks };
      }
      let finished = false;
      await readSseResponse(res, (evt) => {
        if (finished) return;
        let msg;
        try { msg = JSON.parse(evt.data); } catch (e) { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'error' || evt.event === 'error' || msg.error) {
          streamError = 'upstream_error';
          finished = true;
          return;
        }
        if (typeof msg.data === 'string' && msg.data && (msg.type === 'chunk' || msg.type === undefined)) {
          chunks++;
          onChunk(msg.data);
        }
        if (msg.type === 'done' || msg.done === true) finished = true;
      });
      if (streamError) return { ok: false, reason: streamError, chunks };
      if (!chunks) return { ok: false, reason: 'no_audio', chunks };
      return { ok: true, chunks };
    } catch (e) {
      if (signal && signal.aborted) return { ok: false, reason: 'aborted', chunks };
      return { ok: false, reason: timedOut ? 'timeout' : 'network', chunks };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  };
}

// ---------------------------------------------------------------------------
// The voice side of one streamed reply.
//
// `emit(type, payload)` writes a chat-stream event: "audio" for each chunk
// ({ seq, sentence, data, encoding, sample_rate }) and one "audio_end"
// ({ ok, chunks, sentences, reason? }) from finish(). Sentences are
// synthesised one after another, so chunks are emitted, and numbered, in
// speaking order; TTS runs much faster than real time, so the client's
// queue stays ahead of playback.
export function createVoiceStream({ emit, synth, signal, deadlineTs = Infinity, envValues = [], knownIds = [], maxChars = MAX_SPOKEN_CHARS, format = VOICE_AUDIO_FORMAT, onStart }) {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onOuterAbort);
  }
  let seq = 0;
  let sentences = 0;
  let spokenSentences = 0;
  let failure = '';
  let started = false;
  let chain = Promise.resolve();

  const speakOne = async (text, index) => {
    if (failure || controller.signal.aborted) return;
    if (Date.now() >= deadlineTs) { failure = 'deadline'; return; }
    const result = await synth(text, {
      signal: controller.signal,
      onChunk: (data) => {
        if (controller.signal.aborted) return;
        emit('audio', { seq: seq++, sentence: index, data, encoding: format.encoding, sample_rate: format.sample_rate });
      }
    });
    if (result && result.ok) spokenSentences++;
    else if (!failure) failure = controller.signal.aborted ? 'aborted' : ((result && result.reason) || 'failed');
  };

  const speaker = createSpeechSplitter((text) => {
    const index = sentences++;
    if (!started) {
      started = true;
      if (onStart) onStart();
    }
    chain = chain.then(() => speakOne(text, index));
  }, { envValues, knownIds, maxChars });

  return {
    signal: controller.signal,
    push(chunk) {
      if (failure || controller.signal.aborted) return;
      speaker.push(chunk);
    },
    abort() { controller.abort(); },
    get started() { return started; },
    // Waits for every queued sentence (bounded by deadlineTs), then emits
    // "audio_end". With { abort: true } nothing further is synthesised.
    async finish({ abort = false } = {}) {
      if (abort) controller.abort();
      else speaker.flush();
      const remaining = deadlineTs - Date.now();
      let timer;
      // At the deadline, stop waiting even if a TTS request is slow to
      // notice the abort.
      const deadline = Number.isFinite(remaining)
        ? new Promise((resolve) => {
          timer = setTimeout(() => { if (!failure) failure = 'deadline'; controller.abort(); resolve(); }, Math.max(0, remaining));
        })
        : null;
      try {
        await (deadline ? Promise.race([chain, deadline]) : chain);
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onOuterAbort);
      }
      if (controller.signal.aborted && !failure) failure = 'aborted';
      const summary = { ok: !failure, chunks: seq, sentences: spokenSentences, queued: sentences };
      if (failure) summary.reason = failure;
      emit('audio_end', summary);
      return summary;
    }
  };
}
