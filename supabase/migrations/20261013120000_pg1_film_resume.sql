-- PG1 Studio: surviving engine rate limits and outages, and resuming a
-- failed film (lib/film/pipeline.mjs, scripts/film-render.mjs,
-- lib/film/chat.mjs /film retry).
--
-- failure: why and where a film stopped, written by the render worker
--   with status 'failed': { stage: 'storyboard' | 'preview' | 'full',
--   step: 'reference' | 'stills' | 'voice' | 'music' | 'clips' | ...,
--   kind: 'throttled' | 'billing' | ..., engine, fallback, switched }. Engine
--   names are PG1's white-label labels only. /film retry restarts the film
--   at failure.stage, reusing every stored asset.
--
-- pg1_film_refund: gives back a charge for a call the engine refused (a
-- throttled or out-of-credit request ran nothing and was not billed), and
-- the unused part of a clip's reservation. Never takes spend below zero.
-- Re-runnable.

alter table public.pg1_film_projects add column if not exists failure jsonb;

create or replace function public.pg1_film_refund(p_project uuid, p_amount numeric)
returns table (spent_usd numeric, cap_usd numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric := round(greatest(coalesce(p_amount, 0), 0), 2);
begin
  return query
  update public.pg1_film_projects p
     set spent_usd = greatest(p.spent_usd - v_amount, 0), updated_at = now()
   where p.id = p_project
  returning p.spent_usd, p.cap_usd;
end;
$$;

revoke all on function public.pg1_film_refund(uuid, numeric) from public, anon, authenticated;
grant execute on function public.pg1_film_refund(uuid, numeric) to service_role;
