-- alert_subscriptions: licence keys stop being stored in plain text.
--
-- The code (api/mcp.mjs handleSubscribeAlerts) now writes
--   alert_subscriptions.license_key_hash  licenceKeyHash(key): HMAC-SHA256
--                                         with TELEMETRY_IP_SALT (or the
--                                         derived fallback), domain-separated
--                                         ("pg1-licence-key-v1:"), first 32
--                                         lowercase hex characters. The same
--                                         hash api_access_logs stores as
--                                         license:<hash>.
-- and no longer writes license_key.
--
-- This migration (deletes nothing, blanks nothing):
--   1. Adds license_key_hash (nullable; old rows are filled by the backfill).
--   2. Allows license_key to be NULL, so new rows can omit it. The existing
--      plain-text values stay exactly as they are.
--   3. Constrains license_key_hash to the hash shape.
--   4. Indexes license_key_hash for lookups by hash.
--
-- BACKFILL: hashing needs the secret salt, which must not be typed into the
-- SQL editor, so the backfill is a script run with the production env:
--   node scripts/alert-subscriptions-backfill-hash.mjs          (dry run)
--   node scripts/alert-subscriptions-backfill-hash.mjs --apply  (writes)
-- It only fills license_key_hash where it is NULL; it never touches
-- license_key.
--
-- ORDER: run this migration first, then deploy the code (the new code writes
-- license_key_hash, which must exist), then run the backfill.
--
-- Clearing the plain column is a SEPARATE step, run by hand after checking
-- that every row has a hash:
--   supabase/manual/alert_subscriptions_drop_plain_key.sql

alter table if exists public.alert_subscriptions
  add column if not exists license_key_hash text;

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'alert_subscriptions' and column_name = 'license_key') then
    alter table public.alert_subscriptions alter column license_key drop not null;
  end if;
  if to_regclass('public.alert_subscriptions') is not null
     and not exists (select 1 from pg_constraint where conname = 'alert_subscriptions_license_key_hash_shape') then
    alter table public.alert_subscriptions
      add constraint alert_subscriptions_license_key_hash_shape
      check (license_key_hash is null or license_key_hash ~ '^[0-9a-f]{32}$');
  end if;
end $$;

create index if not exists alert_subscriptions_license_key_hash_idx
  on public.alert_subscriptions (license_key_hash);
