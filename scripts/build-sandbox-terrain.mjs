// Writes public/sandbox/terrain.js, the viewer's copy of the sandbox
// terrain (lib/sandbox/terrain.mjs): the engine and the viewer must draw
// and keep to exactly the same coastline, so the viewer gets the very same
// file. Run after changing lib/sandbox/terrain.mjs:
//   node scripts/build-sandbox-terrain.mjs
// tests/sandbox-terrain.test.mjs fails while the two differ.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TERRAIN_SOURCE = path.join(ROOT, 'lib', 'sandbox', 'terrain.mjs');
export const TERRAIN_VIEWER = path.join(ROOT, 'public', 'sandbox', 'terrain.js');

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(TERRAIN_VIEWER, readFileSync(TERRAIN_SOURCE));
  console.log(`wrote ${path.relative(ROOT, TERRAIN_VIEWER)}`);
}
