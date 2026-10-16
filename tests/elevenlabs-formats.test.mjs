// ElevenLabs output formats on the Creator plan: pcm_44100 and pcm_48000
// need the Pro plan, so no ElevenLabs request PG1 sends may ask for them.
// TTS and dialogue use pcm_24000; sound effects and music mp3_44100_192.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { synthesizeLineElevenLabs, createFilmDialogue, soundEffect, elevenLabsVoiceConfig } from '../lib/film/providers.mjs';
import { generateMusic, musicPlan } from '../lib/music/engines.mjs';
import { voiceCheck } from '../scripts/film-render.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRO_ONLY = /pcm_(?:44100|48000)/;
const ALLOWED = new Set(['pcm_16000', 'pcm_22050', 'pcm_24000', 'mp3_44100_128', 'mp3_44100_192']);
const ENV = { ELEVENLABS_API_KEY: 'sk_el_format_0123456789', PG1_FILM_VOICE_ID: 'brandvoice0123', PG1_ELEVENLABS_FILM_RIGHTS: '1' };

// Every ElevenLabs request, answered with something each caller accepts.
function capture() {
  const urls = [];
  const fetchImpl = async (u, o = {}) => {
    const url = String(u);
    if (url.startsWith('https://api.elevenlabs.io/')) urls.push(url);
    if (/with-timestamps/.test(url)) {
      const chars = [...JSON.parse(o.body).text];
      return new Response(JSON.stringify({ audio_base64: Buffer.alloc(4800).toString('base64'), alignment: { characters: chars, character_start_times_seconds: chars.map((c, i) => i * 0.05), character_end_times_seconds: chars.map((c, i) => i * 0.05 + 0.04) } }), { status: 200 });
    }
    if (/\/v1\/music/.test(url)) return new Response(Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]), { status: 200 });
    return new Response(Buffer.alloc(4800), { status: 200 });
  };
  return { urls, fetchImpl };
}

test('no ElevenLabs request asks for pcm_44100 or pcm_48000 (TTS, dialogue, sound effects, music, the voice check)', async () => {
  const { urls, fetchImpl } = capture();
  for (const env of [ENV, { ...ENV, PG1_FILM_ELEVENLABS_FORMAT: 'pcm_44100' }, { ...ENV, PG1_FILM_ELEVENLABS_FORMAT: 'pcm_48000' }]) {
    await synthesizeLineElevenLabs({ env, text: 'Every morning starts in the dark.', fetchImpl });
    await createFilmDialogue({ env, fetchImpl, log: () => {} })({ lines: [{ character: 'Ana', line: 'Morning.' }, { character: 'Ben', line: 'Already?' }] });
    await soundEffect({ env, text: 'a door creaks', seconds: 2, fetchImpl });
    const plan = musicPlan(env).filter((c) => c.provider === 'elevenlabs');
    assert.equal(plan.length, 1);
    const out = await generateMusic({ env, spec: { prompt: 'calm piano', instrumental: true, length: 'short' }, plan, fetchImpl, log: () => {} });
    assert.equal(out.ok, true, out.detail);
    assert.equal(out.ext, 'mp3', 'the MP3 asked for is kept as MP3');
    assert.equal(await voiceCheck({ ...env, VOICE_CHECK_OUT: path.join(os.tmpdir(), `pg1-voice-check-${process.pid}.wav`) }, { fetchImpl, log: () => {} }), 0);
  }
  assert.ok(urls.length >= 15, `${urls.length} requests`);
  // Every request that makes audio; listing the account's voices (the voice
  // check's fallback lookup) returns no audio and has no format.
  for (const u of urls.filter((x) => new URL(x).pathname !== '/v1/voices')) {
    const format = new URL(u).searchParams.get('output_format');
    assert.ok(format, `${u} names its format`);
    assert.doesNotMatch(format, PRO_ONLY, u);
    assert.ok(ALLOWED.has(format), `${format} is a Creator-plan format`);
  }
  assert.ok(urls.filter((u) => /text-to-speech|text-to-dialogue/.test(u)).every((u) => /output_format=pcm_24000/.test(u)), 'speech in 24 kHz PCM');
  assert.ok(urls.filter((u) => /sound-generation|\/v1\/music/.test(u)).every((u) => /output_format=mp3_44100_192/.test(u)), 'effects and music in 192 kbps MP3');
  assert.equal(elevenLabsVoiceConfig({ PG1_FILM_ELEVENLABS_FORMAT: 'pcm_44100' }).format, 'pcm_24000', 'the override may not pick a Pro-only format');
});

test('no Pro-only ElevenLabs format appears in the code that builds requests', () => {
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(?:mjs|js)$/.test(f)) files.push(p); } };
  walk(path.join(ROOT, 'lib'));
  walk(path.join(ROOT, 'scripts'));
  walk(path.join(ROOT, 'api'));
  const hits = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (PRO_ONLY.test(code)) hits.push(`${path.relative(ROOT, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});
