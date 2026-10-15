-- PG1 fallback router and Director Mode (docs/director-mode.md).
--
-- pg1_film_projects
--   mode       'standard' (/film) or 'director' (/film director)
--   director   Director Mode's saved stages: { stage, done: [...], brief,
--              treatment, script, shotList, stillChecks, dailies, edit,
--              deliverables, regenerated: [...], notes } so a stopped run
--              resumes where it stopped
--   client     a client film: { name, credit: boolean, logo_asset_id } or
--              null for the operator's own film (client work uses
--              commercial_ok engines only)
--   price_usd  the package price of a client film: spend may not pass
--              price / 1.5 (the 1.5x floor)
--   statuses   director_queued, directing, awaiting_delivery_approval
-- pg1_film_assets kinds: sfx, dialogue, stem, social, notes, logo
-- pg1_router_alerts: one row per engine, the last capacity alert sent;
--   pg1_router_alert_claim takes the hour's alert atomically.
--
-- Nothing here deletes or rewrites data. Re-runnable.

alter table public.pg1_film_projects add column if not exists mode text not null default 'standard';
alter table public.pg1_film_projects add column if not exists director jsonb;
alter table public.pg1_film_projects add column if not exists client jsonb;
alter table public.pg1_film_projects add column if not exists price_usd numeric(8, 2);

-- The status and kind checks were created unnamed by the first film
-- migration; they are found by their definition, so their generated names
-- never need spelling out.
do $$
declare
  c record;
begin
  for c in
    select t.relname as tbl, k.conname as name
      from pg_constraint k
      join pg_class t on t.oid = k.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public' and k.contype = 'c'
       and ((t.relname = 'pg1_film_projects' and (pg_get_constraintdef(k.oid) like '%status%' or pg_get_constraintdef(k.oid) like '%mode%'))
         or (t.relname = 'pg1_film_assets' and pg_get_constraintdef(k.oid) like '%kind%'))
  loop
    execute format('alter table public.%I drop constraint %I', c.tbl, c.name);
  end loop;
end;
$$;

alter table public.pg1_film_projects add constraint pg1_film_mode_ok check (mode in ('standard', 'director'));
alter table public.pg1_film_projects add constraint pg1_film_status_ok check (status in (
  'storyboard_queued', 'storyboarding', 'awaiting_preview_approval',
  'preview_queued', 'preview_rendering', 'preview_done',
  'full_queued', 'full_rendering', 'done', 'failed', 'cancelled',
  'director_queued', 'directing', 'awaiting_delivery_approval'
));
alter table public.pg1_film_assets add constraint pg1_film_asset_kind_ok check (kind in (
  'reference', 'keyframe', 'clip', 'voice', 'music', 'preview', 'final', 'frame', 'transcript',
  'sfx', 'dialogue', 'stem', 'social', 'notes', 'logo'
));

create table if not exists public.pg1_router_alerts (
  engine text primary key,
  last_sent timestamptz not null default now()
);
alter table public.pg1_router_alerts enable row level security;
revoke all on public.pg1_router_alerts from anon, authenticated;

-- true when this caller may send the engine's alert now (no alert for it in
-- the last p_window_s seconds), and records it; false otherwise.
create or replace function public.pg1_router_alert_claim(p_engine text, p_window_s integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean;
begin
  insert into public.pg1_router_alerts as a (engine, last_sent)
  values (p_engine, now())
  on conflict (engine) do update
    set last_sent = now()
    where a.last_sent <= now() - make_interval(secs => greatest(coalesce(p_window_s, 3600), 60))
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;

revoke all on function public.pg1_router_alert_claim(text, integer) from public, anon, authenticated;
grant execute on function public.pg1_router_alert_claim(text, integer) to service_role;
