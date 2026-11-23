-- PG1 1.23.0: requests to delete a free key and its email, made WITHOUT the
-- key (lib/keysApi.mjs). Deleting by email alone would let anyone who knows
-- an address revoke someone else's key, so a request with only an email is
-- recorded here and the operator performs it (/keys delete-request <id>
-- approve) within 30 days. With the key itself, deletion is immediate and
-- nothing is recorded here.
--
-- Stored: a hash of the email (never the address), when, and the status.
-- One pending request per email. Service role only.
--
-- Additive only: one new table. NOT APPLIED AUTOMATICALLY: run it yourself
-- in the Supabase SQL editor. Run it after 20261122120000_pg1_paid_checks.sql.
-- Safe to run more than once. Until it runs, a request without the key gets
-- the same answer and is written to the error log (so it is not lost), and
-- the daily report shows "Key deletion requests: not read".

create table if not exists public.pg1_key_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'done', 'declined')),
  decided_at timestamptz,
  deleted_keys integer check (deleted_keys is null or deleted_keys >= 0)
);
create unique index if not exists pg1_key_deletion_requests_one_pending
  on public.pg1_key_deletion_requests (email_hash) where status = 'pending';
create index if not exists pg1_key_deletion_requests_created on public.pg1_key_deletion_requests (created_at desc);
alter table public.pg1_key_deletion_requests enable row level security;
revoke all on public.pg1_key_deletion_requests from anon, authenticated;

notify pgrst, 'reload schema';

-- Read-only checks after running:
--   select count(*) from public.pg1_key_deletion_requests;                                -- 0 at first
--   select relrowsecurity from pg_class where relname = 'pg1_key_deletion_requests';      -- true
--   select status, count(*) from public.pg1_key_deletion_requests group by 1;
