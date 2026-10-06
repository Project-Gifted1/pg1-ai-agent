-- pg1_video_jobs: quality tiers and a daily estimated-spend budget
-- (lib/videoJobs.mjs, lib/videoText.mjs).
--
-- Safe to run on a database that already has 20261008120000_pg1_video_jobs
-- (the table and pg1_reserve_video_slot(text, integer, text, boolean)) and
-- on a fresh one: every statement is idempotent, and the table is created
-- here too if it does not exist yet.
--
-- Each job records its tier (draft, standard, pro), its length (5 or 10 s)
-- and est_cost_usd, the estimate reserved for it before any provider is
-- called. A UTC day's spend is the sum of est_cost_usd over that day's rows,
-- failed clips included: a failed clip keeps its reservation, and falling
-- back to another provider updates the same row, so it never reserves twice.
create table if not exists public.pg1_video_jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  day date not null default ((now() at time zone 'utc')::date),
  status text not null default 'reserved'
    check (status in ('reserved', 'rendering', 'done', 'failed')),
  prompt text not null,
  has_start_frame boolean not null default false,
  request_id text,
  interaction_id text,
  key_slot integer,
  storage_path text,
  error_reason text
);

alter table public.pg1_video_jobs add column if not exists provider text check (provider in ('google', 'replicate'));
alter table public.pg1_video_jobs add column if not exists model text;
alter table public.pg1_video_jobs add column if not exists tier text not null default 'standard' check (tier in ('draft', 'standard', 'pro'));
alter table public.pg1_video_jobs add column if not exists duration_s integer not null default 5 check (duration_s in (5, 10));
alter table public.pg1_video_jobs add column if not exists est_cost_usd numeric(8, 2) not null default 0 check (est_cost_usd >= 0);

create index if not exists pg1_video_jobs_day_idx on public.pg1_video_jobs (day);
create index if not exists pg1_video_jobs_open_idx
  on public.pg1_video_jobs (created_at)
  where status in ('reserved', 'rendering');

-- Service-role only: every read and write goes through api/chat.mjs.
alter table public.pg1_video_jobs enable row level security;
revoke all on public.pg1_video_jobs from anon, authenticated;

-- The clip-count reservation is replaced by a spend reservation. The old
-- overload is dropped so no caller can still reserve by count alone; the
-- new one is dropped first too, so this file can be run again.
drop function if exists public.pg1_reserve_video_slot(text, integer, text, boolean);
drop function if exists public.pg1_reserve_video_slot(text, numeric, numeric, integer, text, boolean, text, integer);

-- Reserves one clip's estimated cost, atomically. Two requests at the same
-- time cannot both spend the last of the budget: the transaction-level
-- advisory lock for the UTC day serialises the sum and the insert. A clip
-- is refused when it would take the day's estimated spend over
-- p_budget_usd ('budget') or the day's clips past p_max_clips ('clips').
-- Returns one row:
--   job_id      the new job's id, or null when refused
--   clips_used  clips today, this one included when reserved
--   spent_usd   estimated spend today, this clip included when reserved
--   budget_usd  the budget that was applied
--   max_clips   the clip limit that was applied
--   reserved    whether the clip was reserved
--   refusal     null, 'budget' or 'clips'
create function public.pg1_reserve_video_slot(
  p_prompt text,
  p_est_cost_usd numeric,
  p_budget_usd numeric,
  p_max_clips integer,
  p_request_id text default null,
  p_has_start_frame boolean default false,
  p_tier text default 'standard',
  p_duration_s integer default 5
)
returns table (job_id uuid, clips_used integer, spent_usd numeric, budget_usd numeric, max_clips integer, reserved boolean, refusal text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_cost numeric := round(greatest(coalesce(p_est_cost_usd, 0), 0), 2);
  v_budget numeric := round(greatest(coalesce(p_budget_usd, 0), 0), 2);
  v_max integer := greatest(coalesce(p_max_clips, 0), 0);
  v_clips integer;
  v_spent numeric;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('pg1_video_jobs:' || v_day::text));

  -- Jobs nobody finished in 15 minutes are failed; they keep their reservation.
  update public.pg1_video_jobs
     set status = 'failed', error_reason = 'timeout', updated_at = now()
   where status in ('reserved', 'rendering')
     and created_at < now() - interval '15 minutes';

  select count(*)::integer, coalesce(sum(est_cost_usd), 0)
    into v_clips, v_spent
    from public.pg1_video_jobs
   where day = v_day;

  if v_clips >= v_max then
    return query select null::uuid, v_clips, v_spent, v_budget, v_max, false, 'clips'::text;
    return;
  end if;
  if v_spent + v_cost > v_budget then
    return query select null::uuid, v_clips, v_spent, v_budget, v_max, false, 'budget'::text;
    return;
  end if;

  insert into public.pg1_video_jobs (prompt, request_id, has_start_frame, day, tier, duration_s, est_cost_usd)
  values (
    left(coalesce(p_prompt, ''), 2000), left(p_request_id, 64), coalesce(p_has_start_frame, false), v_day,
    case when p_tier in ('draft', 'standard', 'pro') then p_tier else 'standard' end,
    case when p_duration_s = 10 then 10 else 5 end,
    v_cost
  )
  returning id into v_id;

  return query select v_id, v_clips + 1, v_spent + v_cost, v_budget, v_max, true, null::text;
end;
$$;

revoke all on function public.pg1_reserve_video_slot(text, numeric, numeric, integer, text, boolean, text, integer) from public, anon, authenticated;
grant execute on function public.pg1_reserve_video_slot(text, numeric, numeric, integer, text, boolean, text, integer) to service_role;
