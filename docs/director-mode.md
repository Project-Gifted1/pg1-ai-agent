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
| `voice` | ElevenLabs brand voice (`PG1_FILM_VOICE_ID`), Cartesia | film voice-over (was Cartesia first) |
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

A call made for a client film (`client` set on the project) uses only steps
whose registry model licence is `commercial_ok`. As the registry stands:
Kling (R1) and Cartesia (C1) are `unclear`, so a client film's clips run on
Gemini Omni alone and its voice on ElevenLabs alone; when those are out, the
stage stops with a clear message instead of using an unlicensed engine.

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
- The router ledger records each clip's real cost (Kling 0.30 USD per 5 s
  standard, Gemini Omni at its per-second price), not the 1.40 USD worst
  case, and a Lyria 3.5 bed at 0.08 USD (the clip model at its own 0.04), so
  `/usage` matches the film's own charges. Film estimates use 0.08 per bed.
- A real ElevenLabs test line in the brand voice: a `voice_check` stage of
  the render workflow (one fixed sentence, no database writes, the WAV kept
  as the run's artifact), dispatched once from this branch.

## Part B: Director Mode

`/film director <brief>` (operator only). Options: `--seconds 20..120`,
`--client "<name>"` (client film), `--price <usd>` (the package price, for
the 1.5x floor), `--credit on|off` (the PG1 credit lines on a client film).
Images attached to the message are the client's or the operator's brand
assets, as for `/film`.

One approval at the start (the budget and cap, as every PG1 spend), then the
worker runs every stage alone. It stops only when the cap or price floor
would be passed, a safety filter refuses, or, for a client film, before
delivery (`PG1_DIRECTOR_CLIENT_APPROVAL`, default on).

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

- `PG1_FILM_VOICE_ID`: the ElevenLabs brand voice id (Vercel and GitHub
  Actions variable). Cartesia's voice is `CARTESIA_VOICE_ID` only from now.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` as Actions secrets, so the render
  worker can push the alerts and the end-of-film notice.
- `PG1_DIRECTOR_CLIENT_APPROVAL` (default on), `PG1_STUDIO_LOGO_PATH`
  (storage path of the logo end card; default the PG1 mark).
- The migration `supabase/migrations/20261030120000_pg1_director.sql`.

## Open questions for the operator

- Chat light replies keep their cost-first order (free Gemini first). The
  request's text chain (Claude first) is applied to storyboards, checks and
  heavy chat. Moving every light reply to Claude would multiply chat cost;
  one line in `ROUTING_CHAINS` changes it.
- The single approval at the start of a Director run (budget and cap) is
  kept, as for every PG1 spend; `PG1_DIRECTOR_START_APPROVAL=0` removes it.
