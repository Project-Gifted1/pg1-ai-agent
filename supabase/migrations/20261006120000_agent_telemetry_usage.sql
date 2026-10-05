-- agent_telemetry, part 2: enough to answer "how many agents used our
-- tools this week?" (lib/telemetry.mjs writes, lib/usageStats.mjs reads).
--
-- New columns, all optional so rows written by the previous deploy still
-- insert:
--   client_name / client_version - the MCP initialize clientInfo, cut to
--     64 / 32 characters and reduced to a plain character set before it is
--     stored. Only set on event_type 'initialize' rows.
--   caller_hash - HMAC-SHA256 of the caller IP with a server-side secret
--     salt, first 32 hex characters. Never the raw IP.
--   is_fixture - true for an integration-test fixture call
--     (lib/fixtures.mjs). The usage stats exclude these rows.
--
-- Rows record which PG1 route and tool were used and how it ended - never
-- message contents, tool arguments, wallet addresses, domains or other
-- values a caller queried.
--
-- Retention: rows older than 90 days are deleted daily by the
-- /api/errors/cleanup cron (vercel.json), not by SQL, same as pg1_errors.
alter table public.agent_telemetry
  add column if not exists client_name text check (client_name is null or char_length(client_name) <= 64),
  add column if not exists client_version text check (client_version is null or char_length(client_version) <= 32),
  add column if not exists caller_hash text check (caller_hash is null or caller_hash ~ '^[0-9a-f]{32}$'),
  add column if not exists is_fixture boolean not null default false;

-- 'initialize' is one row per MCP initialize handshake.
alter table public.agent_telemetry drop constraint if exists agent_telemetry_event_type_check;
alter table public.agent_telemetry add constraint agent_telemetry_event_type_check
  check (event_type in ('tool_call', 'settlement', 'initialize'));

-- The stats read and the retention delete both filter on created_at; this
-- one also covers the is_fixture = false filter on every stats read.
create index if not exists agent_telemetry_fixture_created_at_idx
  on public.agent_telemetry (is_fixture, created_at desc);
