// Client work reaches only engines whose registry licence is commercial_ok
// (Google, ElevenLabs, and Claude for text), in every chain; FLUX,
// OpenRouter, the AI gateway and OpenAI are 'unclear'; /music never falls
// through to ElevenLabs Music for a client; no ElevenLabs request asks for a
// Pro-tier format (pcm_44100, pcm_48000).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROUTING_CHAINS, stepLicence } from '../lib/capabilities/registry.mjs';
import { chainPlan } from '../lib/router/chains.mjs';
import { planRoute, TASKS, DATA, __resetRouterState } from '../lib/aiRouter.mjs';
import { filmTextPlan, filmMediaPlan, elevenLabsVoiceConfig } from '../lib/film/providers.mjs';
import { musicPlan, generateMusic, ELEVENLABS_OUTPUT_FORMAT } from '../lib/music/engines.mjs';
import { parseMusicFlags, specText } from '../lib/music/text.mjs';
import { trackSpec } from '../lib/music/pipeline.mjs';

const ALL_KEYS = {
  ANTHROPIC_API_KEY: 'sk-ant-test', GEMINI_API_KEY_PAID: 'AIza-paid', GEMINI_API_KEY_FREE: 'AIza-free',
  OPENROUTER_API_KEY: 'or-key', AI_GATEWAY_API_KEY: 'gw-key', OPENAI_API_KEY: 'sk-openai',
  REPLICATE_API_TOKEN: 'r8_test', ELEVENLABS_API_KEY: 'el-key', CARTESIA_API_KEY: 'ca-key',
  PG1_ELEVENLABS_FILM_RIGHTS: '1', PG1_TTS_FREE_FIRST: '1', PG1_TTS_GEMINI_VOICE: 'Kore'
};
const UNCLEARED = /^(?:openrouter|gateway|openai|cartesia|gemini_free)$/;

test('every engine in ROUTING_CHAINS, with its licence: only Google, ElevenLabs and Claude are commercial_ok', () => {
  const rows = [];
  for (const [id, steps] of Object.entries(ROUTING_CHAINS)) for (const s of steps) rows.push([id, s.provider, s.model || '', stepLicence(s)]);
  for (const [id, provider, model, licence] of rows) {
    const flux = /flux/i.test(model) || (id === 'image' && provider === 'replicate');
    if (flux || UNCLEARED.test(provider) || /kling/.test(model)) assert.equal(licence, 'unclear', `${id}: ${provider} ${model}`);
    else assert.equal(licence, 'commercial_ok', `${id}: ${provider} ${model}`);
    if (licence === 'commercial_ok') assert.match(provider, /^(?:gemini_paid|elevenlabs|anthropic)$/, `${id}: ${provider}`);
  }
});

test('a client job never reaches a non-commercial_ok engine, in any chain', () => {
  __resetRouterState();
  for (const id of ['text', 'chat_light', 'research', 'speech', 'stills', 'clips', 'image', 'voice', 'dialogue', 'sfx', 'music_film', 'music']) {
    const plan = chainPlan(id, { env: ALL_KEYS, clientWork: true, operator: true });
    for (const s of plan.steps) {
      assert.equal(s.licence, 'commercial_ok', `${id}: ${s.provider} ${s.model || ''}`);
      assert.notEqual(s.clientOk, false, `${id}: ${s.provider}`);
    }
    // And every step left out was left out for a reason, never silently kept.
    const all = chainPlan(id, { env: ALL_KEYS, clientWork: false, operator: true }).steps.length;
    assert.ok(plan.steps.length <= all);
  }
  // The named chains, as the client sees them.
  const ids = (id) => chainPlan(id, { env: ALL_KEYS, clientWork: true }).steps.map((s) => `${s.provider}${s.model ? ` ${s.model}` : ''}`);
  assert.deepEqual(ids('text'), ['anthropic', 'gemini_paid']);
  assert.deepEqual(ids('stills'), ['gemini_paid gemini-3.1-flash-image']);
  assert.deepEqual(ids('clips'), ['gemini_paid gemini-omni-1.1-flash']);
  assert.deepEqual(ids('voice'), ['elevenlabs eleven_multilingual_v2']);
  assert.deepEqual(ids('music'), ['gemini_paid lyria-3.5', 'gemini_paid lyria-3-clip-preview'], '/music for a client: never ElevenLabs Music');
  // Film beds: ElevenLabs Music only when PG1_ELEVENLABS_FILM_RIGHTS=1 records that the plan covers film.
  const noRights = { ...ALL_KEYS, PG1_ELEVENLABS_FILM_RIGHTS: '' };
  assert.ok(!chainPlan('music_film', { env: noRights, clientWork: true }).steps.some((s) => s.provider === 'elevenlabs'), 'film beds for a client: never ElevenLabs Music without film rights');
  assert.ok(!chainPlan('music_film', { env: noRights }).steps.some((s) => s.provider === 'elevenlabs'), 'nor for the operator\'s films');
});

test('the router\'s own plans (text, music) and the film plans keep the client filter', () => {
  __resetRouterState();
  const providers = (plan) => plan.map((c) => c.provider);
  for (const task of [TASKS.HEAVY, TASKS.LIGHT, TASKS.MUSIC, TASKS.TTS]) {
    const p = providers(planRoute(task, { env: ALL_KEYS, dataClass: DATA.CUSTOMER, clientWork: true }));
    assert.ok(!p.some((x) => UNCLEARED.test(x)), `${task}: ${p.join(',')}`);
  }
  assert.ok(providers(planRoute(TASKS.HEAVY, { env: ALL_KEYS, dataClass: DATA.CUSTOMER })).includes('openrouter'), 'operator work keeps the backups');
  assert.deepEqual(providers(filmTextPlan(ALL_KEYS, { clientWork: true })), ['anthropic', 'gemini_paid']);
  assert.ok(providers(filmTextPlan(ALL_KEYS)).includes('openrouter'));
  assert.deepEqual(providers(filmMediaPlan(ALL_KEYS, { kind: 'still', clientWork: true })), ['gemini_paid']);
  assert.ok(!providers(musicPlan(ALL_KEYS, { clientWork: true })).includes('elevenlabs'));
  assert.ok(providers(musicPlan(ALL_KEYS)).includes('elevenlabs'), 'operator /music may keep ElevenLabs');
});

test('/music --client: parsed, kept on the track, and never sent to ElevenLabs even when Lyria is out', async () => {
  const parsed = parseMusicFlags('warm piano for a bakery ad --client --instrumental');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.spec.client, true);
  assert.match(specText(parsed.spec), /client track/);
  assert.equal(trackSpec({ prompt: 'x', options: parsed.spec }).client, true);
  assert.equal(trackSpec({ prompt: 'x', options: {} }).client, false);
  __resetRouterState();
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    return new Response('{"error":{"code":429,"message":"quota exhausted","status":"RESOURCE_EXHAUSTED"}}', { status: 429 });
  };
  // A plan that still lists ElevenLabs (as an operator plan would): the client spec drops it.
  const plan = musicPlan(ALL_KEYS);
  assert.ok(plan.some((c) => c.provider === 'elevenlabs'));
  const out = await generateMusic({ env: ALL_KEYS, spec: { prompt: 'warm piano', instrumental: true, length: 'short', client: true }, plan, fetchImpl, sleep: async () => {}, log: () => {} });
  assert.equal(out.ok, false);
  assert.ok(seen.length > 0);
  assert.ok(!seen.some((u) => /elevenlabs/.test(u)), seen.join('\n'));
});

test('no ElevenLabs request asks for pcm_44100 or pcm_48000 (they need the Pro tier)', () => {
  assert.equal(ELEVENLABS_OUTPUT_FORMAT, 'mp3_44100_192');
  for (const f of ['pcm_44100', 'pcm_48000', 'mp3_44100_192', 'nonsense']) assert.equal(elevenLabsVoiceConfig({ PG1_FILM_ELEVENLABS_FORMAT: f }).format, 'pcm_24000', f);
  assert.equal(elevenLabsVoiceConfig({ PG1_FILM_ELEVENLABS_FORMAT: 'pcm_22050' }).format, 'pcm_22050');
  // Every source line that builds an ElevenLabs output format.
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const f = path.join(d, n); if (statSync(f).isDirectory()) walk(f); else if (/\.(mjs|js)$/.test(n)) files.push(f); } };
  for (const d of ['lib', 'scripts', 'api']) walk(new URL(`../${d}`, import.meta.url).pathname);
  for (const f of files) {
    const code = readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.doesNotMatch(code, /['"`=]pcm_(?:44100|48000)\b/, f);
  }
});
