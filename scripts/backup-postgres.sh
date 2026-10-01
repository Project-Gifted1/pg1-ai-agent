#!/usr/bin/env bash
#
# Nightly encrypted backup of the Supabase Postgres database.
#
# Usage:
#   scripts/backup-postgres.sh [output-dir]
#
# Required env vars:
#   SUPABASE_DB_URL              Direct (non-pooler) postgres:// connection string.
#   BACKUP_ENCRYPTION_PASSPHRASE  Symmetric passphrase used to encrypt the dump with gpg.
#
# Produces:
#   <output-dir>/pg1-<UTC timestamp>.dump.gpg
#
# See docs/BACKUPS.md for the matching restore procedure, including how to
# filter the `CREATE SCHEMA public` TOC entry before restoring into Supabase.
set -euo pipefail

: "${SUPABASE_DB_URL:?SUPABASE_DB_URL is required}"
: "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE is required}"

OUT_DIR="${1:-backups}"
mkdir -p "$OUT_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_FILE="$OUT_DIR/pg1-${TIMESTAMP}.dump"
ENC_FILE="${DUMP_FILE}.gpg"

cleanup() {
  rm -f "$DUMP_FILE"
}
trap cleanup EXIT

pg_dump "$SUPABASE_DB_URL" \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="$DUMP_FILE"

gpg --batch --yes --quiet \
  --symmetric --cipher-algo AES256 \
  --passphrase-file <(printf '%s' "$BACKUP_ENCRYPTION_PASSPHRASE") \
  --output "$ENC_FILE" \
  "$DUMP_FILE"

echo "Wrote encrypted backup to $ENC_FILE"
