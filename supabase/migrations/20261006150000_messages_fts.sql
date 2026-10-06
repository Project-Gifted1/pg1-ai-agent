-- public.messages: full-text search for the operator-only search_history
-- chat tool (lib/historySearch.mjs, lib/chatTools.mjs).
--
-- Why: the chat loads only the last 12 messages into its context, so it
-- cannot recall anything older. search_history queries this table with
-- PostgREST's wfts operator (websearch_to_tsquery('english', ...)) on the
-- generated column below, newest first, at most 10 rows.
--
-- What it adds:
--   content_tsv  tsvector, generated from content (english config), stored.
--                Only the first 100000 characters are indexed: a tsvector is
--                capped at 1 MB, and an over-long message must never make
--                the chat's own insert fail.
--   messages_content_tsv_idx  GIN index on content_tsv.
--   messages_created_at_idx   btree on created_at (newest-first ordering,
--                             date-range filters, and the existing
--                             "last 12 messages" read).
--
-- Adding a stored generated column rewrites the table once (existing rows
-- are indexed as part of it). Inserts from api/chat.mjs name only role and
-- content, so they are unchanged.
--
-- Access is unchanged: RLS on, nothing granted to anon or authenticated
-- (20260921000000_security_advisor_fixes.sql); every read and write goes
-- through the service-role key.
--
-- Safe to run more than once.

alter table public.messages
  add column if not exists content_tsv tsvector
  generated always as (to_tsvector('english'::regconfig, left(coalesce(content::text, ''), 100000))) stored;

create index if not exists messages_content_tsv_idx
  on public.messages using gin (content_tsv);

create index if not exists messages_created_at_idx
  on public.messages (created_at desc);

-- PostgREST caches the schema; tell it about the new column now.
notify pgrst, 'reload schema';
