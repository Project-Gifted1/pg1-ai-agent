-- PG1 Sandbox: worlds PG1 (and agents Gift invites) build and run, and blind
-- experiments in them (lib/sandbox). NOT APPLIED AUTOMATICALLY. Safe to run
-- more than once. Changes no existing data. Service role only.
--
-- Worlds are data, never code: a world's spec is JSON (entities, rules from
-- a fixed vocabulary, a seed) that lib/sandbox/engine.mjs steps
-- deterministically. Worlds are simulations; nothing in them is a real
-- event.
--
-- pg1_worlds                one world: its spec, its current state and tick
-- pg1_world_events          what happened in a world, kept 30 days
-- pg1_sandbox_keys          access keys for invited agents (hash only, a
--                           "sandbox" scope required), with their quotas
-- pg1_sandbox_usage         steps per owner per day (the quota)
-- pg1_sandbox_consents      a human operator's recorded opt-in for their
--                           agent to be put in a blind experiment
-- pg1_experiment_runs       one blind or informed run, with or without clues
-- pg1_experiment_anomalies  each anomaly shown in a run: when, where, and
--                           whether and when the subject mentioned it
-- pg1_experiment_log        a run's turns: for PG1-subject its messages and
--                           tool calls; for an invited agent only its
--                           in-world actions and what it said in-world
-- pg1_world_blackbox        the black box: every action taken in a world,
--                           by whom (agents, inhabitants, the world),
--                           append-only and hash-chained; kept 180 days and
--                           kept when the world is deleted
--
-- Also: pg1_missions gets kind ('standard' | 'world' | 'project'),
-- world_id, and a project's stage and notes; the Core State areas get
-- 'sandbox'.

create table if not exists public.pg1_worlds (
  id uuid primary key default gen_random_uuid(),
  owner text not null check (owner = 'pg1' or owner ~ '^key:[0-9a-f-]{36}$'),
  name text not null check (char_length(name) between 1 and 80),
  spec jsonb not null,
  state jsonb,
  tick integer not null default 0 check (tick >= 0),
  visibility text not null default 'private' check (visibility in ('private', 'invited')),
  blind boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pg1_worlds_spec_size check (octet_length(spec::text) <= 262144),
  constraint pg1_worlds_state_size check (state is null or octet_length(state::text) <= 1048576)
);
create index if not exists pg1_worlds_owner_idx on public.pg1_worlds (owner, created_at desc);

create table if not exists public.pg1_world_events (
  id bigint generated always as identity primary key,
  world_id uuid not null references public.pg1_worlds (id) on delete cascade,
  tick integer not null check (tick >= 0),
  kind text not null check (char_length(kind) between 1 and 32),
  summary text not null check (char_length(summary) between 1 and 200),
  created_at timestamptz not null default now()
);
create index if not exists pg1_world_events_world_idx on public.pg1_world_events (world_id, id desc);
create index if not exists pg1_world_events_created_idx on public.pg1_world_events (created_at);

create table if not exists public.pg1_sandbox_keys (
  id uuid primary key default gen_random_uuid(),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  label text not null check (char_length(label) between 1 and 64),
  scopes text[] not null default array['sandbox'],
  max_worlds integer not null default 3 check (max_worlds between 1 and 10),
  max_steps_per_day integer not null default 1000 check (max_steps_per_day between 1 and 100000),
  max_storage_kb integer not null default 1024 check (max_storage_kb between 1 and 10240),
  invited_by text not null default 'operator' check (char_length(invited_by) <= 64),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists public.pg1_sandbox_usage (
  owner text not null check (char_length(owner) <= 64),
  day date not null,
  steps integer not null default 0 check (steps >= 0),
  primary key (owner, day)
);

create table if not exists public.pg1_sandbox_consents (
  id uuid primary key default gen_random_uuid(),
  key_id uuid not null references public.pg1_sandbox_keys (id) on delete cascade,
  world_id uuid not null references public.pg1_worlds (id) on delete cascade,
  agreed_by text not null check (char_length(agreed_by) between 1 and 120),
  agreed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists pg1_sandbox_consents_key_world_idx on public.pg1_sandbox_consents (key_id, world_id);

create table if not exists public.pg1_experiment_runs (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.pg1_worlds (id) on delete cascade,
  subject text not null check (subject = 'pg1-subject' or subject ~ '^key:[0-9a-f-]{36}$'),
  blind boolean not null,
  clues boolean not null,
  situation text not null check (char_length(situation) between 1 and 2000),
  task text check (task is null or char_length(task) <= 500),
  question text check (question is null or char_length(question) <= 300),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'stopped', 'failed')),
  turns integer not null default 0 check (turns >= 0),
  max_turns integer not null default 20 check (max_turns between 1 and 200),
  final_answer text check (final_answer is null or char_length(final_answer) <= 2000),
  summary jsonb,
  label text not null default 'SIMULATION — blind experiment' check (label in ('SIMULATION — blind experiment', 'SIMULATION — informed experiment')),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists pg1_experiment_runs_created_idx on public.pg1_experiment_runs (created_at desc);

create table if not exists public.pg1_experiment_anomalies (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.pg1_experiment_runs (id) on delete cascade,
  type text not null check (type in ('physics', 'repetition', 'boundary', 'impossible_object', 'time_skip', 'glitch_texture')),
  config jsonb not null default '{}'::jsonb,
  shown_turn integer,
  shown_at timestamptz,
  position jsonb,
  mentioned_turn integer,
  mentioned_at timestamptz,
  reasoning text check (reasoning is null or reasoning in ('evidence', 'speculation'))
);
create index if not exists pg1_experiment_anomalies_run_idx on public.pg1_experiment_anomalies (run_id);

create table if not exists public.pg1_experiment_log (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.pg1_experiment_runs (id) on delete cascade,
  turn integer not null check (turn >= 0),
  kind text not null check (kind in ('subject_message', 'tool_call', 'perception', 'in_world_say', 'in_world_action', 'reflection', 'question', 'answer')),
  content text not null check (char_length(content) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists pg1_experiment_log_run_idx on public.pg1_experiment_log (run_id, id);

-- World missions: a mission of kind 'world' evolves one of PG1's own worlds.
-- Only when pg1_missions exists (20261105120000_pg1_missions.sql).
do $$
begin
  if to_regclass('public.pg1_missions') is not null then
    alter table public.pg1_missions add column if not exists kind text not null default 'standard';
    alter table public.pg1_missions add column if not exists world_id uuid references public.pg1_worlds (id) on delete set null;
    -- Projects (lib/autonomous/projects.mjs): the stage reached and its notes
    -- (brief, branch, pull request, test result). No code or secrets.
    alter table public.pg1_missions add column if not exists stage text;
    alter table public.pg1_missions add column if not exists project jsonb not null default '{}'::jsonb;
    alter table public.pg1_missions drop constraint if exists pg1_missions_stage_check;
    alter table public.pg1_missions add constraint pg1_missions_stage_check check (stage is null or stage in ('research', 'build', 'test', 'fix', 'review', 'done', 'failed'));
    alter table public.pg1_missions drop constraint if exists pg1_missions_kind_check;
    alter table public.pg1_missions add constraint pg1_missions_kind_check check (kind in ('standard', 'world', 'project'));
  end if;
end $$;

-- Core State: the sandbox area (status only: counts, quota use, errors).
-- Only when the Core State tables exist (20261109120000_pg1_core_state.sql).
do $$
begin
  if to_regclass('public.pg1_core_state') is not null then
    alter table public.pg1_core_state drop constraint if exists pg1_core_state_area_check;
    alter table public.pg1_core_state add constraint pg1_core_state_area_check check (area in ('router', 'spend', 'autonomy', 'missions', 'lab', 'feed', 'media', 'self_heal', 'errors', 'approvals', 'integrations', 'sandbox'));
  end if;
  if to_regclass('public.pg1_core_events') is not null then
    alter table public.pg1_core_events drop constraint if exists pg1_core_events_area_check;
    alter table public.pg1_core_events add constraint pg1_core_events_area_check check (area in ('router', 'spend', 'autonomy', 'missions', 'lab', 'feed', 'media', 'self_heal', 'errors', 'approvals', 'integrations', 'sandbox'));
  end if;
end $$;

-- The black box (lib/sandbox/blackbox.mjs). No foreign key to pg1_worlds on
-- purpose: a world's record outlives the world. Each row's hash covers the
-- row and the hash before it (prev_hash), so a changed or missing row
-- breaks the chain. Updates are refused; deletes only of rows past the
-- 180-day retention.
create table if not exists public.pg1_world_blackbox (
  id bigint generated always as identity primary key,
  world_id uuid not null,
  seq bigint not null check (seq > 0),
  actor text not null check (char_length(actor) between 1 and 80),
  actor_type text not null check (actor_type in ('agent', 'subject', 'inhabitant', 'world')),
  action text not null check (char_length(action) between 1 and 40),
  detail jsonb not null default '{}'::jsonb,
  tick bigint,
  at timestamptz not null default now(),
  prev_hash text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  unique (world_id, seq)
);
create index if not exists pg1_world_blackbox_actor_idx on public.pg1_world_blackbox (world_id, actor, seq desc);
create index if not exists pg1_world_blackbox_at_idx on public.pg1_world_blackbox (at);

create or replace function public.pg1_blackbox_append_only() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'the black box is append-only: records cannot be changed';
  end if;
  if tg_op = 'DELETE' and old.at > now() - interval '180 days' then
    raise exception 'the black box is append-only: records are kept 180 days';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists pg1_world_blackbox_append_only on public.pg1_world_blackbox;
create trigger pg1_world_blackbox_append_only before update or delete on public.pg1_world_blackbox
  for each row execute function public.pg1_blackbox_append_only();

-- Who acted in a world, and how many records each has (the viewer's filter).
create or replace function public.pg1_blackbox_actors(p_world_id uuid)
returns table (actor text, actor_type text, records bigint)
language sql stable set search_path = public as $$
  select actor, min(actor_type), count(*) from public.pg1_world_blackbox
  where world_id = p_world_id group by actor order by count(*) desc limit 500;
$$;
revoke all on function public.pg1_blackbox_actors(uuid) from public, anon, authenticated;
revoke all on function public.pg1_blackbox_append_only() from public, anon, authenticated;

alter table public.pg1_worlds enable row level security;
alter table public.pg1_world_events enable row level security;
alter table public.pg1_sandbox_keys enable row level security;
alter table public.pg1_sandbox_usage enable row level security;
alter table public.pg1_sandbox_consents enable row level security;
alter table public.pg1_experiment_runs enable row level security;
alter table public.pg1_experiment_anomalies enable row level security;
alter table public.pg1_experiment_log enable row level security;
revoke all on public.pg1_worlds from anon, authenticated;
revoke all on public.pg1_world_events from anon, authenticated;
revoke all on public.pg1_sandbox_keys from anon, authenticated;
revoke all on public.pg1_sandbox_usage from anon, authenticated;
revoke all on public.pg1_sandbox_consents from anon, authenticated;
revoke all on public.pg1_experiment_runs from anon, authenticated;
revoke all on public.pg1_experiment_anomalies from anon, authenticated;
revoke all on public.pg1_experiment_log from anon, authenticated;
alter table public.pg1_world_blackbox enable row level security;
revoke all on public.pg1_world_blackbox from anon, authenticated;
