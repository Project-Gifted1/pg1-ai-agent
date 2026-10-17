-- Missions: the operator's standing goals for Autonomous mode (/mission add
-- "<goal>" [hourly|every 6h|daily|weekly], /mission list, /mission pause,
-- /mission remove; lib/autonomous/missions.mjs). NOT APPLIED AUTOMATICALLY.
-- Safe to run more than once. Changes no existing data. Service role only.
--
-- A mission runs on its schedule only while Autonomous mode is ON: PG1
-- plans up to three read-only tasks for it (feed check, engine check,
-- integration check, research note) on a free engine and runs them within
-- the guardrails; each run is one row in pg1_autonomous_actions (type
-- mission). Nothing a mission does spends money, publishes, merges,
-- deploys or changes data.

create table if not exists public.pg1_missions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  goal text not null check (char_length(goal) between 3 and 300),
  schedule text not null default 'daily' check (char_length(schedule) <= 20),
  interval_minutes integer not null default 1440 check (interval_minutes between 60 and 10080),
  status text not null default 'active' check (status in ('active', 'paused', 'removed')),
  last_run_at timestamptz,
  next_run_at timestamptz not null default now()
);
create index if not exists pg1_missions_due_idx on public.pg1_missions (status, next_run_at);

alter table public.pg1_missions enable row level security;
revoke all on public.pg1_missions from anon, authenticated;
