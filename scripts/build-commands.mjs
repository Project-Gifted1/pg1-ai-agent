// Writes public/commands.json from the command registry
// (lib/commands/registry.mjs): what the page's command panel and its
// command chips read. Run after changing the registry:
//   npm run commands:build
// tests/command-registry.test.mjs fails while the file and the registry differ.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandsForClient } from '../lib/commands/registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMMANDS_JSON = path.join(ROOT, 'public', 'commands.json');

export function commandsJsonText() {
  return `${JSON.stringify(commandsForClient(), null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(COMMANDS_JSON, commandsJsonText());
  console.log(`wrote ${path.relative(ROOT, COMMANDS_JSON)}`);
}
