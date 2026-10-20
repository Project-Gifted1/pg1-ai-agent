// Saved chats ("Session threads"): the pure parts of api/threads.mjs -
// input limits, message clean-up, the auto title and the secret guard.
//
// A saved thread is { id, title, messages: [{ role, text, at }], created_at,
// updated_at, message_count } in public.pg1_chat_threads
// (supabase/migrations/20261015120000_pg1_usage_report_and_chat_threads.sql).
// Only text is stored: result cards, images and audio stay in the browser.
// Every title and message text passes the same reply secret guard the chat
// uses on its replies (lib/secretGuard.mjs) before it is stored, so a key,
// token or configuration value pasted into a chat is never saved.

import { createReplySecretGuard } from './secretGuard.mjs';
import { secretEnvValues } from './handoff.mjs';
import { cleanTaskState } from './taskState.mjs';
import { cleanSummary, MAX_CARD_LINES, MAX_CARD_LINE_CHARS } from './contextWindow.mjs';
import { cleanRelayName, RELAY_SPEAKER } from './relay.mjs';

export const THREAD_TABLE = 'pg1_chat_threads';
export const MAX_THREAD_MESSAGES = 500;
export const MAX_MESSAGE_CHARS = 20000;
export const MAX_THREAD_CHARS = 1000000;
export const MAX_TITLE_CHARS = 120;
export const AUTO_TITLE_CHARS = 60;
export const THREAD_LIST_LIMIT = 50;

export const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ThreadInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.threadInputError = true;
    this.status = status;
  }
}

// The guard for saved content: the deployment's own secret values, secret
// shapes (keys, tokens, JWTs, private keys) and configuration names.
export function threadGuard(env = process.env) {
  const guard = createReplySecretGuard({ envValues: secretEnvValues(env), env });
  return (text) => guard(text).text;
}

const ROLES = Object.freeze({ user: 'user', assistant: 'assistant', model: 'assistant', agent: 'assistant' });

// Validates and cleans the messages a client sends. Throws ThreadInputError
// on anything malformed or over the limits; drops empty messages.
export function cleanMessages(input, guard = (t) => t) {
  if (!Array.isArray(input)) throw new ThreadInputError('messages must be a list');
  if (input.length > MAX_THREAD_MESSAGES) throw new ThreadInputError(`A saved chat holds at most ${MAX_THREAD_MESSAGES} messages.`, 413);
  let total = 0;
  const out = [];
  for (const m of input) {
    if (!m || typeof m !== 'object') throw new ThreadInputError('each message must be an object');
    const role = ROLES[m.role];
    if (!role) throw new ThreadInputError('message role must be user or assistant');
    if (typeof m.text !== 'string') throw new ThreadInputError('message text must be a string');
    const raw = m.text.replace(/\u0000/g, '').trim();
    if (!raw) continue;
    if (raw.length > MAX_MESSAGE_CHARS) throw new ThreadInputError(`A message can be at most ${MAX_MESSAGE_CHARS} characters.`, 413);
    total += raw.length;
    if (total > MAX_THREAD_CHARS) throw new ThreadInputError('This chat is too long to save.', 413);
    const at = typeof m.at === 'string' && Number.isFinite(Date.parse(m.at)) ? new Date(Date.parse(m.at)).toISOString() : null;
    // Card lines ("[card] film 1a2b3c4d ...", lib/contextWindow.mjs
    // cardLines): what the result cards said, as text, so a restored thread
    // keeps them in context. At most MAX_CARD_LINES, each one short line.
    const cards = Array.isArray(m.cards)
      ? m.cards.filter((c) => typeof c === 'string' && /^\[card\]/.test(c)).slice(0, MAX_CARD_LINES).map((c) => guard(c.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, MAX_CARD_LINE_CHARS)))
      : [];
    const msg = cards.length ? { role, text: guard(raw), at, cards } : { role, text: guard(raw), at };
    // RELAY MODE (lib/relay.mjs): a user message another AI wrote keeps
    // speaker 'relay' and its name; PG1's reply to it keeps the name, so
    // a restored thread shows the label and the Copy for <name> button.
    const relayName = cleanRelayName(m.relay_name);
    if (relayName && role === 'user' && m.speaker === RELAY_SPEAKER) Object.assign(msg, { speaker: RELAY_SPEAKER, relay_name: relayName });
    else if (relayName && role === 'assistant') msg.relay_name = relayName;
    out.push(msg);
  }
  return out;
}

// A title from the first user message: plain words, no markdown, at most
// AUTO_TITLE_CHARS characters (cut at a word, with an ellipsis).
export function autoTitle(messages, now = new Date()) {
  const first = (Array.isArray(messages) ? messages : []).find((m) => m && m.role === 'user' && typeof m.text === 'string' && m.text.trim());
  const plain = first
    ? first.text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*_#>|~]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    : '';
  if (!plain) return `Chat ${now.toISOString().slice(0, 10)}`;
  if (plain.length <= AUTO_TITLE_CHARS) return plain;
  const cut = plain.slice(0, AUTO_TITLE_CHARS - 1);
  const atWord = cut.replace(/\s+\S*$/, '');
  return `${(atWord.length >= AUTO_TITLE_CHARS / 2 ? atWord : cut).trim()}…`;
}

// A title the operator typed: one line, trimmed, at most MAX_TITLE_CHARS.
export function cleanTitle(input, guard = (t) => t) {
  if (typeof input !== 'string') throw new ThreadInputError('title must be a string');
  const title = guard(input.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, MAX_TITLE_CHARS).trim();
  if (!title) throw new ThreadInputError('title cannot be empty');
  return title;
}

export function threadSummary(row) {
  return {
    id: row.id,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    message_count: Number.isFinite(row.message_count) ? row.message_count : Array.isArray(row.messages) ? row.messages.length : 0
  };
}

// The thread's task state and rolling summary (lib/taskState.mjs,
// lib/contextWindow.mjs), cleaned and secret-guarded for storage in
// pg1_chat_threads.task_state / context_summary. null when absent.
export function cleanThreadContext(body, guard = (t) => t) {
  const out = {};
  if (body && body.taskState && typeof body.taskState === 'object') out.task_state = cleanTaskState(body.taskState, guard);
  if (body && body.contextSummary && typeof body.contextSummary === 'object') out.context_summary = cleanSummary(body.contextSummary, guard);
  return out;
}
