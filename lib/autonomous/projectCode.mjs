// What code PG1 may write on its own (lib/autonomous/projects.mjs): an
// import allowlist read from the code, and no way to the process.
//
//   imports    every static import (import ... from 'x', import 'x'),
//              re-export (export ... from 'x') and dynamic import('x') is
//              found and its specifier checked. Allowed: node:assert (and
//              node:assert/strict), node:test, node:crypto, node:util,
//              node:path, and relative "./file.mjs" files in the project's
//              own folder. Anything else is refused, as is a dynamic
//              import() of anything but one of those, written literally.
//   require    refused in any form (ES modules only).
//   process    refused in any form: the word itself, the global object
//              (globalThis, global), the Function constructor and eval,
//              and the usual ways round them (constructor, prototype
//              lookups, Reflect, Proxy). The check runs on the whole text,
//              strings and comments included, after decoding \u and \x
//              escapes, so spelling a word with escapes does not hide it.
//   network    fetch, WebSocket, XMLHttpRequest and the like are refused;
//              node:net/http/https/dns/child_process are not on the
//              allowlist anyway.
//
// A static check of JavaScript cannot be complete, so this is one layer:
// project tests also run in CI with the network blocked
// (tests/ci/no-network.mjs) and with no secrets (.github/workflows/tests.yml
// references none, and its token is read-only and not kept by checkout).

export const ALLOWED_MODULES = Object.freeze(['node:assert', 'node:assert/strict', 'node:test', 'node:crypto', 'node:util', 'node:path']);
const RELATIVE_RE = /^\.\/[a-z0-9][a-z0-9_-]{0,40}\.mjs$/;
// Whole words refused anywhere in the text (after decoding escapes).
export const BANNED_WORDS = Object.freeze([
  'process', 'require', 'globalThis', 'global', 'eval', 'Function', 'constructor',
  '__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
  'getPrototypeOf', 'setPrototypeOf', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors',
  'Reflect', 'Proxy', 'WebAssembly', 'Deno', 'Bun', 'createRequire',
  'fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'Worker', 'SharedArrayBuffer', 'Atomics',
  'child_process', 'execSync'
]);

// Decode the escapes JavaScript accepts in identifiers and strings, so a
// word cannot hide behind them: \uXXXX, \u{X...}, \xXX.
export function decodeEscapes(text) {
  return String(text)
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, h) => { const n = parseInt(h, 16); return n <= 0x10ffff ? String.fromCodePoint(n) : ''; })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Every module specifier the code names: [{ kind, spec, literal }].
export function findImports(text) {
  const t = String(text);
  const out = [];
  const add = (kind, spec, literal = true) => out.push({ kind, spec, literal });
  // import x from 'y'; import { a } from "y"; import * as z from 'y'; export { a } from 'y'; export * from 'y'
  for (const m of t.matchAll(/\b(?:import|export)\b[^;'"`()]*?\bfrom\s*(['"`])([^'"`]*)\1/g)) add('static', m[2], m[1] !== '`');
  // import 'y' (side effects only)
  for (const m of t.matchAll(/\bimport\s*(['"`])([^'"`]*)\1/g)) add('static', m[2], m[1] !== '`');
  // import('y'), and import(anything else)
  for (const m of t.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) {
    const lit = /^(['"])([^'"`]*)\1\s*$/.exec(m[1].trim());
    add('dynamic', lit ? lit[2] : m[1].trim(), !!lit);
  }
  return out;
}

// { ok: true } or { ok: false, reason }.
export function checkProjectCode(content, { path = 'file' } = {}) {
  const raw = String(content || '');
  const text = decodeEscapes(raw);
  for (const w of BANNED_WORDS) {
    if (new RegExp(`(^|[^A-Za-z0-9_$])${w.replace(/[$]/g, '\\$')}(?![A-Za-z0-9_$])`).test(text)) return { ok: false, reason: `${path} uses "${w}", which is not allowed (no process, require, global object, eval or network)` };
  }
  if (/\bimport\s*\.\s*meta\b/.test(text)) return { ok: false, reason: `${path} uses import.meta, which is not allowed` };
  const imports = findImports(text);
  for (const i of imports) {
    if (!i.literal) return { ok: false, reason: `${path} has an import whose module is not written out literally` };
    if (!ALLOWED_MODULES.includes(i.spec) && !RELATIVE_RE.test(i.spec)) return { ok: false, reason: `${path} imports "${i.spec.slice(0, 60)}"; only ${ALLOWED_MODULES.join(', ')} and ./file.mjs are allowed` };
  }
  // Every "import" in the text must be one of the imports found above: any
  // other use (an odd form the patterns miss) is refused rather than guessed at.
  const mentions = (text.match(/\bimport\b/g) || []).length;
  const found = (text.match(/\bimport\b[^;'"`()]*?\bfrom\s*(['"`])[^'"`]*\1/g) || []).length + (text.match(/\bimport\s*(['"`])[^'"`]*\1/g) || []).length + (text.match(/\bimport\s*\(/g) || []).length;
  if (mentions !== found) return { ok: false, reason: `${path} uses "import" in a way that could not be checked` };
  return { ok: true };
}

// GitHub text PG1 writes on its own (titles, bodies, commit messages,
// comments): no "@" mention can survive, so nothing it writes can call
// @claude (.github/workflows/claude.yml) or notify anyone. Each "@" becomes
// "＠" (a full-width at sign, not a mention).
export function noMentions(text) {
  return String(text == null ? '' : text).replace(/@/g, '＠');
}
