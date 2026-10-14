-- Watchlists (lib/watchlists.mjs): paid subscriptions to status changes of
-- wallets, domains, packages and CVE products, with an HMAC-signed webhook.
--
--   pg1_watchlists    one row per paid watchlist: subscriber_hash (salted
--                     HMAC of the paying wallet, never the wallet), the
--                     webhook URL (https, public, checked again on every
--                     delivery), status (active | expired | cancelled), items,
--                     price, expiry (30 days after purchase), the settlement
--                     transaction id, delivery bookkeeping. No secret is
--                     stored: the webhook secret is derived from
--                     PG1_WATCHLIST_SECRET and the id. Deleted 30 days after
--                     expires_at (lib/retention.mjs); items go with it.
--   pg1_watch_items   one row per watched target: kind, target, ecosystem or
--                     chain, the last status and reasons, when it was last
--                     checked and last changed.
--
-- Service role only: RLS on, nothing for anon/authenticated.
-- NOT APPLIED AUTOMATICALLY. Safe to run more than once. Deletes no data.

create table if not exists public.pg1_watchlists (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  subscriber_hash text not null,
  webhook_url text not null,
  status text not null default 'active',
  items integer not null,
  price_usd numeric(12, 6) not null,
  settlement_tx text,
  last_delivery_at timestamptz,
  delivery_failures integer not null default 0
);

alter table public.pg1_watchlists drop constraint if exists pg1_watchlists_status_check;
alter table public.pg1_watchlists drop constraint if exists pg1_watchlists_shape_check;
alter table public.pg1_watchlists
  add constraint pg1_watchlists_status_check check (status in ('active', 'expired', 'cancelled')),
  add constraint pg1_watchlists_shape_check check (subscriber_hash ~ '^[0-9a-f]{16,64}$' and webhook_url like 'https://%' and length(webhook_url) <= 2048 and items between 1 and 50 and price_usd >= 0);

create index if not exists pg1_watchlists_active_idx on public.pg1_watchlists (status, expires_at);
create index if not exists pg1_watchlists_subscriber_idx on public.pg1_watchlists (subscriber_hash, status);

create table if not exists public.pg1_watch_items (
  id uuid primary key default gen_random_uuid(),
  watchlist_id uuid not null references public.pg1_watchlists (id) on delete cascade,
  created_at timestamptz not null default now(),
  kind text not null,
  target text not null,
  ecosystem text,
  chain text,
  last_status text,
  last_reasons jsonb,
  last_checked_at timestamptz,
  last_changed_at timestamptz
);

alter table public.pg1_watch_items drop constraint if exists pg1_watch_items_kind_check;
alter table public.pg1_watch_items drop constraint if exists pg1_watch_items_status_check;
alter table public.pg1_watch_items
  add constraint pg1_watch_items_kind_check check (kind in ('wallet', 'domain', 'package', 'cve_product') and length(target) between 1 and 300),
  add constraint pg1_watch_items_status_check check (last_status is null or last_status in ('no_flags', 'flagged', 'unknown'));

create index if not exists pg1_watch_items_due_idx on public.pg1_watch_items (watchlist_id, last_checked_at);

alter table public.pg1_watchlists enable row level security;
alter table public.pg1_watch_items enable row level security;
revoke all on public.pg1_watchlists from public, anon, authenticated;
revoke all on public.pg1_watch_items from public, anon, authenticated;

notify pgrst, 'reload schema';
