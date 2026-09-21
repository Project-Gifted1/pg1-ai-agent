-- Supabase security advisor remediation (issue #87).
--
-- Scope note: this repo has no prior migrations directory and the app never
-- talks to Postgres directly except through PostgREST/RPC over HTTP, so the
-- actual current definitions of get_all_vaults(), match_agent_memories(),
-- the RLS policies on public.messages, and the storage.objects policies for
-- the pg1-vault bucket are not visible from source. Every statement below
-- was chosen so it does not require knowing those definitions up front
-- (ALTER FUNCTION ... SET, or dynamic DROP POLICY over pg_policies), except
-- where noted. See the accompanying PR/issue comment for what still needs
-- confirmation before running.

-- =====================================================================
-- 1. public.pending_actions — RLS Disabled in Public / Sensitive Columns Exposed
-- =====================================================================
-- Code evidence (api/chat.mjs: storePendingAction/loadPendingAction/
-- resolvePendingActionStatus): every read and write to this table uses the
-- Supabase *service role* key (SUPABASEAPI_KEY / SUPABASE_SERVICE_ROLE_KEY).
-- No client-side or anon-key code path touches it. Its `token` column is a
-- bearer-style approval token (crypto.randomUUID()) that lets a caller
-- approve a pending GitHub commit/PR via /approve — anyone who could read
-- this table via the anon/authenticated PostgREST role could hijack that
-- flow, and `plan`/`diff_summary` embed real repo file contents. There is
-- no legitimate anon/authenticated use case, so this locks the table down
-- to service_role only (service_role has BYPASSRLS and its own grants, so
-- existing app behavior is unaffected).
alter table public.pending_actions enable row level security;
revoke all on public.pending_actions from anon, authenticated;

-- =====================================================================
-- 2. public.vector — Extension in Public
-- =====================================================================
-- No app code references the `vector` type directly (embeddings are only
-- ever handled inside match_agent_memories()/related DB functions), so
-- there's nothing in this repo that assumes an unqualified/public-schema
-- `vector` type. Moving the extension to a dedicated schema is Supabase's
-- standard fix and does not change already-created columns (Postgres
-- resolves existing columns by type OID, not by search_path). It DOES mean
-- any function body that references `vector` unqualified needs `extensions`
-- on its search_path — handled together with fix #3 below.
create schema if not exists extensions;
alter extension vector set schema extensions;
grant usage on schema extensions to postgres, anon, authenticated, service_role;

-- =====================================================================
-- 3. get_all_vaults / match_agent_memories — Function Search Path Mutable
-- =====================================================================
-- ALTER FUNCTION ... SET only changes the function's runtime config, not
-- its body, so this is safe to apply without seeing the current source.
-- Pinning search_path prevents a caller from shadowing objects the
-- function relies on via a session-level search_path change, and
-- `extensions` is included so the `vector` type still resolves after fix #2.
--
-- match_agent_memories' exact parameter list isn't visible from the app
-- (api/memory/recall.js only shows the call site: query_embedding,
-- match_threshold, match_count), so the signature below is inferred from
-- that call + the embedding model in use (OpenAI text-embedding-ada-002 =
-- 1536 dims). If this errors with "function does not exist", run:
--   select oid::regprocedure from pg_proc where proname = 'match_agent_memories';
-- and substitute the exact signature it prints.
alter function public.get_all_vaults() set search_path = public, extensions;
alter function public.match_agent_memories(vector(1536), double precision, integer)
  set search_path = public, extensions;

-- =====================================================================
-- 4. get_all_vaults() — SECURITY DEFINER callable by anon/authenticated
-- =====================================================================
-- No code in this repo calls get_all_vaults() at all (no RPC call, no REST
-- call to /rest/v1/rpc/get_all_vaults anywhere in api/, app/, public/,
-- workers/, scripts/). CONFIRM before running this: if nothing outside
-- this repo (Supabase Studio, another service, a cron/webhook) legitimately
-- calls it as anon/authenticated, this is safe — it restricts the elevated
-- SECURITY DEFINER function to service_role only.
revoke execute on function public.get_all_vaults() from public, anon, authenticated;

-- =====================================================================
-- 5. public.messages — Multiple Permissive Policies / RLS Policy Always True
-- =====================================================================
-- Code evidence (api/chat.mjs): every read (`GET .../rest/v1/messages`)
-- and write (`POST .../rest/v1/messages`) uses `dbHeaders`, which is built
-- from the service-role key established earlier in the same file — never
-- the anon key, and never from client-side code (public/index.html has no
-- direct Supabase calls). There's no per-user ownership column either,
-- consistent with this being a server-only chat log. So, same as
-- pending_actions: drop whatever permissive policies currently exist
-- (names unknown from source, hence the dynamic loop) and rely on
-- service_role's RLS bypass for the app's own access.
do $$
declare
  pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'messages'
  loop
    execute format('drop policy %I on public.messages', pol.policyname);
  end loop;
end $$;

revoke all on public.messages from anon, authenticated;

-- =====================================================================
-- 6. storage."pg1-vault" — Public Bucket Allows Listing
-- =====================================================================
-- Code evidence: api/chat.mjs both (a) lists/uploads via the service-role
-- key (`storage/v1/object/list/pg1-vault`, `storage/v1/object/pg1-vault/...`)
-- and (b) hands the browser plain public object URLs for generated
-- TTS/images/notebooks (`storage/v1/object/public/pg1-vault/...`, lines
-- ~1330/1393/1445). That second part means the bucket's `public` flag must
-- stay on — Supabase's public-object download path bypasses storage.objects
-- RLS entirely, so turning `public` off would break those links. Listing,
-- however, always goes through a `storage.objects` RLS policy check
-- regardless of the public flag, so the fix is to remove any policy that
-- lets anon/authenticated SELECT (list) rows for this bucket, without
-- touching the public-download path or other buckets' policies.
do $$
declare
  pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (qual ilike '%pg1-vault%' or with_check ilike '%pg1-vault%')
  loop
    execute format('drop policy %I on storage.objects', pol.policyname);
  end loop;
end $$;
-- After running this, re-check the advisor. If it still flags listing,
-- there was no storage.objects policy driving it and the bucket's
-- `public` flag itself is being read as listable by the linter — in that
-- case the only full fix is making the bucket private and switching
-- api/chat.mjs to createSignedUrl() for TTS/image/notebook links instead
-- of the raw /object/public/ URLs, which is a larger app change than a
-- SQL/dashboard toggle and needs sign-off before implementing.
