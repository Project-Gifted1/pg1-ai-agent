// Job 2 of .github/workflows/lab.yml (no secrets): writes a code
// experiment's files into the checkout, re-checking every path against the
// lab's allowed paths, so the test suite runs on the proposed change.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { checkCodePath, MAX_CODE_FILES, MAX_CODE_BYTES } from '../lib/lab/policy.mjs';

export function applyPatch(files, root = process.cwd()) {
  if (!Array.isArray(files) || files.length > MAX_CODE_FILES) throw new Error('bad patch');
  let bytes = 0;
  for (const f of files) {
    const ok = checkCodePath(f.path);
    if (!ok.ok) throw new Error(`refused path ${f.path}: ${ok.reason}`);
    bytes += Buffer.byteLength(String(f.content));
    if (bytes > MAX_CODE_BYTES) throw new Error('patch too large');
    const target = path.resolve(root, f.path);
    if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error(`refused path ${f.path}`);
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
