# PG1 Studio + Sound: Phase 1 research and capability registry

Project-Gifted1™ · PG1 Studio and PG1 Sound. Internal report: it names providers and models, which client-facing output never does.

Registry version 2026-10-14. Generated from `lib/capabilities/registry.mjs` and `lib/capabilities/costs.mjs` by `node scripts/capabilities-report.mjs`; edit those, not this file.

**How the figures were gathered.** The research ran on 2026-10-14 through web-search extracts of official provider pages and model cards. This session's network policy blocked loading the pages themselves, so every figure marked *official* is unverified until checked on the live page, and where pages disagreed the dearer figure is used. Figures marked *PG1 estimate* are PG1's own. No figure here comes from a third-party blog or a search redirect link.

## 1. Capability registry

| Feature | Status | Chosen model(s) | Licence | Unit cost | Min price (1.5x) | Offer rule |
|---|---|---|---|---|---|---|
| Text- and image-to-video clips | standard | gemini-omni-1.1-flash (google, primary); kwaivgi/kling-v2.1 (replicate, fallback (needs a start image)) | **unclear** (R1) | 0.1 USD per second of 720p video (official) | 0.15 USD per second of 720p video | not offered (licence review) |
| Scene and character consistency | standard | black-forest-labs/flux-kontext-pro (replicate, primary (reference and keyframes); never for client films); gemini-3.1-flash-image (google, fallback stills) | commercial_ok | 0.067 USD per still (official) | 0.1005 USD per still | may be offered |
| Storyboard and keyframe images | standard | black-forest-labs/flux-kontext-pro (replicate, primary stills; never for client films); gemini-3.1-flash-image (google, fallback stills) | commercial_ok | 0.067 USD per still (official) | 0.1005 USD per still | may be offered |
| Video upscaling to 4K | custom | topazlabs/video-upscale (replicate, chosen) | **unclear** (R1) | unknown per second of output video | after a priced test | not offered (licence review) |
| Video upscaling to 8K | unavailable | - | **unclear** (no provider) | unknown per second of output video | after a priced test | never offered |
| Frame interpolation (smoother motion, higher frame rate) | custom | ffmpeg minterpolate (motion-compensated) (pg1, chosen, on PG1's render runner) | commercial_ok | 0.06 USD per minute of output video (PG1 estimate) | 0.09 USD per minute of output video | custom, on request |
| Voice-over (one voice) | standard | eleven_multilingual_v2 (elevenlabs, primary (brand voice)); sonic-3.6 (cartesia, fallback) | **unclear** (C1) | 0.05 USD per 1,000 characters (PG1 estimate) | 0.075 USD per 1,000 characters | not offered (licence review) |
| Dialogue text-to-speech (several voices) | custom | eleven_v3 (Text to Dialogue) (elevenlabs, chosen) | commercial_ok | 0.1 USD per 1,000 characters (official) | 0.15 USD per 1,000 characters | custom, on request |
| Sound effects and Foley | custom | eleven_text_to_sound_v2 (elevenlabs, chosen) | commercial_ok | 0.12 USD per minute of audio (official) | 0.18 USD per minute of audio | custom, on request |
| Music (PG1 Sound tracks) | standard | lyria-3.5 (google, primary); lyria-3-clip-preview (google, fallback (30 s)); Eleven Music (elevenlabs, last fallback (not for film)) | commercial_ok | 0.15 USD per minute of music (official) | 0.225 USD per minute of music | may be offered |
| Music for films (score beds) | standard | lyria-3.5 (google, primary (Gemini API)); lyria-3-clip-preview (google, fallback (Gemini API, 30 s)) | commercial_ok | 0.08 USD per music bed (official) | 0.12 USD per music bed | may be offered |
| Stem separation | standard | demucs htdemucs (MIT) (pg1, primary, on PG1's runner) | commercial_ok | 0.03 USD per track (about 3 minutes) (PG1 estimate) | 0.045 USD per track (about 3 minutes) | may be offered |
| 5.1 and 7.1 surround mixes | custom | ffmpeg surround / pan from stems (pg1, chosen, on PG1's runner) | commercial_ok | 0.01 USD per track (PG1 estimate) | 0.015 USD per track | custom, on request |
| Consented voice cloning (own voice only) | custom (gated: phase4) | Professional Voice Cloning (elevenlabs, chosen (own voice, voice-captcha verified)) | commercial_ok | 0.1 USD per 1,000 characters spoken in the cloned voice (official) | 0.15 USD per 1,000 characters spoken in the cloned voice | never offered |

Never offered in this phase: client accounts or seats, an account manager, dedicated compute or GPUs, IP indemnification (never, in any phase), exclusive rights (never, in any phase).

## 2. Research by feature

### Text- and image-to-video clips

Wired now: lib/videoJobs.mjs (PG1 Motion), lib/film/providers.mjs (film shots, ROUTING_CHAINS.clips): Gemini Omni first, Kling on Replicate as the start-frame fallback (never for client films: R1).

Unit cost: Gemini Omni 1.1 Flash at 720p; Kling standard is a PG1 estimate of 0.30 USD per 5 s clip (0.06 USD per second).

| Provider | Model | What it does | Max resolution / length | Price | Licence, resale | Sources |
|---|---|---|---|---|---|---|
| google | gemini-omni-1.1-flash | text, image and short video references to video with audio; scene extension | 3-10 s per generation, extend to about 40 s; 360p, 720p, 1080p, 4K at 24 fps | about 0.10 USD per second at 720p (official); 360p about a third of that | commercial_ok: operator accepted Google's generated-content terms; operator responsible for use (G1) | [1](https://ai.google.dev/gemini-api/docs/pricing) [2](https://ai.google.dev/gemini-api/docs/omni) [3](https://blog.google/innovation-and-ai/technology/developers-tools/build-with-gemini-omni-1-1-flash/) |
| google | veo-3.1 / veo-3.1-fast / veo-3.1-lite | text and image to video with audio, up to 3 reference images, extension of Veo clips | 8 s clips at 720p, 1080p or 4K (Lite: no 4K, no extension); extension to 37 s on Google Cloud | Veo 3.1 0.40 USD/s (720p, 1080p), 0.60 USD/s 4K; Fast 0.10/0.12/0.30; Lite 0.05/0.08 | commercial_ok: operator accepted Google's generated-content terms; operator responsible for use (G1); PG1 does not use Veo: the preview models shut down on 2026-10-22 (lib/videoJobs.mjs) | [1](https://ai.google.dev/gemini-api/docs/pricing) [2](https://ai.google.dev/gemini-api/docs/veo) [3](https://ai.google.dev/gemini-api/docs/models/veo-3.1-lite-generate-preview) [4](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/extend-videos) |
| replicate | kwaivgi/kling-v2.1 | image-to-video (start image required) | 5 or 10 s; 720p standard, 1080p pro, 24 fps | per run; Replicate's June 2025 comparison listed about 0.25-0.90 USD per video; current rate not retrieved | unclear (R1) | [1](https://replicate.com/kwaivgi/kling-v2.1) [2](https://replicate.com/blog/compare-ai-video-models) [3](https://replicate.com/terms) |
| replicate | kwaivgi/kling-v2.5-turbo-pro | text and image to video | not retrieved | not retrieved | unclear (R1) | [1](https://replicate.com/kwaivgi/kling-v2.5-turbo-pro) |
| replicate | google/veo-3.1-lite | text and image to video with audio | 720p, 1080p | 0.05 USD/s 720p, 0.08 USD/s 1080p | unclear (R1: Replicate-hosted) | [1](https://replicate.com/google/veo-3.1-lite) |
| replicate | wan-video/wan-2.5-i2v | image to video | 480p, 720p, 1080p | not retrieved | unclear (R1) | [1](https://replicate.com/wan-video/wan-2.5-i2v) |

### Scene and character consistency

Wired now: lib/film: one shared reference still per film; each shot's keyframe is made from it (FLUX Kontext Pro), then animated from that keyframe.

Unit cost: Kontext Pro 0.04 USD per image; the Gemini fallback about 0.067 USD per 1K image. The clip made from each still is priced under text_image_to_video.

| Provider | Model | What it does | Max resolution / length | Price | Licence, resale | Sources |
|---|---|---|---|---|---|---|
| replicate | black-forest-labs/flux-kontext-pro | image editing and generation from a reference image | one image per run | 0.04 USD per image | unclear (R1: Replicate-hosted; Replicate's page says outputs may be used commercially, but the operator has not cleared it for client work) | [1](https://replicate.com/black-forest-labs/flux-kontext-pro) [2](https://replicate.com/blog/flux-kontext) [3](https://bfl.ai/pricing) |
| google | gemini-omni-1.1-flash (references) | images and up to 3 video references (3 s each) guide the clip | as text_image_to_video | as text_image_to_video | commercial_ok: operator accepted Google's generated-content terms; operator responsible for use (G1) | [1](https://ai.google.dev/gemini-api/docs/omni) [2](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-references) |
| google | veo-3.1 (reference images) | up to 3 reference images per clip | 8 s | as Veo above | commercial_ok: operator accepted Google's generated-content terms; operator responsible for use (G1) | [1](https://ai.google.dev/gemini-api/docs/veo) |

### Storyboard and keyframe images

Wired now: lib/film/storyboard.mjs (the storyboard), lib/film/providers.mjs (stills); /film storyboard <id> makes the PDF.

Unit cost: Dearest path (the Gemini fallback). Writing the storyboard itself is a PG1 estimate of 0.15 USD (lib/film/cost.mjs).

| Provider | Model | What it does | Max resolution / length | Price | Licence, resale | Sources |
|---|---|---|---|---|---|---|
| replicate | black-forest-labs/flux-kontext-pro | keyframes that keep the reference | one image per run | 0.04 USD per image | unclear (R1) | [1](https://replicate.com/black-forest-labs/flux-kontext-pro) [2](https://bfl.ai/pricing) |
| google | gemini-3.1-flash-image | image generation and editing | up to 4K images | about 0.045 (0.5K), 0.067 (1K), 0.101 (2K), 0.151 (4K) USD per image | commercial_ok: operator accepted Google's generated-content terms; operator responsible for use (G1) | [1](https://ai.google.dev/gemini-api/docs/pricing) |
| google | imagen-4 | text to image | - | - | commercial_ok: operator accepted Google's generated-content terms; operator responsible for use (G1); Shut down on 2026-08-17 per Google's model page | [1](https://ai.google.dev/gemini-api/docs/models/imagen) |

### Video upscaling to 4K

Unit cost: Replicate bills it per second of output; the rate could not be retrieved. Generating natively at 4K with Gemini Omni (about 0.30 USD per second, unconfirmed) is the alternative.

| Provider | Model | What it does | Max resolution / length | Price | Licence, resale | Sources |
|---|---|---|---|---|---|---|
| replicate | topazlabs/video-upscale | upscales existing video, frame rates up to 120 fps | up to 4K | per second of output; rate not retrieved | unclear (R1) | [1](https://replicate.com/topazlabs/video-upscale/api/learn-more) [2](https://replicate.com/collections/ai-enhance-videos) |
| replicate | lucataco/real-esrgan-video | Real-ESRGAN upscaling of MP4 | not stated | about 0.18 USD per run (A100) | unclear (R1) | [1](https://replicate.com/lucataco/real-esrgan-video) |
| google | gemini-omni-1.1-flash (4K output) | generates at 4K rather than upscaling | 3-10 s per generation | about 0.30 USD per second (unconfirmed) | commercial_ok: operator accepted Google's generated-content terms; operator responsible for use (G1) | [1](https://ai.google.dev/gemini-api/docs/pricing) [2](https://ai.google.dev/gemini-api/docs/omni) |

### Video upscaling to 8K

No Replicate, Google or ElevenLabs model found outputs 8K video; Replicate's Topaz model and Google's models top out at 4K.

| Provider | Model | What it does | Max resolution / length | Price | Licence, resale | Sources |
|---|---|---|---|---|---|---|
| replicate | topazlabs/video-upscale | upscaling | up to 4K | - | - | [1](https://replicate.com/collections/ai-enhance-videos) |

### Frame interpolation (smoother motion, higher frame rate)

Unit cost: PG1 estimate: about 10 runner-minutes per output minute at 1080p, at 0.006 USD per Linux 2-core minute.

Licence conditions: FFmpeg's licence (LGPL/GPL) covers the software, not the frames it outputs.

| Provider | Model | What it does | Max resolution / length | Price | Licence, resale | Sources |
|---|---|---|---|---|---|---|
| pg1 | ffmpeg minterpolate | motion-compensated frame interpolation | any resolution; runner time grows with it | runner time only | commercial_ok | [1](https://ffmpeg.org/ffmpeg-filters.html) [2](https://docs.github.com/en/billing/reference/actions-runner-pricing) |
| replicate | google-research/frame-interpolation (FILM) | interpolates between frames | per frame pair | about 0.0026 USD per run (T4) | unclear (R1) | [1](https://replicate.com/google-research/frame-interpolation) |
| replicate | pollinations/rife-video-interpolation | RIFE video interpolation | not stated | about 0.037 USD per run | unclear (R1); Practical-RIFE models are MIT per its repo | [1](https://replicate.com/pollinations/rife-video-interpolation) [2](https://github.com/hzwer/Practical-RIFE) |

### Voice-over (one voice)

Wired now: lib/film/providers.mjs (createFilmVoice, ROUTING_CHAINS.voice): ElevenLabs in each film's own voice (lib/film/voices.mjs: --voice, the Director cast, else PG1_FILM_VOICE_ID, else the premade fallback), then Cartesia sonic (sent once more on a timeout); one voice per film, never Cartesia for client films (C1).

Unit cost: PG1's film estimate (lib/film/cost.mjs voicePerCharUsd).

| Provider | Model | What it does | Max resolution / length | Price | Licence, resale | Sources |
|---|---|---|---|---|---|---|
| cartesia | sonic-3.6 | single-voice TTS (wired now) | - | PG1 estimate 0.05 USD per 1,000 characters | unclear (C1) |  |
| elevenlabs | Eleven multilingual / v3 TTS | single-voice TTS; a commercial_ok replacement for Cartesia if C1 stays open | 5,000 characters per request (v3) | 0.08-0.10 USD per 1,000 characters (pages disagree) | commercial_ok on the paid plan (E1, Creator plan) | [1](https://elevenlabs.io/pricing/api) [2](https://help.elevenlabs.io/hc/en-us/articles/13313564601361-Can-I-publish-the-content-I-generate-on-the-platform) |

### Dialogue text-to-speech (several voices)

Unit cost: ElevenLabs pages disagree: 0.08 and 0.10 USD per 1,000 characters for v3; the dearer is used.

Licence conditions: The Creator plan (E1, Creator plan). Eleven v3 and its Text to Dialogue endpoint are generally available, not a Beta Service (E2, answered).

| Provider | Model | What it does | Max resolution / length | Price | Licence, resale | Sources |
|---|---|---|---|---|---|---|
| elevenlabs | eleven_v3 Text to Dialogue | multi-speaker dialogue in one request | 5,000 characters per request (about 5 minutes) | 0.08-0.10 USD per 1,000 characters (pages disagree) | commercial_ok on the Creator plan (E1); generally available, not beta (E2) | [1](https://elevenlabs.io/pricing/api) [2](https://elevenlabs.io/docs/overview/models) [3](https://elevenlabs.io/blog/eleven-v3) [4](https://help.elevenlabs.io/hc/en-us/articles/35869113958801-How-much-does-it-cost-to-generate-using-Eleven-v3) [5](https://help.elevenlabs.io/hc/en-us/articles/13313564601361-Can-I-publish-the-content-I-generate-on-the-platform) |
| google | gemini-2.5-flash-preview-tts | speech with one or two speakers | 8,192 input tokens | 10 USD per 1M audio output tokens (about 0.02 USD per minute at 32 tokens per second) | commercial_ok: operator accepted Google's generated-content terms; operator responsible for use (G1) | [1](https://ai.google.dev/gemini-api/docs/pricing) [2](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-preview-tts) |
| replicate | resemble-ai/chatterbox-multilingual | TTS with voice prompts | not retrieved | not retrieved | unclear (R1) | [1](https://replicate.com/resemble-ai/chatterbox-multilingual) |

### Sound effects and Foley

Unit cost: The credits page lists 200 credits per generation instead; confirm the billing basis.

Licence conditions: The paid ElevenLabs plan (E1, Creator plan); not a Beta Service.

| Provider | Model | What it does | Max resolution / length | Price | Licence, resale | Sources |
|---|---|---|---|---|---|---|
| elevenlabs | eleven_text_to_sound_v2 | sound effects from text, optional seamless loop | 0.5-30 s per generation | 0.12 USD per minute (API page); 40 credits per second when a duration is set | commercial_ok on paid plans | [1](https://elevenlabs.io/pricing/api) [2](https://elevenlabs.io/docs/overview/capabilities/sound-effects) [3](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert) [4](https://help.elevenlabs.io/hc/en-us/articles/13313564601361-Can-I-publish-the-content-I-generate-on-the-platform) |

### Music (PG1 Sound tracks)

Wired now: lib/music/engines.mjs (ROUTING_CHAINS.music): Lyria 3.5 (paid Gemini key), the Lyria 3 clip model, then ElevenLabs Music; Replicate's Lyria 2 is no longer used (R1).

Unit cost: Eleven Music. Lyria 3.5 is 0.08 USD per song and the Lyria 3 clip 0.04 USD per 30 s request.

Licence conditions: ElevenLabs Music is commercial_ok on the paid plan (E1, Creator plan) except film, TV, radio and large studio games, which the plan excludes (Enterprise only). Music for a film is the film_music feature. Lyria through the Gemini API is commercial_ok (G2, answered). Lyria 2 on Replicate (R1) is no longer in the chain.

| Provider | Model | What it does | Max resolution / length | Price | Licence, resale | Sources |
|---|---|---|---|---|---|---|
| elevenlabs | Eleven Music | songs and instrumentals from a prompt | up to 5 minutes | 0.15 USD per minute | commercial_ok on the paid plan (E1, Creator plan); excludes film, TV, radio and large studio games (Enterprise only); streaming from Creator up | [1](https://elevenlabs.io/pricing/api) [2](https://elevenlabs.io/eleven-music-api) [3](https://elevenlabs.io/music-terms) |
| google | lyria-3.5 | full songs | full song | 0.08 USD per song | commercial_ok: operator accepted Google's generated-content terms; operator responsible for use (G2) | [1](https://ai.google.dev/gemini-api/docs/pricing) [2](https://ai.google.dev/gemini-api/docs/music-generation) |
| google | lyria-3-clip-preview | 30 s clips, 48 kHz stereo | 30 s | 0.04 USD per request | commercial_ok: operator accepted Google's generated-content terms; operator responsible for use (G2) | [1](https://ai.google.dev/gemini-api/docs/pricing) [2](https://ai.google.dev/gemini-api/docs/models/lyria-3-clip-preview) |
| replicate | google/lyria-2 | instrumental clips with SynthID | 30 s, 48 kHz stereo | per output; rate not retrieved | unclear (R1: Replicate-hosted) | [1](https://replicate.com/google/lyria-2) |

### Music for films (score beds)

Wired now: lib/film/providers.mjs (filmMusicExclude) and lib/music/engines.mjs (filmMusicPlan): Lyria 3.5 on the paid Gemini key, then the Lyria clip model; ElevenLabs only with PG1_ELEVENLABS_FILM_RIGHTS=1, never Replicate. A bed none can make is left out and the film finishes without it (music unavailable).

Unit cost: Lyria 3.5 at 0.08 USD per song; the clip model is 0.04 USD per 30 s. PG1 Studio's film estimate is the same 0.08 USD per bed (lib/film/cost.mjs).

Licence conditions: Lyria through the Gemini API: operator accepted Google's generated-content terms; operator responsible for use (G2, answered). ElevenLabs Music is not used: the Creator plan excludes film, TV and radio. Set PG1_ELEVENLABS_FILM_RIGHTS=1 only if the plan covers film (Enterprise). Replicate's Lyria 2 is never used for film beds (R1).

| Provider | Model | What it does | Max resolution / length | Price | Licence, resale | Sources |
|---|---|---|---|---|---|---|
| google | lyria-3.5 (Gemini API) | full songs and instrumentals | full song | 0.08 USD per song | commercial_ok: operator accepted Google's generated-content terms; operator responsible for use (G2) | [1](https://ai.google.dev/gemini-api/docs/pricing) [2](https://ai.google.dev/gemini-api/docs/music-generation) |
| google | lyria-3-clip-preview (Gemini API) | 30 s clips, 48 kHz stereo | 30 s | 0.04 USD per request | commercial_ok: operator accepted Google's generated-content terms; operator responsible for use (G2) | [1](https://ai.google.dev/gemini-api/docs/pricing) [2](https://ai.google.dev/gemini-api/docs/models/lyria-3-clip-preview) |
| elevenlabs | Eleven Music | songs and instrumentals | up to 5 minutes | 0.15 USD per minute | not for film on the Creator plan (Enterprise only) | [1](https://elevenlabs.io/music-terms) [2](https://elevenlabs.io/eleven-music-api) |

### Stem separation

Wired now: lib/music/export.mjs + scripts/music_stems.py on the music-render runner: Demucs htdemucs (drums, bass, vocals, other) and basic-pitch MIDI.

Unit cost: PG1 estimate: about 5 runner-minutes per track at 0.006 USD per minute.

Licence conditions: Demucs is MIT. The stems carry the licence of the track they come from.

| Provider | Model | What it does | Max resolution / length | Price | Licence, resale | Sources |
|---|---|---|---|---|---|---|
| pg1 | Demucs htdemucs | 4 stems (6 with htdemucs_6s) | any length; runner time grows with it | runner time only | commercial_ok (MIT) | [1](https://github.com/facebookresearch/demucs) [2](https://docs.github.com/en/billing/reference/actions-runner-pricing) |
| elevenlabs | music/stem-separation | 2 or 6 stems as a ZIP | not stated | 0.5x (2 stems) to 1x (4 stems) the generation cost, per an ElevenLabs blog post | commercial_ok on the paid plan (E1, Creator plan) | [1](https://elevenlabs.io/docs/api-reference/music/separate-stems) [2](https://elevenlabs.io/blog/eleven-music-new-tools-for-exploring-editing-and-producing-music-with-ai) |
| replicate | cjwbw/demucs | Demucs on Replicate | - | about 0.016 USD per run | MIT upstream | [1](https://replicate.com/cjwbw/demucs) [2](https://github.com/facebookresearch/demucs) |

### 5.1 and 7.1 surround mixes

Unit cost: PG1 estimate: about 1-2 runner-minutes per track.

Licence conditions: The mix carries the licence of the track and stems it is made from. No provider model was found that generates surround audio.

| Provider | Model | What it does | Max resolution / length | Price | Licence, resale | Sources |
|---|---|---|---|---|---|---|
| pg1 | ffmpeg surround filter | active upmix stereo to 5.1, and 5.1 to 7.1 | - | runner time only | commercial_ok | [1](https://ffmpeg.org/ffmpeg-filters.html) |
| pg1 | ffmpeg pan from Demucs stems | places stems in a 5.1(side) or 7.1 layout (dialogue and vocals centre, drums and bass front with LFE, other in the surrounds) | - | runner time only | commercial_ok | [1](https://ffmpeg.org/ffmpeg-filters.html) [2](https://github.com/facebookresearch/demucs) |

### Consented voice cloning (own voice only)

Unit cost: Making the clone itself is part of the plan subscription (not separately priced on the pages found).

Licence conditions: The Creator plan (E1), which includes Professional Voice Cloning. Only the account holder's own voice: ElevenLabs does not allow a Professional clone of someone else's voice, even with consent.

Consent and verification by provider:

- **elevenlabs**: Professional clones: own voice only, verified by a voice captcha (the speaker reads a prompt that is compared with the training audio); a consent attestation for every clone; celebrity and high-risk voices blocked.
- **google**: Chirp 3 Instant Custom Voice: a recorded consent statement in the fixed script for the language (up to 10 s) plus up to 10 s of reference audio; allowlist access only; 60 USD per 1M characters.
- **replicate**: No platform verification; the terms forbid impersonating someone without consent, and model pages add their own consent rules.

| Provider | Model | What it does | Max resolution / length | Price | Licence, resale | Sources |
|---|---|---|---|---|---|---|
| elevenlabs | Professional Voice Cloning | a high-fidelity clone from about 30 minutes of audio | - | plan (Creator or above) plus TTS per character | commercial_ok on paid plans | [1](https://elevenlabs.io/docs/eleven-api/concepts/voice-cloning) [2](https://elevenlabs.io/docs/cookbooks/voices/professional-voice-cloning) [3](https://help.elevenlabs.io/hc/en-us/articles/36842751624209-Can-I-create-a-Professional-Voice-Clone-of-someone-else-s-voice) |
| elevenlabs | Instant Voice Cloning | a quick clone from 1-2 minutes of audio | - | plan plus TTS per character | commercial_ok on paid plans | [1](https://elevenlabs.io/docs/eleven-api/concepts/voice-cloning) |
| google | Chirp 3 Instant Custom Voice | a custom voice from 10 s of reference audio | - | 60 USD per 1M characters | unclear: Google Cloud Text-to-Speech terms, not the Gemini API, were not reviewed | [1](https://docs.cloud.google.com/text-to-speech/docs/chirp3-instant-custom-voice) [2](https://cloud.google.com/text-to-speech/pricing) |
| replicate | resemble-ai/chatterbox-multilingual | zero-shot voice prompts | - | not retrieved | unclear (R1) | [1](https://replicate.com/resemble-ai/chatterbox-multilingual) [2](https://replicate.com/terms) |

## 3. Open licence questions (for your review)

Every feature marked **unclear** is treated as not commercial: PG1 does not offer it to clients until the question is answered and the registry is changed.

- **R1. Replicate-hosted models (Kling, FLUX Kontext Pro, FLUX schnell, Topaz, FILM): what does each model's own licence allow?** Replicate grants its rights in outputs, including commercial use, "subject to any third-party terms" of the model used. The model pages' licence tabs could not be loaded, so each model's terms are unconfirmed. Blocks: Text- and image-to-video clips; Video upscaling to 4K. [1](https://replicate.com/terms) [2](https://replicate.com/kwaivgi/kling-v2.1) [3](https://replicate.com/topazlabs/video-upscale/api/learn-more) [4](https://replicate.com/google-research/frame-interpolation)
- **T1. OpenRouter, the AI gateway and OpenAI: may their output go into a client deliverable?** Google (G1, G2), ElevenLabs (E1) and Claude (cleared by the operator on 2026-10-16) have an answer for client work. Until this one is answered, a client job's text (storyboards, scripts, checks) runs on Claude, then the paid Gemini key; the operator's own films keep the whole text chain. Blocks: none. 
- **C1. Cartesia (the voice PG1 Studio uses now for voice-over): do its terms allow resale of output?** Cartesia was outside this phase's providers (Replicate, Google, ElevenLabs), so its terms were not reviewed. Blocks: Voice-over (one voice). 

Answered:

- **G1. Google outputs (Gemini Omni, Veo, Lyria, Gemini image and TTS on the paid Gemini API): may PG1 resell them to clients?** Answered 2026-10-14 by the operator: the Gemini API Additional Terms (effective 25 Sep 2025) say "Google won't claim ownership over that content", make the user responsible for its use and do not ban selling generated output. Gemini, Veo, Imagen and Gemini TTS output through the Gemini API is commercial_ok: operator accepted Google's generated-content terms; operator responsible for use. [1](https://ai.google.dev/gemini-api/terms) [2](https://developers.google.com/terms)
- **G2. Lyria music on the paid Gemini API: may it be published and sold, including on streaming platforms and YouTube?** Answered 2026-10-14 by the operator: the same as G1, so Lyria through the Gemini API is commercial_ok (operator accepted Google's generated-content terms; operator responsible for use) and film music on it may be offered. Lyria 2 through Replicate stays unclear under R1. [1](https://ai.google.dev/gemini-api/terms) [2](https://ai.google.dev/gemini-api/docs/music-generation)
- **E1. Which ElevenLabs plan is ELEVENLABS_API_KEY on?** Answered 2026-10-14 by the operator: the Creator plan (paid self-serve), with ELEVENLABS_API_KEY set in Vercel (the key is named PG1-Studi0 in ElevenLabs). Creator includes Professional Voice Cloning of the account holder's own voice. ElevenLabs TTS, dialogue, sound effects and voice output are commercial_ok on it. The plan's Eleven Music licence excludes film, TV, radio and large studio games, so film beds stay on Lyria through the Gemini API (lib/film/providers.mjs filmMusicExclude) unless PG1_ELEVENLABS_FILM_RIGHTS=1 records that the plan covers film. [1](https://help.elevenlabs.io/hc/en-us/articles/13313564601361-Can-I-publish-the-content-I-generate-on-the-platform) [2](https://elevenlabs.io/music-terms) [3](https://elevenlabs.io/eleven-music-api)
- **E2. Is Eleven v3 Text to Dialogue still a Beta Service?** Answered 2026-10-14 by the operator: ElevenLabs' own Eleven v3 page says v3 is no longer in alpha and is generally available, including the Text to Dialogue API endpoint. No beta restriction applies. [1](https://elevenlabs.io/blog/eleven-v3) [2](https://help.elevenlabs.io/hc/en-us/articles/13313564601361-Can-I-publish-the-content-I-generate-on-the-platform)

## 4. Compute cost per film package (PG1 estimates)

Assumptions: 5-second shots, 4 shots a scene, 900 voice-over characters a minute, a quarter of shots retried once, PG1 Studio's own price table (lib/film/cost.mjs) for stills, checks, voice and music, the registry's clip rates (1080p 0.15 USD/s; 4K generated natively at about 0.30 USD/s, unconfirmed), and render time on a GitHub runner at 0.006 USD a minute. A 4K upscale of a 1080p film instead has no known price (registry: upscale_4k).

| Film | Resolution | Shots | Clips | Everything else | Expected cost | Min price (1.5x) | One film in today's pipeline? |
|---|---|---|---|---|---|---|---|
| 1 min | 1080p | 12 | 11.49 USD | 1.47 USD | 12.96 USD | 19.44 USD | yes |
| 1 min | 4k | 12 | 22.74 USD | 1.51 USD | 24.25 USD | 36.38 USD | yes |
| 3 min | 1080p | 36 | 34.47 USD | 4.02 USD | 38.49 USD | 57.74 USD | yes |
| 3 min | 4k | 36 | 68.22 USD | 4.15 USD | 72.37 USD | 108.56 USD | yes |
| 10 min | 1080p | 120 | 114.90 USD | 12.94 USD | 127.84 USD | 191.76 USD | no: over 300 s (30 shots of at most 10 s) |
| 10 min | 4k | 120 | 227.40 USD | 13.36 USD | 240.76 USD | 361.14 USD | no: over 300 s (30 shots of at most 10 s) |

Clips (with retries) are 89-95% of every package's cost, so the clip rate decides the price. A 3-minute film fits today only with longer shots (18 shots of 10 s); its estimate above uses 5-second shots, which is the dearer case.

## 5. Storage per package (PG1 estimates)

Video at 8 Mbps (1080p) and 42 Mbps (4K) H.264, from YouTube's published rates [1](https://support.google.com/youtube/answer/1722171?hl=en) [2](https://support.google.com/youtube/answer/2853702?hl=en); audio at uncompressed WAV sizes, stems as FLAC at about 55% of WAV.

| Film | Resolution | Final film | Stems (4 x FLAC) | 5.1 WAV | 7.1 WAV | Client deliverables | With working files (clips, stills) |
|---|---|---|---|---|---|---|---|
| 1 min | 1080p | 62.9 MB | 23.3 MB | 51.8 MB | 69.1 MB | 208.1 MB | 302.6 MB |
| 1 min | 4k | 317.9 MB | 23.3 MB | 51.8 MB | 69.1 MB | 463.1 MB | 876.4 MB |
| 3 min | 1080p | 188.6 MB | 69.9 MB | 155.5 MB | 207.4 MB | 622.4 MB | 902.9 MB |
| 3 min | 4k | 953.6 MB | 69.9 MB | 155.5 MB | 207.4 MB | 1.39 GB | 2.62 GB |
| 10 min | 1080p | 628.8 MB | 232.8 MB | 518.4 MB | 691.2 MB | 2.07 GB | 3.00 GB |
| 10 min | 4k | 3.18 GB | 232.8 MB | 518.4 MB | 691.2 MB | 4.62 GB | 8.74 GB |

## 6. Storage options for large video

| Option | Storage | Egress | Included / minimums | Notes | 500 GB stored, 1 TB served a month | 2 TB stored, 4 TB served | Source |
|---|---|---|---|---|---|---|---|
| Cloudflare R2 (Standard) | 0.015 USD/GB-month | free | 10 GB-month, 1M Class A and 10M Class B operations free each month | Egress to the internet is free. S3-compatible. | 7.35 USD | 29.85 USD | [1](https://developers.cloudflare.com/r2/pricing/) |
| Backblaze B2 | 0.00695 USD/GB-month | 0.01 USD/GB | egress free up to 3x the average stored data; free to Cloudflare and other partners | 6.95 USD per TB-month pay as you go. S3-compatible. | 3.47 USD | 13.90 USD | [1](https://www.backblaze.com/cloud-storage/pricing) |
| Supabase Pro (Storage) | 0.0213 USD/GB-month | 0.09 USD/GB | 100 GB storage and 250 GB uncached egress in the 25 USD plan; cached egress 0.03 USD per GB beyond 250 GB | Already PG1's vault. Uploads up to 500 GB per file on Pro. | 76.02 USD | 377.97 USD | [1](https://supabase.com/docs/guides/storage/pricing) |
| Wasabi Hot Cloud Storage | 0.00799 USD/GB-month | free | no egress or API fees within the fair-use policy | 7.99 USD per TB-month; 1 TB monthly minimum and 90-day minimum storage duration. | 7.99 USD | 15.98 USD | [1](https://wasabi.com/pricing) |
| Amazon S3 Standard (us-east-1) | 0.023 USD/GB-month | 0.09 USD/GB | first 100 GB a month of egress free across AWS | Storage and egress rates from AWS pages found by search; confirm on the S3 pricing page. | 92.50 USD | 397.00 USD | [1](https://aws.amazon.com/s3/pricing/) |

Monthly figures leave out per-request fees and Supabase's 25 USD plan fee.

**Recommendation: Cloudflare R2** for finished films, stems and mixes, with Supabase kept for the database and small files. Clients download large files, and R2 never charges for that, so the bill is storage alone and predictable: about 15 USD per TB-month. Supabase, by contrast, is 0.09 USD per GB served past 250 GB, so 4 TB served a month costs about 340 USD in egress alone. PG1 already has an R2 bucket bound in `wrangler.toml` (`pg1-storage`), and R2 is S3-compatible, so signed download links work like today's. Backblaze B2 is cheaper to store, but its egress is free only up to 3x the stored data or through a CDN partner, which adds a moving part. Wasabi needs a 1 TB minimum and 90-day minimum storage. Nothing has been set up.

## 7. Proposed scope for Phases 2-5

**Phase 2: pipeline features.** Raise the film limits so 10-minute films fit: more shots, or a film built from chapters. Then wire, as custom on request:
- 4K output, generated natively or upscaled, whichever has a confirmed price and licence;
- frame interpolation (ffmpeg minterpolate);
- sound effects (ElevenLabs);
- multi-voice dialogue (once E2 is answered);
- 5.1/7.1 mixes from stems (ffmpeg).

Each feature moves to standard in the registry only when it is wired and tested. Move large deliverables to R2. G1, G2, E1 and E2 are answered; R1 (Replicate-hosted models) and C1 (Cartesia) are still open. Until R1 is settled, client video can be made offerable by leaving the Kling fallback out of client work (Gemini Omni only), and client tracks by leaving Replicate's Lyria 2 out of the music chain; until C1 is settled, voice-over can move to ElevenLabs TTS. Film beds already stay on Lyria through the Gemini API, which is commercial_ok.

**Phase 3: client accounts.** Per-client projects, deliverable history and signed download pages on R2, with no seats or account managers until you decide otherwise. The registry gains the account features, and the guard starts allowing them.

**Phase 4: consented voice cloning.** Own-voice cloning only, through ElevenLabs Professional Voice Cloning with its voice captcha, on a Creator or higher plan. PG1 keeps its own consent record (who, when, which sample, the verification result) and offers deletion on request. PG1 Sound's refusal of all voice cloning is lifted only for verified own-voice clones. Then add 4 to SHIPPED_PHASES.

**Phase 5: support agent.** A client-facing assistant that answers from the registry, the client's own projects and the published terms. It cannot change prices, licences or deliverables, and it hands anything else to the operator.

IP indemnification and exclusive rights stay out in every phase. Everything client-facing in every phase is white-labelled (lib/whiteLabel.mjs): PG1 Studio and PG1 Sound, never a provider or model name.
