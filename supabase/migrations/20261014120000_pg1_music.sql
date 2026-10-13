-- pg1_music_tracks / pg1_music_assets: PG1 Sound, original music and beats
-- with a DAW export (lib/music/*, scripts/music-render.mjs,
-- .github/workflows/music-render.yml).
--
-- NOT APPLIED AUTOMATICALLY: review, then run it in the Supabase SQL editor.
-- Safe to run more than once. pending_actions is not changed (MUSIC_FINAL,
-- MUSIC_EDIT and MUSIC_RETRY rows use its existing columns).
--
-- One track per /music request. status:
--   preview_queued -> previewing -> awaiting_choice (two previews, one
--   MUSIC_FINAL approval each) -> final_queued -> rendering -> done
--   -> export_queued -> exporting -> done (stems_path set) | failed | cancelled.
-- /music edit raises version and makes new previews; /music retry restarts
-- a failed track at failure.stage ('preview' | 'final' | 'export').
--
-- Licence. provider, model and licence_note say which engine made the
-- master and on what terms (e.g. "SynthID watermarked; commercial use under
-- Gemini API terms; source MP3"). They are operator-only: shown in /music
-- status and the export README, never on the card or in the page. No row
-- ever claims exclusive copyright.
--
-- Spend. cap_usd is the per-track cap (PG1_MUSIC_TRACK_CAP, default 2 USD);
-- spent_usd the estimated spend so far. Every paid call first goes through
-- pg1_music_charge() (adds the estimate only when it still fits under the
-- cap, in one conditional UPDATE); pg1_music_refund() gives back a call the
-- engine refused and the unused part of a reservation.
--
-- Service-role only, like pg1_film_projects: every read and write goes
-- through api/chat.mjs or the render worker with the service-role key.

create table if not exists public.pg1_music_tracks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  request_id text,
  prompt text not null,
  title text,
  options jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  status text not null default 'preview_queued'
    check (status in (
      'preview_queued', 'previewing', 'awaiting_choice', 'final_queued', 'rendering', 'done',
      'export_queued', 'exporting', 'failed', 'cancelled'
    )),
  cap_usd numeric(8, 2) not null check (cap_usd >= 0),
  spent_usd numeric(8, 2) not null default 0 check (spent_usd >= 0),
  -- [{ variant, token, asset_id }] for the previews awaiting a choice.
  choices jsonb,
  chosen_variant integer,
  -- The master's engine and terms (operator-only).
  provider text,
  model text,
  licence_note text,
  master_path text,
  master_mime text,
  duration_s numeric(8, 3),
  bpm numeric(6, 2),
  musical_key text,
  stems_path text,
  lyrics_text text,
  progress jsonb,
  failure jsonb,
  render_started_at timestamptz,
  error_reason text,
  error_detail text
);

create index if not exists pg1_music_tracks_created_idx on public.pg1_music_tracks (created_at desc);

create table if not exists public.pg1_music_assets (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  track_id uuid not null references public.pg1_music_tracks (id) on delete cascade,
  version integer not null default 1,
  kind text not null check (kind in ('preview', 'master', 'stems_zip')),
  variant integer,
  status text not null default 'ok' check (status in ('ok', 'superseded')),
  storage_path text not null,
  mime_type text,
  duration_s numeric(8, 3),
  cost_usd numeric(8, 4) not null default 0,
  provider text,
  model text,
  licence_note text,
  prompt text,
  meta jsonb
);

create index if not exists pg1_music_assets_track_idx on public.pg1_music_assets (track_id, kind, version);

alter table public.pg1_music_tracks enable row level security;
alter table public.pg1_music_assets enable row level security;
revoke all on public.pg1_music_tracks from anon, authenticated;
revoke all on public.pg1_music_assets from anon, authenticated;

-- Adds p_amount to a track's spend only when it still fits under its cap.
-- Returns one row: charged, spent_usd and cap_usd after the call. A missing
-- track is never charged.
create or replace function public.pg1_music_charge(p_track uuid, p_amount numeric)
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
  update public.pg1_music_tracks t
     set spent_usd = t.spent_usd + v_amount, updated_at = now()
   where t.id = p_track
     and t.spent_usd + v_amount <= t.cap_usd
  returning t.spent_usd, t.cap_usd into v_spent, v_cap;
  if found then
    return query select true, v_spent, v_cap;
    return;
  end if;
  select t.spent_usd, t.cap_usd into v_spent, v_cap from public.pg1_music_tracks t where t.id = p_track;
  return query select false, v_spent, v_cap;
end;
$$;

-- Gives back p_amount (a call the engine refused, or the unused part of a
-- reservation). Never takes spend below zero.
create or replace function public.pg1_music_refund(p_track uuid, p_amount numeric)
returns table (spent_usd numeric, cap_usd numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric := round(greatest(coalesce(p_amount, 0), 0), 2);
begin
  return query
  update public.pg1_music_tracks t
     set spent_usd = greatest(t.spent_usd - v_amount, 0), updated_at = now()
   where t.id = p_track
  returning t.spent_usd, t.cap_usd;
end;
$$;

revoke all on function public.pg1_music_charge(uuid, numeric) from public, anon, authenticated;
revoke all on function public.pg1_music_refund(uuid, numeric) from public, anon, authenticated;
grant execute on function public.pg1_music_charge(uuid, numeric) to service_role;
grant execute on function public.pg1_music_refund(uuid, numeric) to service_role;
