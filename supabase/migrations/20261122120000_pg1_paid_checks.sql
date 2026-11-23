-- PG1 1.23.0: plans for check_agent_message and check_repo_trap (lib/plans.mjs).
--
--   pg1_api_keys     PG1's own keys: free keys from /keys (with the holder's
--                    email and consent) and Team member keys (tied to a Team
--                    licence account). Only sha256(key) is stored, never the
--                    key. One active free key per email.
--   pg1_check_usage  one row per counter and period: anonymous callers (by
--                    salted IP hash, per day), free keys (per email, per day),
--                    Builder and Team licences (per licence account, per
--                    month), and the per-IP signup/delete limits (per day).
--   pg1_check_usage_take(subject, period, tier, limit)
--                    one more use when under the limit; returns the new
--                    count, or -1 when the limit is reached. Atomic.
--   pg1_check_usage_refund(subject, period)
--                    gives one use back (a check that failed on bad input).
--
-- Additive only: no existing table or row is changed. NOT APPLIED
-- AUTOMATICALLY: run it yourself in the Supabase SQL editor; PG1 never runs
-- SQL. Safe to run more than once. Service role only (row level security on,
-- no policies; anon and authenticated have no access).
--
-- Until it runs: the free-key signup answers 503 ("try again in a few
-- minutes") and the checks are served uncounted (the meter fails open; the
-- hourly abuse limits still apply). Nothing breaks for anyone else.

create table if not exists public.pg1_api_keys (
  id uuid primary key default gen_random_uuid(),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  key_hint text not null check (char_length(key_hint) <= 12),
  tier text not null check (tier in ('free', 'team')),
  email text check (email is null or char_length(email) <= 254),
  email_hash text check (email_hash is null or email_hash ~ '^[0-9a-f]{64}$'),
  account text check (account is null or char_length(account) <= 60),
  label text check (label is null or char_length(label) <= 60),
  consent_at timestamptz,
  consent_version text check (consent_version is null or char_length(consent_version) <= 20),
  marketing_opt_in boolean not null default false,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint pg1_api_keys_free_has_email check (tier <> 'free' or (email is not null and email_hash is not null and consent_at is not null)),
  constraint pg1_api_keys_team_has_account check (tier <> 'team' or account is not null)
);
create unique index if not exists pg1_api_keys_one_active_free_per_email
  on public.pg1_api_keys (email_hash) where tier = 'free' and revoked_at is null;
create index if not exists pg1_api_keys_account_active
  on public.pg1_api_keys (account) where revoked_at is null;
create index if not exists pg1_api_keys_created_at on public.pg1_api_keys (created_at);
alter table public.pg1_api_keys enable row level security;
revoke all on public.pg1_api_keys from anon, authenticated;

create table if not exists public.pg1_check_usage (
  subject text not null check (char_length(subject) <= 80),
  period text not null check (period ~ '^[0-9]{4}-[0-9]{2}(-[0-9]{2})?$'),
  tier text not null check (tier in ('anonymous', 'free', 'builder', 'team', 'signup')),
  used integer not null default 0 check (used >= 0),
  updated_at timestamptz not null default now(),
  primary key (subject, period)
);
create index if not exists pg1_check_usage_updated_at on public.pg1_check_usage (updated_at);
alter table public.pg1_check_usage enable row level security;
revoke all on public.pg1_check_usage from anon, authenticated;

create or replace function public.pg1_check_usage_take(p_subject text, p_period text, p_tier text, p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v integer;
begin
  if p_limit is not null and p_limit <= 0 then
    return -1;
  end if;
  insert into public.pg1_check_usage as u (subject, period, tier, used, updated_at)
  values (p_subject, p_period, p_tier, 1, now())
  on conflict (subject, period) do update
    set used = u.used + 1, updated_at = now()
    where p_limit is null or u.used < p_limit
  returning u.used into v;
  return coalesce(v, -1);
end;
$$;

create or replace function public.pg1_check_usage_refund(p_subject text, p_period text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.pg1_check_usage
     set used = greatest(used - 1, 0), updated_at = now()
   where subject = p_subject and period = p_period;
$$;

revoke all on function public.pg1_check_usage_take(text, text, text, integer) from public, anon, authenticated;
revoke all on function public.pg1_check_usage_refund(text, text) from public, anon, authenticated;
grant execute on function public.pg1_check_usage_take(text, text, text, integer) to service_role;
grant execute on function public.pg1_check_usage_refund(text, text) to service_role;

notify pgrst, 'reload schema';

-- Read-only checks after running (each should return what the comment says):
--   select count(*) from public.pg1_api_keys;                         -- 0 on first run
--   select count(*) from public.pg1_check_usage;                      -- 0 on first run
--   select relrowsecurity from pg_class where relname in ('pg1_api_keys', 'pg1_check_usage');  -- true, true
--   select proname from pg_proc where proname like 'pg1_check_usage_%' order by 1;            -- _refund, _take
