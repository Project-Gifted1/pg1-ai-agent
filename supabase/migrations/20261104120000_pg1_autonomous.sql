-- Autonomous mode (the ON/OFF switch in the Command Centre header,
-- lib/autonomous/state.mjs): one shared state row and the audit log of every
-- autonomous action. NOT APPLIED AUTOMATICALLY. Safe to run more than once.
-- Changes no existing data. Service role only (RLS on, no policies for anon
-- or authenticated): the server reads and writes these, the browser never
-- does.
--
-- pg1_autonomous_state: exactly one row (id 'global'). enabled is the
-- switch; changed_by says whether the operator or an automatic safety stop
-- (auto_off) set it last, and reason why. max_actions_per_hour (default 30)
-- and daily_budget_usd (default 0: free tiers only) are the guardrails the
-- operator sets with /auto limit and /auto budget.
--
-- pg1_autonomous_actions: one row per autonomous action: when, its type,
-- why, a short summary of its inputs, its status and result, its cost and
-- a link (a draft PR) when there is one. Approval cards are rows with
-- status needs_approval and an approval object (what to approve, the dry
-- run's result). body is a longer report (the daily briefing) that the app
-- shows in chat once (delivered_at). No secrets or personal data: the server scrubs every text
-- field before it writes (lib/autonomous/state.mjs scrub).
--
-- Until this runs, the switch reads as OFF and no autonomous action starts.

create table if not exists public.pg1_autonomous_state (
  id text primary key default 'global' check (id = 'global'),
  enabled boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by text not null default 'operator' check (changed_by in ('operator', 'auto_off')),
  reason text check (char_length(reason) <= 200),
  max_actions_per_hour integer not null default 30 check (max_actions_per_hour between 1 and 1000),
  daily_budget_usd numeric(10, 2) not null default 0 check (daily_budget_usd >= 0)
);
insert into public.pg1_autonomous_state (id) values ('global') on conflict (id) do nothing;

alter table public.pg1_autonomous_state enable row level security;
revoke all on public.pg1_autonomous_state from anon, authenticated;

create table if not exists public.pg1_autonomous_actions (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  type text not null check (char_length(type) <= 40),
  reason text check (char_length(reason) <= 200),
  inputs_summary text check (char_length(inputs_summary) <= 300),
  status text not null check (status in ('queued', 'running', 'done', 'failed', 'cancelled', 'stopped', 'refused', 'needs_approval', 'approved', 'rejected')),
  result text check (char_length(result) <= 500),
  cost_usd numeric(10, 4) not null default 0 check (cost_usd >= 0),
  link text check (char_length(link) <= 300),
  finished_at timestamptz,
  approval jsonb,
  body text check (char_length(body) <= 4000),
  delivered_at timestamptz
);
create index if not exists pg1_autonomous_actions_at_idx on public.pg1_autonomous_actions (at desc);
create index if not exists pg1_autonomous_actions_type_at_idx on public.pg1_autonomous_actions (type, at desc);
create index if not exists pg1_autonomous_actions_status_idx on public.pg1_autonomous_actions (status) where status in ('queued', 'running', 'needs_approval');

alter table public.pg1_autonomous_actions enable row level security;
revoke all on public.pg1_autonomous_actions from anon, authenticated;
