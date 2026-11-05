-- PG1 Kingdom Defence (lib/defenseEvents.mjs, lib/defenseFeed.mjs,
-- api/defense-feed.mjs): the real defence events the Kingdom view draws.
--
--   agent_telemetry.country_code   the request's country (ISO 3166-1
--                                  alpha-2) from Vercel's x-vercel-ip-country
--                                  header, recorded at ingest. Never the IP.
--                                  Null when the header is absent ("the fog").
--   pg1_defense_events             one row per defence verdict a PG1 check
--                                  returned to a caller: check_agent_message
--                                  malicious / suspicious, a flagged
--                                  check_hostname_reputation, check_domain_age,
--                                  check_wallet_sanctions or check_package,
--                                  and a flagged preflight_check. Stored: the
--                                  check, the verdict code, the reason codes
--                                  (PG1's frozen list, lib/reasonCodes.mjs),
--                                  the country, the salted caller hash and,
--                                  for check_agent_message, the kind the
--                                  caller declared (skill_md, message, other).
--                                  Never the IP, a user agent, a key, a
--                                  wallet, a domain, a package name or any
--                                  message content.
--
-- Additive only: one nullable column and one new table. Deletes no data.
-- Service role only (RLS on, nothing granted to anon or authenticated), like
-- the other pg1_* tables. NOT APPLIED AUTOMATICALLY: run it yourself in the
-- Supabase SQL editor; PG1 never runs SQL. Until it runs, telemetry rows are
-- written without the country (lib/telemetry.mjs retries once without the
-- column) and the defence recorder drops its rows silently.
-- Safe to run more than once.

alter table public.agent_telemetry add column if not exists country_code text;
alter table public.agent_telemetry drop constraint if exists agent_telemetry_country_code_check;
alter table public.agent_telemetry
  add constraint agent_telemetry_country_code_check check (country_code is null or country_code ~ '^[A-Z]{2}$');
create index if not exists agent_telemetry_created_idx on public.agent_telemetry (created_at desc);

create table if not exists public.pg1_defense_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  check_name text not null check (check_name in (
    'check_agent_message', 'check_hostname_reputation', 'check_domain_age',
    'check_wallet_sanctions', 'check_package', 'preflight_check'
  )),
  endpoint text not null check (endpoint in ('/api/mcp', '/api/a2a', '/api/preflight')),
  verdict_code text not null check (verdict_code ~ '^[a-z_]{2,24}$'),
  reason_codes text[] not null default '{}' check (array_length(reason_codes, 1) is null or array_length(reason_codes, 1) <= 8),
  severity text not null check (severity in ('low', 'medium', 'high')),
  subject_kind text check (subject_kind is null or subject_kind in ('skill_md', 'message', 'other')),
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  caller_hash text check (caller_hash is null or caller_hash ~ '^[0-9a-f]{32}$')
);
create index if not exists pg1_defense_events_created_idx on public.pg1_defense_events (created_at desc);
alter table public.pg1_defense_events enable row level security;
revoke all on public.pg1_defense_events from public, anon, authenticated;

notify pgrst, 'reload schema';
