-- Phase 1: Enterprise Autonomous Agent Foundation
-- Enable pgvector for future semantic memory retrieval
create extension if not exists vector;

create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  task text not null,
  status text not null default 'planned',
  lifecycle_state text not null default 'planning',
  decomposition jsonb not null default '[]'::jsonb,
  progress jsonb not null default '{}'::jsonb,
  budget_cents numeric(12,6),
  failure_reason text,
  last_result jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_execution_logs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.agent_tasks(id) on delete cascade,
  session_id text not null,
  state text not null,
  level text not null default 'info',
  thought text,
  action text,
  observation text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_memory (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.agent_tasks(id) on delete set null,
  session_id text,
  memory_type text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(1536),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_conversations (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  role text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_costs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.agent_tasks(id) on delete cascade,
  session_id text not null,
  provider text not null,
  model text not null,
  input_tokens integer not null,
  output_tokens integer not null,
  cost_cents numeric(12,6) not null,
  pricing jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_approvals (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.agent_tasks(id) on delete cascade,
  session_id text not null,
  operation text not null,
  risk_score integer not null default 0,
  requires_approval boolean not null default false,
  status text not null default 'pending',
  metadata jsonb not null default '{}'::jsonb,
  decided_by text,
  decision_notes text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_metrics (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.agent_tasks(id) on delete cascade,
  session_id text not null,
  metric_name text not null,
  metric_value numeric,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_agent_tasks_session on public.agent_tasks(session_id, created_at desc);
create index if not exists idx_agent_logs_task on public.agent_execution_logs(task_id, created_at asc);
create index if not exists idx_agent_memory_session on public.agent_memory(session_id, created_at desc);
create index if not exists idx_agent_costs_task on public.agent_costs(task_id, created_at desc);
create index if not exists idx_agent_approvals_status on public.agent_approvals(status, created_at desc);
create index if not exists idx_agent_metrics_session on public.agent_metrics(session_id, created_at desc);

create index if not exists idx_agent_memory_embedding on public.agent_memory using ivfflat (embedding vector_cosine_ops) with (lists = 100);
