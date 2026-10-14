-- pg1_autonomy_log: the audit trail of PG1's autonomous decisions
-- (lib/autonomy.mjs). One row per decision: the action, its tier (FREE,
-- APPROVAL, NEVER, EXTERNAL), who started it (pg1, operator, external,
-- lab), the decision (allowed, denied, needs_approval), the autonomy mode
-- at the time (PG1_AUTONOMY off|lab|on), the cost in USD, the outcome and a
-- short fixed-word detail. Never content, a caller, an address or a key.
--
-- Append-only for the server: the service role may insert and read, but
-- UPDATE, DELETE and TRUNCATE are revoked and a trigger refuses them, so
-- PG1 cannot rewrite or switch off its own audit log. The only deletion is
-- pg1_autonomy_log_purge(), which removes rows older than 365 days (the
-- retention limit) and is what the daily cleanup calls.
--
-- RLS on, nothing for anon/authenticated.
-- NOT APPLIED AUTOMATICALLY. Safe to run more than once. The purge function
-- deletes rows older than 365 days when it is called; running this
-- migration deletes nothing.

create table if not exists public.pg1_autonomy_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  action text not null,
  tier text not null,
  actor text not null default 'pg1',
  decision text not null,
  mode text not null,
  cost_usd numeric(12, 6) not null default 0,
  outcome text,
  detail text,
  request_id text
);

alter table public.pg1_autonomy_log drop constraint if exists pg1_autonomy_log_tier_check;
alter table public.pg1_autonomy_log drop constraint if exists pg1_autonomy_log_actor_check;
alter table public.pg1_autonomy_log drop constraint if exists pg1_autonomy_log_decision_check;
alter table public.pg1_autonomy_log drop constraint if exists pg1_autonomy_log_mode_check;
alter table public.pg1_autonomy_log drop constraint if exists pg1_autonomy_log_sizes_check;

alter table public.pg1_autonomy_log
  add constraint pg1_autonomy_log_tier_check check (tier in ('FREE', 'APPROVAL', 'NEVER', 'EXTERNAL')),
  add constraint pg1_autonomy_log_actor_check check (actor in ('pg1', 'operator', 'external', 'lab')),
  add constraint pg1_autonomy_log_decision_check check (decision in ('allowed', 'denied', 'needs_approval')),
  add constraint pg1_autonomy_log_mode_check check (mode in ('off', 'lab', 'on')),
  add constraint pg1_autonomy_log_sizes_check check (char_length(action) <= 64 and char_length(coalesce(detail, '')) <= 200 and cost_usd >= 0);

create index if not exists pg1_autonomy_log_at_idx on public.pg1_autonomy_log (at desc);

alter table public.pg1_autonomy_log enable row level security;
revoke all on public.pg1_autonomy_log from public, anon, authenticated;
revoke update, delete, truncate on public.pg1_autonomy_log from service_role;
grant select, insert on public.pg1_autonomy_log to service_role;

-- Refuses UPDATE and DELETE unless the purge function below set the flag.
create or replace function public.pg1_autonomy_log_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(current_setting('pg1.autonomy_purge', true), '') <> 'on' then
    raise exception 'pg1_autonomy_log is append-only';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'pg1_autonomy_log is append-only';
  end if;
  return old;
end;
$$;

drop trigger if exists pg1_autonomy_log_append_only on public.pg1_autonomy_log;
create trigger pg1_autonomy_log_append_only
  before update or delete on public.pg1_autonomy_log
  for each row execute function public.pg1_autonomy_log_guard();

-- Retention: rows older than 365 days. Returns how many were removed.
create or replace function public.pg1_autonomy_log_purge()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  perform set_config('pg1.autonomy_purge', 'on', true);
  delete from public.pg1_autonomy_log where at < now() - interval '365 days';
  get diagnostics n = row_count;
  perform set_config('pg1.autonomy_purge', 'off', true);
  return n;
end;
$$;

revoke all on function public.pg1_autonomy_log_purge() from public, anon, authenticated;
grant execute on function public.pg1_autonomy_log_purge() to service_role;

notify pgrst, 'reload schema';
