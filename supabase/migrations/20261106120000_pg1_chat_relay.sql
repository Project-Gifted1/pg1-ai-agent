-- public.messages: who wrote a user message, for relay mode (/relay <name>
-- <text> in the PG1 Command Centre chat; lib/relay.mjs). NOT APPLIED
-- AUTOMATICALLY. Safe to run more than once. Changes no existing data.
--
--   speaker     'operator' for the operator's own message, 'relay' for a
--               message from another AI (Grok, ChatGPT, ...) that the
--               operator pasted in. null on older rows (all the operator's)
--               and on PG1's own replies (role model).
--   relay_name  the other AI's name as typed after /relay (letters, digits,
--               _ . -; at most 32), set only when speaker = 'relay'.
--
-- A relay row's content is the <relayed_message from=... relayed_by=
-- "operator"> envelope the model saw, so its provenance survives in the
-- text too (the archive and search_history read content).
--
-- Until this runs, api/chat.mjs inserts the rows without the two columns
-- (lib/relay.mjs insertMessageRows retries without them).
--
-- Access is unchanged: RLS on, nothing granted to anon or authenticated
-- (20260921000000_security_advisor_fixes.sql); service role only.

alter table public.messages
  add column if not exists speaker text,
  add column if not exists relay_name text;

alter table public.messages drop constraint if exists messages_speaker_check;
alter table public.messages drop constraint if exists messages_relay_name_check;

alter table public.messages
  add constraint messages_speaker_check
    check (speaker is null or speaker in ('operator', 'relay')),
  add constraint messages_relay_name_check
    check (
      (speaker = 'relay' and relay_name ~ '^[A-Za-z][A-Za-z0-9_.-]{0,31}$')
      or (speaker is distinct from 'relay' and relay_name is null)
    );

-- PostgREST caches the schema; tell it about the new columns now.
notify pgrst, 'reload schema';
