// Job 2 of .github/workflows/lab.yml (no secrets): writes a code
// experiment's change into the checkout, re-checking every path against the
// lab's allowed paths, so the test suite runs on the proposed change.
// scripts/lab-pr.mjs applies the same patch on a fresh checkout.
//
// A patch entry is either a targeted edit list, { path, edits: [{ search,
// replace }] } (each search must match its file exactly once, as the runner
// checked: lib/lab/edits.mjs), or a whole new file, { path, content }. The
// size limit counts what the change writes (search, replace, content).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { checkCodePath, MAX_CODE_FILES, MAX_CODE_BYTES } from '../lib/lab/policy.mjs';
import { applyEditsToText } from '../lib/lab/edits.mjs';

export function applyPatch(files, root = process.cwd()) {
  if (!Array.isArray(files) || files.length > MAX_CODE_FILES) throw new Error('bad patch');
  let bytes = 0;
  for (const f of files) {
    const ok = checkCodePath(f.path);
    if (!ok.ok) throw new Error(`refused path ${f.path}: ${ok.reason}`);
    const target = path.resolve(root, f.path);
    if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error(`refused path ${f.path}`);
    if (Array.isArray(f.edits)) {
      bytes += f.edits.reduce((n, e) => n + Buffer.byteLength(String(e.search)) + Buffer.byteLength(String(e.replace)), 0);
      if (bytes > MAX_CODE_BYTES) throw new Error('patch too large');
      if (!existsSync(target)) throw new Error(`no file ${f.path} to edit`);
      writeFileSync(target, applyEditsToText(readFileSync(target, 'utf8'), f.edits.map((e) => ({ search: String(e.search), replace: String(e.replace) })), f.path));
      continue;
    }
    bytes += Buffer.byteLength(String(f.content));
    if (bytes > MAX_CODE_BYTES) throw new Error('patch too large');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, String(f.content));
  }
  return files.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const n = applyPatch(JSON.parse(readFileSync(process.argv[2] || 'lab-out/patch.json', 'utf8')));
    console.log(`applied ${n} file(s)`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
