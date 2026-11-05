-- The operator's sign-in (lib/security): passkeys, sessions, the durable
-- lockout and the sign-in alerts.
--
--   pg1_operator_passkeys  the operator's passkeys (WebAuthn). Public
--                          material only: the credential ID, the public key
--                          (SPKI, base64url), its COSE algorithm and the
--                          signature counter. No private key ever exists
--                          outside the operator's device.
--   pg1_operator_sessions  signed-in sessions, keyed by SHA-256 of the
--                          token's random id (the token itself is only in
--                          the operator's httpOnly cookie). 12 h at most;
--                          revoked_at ends one at once on every instance.
--   pg1_auth_events        failed sign-in attempts (the per-IP and global
--                          lockout, the burst alert) and the burst alerts
--                          sent. The IP is a keyed hash, never the address.
--   pg1_auth_challenges    WebAuthn challenges already used (each works
--                          once).
--
-- Additive only: four new tables. Deletes no data. Service role only (RLS
-- on, no policies, nothing granted to anon or authenticated), like the
-- other pg1_* tables. Run it yourself in the Supabase SQL editor; PG1
-- never runs SQL.

create table if not exists public.pg1_operator_passkeys (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  credential_id text not null unique check (char_length(credential_id) between 16 and 1400),
  public_key text not null check (char_length(public_key) <= 1200),
  algorithm integer not null check (algorithm in (-7, -8, -257)),
  sign_count bigint not null default 0 check (sign_count >= 0),
  transports text[] not null default '{}',
  rp_id text not null check (char_length(rp_id) <= 253),
  name text not null check (char_length(name) between 1 and 40),
  device text check (char_length(device) <= 40),
  backed_up boolean not null default false,
  last_used_at timestamptz
);
alter table public.pg1_operator_passkeys enable row level security;
revoke all on public.pg1_operator_passkeys from anon, authenticated;

create table if not exists public.pg1_operator_sessions (
  id_hash text primary key check (id_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  method text not null check (method in ('password', 'passkey', 'recovery')),
  device text check (char_length(device) <= 40),
  passkey_id uuid references public.pg1_operator_passkeys (id) on delete set null,
  check (expires_at <= created_at + interval '12 hours 5 minutes')
);
create index if not exists pg1_operator_sessions_live_idx on public.pg1_operator_sessions (expires_at) where revoked_at is null;
create index if not exists pg1_operator_sessions_passkey_idx on public.pg1_operator_sessions (passkey_id);
alter table public.pg1_operator_sessions enable row level security;
revoke all on public.pg1_operator_sessions from anon, authenticated;

create table if not exists public.pg1_auth_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('failure', 'burst_alert')),
  ip_hash text check (ip_hash ~ '^[0-9a-f]{32}$'),
  method text check (method in ('password', 'passkey')),
  device text check (char_length(device) <= 40)
);
create index if not exists pg1_auth_events_ip_idx on public.pg1_auth_events (ip_hash, kind, created_at desc);
create index if not exists pg1_auth_events_kind_idx on public.pg1_auth_events (kind, created_at desc);
alter table public.pg1_auth_events enable row level security;
revoke all on public.pg1_auth_events from anon, authenticated;

create table if not exists public.pg1_auth_challenges (
  id text primary key check (id ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('register', 'signin')),
  expires_at timestamptz not null
);
create index if not exists pg1_auth_challenges_expires_idx on public.pg1_auth_challenges (expires_at);
alter table public.pg1_auth_challenges enable row level security;
revoke all on public.pg1_auth_challenges from anon, authenticated;
