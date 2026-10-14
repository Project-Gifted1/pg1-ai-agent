-- MANUAL, run by hand only after checking. NOT a migration.
--
-- Clears the plain-text licence keys from alert_subscriptions once every
-- row has license_key_hash (scripts/alert-subscriptions-backfill-hash.mjs).
--
-- 1. Check: must return 0 before going on.
select count(*) as rows_without_hash
  from public.alert_subscriptions
 where license_key is not null and license_key_hash is null;

-- 2. Blank the plain keys (DESTROYS the plain-text values; the hashes stay).
update public.alert_subscriptions set license_key = null where license_key is not null;

-- 3. Drop the column (DESTROYS the column).
alter table public.alert_subscriptions drop column license_key;
