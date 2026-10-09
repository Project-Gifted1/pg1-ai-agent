-- pg1_ai_usage: one row per AI call made through the router
-- (lib/aiRouter.mjs recordUsage), for the daily budgets
-- (PG1_DAILY_BUDGET_<PROVIDER>_USD) and the operator's /spend summary.
--
-- Rows carry provider, model, task, data class, token / character / unit
-- counts and the estimated cost in USD. Never the prompt, the reply or a
-- key: recordUsage writes a fixed list of fields only.
--
-- Safe to run more than once. Until it has run, the router keeps budgets
-- and the summary per server instance (in memory) and the inserts fail
-- quietly.
create table if not exists public.pg1_ai_usage (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  day date not null default ((now() at time zone 'utc')::date),
  provider text not null,
  model text,
  task text,
  data_class text check (data_class in ('operator', 'customer')),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  chars integer not null default 0 check (chars >= 0),
  unit text,
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  cached boolean not null default false,
  ok boolean not null default true,
  status integer,
  fallback integer not null default 0,
  request_id text
);

create index if not exists pg1_ai_usage_day_provider_idx on public.pg1_ai_usage (day, provider);

-- Service-role only: written and read by the server.
alter table public.pg1_ai_usage enable row level security;
revoke all on public.pg1_ai_usage from anon, authenticated;

-- Spend per provider for one UTC day: calls, estimated USD, cache hits.
create or replace function public.pg1_ai_spend(p_day date)
returns table (provider text, calls bigint, cost_usd numeric, cached bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select u.provider, count(*)::bigint, coalesce(sum(u.cost_usd), 0), count(*) filter (where u.cached)::bigint
  from public.pg1_ai_usage u
  where u.day = p_day
  group by u.provider
$$;

revoke all on function public.pg1_ai_spend(date) from public, anon, authenticated;
grant execute on function public.pg1_ai_spend(date) to service_role;
