-- Token-aware free-engine limits, shared by every PG1 instance
-- (lib/router/freeLimiter.mjs). NOT APPLIED AUTOMATICALLY: Gift runs it by
-- hand after review. Safe to run more than once. Changes no existing data.
-- Service role only. Needs 20261102120000_pg1_rate_windows.sql first.
--
-- pg1_rate_take_n(p_key, p_cap, p_window_s, p_n): takes p_n units (tokens
-- or requests) of p_key in the current window of p_window_s seconds when
-- used + p_n <= p_cap, and says how long until the next window otherwise.
-- p_n = 0 only reads the window (how much is used). Keys are
-- '<engine>:tpm' (60 s), '<engine>:tpd' and '<engine>:rpd' (86400 s, UTC
-- days) and '<engine>:chat' (operator chat activity, 120 s), in the same
-- pg1_rate_windows table as the per-minute request counts. Windows older
-- than two days are removed as new ones open.
--
-- Until this runs, the limiter counts tokens per instance (the per-minute
-- request pace stays shared through pg1_rate_take).

create or replace function public.pg1_rate_take_n(p_key text, p_cap bigint, p_window_s integer, p_n bigint)
returns table (granted boolean, retry_ms integer, used bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window integer := greatest(coalesce(p_window_s, 60), 1);
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / v_window) * v_window);
  v_n bigint := greatest(coalesce(p_n, 0), 0);
  v_used bigint;
  v_retry integer := ceil(extract(epoch from (v_start + make_interval(secs => v_window) - now())) * 1000)::integer;
begin
  if v_n = 0 then
    select w.used into v_used from public.pg1_rate_windows w where w.key = p_key and w.window_start = v_start;
    return query select true, 0, coalesce(v_used, 0)::bigint;
    return;
  end if;
  if coalesce(p_cap, 0) < v_n then
    return query select false, v_retry, 0::bigint;
    return;
  end if;
  insert into public.pg1_rate_windows as w (key, window_start, used)
  values (p_key, v_start, v_n)
  on conflict (key, window_start) do update
    set used = w.used + v_n
    where w.used + v_n <= p_cap
  returning w.used into v_used;
  if v_used is not null and v_used = v_n then
    delete from public.pg1_rate_windows where key = p_key and window_start < now() - interval '2 days';
  end if;
  if v_used is null then
    select w.used into v_used from public.pg1_rate_windows w where w.key = p_key and w.window_start = v_start;
    return query select false, v_retry, coalesce(v_used, 0)::bigint;
  else
    return query select true, 0, v_used;
  end if;
end;
$$;

revoke all on function public.pg1_rate_take_n(text, bigint, integer, bigint) from public, anon, authenticated;
grant execute on function public.pg1_rate_take_n(text, bigint, integer, bigint) to service_role;
