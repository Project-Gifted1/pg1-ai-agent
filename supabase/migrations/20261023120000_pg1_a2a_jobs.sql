-- A2A jobs (lib/a2aJobs): paid jobs other agents buy over A2A + x402.
--
--   pg1_a2a_jobs     one row per job, from quote to result: job_type (one
--                    of the fixed catalogue), status (quoted | working |
--                    completed | failed | expired | cancelled | refused),
--                    the validated input, items, price and worst-case cost,
--                    ETA, quote expiry, how it was paid (x402 | free_tier |
--                    credit), the settlement's transaction id, attempts,
--                    the result and the artifact paths, credited_usd and
--                    flagged after a failure. caller_hash and payer_hash are
--                    salted HMACs: no raw IP or wallet is stored.
--                    Deleted 30 days after creation; output files 7 days
--                    after completion (lib/retention.mjs).
--   pg1_a2a_credits  credit per paying wallet (payer_hash) after a failed
--                    paid job, used for its next job. Never an on-chain
--                    refund.
--   pg1_a2a_credit_add(p_payer, p_amount), pg1_a2a_credit_use(p_payer,
--   p_amount): atomic balance changes (use only when the balance covers it).
--
-- Service role only: RLS on, nothing for anon/authenticated.
-- NOT APPLIED AUTOMATICALLY. Safe to run more than once. Deletes no data.

create table if not exists public.pg1_a2a_jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  job_type text not null,
  status text not null default 'quoted',
  input jsonb not null,
  items integer not null,
  price_usd numeric(12, 6) not null,
  worst_cost_usd numeric(12, 6) not null,
  cost_usd numeric(12, 6),
  eta_s integer not null,
  quote_expires_at timestamptz not null,
  accepted_at timestamptz,
  caller_hash text,
  payer_hash text,
  payment text,
  settlement jsonb,
  attempts integer not null default 0,
  result jsonb,
  artifacts jsonb,
  output_expires_at timestamptz,
  error text,
  credited_usd numeric(12, 6) not null default 0,
  flagged boolean not null default false
);

alter table public.pg1_a2a_jobs drop constraint if exists pg1_a2a_jobs_type_check;
alter table public.pg1_a2a_jobs drop constraint if exists pg1_a2a_jobs_status_check;
alter table public.pg1_a2a_jobs drop constraint if exists pg1_a2a_jobs_payment_check;
alter table public.pg1_a2a_jobs drop constraint if exists pg1_a2a_jobs_price_check;
alter table public.pg1_a2a_jobs drop constraint if exists pg1_a2a_jobs_hash_check;

alter table public.pg1_a2a_jobs
  add constraint pg1_a2a_jobs_type_check check (job_type in ('batch_wallet_screen', 'cve_exposure_report', 'hostname_package_batch', 'threat_writeup_pdf')),
  add constraint pg1_a2a_jobs_status_check check (status in ('quoted', 'working', 'completed', 'failed', 'expired', 'cancelled', 'refused')),
  add constraint pg1_a2a_jobs_payment_check check (payment is null or payment in ('x402', 'free_tier', 'credit')),
  add constraint pg1_a2a_jobs_price_check check (price_usd >= 0 and worst_cost_usd >= 0 and price_usd >= worst_cost_usd * 1.5 and items between 1 and 500),
  add constraint pg1_a2a_jobs_hash_check check ((caller_hash is null or caller_hash ~ '^[0-9a-f]{16,64}$') and (payer_hash is null or payer_hash ~ '^[0-9a-f]{16,64}$'));

create index if not exists pg1_a2a_jobs_status_idx on public.pg1_a2a_jobs (status);
create index if not exists pg1_a2a_jobs_payer_idx on public.pg1_a2a_jobs (payer_hash, accepted_at);
create index if not exists pg1_a2a_jobs_created_idx on public.pg1_a2a_jobs (created_at desc);

create table if not exists public.pg1_a2a_credits (
  payer_hash text primary key,
  balance_usd numeric(12, 6) not null default 0 check (balance_usd >= 0),
  updated_at timestamptz not null default now()
);

alter table public.pg1_a2a_credits drop constraint if exists pg1_a2a_credits_hash_check;
alter table public.pg1_a2a_credits add constraint pg1_a2a_credits_hash_check check (payer_hash ~ '^[0-9a-f]{16,64}$');

create or replace function public.pg1_a2a_credit_add(p_payer text, p_amount numeric)
returns table (balance_usd numeric)
language sql
security invoker
set search_path = public
as $$
  insert into public.pg1_a2a_credits (payer_hash, balance_usd, updated_at)
  values (p_payer, greatest(0, p_amount), now())
  on conflict (payer_hash) do update set balance_usd = public.pg1_a2a_credits.balance_usd + greatest(0, excluded.balance_usd), updated_at = now()
  returning public.pg1_a2a_credits.balance_usd
$$;

create or replace function public.pg1_a2a_credit_use(p_payer text, p_amount numeric)
returns table (used boolean)
language sql
security invoker
set search_path = public
as $$
  with u as (
    update public.pg1_a2a_credits set balance_usd = balance_usd - p_amount, updated_at = now()
    where payer_hash = p_payer and p_amount > 0 and balance_usd >= p_amount
    returning 1
  )
  select exists (select 1 from u)
$$;

alter table public.pg1_a2a_jobs enable row level security;
alter table public.pg1_a2a_credits enable row level security;
revoke all on public.pg1_a2a_jobs from public, anon, authenticated;
revoke all on public.pg1_a2a_credits from public, anon, authenticated;
revoke all on function public.pg1_a2a_credit_add(text, numeric) from public, anon, authenticated;
revoke all on function public.pg1_a2a_credit_use(text, numeric) from public, anon, authenticated;
grant execute on function public.pg1_a2a_credit_add(text, numeric) to service_role;
grant execute on function public.pg1_a2a_credit_use(text, numeric) to service_role;

notify pgrst, 'reload schema';
