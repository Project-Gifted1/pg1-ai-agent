-- pg1_chat_threads: the thread's task state and rolling summary, saved with
-- the chat (api/threads.mjs; lib/taskState.mjs, lib/contextWindow.mjs).
--
--   task_state       { goal, constraints[], decisions[], open[], objects[],
--                      pins[], turn, lastHash }: cleaned, capped and passed
--                      through the reply secret guard before it is stored
--   context_summary  { text, lastHash, folded }: the rolling summary of the
--                      thread's older turns, same guard
--
-- Both nullable, so existing rows are untouched. Only the signed-in
-- operator saves threads; a guest's task state is never stored. The table
-- keeps RLS on with no policies and nothing granted to anon or
-- authenticated (re-asserted below). Safe to run more than once.

alter table public.pg1_chat_threads
  add column if not exists task_state jsonb,
  add column if not exists context_summary jsonb;

alter table public.pg1_chat_threads drop constraint if exists pg1_chat_threads_task_state_check;
alter table public.pg1_chat_threads drop constraint if exists pg1_chat_threads_context_summary_check;

alter table public.pg1_chat_threads
  add constraint pg1_chat_threads_task_state_check
    check (task_state is null or (jsonb_typeof(task_state) = 'object' and octet_length(task_state::text) <= 16384)),
  add constraint pg1_chat_threads_context_summary_check
    check (context_summary is null or (jsonb_typeof(context_summary) = 'object' and octet_length(context_summary::text) <= 8192));

alter table public.pg1_chat_threads enable row level security;
revoke all on public.pg1_chat_threads from public, anon, authenticated;

notify pgrst, 'reload schema';
