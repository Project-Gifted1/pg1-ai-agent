-- wallet_first_seen: permanent result cache for the check_wallet_age MCP
-- tool (issue #209).
--
-- Keyed by (address, chain). A "found" row (first_seen not null) never
-- changes — an address's earliest on-chain transfer is a historical fact —
-- so those rows are cached forever and never re-queried. A "not found" row
-- (first_seen null) is only valid for 10 minutes from checked_at, since a
-- wallet can start transacting at any time; api/mcp.mjs re-queries and
-- upserts once that window has passed. Written via plain PostgREST
-- reads/upserts from api/mcp.mjs's handleCheckWalletAge, using the
-- service-role key only. If this table is missing or unreachable, the tool
-- still works uncached (see lib comment in api/mcp.mjs).
create table if not exists public.wallet_first_seen (
  address text not null,
  chain text not null check (chain in ('base', 'ethereum', 'arbitrum', 'optimism', 'polygon', 'bsc')),
  first_seen timestamptz,
  first_seen_block bigint,
  first_direction text check (first_direction in ('in', 'out')),
  is_contract boolean not null default false,
  checked_at timestamptz not null default now(),
  primary key (address, chain)
);

-- Speeds up the 10-minute not-found TTL check in handleCheckWalletAge (only
-- relevant for first_seen is null rows; found rows never re-check this).
create index if not exists wallet_first_seen_not_found_ttl_idx
  on public.wallet_first_seen (chain, checked_at)
  where first_seen is null;

-- Service-role only, same reasoning as public.pg1_errors and
-- public.pending_actions: every read and write goes through
-- api/mcp.mjs's handleCheckWalletAge using the service-role key, never the
-- anon/authenticated PostgREST role.
alter table public.wallet_first_seen enable row level security;
revoke all on public.wallet_first_seen from anon, authenticated;
