// The real code a code experiment's build step needs (lib/lab/runner.mjs):
// the goal's identifiers, methods, routes and tool names searched for in
// the repository, and the code around each match (its enclosing function
// where one can be found) with line numbers, within a token budget. It goes
// into the build prompt as untrusted context: data to copy "search" texts
// from, never instructions.
//
// 23 Nov, lab 82aaad40 ("Improve (server/discover): 11 method_not_found
// answers"): the build step saw the goal and the research notes but no line
// of PG1's code, and the free engine "proposed no usable change".
//
//   goalTerms(goal)                       -> the terms to search for
//   gatherCodeContext({ goal, root, budgetTokens }) -> { text, files, terms, tokens }

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkCodePath } from './policy.mjs';

export const CONTEXT_DIRS = Object.freeze(['lib', 'api', 'scripts', 'tests']);
export const DEFAULT_CONTEXT_TOKENS = 7000;
const MAX_FILE_BYTES = 400 * 1024;
const SKIP = /(^|\/)(node_modules|vendor|fixtures?|__snapshots__)(\/|$)/;
const tokens = (s) => Math.ceil(String(s).length / 4);
// Words too common to search for on their own.
const STOP = new Set(['method_not_found', 'invalid_params', 'tool_call', 'real_callers', 'error_messages', 'output_shapes']);

export function goalTerms(goal) {
  const g = String(goal || '');
  const out = new Map();
  const add = (t, weight) => { const k = t.trim(); if (k.length >= 4 && k.length <= 80 && !out.has(k)) out.set(k, weight); };
  // Paths, routes, JSON-RPC / MCP / A2A method names, tool names, identifiers.
  for (const m of g.matchAll(/\b(?:lib|api|scripts|tests|public)\/[\w./-]+\.m?js\b/g)) add(m[0], 5);
  for (const m of g.matchAll(/\/api\/[\w/-]+/g)) add(m[0], 2);
  for (const m of g.matchAll(/(?<![\w/.])([a-z][a-zA-Z]+\/[a-z][a-zA-Z/]*)(?![\w/.])/g)) if (!/^(lib|api|tests|scripts|public|docs)\//.test(m[1])) add(m[1], 4);
  for (const m of g.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) if (!STOP.has(m[0])) add(m[0], 3);
  for (const m of g.matchAll(/\b[a-z]+[A-Z][A-Za-z0-9]+\b/g)) add(m[0], 2);
  // The error code a goal names ("method_not_found" -> its JSON-RPC code).
  if (/method_not_found|method not found/i.test(g)) add('-32601', 2);
  // A protocol method: where methods are dispatched (the place a new one goes).
  if ([...out.keys()].some((k) => /^[a-z][a-zA-Z]+\/[a-z]/.test(k))) { add("method === 'initialize'", 3); add("method === 'tools/list'", 2); }
  if (/invalid_params|invalid params/i.test(g)) add('-32602', 2);
  // A term that is only the start of another (a goal cut mid-word) is dropped.
  const keys = [...out.keys()];
  for (const k of keys) if (keys.some((o) => o !== k && o.startsWith(k))) out.delete(k);
  return [...out.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([term, weight]) => ({ term, weight }));
}

function walk(root, dir, out) {
  let names; try { names = readdirSync(join(root, dir)); } catch (e) { return out; }
  for (const n of names) {
    const rel = `${dir}/${n}`;
    if (SKIP.test(rel)) continue;
    let st; try { st = statSync(join(root, rel)); } catch (e) { continue; }
    if (st.isDirectory()) walk(root, rel, out);
    else if (/\.m?js$/.test(n) && st.size <= MAX_FILE_BYTES) out.push(rel);
  }
  return out;
}

// Where the enclosing block of line i starts (a function, a method, an
// if/case on the matched name), within 60 lines; else 12 lines above.
const BLOCK_START = /^\s*(?:export\s+)?(?:async\s+)?function\b|^\s*(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?(?:\(|function)|^\s*(?:async\s+)?[a-zA-Z_]\w*\s*\([^)]*\)\s*\{\s*$|^\s*(?:if|else if)\s*\(.*\bmethod\b|^\s*case\s/;
function excerptRange(lines, i) {
  let start = Math.max(0, i - 12);
  for (let k = i; k >= Math.max(0, i - 60); k--) if (BLOCK_START.test(lines[k])) { start = k; break; }
  // To the end of that block (indentation back to its start) or 40 lines on.
  const ind = (lines[start].match(/^\s*/) || [''])[0].length;
  let end = Math.min(lines.length - 1, i + 25);
  for (let k = i + 1; k < Math.min(lines.length, start + 120); k++) { const l = lines[k]; if (l.trim() && (l.match(/^\s*/) || [''])[0].length <= ind && /^\s*[}\])]/.test(l)) { end = k; break; } }
  return [start, Math.max(end, Math.min(lines.length - 1, i + 6))];
}

export function gatherCodeContext({ goal, root = process.cwd(), budgetTokens = DEFAULT_CONTEXT_TOKENS, dirs = CONTEXT_DIRS } = {}) {
  const terms = goalTerms(goal);
  if (!terms.length) return { text: '', files: [], terms: [], tokens: 0 };
  // Only files the lab may change (lib/lab/policy.mjs checkCodePath): the
  // lab's own code and the autonomy policy are never context for a change.
  const files = dirs.flatMap((d) => walk(root, d, [])).filter((f) => checkCodePath(f).ok);
  const hits = [];
  for (const f of files) {
    let src; try { src = readFileSync(join(root, f), 'utf8'); } catch (e) { continue; }
    const found = terms.filter((t) => src.includes(t.term));
    if (!found.length) continue;
    const lines = src.split('\n');
    const at = [];
    // The strongest terms first, two places each (six at most a file).
    for (const t of [...found].sort((a, b) => b.weight - a.weight)) { let k = 0; for (let i = 0; i < lines.length && k < 2 && at.length < 6; i++) if (lines[i].includes(t.term) && !at.includes(i)) { at.push(i); k++; } }
    const score = found.reduce((n, t) => n + t.weight, 0) * (/^tests\//.test(f) ? 0.3 : 1) + (found.some((t) => f === t.term) ? 10 : 0);
    hits.push({ path: f, lines, at: [...new Set(at)].sort((a, b) => a - b), score, terms: found.map((t) => t.term) });
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const parts = []; const used = []; let spent = 0;
  for (const h of hits) {
    // Merge each hit's block with its neighbours.
    const ranges = [];
    for (const i of h.at) { const [s, e] = excerptRange(h.lines, i); const last = ranges[ranges.length - 1]; if (last && s <= last[1] + 3) last[1] = Math.max(last[1], e); else ranges.push([s, e]); }
    for (const [s, e] of ranges) {
      const body = h.lines.slice(s, e + 1).map((l, k) => `${String(s + k + 1).padStart(5)}| ${l}`).join('\n');
      const block = `<file path="${h.path}" lines="${s + 1}-${e + 1}" matches="${h.terms.join(', ')}">\n${body}\n</file>`;
      if (spent + tokens(block) > budgetTokens) continue;
      parts.push(block); spent += tokens(block);
      const u = used.find((x) => x.path === h.path); if (u) u.ranges.push([s + 1, e + 1]); else used.push({ path: h.path, ranges: [[s + 1, e + 1]] });
    }
    if (spent >= budgetTokens * 0.95) break;
  }
  return { text: parts.join('\n'), files: used, terms: terms.map((t) => t.term), tokens: spent, root: relative(process.cwd(), root) || '.' };
}
