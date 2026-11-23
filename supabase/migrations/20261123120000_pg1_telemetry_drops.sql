-- PG1: a record of telemetry rows that could not be written (lib/telemetry.mjs).
--
-- agent_telemetry inserts are batched and retried with backoff; a row is
-- dropped only when its insert is refused for good or gets no answer after
-- every retry. Each such drop is written here as a count and a time window,
-- never the rows themselves, so the daily report can say exactly how many
-- rows were lost and when (its "Errors by fault" section), and the ERROR LOG
-- warning names the same count.
--
-- Additive only: one new table. NOT APPLIED AUTOMATICALLY: run it yourself
-- in the Supabase SQL editor; PG1 never runs SQL. Safe to run more than once.
-- Service role only. Until it runs, the warning still names the count, and
-- the daily report shows "Telemetry rows dropped: not read".

create table if not exists public.pg1_telemetry_drops (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  first_dropped_at timestamptz not null,
  last_dropped_at timestamptz not null,
  rows_dropped integer not null check (rows_dropped > 0),
  reason text not null check (char_length(reason) <= 40),
  check (last_dropped_at >= first_dropped_at)
);
create index if not exists pg1_telemetry_drops_last_idx on public.pg1_telemetry_drops (last_dropped_at desc);
alter table public.pg1_telemetry_drops enable row level security;
revoke all on public.pg1_telemetry_drops from anon, authenticated;

notify pgrst, 'reload schema';

-- Read-only checks after running:
--   select count(*) from public.pg1_telemetry_drops;                                      -- 0 at first
--   select relrowsecurity from pg_class where relname = 'pg1_telemetry_drops';            -- true
--   select sum(rows_dropped) from public.pg1_telemetry_drops where last_dropped_at > now() - interval '24 hours';
