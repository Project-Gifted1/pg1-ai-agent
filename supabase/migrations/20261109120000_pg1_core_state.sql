-- PG1 Core State: the shared workspace every module publishes to, and the
-- lessons PG1 proposes from its reflections (lib/core/state.mjs,
-- lib/core/reflect.mjs). NOT APPLIED AUTOMATICALLY. Safe to run more than
-- once. Changes no existing data. Service role only.
--
-- pg1_core_state   one row per area, its latest snapshot (JSON). Never
--                  secrets, keys, tokens, client data or request content:
--                  lib/core/state.mjs sanitizes every snapshot first.
-- pg1_core_events  append-only, what happened in an area; kept 30 days
--                  (the hourly pulse deletes older rows).
-- pg1_core_lessons durable lessons from reflections: proposed until the
--                  operator approves them; only approved lessons are used,
--                  and only as hints.
-- Until this runs, each server instance keeps the state in memory.

create table if not exists public.pg1_core_state (
  area text primary key check (area in ('router', 'spend', 'autonomy', 'missions', 'lab', 'feed', 'media', 'self_heal', 'errors', 'approvals', 'integrations')),
  snapshot jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.pg1_core_events (
  id bigint generated always as identity primary key,
  area text not null check (area in ('router', 'spend', 'autonomy', 'missions', 'lab', 'feed', 'media', 'self_heal', 'errors', 'approvals', 'integrations')),
  kind text not null check (char_length(kind) between 1 and 40),
  severity text not null default 'info' check (severity in ('info', 'warning', 'error')),
  summary text not null check (char_length(summary) between 1 and 300),
  ref text check (ref is null or char_length(ref) <= 120),
  created_at timestamptz not null default now()
);
create index if not exists pg1_core_events_created_idx on public.pg1_core_events (created_at desc);
create index if not exists pg1_core_events_area_idx on public.pg1_core_events (area, created_at desc);

create table if not exists public.pg1_core_lessons (
  id uuid primary key default gen_random_uuid(),
  text text not null check (char_length(text) between 3 and 400),
  source_event text check (source_event is null or char_length(source_event) <= 120),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pg1_core_lessons_status_idx on public.pg1_core_lessons (status, created_at desc);

alter table public.pg1_core_state enable row level security;
alter table public.pg1_core_events enable row level security;
alter table public.pg1_core_lessons enable row level security;
revoke all on public.pg1_core_state from anon, authenticated;
revoke all on public.pg1_core_events from anon, authenticated;
revoke all on public.pg1_core_lessons from anon, authenticated;
