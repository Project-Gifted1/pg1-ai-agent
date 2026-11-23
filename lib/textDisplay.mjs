// How PG1 shows text it did not write word for word (chat, lab cards,
// reports, watch reports): the same four rules everywhere. Pure.
//
//   plainInline(text)      Markdown emphasis removed, the words kept. An
//                          underscore inside a word is part of it
//                          (check_agent_message stays check_agent_message):
//                          underscore emphasis only at word edges, as in
//                          CommonMark and lib/pdf/markdown.mjs.
//   clipWords(text, n)     at most n characters, cut only at a word
//                          boundary, with "…". A first word longer than n
//                          is kept whole (never cut inside a word).
//   withPrefix(p, text)    "p: text", unless text already starts with p
//                          (never "Improve: Improve (…)").
//   undouble(text)        a prefix already doubled in stored text, once:
//                          "Improve: Improve (x): …" reads "Improve (x): …".
//   paren(value)           " (value)", or "" when the value is missing or
//                          empty (never a stray ")" or an empty "( )").
//
// public/text-display.js is the browser's copy of clipWords, withPrefix
// and paren; tests/text-display.test.mjs runs the same cases on both.

import { plainText } from './pdf/markdown.mjs';

const squash = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();

export function plainInline(text) {
  return squash(plainText(String(text == null ? '' : text)));
}

export function clipWords(text, n) {
  const t = squash(text);
  const max = Math.max(1, Math.floor(Number(n) || 0));
  if (t.length <= max) return t;
  // Cut at the last space within n characters (the "…" takes the space's
  // place, so the result is never longer than n), else keep the first word
  // whole.
  const sp = t.slice(0, max).lastIndexOf(' ');
  if (sp <= 0) { const end = t.indexOf(' '); return end < 0 ? t : `${t.slice(0, end).replace(/[\s,;:.(\-–—]+$/, '')}…`; }
  let head = t.slice(0, sp).replace(/[\s,;:(\-–—]+$/, '').replace(/\.+$/, '');
  // Never end on an open bracket's word: "( foo" without its ")".
  const opens = (head.match(/\(/g) || []).length; const closes = (head.match(/\)/g) || []).length;
  if (opens > closes) { const at = head.lastIndexOf('('); const before = head.slice(0, at).replace(/[\s,;:\-–—]+$/, ''); if (before) head = before; }
  return `${head}…`;
}

export function withPrefix(prefix, text) {
  const p = squash(prefix).replace(/:$/, '');
  const t = squash(text);
  if (!p) return t;
  if (!t) return p;
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc}(?![A-Za-z0-9])`, 'i').test(t) ? t : `${p}: ${t}`;
}

export function undouble(text) {
  const t = squash(text);
  const m = /^([A-Z][\w ]{1,30}?):\s+(.*)$/.exec(t);
  if (!m) return t;
  const esc = m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc}(?![A-Za-z0-9])`, 'i').test(m[2]) ? m[2] : t;
}

export function paren(value) {
  const v = squash(value);
  return v && !/^[(\s)]*$/.test(v) ? ` (${v})` : '';
}
