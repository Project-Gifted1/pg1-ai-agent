-- PG1 lab and feature flags (lib/lab, lib/flags.mjs).
--
--   pg1_lab_experiments  one row per /lab start: kind (research | skill |
--                        code), goal, budget_usd and spent_usd, the GitHub
--                        run, the runner's result (report, drafts, eval
--                        results, the draft PR), the promotion candidate,
--                        the gate's evidence, the approval card's token and
--                        the rollout stage (none | operator | public |
--                        declined). No caller identifiers. Kept 180 days
--                        (lib/retention.mjs).
--   pg1_feature_flags    one row per promoted thing: stage operator | public
--                        | disabled, the thresholds the hourly monitor
--                        applies (max_error_rate, max_cost_per_call_usd,
--                        min_calls), cost_task (the usage-ledger task its
--                        calls are recorded under), and why it was disabled.
--
-- The lab's spend goes on the existing usage ledger (pg1_ai_usage, task
-- 'lab'); this migration does not change that table.
--
-- Service role only: RLS on, nothing for anon/authenticated.
-- NOT APPLIED AUTOMATICALLY. Safe to run more than once. Deletes no data.

create table if not exists public.pg1_lab_experiments (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  kind text not null,
  goal text not null,
  status text not null default 'queued',
  budget_usd numeric(8, 2) not null,
  spent_usd numeric(10, 6) not null default 0,
  run_id bigint,
  result jsonb,
  candidate jsonb,
  gate jsonb,
  approval_token text,
  promoted_stage text not null default 'none',
  error text
);

alter table public.pg1_lab_experiments drop constraint if exists pg1_lab_experiments_kind_check;
alter table public.pg1_lab_experiments drop constraint if exists pg1_lab_experiments_status_check;
alter table public.pg1_lab_experiments drop constraint if exists pg1_lab_experiments_budget_check;
alter table public.pg1_lab_experiments drop constraint if exists pg1_lab_experiments_stage_check;
alter table public.pg1_lab_experiments drop constraint if exists pg1_lab_experiments_goal_check;

alter table public.pg1_lab_experiments
  add constraint pg1_lab_experiments_kind_check check (kind in ('research', 'skill', 'code')),
  add constraint pg1_lab_experiments_status_check check (status in ('queued', 'running', 'done', 'failed', 'over_budget', 'timeout', 'stopped')),
  add constraint pg1_lab_experiments_budget_check check (budget_usd > 0 and budget_usd <= 10 and spent_usd >= 0),
  add constraint pg1_lab_experiments_stage_check check (promoted_stage in ('none', 'operator', 'public', 'declined')),
  add constraint pg1_lab_experiments_goal_check check (char_length(goal) between 1 and 1000);

create index if not exists pg1_lab_experiments_created_idx on public.pg1_lab_experiments (created_at desc);
create index if not exists pg1_lab_experiments_status_idx on public.pg1_lab_experiments (status);

create table if not exists public.pg1_feature_flags (
  key text primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  kind text not null default 'tool',
  stage text not null default 'operator',
  experiment_id uuid,
  thresholds jsonb not null default '{}'::jsonb,
  cost_task text,
  disabled_reason text
);

alter table public.pg1_feature_flags drop constraint if exists pg1_feature_flags_key_check;
alter table public.pg1_feature_flags drop constraint if exists pg1_feature_flags_stage_check;
alter table public.pg1_feature_flags drop constraint if exists pg1_feature_flags_kind_check;
alter table public.pg1_feature_flags drop constraint if exists pg1_feature_flags_cost_task_check;

alter table public.pg1_feature_flags
  add constraint pg1_feature_flags_key_check check (key ~ '^[a-z0-9:_-]{2,64}$'),
  add constraint pg1_feature_flags_stage_check check (stage in ('operator', 'public', 'disabled')),
  add constraint pg1_feature_flags_kind_check check (kind in ('skill', 'code', 'tool', 'source', 'job')),
  add constraint pg1_feature_flags_cost_task_check check (cost_task is null or char_length(cost_task) <= 16);

alter table public.pg1_lab_experiments enable row level security;
alter table public.pg1_feature_flags enable row level security;
revoke all on public.pg1_lab_experiments from public, anon, authenticated;
revoke all on public.pg1_feature_flags from public, anon, authenticated;

notify pgrst, 'reload schema';
