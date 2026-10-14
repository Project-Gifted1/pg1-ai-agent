-- No raw IP addresses or licence keys at rest (EU operator; GDPR data
-- minimisation). The one migration for this change.
--
-- The code now writes:
--   free_tier_usage.identifier   freeTierKey(ip): salted HMAC-SHA256 of the
--                                caller IP (lib/telemetry.mjs callerHash,
--                                salt TELEMETRY_IP_SALT), 32 lowercase hex.
--   api_access_logs.license_key  one of these labels, never a raw IP or key:
--                                  license:<32 hex>    licenceKeyHash(key), the
--                                                      same salt, domain-separated
--                                  free-tier:<32 hex>  the caller hash above
--                                  x402:<0x + 40 hex>  the payer wallet, or
--                                  x402:unknown-payer
--                                  free-feed           the STIX feed while free
--                                  redacted            a key with no salt set
--
-- This migration:
--   1. Creates free_tier_usage if it is missing.
--   2. Deletes free_tier_usage rows that are not a hash (the raw-IP rows).
--      RESET rather than hash: hashing in SQL would need the secret salt,
--      and the table only holds daily counters, so the cost is that callers
--      seen today get a fresh 5 free calls once.
--   3. Makes free_tier_usage accept only hashes (check constraint).
--   4. Indexes usage_date for the 7-day retention delete
--      (/api/errors/cleanup -> purgeExpiredFreeTierUsage).
--   5. Deletes the api_access_logs rows that recorded a free-tier caller as
--      "free-tier:<raw IP>".
--   6. Overwrites every other api_access_logs.license_key that is not one of
--      the labels above (raw Gumroad licence keys, and any other legacy
--      value) with 'redacted'. The rows are kept (endpoint, status, time);
--      only the key is cleared. Rehashing is not possible in SQL without the
--      secret salt.
--   7. Makes api_access_logs accept only those labels (check constraint), so
--      a raw licence key or IP can never be stored again, by this code or
--      any other.
--
-- ORDER: deploy the code first, then run this. Run before the deploy, the old
-- code's raw-IP and raw-key inserts would fail the new constraints (they are
-- best-effort, so the free tier would stop counting and access logging would
-- stop until the deploy).
--
-- Safe to run more than once: create/index "if not exists", each constraint
-- dropped "if exists" before it is added, and the deletes and the update
-- match nothing on a second run. Neither table is created by an earlier
-- migration (both were created by hand), so each step checks it exists.

-- 1. free_tier_usage exists.
create table if not exists public.free_tier_usage (
  identifier text not null,
  usage_date date not null,
  request_count int not null default 1,
  primary key (identifier, usage_date)
);

-- 2. Raw-IP counters removed (DELETES rows).
delete from public.free_tier_usage where identifier !~ '^[0-9a-f]{32}$';

-- 3. Only hashes from now on.
alter table public.free_tier_usage drop constraint if exists free_tier_usage_identifier_hashed;
alter table public.free_tier_usage
  add constraint free_tier_usage_identifier_hashed check (identifier ~ '^[0-9a-f]{32}$');

-- 4. Retention index.
create index if not exists free_tier_usage_usage_date_idx on public.free_tier_usage (usage_date);

-- 5-7. api_access_logs (only if the table exists).
do $$
begin
  if to_regclass('public.api_access_logs') is not null then
    -- 5. "free-tier:<raw IP>" rows removed (DELETES rows).
    delete from public.api_access_logs
    where license_key like 'free-tier:%'
      and license_key !~ '^free-tier:[0-9a-f]{32}$';

    -- 6. Raw licence keys and other unknown labels cleared (UPDATES rows,
    --    deletes none).
    update public.api_access_logs
    set license_key = 'redacted'
    where license_key is not null
      and license_key !~ '^(license:[0-9a-f]{32}|free-tier:[0-9a-f]{32}|x402:(0x[0-9a-fA-F]{40}|unknown-payer)|free-feed|redacted)$';

    -- 7. Only those labels from now on.
    alter table public.api_access_logs drop constraint if exists api_access_logs_license_key_hashed;
    alter table public.api_access_logs
      add constraint api_access_logs_license_key_hashed check (
        license_key ~ '^(license:[0-9a-f]{32}|free-tier:[0-9a-f]{32}|x402:(0x[0-9a-fA-F]{40}|unknown-payer)|free-feed|redacted)$'
      );
  end if;
end $$;
