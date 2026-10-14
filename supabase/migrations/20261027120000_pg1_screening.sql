-- Customer sanctions screening (lib/screening.mjs, P11).
--
--   pg1_eu_sanctioned_wallets  wallet addresses found in the EU consolidated
--                              financial sanctions list (daily sync,
--                              /api/sanctions/sync-eu): the address, its
--                              normalised form, the EU reference number and
--                              entity name (public list data), when the sync
--                              last saw it, and whether the operator dismissed
--                              it after review (an extraction error, never an
--                              OFAC entry). The sync removes delisted rows.
--   pg1_screening_events       one row per refused payer: the wallet's salted
--                              hash (never the wallet), which lists matched,
--                              the context (payment, quote, job, watchlist,
--                              foundry), and the list references. Kept 5 years
--                              as evidence of screening (lib/retention.mjs).
--
-- Service role only: RLS on, nothing for anon/authenticated.
-- NOT APPLIED AUTOMATICALLY. Safe to run more than once. Deletes no data.

create table if not exists public.pg1_eu_sanctioned_wallets (
  address_normalized text primary key,
  address text not null,
  eu_reference text,
  entity_name text,
  last_seen_at timestamptz not null default now(),
  dismissed boolean not null default false,
  dismissed_reason text,
  dismissed_at timestamptz
);

create table if not exists public.pg1_screening_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  wallet_hash text,
  lists text[] not null,
  context text not null,
  eu_references text[],
  ofac_uids text[]
);

alter table public.pg1_screening_events drop constraint if exists pg1_screening_events_shape_check;
alter table public.pg1_screening_events
  add constraint pg1_screening_events_shape_check check ((wallet_hash is null or wallet_hash ~ '^[0-9a-f]{16,64}$') and array_length(lists, 1) >= 1 and lists <@ array['ofac', 'eu']::text[]);

create index if not exists pg1_screening_events_created_idx on public.pg1_screening_events (created_at desc);
create index if not exists pg1_eu_sanctioned_wallets_seen_idx on public.pg1_eu_sanctioned_wallets (last_seen_at);

alter table public.pg1_eu_sanctioned_wallets enable row level security;
alter table public.pg1_screening_events enable row level security;
revoke all on public.pg1_eu_sanctioned_wallets from public, anon, authenticated;
revoke all on public.pg1_screening_events from public, anon, authenticated;

notify pgrst, 'reload schema';
