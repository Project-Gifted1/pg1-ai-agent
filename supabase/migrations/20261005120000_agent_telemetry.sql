-- agent_telemetry: usage telemetry for MCP tool calls and x402 settlements
-- (lib/telemetry.mjs, called from api/mcp.mjs).
--
-- event_type 'tool_call' is one row per tools/call request, written after
-- the response is sent; latency_ms covers the whole call. event_type
-- 'settlement' is one row per x402 settle attempt; latency_ms covers only
-- the facilitator settle call. Written fire-and-forget via plain PostgREST
-- inserts - if this table is missing or unreachable, API responses are
-- unaffected and the row is simply dropped.
create table if not exists public.agent_telemetry (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  event_type text not null default 'tool_call'
    check (event_type in ('tool_call', 'settlement')),
  endpoint text not null,
  tool_name text,
  payment_type text not null default 'none'
    check (payment_type in ('free', 'free_tier', 'license', 'x402', 'none')),
  status text not null,
  latency_ms integer check (latency_ms is null or latency_ms >= 0)
);

-- Newest-first reads and per-tool rollups.
create index if not exists agent_telemetry_created_at_idx
  on public.agent_telemetry (created_at desc);
create index if not exists agent_telemetry_tool_created_at_idx
  on public.agent_telemetry (tool_name, created_at desc);

-- Service-role only, same as public.pg1_errors and public.pg1_handoffs:
-- every write goes through lib/telemetry.mjs with the service-role key,
-- never the anon/authenticated PostgREST role.
alter table public.agent_telemetry enable row level security;
revoke all on public.agent_telemetry from anon, authenticated;
