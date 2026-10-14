-- pg1_opportunities: proposals for new tools from the weekly opportunity
-- scan (lib/opportunities.mjs, a lab research experiment). One row per
-- proposal: title, problem, target agents, data sources with their licence
-- status and resale-terms URL, build cost, run cost per call, proposed
-- price (and the lowest price the 1.5x rule allows), whether the margin and
-- the licences are cleared, risks. status: proposed | prototyping (a lab
-- code experiment was started for it) | dismissed. PG1 never launches,
-- prices or publishes anything from this table.
--
-- No caller identifiers: the scan reads usage aggregates only.
-- Kept 365 days (lib/retention.mjs).
-- Service role only: RLS on, nothing for anon/authenticated.
-- NOT APPLIED AUTOMATICALLY. Safe to run more than once. Deletes no data.

create table if not exists public.pg1_opportunities (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  experiment_id uuid,
  status text not null default 'proposed',
  title text not null,
  problem text not null,
  target_agents text,
  data_sources jsonb not null default '[]'::jsonb,
  build_cost_usd numeric(12, 2),
  run_cost_per_call_usd numeric(12, 6),
  price_usd numeric(12, 6),
  min_price_usd numeric(12, 6),
  margin_ok boolean not null default false,
  licence_ok boolean not null default false,
  risks text,
  prototype_experiment_id uuid
);

alter table public.pg1_opportunities drop constraint if exists pg1_opportunities_status_check;
alter table public.pg1_opportunities drop constraint if exists pg1_opportunities_sizes_check;
alter table public.pg1_opportunities
  add constraint pg1_opportunities_status_check check (status in ('proposed', 'prototyping', 'dismissed')),
  add constraint pg1_opportunities_sizes_check check (char_length(title) <= 120 and char_length(problem) <= 1000 and jsonb_typeof(data_sources) = 'array');

create index if not exists pg1_opportunities_created_idx on public.pg1_opportunities (created_at desc);

alter table public.pg1_opportunities enable row level security;
revoke all on public.pg1_opportunities from public, anon, authenticated;

notify pgrst, 'reload schema';
