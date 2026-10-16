-- A lab experiment is "done" only when every stage its kind requires
-- passed (lib/lab/chat.mjs verdictFor). Research that came back empty never
-- passed: rows finished before that rule, marked done with no findings
-- (under 80 characters of report and no opportunity proposals), become
-- failed with the reason. Lab 74cdef04 is one: its result artifact was
-- 319 bytes. Guarded: does nothing where the table does not exist.

do $$
begin
  if to_regclass('public.pg1_lab_experiments') is null then
    return;
  end if;
  update public.pg1_lab_experiments
  set status = 'failed',
      candidate = null,
      error = 'research: no findings: the research step returned an empty answer',
      updated_at = now()
  where status = 'done'
    and kind = 'research'
    and length(btrim(coalesce(result ->> 'report_markdown', ''))) < 80
    and coalesce(jsonb_array_length(case when jsonb_typeof(result -> 'proposals') = 'array' then result -> 'proposals' end), 0) = 0;
end $$;
