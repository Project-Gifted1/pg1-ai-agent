-- pg1_documents: PDFs made by PG1 (lib/pdf), the media library's documents
-- shelf. The file is in the pg1-vault bucket at storage_path
-- (documents/<id>.pdf); this row records what it is and when it expires.
--
--   source      what made it: chat (/pdf <request>), reply ("make this a
--               PDF"), thread (/pdf thread), usage (/pdf usage),
--               film_storyboard (/film storyboard <id>), a2a, foundry, lab
--   expires_at  the daily cleanup (api/errors/cleanup.mjs ->
--               lib/retention.mjs) deletes the file and the row after it:
--               PG1_PDF_RETENTION_DAYS (default 90) for the operator's
--               documents, 7 days for A2A job outputs
--
-- No caller identifiers are stored. Service role only: RLS on, no
-- policies, nothing granted to anon or authenticated.
--
-- NOT APPLIED AUTOMATICALLY. Safe to run more than once. Deletes no data.

create table if not exists public.pg1_documents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 days'),
  title text not null,
  pages integer not null,
  bytes integer not null,
  source text not null default 'chat',
  storage_path text not null,
  request_id text
);

alter table public.pg1_documents drop constraint if exists pg1_documents_title_check;
alter table public.pg1_documents drop constraint if exists pg1_documents_pages_check;
alter table public.pg1_documents drop constraint if exists pg1_documents_bytes_check;
alter table public.pg1_documents drop constraint if exists pg1_documents_source_check;
alter table public.pg1_documents drop constraint if exists pg1_documents_path_check;

alter table public.pg1_documents
  add constraint pg1_documents_title_check check (char_length(title) between 1 and 200),
  add constraint pg1_documents_pages_check check (pages between 1 and 500),
  add constraint pg1_documents_bytes_check check (bytes > 0),
  add constraint pg1_documents_source_check check (source in ('chat', 'reply', 'thread', 'usage', 'film_storyboard', 'a2a', 'foundry', 'lab')),
  add constraint pg1_documents_path_check check (storage_path like 'documents/%');

create index if not exists pg1_documents_created_idx on public.pg1_documents (created_at desc);
create index if not exists pg1_documents_expires_idx on public.pg1_documents (expires_at);

alter table public.pg1_documents enable row level security;
revoke all on public.pg1_documents from public, anon, authenticated;

notify pgrst, 'reload schema';
