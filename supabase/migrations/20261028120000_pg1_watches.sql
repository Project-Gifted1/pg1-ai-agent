-- Background watching and real-time reports (lib/watches, docs/watches.md).
--
--   pg1_watches              one row per watched thing: target type (lab
--                            experiment, pull request, workflow run,
--                            deploy), target id, the chat thread it came
--                            from, what to report (finish | changes), who
--                            asked (operator | auto), the last state seen,
--                            status (open | done | stopped | expired),
--                            created / expires. At most one open watch per
--                            target.
--   pg1_watch_reports        one row per report PG1 wrote when a watched
--                            thing changed state: the thread it goes to, a
--                            short title and body (what happened, result,
--                            cost, next step), the action buttons, when a
--                            screen showed it (delivered_at) and how many
--                            push notifications went out. Deleted with its
--                            watch.
--   pg1_push_subscriptions   the operator's devices that opted in to web
--                            push (endpoint and its two public keys, as the
--                            browser gives them). No VAPID key is stored.
--
-- Operator only: RLS on and no policy, so anon and authenticated reach
-- nothing; the server reaches them with the service role after checking the
-- operator's session.
-- NOT APPLIED AUTOMATICALLY. Safe to run more than once. Deletes no data.

create table if not exists public.pg1_watches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  target_type text not null,
  target_id text not null,
  label text,
  origin_thread text,
  report_on text not null default 'finish',
  source text not null default 'operator',
  status text not null default 'open',
  last_state text,
  last_checked_at timestamptz,
  closed_at timestamptz
);

alter table public.pg1_watches drop constraint if exists pg1_watches_shape_check;
alter table public.pg1_watches
  add constraint pg1_watches_shape_check check (
    target_type in ('lab', 'pr', 'workflow_run', 'deploy')
    and length(target_id) between 1 and 200
    and report_on in ('finish', 'changes')
    and source in ('operator', 'auto')
    and status in ('open', 'done', 'stopped', 'expired')
    and (origin_thread is null or length(origin_thread) <= 64)
    and (label is null or length(label) <= 200)
  );

create unique index if not exists pg1_watches_one_open_idx on public.pg1_watches (target_type, target_id) where status = 'open';
create index if not exists pg1_watches_status_idx on public.pg1_watches (status, expires_at);

create table if not exists public.pg1_watch_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  watch_id uuid not null references public.pg1_watches (id) on delete cascade,
  origin_thread text,
  target_type text not null,
  target_id text not null,
  state text not null,
  title text not null,
  body text not null,
  actions jsonb not null default '[]'::jsonb,
  delivered_at timestamptz,
  push_sent integer not null default 0
);

alter table public.pg1_watch_reports drop constraint if exists pg1_watch_reports_shape_check;
alter table public.pg1_watch_reports
  add constraint pg1_watch_reports_shape_check check (length(title) <= 120 and length(body) <= 4000 and push_sent >= 0);

create index if not exists pg1_watch_reports_inbox_idx on public.pg1_watch_reports (delivered_at, created_at);

create table if not exists public.pg1_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  label text,
  last_ok_at timestamptz,
  failures integer not null default 0
);

alter table public.pg1_push_subscriptions drop constraint if exists pg1_push_subscriptions_shape_check;
alter table public.pg1_push_subscriptions
  add constraint pg1_push_subscriptions_shape_check check (endpoint like 'https://%' and length(endpoint) <= 1000 and length(p256dh) <= 200 and length(auth) <= 100 and (label is null or length(label) <= 60));

alter table public.pg1_watches enable row level security;
alter table public.pg1_watch_reports enable row level security;
alter table public.pg1_push_subscriptions enable row level security;
revoke all on public.pg1_watches from public, anon, authenticated;
revoke all on public.pg1_watch_reports from public, anon, authenticated;
revoke all on public.pg1_push_subscriptions from public, anon, authenticated;

notify pgrst, 'reload schema';
