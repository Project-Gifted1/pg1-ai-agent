-- PG1 projects (lib/autonomous/projects.mjs): /mission add project "<goal>"
-- researches, builds (a draft pull request), tests and fixes on its own,
-- and asks for review once, at the end. NOT APPLIED AUTOMATICALLY. Run it
-- after 20261110120000_pg1_sandbox.sql. Can be run more than once.
-- Changes no existing data. Service role only.
--
-- pg1_missions gets a project's stage and its notes (the brief, branch,
-- pull request and test result: no code, no secrets), and its kind check
-- widens to 'project'. A project moves one stage every 10 minutes, so for
-- projects only the interval may be as short as 5 minutes (other missions
-- keep 60 minutes to a week). Only when pg1_missions exists.

do $$
begin
  if to_regclass('public.pg1_missions') is not null then
    alter table public.pg1_missions add column if not exists kind text not null default 'standard';
    alter table public.pg1_missions add column if not exists stage text;
    alter table public.pg1_missions add column if not exists project jsonb not null default '{}'::jsonb;
    alter table public.pg1_missions drop constraint if exists pg1_missions_stage_check;
    alter table public.pg1_missions add constraint pg1_missions_stage_check check (stage is null or stage in ('research', 'build', 'test', 'fix', 'review', 'done', 'failed'));
    alter table public.pg1_missions drop constraint if exists pg1_missions_kind_check;
    alter table public.pg1_missions add constraint pg1_missions_kind_check check (kind in ('standard', 'world', 'project'));
    alter table public.pg1_missions drop constraint if exists pg1_missions_interval_minutes_check;
    alter table public.pg1_missions add constraint pg1_missions_interval_minutes_check check (interval_minutes between 60 and 10080 or (kind = 'project' and interval_minutes between 5 and 10080));
    alter table public.pg1_missions drop constraint if exists pg1_missions_project_size;
    alter table public.pg1_missions add constraint pg1_missions_project_size check (octet_length(project::text) <= 16384);
  end if;
end $$;
