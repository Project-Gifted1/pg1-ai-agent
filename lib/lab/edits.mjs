// A code experiment's change as targeted edits (lib/lab/runner.mjs build
// stage), checked before anything is written. The model replies
//   {"summary":"...","edits":[{"path","search","replace"}],"new_files":[{"path","content"}],"tests":"..."}
// Each "search" must match its file EXACTLY ONCE (the rule of
// APPLY_SURGICAL_PATCH in api/chat.mjs): zero or several matches refuse the
// edit, with the reason. New files may be whole. The lab's path allow-list
// (checkCodePath), the size limit (MAX_CODE_BYTES, counted over what the
// change writes: search, replace and new files) and "every change needs a
// test" (a file under tests/) still hold.
//
// Every way a build reply can fail has its own code and a message that
// says what to do about it (BUILD_FAILURES), so a failed build explains
// itself instead of "The model proposed no usable change".
//
//   parseBuildReply(text, { truncated })      -> { ok, plan } | { ok: false, failure }
//   checkBuildPlan(plan, { readFile })        -> { ok, patch, bytes, touched } | { ok: false, failure }
//   applyEditsToText(content, edits, path)    -> new content (throws BuildFailure)
//   countOccurrences(haystack, needle)
//
// patch (lab-out/patch.json, applied by scripts/lab-apply.mjs):
//   [{ path, edits: [{ search, replace }] }, { path, content }]

import { checkCodePath, MAX_CODE_FILES, MAX_CODE_BYTES } from './policy.mjs';

export const BUILD_FAILURES = Object.freeze({
  no_json: 'the reply held no JSON object',
  truncated: 'the reply was cut off (the engine stopped at its output limit) before the JSON was complete',
  empty_edits: 'the JSON had no edits and no new files',
  bad_fields: 'an edit or new file is missing a field or has the wrong type',
  no_match: 'a search text is not in its file',
  multiple_match: 'a search text appears more than once in its file',
  refused_path: 'Refused: the change touches a path the lab may not change',
  too_large: 'Refused: the change is over the size limit',
  no_test: 'the change has no test (every change needs one under tests/)'
});

export class BuildFailure extends Error {
  constructor(code, message, detail = {}) { super(message); this.code = code; this.detail = detail; }
}
const fail = (code, message, detail) => ({ ok: false, failure: { code, message, ...(detail ? { detail } : {}) } });

export function countOccurrences(hay, needle) {
  const h = String(hay); const n = String(needle);
  if (!n) return 0;
  let k = 0; let i = h.indexOf(n);
  while (i >= 0) { k++; i = h.indexOf(n, i + n.length); }
  return k;
}

// The first complete JSON object in a reply (a ```json fence first).
function firstJson(text) {
  const t = String(text || '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  const body = fenced ? fenced[1] : t;
  const start = body.indexOf('{');
  if (start < 0) return { found: false };
  // Walk to the matching brace (strings and escapes respected).
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { try { return { found: true, value: JSON.parse(body.slice(start, i + 1)) }; } catch (e) { return { found: true, error: e.message }; } } }
  }
  return { found: true, open: true };
}

export function parseBuildReply(text, { truncated = false } = {}) {
  const t = String(text || '');
  const j = firstJson(t);
  if (truncated && (!j.found || j.open || j.error)) return fail('truncated', `${BUILD_FAILURES.truncated} (${t.length} characters received)`);
  if (!j.found) return fail('no_json', `${BUILD_FAILURES.no_json}${t.trim() ? ` (it began: "${t.trim().slice(0, 80).replace(/\s+/g, ' ')}")` : ' (the reply was empty)'}`);
  if (j.open) return fail('truncated', `${BUILD_FAILURES.truncated}: the JSON never closed (${t.length} characters received)`);
  if (j.error) return fail('no_json', `${BUILD_FAILURES.no_json}: the JSON did not parse (${j.error.slice(0, 80)})`);
  const plan = j.value;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return fail('bad_fields', `${BUILD_FAILURES.bad_fields}: the reply is not an object`);
  const edits = plan.edits == null ? [] : plan.edits; const files = plan.new_files == null ? [] : plan.new_files;
  if (!Array.isArray(edits) || !Array.isArray(files)) return fail('bad_fields', `${BUILD_FAILURES.bad_fields}: "edits" and "new_files" must be lists`);
  if (!edits.length && !files.length) return fail('empty_edits', BUILD_FAILURES.empty_edits);
  for (const [i, e] of edits.entries()) {
    const miss = !e || typeof e !== 'object' ? 'is not an object' : typeof e.path !== 'string' || !e.path ? 'has no "path"' : typeof e.search !== 'string' || !e.search ? 'has no "search" text' : typeof e.replace !== 'string' ? 'has no "replace" text' : e.search === e.replace ? 'changes nothing (search equals replace)' : '';
    if (miss) return fail('bad_fields', `${BUILD_FAILURES.bad_fields}: edit ${i + 1}${e && e.path ? ` (${e.path})` : ''} ${miss}`, { edit: i + 1 });
  }
  for (const [i, f] of files.entries()) {
    const miss = !f || typeof f !== 'object' ? 'is not an object' : typeof f.path !== 'string' || !f.path ? 'has no "path"' : typeof f.content !== 'string' || !f.content ? 'has no "content"' : '';
    if (miss) return fail('bad_fields', `${BUILD_FAILURES.bad_fields}: new file ${i + 1}${f && f.path ? ` (${f.path})` : ''} ${miss}`, { new_file: i + 1 });
  }
  return { ok: true, plan: { summary: String(plan.summary || '').slice(0, 2000), edits, new_files: files, tests: String(plan.tests || '').slice(0, 1000) } };
}

// Edits applied to one file's text in order; each search must match exactly once.
export function applyEditsToText(content, edits, path = '') {
  let out = String(content);
  for (const [i, e] of edits.entries()) {
    const n = countOccurrences(out, e.search);
    const at = `edit ${e.index || i + 1} in ${path}`;
    if (n === 0) throw new BuildFailure('no_match', `${at}: the search text is not in the file (it must be copied exactly, whitespace included)`, { path, edit: e.index || i + 1 });
    if (n > 1) throw new BuildFailure('multiple_match', `${at}: the search text appears ${n} times; it must appear exactly once (add surrounding lines to make it unique)`, { path, edit: e.index || i + 1, matches: n });
    out = out.replace(e.search, () => e.replace);
  }
  return out;
}

// readFile(path) -> the file's text, or null when it does not exist.
export function checkBuildPlan(plan, { readFile }) {
  const byPath = new Map();
  plan.edits.forEach((e, i) => { const list = byPath.get(e.path) || []; list.push({ ...e, index: i + 1 }); byPath.set(e.path, list); });
  const paths = [...byPath.keys(), ...plan.new_files.map((f) => f.path)];
  if (new Set(paths).size > MAX_CODE_FILES) return fail('too_large', `${BUILD_FAILURES.too_large}: ${new Set(paths).size} files, at most ${MAX_CODE_FILES}`);
  const refused = [...new Set(paths)].map((p) => ({ path: p, ...checkCodePath(p) })).filter((x) => !x.ok);
  if (refused.length) return fail('refused_path', `${BUILD_FAILURES.refused_path}: ${refused.map((r) => `${r.path} (${r.reason || 'not allowed'})`).join(', ')}`, { paths: refused.map((r) => r.path) });
  const bytes = plan.edits.reduce((n, e) => n + Buffer.byteLength(e.search) + Buffer.byteLength(e.replace), 0) + plan.new_files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
  if (bytes > MAX_CODE_BYTES) return fail('too_large', `${BUILD_FAILURES.too_large}: ${Math.round(bytes / 1024)} KB, at most ${Math.round(MAX_CODE_BYTES / 1024)} KB`, { bytes });
  if (!paths.some((p) => /^tests\//.test(p))) return fail('no_test', BUILD_FAILURES.no_test);
  for (const f of plan.new_files) if (readFile(f.path) != null && byPath.has(f.path)) return fail('bad_fields', `${BUILD_FAILURES.bad_fields}: ${f.path} is both edited and given whole`);
  const patch = [];
  for (const [path, edits] of byPath) {
    const current = readFile(path);
    if (current == null) return fail('no_match', `edit ${edits[0].index} in ${path}: the file does not exist (to create it, give it under "new_files")`, { path, edit: edits[0].index });
    try { applyEditsToText(current, edits, path); } catch (e) { if (e instanceof BuildFailure) return fail(e.code, e.message, e.detail); throw e; }
    patch.push({ path, edits: edits.map((e) => ({ search: e.search, replace: e.replace })) });
  }
  for (const f of plan.new_files) patch.push({ path: f.path, content: f.content });
  return { ok: true, patch, bytes, touched: [...new Set(paths)] };
}
