-- Tool Foundry (lib/foundry): tools other agents commission over A2A.
--
--   pg1_foundry_jobs   one row per build_tool request: the normalised spec
--                      (the purpose is customer text, stored as data), the
--                      offer, the screening outcome (status refused with a
--                      refusal_category, or review with review_reason, and
--                      the classifier's label and confidence), the plan
--                      (PG1 primitives only), the quote (build fee and
--                      per-call price, both >= 1.5x worst-case cost), the
--                      paying wallet as a salted hash, the settlement id,
--                      the lab experiment and its gate, credits and flags.
--                      Deleted 365 days after creation (lib/retention.mjs).
--   pg1_foundry_tools  deployed tools: the validated plan (never code), the
--                      input schema, visibility, owner_hash (the
--                      commissioning wallet's salted hash), prices, status
--                      (active | disabled). No access key is stored: it is
--                      derived from PG1_FOUNDRY_SECRET.
--
-- Service role only: RLS on, nothing for anon/authenticated.
-- NOT APPLIED AUTOMATICALLY. Safe to run more than once. Deletes no data.

create table if not exists public.pg1_foundry_jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null,
  spec jsonb not null,
  visibility text not null default 'private',
  offer jsonb,
  classification jsonb,
  refusal_category text,
  review_reason text,
  plan jsonb,
  quote jsonb,
  build_fee_usd numeric(12, 6),
  per_call_usd numeric(12, 6),
  caller_hash text,
  payer_hash text,
  settlement_tx text,
  paid_at timestamptz,
  lab_experiment_id uuid,
  gate jsonb,
  tool_id uuid,
  error text,
  credited_usd numeric(12, 6) not null default 0,
  flagged boolean not null default false
);

alter table public.pg1_foundry_jobs drop constraint if exists pg1_foundry_jobs_status_check;
alter table public.pg1_foundry_jobs drop constraint if exists pg1_foundry_jobs_shape_check;
alter table public.pg1_foundry_jobs
  add constraint pg1_foundry_jobs_status_check check (status in ('review', 'refused', 'infeasible', 'quoted', 'counter_offer', 'expired', 'building', 'awaiting_approval', 'deployed', 'rejected', 'build_failed')),
  add constraint pg1_foundry_jobs_shape_check check (
    visibility in ('private', 'public')
    and (caller_hash is null or caller_hash ~ '^[0-9a-f]{16,64}$')
    and (payer_hash is null or payer_hash ~ '^[0-9a-f]{16,64}$')
    and (build_fee_usd is null or build_fee_usd >= 0)
    and (per_call_usd is null or per_call_usd >= 0)
  );

create index if not exists pg1_foundry_jobs_status_idx on public.pg1_foundry_jobs (status, created_at desc);

create table if not exists public.pg1_foundry_tools (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null unique,
  job_id uuid not null references public.pg1_foundry_jobs (id),
  description text not null,
  input_schema jsonb not null,
  plan jsonb not null,
  visibility text not null,
  owner_hash text,
  per_call_usd numeric(12, 6) not null,
  commissioner_per_call_usd numeric(12, 6) not null,
  worst_call_cost_usd numeric(12, 6) not null,
  status text not null default 'active',
  disabled_reason text
);

alter table public.pg1_foundry_tools drop constraint if exists pg1_foundry_tools_shape_check;
alter table public.pg1_foundry_tools
  add constraint pg1_foundry_tools_shape_check check (
    name ~ '^ft_[a-z][a-z0-9_]{2,39}$'
    and visibility in ('private', 'public')
    and status in ('active', 'disabled')
    and (owner_hash is null or owner_hash ~ '^[0-9a-f]{16,64}$')
    and per_call_usd >= worst_call_cost_usd * 1.5
    and commissioner_per_call_usd >= worst_call_cost_usd * 1.5
  );

alter table public.pg1_foundry_jobs enable row level security;
alter table public.pg1_foundry_tools enable row level security;
revoke all on public.pg1_foundry_jobs from public, anon, authenticated;
revoke all on public.pg1_foundry_tools from public, anon, authenticated;

notify pgrst, 'reload schema';
