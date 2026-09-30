-- pg1_errors: server + client error log (issue #201 Phase 2b).
--
-- Grouped by (source, route, status, reason) while unresolved: repeated
-- occurrences of the same failure increment `count` and bump `last_seen`
-- instead of creating a new row every time, so both the ERROR LOG modal and
-- the "what's broken?" chat summary (api/chat.mjs) stay readable during a
-- repeated failure. Written via plain PostgREST reads/writes from
-- lib/errorLog.mjs - no DB function required, same accepted read-then-write
-- race tradeoff as lib/freeTier.mjs's free_tier_usage table.
--
-- Row lifecycle: api/chat.mjs writes source='server' rows for unexpected
-- 4xx/5xx from its own routes (excluding 402 paywall responses and the
-- silent voice-profile fallback). api/errors.mjs writes source='client'
-- rows from the browser's local error log (never with message text - see
-- that file). Rows older than 30 days are deleted by the
-- /api/errors/cleanup cron (see vercel.json), not by SQL, so no pg_cron
-- extension is required.
create table if not exists public.pg1_errors (
  id uuid primary key default gen_random_uuid(),
  time timestamptz not null default now(),
  source text not null check (source in ('server', 'client')),
  route text not null,
  status integer,
  reason text,
  message text,
  count integer not null default 1,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  resolved boolean not null default false
);

-- Speeds up the read-then-write grouping lookup in lib/errorLog.mjs (one
-- query per error, filtered on exactly these columns plus resolved=false).
create index if not exists pg1_errors_lookup_idx
  on public.pg1_errors (source, route, status, reason)
  where resolved = false;

-- Speeds up both the ERROR LOG modal's "newest first" list and the
-- "unresolved errors in the last 24h" chat-context query.
create index if not exists pg1_errors_last_seen_idx
  on public.pg1_errors (last_seen desc);

-- Service-role only, same reasoning as public.pending_actions and
-- public.messages in 20260921000000_security_advisor_fixes.sql: every read
-- and write goes through lib/errorLog.mjs / api/chat.mjs / api/errors.mjs
-- using the service-role key, never the anon/authenticated PostgREST role.
alter table public.pg1_errors enable row level security;
revoke all on public.pg1_errors from anon, authenticated;
