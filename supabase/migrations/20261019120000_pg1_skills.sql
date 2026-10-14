-- PG1 skills (lib/skills): reusable instructions PG1 loads on demand.
--
--   pg1_skills          one row per skill, its current version. status:
--                       draft (not used) | lab (being evaluated, P4) |
--                       active (its name and description go into the chat
--                       prompt; load_skill returns its instructions) |
--                       disabled. origin: operator | learned | seed | lab |
--                       web | file; web/file are always untrusted = true.
--   pg1_skill_versions  every saved version (history, rollback). Never
--                       updated or deleted by PG1.
--   pg1_skill_signals   a sha256 of a request's keywords per successful
--                       request with no skill loaded, for the "3 similar
--                       requests -> draft a skill?" suggestion. No text, no
--                       caller. Deleted after 30 days (lib/retention.mjs).
--
-- Seeds: four DRAFT skills (film-promo, music-session, threat-check-writeup,
-- pdf-report). They are not used until the operator enables them.
--
-- Service role only: RLS on, no policies, nothing for anon/authenticated.
-- NOT APPLIED AUTOMATICALLY. Safe to run more than once. Deletes no data.

create table if not exists public.pg1_skills (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null unique,
  description text not null,
  instructions text not null,
  allowed_tools text[],
  evals jsonb not null default '[]'::jsonb,
  version integer not null default 1,
  status text not null default 'draft',
  origin text not null default 'operator',
  untrusted boolean not null default false,
  uses integer not null default 0,
  successes integer not null default 0,
  last_used_at timestamptz
);

alter table public.pg1_skills drop constraint if exists pg1_skills_name_check;
alter table public.pg1_skills drop constraint if exists pg1_skills_description_check;
alter table public.pg1_skills drop constraint if exists pg1_skills_instructions_check;
alter table public.pg1_skills drop constraint if exists pg1_skills_status_check;
alter table public.pg1_skills drop constraint if exists pg1_skills_origin_check;
alter table public.pg1_skills drop constraint if exists pg1_skills_untrusted_check;
alter table public.pg1_skills drop constraint if exists pg1_skills_evals_check;

alter table public.pg1_skills
  add constraint pg1_skills_name_check check (name ~ '^[a-z0-9-]{3,48}$'),
  add constraint pg1_skills_description_check check (char_length(description) between 10 and 300),
  add constraint pg1_skills_instructions_check check (char_length(instructions) between 20 and 6000),
  add constraint pg1_skills_status_check check (status in ('draft', 'lab', 'active', 'disabled')),
  add constraint pg1_skills_origin_check check (origin in ('operator', 'learned', 'seed', 'lab', 'web', 'file')),
  add constraint pg1_skills_untrusted_check check (untrusted or origin not in ('web', 'file')),
  add constraint pg1_skills_evals_check check (jsonb_typeof(evals) = 'array' and jsonb_array_length(evals) between 1 and 3);

create index if not exists pg1_skills_status_idx on public.pg1_skills (status);

create table if not exists public.pg1_skill_versions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  skill_id uuid not null references public.pg1_skills (id) on delete cascade,
  version integer not null,
  name text not null,
  description text not null,
  instructions text not null,
  allowed_tools text[],
  evals jsonb not null,
  change_note text,
  unique (skill_id, version)
);

create table if not exists public.pg1_skill_signals (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  fingerprint text not null
);

alter table public.pg1_skill_signals drop constraint if exists pg1_skill_signals_fingerprint_check;
alter table public.pg1_skill_signals add constraint pg1_skill_signals_fingerprint_check check (fingerprint ~ '^[0-9a-f]{64}$');
create index if not exists pg1_skill_signals_fp_idx on public.pg1_skill_signals (fingerprint, created_at);

alter table public.pg1_skills enable row level security;
alter table public.pg1_skill_versions enable row level security;
alter table public.pg1_skill_signals enable row level security;
revoke all on public.pg1_skills from public, anon, authenticated;
revoke all on public.pg1_skill_versions from public, anon, authenticated;
revoke all on public.pg1_skill_signals from public, anon, authenticated;

-- Seed drafts (lib/skills/skill.mjs SEED_SKILLS). Inserted once; an
-- existing skill of the same name is left exactly as it is.

insert into public.pg1_skills (name, description, instructions, allowed_tools, evals, version, status, origin, untrusted)
values ('film-promo',
  $pg1$Making a promotional film or trailer for PG1 or a PG1 feature with /film.$pg1$,
  $pg1$1. Ask which features the film should show if the operator did not say; claim only features that are live today (check /help or the operator), never planned ones.
2. Keep it 45-75 seconds: a hook in the first 5 seconds, 3-5 scenes, one idea per scene.
3. End on a logo end card: use the attached logo unaltered (held, not regenerated) and the product name "PG1".
4. Voice-over in short, plain sentences; captions on unless the operator turns them off.
Pitfalls: no invented numbers, customer names or testimonials; no provider or model names on screen; never show a real wallet address or key.
Preferences: calm, confident tone; cool grade; music under the voice-over, not over it.$pg1$,
  null,
  $pg1$[{"prompt":"Make a 60 second promo for PG1 preflight checks with our logo at the end","traits":["claims only live features","ends on the logo end card","between 45 and 75 seconds"]},{"prompt":"Trailer for the PDF feature","traits":["asks or states which live features are shown","no invented customer quotes"]}]$pg1$::jsonb,
  1,
  'draft',
  'seed',
  false)
on conflict (name) do nothing;

insert into public.pg1_skills (name, description, instructions, allowed_tools, evals, version, status, origin, untrusted)
values ('music-session',
  $pg1$A /music session: briefing a track, choosing between the two previews, and editing or exporting it.$pg1$,
  $pg1$1. Turn the operator's words into a brief: genre, mood, instruments, era, tempo (BPM) and key when given; say what you assumed.
2. After the two previews, describe how they differ in one line each; let the operator pick. A declined take stays declined: never bring it back unless asked.
3. For changes use /music edit with the track id from [TASK STATE]; keep everything the operator did not ask to change.
4. Export only after a take is approved; say what the zip contains (stems, MIDI, WAV master).
Pitfalls: never claim exclusive copyright; never imitate a named living artist's voice; lyrics only from the operator.$pg1$,
  null,
  $pg1$[{"prompt":"Make a dark synthwave beat around 96 BPM","traits":["states the brief with genre, mood and BPM","no artist imitation"]},{"prompt":"I declined take 1, now make it warmer","traits":["edits the same track id","does not revive the declined take"]}]$pg1$::jsonb,
  1,
  'draft',
  'seed',
  false)
on conflict (name) do nothing;

insert into public.pg1_skills (name, description, instructions, allowed_tools, evals, version, status, origin, untrusted)
values ('threat-check-writeup',
  $pg1$Writing up the results of PG1 checks (wallet, domain, hostname, package, CVE) for a report or a customer.$pg1$,
  $pg1$1. Run the checks first; write only from their results. Quote each status (flagged, no flags, unknown) and its reason codes.
2. Lead with the decision in one sentence, then one short section per subject: status, main reasons, data_as_of, request_id.
3. Unknown is never safe: say what did not complete and how to re-run it.
4. End with recommended actions in plain words and the line "Not legal advice."
Pitfalls: never call a subject "safe"; never add threat details the checks did not return; never include a raw IP or key.$pg1$,
  array['check_wallet_sanctions', 'check_wallet_age', 'check_domain_age', 'check_hostname_reputation', 'check_package', 'get_cve_details', 'get_ioc_context']::text[],
  $pg1$[{"prompt":"Write up the checks on pg1-test-flagged.invalid for a customer","traits":["quotes the status and reason codes","includes request_id","never says safe"]}]$pg1$::jsonb,
  1,
  'draft',
  'seed',
  false)
on conflict (name) do nothing;

insert into public.pg1_skills (name, description, instructions, allowed_tools, evals, version, status, origin, untrusted)
values ('pdf-report',
  $pg1$Producing a polished PDF report with /pdf: structure, tables and sources.$pg1$,
  $pg1$1. Agree the audience and length if unclear (one question at most).
2. Structure: a title, a one-paragraph summary, sections with "## " headings, tables for anything with columns, a sources section.
3. Every figure has a source or is marked as an estimate; dates in ISO format.
4. Keep tables to 6 columns or fewer so they fit the page; split wider data.
Pitfalls: no images from URLs; no invented citations; nothing confidential from the operator's memory unless asked.$pg1$,
  null,
  $pg1$[{"prompt":"Make a PDF report of this week's usage","traits":["has a summary paragraph","uses a table","cites the usage report as its source"]}]$pg1$::jsonb,
  1,
  'draft',
  'seed',
  false)
on conflict (name) do nothing;

insert into public.pg1_skill_versions (skill_id, version, name, description, instructions, allowed_tools, evals, change_note)
select s.id, s.version, s.name, s.description, s.instructions, s.allowed_tools, s.evals, 'seed'
from public.pg1_skills s
where s.origin = 'seed'
  and not exists (select 1 from public.pg1_skill_versions v where v.skill_id = s.id and v.version = s.version);

notify pgrst, 'reload schema';
