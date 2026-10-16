-- Corrects film clip rows in pg1_ai_usage written before the router took
-- its prices from the capability registry (lib/capabilities/registry.mjs
-- ENGINE_UNIT_COSTS). Those rows carry the old worst-case unit price:
--   video_replicate (Kling)        1.40 USD, real 0.30 USD per 5 s standard clip
--   video_gemini    (Gemini Omni)  0.75 USD, real 0.50 USD per 5 s 720p clip
--
-- A Kling row takes the price the film recorded for the clip it made: the
-- pg1_film_assets clip nearest in time (created within a minute before to
-- 30 minutes after the call), whose cost_usd is the clip's real price for
-- its tier and length; with no such clip, 0.30 USD. A Gemini Omni row
-- becomes 0.50 USD (the film's tier and length are not on the row).
--
-- Only successful rows still holding exactly the old price change, so it
-- is safe to run more than once. It rewrites cost_usd on those rows and
-- deletes nothing. Run the preview query in the PR description first.

with kling as (
  select u.id,
         coalesce((
           select a.cost_usd
             from public.pg1_film_assets a
            where a.kind = 'clip'
              and a.cost_usd > 0 and a.cost_usd < 1.40
              and a.created_at between u.at - interval '1 minute' and u.at + interval '30 minutes'
            order by abs(extract(epoch from (a.created_at - u.at)))
            limit 1
         ), 0.30) as real_usd
    from public.pg1_ai_usage u
   where u.provider = 'replicate' and u.unit = 'video_replicate'
     and u.ok and not u.cached and u.cost_usd = 1.40
)
update public.pg1_ai_usage u
   set cost_usd = kling.real_usd
  from kling
 where u.id = kling.id;

update public.pg1_ai_usage
   set cost_usd = 0.50
 where provider = 'gemini_paid' and unit = 'video_gemini'
   and ok and not cached and cost_usd = 0.75;
