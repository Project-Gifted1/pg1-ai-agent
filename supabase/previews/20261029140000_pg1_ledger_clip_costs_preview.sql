-- Read-only preview for supabase/migrations/20261029140000_pg1_ledger_clip_costs.sql:
-- how many pg1_ai_usage rows it would change, and their total cost before
-- and after, per unit and overall (the row with unit null). Changes nothing.
with kling as (
  select u.cost_usd as before_usd,
         coalesce((
           select a.cost_usd
             from public.pg1_film_assets a
            where a.kind = 'clip'
              and a.cost_usd > 0 and a.cost_usd < 1.40
              and a.created_at between u.at - interval '1 minute' and u.at + interval '30 minutes'
            order by abs(extract(epoch from (a.created_at - u.at)))
            limit 1
         ), 0.30) as after_usd
    from public.pg1_ai_usage u
   where u.provider = 'replicate' and u.unit = 'video_replicate'
     and u.ok and not u.cached and u.cost_usd = 1.40
),
gemini as (
  select cost_usd as before_usd, 0.50::numeric as after_usd
    from public.pg1_ai_usage
   where provider = 'gemini_paid' and unit = 'video_gemini'
     and ok and not cached and cost_usd = 0.75
),
changes as (
  select 'video_replicate' as unit, before_usd, after_usd from kling
  union all
  select 'video_gemini', before_usd, after_usd from gemini
)
select unit,
       count(*) as rows_changing,
       coalesce(sum(before_usd), 0) as total_before_usd,
       coalesce(sum(after_usd), 0) as total_after_usd
  from changes
 group by rollup (unit)
 order by unit nulls last;
