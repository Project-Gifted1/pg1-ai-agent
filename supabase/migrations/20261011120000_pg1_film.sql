-- pg1_film_projects / pg1_film_assets: PG1 Studio, multi-shot films
-- (lib/film/*, scripts/film-render.mjs, .github/workflows/film-render.yml).
--
-- One project per film the operator asks for. Its timeline (jsonb) is the
-- single source of truth: scenes, shots, camera moves, voiceover lines,
-- music moods, transitions, captions. PG1 edits a film by changing the
-- timeline (an approved FILM_EDIT in pending_actions) and re-renders; every
-- generated asset carries a fingerprint of the inputs that made it, so a
-- re-render only regenerates what an edit changed.
--
-- status: storyboard_queued -> storyboarding -> awaiting_preview_approval
--   -> preview_queued -> preview_rendering -> preview_done (awaiting the
--   full-render approval) -> full_queued -> full_rendering -> done
--   | failed | cancelled.
--
-- Spend. cap_usd is the per-film spending cap; spent_usd is the estimated
-- spend so far. Every paid call first goes through pg1_film_charge(), which
-- adds the call's estimate only when it still fits under the cap, in one
-- conditional UPDATE, so two workers can never both spend the last of it.
--
-- Service-role only, same as pg1_video_jobs: every read and write goes
-- through api/chat.mjs or the render worker with the service-role key.

create table if not exists public.pg1_film_projects (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  request_id text,
  request text not null,
  title text,
  status text not null default 'storyboard_queued'
    check (status in (
      'storyboard_queued', 'storyboarding', 'awaiting_preview_approval',
      'preview_queued', 'preview_rendering', 'preview_done',
      'full_queued', 'full_rendering', 'done', 'failed', 'cancelled'
    )),
  tier text not null default 'standard' check (tier in ('draft', 'standard', 'pro')),
  timeline jsonb,
  timeline_version integer not null default 0,
  progress jsonb,
  est_preview_usd numeric(8, 2),
  est_full_usd numeric(8, 2),
  cap_usd numeric(8, 2) not null check (cap_usd >= 0),
  spent_usd numeric(8, 2) not null default 0 check (spent_usd >= 0),
  pending_token text,
  preview_path text,
  final_path text,
  poster_path text,
  qc_report jsonb,
  render_started_at timestamptz,
  error_reason text,
  error_detail text
);

create index if not exists pg1_film_projects_created_idx on public.pg1_film_projects (created_at desc);

create table if not exists public.pg1_film_assets (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  project_id uuid not null references public.pg1_film_projects (id) on delete cascade,
  kind text not null check (kind in ('reference', 'keyframe', 'clip', 'voice', 'music', 'preview', 'final', 'frame', 'transcript')),
  scene integer,
  shot integer,
  shot_id text,
  timeline_version integer,
  fingerprint text,
  attempt integer not null default 1,
  status text not null default 'ok' check (status in ('ok', 'rejected', 'superseded')),
  prompt text,
  description text,
  storage_path text,
  thumb_path text,
  mime_type text,
  duration_s numeric(8, 3),
  start_s numeric(8, 3),
  end_s numeric(8, 3),
  cost_usd numeric(8, 4) not null default 0,
  meta jsonb,
  search tsvector generated always as (
    to_tsvector('english', coalesce(prompt, '') || ' ' || coalesce(description, '') || ' ' || coalesce(kind, ''))
  ) stored
);

create index if not exists pg1_film_assets_project_idx on public.pg1_film_assets (project_id, kind, scene, shot);
create index if not exists pg1_film_assets_fp_idx on public.pg1_film_assets (project_id, kind, fingerprint) where status = 'ok';
create index if not exists pg1_film_assets_search_idx on public.pg1_film_assets using gin (search);

alter table public.pg1_film_projects enable row level security;
alter table public.pg1_film_assets enable row level security;
revoke all on public.pg1_film_projects from anon, authenticated;
revoke all on public.pg1_film_assets from anon, authenticated;

-- Adds p_amount to a film's spend only when it still fits under its cap.
-- Returns one row: charged (whether it was added), spent_usd and cap_usd
-- after the call. A missing project is never charged.
create or replace function public.pg1_film_charge(p_project uuid, p_amount numeric)
returns table (charged boolean, spent_usd numeric, cap_usd numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric := round(greatest(coalesce(p_amount, 0), 0), 2);
  v_spent numeric;
  v_cap numeric;
begin
  update public.pg1_film_projects p
     set spent_usd = p.spent_usd + v_amount, updated_at = now()
   where p.id = p_project
     and p.spent_usd + v_amount <= p.cap_usd
  returning p.spent_usd, p.cap_usd into v_spent, v_cap;
  if found then
    return query select true, v_spent, v_cap;
    return;
  end if;
  select p.spent_usd, p.cap_usd into v_spent, v_cap from public.pg1_film_projects p where p.id = p_project;
  return query select false, v_spent, v_cap;
end;
$$;

revoke all on function public.pg1_film_charge(uuid, numeric) from public, anon, authenticated;
grant execute on function public.pg1_film_charge(uuid, numeric) to service_role;
