// Delivered files carry no engine, library or model name in their metadata:
// the 9:16 cut and the audio stems, made with the real ffmpeg from sources
// tagged with provider names (skipped where ffmpeg is not installed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as ff from '../lib/film/ffmpeg.mjs';
import { run } from '../lib/film/ffmpeg.mjs';

const HAS_FFMPEG = await ff.hasFfmpeg();
const BANNED = /(?<![a-z0-9])(?:eleven[\s_-]*labs|google|gemini|veo|lyria|replicate|kling|cartesia|flux|openrouter|openai|anthropic|claude|omni|lavf|lavc|libavformat|libavcodec)(?![a-z0-9])/i;

async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]);
  const j = JSON.parse(stdout);
  return { format: j.format.tags || {}, streams: j.streams.map((s) => s.tags || {}) };
}

test('the 9:16 cut and the stems: source tags stripped, PG1 Studio\'s own in their place', { skip: !HAS_FFMPEG && 'ffmpeg is not installed' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pg1-meta-'));
  try {
    const f = (n) => path.join(dir, n);
    const tags = ['-metadata', 'title=Gemini Omni clip', '-metadata', 'comment=made on Replicate with Kling', '-metadata', 'artist=ElevenLabs', '-metadata:s:v:0', 'encoder=Google Veo'];
    await run('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=1', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', ...tags, f('master.mp4')]);
    await run('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=300:d=1', '-metadata', 'artist=ElevenLabs', '-metadata', 'comment=Lyria bed', f('voice.wav')]);
    const before = await probe(f('master.mp4'));
    assert.match(JSON.stringify(before), BANNED, 'the source does carry provider names');

    await ff.socialCut(f('master.mp4'), f('social.mp4'), { width: 180, height: 320 }, { title: 'Harbour at Dawn' });
    const social = await probe(f('social.mp4'));
    assert.doesNotMatch(JSON.stringify(social), BANNED, JSON.stringify(social));
    assert.equal(social.format.title, 'Harbour at Dawn');
    assert.equal(social.format.comment, 'PG1 Studio');
    assert.ok(social.streams.every((s) => !s.encoder || s.encoder === 'PG1 Studio'), JSON.stringify(social.streams));

    await ff.mixAudio({ voice: [{ file: f('voice.wav'), atS: 0 }], music: [], sfx: [], totalS: 1, out: f('stem-voice.wav') });
    const stem = await probe(f('stem-voice.wav'));
    assert.doesNotMatch(JSON.stringify(stem), BANNED, JSON.stringify(stem));
    await ff.mixAudio({ voice: [], music: [], sfx: [], totalS: 1, out: f('stem-silent.wav') });
    assert.doesNotMatch(JSON.stringify(await probe(f('stem-silent.wav'))), BANNED);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('every delivered encode uses the metadata scrub', () => {
  const v = ff.videoMetadata('X');
  for (const flag of ['-map_metadata', '-1', '+bitexact', 'comment=PG1 Studio', 'encoder=PG1 Studio', 'title=X']) assert.ok(v.includes(flag), flag);
  assert.deepEqual([...ff.AUDIO_METADATA], ['-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact']);
});
