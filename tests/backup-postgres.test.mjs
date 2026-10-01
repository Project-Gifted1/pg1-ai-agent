/**
 * Tests for the nightly encrypted Postgres backup script and its paired
 * restore docs (issue #225): scripts/backup-postgres.sh, docs/BACKUPS.md.
 * Run with: node --test tests/backup-postgres.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'backup-postgres.sh');
const docsPath = path.join(repoRoot, 'docs', 'BACKUPS.md');

test('backup-postgres.sh exists, is executable, and dumps+encrypts', () => {
  const stat = fs.statSync(scriptPath);
  assert.ok(stat.mode & 0o111, 'expected scripts/backup-postgres.sh to be executable');

  const script = fs.readFileSync(scriptPath, 'utf8');
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /SUPABASE_DB_URL:\?/, 'expected SUPABASE_DB_URL to be required');
  assert.match(script, /BACKUP_ENCRYPTION_PASSPHRASE:\?/, 'expected BACKUP_ENCRYPTION_PASSPHRASE to be required');
  assert.match(script, /pg_dump\b/);
  assert.match(script, /--format=custom/);
  assert.match(script, /gpg\b.*--symmetric/s);
  assert.match(script, /\.dump\.gpg/);
});

test('BACKUPS.md documents the restore procedure filtering the public schema TOC entry', () => {
  const docs = fs.readFileSync(docsPath, 'utf8');

  assert.match(docs, /pg_restore --list/, 'expected docs to list the TOC before restoring');
  assert.match(docs, /SCHEMA - public/, 'expected docs to filter the public schema TOC entry');
  assert.match(docs, /--use-list=/, 'expected docs to restore from the filtered list');
  assert.match(docs, /gpg --batch --yes --quiet/, 'expected a decrypt step matching the backup script');
  assert.match(docs, /SUPABASE_DB_URL/);
  assert.match(docs, /BACKUP_ENCRYPTION_PASSPHRASE/);
});

test('backup script and docs agree on the dump format flags', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');
  const docs = fs.readFileSync(docsPath, 'utf8');

  assert.ok(script.includes('--no-owner') && script.includes('--no-acl'));
  assert.ok(docs.includes('--no-owner') && docs.includes('--no-acl'),
    'expected restore docs to also pass --no-owner --no-acl, matching how the dump was taken');
});
