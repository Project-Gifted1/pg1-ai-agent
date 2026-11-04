-- PG1 lab research agenda (lib/lab/agenda.mjs): what the continuous lab
-- loop works on next, one row per goal (de-duplicated by its normalised
-- text, goal_key). NOT APPLIED AUTOMATICALLY: run it by hand in the
-- Supabase SQL editor. Can be run more than once. Changes no existing data.
-- Service role only.
--
--   goal           the goal, as the experiment gets it
--   goal_key       the goal lower-cased, punctuation and spacing removed
--   kind           research | skill | code
--   priority       higher runs first (/lab agenda top <id> raises it)
--   status         open (waiting) | running (an experiment is on it) |
--                  done | dropped (/lab agenda drop <id>)
--   continued_from the last experiment on this goal, whose findings the
--                  next one receives
--   notes          the previous findings and why the last run stopped
--                  (no secrets: the runner's own report, capped)
--   source         history (built from pg1_lab_experiments) | pg1 (its
--                  missions, lessons, failures) | operator (/lab agenda add)
--   experiment_id  the experiment running on it now (status running)
--   attempts       experiments run on this goal by the loop
--
-- pg1_lab_experiments gets continued_from: the experiment a new one
-- continues (the loop also writes it into the result, so nothing is lost
-- before this runs).

create table if not exists public.pg1_lab_agenda (
  id uuid primary key default gen_random_uuid(),
  goal text not null check (char_length(goal) between 3 and 1000),
  goal_key text not null check (char_length(goal_key) between 1 and 1000),
  kind text not null default 'research' check (kind in ('research', 'skill', 'code')),
  priority integer not null default 50 check (priority between -1000 and 100000),
  status text not null default 'open' check (status in ('open', 'running', 'done', 'dropped')),
  continued_from uuid,
  notes text check (notes is null or char_length(notes) <= 6000),
  source text not null default 'pg1' check (source in ('history', 'pg1', 'operator')),
  experiment_id uuid,
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists pg1_lab_agenda_goal_key_idx on public.pg1_lab_agenda (goal_key);
create index if not exists pg1_lab_agenda_next_idx on public.pg1_lab_agenda (status, priority desc, created_at);

alter table public.pg1_lab_agenda enable row level security;
revoke all on public.pg1_lab_agenda from anon, authenticated;

do $$
begin
  if to_regclass('public.pg1_lab_experiments') is not null then
    alter table public.pg1_lab_experiments add column if not exists continued_from uuid;
  end if;
end $$;
