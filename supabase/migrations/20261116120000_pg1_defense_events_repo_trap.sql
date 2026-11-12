-- PG1 1.22.0: check_repo_trap verdicts in pg1_defense_events (the Kingdom's
-- Repo Trap Scanner). Widens two check constraints: check_name may now be
-- 'check_repo_trap' and endpoint may be '/api/repo-trap'. Stored as before:
-- the check, the verdict code, PG1's own reason codes, the country and the
-- salted caller hash. Never a path, a project name or any file content.
--
-- Additive only: no data is changed or deleted. NOT APPLIED AUTOMATICALLY:
-- run it yourself in the Supabase SQL editor; PG1 never runs SQL. Until it
-- runs, check_repo_trap rows fail the old constraint and the recorder drops
-- them silently (lib/defenseEvents.mjs never throws). Safe to run more than once.

alter table public.pg1_defense_events drop constraint if exists pg1_defense_events_check_name_check;
alter table public.pg1_defense_events
  add constraint pg1_defense_events_check_name_check check (check_name in (
    'check_agent_message', 'check_repo_trap', 'check_hostname_reputation', 'check_domain_age',
    'check_wallet_sanctions', 'check_package', 'preflight_check'
  ));
alter table public.pg1_defense_events drop constraint if exists pg1_defense_events_endpoint_check;
alter table public.pg1_defense_events
  add constraint pg1_defense_events_endpoint_check check (endpoint in ('/api/mcp', '/api/a2a', '/api/preflight', '/api/repo-trap'));

notify pgrst, 'reload schema';
