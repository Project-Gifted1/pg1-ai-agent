-- PG1 Sandbox: worlds PG1 (and agents Gift invites) build and run, and blind
-- experiments in them (lib/sandbox). NOT APPLIED AUTOMATICALLY. Can be run
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
-- pg1_sandbox_usage         steps and changes per owner per day (the quotas)
-- pg1_sandbox_consents      a human operator's recorded opt-in for their
--                           agent to be put in a blind experiment
-- pg1_experiment_runs       one blind or informed run, with or without clues
-- pg1_experiment_anomalies  each anomaly shown in a run: when, where, and
--                           whether and when the subject mentioned it
-- pg1_experiment_log        a run's turns: for PG1-subject its messages and
--                           tool calls; for an invited agent only its
--                           in-world actions and what it said in-world
-- pg1_world_blackbox        the black box: every action taken in a world,
--                           by whom, append-only and hash-chained in two
--                           chains per world: long (agents and subjects,
--                           kept 180 days) and short (inhabitants' notable
--                           events and daily summaries, kept 30 days);
--                           kept when the world is deleted
-- pg1_blackbox_purges       the audit of every operator purge: who, why,
--                           how many, and the hash the chain re-anchors to
--
-- Also: pg1_missions gets kind ('standard' | 'world') and world_id; the
-- Core State areas get 'sandbox'.

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
  actions integer not null default 0 check (actions >= 0),
  primary key (owner, day)
);
alter table public.pg1_sandbox_usage add column if not exists actions integer not null default 0 check (actions >= 0);

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
-- Only when pg1_missions exists (20261105120000_pg1_missions.sql). The kind
-- check is added only when missing, so a later migration may widen it.
do $$
begin
  if to_regclass('public.pg1_missions') is not null then
    alter table public.pg1_missions add column if not exists kind text not null default 'standard';
    alter table public.pg1_missions add column if not exists world_id uuid references public.pg1_worlds (id) on delete set null;
    if not exists (select 1 from pg_constraint where conname = 'pg1_missions_kind_check' and conrelid = 'public.pg1_missions'::regclass) then
      alter table public.pg1_missions add constraint pg1_missions_kind_check check (kind in ('standard', 'world'));
    end if;
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
-- purpose: a world's record outlives the world. Two chains per world, each
-- numbered from 1: long (agents, blind subjects) and short (inhabitants and
-- the world: notable events and one summary per in-world day). Each row's
-- hash covers the row and the hash before it in its chain (prev_hash), so a
-- changed or missing row breaks the chain. A row's detail is at most
-- 2,048 bytes. Updates are refused; deletes are allowed only past the
-- chain's retention (short 30 days, long 180) or through the operator's
-- purge function, which writes an audit row. Both remove a chain's oldest
-- rows, and the application then writes a checkpoint row with the hash of
-- the last one removed, so the rest still verifies.
create table if not exists public.pg1_world_blackbox (
  id bigint generated always as identity primary key,
  world_id uuid not null,
  chain text not null check (chain in ('long', 'short')),
  seq bigint not null check (seq > 0),
  actor text not null check (char_length(actor) between 1 and 80),
  actor_type text not null check (actor_type in ('agent', 'subject', 'inhabitant', 'world', 'system')),
  action text not null check (char_length(action) between 1 and 40),
  detail jsonb not null default '{}'::jsonb check (octet_length(detail::text) <= 2048),
  tick bigint,
  at timestamptz not null default now(),
  prev_hash text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  unique (world_id, chain, seq),
  constraint pg1_world_blackbox_chain_actor check (
    (chain = 'long' and actor_type in ('agent', 'subject', 'system'))
    or (chain = 'short' and actor_type in ('inhabitant', 'world', 'system')))
);
create index if not exists pg1_world_blackbox_world_idx on public.pg1_world_blackbox (world_id, id desc);
create index if not exists pg1_world_blackbox_actor_idx on public.pg1_world_blackbox (world_id, actor, id desc);
create index if not exists pg1_world_blackbox_chain_at_idx on public.pg1_world_blackbox (chain, at);

-- Every operator purge: who, why, how many, and the hash the chain re-anchors to.
create table if not exists public.pg1_blackbox_purges (
  id bigint generated always as identity primary key,
  world_id uuid not null,
  chain text not null check (chain in ('long', 'short')),
  through_seq bigint not null check (through_seq > 0),
  anchor_hash text not null check (anchor_hash ~ '^[0-9a-f]{64}$'),
  removed bigint not null check (removed >= 0),
  who text not null check (char_length(who) between 1 and 80),
  why text not null check (char_length(why) between 1 and 500),
  at timestamptz not null default now()
);
create index if not exists pg1_blackbox_purges_world_idx on public.pg1_blackbox_purges (world_id, at desc);

create or replace function public.pg1_blackbox_append_only() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'the black box is append-only: records cannot be changed';
  end if;
  -- DELETE: the operator's purge (pg1_blackbox_purge), or past retention.
  if coalesce(current_setting('pg1.blackbox_purge', true), '') = 'on' then
    return old;
  end if;
  if old.chain = 'short' and old.at <= now() - interval '30 days' then
    return old;
  end if;
  if old.at <= now() - interval '180 days' then
    return old;
  end if;
  raise exception 'the black box is append-only: records are kept 30 days (inhabitants) or 180 days (agents and subjects)';
end $$;
drop trigger if exists pg1_world_blackbox_append_only on public.pg1_world_blackbox;
create trigger pg1_world_blackbox_append_only before update or delete on public.pg1_world_blackbox
  for each row execute function public.pg1_blackbox_append_only();

-- Operator only: remove a chain's records up to p_through_seq (its oldest),
-- keeping at least the newest, and write the audit row. Returns the audit
-- row, or nothing when there is no such record.
create or replace function public.pg1_blackbox_purge(p_world_id uuid, p_chain text, p_through_seq bigint, p_who text, p_why text)
returns setof public.pg1_blackbox_purges
language plpgsql set search_path = public as $$
declare
  v_hash text;
  v_head bigint;
  v_removed bigint;
begin
  if coalesce(btrim(p_who), '') = '' or coalesce(btrim(p_why), '') = '' then
    raise exception 'a purge needs who and why';
  end if;
  select b.hash into v_hash from public.pg1_world_blackbox b
    where b.world_id = p_world_id and b.chain = p_chain and b.seq = p_through_seq;
  if v_hash is null then
    return;
  end if;
  select max(b.seq) into v_head from public.pg1_world_blackbox b
    where b.world_id = p_world_id and b.chain = p_chain;
  if p_through_seq >= v_head then
    raise exception 'a purge keeps at least the newest record of the chain';
  end if;
  perform set_config('pg1.blackbox_purge', 'on', true);
  delete from public.pg1_world_blackbox b
    where b.world_id = p_world_id and b.chain = p_chain and b.seq <= p_through_seq;
  get diagnostics v_removed = row_count;
  perform set_config('pg1.blackbox_purge', 'off', true);
  return query insert into public.pg1_blackbox_purges (world_id, chain, through_seq, anchor_hash, removed, who, why)
    values (p_world_id, p_chain, p_through_seq, v_hash, v_removed, left(btrim(p_who), 80), left(btrim(p_why), 500))
    returning *;
end $$;

-- Retention: per world, the last record of a chain older than the cutoff
-- (never the newest), its hash, and how many records go with it.
create or replace function public.pg1_blackbox_prune_plan(p_chain text, p_cutoff timestamptz)
returns table (world_id uuid, through_seq bigint, anchor_hash text, removed bigint)
language sql stable set search_path = public as $$
  with heads as (
    select b.world_id, max(b.seq) as head from public.pg1_world_blackbox b
    where b.chain = p_chain group by b.world_id
  ), last as (
    select b.world_id, max(b.seq) as through_seq from public.pg1_world_blackbox b
    join heads h on h.world_id = b.world_id
    where b.chain = p_chain and b.at < p_cutoff and b.seq < h.head
    group by b.world_id
  )
  select l.world_id, l.through_seq, b.hash,
    (select count(*) from public.pg1_world_blackbox c where c.world_id = l.world_id and c.chain = p_chain and c.seq <= l.through_seq)
  from last l
  join public.pg1_world_blackbox b on b.world_id = l.world_id and b.chain = p_chain and b.seq = l.through_seq
  limit 500;
$$;

-- The short chain's size, for one world and in all: the budgets
-- (lib/sandbox/blackbox.mjs BLACKBOX_BUDGETS).
create or replace function public.pg1_blackbox_counts(p_world_id uuid)
returns table (world_rows bigint, global_rows bigint)
language sql stable set search_path = public as $$
  select (select count(*) from public.pg1_world_blackbox where chain = 'short' and world_id = p_world_id),
         (select count(*) from public.pg1_world_blackbox where chain = 'short');
$$;

-- Who acted in a world, and how many records each has (the viewer's filter).
create or replace function public.pg1_blackbox_actors(p_world_id uuid)
returns table (actor text, actor_type text, records bigint)
language sql stable set search_path = public as $$
  select actor, min(actor_type), count(*) from public.pg1_world_blackbox
  where world_id = p_world_id group by actor order by count(*) desc limit 500;
$$;
revoke all on function public.pg1_blackbox_actors(uuid) from public, anon, authenticated;
revoke all on function public.pg1_blackbox_counts(uuid) from public, anon, authenticated;
revoke all on function public.pg1_blackbox_prune_plan(text, timestamptz) from public, anon, authenticated;
revoke all on function public.pg1_blackbox_purge(uuid, text, bigint, text, text) from public, anon, authenticated;
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
alter table public.pg1_blackbox_purges enable row level security;
revoke all on public.pg1_world_blackbox from anon, authenticated;
revoke all on public.pg1_blackbox_purges from anon, authenticated;
