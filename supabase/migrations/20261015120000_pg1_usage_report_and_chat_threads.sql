-- Two changes, both service-role only:
--
-- 1. agent_telemetry: what the reorganised /usage report needs
--    (lib/telemetry.mjs writes, lib/usageStats.mjs reads).
--      event_type 'mcp_request'  one row per JSON-RPC request to /api/mcp
--                                that is neither initialize nor tools/call
--                                (tools/list, notifications, ping, unknown
--                                methods, a body that is not JSON), so MCP
--                                requests and tool calls can be counted apart
--      mcp_method text           the method of an mcp_request row: one of a
--                                fixed list, else 'other' (never caller text)
--      requested_tool text       on unknown_tool rows only: the tool name the
--                                caller asked for, reduced like client_name
--                                (letters, digits, space . _ - / @ + ( ) only,
--                                no 0x-hex or 20+ character runs, <= 64 chars)
--      amount_usd numeric        on settled settlement rows only: the price
--                                settled, in USD, for the revenue line
--    The status column (free text) also gains 'free_limit_reached' (a
--    payment challenge sent after the caller's free-tier quota ran out),
--    'method_not_found' and 'parse_error'; no constraint change is needed.
--    Until this runs, every existing row shape still inserts (the new keys
--    are only sent on the rows they apply to) and /usage reads the old
--    columns and says so.
--
-- 2. pg1_chat_threads: chats the operator saves from the PG1 chat (the save
--    button in the top bar and the Session threads sheet, api/threads.mjs).
--    One row per saved chat: a title (auto-generated from the first message,
--    renameable), the messages as a JSON array of { role, text, at }, and
--    created/updated times. Every title and message text passes the reply
--    secret guard (lib/secretGuard.mjs createReplySecretGuard) before it is
--    stored, so no key, token or configuration value is ever saved. Only the
--    signed-in operator can save, list, load, rename or delete; guests
--    cannot. Access is service role only: RLS on, no policies, nothing
--    granted to anon or authenticated.
--
-- Safe to run more than once.

-- 1. agent_telemetry --------------------------------------------------------

alter table public.agent_telemetry
  add column if not exists mcp_method text,
  add column if not exists requested_tool text,
  add column if not exists amount_usd numeric(12, 6);

alter table public.agent_telemetry drop constraint if exists agent_telemetry_event_type_check;
alter table public.agent_telemetry drop constraint if exists agent_telemetry_mcp_method_check;
alter table public.agent_telemetry drop constraint if exists agent_telemetry_requested_tool_check;
alter table public.agent_telemetry drop constraint if exists agent_telemetry_amount_usd_check;

alter table public.agent_telemetry
  add constraint agent_telemetry_event_type_check
    check (event_type in ('tool_call', 'settlement', 'initialize', 'mcp_request')),
  add constraint agent_telemetry_mcp_method_check
    check (mcp_method is null or char_length(mcp_method) <= 40),
  add constraint agent_telemetry_requested_tool_check
    check (requested_tool is null or char_length(requested_tool) <= 64),
  add constraint agent_telemetry_amount_usd_check
    check (amount_usd is null or amount_usd >= 0);

-- 2. pg1_chat_threads -------------------------------------------------------

create table if not exists public.pg1_chat_threads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  title text not null,
  messages jsonb not null default '[]'::jsonb,
  message_count integer not null default 0
);

alter table public.pg1_chat_threads drop constraint if exists pg1_chat_threads_title_check;
alter table public.pg1_chat_threads drop constraint if exists pg1_chat_threads_messages_check;
alter table public.pg1_chat_threads drop constraint if exists pg1_chat_threads_message_count_check;

alter table public.pg1_chat_threads
  add constraint pg1_chat_threads_title_check
    check (char_length(title) between 1 and 120),
  add constraint pg1_chat_threads_messages_check
    check (jsonb_typeof(messages) = 'array'),
  add constraint pg1_chat_threads_message_count_check
    check (message_count between 0 and 1000);

-- The Session threads sheet lists newest first.
create index if not exists pg1_chat_threads_updated_at_idx
  on public.pg1_chat_threads (updated_at desc);

alter table public.pg1_chat_threads enable row level security;
revoke all on public.pg1_chat_threads from public, anon, authenticated;

-- Let PostgREST see the new columns and table now rather than on its next reload.
notify pgrst, 'reload schema';
