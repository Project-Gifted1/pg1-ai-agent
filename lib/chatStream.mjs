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
//   step_done  { id, label, result, details?, failed? }  that action finished
//   text       { text }                           a chunk of the reply
//   audio      { seq, sentence, data, encoding, sample_rate }
//                                                 a chunk of spoken reply
//                                                 (base64 PCM, lib/voiceStream.mjs)
//   audio_end  { ok, chunks, sentences, reason? } no more audio for this reply
//   done       { request_id, result? }            the reply is complete
//   error      { message, request_id, partial }   the request failed
//
// A step is only ever emitted by the code path that is about to do the thing
// it names (see api/chat.mjs). Every label, result and detail line goes
// through redactTraceText() first: the same secret patterns and deployment
// env values Send to Code strips (lib/handoff.mjs), plus a length cap. No
// step ever carries a system prompt, memory contents or model thinking.

import { stripSecrets } from './handoff.mjs';

export const STREAM_EVENT_TYPES = Object.freeze(['step', 'step_done', 'text', 'audio', 'audio_end', 'done', 'error']);

const MAX_LABEL_LEN = 80;
const MAX_RESULT_LEN = 80;
const MAX_DETAIL_LEN = 160;
const MAX_DETAILS = 8;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export function redactTraceText(value, envValues = [], max = MAX_DETAIL_LEN) {
  if (value == null) return '';
  const flat = String(value).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const { text } = stripSecrets(flat, { envValues });
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// The identity guard api/chat.mjs has always applied to a finished reply.
export const IDENTITY_CLAIM_RE = /\b(I am|I'm|I’m|powered by|built on|running on)\s+(Google Gemini|Gemini|ChatGPT|Claude|Anthropic|Google|OpenAI)\b/gi;

export function scrubIdentity(text) {
  return String(text).replace(IDENTITY_CLAIM_RE, (m, lead) => lead + ' PG1 Sovereign Core');
}

// Streams scrubIdentity() over chunks. The last HOLD characters are kept back
// until more text (or flush) arrives, so a claim split across two chunks
// ("I am Gem" + "ini") is still caught before any of it reaches the client.
const HOLD = 48;

export function createReplyScrubber(emit) {
  let pending = '';
  let full = '';
  return {
    push(chunk) {
      if (!chunk) return;
      pending = scrubIdentity(pending + chunk);
      if (pending.length > HOLD) {
        const out = pending.slice(0, pending.length - HOLD);
        pending = pending.slice(pending.length - HOLD);
        full += out;
        emit(out);
      }
    },
    flush() {
      if (!pending) return;
      const out = scrubIdentity(pending);
      pending = '';
      full += out;
      emit(out);
    },
    get text() { return full + pending; }
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
export function createChatStream(res, { requestId, envValues = [], corsOrigin = '*' } = {}) {
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

  const redactLabel = (v) => redactTraceText(v, envValues, MAX_LABEL_LEN);

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
      open.set(id, true);
      return write('step', { id, label: redactLabel(label) });
    },

    // Only closes a step that was opened and is still running, so a
    // step_done can never appear for something that never started.
    stepDone(id, { label, result, details, failed } = {}) {
      if (!open.has(id)) return false;
      open.delete(id);
      finished.add(id);
      const payload = { id, label: redactLabel(label), result: redactTraceText(result, envValues, MAX_RESULT_LEN) };
      if (failed) payload.failed = true;
      if (Array.isArray(details) && details.length) {
        payload.details = details.slice(0, MAX_DETAILS).map((d) => redactTraceText(d, envValues, MAX_DETAIL_LEN)).filter(Boolean);
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
      const payload = { message: redactTraceText(message, envValues, 400), request_id: requestId, partial: !!partial };
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
