/**
 * PG1 Studio + Sound, Phase 1: the capability registry and the offer guard.
 *
 *   - every feature has a status, chosen models, a licence verdict, a unit
 *     cost with its basis and a minimum price of 1.5x cost
 *   - a feature's verdict is the worst of the models that can make a
 *     deliverable; "unclear" is never treated as commercial_ok
 *   - every source is an official provider page, never a redirect link
 *   - registry.json is the registry's export
 *   - offers: standard may be offered, custom only "on request", unclear,
 *     unavailable and non-commercial never; no client accounts or seats,
 *     account managers, dedicated compute, indemnification or exclusivity;
 *     voice cloning only after Phase 4 and only the client's own voice
 *   - package cost and storage estimates
 *
 * Run with: node --test tests/capabilities.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REGISTRY, STATUSES, LICENCES, COST_BASES, LICENCE_QUESTIONS, NOT_OFFERED, SOURCES, GOOGLE_NOTE, featureLicence, minPrice, capability, registryJson, PRICE_MULTIPLIER } from '../lib/capabilities/registry.mjs';
import { offerability, offersDirective, offerViolations, offerNote, licenceReviewNote, safetyAllows, SHIPPED_PHASES, RIGHTS_WORDING, RIGHTS_PHRASE, SAFETY_WORDING } from '../lib/capabilities/offers.mjs';
import { namesProvider } from '../lib/whiteLabel.mjs';
import { estimateFilmCost, estimateFilmStorage, PACKAGE_GRID, PIPELINE_MAX_SECONDS, STORAGE_OPTIONS, storageMonthlyUsd } from '../lib/capabilities/costs.mjs';
import { FILM_PRICES } from '../lib/film/cost.mjs';

const FEATURES = ['text_image_to_video', 'scene_character_consistency', 'video upscaling', 'frame_interpolation', 'storyboard_keyframes', 'dialogue_tts', 'sound_effects', 'music', 'stem_separation', 'surround_upmix', 'voice_cloning'];

// --- registry shape ------------------------------------------------------------

test('every feature the brief lists has an entry with status, models, licence, unit cost and min price', () => {
  const ids = REGISTRY.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const f of FEATURES) {
    if (f === 'video upscaling') { assert.ok(capability('upscale_4k') && capability('upscale_8k')); continue; }
    assert.ok(capability(f), f);
  }
  for (const e of REGISTRY) {
    assert.ok(STATUSES.includes(e.status), `${e.id} status`);
    assert.ok(LICENCES.includes(e.licence), `${e.id} licence`);
    assert.ok(COST_BASES.includes(e.unitCost.basis), `${e.id} cost basis`);
    assert.equal(e.unitCost.verified, false, `${e.id}: research figures stay unverified until the operator checks the live page`);
    assert.ok(['studio', 'sound'].includes(e.area));
    if (e.status !== 'unavailable') assert.ok(e.models.length >= 1, `${e.id} has a chosen model`);
    if (e.status === 'standard') assert.ok(e.wired, `${e.id}: a standard feature names where it is wired`);
    if (e.status !== 'standard') assert.equal(e.wired, null, `${e.id}: only standard features are wired`);
    // Min price: 1.5x cost, rounded up; null when the cost is unknown.
    if (e.unitCost.usd == null) {
      assert.equal(e.unitCost.basis, 'unknown');
      assert.equal(e.minPrice.usd, null);
    } else {
      assert.ok(e.minPrice.usd >= e.unitCost.usd * PRICE_MULTIPLIER - 1e-9, `${e.id} min price covers 1.5x`);
      assert.ok(e.minPrice.usd - e.unitCost.usd * PRICE_MULTIPLIER < 0.0101, `${e.id} min price is rounded up, not padded`);
    }
  }
});

test('the min price rounds up: to the cent at 1 USD or more, otherwise to 4 places', () => {
  assert.equal(minPrice(0.10), 0.15);
  assert.equal(minPrice(0.067), 0.1005);
  assert.equal(minPrice(12.9), 19.35);
  assert.equal(minPrice(0.666667), 1.01);
  assert.equal(minPrice(null), null);
});

test('a feature\'s licence is the worst of its deliverable models; unclear ones name their open questions', () => {
  for (const e of REGISTRY) {
    if (e.models.length) assert.equal(e.licence, featureLicence(e), `${e.id}: stored verdict matches its models`);
    if (e.licence === 'unclear' && e.status !== 'unavailable') {
      assert.ok(e.review.length >= 1, `${e.id}: an unclear licence names the question to settle`);
      for (const code of e.review) assert.ok(LICENCE_QUESTIONS[code], `${e.id}: ${code} is a real question`);
    }
  }
  // A commercial_ok primary does not hide an unclear fallback.
  assert.equal(featureLicence({ models: [{ deliverable: true, licence: 'commercial_ok' }, { deliverable: true, licence: 'unclear' }] }), 'unclear');
  assert.equal(featureLicence({ models: [{ deliverable: true, licence: 'commercial_ok' }, { deliverable: true, licence: 'non_commercial' }] }), 'non_commercial');
  assert.equal(featureLicence({ models: [] }), 'unclear', 'no model: never commercial_ok');
  assert.equal(capability('music').licence, 'unclear', 'the Lyria fallbacks keep music unclear even though ElevenLabs is commercial_ok');
  assert.equal(capability('upscale_8k').status, 'unavailable');
  assert.equal(capability('voice_cloning').gatedUntil, 'phase4');
});

test('every cited source is an official provider page or model card, never a redirect or search link', () => {
  const OFFICIAL = /^https:\/\/(?:ai\.google\.dev|blog\.google|cloud\.google\.com|docs\.cloud\.google\.com|developers\.google\.com|support\.google\.com|replicate\.com|bfl\.ai|elevenlabs\.io|help\.elevenlabs\.io|ffmpeg\.org|docs\.github\.com|github\.com\/(?:facebookresearch|hzwer)|developers\.cloudflare\.com|www\.backblaze\.com|supabase\.com|wasabi\.com|aws\.amazon\.com)\//;
  const all = JSON.stringify(registryJson()) + JSON.stringify(STORAGE_OPTIONS);
  const urls = all.match(/https?:\/\/[^"\s)]+/g);
  assert.ok(urls.length > 40);
  for (const u of urls) {
    assert.match(u, OFFICIAL, u);
    assert.doesNotMatch(u, /vertexaisearch|grounding-api-redirect|google\.com\/url|\/search\?/, u);
  }
  for (const u of Object.values(SOURCES)) assert.match(u, OFFICIAL, u);
});

test('docs/studio-sound-phase1.md is generated from the registry (run scripts/capabilities-report.mjs after a change)', async () => {
  const { reportMarkdown } = await import('../scripts/capabilities-report.mjs');
  assert.equal(readFileSync(new URL('../docs/studio-sound-phase1.md', import.meta.url), 'utf8'), reportMarkdown());
});

test('lib/capabilities/registry.json is the registry\'s export (run scripts/capabilities-export.mjs after a change)', () => {
  const file = JSON.parse(readFileSync(new URL('../lib/capabilities/registry.json', import.meta.url), 'utf8'));
  assert.deepEqual(file, JSON.parse(JSON.stringify(registryJson())));
});

// --- the guard -------------------------------------------------------------------

test('offerability: standard + commercial_ok may be offered, custom only on request, unclear and the rest never', () => {
  assert.equal(offerability({ status: 'standard', licence: 'commercial_ok' }), 'offer');
  assert.equal(offerability({ status: 'custom', licence: 'commercial_ok' }), 'on_request');
  assert.equal(offerability({ status: 'standard', licence: 'unclear' }), 'review', 'unclear is never treated as commercial_ok');
  assert.equal(offerability({ status: 'custom', licence: 'unclear' }), 'review');
  assert.equal(offerability({ status: 'standard', licence: 'non_commercial' }), 'never');
  assert.equal(offerability({ status: 'unavailable', licence: 'commercial_ok' }), 'never');
  assert.equal(offerability(null), 'never');
  // Voice cloning waits for Phase 4, and for PG1 Sound's safety filter to
  // stop refusing it (item 2: what the filters refuse is never offered).
  assert.deepEqual(SHIPPED_PHASES, [1]);
  assert.equal(offerability(capability('voice_cloning')), 'never');
  assert.equal(safetyAllows('voice_cloning'), false, 'PG1 Sound refuses voice cloning today');
  assert.equal(offerability(capability('voice_cloning'), { shipped: [1, 2, 3, 4] }), 'never', 'Phase 4 listed, but the filter still refuses it');
  assert.equal(offerability(capability('voice_cloning'), { shipped: [1, 4], gates: {} }), 'on_request', 'once the filter allows own-voice cloning');
  assert.equal(offerability(capability('stem_separation')), 'offer');
  assert.equal(offerability(capability('storyboard_keyframes')), 'offer', 'G1 answered');
  assert.equal(offerability(capability('film_music')), 'offer', 'G2 answered');
  assert.equal(offerability(capability('sound_effects')), 'on_request');
  assert.equal(offerability(capability('text_image_to_video')), 'review', 'the Replicate fallback keeps it under R1');
});

test('[OFFERS] lists what may be offered with its min price, what only on request, and what never', () => {
  const d = offersDirective();
  assert.match(d, /^\[OFFERS\]/);
  assert.match(d, /May be included in a package: [^\n]*Storyboard and keyframe images \(at least 0\.1005 USD per still\)[^\n]*Music for films \(score beds\) \(at least 0\.12 USD per music bed\)[^\n]*Stem separation \(at least 0\.045 USD per track \(about 3 minutes\) \(from PG1's own cost estimate\)\)/);
  assert.match(d, /Only as "custom, on request"[^\n]*Sound effects and Foley \(at least 0\.18 USD per minute of audio\)/);
  assert.match(d, /Only as "custom, on request"[^\n]*5\.1 and 7\.1 surround mixes/);
  assert.match(d, /until the operator settles its licence[^\n]*Text- and image-to-video clips \[licence question R1\][^\n]*Voice-over \(one voice\) \[licence question C1\][^\n]*Music \(PG1 Sound tracks\) \[licence question R1\]/);
  assert.match(d, /Never offered: [^\n]*Video upscaling to 8K \(no provider offers it\)/);
  assert.match(d, /Never offered: [^\n]*Consented voice cloning \(own voice only\) \(not before a later phase\)/);
  for (const n of NOT_OFFERED) assert.ok(d.includes(n.label), n.label);
  assert.match(d, /Voice cloning: not offered at all yet\./);
  assert.match(offersDirective({ shipped: [1, 4] }), /Voice cloning: not offered at all yet\./, 'the safety filter still refuses it');
  assert.match(offersDirective({ shipped: [1, 4], gates: {} }), /Voice cloning: only consented cloning of the client's own voice/);
  assert.match(d, /Never offer what PG1's safety filters refuse: imitating a real artist's voice or style, covers or remixes of existing songs/);
  assert.match(d, /White label: an offer, package, quote or proposal never names a provider, company or model/);
  assert.ok(d.includes(RIGHTS_WORDING) && d.includes(SAFETY_WORDING));
});

test('the rights and safety wording never promise ownership, exclusivity, indemnity or "no filters"', () => {
  assert.equal(RIGHTS_WORDING, 'Full commercial use rights, subject to provider terms. No exclusive rights, buyout or transfer of copyright ownership, and no IP indemnification.');
  assert.ok(RIGHTS_WORDING.toLowerCase().startsWith(RIGHTS_PHRASE));
  assert.match(SAFETY_WORDING, /safety filters/);
  assert.deepEqual(offerViolations(RIGHTS_WORDING), []);
  assert.deepEqual(offerViolations(SAFETY_WORDING), []);
});

test('offerViolations: what PG1 never offers is caught; a sentence that declines it is not', () => {
  const caught = (t) => offerViolations(t).map((v) => v.id);
  assert.deepEqual(caught('The Agency tier includes 5 client accounts.'), ['client_accounts']);
  assert.deepEqual(caught('Studio: $500/month for 3 seats.'), ['client_accounts']);
  assert.deepEqual(caught('Every Enterprise client gets a dedicated account manager.'), ['account_manager']);
  assert.deepEqual(caught('Renders run on dedicated GPUs.'), ['dedicated_compute']);
  assert.deepEqual(caught('Includes full IP indemnification.'), ['ip_indemnification']);
  assert.deepEqual(caught('Exclusive rights to every film.'), ['exclusive_rights']);
  assert.deepEqual(caught('A full buyout is available.'), ['exclusive_rights']);
  assert.deepEqual(caught('You own all rights to the footage.'), ['ownership_promise']);
  assert.deepEqual(caught('You will own the copyright to every film.'), ['ownership_promise']);
  assert.deepEqual(caught('Copyright ownership passes to the client.'), ['ownership_promise']);
  // Item 2: what the safety filters refuse.
  assert.deepEqual(caught('We can make covers of any existing song.'), ['refused_covers']);
  assert.deepEqual(caught('Tracks in the style of any famous artist.'), ['refused_voice_style']);
  assert.deepEqual(caught('Celebrity cameos via face swap.'), ['refused_likeness']);
  assert.deepEqual(caught('Disney characters in your ad.'), ['refused_characters']);
  assert.deepEqual(caught('Adult content packages.'), ['refused_adult']);
  assert.deepEqual(caught('No content filters, make anything.'), ['no_filter_promise']);
  for (const ok of ['PG1 does not provide IP indemnification.', 'No exclusive rights are granted.', 'There are no client accounts or seats yet.', 'Renders never run on dedicated compute.', 'Creator: $45/month for 8 clips.']) {
    assert.deepEqual(offerViolations(ok), [], ok);
  }
});

test('offerViolations: unavailable, gated and unclear features are caught; custom ones need "on request"', () => {
  const caught = (t, o) => offerViolations(t, o).map((v) => `${v.id}:${v.reason}`);
  assert.deepEqual(caught('Pro adds an 8K master.'), ['upscale_8k:no provider offers it']);
  assert.deepEqual(caught('Includes voice cloning of your narrator.'), ['voice_cloning:not offered before a later phase']);
  assert.deepEqual(caught('Includes voice cloning of your own voice.', { shipped: [1, 4] }), ['voice_cloning:PG1\'s safety filters refuse it']);
  const ready = { shipped: [1, 4], gates: {} };
  assert.deepEqual(caught('Includes voice cloning of your own voice.', ready), ['voice_cloning:it may only be offered as "custom, on request"']);
  assert.deepEqual(caught('Custom voice cloning on request: clone any voice you like.', ready), ['voice_cloning:only consented cloning of the client\'s own voice']);
  assert.deepEqual(caught('Custom voice cloning of your own voice, on request.', ready), []);
  assert.deepEqual(caught('Every film includes an original score.'), [], 'film music is offerable now (G2 answered)');
  assert.deepEqual(caught('Every film ships with a 4K upscaled master.'), ['upscale_4k:its licence is under review (R1)']);
  assert.deepEqual(caught('Every film includes sound effects and Foley.'), ['sound_effects:it may only be offered as "custom, on request"']);
  assert.deepEqual(caught('Sound effects and Foley: custom, on request.'), []);
  assert.deepEqual(caught('Studio tier: 5.1 surround mix included.'), ['surround_upmix:it may only be offered as "custom, on request"']);
  assert.deepEqual(caught('A 5.1 surround mix is available on request.'), []);
  assert.deepEqual(caught('No 8K, and no voice cloning yet.'), []);
  assert.match(offerNote(offerViolations('Includes full IP indemnification and an 8K master.')), /^\*\*Offer check:\*\* IP indemnification: PG1 never offers it; Video upscaling to 8K: no provider offers it\. Correct this before it reaches a client\.$/);
  assert.equal(offerNote([]), '');
});

test('licenceReviewNote warns the operator when a package relies on an unsettled licence', () => {
  const n = licenceReviewNote('## Packages\n| Tier | Price |\n|---|---|\n| Starter | $25 | 4 video clips with music |');
  assert.equal(n, '**Licence under review (operator only):** text- and image-to-video clips rely on licence questions not yet settled (R1; see the Studio + Sound report). Do not send this offer to a client until they are answered.', 'film music is settled; video still waits on R1');
  assert.match(licenceReviewNote('Sound package: 3 original tracks a month'), /music \(pg1 sound tracks\) rely on licence questions not yet settled \(R1;/);
  assert.equal(namesProvider(n), false, 'the note names no provider');
  assert.equal(licenceReviewNote('What is the weather?'), '');
});

// --- chat ------------------------------------------------------------------------

test('chat: [OFFERS] is in every prompt and a reply offering what PG1 may not gets the offer check (JSON and streamed)', async () => {
  const { default: chatHandler, __clearAuthRateLimitState } = await import('../api/chat.mjs');
  const { createSseParser } = await import('../lib/chatStream.mjs');
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  try {
    Object.assign(process.env, { USER_API_KEY: 'test-operator', USER_API_PASS: 'test-secret-pass', GEMINI_API_KEY: 'stub-gemini-key' });
    for (const k of ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CARTESIA_API_KEY']) delete process.env[k];
    __clearAuthRateLimitState();
    const REPLY = '## Packages\n| Tier | Price |\n|---|---|\n| Studio | $500/month | 20 video clips |\n\nStudio includes 3 seats and full IP indemnification.';
    const prompts = [];
    globalThis.fetch = async (url, options = {}) => {
      const u = String(url);
      if (!u.includes('generativelanguage.googleapis.com')) throw new Error('Unexpected network call in test: ' + u);
      prompts.push(JSON.parse(options.body).systemInstruction.parts[0].text);
      const cand = { content: { parts: [{ text: REPLY }] }, finishReason: 'STOP' };
      if (u.includes('streamGenerateContent')) return new Response(`data: ${JSON.stringify({ candidates: [cand] })}\n\n`);
      return Response.json({ candidates: [cand] });
    };
    const mk = () => ({ statusCode: null, headers: {}, jsonBody: null, chunks: [], setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; }, write(c) { this.chunks.push(String(c)); return true; }, end() { return this; }, on() {} });
    const req = (body, ip) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: ip }, body: { user: 'test-operator', pass: 'test-secret-pass', ...body } });
    const json = mk();
    await chatHandler(req({ prompt: 'price a studio package for an agency' }, '10.88.0.1'), json);
    assert.ok(prompts[0].includes(offersDirective()), 'the registry\'s rules are in the prompt');
    assert.match(json.jsonBody.reply, /\*\*Offer check:\*\* client accounts or seats: PG1 does not offer it yet; IP indemnification: PG1 never offers it\./);
    assert.match(json.jsonBody.reply, /\*\*Licence under review \(operator only\):\*\*/);
    const streamed = mk();
    await chatHandler(req({ prompt: 'price a studio package for an agency', stream: true }, '10.88.0.2'), streamed);
    const events = [];
    const parser = createSseParser(({ data }) => events.push(JSON.parse(data)));
    parser.push(streamed.chunks.join(''));
    parser.end();
    assert.match(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), /\*\*Offer check:\*\* client accounts or seats/);
  } finally {
    process.env = saved;
    globalThis.fetch = savedFetch;
  }
});

// --- costs and storage ------------------------------------------------------------

test('package estimates: 1, 3 and 10 minutes at 1080p and 4K, each line summed, min price 1.5x', () => {
  assert.deepEqual(PACKAGE_GRID.map((g) => `${g.minutes}:${g.resolution}`), ['1:1080p', '1:4k', '3:1080p', '3:4k', '10:1080p', '10:4k']);
  for (const g of PACKAGE_GRID) {
    const c = estimateFilmCost(g);
    assert.equal(c.expectedUsd, Math.round(c.lines.reduce((s, l) => s + l.usd, 0) * 100) / 100);
    assert.equal(c.minPriceUsd, minPrice(c.expectedUsd));
    assert.equal(c.fitsPipeline, g.minutes * 60 <= PIPELINE_MAX_SECONDS);
  }
  const one = estimateFilmCost({ minutes: 1, resolution: '1080p' });
  assert.equal(one.shots, 12);
  assert.equal(one.lines.find((l) => l.label === 'Video clips (1080p)').usd, 9, '60 s at 0.15 USD per second');
  assert.equal(one.lines.find((l) => l.label === 'Shot stills').usd, 12 * FILM_PRICES.stillUsd);
  assert.equal(one.expectedUsd, 12.9);
  assert.equal(estimateFilmCost({ minutes: 1, resolution: '4k' }).lines.find((l) => /Video clips/.test(l.label)).usd, 18, '60 s at 0.30 USD per second');
  assert.equal(PIPELINE_MAX_SECONDS, 300, '30 shots of at most 10 s');
  assert.equal(estimateFilmCost({ minutes: 10 }).fitsPipeline, false, 'a 10-minute film does not fit the current pipeline');
});

test('storage sizes follow from the bitrates; client deliverables are counted apart from working files', () => {
  const s = estimateFilmStorage({ minutes: 1, resolution: '1080p' });
  assert.equal(s.items[0].mb, 62.9, '8.384 Mbps for 60 s');
  assert.equal(s.items.find((i) => /^5\.1/.test(i.label)).mb, 51.8, '6 x 48 kHz x 3 bytes x 60 s');
  assert.equal(s.items.find((i) => /^7\.1/.test(i.label)).mb, 69.1);
  assert.ok(s.totalMb > s.clientMb);
  assert.equal(estimateFilmStorage({ minutes: 1, resolution: '4k' }).items[0].mb, 317.9, '42.384 Mbps for 60 s');
});

test('storage options: monthly cost with each provider\'s free allowance', () => {
  const by = Object.fromEntries(STORAGE_OPTIONS.map((o) => [o.id, o]));
  assert.equal(storageMonthlyUsd(by.cloudflare_r2, { gb: 500, egressGb: 1000 }), 7.35, '490 GB x 0.015, egress free');
  assert.equal(storageMonthlyUsd(by.backblaze_b2, { gb: 500, egressGb: 1000 }), 3.47, 'egress within 3x storage is free');
  assert.equal(storageMonthlyUsd(by.backblaze_b2, { gb: 100, egressGb: 1000 }), 7.7, '700 GB over 3x at 0.01');
  assert.equal(storageMonthlyUsd(by.supabase_pro, { gb: 500, egressGb: 1000 }), 76.02, '400 GB over the plan + 750 GB egress at 0.09');
  assert.equal(storageMonthlyUsd(by.wasabi, { gb: 100, egressGb: 0 }), 7.99, '1 TB minimum');
});

// --- E1 answered: the paid ElevenLabs plan ------------------------------------------

test('E1 answered: ElevenLabs TTS, dialogue, sound effects and voice output are commercial_ok on the paid plan', () => {
  assert.match(LICENCE_QUESTIONS.E1.answered, /the Creator plan \(paid self-serve\)/);
  assert.match(LICENCE_QUESTIONS.E1.answered, /named PG1-Studi0/);
  assert.match(LICENCE_QUESTIONS.E1.answered, /ELEVENLABS_API_KEY set in Vercel/);
  for (const e of REGISTRY) assert.ok(!e.review.includes('E1'), `${e.id} no longer waits on E1`);
  for (const id of ['dialogue_tts', 'sound_effects', 'voice_cloning']) {
    assert.equal(capability(id).licence, 'commercial_ok', id);
    assert.ok(capability(id).models.every((m) => m.provider === 'elevenlabs' && m.licence === 'commercial_ok'), id);
  }
  // E2 answered: v3 is generally available, so no beta condition is left.
  assert.match(LICENCE_QUESTIONS.E2.answered, /no longer in alpha and is generally available, including the Text to Dialogue API endpoint/);
  assert.ok(LICENCE_QUESTIONS.E2.sources.includes('https://elevenlabs.io/blog/eleven-v3'));
  assert.ok(!capability('dialogue_tts').licenceConditions.some((c) => /confirm|still a beta/i.test(c)), 'no beta concern left');
  assert.match(capability('voiceover_single').candidates.find((c) => c.provider === 'elevenlabs').licence, /^commercial_ok on the paid plan/);
  assert.deepEqual([...capability('voice_cloning').licenceConditions][0], 'The Creator plan (E1), which includes Professional Voice Cloning.');
  assert.equal(offerability(capability('dialogue_tts')), 'on_request');
  assert.equal(offerability(capability('voice_cloning')), 'never', 'still gated to Phase 4');
  assert.match(offersDirective(), /Only as "custom, on request"[^\n]*Dialogue text-to-speech \(several voices\)/);
});

test('E1 answered: the plan\'s film, TV and radio exclusion is recorded and film music stays on Lyria through the Gemini API', async () => {
  const eleven = capability('music').models.find((m) => m.provider === 'elevenlabs');
  assert.deepEqual([...eleven.excludes], ['film', 'TV', 'radio', 'large studio games']);
  assert.deepEqual(registryJson().features.find((f) => f.id === 'music').chosen[0].excludes, ['film', 'TV', 'radio', 'large studio games']);
  const film = capability('film_music');
  assert.deepEqual(film.models.map((m) => `${m.provider}:${m.model}`), ['google:lyria-3.5', 'google:lyria-3-clip-preview']);
  assert.equal(film.licence, 'commercial_ok', 'Lyria through the Gemini API: G2 answered');
  assert.deepEqual([...film.review], []);
  assert.equal(offerability(film), 'offer');

  const { filmMusicExclude } = await import('../lib/film/providers.mjs');
  const { musicPlan } = await import('../lib/music/engines.mjs');
  const env = { ELEVENLABS_API_KEY: 'el-test', GEMINI_API_KEY_PAID: 'paid-test', REPLICATE_API_TOKEN: 'r8-test' };
  assert.deepEqual(filmMusicExclude(env), ['elevenlabs', 'replicate']);
  assert.deepEqual([...new Set(musicPlan(env, { exclude: filmMusicExclude(env) }).map((c) => c.provider))], ['gemini_paid'], 'a film bed is planned on the Gemini API only');
  assert.ok(musicPlan(env).some((c) => c.provider === 'elevenlabs'), 'PG1 Sound tracks still start with ElevenLabs');
  const covered = { ...env, PG1_ELEVENLABS_FILM_RIGHTS: '1' };
  assert.deepEqual(filmMusicExclude(covered), ['replicate'], 'only a plan that covers film lets ElevenLabs make film beds');
});

// --- G1, G2 answered ----------------------------------------------------------------

test('G1 and G2 answered: Google output through the Gemini API is commercial_ok with the operator\'s note; Replicate-hosted Lyria 2 stays under R1', () => {
  assert.match(LICENCE_QUESTIONS.G1.answered, /effective 25 Sep 2025/);
  assert.match(LICENCE_QUESTIONS.G1.answered, /"Google won't claim ownership over that content"/);
  assert.ok(LICENCE_QUESTIONS.G1.sources.includes('https://ai.google.dev/gemini-api/terms'));
  assert.match(LICENCE_QUESTIONS.G2.answered, /Lyria 2 through Replicate stays unclear under R1/);
  assert.equal(GOOGLE_NOTE, 'operator accepted Google\'s generated-content terms; operator responsible for use');
  for (const e of REGISTRY) {
    for (const m of e.models.filter((x) => x.provider === 'google')) {
      assert.equal(m.licence, 'commercial_ok', `${e.id} ${m.model}`);
      assert.equal(m.licenceNote, GOOGLE_NOTE, `${e.id} ${m.model} carries the note`);
      assert.deepEqual([...m.licenceSources], ['https://ai.google.dev/gemini-api/terms']);
    }
    assert.ok(!e.review.includes('G1') && !e.review.includes('G2'), `${e.id} no longer waits on G1 or G2`);
    for (const c of e.candidates) if (/^(?:gemini|veo|imagen|lyria)/.test(c.model) && c.provider === 'google') assert.match(c.licence, /^commercial_ok: operator accepted Google's generated-content terms; operator responsible for use/, c.model);
  }
  const lyria2 = capability('music').models.find((m) => m.model === 'google/lyria-2');
  assert.deepEqual([lyria2.licence, [...lyria2.review]], ['unclear', ['R1']]);
  assert.deepEqual(REGISTRY.filter((e) => e.licence === 'unclear').map((e) => `${e.id}:${e.review.join(',')}`), ['text_image_to_video:R1', 'upscale_4k:R1', 'upscale_8k:', 'voiceover_single:C1', 'music:R1']);
});
