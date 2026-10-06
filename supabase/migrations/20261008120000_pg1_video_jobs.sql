-- pg1_video_jobs: PG1 Motion video clips (lib/videoJobs.mjs, api/chat.mjs).
--
-- One row per clip the operator asks for. The row is the daily cap: a slot
-- is reserved here, by pg1_reserve_video_slot() below, before PG1 calls the
-- video engine, and every row counts towards that UTC day's cap whatever
-- happens to the clip afterwards - a clip that fails still used its slot.
--
-- status: reserved (slot taken, engine not called yet) -> rendering (the
-- engine accepted the job; interaction_id is set) -> done (the clip is in
-- the vault at storage_path) or failed (error_reason says why, a short
-- fixed word; the engine's own error text is in pg1_errors under
-- request_id). A job still reserved or rendering 15 minutes after it was
-- created is marked failed (timeout), by the status poll or by the next
-- reservation, whichever comes first.
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

-- The cap count (one UTC day) and the timeout sweep.
create index if not exists pg1_video_jobs_day_idx on public.pg1_video_jobs (day);
create index if not exists pg1_video_jobs_open_idx
  on public.pg1_video_jobs (created_at)
  where status in ('reserved', 'rendering');

-- Service-role only, same as public.pg1_errors and public.pg1_handoffs:
-- every read and write goes through api/chat.mjs with the service-role key.
alter table public.pg1_video_jobs enable row level security;
revoke all on public.pg1_video_jobs from anon, authenticated;

-- Reserves one of today's slots, atomically. Two requests at the same time
-- cannot both take the last slot: the transaction-level advisory lock for
-- the day serialises the count and the insert. Returns one row:
--   job_id    the new job's id, or null when the cap is reached
--   used      slots used today, including this one when reserved
--   daily_cap the cap that was applied
--   reserved  whether a slot was taken
create or replace function public.pg1_reserve_video_slot(p_prompt text, p_cap integer, p_request_id text default null, p_has_start_frame boolean default false)
returns table (job_id uuid, used integer, daily_cap integer, reserved boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_used integer;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('pg1_video_jobs:' || v_day::text));

  -- Jobs nobody finished in 15 minutes are failed; they keep their slot.
  update public.pg1_video_jobs
     set status = 'failed', error_reason = 'timeout', updated_at = now()
   where status in ('reserved', 'rendering')
     and created_at < now() - interval '15 minutes';

  select count(*)::integer into v_used from public.pg1_video_jobs where day = v_day;
  if v_used >= greatest(coalesce(p_cap, 0), 0) then
    return query select null::uuid, v_used, greatest(coalesce(p_cap, 0), 0), false;
    return;
  end if;

  insert into public.pg1_video_jobs (prompt, request_id, has_start_frame, day)
  values (left(coalesce(p_prompt, ''), 2000), left(p_request_id, 64), coalesce(p_has_start_frame, false), v_day)
  returning id into v_id;

  return query select v_id, v_used + 1, greatest(coalesce(p_cap, 0), 0), true;
end;
$$;

revoke all on function public.pg1_reserve_video_slot(text, integer, text, boolean) from public, anon, authenticated;
grant execute on function public.pg1_reserve_video_slot(text, integer, text, boolean) to service_role;
