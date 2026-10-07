-- pg1_video_jobs: the synchronous render (api/video-render.mjs,
-- lib/videoJobs.mjs renderVideoJob).
--
-- Since 2026-10-03 Google answers GET /v1beta/interactions/{id} with 400
-- "Multiple authentication credentials received" for background
-- interactions, so the clip is rendered with background: false in its own
-- function invocation instead of being polled. The row now goes
--   reserved -> queued -> rendering -> done | failed
-- where 'queued' means "reserved, waiting for api/video-render.mjs to claim
-- it". The render claims it atomically (queued -> rendering), so a second
-- trigger for the same job never calls Google.
--
-- Safe to run more than once, and after 20261009120000_pg1_video_budget.
-- pg1_reserve_video_slot is unchanged: one reservation per clip.

alter table public.pg1_video_jobs drop constraint if exists pg1_video_jobs_status_check;
alter table public.pg1_video_jobs add constraint pg1_video_jobs_status_check
  check (status in ('reserved', 'queued', 'rendering', 'done', 'failed'));

-- When the render claimed the job; the status action fails a job that has
-- been rendering longer than the function's maxDuration plus a margin.
alter table public.pg1_video_jobs add column if not exists render_started_at timestamptz;
-- The engine's own error text for a failed render (operator diagnostics;
-- never shown in a reply). error_reason stays the short code.
alter table public.pg1_video_jobs add column if not exists error_detail text;
-- Where the starting frame waits in pg1-vault for the render to pick up.
alter table public.pg1_video_jobs add column if not exists start_frame_path text;

drop index if exists public.pg1_video_jobs_open_idx;
create index if not exists pg1_video_jobs_open_idx
  on public.pg1_video_jobs (created_at)
  where status in ('reserved', 'queued', 'rendering');
