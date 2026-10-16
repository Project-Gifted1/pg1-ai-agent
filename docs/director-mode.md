# PG1: central fallback router and Director Mode

Status: plan, then build (this PR). Builds on #323. One PR, one commit per
part; nothing is merged without the operator.

## Part A: one fallback router

### A1. Chains live in the capability registry

`lib/capabilities/registry.mjs` gains `ROUTING_CHAINS`: one ordered list of
steps per kind of call. Each step names a provider (the ledger name), the
registry feature and model it stands for (so its licence is the registry's),
and the env var that holds its key. `lib/router/chains.mjs` is the one
engine that reads them:

- `chainPlan(id, { env, clientWork, exclude, ledger })` turns a chain into
  the candidates this deployment can use, in order, and says why each other
  step was left out (`no_key`, `licence`, `budget`, `breaker`).
- `runChain({ id, attempt, ... })` runs a plan: it moves on only on a
  capacity failure (A2), stops on a refusal, records each attempt in the
  ledger and raises the capacity alert (A6).

Every existing call site keeps its own wire code (Anthropic, Gemini,
Replicate, Cartesia, ElevenLabs request shapes) and asks the chain for its
order. `planRoute` (chat, text, TTS), `createFilmMedia` (stills, clips),
`createFilmVoice`, `filmMusicPlan`/`musicPlan`, the `/image` engines and the
Lab's research call all take their order from `ROUTING_CHAINS`.

| Chain | Order as built | Used by |
|---|---|---|
| `text` | Claude, Gemini (paid), OpenRouter, AI gateway, OpenAI | storyboard, shot checks, edits, Director writing and critic, chat heavy |
| `chat_light` | Gemini free (operator only), Gemini paid, Claude, OpenRouter, gateway, OpenAI | chat light replies (kept cost-first; see Open questions) |
| `research` | Gemini (paid, Google Search grounding), Claude (web search tool) | Lab research, Director brief research |
| `stills` | FLUX Kontext Pro (Replicate), Gemini image | film reference and shot stills |
| `clips` | Gemini Omni, Kling (Replicate) | film clips (was Kling first) |
| `image` | Gemini image, Gemini image pro, FLUX schnell (Replicate) | `/image` (order unchanged) |
| `voice` | ElevenLabs in the film's own voice (`--voice`, the Director cast, else `PG1_FILM_VOICE_ID`, else the premade fallback), Cartesia | film voice-over (was Cartesia first) |
| `dialogue` | ElevenLabs Text to Dialogue, ElevenLabs per-line TTS (same voices) | Director dialogue lines (new) |
| `sfx` | ElevenLabs sound effects | Director SFX cues (new) |
| `music_film` | Lyria 3.5, Lyria clip (both Gemini API); ElevenLabs only with `PG1_ELEVENLABS_FILM_RIGHTS=1` | film beds |
| `music` | Lyria 3.5, Lyria clip, ElevenLabs Music | `/music` (non-film; was ElevenLabs first; Replicate's Lyria 2 dropped: R1) |

### A2. What falls through and what stops

One classifier, `failureClass(status, text, { refused })` in
`lib/router/chains.mjs`, used by every chain:

- **capacity (falls through):** out of credit or quota (402, billing
  wording on any status), 429 (after the throttle waits), 5xx, timeout,
  network error, missing key, 401/403 (a revoked key is a missing key) and
  404 (the model is gone).
- **refused (stops, never tries the next engine):** a provider's content
  safety block (`PROHIBITED_CONTENT`, `SAFETY`, `IMAGE_SAFETY`, Anthropic
  `refusal`, OpenRouter `content_filter`, Replicate NSFW), and PG1's own
  filters (music safety, the Director brief check). The stage stops with
  `refused`.
- **error (stops):** any other 4xx: the request itself is wrong, so
  another engine would not help.
- Kept as before: a reply that fails PG1's own format check twice on one
  engine moves on (the engine answered, but unusably).

### A3. Licence for client work

A call made for a client film (`client` set on the project) or a client
track (`/music … --client`) uses only steps whose registry licence is
`commercial_ok`. Google (G1, G2), ElevenLabs (E1) and Claude (cleared by
the operator for client text) are `commercial_ok`; every other engine is
`unclear` until the operator answers its licence question: FLUX Kontext Pro,
FLUX schnell and Kling on Replicate (R1), Cartesia (C1), and OpenRouter, the
AI gateway and OpenAI (T1). FLUX Kontext Pro is also `deliverable: false`:
its stills become the keyframes clips are made from, so a client film skips
it whatever its licence. So a client film's text runs on Claude, then the
paid Gemini key, its stills on Gemini image, its clips on Gemini Omni and
its voice, dialogue and SFX on ElevenLabs. `planRoute` applies the same rule
(`clientWork`), so OpenRouter, the AI gateway and OpenAI are never planned
for client work. ElevenLabs Music is never used for a client (`clientExcluded`:
its licence excludes film, TV and radio), on `/music` or in a film; the
operator's own tracks keep it. When no cleared engine is left, the stage
stops with a clear message instead of using an unlicensed engine.

### A4. One engine per stage

Each film stage keeps one engine per kind (stills, clips, voice). Once a
kind switches, the rest of the stage stays on the new engine, and the items
made earlier in the stage on the old one are made again on the new one, so
a film never mixes voices or clip styles. A later stage starts on the
engine the stored items used. Music beds are per scene and may differ.

### A5. Cost

- The film's spending cap is checked before every call, on the price of the
  engine that will make it (the dearest one the chain could fall to is
  reserved, the rest given back).
- A priced client job (`price_usd` on the project) also keeps the 1.5x
  floor: spend may not pass `price / 1.5`. A fallback that would break
  either stops the stage: "no engine fits the budget: <step> needs X USD on
  <engine>, Y USD left".

### A6. Capacity alerts

On a capacity failure the router push-notifies the operator once per engine
per hour, naming the engine and the failure ("Replicate is out of credit;
clips moved to the next engine"). Operator-only, so provider names are
allowed in this one notification. The once-per-hour claim is a database row
(`pg1_router_alerts`, migration below), so the Vercel functions and the
render worker share it; without the table it falls back to once per process.

### A7. Fixes

- Music beds are scored to each scene's length (asked for that many
  seconds; the clip model only for scenes of 30 s or less, else as a
  fallback that fades out). The mix no longer loops a bed.
- Music cues are scored to each scene's length from the shot list (the sum
  of its shots' durations, or the edit's length when narration makes the
  scene longer); a cue's fingerprint holds that length, so a scene made
  longer or shorter gets a new cue.
- Every engine's price lives in the registry (`ENGINE_UNIT_COSTS`) and the
  ledger records the price of the engine that made the call: Kling 0.30 USD
  and Gemini Omni 0.50 USD per 5 s standard clip (not 1.40), FLUX Kontext
  Pro 0.04 and Gemini image 0.067 per still, Lyria 3.5 0.08 per bed (the
  clip model 0.04), ElevenLabs 0.10 per 1,000 characters (speech and
  dialogue), 0.12 per minute (SFX), 0.15 per minute (music), Cartesia 0.05
  per 1,000 characters. `supabase/migrations/20261029140000_pg1_ledger_clip_costs.sql`
  corrects the clip rows written before (preview query in
  `supabase/previews/`).
- ElevenLabs requests use Creator-plan formats only: `pcm_24000` for speech
  and dialogue, `mp3_44100_192` for SFX and music (`pcm_44100` and
  `pcm_48000` need the Pro plan; a test keeps them out).
- A real ElevenLabs test line in the brand voice: a `voice_check` stage of
  the render workflow (one fixed sentence, no database writes, the WAV kept
  as the run's artifact), dispatched once from this branch.

## Part B: Director Mode

`/film director <brief>` (operator only). Options: `--seconds 15..300`
(at most 30 shots of 10 s; the cap and the 1.5x floor still stop it sooner),
`--client "<name>"` (client film), `--price <usd>` (the package price, for
the 1.5x floor), `--credit on|off` (the PG1 credit lines on a client film).
Images attached to the message are the client's or the operator's brand
assets, as for `/film`.

The operator's own film starts at once (`director_queued`, `directing`,
`done`) and stops on its own only when the cap or the price floor would be
passed or a safety filter refuses; `PG1_DIRECTOR_START_APPROVAL=1` makes it
ask first. A client film always waits for the operator's approval to start
(`awaiting_director_approval`) and, with `PG1_DIRECTOR_CLIENT_APPROVAL` on
(the default), again before delivery (`awaiting_delivery_approval`).

Every stage's output is saved on the project (`director` column) and every
asset in the media library with its fingerprint, so a stopped run resumes at
the stage it stopped (`/film retry`) and pays for nothing twice.

| # | Stage | What it does | Reused | New |
|---|---|---|---|---|
| 1 | Writing | brief to treatment to script: beats, look, mood, runtime | `filmThink` (text chain, validation, retry) | `lib/film/director.mjs` prompts and checks |
| 2 | Shot list | per shot: size, camera move, lens feel, lighting, blocking, continuity notes, intended duration, SFX cues | timeline schema and `normaliseTimeline` | the extra shot fields |
| 3 | Storyboard | reference still and a still per shot; each still scored against the script; weak ones made again (once); characters and style locked by the reference | stills, reference, fingerprints | still critic |
| 4 | Production | clips, voice-over, dialogue, SFX, music through the Part A chains | the render pipeline | dialogue and SFX engines |
| 5 | Dailies | a critic scores every clip against its intent (composition, continuity, motion artefacts, faces and hands, text errors) and regenerates weak shots within budget, at most 2 retries a shot, reasons logged | shot check and retries | the director rubric and the log |
| 6 | Edit | pacing to the script, cuts on action (the critic's best start), transitions, one grade, voice clear, music ducked under voice and dialogue, SFX, music cues on scene cuts, loudness -14 LUFS | `planCuts`, mix, loudness | SFX in the mix |
| 7 | Titles and credits | opening title card; end crawl "Directed by PG1 Studio", "Music and sound by PG1 Sound", "A Project-Gifted1™ production"; then the operator's logo end card, held, never generated. No © line, no provider or model names. Client films: the client's logo and name; PG1 credit lines on or off per package | title cards, image shots, white label | the crawl and logo card |

Deliverables: the master, a 9:16 social cut (the master fitted on a blurred
fill, captions kept), audio stems (voice, music, SFX as WAV), and a PDF of
the director's notes (treatment, script, shot list, dailies decisions, edit
decisions), all in the media library. At the end the operator gets a push
with the film, its cost and the shots that were regenerated.

Craft rules in every Director prompt: framing, coverage, rhythm and
motivated camera; never imitate a named living director's signature style
(a brief that asks for one is rewritten to describe the look in neutral
craft terms, with a note).

## Manual steps and migration

- `PG1_FILM_VOICE_ID` (optional): the ElevenLabs voice for films with no
  `--voice` and no cast. Fallback order: `PG1_FILM_VOICE_ID` while it is
  still in the account (GET /v1/voices; cleared, for a client film), else
  `FALLBACK_PREMADE_VOICE` (`lib/film/voices.mjs`: the premade voice
  George, male and British), its id looked up by name in the account's
  voice list. A missing or invalid voice never fails a film. Cartesia's
  voice is `CARTESIA_VOICE_ID` only.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` as Actions secrets, so the render
  worker can push the alerts and the end-of-film notice.
- `PG1_DIRECTOR_CLIENT_APPROVAL` (default on), `PG1_STUDIO_LOGO_PATH`
  (storage path of the logo end card; default the PG1 mark shipped in
  `public/brand/pg1-icon-512.png`), `PG1_DIRECTOR_VOICES` (optional
  `Name=voiceId;Name=voiceId` for characters' dialogue; default premade
  voices in cast order).
- `PG1_DIRECTOR_START_APPROVAL` (optional, Vercel): `1` makes the
  operator's own Director films wait for an approval to start.
- Cloudflare R2 for the large files (clips, masters, the 9:16 cut, stems),
  bucket `pg1-storage`, in both Vercel and GitHub Actions:
  `R2_ACCOUNT_ID` and `R2_BUCKET` (Actions variables), `R2_ACCESS_KEY_ID`
  and `R2_SECRET_ACCESS_KEY` (Actions secrets; `/film sync-secrets` copies
  them from Vercel). Without them every file stays in Supabase Storage.
- The migrations `supabase/migrations/20261029130000_pg1_director.sql` and
  `supabase/migrations/20261029140000_pg1_ledger_clip_costs.sql` (run the
  preview query first).

## Open questions for the operator

- Chat light replies keep their cost-first order (free Gemini first). The
  request's text chain (Claude first) is applied to storyboards, checks and
  heavy chat. Moving every light reply to Claude would multiply chat cost;
  one line in `ROUTING_CHAINS` changes it.
- T1: may output from OpenRouter, the AI gateway or OpenAI go into a client
  deliverable? Until answered, a client film's text runs on Claude, then the
  paid Gemini key (one line in `ROUTING_CHAINS` changes it).

## Film voices (per film)

`lib/film/voices.mjs`. Voices come from the account (ElevenLabs `GET /v1/voices`,
cached in memory for 5 minutes, so one film reads the list once).

- **`--voice "<name or id>"`** on `/film` and `/film director`: exact
  `voice_id` first, then the name, case-insensitive and trimmed (the part
  before " - " of a premade tagline name also matches). Unknown: the three
  closest names (edit distance). Two voices with the name: both listed with
  ids. Either stops before the film row, the render dispatch or any engine
  call. Saved on the film as `director.cast.narrator` (source `flag`).
- **Director casting** (no `--voice`, or `--voice` for the narrator only):
  after the shot list, the narrator and every character with dialogue are
  matched to voice labels (`gender`, `age`, `accent`, `description`,
  `use_case`) and descriptions, from the character's own description first
  and the script clauses that name it after; each role gets its own voice.
  Saved as `director.cast = { narrator: { voice_id, name }, characters:
  { "<role>": { voice_id, name } }, cast_at, source }`. Every resume, retry
  and regeneration reads it; a film is never recast (a role the shot list
  adds later is cast on its own). A cast voice gone from the account falls
  back for that role only, logged, and the lines it already read are
  recorded again so a role never changes voice mid-film.
- **Client clearance** (`isClientCleared`): premade voices, and voices the
  account owns (`is_owner: true` with category `cloned`, `generated` or
  `professional`). Never a Voice Library copy: `sharing.status` `copied` or
  `copied_disabled`, or `sharing.original_voice_id` naming another voice.
  Library copies share categories with our own voices, so category alone
  never decides. Used by `/voices`, casting and `--voice`.
- **`/voices`** (operator only): name, a short description from the labels,
  cleared for client work yes/no, and the id. PG1 wording only; provider
  errors stay in the server log.
- **Engine rules** (unchanged): `pcm_24000`; one engine per stage (a stage
  that moves to Cartesia records its earlier lines again there); never
  Cartesia for a client film (the primary is sent twice, then the stage
  fails in PG1 words).
