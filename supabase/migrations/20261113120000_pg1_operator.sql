-- PG1 as the operator of its own service (lib/operator): the scheduled
-- daily and weekly reports, and the tasks PG1 makes from their findings
-- (fix, improve, new, listing, pricing), with the lab experiment, the PR,
-- the low-risk auto-merge, the production deploy it watches and any
-- rollback. Also lets an approval card expire (7 days without a decision).
--
-- Additive only: two new tables and one widened check. Deletes no data.
-- Service role only (RLS on, no policies), like the other pg1_* tables.
-- Run it yourself in the Supabase SQL editor; PG1 never runs SQL.

create table if not exists public.pg1_operator_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('daily', 'weekly')),
  period_start timestamptz not null,
  period_end timestamptz not null,
  title text not null check (char_length(title) <= 200),
  markdown text not null check (char_length(markdown) <= 60000),
  card jsonb not null default '{}'::jsonb,
  approvals jsonb not null default '[]'::jsonb,
  document_id uuid,
  delivered_at timestamptz
);
create index if not exists pg1_operator_reports_kind_idx on public.pg1_operator_reports (kind, created_at desc);
alter table public.pg1_operator_reports enable row level security;

create table if not exists public.pg1_operator_tasks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finding_key text not null unique check (char_length(finding_key) <= 120),
  kind text not null check (kind in ('fix', 'improve', 'new', 'listing', 'pricing')),
  title text not null check (char_length(title) <= 200),
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in (
    'open', 'lab_running', 'pr_open', 'watching', 'merged', 'rolled_back',
    'needs_approval', 'approved', 'declined', 'expired', 'done', 'failed'
  )),
  experiment_id uuid,
  pr_number integer,
  pr_url text check (char_length(pr_url) <= 300),
  -- When the task's PR was found open: the clock for a stuck required check.
  pr_opened_at timestamptz,
  merge_sha text check (char_length(merge_sha) <= 64),
  merged_at timestamptz,
  auto_merged boolean not null default false,
  deploy_id text check (char_length(deploy_id) <= 80),
  previous_deploy_id text check (char_length(previous_deploy_id) <= 80),
  approval jsonb,
  approval_requested_at timestamptz,
  decided_at timestamptz,
  detail text check (char_length(detail) <= 1000)
);
create index if not exists pg1_operator_tasks_status_idx on public.pg1_operator_tasks (status, updated_at desc);
alter table public.pg1_operator_tasks enable row level security;

-- An approval card nobody decided in 7 days becomes 'expired'.
alter table public.pg1_autonomous_actions drop constraint if exists pg1_autonomous_actions_status_check;
alter table public.pg1_autonomous_actions add constraint pg1_autonomous_actions_status_check
  check (status in ('queued', 'running', 'done', 'failed', 'cancelled', 'stopped', 'refused', 'needs_approval', 'approved', 'rejected', 'expired'));
