-- The free Gemini key's per-minute pace, shared by every PG1 instance
-- (lib/router/freeLimiter.mjs). NOT APPLIED AUTOMATICALLY. Safe to run more
-- than once. Changes no existing data. Service role only.
--
-- pg1_rate_windows: one row per key per minute, the requests taken in it.
-- pg1_rate_take(p_key, p_cap, p_window_s): takes one request in the
-- current window when fewer than p_cap were taken, and says how long until
-- the next window otherwise. Chat passes the full per-minute limit and
-- background work a lower cap, so the last slots of a minute stay chat's.
-- Windows older than an hour are removed as new ones open.
--
-- Until this runs, the limiter counts per instance (it still holds within
-- one function instance).

create table if not exists public.pg1_rate_windows (
  key text not null,
  window_start timestamptz not null,
  used integer not null default 0,
  primary key (key, window_start)
);
alter table public.pg1_rate_windows enable row level security;
revoke all on public.pg1_rate_windows from anon, authenticated;

create or replace function public.pg1_rate_take(p_key text, p_cap integer, p_window_s integer)
returns table (granted boolean, retry_ms integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window integer := greatest(coalesce(p_window_s, 60), 1);
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / v_window) * v_window);
  v_used integer;
begin
  if coalesce(p_cap, 0) < 1 then
    return query select false, ceil(extract(epoch from (v_start + make_interval(secs => v_window) - now())) * 1000)::integer;
    return;
  end if;
  insert into public.pg1_rate_windows as w (key, window_start, used)
  values (p_key, v_start, 1)
  on conflict (key, window_start) do update
    set used = w.used + 1
    where w.used < p_cap
  returning w.used into v_used;
  if v_used = 1 then
    delete from public.pg1_rate_windows where key = p_key and window_start < now() - interval '1 hour';
  end if;
  if v_used is null then
    return query select false, ceil(extract(epoch from (v_start + make_interval(secs => v_window) - now())) * 1000)::integer;
  else
    return query select true, 0;
  end if;
end;
$$;

revoke all on function public.pg1_rate_take(text, integer, integer) from public, anon, authenticated;
grant execute on function public.pg1_rate_take(text, integer, integer) to service_role;
