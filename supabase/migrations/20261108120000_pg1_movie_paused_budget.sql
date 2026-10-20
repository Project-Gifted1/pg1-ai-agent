-- PG1 Studio movies: the paused_budget status (lib/movie/text.mjs
-- MOVIE_PAUSED_STATUS). NOT APPLIED AUTOMATICALLY: Gift runs it by hand
-- after review. Safe to run more than once. Changes no existing row.
-- Needs 20261029130000_pg1_director.sql first (the named status check).
--
-- A movie whose next paid step would go over its confirmed budget, or
-- whose picture engine is out of credit, stops before spending and is
-- paused (not failed); /movie resume continues it from the first missing
-- shot. Until this runs, the render worker stores such a movie as failed
-- with error_reason 'paused_budget', which the card, /movie status and
-- /movie resume read the same way.

alter table public.pg1_film_projects drop constraint if exists pg1_film_status_ok;
alter table public.pg1_film_projects add constraint pg1_film_status_ok check (status in (
  'storyboard_queued', 'storyboarding', 'awaiting_preview_approval',
  'preview_queued', 'preview_rendering', 'preview_done',
  'full_queued', 'full_rendering', 'done', 'failed', 'cancelled',
  'awaiting_director_approval', 'director_queued', 'directing', 'awaiting_delivery_approval',
  'paused_budget'
));
