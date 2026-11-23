-- PG1 1.23.0: the caller's plan on agent_telemetry rows for the metered
-- checks (check_agent_message, check_repo_trap), so /usage can count calls
-- by tier: anonymous, free (free key), builder, team, partner. Pay-per-check
-- calls are the rows with payment_type 'x402'. Null on every other row.
--
-- Additive only: one nullable column and its check; no data changes. NOT
-- APPLIED AUTOMATICALLY: run it yourself in the Supabase SQL editor. Safe to
-- run more than once. Until it runs, lib/telemetry.mjs retries the insert
-- without the column (the row is kept, only the plan is left off).

alter table public.agent_telemetry add column if not exists plan text;
alter table public.agent_telemetry drop constraint if exists agent_telemetry_plan_check;
alter table public.agent_telemetry
  add constraint agent_telemetry_plan_check check (plan is null or plan in ('anonymous', 'free', 'builder', 'team', 'partner'));

notify pgrst, 'reload schema';

-- Read-only checks after running:
--   select column_name, data_type from information_schema.columns
--    where table_schema = 'public' and table_name = 'agent_telemetry' and column_name = 'plan';  -- plan | text
--   select plan, count(*) from public.agent_telemetry group by 1;    -- only null before 1.23.0 traffic
