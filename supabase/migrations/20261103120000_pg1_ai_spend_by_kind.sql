-- Paid AI spend by account and kind (text, media, voice) since a day, for
-- the credit view in /keys and /usage (lib/creditReport.mjs). NOT APPLIED
-- AUTOMATICALLY. Safe to run more than once. Read-only: no table, no data
-- change. Service role only.
--
-- kind: 'text' for chat, scans, summaries and writing (task light or heavy
-- with no media unit), 'voice' for speech (task tts, or a tts_*/dialogue_*/
-- sts_* unit), 'media' for everything else with a unit or a media task
-- (video clips, stills, music, sound effects).
--
-- Until this runs, the credit view shows this server instance's figures
-- for today only, and says so.

create or replace function public.pg1_ai_spend_by_kind(p_since date)
returns table (provider text, kind text, calls bigint, cost_usd numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select u.provider,
         case
           when u.task = 'tts' or u.unit like 'tts\_%' or u.unit like 'dialogue\_%' or u.unit like 'sts\_%' then 'voice'
           when u.unit is null and u.task in ('light', 'heavy') then 'text'
           else 'media'
         end as kind,
         count(*)::bigint,
         coalesce(sum(u.cost_usd), 0)
  from public.pg1_ai_usage u
  where u.day >= p_since and u.ok and not u.cached
  group by 1, 2
$$;

revoke all on function public.pg1_ai_spend_by_kind(date) from public, anon, authenticated;
grant execute on function public.pg1_ai_spend_by_kind(date) to service_role;
