# Postgres backups

The production database is a hosted Supabase Postgres instance (there is no
local Postgres in this repo — see `supabase/migrations/` for schema history).
Backups are taken nightly as encrypted `pg_dump` archives and must be
restored with the filtered procedure below, because Supabase projects already
own the `public` schema and replaying its `CREATE SCHEMA public` entry fails
the restore.

## Nightly backup

`scripts/backup-postgres.sh` runs `pg_dump` against `SUPABASE_DB_URL` in
custom (`-Fc`) format, then encrypts the dump with `gpg` using
`BACKUP_ENCRYPTION_PASSPHRASE`:

```bash
SUPABASE_DB_URL="postgres://..." \
BACKUP_ENCRYPTION_PASSPHRASE="..." \
scripts/backup-postgres.sh backups
```

This writes `backups/pg1-<UTC timestamp>.dump.gpg`. The unencrypted dump is
deleted as soon as encryption succeeds.

| Env var | Description |
| --- | --- |
| `SUPABASE_DB_URL` | Direct (non-pooler) Postgres connection string for the project, e.g. `postgres://postgres:<password>@db.<ref>.supabase.co:5432/postgres`. |
| `BACKUP_ENCRYPTION_PASSPHRASE` | Symmetric passphrase used for AES-256 encryption of the dump. |

A scheduled workflow invoking this script nightly (e.g. `0 3 * * *`) and
uploading the resulting `.gpg` file to durable storage (artifact/bucket) is
the intended automation; adding the workflow YAML itself is outside what this
assistant can commit (GitHub App permissions block edits under
`.github/workflows/`), so a maintainer needs to add that trigger by hand —
see [Restore](#restore) below for how any such backup is brought back.

## Restore

Restoring a backup taken by the script above is a three-step process: decrypt,
filter the table of contents, then restore from the filtered list.

### 1. Decrypt

```bash
gpg --batch --yes --quiet \
  --passphrase-file <(printf '%s' "$BACKUP_ENCRYPTION_PASSPHRASE") \
  --output pg1-restore.dump \
  pg1-20260101T030000Z.dump.gpg
```

### 2. Filter out the `CREATE SCHEMA public` TOC entry

Supabase (and other managed Postgres) projects already have a `public` schema
owned by a fixed role. Restoring the dump's `CREATE SCHEMA public` entry
on top of it fails with `schema "public" already exists` and aborts the rest
of the restore. List the table of contents and drop that one entry before
restoring:

```bash
pg_restore --list pg1-restore.dump | grep -v 'SCHEMA - public' > pg1-restore.list
```

The dropped line looks like `3; 2615 2200 SCHEMA - public postgres` — it is
the only TOC entry with object type `SCHEMA` and tag `public`, so the grep
filter is specific to it and leaves every table/data/index entry untouched.

### 3. Restore from the filtered list

```bash
pg_restore \
  --no-owner \
  --no-acl \
  --dbname="$SUPABASE_DB_URL" \
  --use-list=pg1-restore.list \
  pg1-restore.dump
```

`--use-list` replays only the entries present in `pg1-restore.list`, i.e.
everything except the schema-creation entry filtered out in step 2.
`--no-owner --no-acl` avoid replaying ownership/grants tied to the roles of
the source project, which won't exist by the same name on the restore
target.

### Verifying a restore

After restoring, confirm row counts on a couple of key tables against the
source, e.g.:

```bash
psql "$SUPABASE_DB_URL" -c "select count(*) from pg1_errors;"
```

## Notes on this verification pass

The `pg_dump`/`pg_restore`/`gpg` commands above were validated against the
Postgres archive-format documentation and manual pages, not by executing them
against a live database: this sandbox has no local Postgres server (no
`initdb`/running instance), the project only ever talks to hosted Supabase,
and this automation's Bash allowlist doesn't include `pg_dump`, `pg_restore`,
`psql`, or `gpg`. If a maintainer wants these commands exercised end-to-end
in CI, add a `postgres:` service container to the workflow and extend
`--allowedTools` with `Bash(pg_dump:*),Bash(pg_restore:*),Bash(psql:*),Bash(gpg:*)`.
