-- pg1_storage_usage(): the Storage section of the /usage card
-- (lib/storageUsage.mjs). Sizes only: the database's size in bytes and, per
-- storage bucket, the bytes and number of objects. No object names, paths
-- or contents leave the database.
--
-- service_role only (the server, after it has checked the operator's
-- session); anon and authenticated cannot call it.
-- NOT APPLIED AUTOMATICALLY. Safe to run more than once. Changes no data.

create or replace function public.pg1_storage_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_buckets jsonb := '[]'::jsonb;
begin
  if to_regclass('storage.objects') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object('name', b.bucket_id, 'bytes', b.bytes, 'objects', b.objects) order by b.bytes desc, b.bucket_id), '[]'::jsonb)
        from (select bucket_id, sum(coalesce((metadata->>'size')::bigint, 0))::bigint as bytes, count(*)::bigint as objects
                from storage.objects group by bucket_id) b
    $q$ into v_buckets;
  end if;
  return jsonb_build_object('database_bytes', pg_catalog.pg_database_size(pg_catalog.current_database()), 'buckets', v_buckets);
end;
$$;

revoke all on function public.pg1_storage_usage() from public, anon, authenticated;
grant execute on function public.pg1_storage_usage() to service_role;

notify pgrst, 'reload schema';
