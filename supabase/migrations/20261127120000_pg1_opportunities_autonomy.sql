-- pg1_opportunities: PG1 acts on its own best opportunity
-- (lib/opportunities.mjs actOnOpportunities).
--
-- New statuses:
--   prototype_failed: its lab prototype failed (the reason in last_error);
--                     PG1 may retry it once on its own (attempts counts tries).
--   ready:            its prototype passed the gate and waits on the
--                     operator's approval card. PG1 never launches, prices or
--                     publishes it.
-- New columns:
--   attempts      prototype runs started for it
--   last_error    why the last prototype failed
--   score         0-100: margin, demand PG1 could verify in its own usage
--                 signals, build cost. 0 when licences or the 1.5x margin
--                 are not cleared.
--   evidence      the usage signals that back the demand, as checked
--                 (verified true/false per item)
--   auto_started  PG1 started its prototype on its own (no /opportunities approve)
--
-- Additive only. Safe to run more than once. Deletes no data.
-- NOT APPLIED AUTOMATICALLY.

alter table public.pg1_opportunities add column if not exists attempts integer not null default 0;
alter table public.pg1_opportunities add column if not exists last_error text;
alter table public.pg1_opportunities add column if not exists score numeric(5, 1);
alter table public.pg1_opportunities add column if not exists evidence jsonb not null default '[]'::jsonb;
alter table public.pg1_opportunities add column if not exists auto_started boolean not null default false;

alter table public.pg1_opportunities drop constraint if exists pg1_opportunities_status_check;
alter table public.pg1_opportunities
  add constraint pg1_opportunities_status_check check (status in ('proposed', 'prototyping', 'prototype_failed', 'ready', 'dismissed'));

alter table public.pg1_opportunities drop constraint if exists pg1_opportunities_autonomy_check;
alter table public.pg1_opportunities
  add constraint pg1_opportunities_autonomy_check check (attempts >= 0 and attempts <= 20 and (score is null or (score >= 0 and score <= 100)) and jsonb_typeof(evidence) = 'array' and (last_error is null or char_length(last_error) <= 300));

create index if not exists pg1_opportunities_status_idx on public.pg1_opportunities (status, score desc);

notify pgrst, 'reload schema';
