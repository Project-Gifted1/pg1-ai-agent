-- Two changes for the /usage report, both service-role only. NOT APPLIED
-- AUTOMATICALLY. Safe to run more than once. Changes no existing data.
--
-- 1. agent_telemetry.caller_kind text: set only on our own and test traffic
--    (lib/ownTraffic.mjs): 'internal' (our checkers, partner integration
--    checks, PG1_OWN_IPS) or 'test' (preview deployments, X-PG1-Test).
--    lib/usageStats.mjs leaves those callers out of every count. Until this
--    runs, own/test rows are not stored at all (the insert names a column
--    that is not there) and /usage recognises earlier own traffic by
--    PG1_OWN_IPS / PG1_OWN_CALLER_HASHES only.
--    mcp_method now holds the method callers sent when it is not one of the
--    known ones (reduced: letters, digits, / _ . - only, <= 40 characters,
--    the existing check), instead of 'other'.
--
-- 2. pg1_storage_usage() also returns the largest folders of each bucket
--    (films/*/final, music/*/master, videos, "(root) .mp3", ...): sizes and
--    counts per folder only, with film and track ids folded into "*", so no
--    object name leaves the database.

alter table public.agent_telemetry
  add column if not exists caller_kind text;

alter table public.agent_telemetry drop constraint if exists agent_telemetry_caller_kind_check;
alter table public.agent_telemetry
  add constraint agent_telemetry_caller_kind_check
    check (caller_kind is null or caller_kind in ('internal', 'test'));

create or replace function public.pg1_storage_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_buckets jsonb := '[]'::jsonb;
  v_folders jsonb := '[]'::jsonb;
begin
  if to_regclass('storage.objects') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object('name', b.bucket_id, 'bytes', b.bytes, 'objects', b.objects) order by b.bytes desc, b.bucket_id), '[]'::jsonb)
        from (select bucket_id, sum(coalesce((metadata->>'size')::bigint, 0))::bigint as bytes, count(*)::bigint as objects
                from storage.objects group by bucket_id) b
    $q$ into v_buckets;
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object('name', f.folder, 'bytes', f.bytes, 'objects', f.objects) order by f.bytes desc, f.folder), '[]'::jsonb)
        from (
          select folder, sum(bytes)::bigint as bytes, count(*)::bigint as objects
            from (
              select o.bucket_id || ':' || (case
                       when o.name ~ '^(films|music|movies)/[^/]+/[^/]+/' then split_part(o.name, '/', 1) || '/*/' || split_part(o.name, '/', 3)
                       when position('/' in o.name) > 0 then split_part(o.name, '/', 1)
                       else '(root) .' || lower(coalesce(substring(o.name from '\.([A-Za-z0-9]+)$'), 'none'))
                     end) as folder,
                     coalesce((o.metadata->>'size')::bigint, 0) as bytes
                from storage.objects o
            ) x
           group by folder
           order by bytes desc
           limit 12
        ) f
    $q$ into v_folders;
  end if;
  return jsonb_build_object('database_bytes', pg_catalog.pg_database_size(pg_catalog.current_database()), 'buckets', v_buckets, 'folders', v_folders);
end;
$$;

revoke all on function public.pg1_storage_usage() from public, anon, authenticated;
grant execute on function public.pg1_storage_usage() to service_role;

notify pgrst, 'reload schema';
