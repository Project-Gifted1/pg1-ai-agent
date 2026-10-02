-- pg1_handoffs: Send to Code hand-offs (api/handoffs.mjs, lib/handoff.mjs).
--
-- One row per task prompt PG1 drafts for the operator's coding agent.
-- status moves drafted -> sent when the operator copies the prompt, then
-- follows GitHub: the newest PR whose title carries task_id sets pr_open,
-- merged or closed (synced from api/handoffs.mjs op 'list' using PG1's
-- existing GITHUB_TOKEN). Written via plain PostgREST reads/writes.
create table if not exists public.pg1_handoffs (
  task_id text primary key check (task_id ~ '^PG1-TASK-[A-Z0-9]{6}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  repo text not null,
  task text not null,
  prompt text not null,
  status text not null default 'drafted'
    check (status in ('drafted', 'sent', 'pr_open', 'merged', 'closed')),
  pr_url text,
  pr_number integer
);

-- The drawer's "newest first" Hand-offs list.
create index if not exists pg1_handoffs_created_at_idx
  on public.pg1_handoffs (created_at desc);

-- Service-role only, same as public.pg1_errors, public.wallet_first_seen and
-- public.pending_actions: every read and write goes through
-- api/handoffs.mjs with the service-role key, never the anon/authenticated
-- PostgREST role. Prompts describe private repo work, so no anon access.
alter table public.pg1_handoffs enable row level security;
revoke all on public.pg1_handoffs from anon, authenticated;
