// Writes public/sandbox/terrain.js, the viewer's copy of the sandbox
// terrain (lib/sandbox/terrain.mjs): the engine and the viewer must draw
// and keep to exactly the same coastline, so the viewer gets the very same
// file. Run after changing lib/sandbox/terrain.mjs:
//   node scripts/build-sandbox-terrain.mjs
// tests/sandbox-terrain.test.mjs fails while the two differ.
// The same for the vehicles' ways through a step (lib/sandbox/vehicle-path.mjs
// -> public/sandbox/vehicle-path.js): the engine keeps them clear, the viewer
// draws them; tests/sandbox-play.test.mjs checks the copy.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TERRAIN_SOURCE = path.join(ROOT, 'lib', 'sandbox', 'terrain.mjs');
export const TERRAIN_VIEWER = path.join(ROOT, 'public', 'sandbox', 'terrain.js');
export const PATH_SOURCE = path.join(ROOT, 'lib', 'sandbox', 'vehicle-path.mjs');
export const PATH_VIEWER = path.join(ROOT, 'public', 'sandbox', 'vehicle-path.js');

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [from, to] of [[TERRAIN_SOURCE, TERRAIN_VIEWER], [PATH_SOURCE, PATH_VIEWER]]) {
    writeFileSync(to, readFileSync(from));
    console.log(`wrote ${path.relative(ROOT, to)}`);
  }
}
