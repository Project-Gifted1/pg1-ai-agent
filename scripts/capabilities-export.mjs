// Writes lib/capabilities/registry.json from lib/capabilities/registry.mjs.
// tests/capabilities.test.mjs fails when the two differ, so run this after
// any registry change:  node scripts/capabilities-export.mjs

import { writeFileSync } from 'node:fs';
import { registryJson } from '../lib/capabilities/registry.mjs';

const out = new URL('../lib/capabilities/registry.json', import.meta.url);
writeFileSync(out, JSON.stringify(registryJson(), null, 2) + '\n');
console.log(`wrote ${out.pathname}`);
