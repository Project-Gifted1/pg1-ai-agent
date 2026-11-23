// The browser's copy of lib/textDisplay.mjs (clipWords, withPrefix, undouble, paren):
// text is shortened only at a word boundary with "…", a prefix is never
// doubled, and a missing value never leaves "( )" or a stray ")".
// tests/text-display.test.mjs runs the same cases on both copies.
// index.html loads it as a module and exposes it as window.pg1Text.

const squash = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();

export function clipWords(text, n) {
  const t = squash(text);
  const max = Math.max(1, Math.floor(Number(n) || 0));
  if (t.length <= max) return t;
  const sp = t.slice(0, max).lastIndexOf(' ');
  if (sp <= 0) { const end = t.indexOf(' '); return end < 0 ? t : `${t.slice(0, end).replace(/[\s,;:.(\-–—]+$/, '')}…`; }
  let head = t.slice(0, sp).replace(/[\s,;:(\-–—]+$/, '').replace(/\.+$/, '');
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
