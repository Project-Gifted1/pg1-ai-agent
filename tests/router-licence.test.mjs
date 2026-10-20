// Client work and the registry's licences and prices (PR 324 follow-up):
//  - every engine in ROUTING_CHAINS with its licence; Google, ElevenLabs
//    and Claude (cleared by the operator for client text) are
//    commercial_ok, everything else is unclear;
//  - a client job can never reach a non-commercial_ok engine in any chain
//    (text, stills, clips, voice, dialogue, sfx, music, /music), nor
//    ElevenLabs Music (its licence excludes film, TV and radio), nor FLUX
//    (deliverable: false: its stills become the keyframes clips are made
//    from), whether planned by chainPlan or by planRoute;
//  - the ledger records each engine's registry price, never a worst case;
//  - the Lyria clip model is called through the Gemini API, not Replicate.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTING_CHAINS, stepLicence, stepDeliverable, clientAllowedStep, capability, ENGINE_UNIT_COSTS, engineCostUsd } from '../lib/capabilities/registry.mjs';
import { chainPlan, CHAIN_IDS } from '../lib/router/chains.mjs';
import { MEDIA_UNIT_USD, recordUsage, CARTESIA_USD_PER_MCHAR, ELEVENLABS_TTS_USD_PER_MCHAR, __resetRouterState, planRoute, TASKS, DATA } from '../lib/aiRouter.mjs';
import { filmTextPlan, filmMediaPlan, createFilmVoice, soundEffect, createFilmDialogue, EngineError } from '../lib/film/providers.mjs';
import { musicPlan, filmMusicPlan, musicClipPlan, generateMusic } from '../lib/music/engines.mjs';
import { parseMusicFlags } from '../lib/music/text.mjs';
import { trackSpec } from '../lib/music/pipeline.mjs';
import { clipCostOnUsd, stillCostOnUsd } from '../lib/film/cost.mjs';

const ALL_KEYS = {
  PG1_DAILY_SPEND_CAP_USD: '1000', ANTHROPIC_API_KEY: 'sk-ant-licence-0123456789', GEMINI_API_KEY_PAID: 'AQ.licence-paid-0123456789', GEMINI_API_KEY_FREE: 'AIza-licence-free-0123',
  OPENROUTER_API_KEY: 'sk-or-licence-0123456789', AI_GATEWAY_API_KEY: 'gw-licence-0123456789', OPENAI_API_KEY: 'sk-licence-0123456789',
  REPLICATE_API_TOKEN: 'r8_licence_0123456789abcdef', CARTESIA_API_KEY: 'sk_car_licence_0123456789', ELEVENLABS_API_KEY: 'sk_el_licence_0123456789',
  GROQ_API_KEY: 'gsk_licence_0123456789', MISTRAL_API_KEY: 'mistral-licence-0123456789', GITHUB_MODELS_TOKEN: 'github_pat_licence_0123456789',
  CLOUDFLARE_AI_TOKEN: 'cf-licence-0123456789', CLOUDFLARE_ACCOUNT_ID: 'f4ca340d9bcbeeab89bba95915dd072e',
  PG1_ELEVENLABS_FILM_RIGHTS: '1'
};
// The no-card free engines (Step 3): unclear for client work, operator only.
const FREE_ENGINES = ['groq', 'mistral', 'github_models', 'cloudflare'];
const CLEARED_SOURCES = new Set(['gemini_paid', 'gemini_free', 'elevenlabs', 'anthropic']);

beforeEach(() => __resetRouterState());

describe('licences in ROUTING_CHAINS', () => {
  test('every engine and its licence: only Google, ElevenLabs and Claude are commercial_ok', () => {
    const table = [];
    for (const [id, steps] of Object.entries(ROUTING_CHAINS)) for (const s of steps) table.push(`${id}:${s.provider}${s.model ? `:${s.model}` : s.slot ? `:${s.slot}` : ''}=${stepLicence(s)}`);
    assert.deepEqual(table, [
      'text:anthropic=commercial_ok', 'text:gemini_paid=commercial_ok', 'text:gemini_free=unclear',
      'text:groq=unclear', 'text:mistral=unclear', 'text:github_models=unclear', 'text:cloudflare=unclear', 'text:openrouter=unclear', 'text:gateway=unclear', 'text:openai=unclear',
      'chat_light:gemini_free=unclear', 'chat_light:groq=unclear', 'chat_light:mistral=unclear', 'chat_light:github_models=unclear', 'chat_light:cloudflare=unclear', 'chat_light:gemini_paid=commercial_ok', 'chat_light:anthropic=commercial_ok', 'chat_light:gateway=unclear', 'chat_light:openrouter=unclear', 'chat_light:openai=unclear',
      'research:gemini_paid=commercial_ok', 'research:anthropic=commercial_ok',
      'speech:gemini_free=unclear', 'speech:cartesia:sonic-3.6=unclear',
      'stills:replicate:black-forest-labs/flux-kontext-pro=unclear', 'stills:gemini_paid:gemini-3.1-flash-image=commercial_ok',
      'clips:gemini_paid:gemini-omni-1.1-flash=commercial_ok', 'clips:replicate:kwaivgi/kling-v2.1=unclear',
      'image:gemini_paid=commercial_ok', 'image:gemini_paid:secondary=commercial_ok', 'image:replicate=unclear',
      'voice:elevenlabs:eleven_multilingual_v2=commercial_ok', 'voice:cartesia:sonic-3.6=unclear',
      'dialogue:elevenlabs:eleven_v3 (Text to Dialogue)=commercial_ok', 'dialogue:elevenlabs:eleven_multilingual_v2=commercial_ok',
      'sfx:elevenlabs:eleven_text_to_sound_v2=commercial_ok',
      'movie_dialogue_clips:gemini_paid:gemini-omni-1.1-flash=commercial_ok', 'speech_to_speech:elevenlabs:eleven_multilingual_sts_v2=commercial_ok',
      'music_film:gemini_paid:lyria-3.5=commercial_ok', 'music_film:gemini_paid:lyria-3-clip-preview=commercial_ok', 'music_film:elevenlabs:Eleven Music=commercial_ok',
      'music:gemini_paid:lyria-3.5=commercial_ok', 'music:gemini_paid:lyria-3-clip-preview=commercial_ok', 'music:elevenlabs:Eleven Music=commercial_ok'
    ]);
    for (const [, steps] of Object.entries(ROUTING_CHAINS)) {
      for (const s of steps) if (stepLicence(s) === 'commercial_ok') assert.ok(CLEARED_SOURCES.has(s.provider), `${s.provider} is commercial_ok only if Google, ElevenLabs or Claude`);
    }
    // The no-card free engines are unclear and operator only in every chain.
    for (const [id, steps] of Object.entries(ROUTING_CHAINS)) {
      for (const s of steps.filter((x) => FREE_ENGINES.includes(x.provider))) {
        assert.equal(stepLicence(s), 'unclear', `${id}:${s.provider}`);
        assert.equal(s.operatorOnly, true, `${id}:${s.provider} is operator only`);
      }
    }
    // FLUX Kontext Pro is never a client deliverable; every other step may be.
    assert.deepEqual(Object.values(ROUTING_CHAINS).flat().filter((s) => !stepDeliverable(s)).map((s) => s.model), ['black-forest-labs/flux-kontext-pro']);
    for (const f of ['storyboard_keyframes', 'scene_character_consistency']) {
      const flux = capability(f).models.find((m) => m.model === 'black-forest-labs/flux-kontext-pro');
      assert.equal(flux.deliverable, false, f);
      assert.equal(flux.licence, 'unclear', `${f}: FLUX stays under R1`);
      assert.equal(capability(f).licence, 'commercial_ok', `${f}: its deliverables come from Gemini image alone`);
    }
    // ElevenLabs Music is commercial_ok for the operator's own tracks, but never for a client.
    assert.ok(ROUTING_CHAINS.music.find((s) => s.provider === 'elevenlabs').clientExcluded);
    assert.ok(ROUTING_CHAINS.music_film.find((s) => s.provider === 'elevenlabs').clientExcluded);
  });

  test('the Lyria clip model is a Gemini API model: its plan is the paid Gemini key, and the call goes to the Gemini API', async () => {
    assert.equal(capability('film_music').models.find((m) => m.model === 'lyria-3-clip-preview').provider, 'google');
    const plan = musicClipPlan(ALL_KEYS);
    assert.deepEqual(plan.map((c) => [c.provider, c.models[0], c.clip]), [['gemini_paid', 'lyria-3-clip-preview', true]]);
    const urls = [];
    const fetchImpl = async (u) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/mpeg', data: Buffer.from('mp3').toString('base64') } }] } }] }), { status: 200 });
    };
    const out = await generateMusic({ env: ALL_KEYS, spec: { prompt: 'calm', instrumental: true, length: 'short' }, plan, fetchImpl, log: () => {} });
    assert.equal(out.ok, true);
    assert.equal(out.provider, 'gemini_paid');
    assert.ok(urls.length && urls.every((u) => u.startsWith('https://generativelanguage.googleapis.com/') && /lyria-3-clip-preview/.test(u)), urls.join('\n'));
    assert.ok(!urls.some((u) => /replicate/.test(u)));
  });
});

describe('a client job never reaches an engine not cleared for client work', () => {
  test('every chain: only commercial_ok steps, never ElevenLabs Music', () => {
    for (const id of CHAIN_IDS) {
      const plan = chainPlan(id, { env: ALL_KEYS, clientWork: true, operator: true, filmRights: true });
      for (const s of plan.steps) {
        assert.equal(stepLicence(s), 'commercial_ok', `${id}: ${s.provider} ${s.model || ''}`);
        assert.ok(!s.clientExcluded, `${id}: ${s.provider} is excluded for clients`);
        assert.ok(!s.operatorOnly, `${id}: ${s.provider} is operator only`);
      }
      for (const s of plan.skipped) assert.ok(['licence', 'client_excluded', 'operator_only', 'not_deliverable'].includes(s.reason), `${id}: ${s.provider} skipped as ${s.reason}`);
      for (const s of plan.steps) assert.ok(clientAllowedStep(s), `${id}: ${s.provider}`);
    }
  });

  test('planRoute walks every chain it plans and never plans OpenRouter, the AI gateway, OpenAI or Replicate for a client', () => {
    const NOT_FOR_CLIENTS = new Set(['openrouter', 'gateway', 'openai', 'replicate', 'gemini_free', 'cartesia', ...FREE_ENGINES]);
    // Every task planRoute serves, and the chain behind it.
    const TASK_CHAINS = { [TASKS.LIGHT]: 'chat_light', [TASKS.HEAVY]: 'text', [TASKS.TTS]: 'speech', [TASKS.MUSIC]: 'music', [TASKS.MEDIA]: null };
    assert.deepEqual(Object.keys(TASK_CHAINS).sort(), Object.values(TASKS).sort(), 'every task is walked');
    for (const [task, chain] of Object.entries(TASK_CHAINS)) {
      for (const dataClass of [DATA.OPERATOR, DATA.CUSTOMER]) {
        const client = planRoute(task, { env: ALL_KEYS, dataClass, clientWork: true });
        for (const c of client) assert.ok(!NOT_FOR_CLIENTS.has(c.provider), `${task}/${dataClass}: ${c.provider} planned for a client`);
        if (chain) {
          const allowed = new Set(ROUTING_CHAINS[chain].filter(clientAllowedStep).map((s) => s.provider));
          for (const c of client) assert.ok(allowed.has(c.provider), `${task}: ${c.provider} is not cleared in ${chain}`);
        }
      }
    }
    // What each task plans for a client, in order.
    const providers = (task) => [...new Set(planRoute(task, { env: ALL_KEYS, dataClass: DATA.OPERATOR, clientWork: true }).map((c) => c.provider))];
    assert.deepEqual(providers(TASKS.HEAVY), ['anthropic', 'gemini_paid']);
    assert.deepEqual(providers(TASKS.LIGHT), ['gemini_paid', 'anthropic']);
    assert.deepEqual(providers(TASKS.MUSIC), ['gemini_paid']);
    assert.deepEqual(providers(TASKS.MEDIA), ['gemini_paid']);
    assert.deepEqual(providers(TASKS.TTS), []);
    // Customer data never reaches a free engine either, client work or not.
    for (const task of Object.values(TASKS)) {
      for (const c of planRoute(task, { env: ALL_KEYS, dataClass: DATA.CUSTOMER })) assert.ok(!FREE_ENGINES.includes(c.provider), `${task}: ${c.provider} got customer data`);
    }
    // OpenRouter's free DeepSeek and Qwen models are its own (unclear) step's,
    // with first-party Chinese hosts ignored.
    const or = planRoute(TASKS.HEAVY, { env: ALL_KEYS, dataClass: DATA.OPERATOR }).find((c) => c.provider === 'openrouter');
    assert.ok(or.freeModels.every((m) => /:free$/.test(m) && /^qwen\//.test(m)), or.freeModels.join());
    assert.ok(or.freeModels.every((m) => !/deepseek/i.test(m)), 'no DeepSeek model, ever');
    assert.ok(or.ignoreProviders.includes('DeepSeek') && or.ignoreProviders.includes('Alibaba'));
    assert.equal(stepLicence(ROUTING_CHAINS.text.find((s) => s.provider === 'openrouter')), 'unclear');
    // The operator's own work keeps every engine.
    assert.ok(planRoute(TASKS.HEAVY, { env: ALL_KEYS, dataClass: DATA.OPERATOR }).some((c) => c.provider === 'openrouter'));
    assert.ok(planRoute(TASKS.MEDIA, { env: ALL_KEYS, dataClass: DATA.OPERATOR }).some((c) => c.provider === 'replicate'));
  });

  test('text: film text runs on Claude, then the paid Gemini key (never OpenRouter), client or not', () => {
    assert.deepEqual(filmTextPlan(ALL_KEYS, { clientWork: true }).map((c) => c.provider), ['anthropic', 'gemini_paid']);
    assert.deepEqual(filmTextPlan(ALL_KEYS).map((c) => c.provider), ['anthropic', 'gemini_paid'], 'customer data: commercial_ok engines only');
  });

  test('stills and clips: Gemini only for a client film (no FLUX Kontext Pro, no Kling)', () => {
    assert.deepEqual(filmMediaPlan(ALL_KEYS, { kind: 'still', clientWork: true }).map((s) => `${s.provider}:${s.model}`), ['gemini_paid:gemini-3.1-flash-image']);
    // FLUX is skipped for not being a deliverable, before its licence is even read.
    assert.deepEqual(chainPlan('stills', { env: ALL_KEYS, clientWork: true }).skipped.map((s) => `${s.model}:${s.reason}`), ['black-forest-labs/flux-kontext-pro:not_deliverable']);
    assert.deepEqual(filmMediaPlan(ALL_KEYS, { kind: 'clip', clientWork: true }).map((s) => `${s.provider}:${s.model}`), ['gemini_paid:gemini-omni-1.1-flash']);
    assert.deepEqual(filmMediaPlan(ALL_KEYS, { kind: 'still' }).map((s) => s.provider), ['replicate', 'gemini_paid'], 'the operator\'s own films keep FLUX first');
  });

  test('voice, dialogue and sfx: ElevenLabs only (never Cartesia); with no ElevenLabs key a client film stops clearly', async () => {
    const noEl = { ...ALL_KEYS, PG1_DAILY_SPEND_CAP_USD: '1000', ELEVENLABS_API_KEY: '' };
    assert.deepEqual(chainPlan('voice', { env: ALL_KEYS, clientWork: true }).steps.map((s) => s.provider), ['elevenlabs']);
    const voice = createFilmVoice({ env: noEl, clientWork: true, fetchImpl: async () => { throw new Error('no call expected'); } });
    await assert.rejects(voice({ text: 'x' }), (e) => e instanceof EngineError && e.kind === 'not_configured' && e.licence);
    await assert.rejects(soundEffect({ env: noEl, text: 'door', clientWork: true, fetchImpl: async () => { throw new Error('no call expected'); } }), (e) => e.kind === 'not_configured');
    const dialogue = createFilmDialogue({ env: noEl, clientWork: true, fetchImpl: async () => { throw new Error('no call expected'); } });
    await assert.rejects(dialogue({ lines: [{ character: 'Ana', line: 'Hi.' }] }), (e) => e.kind === 'not_configured');
  });

  test('film music and /music: never ElevenLabs Music for a client, even with film rights; the operator may keep it on /music', () => {
    assert.ok(!filmMusicPlan(ALL_KEYS, { clientWork: true }).some((c) => c.provider === 'elevenlabs'));
    assert.ok(filmMusicPlan(ALL_KEYS).some((c) => c.provider === 'elevenlabs'), 'film rights recorded: the operator\'s own film may use it');
    assert.deepEqual([...new Set(musicPlan(ALL_KEYS, { clientWork: true }).map((c) => c.provider))], ['gemini_paid']);
    assert.ok(musicPlan(ALL_KEYS).some((c) => c.provider === 'elevenlabs'), 'operator /music keeps the whole chain');
    const f = parseMusicFlags('a calm piano piece --client --instrumental');
    assert.equal(f.ok, true);
    assert.equal(f.spec.client, true);
    assert.equal(f.prompt, 'a calm piano piece');
    assert.equal(trackSpec({ prompt: 'x', options: f.spec }).client, true);
    assert.equal('client' in trackSpec({ prompt: 'x', options: parseMusicFlags('a calm piece').spec }), false);
  });
});

describe('the ledger records each engine\'s registry price', () => {
  test('every priced unit points at a registry model; clips are 0.30 (Kling) and 0.50 (Omni), never 1.40', () => {
    for (const [unit, c] of Object.entries(ENGINE_UNIT_COSTS)) {
      const e = capability(c.feature);
      assert.ok(e, `${unit}: ${c.feature}`);
      assert.ok(e.models.some((m) => m.model === c.model), `${unit}: ${c.model} is a chosen model of ${c.feature}`);
    }
    assert.equal(MEDIA_UNIT_USD.video_replicate, 0.30);
    assert.equal(MEDIA_UNIT_USD.video_gemini, 0.50);
    assert.equal(MEDIA_UNIT_USD.still_replicate, 0.04);
    assert.equal(MEDIA_UNIT_USD.still_gemini, 0.067);
    assert.equal(MEDIA_UNIT_USD.music_lyria, 0.08);
    assert.equal(MEDIA_UNIT_USD.music_lyria_clip, 0.04);
    assert.equal(CARTESIA_USD_PER_MCHAR, 50);
    assert.equal(ELEVENLABS_TTS_USD_PER_MCHAR, 100);
    assert.equal(engineCostUsd('sfx_elevenlabs', { seconds: 30 }), 0.06);
    assert.equal(engineCostUsd('music_elevenlabs', { seconds: 60 }), 0.15);
    assert.equal(engineCostUsd('dialogue_elevenlabs', { chars: 500 }), 0.05);
    assert.equal(engineCostUsd('video_gemini', { seconds: 10 }), 1);
    // The film's own charges agree with the registry.
    assert.equal(clipCostOnUsd('replicate', 'standard', 5), 0.30);
    assert.equal(clipCostOnUsd('gemini_paid', 'standard', 5), 0.50);
    assert.equal(stillCostOnUsd('replicate'), 0.04);
    assert.equal(stillCostOnUsd('gemini_paid'), 0.07, 'in cents, as the film cap is kept');
  });

  test('a clip row with no price of its own is recorded at the registry price', () => {
    const rows = [];
    const ledger = { record: (r) => rows.push(r) };
    const logged = [];
    recordUsage({ provider: 'replicate', model: 'kwaivgi/kling-v2.1', task: 'media', dataClass: 'operator', unit: 'video_replicate' }, { env: {}, ledger, log: (l) => logged.push(l) });
    recordUsage({ provider: 'gemini_paid', model: 'gemini-omni-1.1-flash', task: 'media', dataClass: 'operator', unit: 'video_gemini', costUsd: 1 }, { env: {}, ledger, log: (l) => logged.push(l) });
    const costs = logged.map((l) => JSON.parse(String(l).replace(/^\[pg1-ai-usage\] /, '')).cost_usd);
    assert.deepEqual(costs, [0.3, 1], 'Kling at 0.30, a 10 s Omni clip at its own 1.00');
    assert.deepEqual(rows.map((r) => r.cost_usd), [0.3, 1], 'the same in the ledger');
  });
});
