// PG1 Studio + Sound capability registry (Phase 1).
//
// One entry per feature PG1 might sell in a Studio (film) or Sound (music)
// package. Package and offer answers read this file (lib/capabilities/
// offers.mjs); nothing else decides what PG1 may offer.
//
//   status   standard     wired into PG1 Studio or Sound now
//            custom       a provider model exists but PG1 has not wired it
//            unavailable  no provider offers it
//   licence  commercial_ok   the provider's terms allow commercial use and
//                            resale of the output (conditions listed)
//            non_commercial  they do not
//            unclear         not settled; the operator reviews it
//                            (`review`). Never treated as commercial_ok.
//
// A feature's licence is the WORST verdict of every model that can produce
// a client deliverable on its path (`deliverable: true`), because a
// fallback engine can make the file the client receives. featureLicence()
// computes it and the tests hold the stored verdict to it.
//
// Unit costs. `basis` says where a figure comes from:
//   official      a provider's own pricing page (sources[])
//   pg1_estimate  PG1's own estimate, labelled as such wherever shown
//   unknown       no price could be found; min price is then null and
//                 the feature can only be quoted after a priced test run
// The research for Phase 1 ran on 2026-10-14 through search-engine extracts
// of the official pages (the session's network policy blocked loading the
// pages directly), so every official figure is `verified: false` until the
// operator confirms it on the live page.
//
// Min price = 1.5 x the dearest deliverable path's unit cost, rounded up.

export const REGISTRY_VERSION = '2026-10-14';
export const PRICE_MULTIPLIER = 1.5;

export const STATUSES = Object.freeze(['standard', 'custom', 'unavailable']);
export const LICENCES = Object.freeze(['commercial_ok', 'non_commercial', 'unclear']);
export const COST_BASES = Object.freeze(['official', 'pg1_estimate', 'unknown']);

// Every source cited below: official provider pages and model cards only.
export const SOURCES = Object.freeze({
  gemini_pricing: 'https://ai.google.dev/gemini-api/docs/pricing',
  gemini_terms: 'https://ai.google.dev/gemini-api/terms',
  google_apis_terms: 'https://developers.google.com/terms',
  gemini_omni_docs: 'https://ai.google.dev/gemini-api/docs/omni',
  gemini_omni_model: 'https://ai.google.dev/gemini-api/docs/models/gemini-omni-flash',
  gemini_omni_11_blog: 'https://blog.google/innovation-and-ai/technology/developers-tools/build-with-gemini-omni-1-1-flash/',
  veo_docs: 'https://ai.google.dev/gemini-api/docs/veo',
  veo_lite_model: 'https://ai.google.dev/gemini-api/docs/models/veo-3.1-lite-generate-preview',
  vertex_references: 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-references',
  vertex_extend: 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/extend-videos',
  lyria_music_docs: 'https://ai.google.dev/gemini-api/docs/music-generation',
  lyria_clip_model: 'https://ai.google.dev/gemini-api/docs/models/lyria-3-clip-preview',
  imagen_model: 'https://ai.google.dev/gemini-api/docs/models/imagen',
  gemini_tts_model: 'https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-preview-tts',
  chirp3_custom_voice: 'https://docs.cloud.google.com/text-to-speech/docs/chirp3-instant-custom-voice',
  cloud_tts_pricing: 'https://cloud.google.com/text-to-speech/pricing',
  replicate_terms: 'https://replicate.com/terms',
  replicate_official: 'https://replicate.com/docs/topics/models/official-models',
  replicate_kling_21: 'https://replicate.com/kwaivgi/kling-v2.1',
  replicate_kling_25: 'https://replicate.com/kwaivgi/kling-v2.5-turbo-pro',
  replicate_video_compare: 'https://replicate.com/blog/compare-ai-video-models',
  replicate_veo_lite: 'https://replicate.com/google/veo-3.1-lite',
  replicate_wan_25: 'https://replicate.com/wan-video/wan-2.5-i2v',
  replicate_kontext_pro: 'https://replicate.com/black-forest-labs/flux-kontext-pro',
  replicate_kontext_blog: 'https://replicate.com/blog/flux-kontext',
  bfl_pricing: 'https://bfl.ai/pricing',
  replicate_topaz_video: 'https://replicate.com/topazlabs/video-upscale/api/learn-more',
  replicate_enhance_videos: 'https://replicate.com/collections/ai-enhance-videos',
  replicate_esrgan_video: 'https://replicate.com/lucataco/real-esrgan-video',
  replicate_film_interp: 'https://replicate.com/google-research/frame-interpolation',
  replicate_rife: 'https://replicate.com/pollinations/rife-video-interpolation',
  practical_rife: 'https://github.com/hzwer/Practical-RIFE',
  replicate_lyria_2: 'https://replicate.com/google/lyria-2',
  replicate_demucs: 'https://replicate.com/cjwbw/demucs',
  demucs_repo: 'https://github.com/facebookresearch/demucs',
  replicate_chatterbox: 'https://replicate.com/resemble-ai/chatterbox-multilingual',
  eleven_api_pricing: 'https://elevenlabs.io/pricing/api',
  eleven_pricing: 'https://elevenlabs.io/pricing',
  eleven_publish_help: 'https://help.elevenlabs.io/hc/en-us/articles/13313564601361-Can-I-publish-the-content-I-generate-on-the-platform',
  eleven_music_terms: 'https://elevenlabs.io/music-terms',
  eleven_music_api: 'https://elevenlabs.io/eleven-music-api',
  eleven_models: 'https://elevenlabs.io/docs/overview/models',
  eleven_v3_blog: 'https://elevenlabs.io/blog/eleven-v3',
  eleven_v3_cost: 'https://help.elevenlabs.io/hc/en-us/articles/35869113958801-How-much-does-it-cost-to-generate-using-Eleven-v3',
  eleven_sfx_docs: 'https://elevenlabs.io/docs/overview/capabilities/sound-effects',
  eleven_sfx_api: 'https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert',
  eleven_stems_api: 'https://elevenlabs.io/docs/api-reference/music/separate-stems',
  eleven_stems_blog: 'https://elevenlabs.io/blog/eleven-music-new-tools-for-exploring-editing-and-producing-music-with-ai',
  eleven_voice_cloning: 'https://elevenlabs.io/docs/eleven-api/concepts/voice-cloning',
  eleven_pvc_quickstart: 'https://elevenlabs.io/docs/cookbooks/voices/professional-voice-cloning',
  eleven_pvc_others: 'https://help.elevenlabs.io/hc/en-us/articles/36842751624209-Can-I-create-a-Professional-Voice-Clone-of-someone-else-s-voice',
  ffmpeg_filters: 'https://ffmpeg.org/ffmpeg-filters.html',
  github_runner_pricing: 'https://docs.github.com/en/billing/reference/actions-runner-pricing'
});

const src = (...keys) => Object.freeze(keys.map((k) => {
  if (!SOURCES[k]) throw new Error(`unknown source ${k}`);
  return SOURCES[k];
}));

// The open licence questions for the operator. A feature whose verdict is
// unclear names the ones that block it.
export const LICENCE_QUESTIONS = Object.freeze({
  G1: Object.freeze({
    question: 'Google outputs (Gemini Omni, Veo, Lyria, Gemini image and TTS on the paid Gemini API): may PG1 resell them to clients?',
    detail: 'The Gemini API Additional Terms say Google does not claim ownership of generated content and that paid-tier data is not used to improve products, but they grant no express commercial licence. The Google APIs Terms (Section 5, prohibitions on content) bar selling or distributing content returned by an API unless its owner or the law allows it; whether that clause reaches generated output is not answered on Google\'s pages.',
    answered: 'Answered 2026-10-14 by the operator: the Gemini API Additional Terms (effective 25 Sep 2025) say "Google won\'t claim ownership over that content", make the user responsible for its use and do not ban selling generated output. Gemini, Veo, Imagen and Gemini TTS output through the Gemini API is commercial_ok: operator accepted Google\'s generated-content terms; operator responsible for use.',
    sources: src('gemini_terms', 'google_apis_terms')
  }),
  G2: Object.freeze({
    question: 'Lyria music on the paid Gemini API: may it be published and sold, including on streaming platforms and YouTube?',
    detail: 'Same terms as G1. Lyria output carries a SynthID watermark. Google\'s pages give no music-specific rights table, unlike ElevenLabs\'.',
    answered: 'Answered 2026-10-14 by the operator: the same as G1, so Lyria through the Gemini API is commercial_ok (operator accepted Google\'s generated-content terms; operator responsible for use) and film music on it may be offered. Lyria 2 through Replicate stays unclear under R1.',
    sources: src('gemini_terms', 'lyria_music_docs')
  }),
  R1: Object.freeze({
    question: 'Replicate-hosted video and upscaling models (Kling, Topaz, FILM): what does each model\'s own licence allow?',
    detail: 'Replicate grants its rights in outputs, including commercial use, "subject to any third-party terms" of the model used. The model pages\' licence tabs could not be loaded, so each model\'s terms are unconfirmed.',
    sources: src('replicate_terms', 'replicate_kling_21', 'replicate_topaz_video', 'replicate_film_interp')
  }),
  E1: Object.freeze({
    question: 'Which ElevenLabs plan is ELEVENLABS_API_KEY on?',
    detail: 'Paid plans include a commercial licence; the free plan does not and requires attribution. Eleven Music on self-serve plans excludes film, TV, radio and large studio games (Enterprise only). Streaming distribution needs Creator or above.',
    answered: 'Answered 2026-10-14 by the operator: the Creator plan (paid self-serve), with ELEVENLABS_API_KEY set in Vercel (the key is named PG1-Studi0 in ElevenLabs). Creator includes Professional Voice Cloning of the account holder\'s own voice. ElevenLabs TTS, dialogue, sound effects and voice output are commercial_ok on it. The plan\'s Eleven Music licence excludes film, TV, radio and large studio games, so film beds stay on Lyria through the Gemini API (lib/film/providers.mjs filmMusicExclude) unless PG1_ELEVENLABS_FILM_RIGHTS=1 records that the plan covers film.',
    sources: src('eleven_publish_help', 'eleven_music_terms', 'eleven_music_api')
  }),
  E2: Object.freeze({
    question: 'Is Eleven v3 Text to Dialogue still a Beta Service?',
    detail: 'Content made with ElevenLabs Beta Services cannot be used commercially or in production.',
    answered: 'Answered 2026-10-14 by the operator: ElevenLabs\' own Eleven v3 page says v3 is no longer in alpha and is generally available, including the Text to Dialogue API endpoint. No beta restriction applies.',
    sources: src('eleven_v3_blog', 'eleven_publish_help')
  }),
  C1: Object.freeze({
    question: 'Cartesia (the voice PG1 Studio uses now for voice-over): do its terms allow resale of output?',
    detail: 'Cartesia was outside this phase\'s providers (Replicate, Google, ElevenLabs), so its terms were not reviewed.',
    sources: Object.freeze([])
  })
});

export const GOOGLE_NOTE = 'operator accepted Google\'s generated-content terms; operator responsible for use';

const cost = (usd, unit, basis, sources = [], extra = {}) => Object.freeze({ usd, unit, basis, sources: Object.freeze(sources), verified: false, ...extra });

const model = (o) => Object.freeze({ deliverable: true, ...o });

// --- the registry -----------------------------------------------------------

const ENTRIES = [
  {
    id: 'text_image_to_video',
    feature: 'Text- and image-to-video clips',
    area: 'studio',
    status: 'standard',
    wired: 'lib/videoJobs.mjs (PG1 Motion), lib/film/providers.mjs (film shots, ROUTING_CHAINS.clips): Gemini Omni first, Kling on Replicate as the start-frame fallback (never for client films: R1)',
    models: [
      model({ provider: 'google', model: 'gemini-omni-1.1-flash', role: 'primary', licence: 'commercial_ok', licenceNote: GOOGLE_NOTE, licenceSources: src('gemini_terms') }),
      model({ provider: 'replicate', model: 'kwaivgi/kling-v2.1', role: 'fallback (needs a start image)', licence: 'unclear', review: ['R1'] })
    ],
    licence: 'unclear',
    unitCost: cost(0.10, 'second of 720p video', 'official', src('gemini_pricing'), { note: 'Gemini Omni 1.1 Flash at 720p; Kling standard is a PG1 estimate of 0.30 USD per 5 s clip (0.06 USD per second).' }),
    byResolution: Object.freeze({
      '360p': cost(0.03, 'second', 'official', src('gemini_omni_11_blog'), { note: 'Google: a third of the 720p price (derived)' }),
      '720p': cost(0.10, 'second', 'official', src('gemini_pricing')),
      '1080p': cost(0.15, 'second', 'pg1_estimate', src('gemini_pricing'), { note: 'The pricing extract showed 0.12 USD per second at 1080p in a block not clearly tied to Omni; PG1 keeps its own 0.15 (lib/videoText.mjs).' }),
      '4k': cost(0.30, 'second', 'official', src('gemini_pricing'), { note: 'Same ambiguous block as 1080p; confirm on the live page.' })
    }),
    candidates: [
      { provider: 'google', model: 'gemini-omni-1.1-flash', does: 'text, image and short video references to video with audio; scene extension', max: '3-10 s per generation, extend to about 40 s; 360p, 720p, 1080p, 4K at 24 fps', price: 'about 0.10 USD per second at 720p (official); 360p about a third of that', licence: 'commercial_ok: operator accepted Google\'s generated-content terms; operator responsible for use (G1)', sources: src('gemini_pricing', 'gemini_omni_docs', 'gemini_omni_11_blog') },
      { provider: 'google', model: 'veo-3.1 / veo-3.1-fast / veo-3.1-lite', does: 'text and image to video with audio, up to 3 reference images, extension of Veo clips', max: '8 s clips at 720p, 1080p or 4K (Lite: no 4K, no extension); extension to 37 s on Google Cloud', price: 'Veo 3.1 0.40 USD/s (720p, 1080p), 0.60 USD/s 4K; Fast 0.10/0.12/0.30; Lite 0.05/0.08', licence: 'commercial_ok: operator accepted Google\'s generated-content terms; operator responsible for use (G1); PG1 does not use Veo: the preview models shut down on 2026-10-22 (lib/videoJobs.mjs)', sources: src('gemini_pricing', 'veo_docs', 'veo_lite_model', 'vertex_extend') },
      { provider: 'replicate', model: 'kwaivgi/kling-v2.1', does: 'image-to-video (start image required)', max: '5 or 10 s; 720p standard, 1080p pro, 24 fps', price: 'per run; Replicate\'s June 2025 comparison listed about 0.25-0.90 USD per video; current rate not retrieved', licence: 'unclear (R1)', sources: src('replicate_kling_21', 'replicate_video_compare', 'replicate_terms') },
      { provider: 'replicate', model: 'kwaivgi/kling-v2.5-turbo-pro', does: 'text and image to video', max: 'not retrieved', price: 'not retrieved', licence: 'unclear (R1)', sources: src('replicate_kling_25') },
      { provider: 'replicate', model: 'google/veo-3.1-lite', does: 'text and image to video with audio', max: '720p, 1080p', price: '0.05 USD/s 720p, 0.08 USD/s 1080p', licence: 'unclear (R1: Replicate-hosted)', sources: src('replicate_veo_lite') },
      { provider: 'replicate', model: 'wan-video/wan-2.5-i2v', does: 'image to video', max: '480p, 720p, 1080p', price: 'not retrieved', licence: 'unclear (R1)', sources: src('replicate_wan_25') }
    ]
  },
  {
    id: 'scene_character_consistency',
    feature: 'Scene and character consistency',
    area: 'studio',
    status: 'standard',
    wired: 'lib/film: one shared reference still per film; each shot\'s keyframe is made from it (FLUX Kontext Pro), then animated from that keyframe',
    models: [
      model({ provider: 'replicate', model: 'black-forest-labs/flux-kontext-pro', role: 'primary (reference and keyframes)', licence: 'commercial_ok' }),
      model({ provider: 'google', model: 'gemini-3.1-flash-image', role: 'fallback stills', licence: 'commercial_ok', licenceNote: GOOGLE_NOTE, licenceSources: src('gemini_terms') })
    ],
    licence: 'commercial_ok',
    unitCost: cost(0.067, 'still', 'official', src('gemini_pricing', 'bfl_pricing'), { note: 'Kontext Pro 0.04 USD per image; the Gemini fallback about 0.067 USD per 1K image. The clip made from each still is priced under text_image_to_video.' }),
    candidates: [
      { provider: 'replicate', model: 'black-forest-labs/flux-kontext-pro', does: 'image editing and generation from a reference image', max: 'one image per run', price: '0.04 USD per image', licence: 'commercial_ok: outputs generated on Replicate may be used commercially', sources: src('replicate_kontext_pro', 'replicate_kontext_blog', 'bfl_pricing') },
      { provider: 'google', model: 'gemini-omni-1.1-flash (references)', does: 'images and up to 3 video references (3 s each) guide the clip', max: 'as text_image_to_video', price: 'as text_image_to_video', licence: 'commercial_ok: operator accepted Google\'s generated-content terms; operator responsible for use (G1)', sources: src('gemini_omni_docs', 'vertex_references') },
      { provider: 'google', model: 'veo-3.1 (reference images)', does: 'up to 3 reference images per clip', max: '8 s', price: 'as Veo above', licence: 'commercial_ok: operator accepted Google\'s generated-content terms; operator responsible for use (G1)', sources: src('veo_docs') }
    ]
  },
  {
    id: 'storyboard_keyframes',
    feature: 'Storyboard and keyframe images',
    area: 'studio',
    status: 'standard',
    wired: 'lib/film/storyboard.mjs (the storyboard), lib/film/providers.mjs (stills); /film storyboard <id> makes the PDF',
    models: [
      model({ provider: 'replicate', model: 'black-forest-labs/flux-kontext-pro', role: 'primary stills', licence: 'commercial_ok' }),
      model({ provider: 'google', model: 'gemini-3.1-flash-image', role: 'fallback stills', licence: 'commercial_ok', licenceNote: GOOGLE_NOTE, licenceSources: src('gemini_terms') })
    ],
    licence: 'commercial_ok',
    unitCost: cost(0.067, 'still', 'official', src('gemini_pricing', 'bfl_pricing'), { note: 'Dearest path (the Gemini fallback). Writing the storyboard itself is a PG1 estimate of 0.15 USD (lib/film/cost.mjs).' }),
    candidates: [
      { provider: 'replicate', model: 'black-forest-labs/flux-kontext-pro', does: 'keyframes that keep the reference', max: 'one image per run', price: '0.04 USD per image', licence: 'commercial_ok', sources: src('replicate_kontext_pro', 'bfl_pricing') },
      { provider: 'google', model: 'gemini-3.1-flash-image', does: 'image generation and editing', max: 'up to 4K images', price: 'about 0.045 (0.5K), 0.067 (1K), 0.101 (2K), 0.151 (4K) USD per image', licence: 'commercial_ok: operator accepted Google\'s generated-content terms; operator responsible for use (G1)', sources: src('gemini_pricing') },
      { provider: 'google', model: 'imagen-4', does: 'text to image', max: '-', price: '-', licence: 'commercial_ok: operator accepted Google\'s generated-content terms; operator responsible for use (G1)', note: 'Shut down on 2026-08-17 per Google\'s model page', sources: src('imagen_model') }
    ]
  },
  {
    id: 'upscale_4k',
    feature: 'Video upscaling to 4K',
    area: 'studio',
    status: 'custom',
    wired: null,
    models: [
      model({ provider: 'replicate', model: 'topazlabs/video-upscale', role: 'chosen', licence: 'unclear', review: ['R1'] })
    ],
    licence: 'unclear',
    unitCost: cost(null, 'second of output video', 'unknown', src('replicate_topaz_video', 'replicate_official'), { note: 'Replicate bills it per second of output; the rate could not be retrieved. Generating natively at 4K with Gemini Omni (about 0.30 USD per second, unconfirmed) is the alternative.' }),
    candidates: [
      { provider: 'replicate', model: 'topazlabs/video-upscale', does: 'upscales existing video, frame rates up to 120 fps', max: 'up to 4K', price: 'per second of output; rate not retrieved', licence: 'unclear (R1)', sources: src('replicate_topaz_video', 'replicate_enhance_videos') },
      { provider: 'replicate', model: 'lucataco/real-esrgan-video', does: 'Real-ESRGAN upscaling of MP4', max: 'not stated', price: 'about 0.18 USD per run (A100)', licence: 'unclear (R1)', sources: src('replicate_esrgan_video') },
      { provider: 'google', model: 'gemini-omni-1.1-flash (4K output)', does: 'generates at 4K rather than upscaling', max: '3-10 s per generation', price: 'about 0.30 USD per second (unconfirmed)', licence: 'commercial_ok: operator accepted Google\'s generated-content terms; operator responsible for use (G1)', sources: src('gemini_pricing', 'gemini_omni_docs') }
    ]
  },
  {
    id: 'upscale_8k',
    feature: 'Video upscaling to 8K',
    area: 'studio',
    status: 'unavailable',
    wired: null,
    models: [],
    licence: 'unclear',
    unitCost: cost(null, 'second of output video', 'unknown', []),
    note: 'No Replicate, Google or ElevenLabs model found outputs 8K video; Replicate\'s Topaz model and Google\'s models top out at 4K.',
    candidates: [
      { provider: 'replicate', model: 'topazlabs/video-upscale', does: 'upscaling', max: 'up to 4K', price: '-', licence: '-', sources: src('replicate_enhance_videos') }
    ]
  },
  {
    id: 'frame_interpolation',
    feature: 'Frame interpolation (smoother motion, higher frame rate)',
    area: 'studio',
    status: 'custom',
    wired: null,
    models: [
      model({ provider: 'pg1', model: 'ffmpeg minterpolate (motion-compensated)', role: 'chosen, on PG1\'s render runner', licence: 'commercial_ok' })
    ],
    licence: 'commercial_ok',
    licenceConditions: ['FFmpeg\'s licence (LGPL/GPL) covers the software, not the frames it outputs.'],
    unitCost: cost(0.06, 'minute of output video', 'pg1_estimate', src('github_runner_pricing'), { note: 'PG1 estimate: about 10 runner-minutes per output minute at 1080p, at 0.006 USD per Linux 2-core minute.' }),
    candidates: [
      { provider: 'pg1', model: 'ffmpeg minterpolate', does: 'motion-compensated frame interpolation', max: 'any resolution; runner time grows with it', price: 'runner time only', licence: 'commercial_ok', sources: src('ffmpeg_filters', 'github_runner_pricing') },
      { provider: 'replicate', model: 'google-research/frame-interpolation (FILM)', does: 'interpolates between frames', max: 'per frame pair', price: 'about 0.0026 USD per run (T4)', licence: 'unclear (R1)', sources: src('replicate_film_interp') },
      { provider: 'replicate', model: 'pollinations/rife-video-interpolation', does: 'RIFE video interpolation', max: 'not stated', price: 'about 0.037 USD per run', licence: 'unclear (R1); Practical-RIFE models are MIT per its repo', sources: src('replicate_rife', 'practical_rife') }
    ]
  },
  {
    id: 'voiceover_single',
    feature: 'Voice-over (one voice)',
    area: 'studio',
    status: 'standard',
    wired: 'lib/film/providers.mjs (createFilmVoice, ROUTING_CHAINS.voice): the ElevenLabs brand voice (PG1_FILM_VOICE_ID), then Cartesia sonic (sent once more on a timeout); one voice per film, never Cartesia for client films (C1)',
    models: [
      model({ provider: 'elevenlabs', model: 'eleven_multilingual_v2', role: 'primary (brand voice)', licence: 'commercial_ok', licenceNote: 'the paid ElevenLabs plan (E1, Creator)', licenceSources: src('eleven_publish_help') }),
      model({ provider: 'cartesia', model: 'sonic-3.6', role: 'fallback', licence: 'unclear', review: ['C1'] })
    ],
    licence: 'unclear',
    unitCost: cost(0.05, '1,000 characters', 'pg1_estimate', [], { note: 'PG1\'s film estimate (lib/film/cost.mjs voicePerCharUsd).' }),
    candidates: [
      { provider: 'cartesia', model: 'sonic-3.6', does: 'single-voice TTS (wired now)', max: '-', price: 'PG1 estimate 0.05 USD per 1,000 characters', licence: 'unclear (C1)', sources: [] },
      { provider: 'elevenlabs', model: 'Eleven multilingual / v3 TTS', does: 'single-voice TTS; a commercial_ok replacement for Cartesia if C1 stays open', max: '5,000 characters per request (v3)', price: '0.08-0.10 USD per 1,000 characters (pages disagree)', licence: 'commercial_ok on the paid plan (E1, Creator plan)', sources: src('eleven_api_pricing', 'eleven_publish_help') }
    ]
  },
  {
    id: 'dialogue_tts',
    feature: 'Dialogue text-to-speech (several voices)',
    area: 'studio',
    status: 'custom',
    wired: null,
    models: [
      model({ provider: 'elevenlabs', model: 'eleven_v3 (Text to Dialogue)', role: 'chosen', licence: 'commercial_ok' })
    ],
    licence: 'commercial_ok',
    licenceConditions: ['The Creator plan (E1, Creator plan). Eleven v3 and its Text to Dialogue endpoint are generally available, not a Beta Service (E2, answered).'],
    unitCost: cost(0.10, '1,000 characters', 'official', src('eleven_api_pricing'), { note: 'ElevenLabs pages disagree: 0.08 and 0.10 USD per 1,000 characters for v3; the dearer is used.' }),
    candidates: [
      { provider: 'elevenlabs', model: 'eleven_v3 Text to Dialogue', does: 'multi-speaker dialogue in one request', max: '5,000 characters per request (about 5 minutes)', price: '0.08-0.10 USD per 1,000 characters (pages disagree)', licence: 'commercial_ok on the Creator plan (E1); generally available, not beta (E2)', sources: src('eleven_api_pricing', 'eleven_models', 'eleven_v3_blog', 'eleven_v3_cost', 'eleven_publish_help') },
      { provider: 'google', model: 'gemini-2.5-flash-preview-tts', does: 'speech with one or two speakers', max: '8,192 input tokens', price: '10 USD per 1M audio output tokens (about 0.02 USD per minute at 32 tokens per second)', licence: 'commercial_ok: operator accepted Google\'s generated-content terms; operator responsible for use (G1)', sources: src('gemini_pricing', 'gemini_tts_model') },
      { provider: 'replicate', model: 'resemble-ai/chatterbox-multilingual', does: 'TTS with voice prompts', max: 'not retrieved', price: 'not retrieved', licence: 'unclear (R1)', sources: src('replicate_chatterbox') }
    ]
  },
  {
    id: 'sound_effects',
    feature: 'Sound effects and Foley',
    area: 'sound',
    status: 'custom',
    wired: null,
    models: [
      model({ provider: 'elevenlabs', model: 'eleven_text_to_sound_v2', role: 'chosen', licence: 'commercial_ok' })
    ],
    licence: 'commercial_ok',
    licenceConditions: ['The paid ElevenLabs plan (E1, Creator plan); not a Beta Service.'],
    unitCost: cost(0.12, 'minute of audio', 'official', src('eleven_api_pricing'), { note: 'The credits page lists 200 credits per generation instead; confirm the billing basis.' }),
    candidates: [
      { provider: 'elevenlabs', model: 'eleven_text_to_sound_v2', does: 'sound effects from text, optional seamless loop', max: '0.5-30 s per generation', price: '0.12 USD per minute (API page); 40 credits per second when a duration is set', licence: 'commercial_ok on paid plans', sources: src('eleven_api_pricing', 'eleven_sfx_docs', 'eleven_sfx_api', 'eleven_publish_help') }
    ]
  },
  {
    id: 'music',
    feature: 'Music (PG1 Sound tracks)',
    area: 'sound',
    status: 'standard',
    wired: 'lib/music/engines.mjs (ROUTING_CHAINS.music): Lyria 3.5 (paid Gemini key), the Lyria 3 clip model, then ElevenLabs Music; Replicate\'s Lyria 2 is no longer used (R1)',
    models: [
      model({ provider: 'google', model: 'lyria-3.5', role: 'primary', licence: 'commercial_ok', licenceNote: GOOGLE_NOTE, licenceSources: src('gemini_terms') }),
      model({ provider: 'google', model: 'lyria-3-clip-preview', role: 'fallback (30 s)', licence: 'commercial_ok', licenceNote: GOOGLE_NOTE, licenceSources: src('gemini_terms') }),
      model({ provider: 'elevenlabs', model: 'Eleven Music', role: 'last fallback (not for film)', licence: 'commercial_ok', excludes: ['film', 'TV', 'radio', 'large studio games'] })
    ],
    licence: 'commercial_ok',
    licenceConditions: ['ElevenLabs Music is commercial_ok on the paid plan (E1, Creator plan) except film, TV, radio and large studio games, which the plan excludes (Enterprise only). Music for a film is the film_music feature.', 'Lyria through the Gemini API is commercial_ok (G2, answered). Lyria 2 on Replicate (R1) is no longer in the chain.'],
    unitCost: cost(0.15, 'minute of music', 'official', src('eleven_api_pricing'), { note: 'Eleven Music. Lyria 3.5 is 0.08 USD per song and the Lyria 3 clip 0.04 USD per 30 s request.' }),
    candidates: [
      { provider: 'elevenlabs', model: 'Eleven Music', does: 'songs and instrumentals from a prompt', max: 'up to 5 minutes', price: '0.15 USD per minute', licence: 'commercial_ok on the paid plan (E1, Creator plan); excludes film, TV, radio and large studio games (Enterprise only); streaming from Creator up', sources: src('eleven_api_pricing', 'eleven_music_api', 'eleven_music_terms') },
      { provider: 'google', model: 'lyria-3.5', does: 'full songs', max: 'full song', price: '0.08 USD per song', licence: 'commercial_ok: operator accepted Google\'s generated-content terms; operator responsible for use (G2)', sources: src('gemini_pricing', 'lyria_music_docs') },
      { provider: 'google', model: 'lyria-3-clip-preview', does: '30 s clips, 48 kHz stereo', max: '30 s', price: '0.04 USD per request', licence: 'commercial_ok: operator accepted Google\'s generated-content terms; operator responsible for use (G2)', sources: src('gemini_pricing', 'lyria_clip_model') },
      { provider: 'replicate', model: 'google/lyria-2', does: 'instrumental clips with SynthID', max: '30 s, 48 kHz stereo', price: 'per output; rate not retrieved', licence: 'unclear (R1: Replicate-hosted)', sources: src('replicate_lyria_2') }
    ]
  },
  {
    id: 'film_music',
    feature: 'Music for films (score beds)',
    area: 'studio',
    status: 'standard',
    wired: 'lib/film/providers.mjs (filmMusicExclude) and lib/music/engines.mjs (filmMusicPlan): Lyria 3.5 on the paid Gemini key, then the Lyria clip model; ElevenLabs only with PG1_ELEVENLABS_FILM_RIGHTS=1, never Replicate. A bed none can make is left out and the film finishes without it (music unavailable)',
    models: [
      model({ provider: 'google', model: 'lyria-3.5', role: 'primary (Gemini API)', licence: 'commercial_ok', licenceNote: GOOGLE_NOTE, licenceSources: src('gemini_terms') }),
      model({ provider: 'google', model: 'lyria-3-clip-preview', role: 'fallback (Gemini API, 30 s)', licence: 'commercial_ok', licenceNote: GOOGLE_NOTE, licenceSources: src('gemini_terms') })
    ],
    licence: 'commercial_ok',
    licenceConditions: ['Lyria through the Gemini API: operator accepted Google\'s generated-content terms; operator responsible for use (G2, answered).', 'ElevenLabs Music is not used: the Creator plan excludes film, TV and radio. Set PG1_ELEVENLABS_FILM_RIGHTS=1 only if the plan covers film (Enterprise).', 'Replicate\'s Lyria 2 is never used for film beds (R1).'],
    unitCost: cost(0.08, 'music bed', 'official', src('gemini_pricing'), { note: 'Lyria 3.5 at 0.08 USD per song; the clip model is 0.04 USD per 30 s. PG1 Studio\'s own film estimate is lower (lib/film/cost.mjs, 0.06 USD per bed).' }),
    candidates: [
      { provider: 'google', model: 'lyria-3.5 (Gemini API)', does: 'full songs and instrumentals', max: 'full song', price: '0.08 USD per song', licence: 'commercial_ok: operator accepted Google\'s generated-content terms; operator responsible for use (G2)', sources: src('gemini_pricing', 'lyria_music_docs') },
      { provider: 'google', model: 'lyria-3-clip-preview (Gemini API)', does: '30 s clips, 48 kHz stereo', max: '30 s', price: '0.04 USD per request', licence: 'commercial_ok: operator accepted Google\'s generated-content terms; operator responsible for use (G2)', sources: src('gemini_pricing', 'lyria_clip_model') },
      { provider: 'elevenlabs', model: 'Eleven Music', does: 'songs and instrumentals', max: 'up to 5 minutes', price: '0.15 USD per minute', licence: 'not for film on the Creator plan (Enterprise only)', sources: src('eleven_music_terms', 'eleven_music_api') }
    ]
  },
  {
    id: 'stem_separation',
    feature: 'Stem separation',
    area: 'sound',
    status: 'standard',
    wired: 'lib/music/export.mjs + scripts/music_stems.py on the music-render runner: Demucs htdemucs (drums, bass, vocals, other) and basic-pitch MIDI',
    models: [
      model({ provider: 'pg1', model: 'demucs htdemucs (MIT)', role: 'primary, on PG1\'s runner', licence: 'commercial_ok' })
    ],
    licence: 'commercial_ok',
    licenceConditions: ['Demucs is MIT. The stems carry the licence of the track they come from.'],
    unitCost: cost(0.03, 'track (about 3 minutes)', 'pg1_estimate', src('github_runner_pricing'), { note: 'PG1 estimate: about 5 runner-minutes per track at 0.006 USD per minute.' }),
    candidates: [
      { provider: 'pg1', model: 'Demucs htdemucs', does: '4 stems (6 with htdemucs_6s)', max: 'any length; runner time grows with it', price: 'runner time only', licence: 'commercial_ok (MIT)', sources: src('demucs_repo', 'github_runner_pricing') },
      { provider: 'elevenlabs', model: 'music/stem-separation', does: '2 or 6 stems as a ZIP', max: 'not stated', price: '0.5x (2 stems) to 1x (4 stems) the generation cost, per an ElevenLabs blog post', licence: 'commercial_ok on the paid plan (E1, Creator plan)', sources: src('eleven_stems_api', 'eleven_stems_blog') },
      { provider: 'replicate', model: 'cjwbw/demucs', does: 'Demucs on Replicate', max: '-', price: 'about 0.016 USD per run', licence: 'MIT upstream', sources: src('replicate_demucs', 'demucs_repo') }
    ]
  },
  {
    id: 'surround_upmix',
    feature: '5.1 and 7.1 surround mixes',
    area: 'sound',
    status: 'custom',
    wired: null,
    models: [
      model({ provider: 'pg1', model: 'ffmpeg surround / pan from stems', role: 'chosen, on PG1\'s runner', licence: 'commercial_ok' })
    ],
    licence: 'commercial_ok',
    licenceConditions: ['The mix carries the licence of the track and stems it is made from. No provider model was found that generates surround audio.'],
    unitCost: cost(0.01, 'track', 'pg1_estimate', src('github_runner_pricing'), { note: 'PG1 estimate: about 1-2 runner-minutes per track.' }),
    candidates: [
      { provider: 'pg1', model: 'ffmpeg surround filter', does: 'active upmix stereo to 5.1, and 5.1 to 7.1', max: '-', price: 'runner time only', licence: 'commercial_ok', sources: src('ffmpeg_filters') },
      { provider: 'pg1', model: 'ffmpeg pan from Demucs stems', does: 'places stems in a 5.1(side) or 7.1 layout (dialogue and vocals centre, drums and bass front with LFE, other in the surrounds)', max: '-', price: 'runner time only', licence: 'commercial_ok', sources: src('ffmpeg_filters', 'demucs_repo') }
    ]
  },
  {
    id: 'voice_cloning',
    feature: 'Consented voice cloning (own voice only)',
    area: 'sound',
    status: 'custom',
    gatedUntil: 'phase4',
    wired: null,
    models: [
      model({ provider: 'elevenlabs', model: 'Professional Voice Cloning', role: 'chosen (own voice, voice-captcha verified)', licence: 'commercial_ok' })
    ],
    licence: 'commercial_ok',
    licenceConditions: ['The Creator plan (E1), which includes Professional Voice Cloning.', 'Only the account holder\'s own voice: ElevenLabs does not allow a Professional clone of someone else\'s voice, even with consent.'],
    unitCost: cost(0.10, '1,000 characters spoken in the cloned voice', 'official', src('eleven_api_pricing'), { note: 'Making the clone itself is part of the plan subscription (not separately priced on the pages found).' }),
    consent: Object.freeze({
      elevenlabs: 'Professional clones: own voice only, verified by a voice captcha (the speaker reads a prompt that is compared with the training audio); a consent attestation for every clone; celebrity and high-risk voices blocked.',
      google: 'Chirp 3 Instant Custom Voice: a recorded consent statement in the fixed script for the language (up to 10 s) plus up to 10 s of reference audio; allowlist access only; 60 USD per 1M characters.',
      replicate: 'No platform verification; the terms forbid impersonating someone without consent, and model pages add their own consent rules.'
    }),
    candidates: [
      { provider: 'elevenlabs', model: 'Professional Voice Cloning', does: 'a high-fidelity clone from about 30 minutes of audio', max: '-', price: 'plan (Creator or above) plus TTS per character', licence: 'commercial_ok on paid plans', sources: src('eleven_voice_cloning', 'eleven_pvc_quickstart', 'eleven_pvc_others') },
      { provider: 'elevenlabs', model: 'Instant Voice Cloning', does: 'a quick clone from 1-2 minutes of audio', max: '-', price: 'plan plus TTS per character', licence: 'commercial_ok on paid plans', sources: src('eleven_voice_cloning') },
      { provider: 'google', model: 'Chirp 3 Instant Custom Voice', does: 'a custom voice from 10 s of reference audio', max: '-', price: '60 USD per 1M characters', licence: 'unclear: Google Cloud Text-to-Speech terms, not the Gemini API, were not reviewed', sources: src('chirp3_custom_voice', 'cloud_tts_pricing') },
      { provider: 'replicate', model: 'resemble-ai/chatterbox-multilingual', does: 'zero-shot voice prompts', max: '-', price: 'not retrieved', licence: 'unclear (R1)', sources: src('replicate_chatterbox', 'replicate_terms') }
    ]
  }
];

// Things PG1 never offers in this phase. `never`: not in any later phase
// either.
export const NOT_OFFERED = Object.freeze([
  Object.freeze({ id: 'client_accounts', label: 'client accounts or seats', never: false }),
  Object.freeze({ id: 'account_manager', label: 'an account manager', never: false }),
  Object.freeze({ id: 'dedicated_compute', label: 'dedicated compute or GPUs', never: false }),
  Object.freeze({ id: 'ip_indemnification', label: 'IP indemnification', never: true }),
  Object.freeze({ id: 'exclusive_rights', label: 'exclusive rights', never: true })
]);

// --- derived values ------------------------------------------------------------

const RANK = { commercial_ok: 0, unclear: 1, non_commercial: 2 };

// The worst licence among the models that can make a deliverable.
export function featureLicence(entry) {
  const ms = (entry.models || []).filter((m) => m.deliverable);
  if (!ms.length) return 'unclear';
  return ms.reduce((worst, m) => (RANK[m.licence] > RANK[worst] ? m.licence : worst), 'commercial_ok');
}

// 1.5x the unit cost, rounded up: to the cent at 1 USD or more, else to
// four places so per-character and per-second prices keep their meaning.
export function minPrice(unitUsd, multiplier = PRICE_MULTIPLIER) {
  if (unitUsd == null || !Number.isFinite(unitUsd)) return null;
  const raw = unitUsd * multiplier;
  const step = raw >= 1 ? 100 : 10000;
  return Math.ceil(raw * step - 1e-9) / step;
}

export function reviewCodes(entry) {
  return [...new Set((entry.models || []).filter((m) => m.deliverable).flatMap((m) => m.review || []))].sort();
}

function freezeEntry(e) {
  const unitCost = e.unitCost;
  return Object.freeze({
    ...e,
    models: Object.freeze(e.models),
    candidates: Object.freeze((e.candidates || []).map((c) => Object.freeze({ ...c }))),
    licenceConditions: Object.freeze(e.licenceConditions || []),
    review: Object.freeze(reviewCodes(e)),
    minPrice: Object.freeze({ usd: minPrice(unitCost.usd), unit: unitCost.unit, basis: unitCost.basis })
  });
}

export const REGISTRY = Object.freeze(ENTRIES.map(freezeEntry));

export function capability(id) {
  return REGISTRY.find((e) => e.id === id) || null;
}

// --- routing chains ------------------------------------------------------------
//
// The order every model call falls back in, one chain per kind of call
// (lib/router/chains.mjs reads these; docs/director-mode.md A1). A step is
// { provider (the AI router's ledger name), feature + model (the registry
// model it stands for, whose licence decides client work) or licence (for
// engines with no registry feature: the text and image cores), role,
// operatorOnly (never for customer or client data) }. Only a capacity
// failure moves a call to the next step; a refusal stops it.

const TEXT_LICENCE = 'commercial_ok';
export const ROUTING_CHAINS = Object.freeze({
  // Storyboards, shot checks, edits, Director writing and critic, heavy chat.
  text: [
    { provider: 'anthropic', licence: TEXT_LICENCE, role: 'reasoning core' },
    { provider: 'gemini_paid', licence: TEXT_LICENCE, role: 'main core (paid)' },
    { provider: 'gemini_free', licence: 'unclear', role: 'main core (free tier)', operatorOnly: true },
    { provider: 'openrouter', licence: TEXT_LICENCE, role: 'backup core' },
    { provider: 'gateway', licence: TEXT_LICENCE, role: 'backup core' },
    { provider: 'openai', licence: TEXT_LICENCE, role: 'backup core' }
  ],
  // Light chat replies: cost first (docs/director-mode.md, Open questions).
  chat_light: [
    { provider: 'gemini_free', licence: 'unclear', role: 'main core (free tier)', operatorOnly: true },
    { provider: 'gemini_paid', licence: TEXT_LICENCE, role: 'main core (paid)' },
    { provider: 'anthropic', licence: TEXT_LICENCE, role: 'reasoning core' },
    { provider: 'gateway', licence: TEXT_LICENCE, role: 'backup core' },
    { provider: 'openrouter', licence: TEXT_LICENCE, role: 'backup core' },
    { provider: 'openai', licence: TEXT_LICENCE, role: 'backup core' }
  ],
  // Search-grounded research.
  research: [
    { provider: 'gemini_paid', licence: TEXT_LICENCE, role: 'Google Search grounding' },
    { provider: 'anthropic', licence: TEXT_LICENCE, role: 'web search tool' }
  ],
  // PG1's own spoken voice in chat (not film): unchanged.
  speech: [
    { provider: 'gemini_free', licence: 'unclear', role: 'opt-in free voice', operatorOnly: true },
    { provider: 'cartesia', feature: 'voiceover_single', model: 'sonic-3.6', role: 'PG1 voice' }
  ],
  stills: [
    { provider: 'replicate', feature: 'storyboard_keyframes', model: 'black-forest-labs/flux-kontext-pro', role: 'primary stills' },
    { provider: 'gemini_paid', feature: 'storyboard_keyframes', model: 'gemini-3.1-flash-image', role: 'fallback stills' }
  ],
  clips: [
    { provider: 'gemini_paid', feature: 'text_image_to_video', model: 'gemini-omni-1.1-flash', role: 'primary clips' },
    { provider: 'replicate', feature: 'text_image_to_video', model: 'kwaivgi/kling-v2.1', role: 'fallback clips (start image)' }
  ],
  // /image.
  image: [
    { provider: 'gemini_paid', licence: 'commercial_ok', role: 'PG1 Vision Primary' },
    { provider: 'gemini_paid', licence: 'commercial_ok', role: 'PG1 Vision Secondary', slot: 'secondary' },
    { provider: 'replicate', licence: 'commercial_ok', role: 'PG1 Vision Tertiary (Apache-2.0 model)' }
  ],
  voice: [
    { provider: 'elevenlabs', feature: 'voiceover_single', model: 'eleven_multilingual_v2', role: 'brand voice (PG1_FILM_VOICE_ID)' },
    { provider: 'cartesia', feature: 'voiceover_single', model: 'sonic-3.6', role: 'fallback voice' }
  ],
  dialogue: [
    { provider: 'elevenlabs', feature: 'dialogue_tts', model: 'eleven_v3 (Text to Dialogue)', role: 'several voices in one take' },
    { provider: 'elevenlabs', feature: 'voiceover_single', model: 'eleven_multilingual_v2', role: 'line by line, same voices', slot: 'lines' }
  ],
  sfx: [
    { provider: 'elevenlabs', feature: 'sound_effects', model: 'eleven_text_to_sound_v2', role: 'sound effects' }
  ],
  music_film: [
    { provider: 'gemini_paid', feature: 'film_music', model: 'lyria-3.5', role: 'score beds' },
    { provider: 'gemini_paid', feature: 'film_music', model: 'lyria-3-clip-preview', role: '30 s beds', slot: 'clip' },
    { provider: 'elevenlabs', feature: 'music', model: 'Eleven Music', role: 'only with PG1_ELEVENLABS_FILM_RIGHTS=1', filmRightsOnly: true }
  ],
  music: [
    { provider: 'gemini_paid', feature: 'music', model: 'lyria-3.5', role: 'tracks' },
    { provider: 'gemini_paid', feature: 'music', model: 'lyria-3-clip-preview', role: '30 s tracks', slot: 'clip' },
    { provider: 'elevenlabs', feature: 'music', model: 'Eleven Music', role: 'tracks (not for film)' }
  ]
});

// What one call costs on each engine, from the prices above: the ledger
// (lib/aiRouter.mjs recordUsage) and the film's own charges record these,
// never a worst case. usd is per `per`; flat units (a clip, a track) also
// give `flat`, the price of one call at PG1's default length.
//   unit             ledger unit (pg1_ai_usage.unit)
//   feature, model   the registry model the price comes from
export const ENGINE_UNIT_COSTS = Object.freeze({
  video_gemini: Object.freeze({ feature: 'text_image_to_video', provider: 'gemini_paid', model: 'gemini-omni-1.1-flash', usd: 0.10, per: 'second of 720p video', flat: 0.50 }),
  video_replicate: Object.freeze({ feature: 'text_image_to_video', provider: 'replicate', model: 'kwaivgi/kling-v2.1', usd: 0.06, per: 'second of standard video (PG1 estimate)', flat: 0.30 }),
  still_replicate: Object.freeze({ feature: 'storyboard_keyframes', provider: 'replicate', model: 'black-forest-labs/flux-kontext-pro', usd: 0.04, per: 'image', flat: 0.04 }),
  still_gemini: Object.freeze({ feature: 'storyboard_keyframes', provider: 'gemini_paid', model: 'gemini-3.1-flash-image', usd: 0.067, per: '1K image', flat: 0.067 }),
  tts_elevenlabs: Object.freeze({ feature: 'voiceover_single', provider: 'elevenlabs', model: 'eleven_multilingual_v2', usd: 0.10, per: '1,000 characters' }),
  tts_cartesia: Object.freeze({ feature: 'voiceover_single', provider: 'cartesia', model: 'sonic-3.6', usd: 0.05, per: '1,000 characters (PG1 estimate)' }),
  dialogue_elevenlabs: Object.freeze({ feature: 'dialogue_tts', provider: 'elevenlabs', model: 'eleven_v3 (Text to Dialogue)', usd: 0.10, per: '1,000 characters' }),
  sfx_elevenlabs: Object.freeze({ feature: 'sound_effects', provider: 'elevenlabs', model: 'eleven_text_to_sound_v2', usd: 0.12, per: 'minute of audio' }),
  music_lyria: Object.freeze({ feature: 'film_music', provider: 'gemini_paid', model: 'lyria-3.5', usd: 0.08, per: 'track', flat: 0.08 }),
  music_lyria_clip: Object.freeze({ feature: 'film_music', provider: 'gemini_paid', model: 'lyria-3-clip-preview', usd: 0.04, per: 'request', flat: 0.04 }),
  music_elevenlabs: Object.freeze({ feature: 'music', provider: 'elevenlabs', model: 'Eleven Music', usd: 0.15, per: 'minute of audio', flat: 0.375 }),
  music_elevenlabs_short: Object.freeze({ feature: 'music', provider: 'elevenlabs', model: 'Eleven Music', usd: 0.15, per: 'minute of audio', flat: 0.075 })
});

// The USD one call costs: per second, minute or 1,000 characters when the
// quantity is known, else the unit's flat price. null for a unit the
// registry does not price.
export function engineCostUsd(unit, { seconds = null, chars = null } = {}) {
  const c = ENGINE_UNIT_COSTS[unit];
  if (!c) return null;
  const round = (n) => Math.round(n * 1e6) / 1e6;
  if (/characters/.test(c.per)) return Number.isFinite(chars) ? round((chars / 1000) * c.usd) : null;
  if (/^minute/.test(c.per) && Number.isFinite(seconds) && seconds > 0) return round((seconds / 60) * c.usd);
  if (/^second/.test(c.per) && Number.isFinite(seconds) && seconds > 0) return round(seconds * c.usd);
  return c.flat == null ? null : c.flat;
}

// A chain step's licence: its registry model's, else its own.
export function stepLicence(step) {
  if (step.feature && step.model) {
    const e = capability(step.feature);
    const m = e && e.models.find((x) => x.model === step.model);
    if (m) return m.licence;
  }
  return step.licence || 'unclear';
}

// The plain-data export (lib/capabilities/registry.json is this, written
// by scripts/capabilities-export.mjs; a test keeps them equal).
export function registryJson() {
  return {
    version: REGISTRY_VERSION,
    priceMultiplier: PRICE_MULTIPLIER,
    researchNote: 'Figures from search-engine extracts of official provider pages on 2026-10-14; the pages could not be loaded directly. Every official figure is unverified until confirmed on the live page.',
    features: REGISTRY.map((e) => ({
      id: e.id,
      feature: e.feature,
      area: e.area,
      status: e.status,
      gatedUntil: e.gatedUntil || null,
      wired: e.wired || null,
      chosen: e.models.map((m) => ({ provider: m.provider, model: m.model, role: m.role, licence: m.licence, ...(m.licenceNote ? { licenceNote: m.licenceNote, licenceSources: [...m.licenceSources] } : {}), ...(m.excludes ? { excludes: [...m.excludes] } : {}) })),
      licence: e.licence,
      licenceConditions: [...e.licenceConditions],
      review: [...e.review],
      unitCost: { usd: e.unitCost.usd, unit: e.unitCost.unit, basis: e.unitCost.basis, verified: e.unitCost.verified, note: e.unitCost.note || null, sources: [...e.unitCost.sources] },
      minPrice: { ...e.minPrice },
      note: e.note || null,
      candidates: e.candidates.map((c) => ({ ...c, sources: [...(c.sources || [])] }))
    })),
    licenceQuestions: Object.fromEntries(Object.entries(LICENCE_QUESTIONS).map(([k, q]) => [k, { question: q.question, detail: q.detail, answered: q.answered || null, sources: [...q.sources] }])),
    notOffered: NOT_OFFERED.map((n) => ({ ...n }))
  };
}
