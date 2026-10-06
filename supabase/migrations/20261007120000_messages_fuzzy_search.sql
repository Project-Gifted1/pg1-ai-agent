-- public.messages: close-match fallback for the operator-only search_history
-- chat tool (lib/historySearch.mjs). Run after 20261006150000_messages_fts.sql.
--
-- Why: the first search (PostgREST wfts on content_tsv) needs every word to
-- match exactly, so one misspelt name finds nothing. Real case: the archive
-- spells "Blanko Ekama"; a search for "Blanco Ekama" returned no rows.
--
-- search_history now tries, in order, stopping at the first step with rows:
--   1. all words, full text   (PostgREST filter, unchanged)
--   2. any word, full text    (this function, match_type 'any_word'),
--                             messages matching more words first
--   3. similar spelling       (this function, match_type 'fuzzy'),
--                             pg_trgm word_similarity >= 0.5 per search word
-- Rows from steps 2 and 3 are labelled close matches; PG1 must say so.
--
-- What it adds:
--   pg_trgm extension (in schema extensions, Supabase's default; an
--     existing install anywhere else is used as it is)
--   messages_content_trgm_idx  trigram GIN index on lower(content::text)
--   public.search_messages_fallback(p_query, p_from, p_to, p_limit)
--     returns at most 10 rows: id, role, content, created_at, match_type,
--     matched_words, score. Read-only (STABLE, SECURITY INVOKER),
--     executable by service_role only.
--
-- Search words: letters/digits runs of 2+ characters, lower-cased, English
-- stop words dropped. Fuzzy matching uses only words of 4+ characters.
--
-- Safe to run more than once.

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

-- The trigram index, in whichever schema pg_trgm lives.
do $$
declare
  trgm_schema text;
begin
  select n.nspname into trgm_schema
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pg_trgm';
  execute format(
    'create index if not exists messages_content_trgm_idx on public.messages using gin (lower(content::text) %I.gin_trgm_ops)',
    trgm_schema
  );
end $$;

create or replace function public.search_messages_fallback(
  p_query text,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit integer default 10
)
returns table (
  id text,
  role text,
  content text,
  created_at timestamptz,
  match_type text,
  matched_words integer,
  score real
)
language plpgsql
stable
security invoker
set search_path = public, extensions, pg_catalog
set pg_trgm.word_similarity_threshold = '0.5'
as $$
#variable_conflict use_column
declare
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 10);
  v_words text[];
  v_fuzzy text[];
  v_any tsquery;
  v_word text;
begin
  select coalesce(array_agg(distinct t.w), '{}')
    into v_words
  from (
    select lower(m[1]) as w
    from regexp_matches(left(coalesce(p_query, ''), 200), '([[:alnum:]]{2,})', 'g') as m
  ) t
  where to_tsvector('english', t.w) <> ''::tsvector;

  if cardinality(v_words) = 0 then
    return;
  end if;

  -- 2. Any word, full text: the words OR-ed together, ranked by how many
  -- of them a message matches, then ts_rank, then newest.
  foreach v_word in array v_words loop
    v_any := case when v_any is null then plainto_tsquery('english', v_word) else v_any || plainto_tsquery('english', v_word) end;
  end loop;

  return query
  select
    msg.id::text,
    msg.role::text,
    msg.content::text,
    msg.created_at::timestamptz,
    'any_word'::text,
    (select count(*)::integer from unnest(v_words) as w(word) where msg.content_tsv @@ plainto_tsquery('english', w.word)),
    ts_rank(msg.content_tsv, v_any)::real
  from public.messages as msg
  where msg.content_tsv @@ v_any
    and (p_from is null or msg.created_at >= p_from)
    and (p_to is null or msg.created_at < p_to)
  order by 6 desc, 7 desc, 4 desc
  limit v_limit;

  if found then
    return;
  end if;

  -- 3. Similar spelling: word_similarity of each 4+ character search word
  -- against the message (the %> operator uses the trigram index and the
  -- 0.5 threshold set on this function). Ranked by how many words match,
  -- then the best similarity, then newest.
  select coalesce(array_agg(w), '{}') into v_fuzzy from unnest(v_words) as w where length(w) >= 4;
  if cardinality(v_fuzzy) = 0 then
    return;
  end if;

  return query
  select
    msg.id::text,
    msg.role::text,
    msg.content::text,
    msg.created_at::timestamptz,
    'fuzzy'::text,
    (select count(*)::integer from unnest(v_fuzzy) as f(word) where word_similarity(f.word, lower(msg.content::text)) >= 0.5),
    (select max(word_similarity(f.word, lower(msg.content::text))) from unnest(v_fuzzy) as f(word))::real
  from public.messages as msg
  where lower(msg.content::text) %> any (v_fuzzy)
    and (p_from is null or msg.created_at >= p_from)
    and (p_to is null or msg.created_at < p_to)
  order by 6 desc, 7 desc, 4 desc
  limit v_limit;
end;
$$;

revoke all on function public.search_messages_fallback(text, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.search_messages_fallback(text, timestamptz, timestamptz, integer) to service_role;

-- PostgREST caches the schema; tell it about the new function now.
notify pgrst, 'reload schema';
