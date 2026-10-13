-- Free tier without raw IP addresses (EU operator; GDPR data minimisation).
--
-- lib/freeTier.mjs now keys free_tier_usage by freeTierKey(ip): the salted
-- HMAC-SHA256 of the caller IP that lib/telemetry.mjs callerHash computes
-- (salt TELEMETRY_IP_SALT), 32 lowercase hex characters. It never writes an
-- IP. This migration:
--
-- 1. Deletes every free_tier_usage row whose identifier is not such a hash
--    (the raw-IP rows written before this change). RESET rather than hash:
--    hashing here would need the secret salt in SQL, and the table only
--    holds daily counters, so the cost is that callers seen today get a
--    fresh 5 free calls once.
-- 2. Makes the table accept only hashes from now on (check constraint), so a
--    raw IP can never be stored again, by this code or any other.
-- 3. Indexes usage_date for the daily retention delete (rows older than 7
--    days, /api/errors/cleanup -> purgeExpiredFreeTierUsage).
-- 4. Deletes the api_access_logs rows that recorded a free-tier caller as
--    "free-tier:<raw IP>" (/api/ioc now writes "free-tier:<hash>").
--
-- ORDER: deploy the code first, then run this. Run before the deploy, the
-- old code's raw-IP inserts would fail the new constraint, and since the
-- increment is best-effort the free tier would stop counting until deploy.
--
-- Safe to run more than once. Neither table is created by an earlier
-- migration (both were created by hand), so each step checks it exists.

do $$
begin
  if to_regclass('public.free_tier_usage') is null then
    create table public.free_tier_usage (
      identifier text not null,
      usage_date date not null,
      request_count int not null default 1,
      primary key (identifier, usage_date)
    );
  end if;
end $$;

delete from public.free_tier_usage where identifier !~ '^[0-9a-f]{32}$';

alter table public.free_tier_usage drop constraint if exists free_tier_usage_identifier_hashed;
alter table public.free_tier_usage
  add constraint free_tier_usage_identifier_hashed check (identifier ~ '^[0-9a-f]{32}$');

create index if not exists free_tier_usage_usage_date_idx on public.free_tier_usage (usage_date);

do $$
begin
  if to_regclass('public.api_access_logs') is not null then
    delete from public.api_access_logs
    where license_key like 'free-tier:%'
      and license_key !~ '^free-tier:[0-9a-f]{32}$';
  end if;
end $$;
