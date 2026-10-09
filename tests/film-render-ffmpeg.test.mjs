/**
 * PG1 Studio end to end with the real ffmpeg (skipped where ffmpeg is not
 * installed): a storyboard, a preview and a full render through
 * lib/film/pipeline.mjs, with stand-in engines that return real media made
 * by ffmpeg itself, against a real Postgres. Checks the rendered film's
 * length, loudness (about -14 LUFS), captions, metadata (no engine names)
 * and that a shot that fails its check is regenerated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import * as ff from '../lib/film/ffmpeg.mjs';
import { run } from '../lib/film/ffmpeg.mjs';
import { createFilmStore } from '../lib/film/store.mjs';
import { runStoryboard, runRender } from '../lib/film/pipeline.mjs';
import { normWords } from '../lib/film/qc.mjs';
import { UPSTREAM_BRAND_RE } from '../lib/upstreamFailure.mjs';
import { makeFilmDb, filmDbRoutes, routedFetch } from './helpers/filmDb.mjs';

const HAS_FFMPEG = await ff.hasFfmpeg();

const STORYBOARD = {
  title: 'Test Reel', logline: 'Colour bars at dawn.', tier: 'draft',
  style: { look: 'clean', grade: 'teal_orange', reference_prompt: 'bars' },
  characters: [], captions: { enabled: true }, title_card: { text: 'Test Reel', duration_s: 2 }, end_card: { text: 'The End', duration_s: 2 },
  scenes: [
    { id: 's1', title: 'Opening', title_card: true, music: { mood: 'tone', bpm: 120 }, shots: [
      { id: 's1-sh1', duration_s: 4, camera: 'push_in', description: 'bars push in', visual_prompt: 'colour bars', voiceover: 'Here is the first line.', transition: 'dissolve' },
      { id: 's1-sh2', duration_s: 3, camera: 'pan_left', description: 'bars pan', visual_prompt: 'more bars', voiceover: '', transition: 'cut', continuous: true }
    ] },
    { id: 's2', title: 'Close', music: { mood: 'tone two', bpm: 100 }, shots: [
      { id: 's2-sh1', duration_s: 3, camera: 'static', description: 'mandelbrot', visual_prompt: 'fractal', voiceover: 'And the second.', transition: 'cut' }
    ] }
  ]
};

async function media(dir) {
  const f = (n) => path.join(dir, n);
  await run('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=1344x768', '-frames:v', '1', f('still.png')]);
  await run('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=24:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('clip.mp4')]);
  await run('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=30:c=pink:a=0.1', '-ar', '48000', '-ac', '2', f('music.wav')]);
  await run('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=300:d=1.6', '-ar', '44100', '-ac', '1', f('voice.wav')]);
  return { still: await readFile(f('still.png')), clip: await readFile(f('clip.mp4')), music: await readFile(f('music.wav')), voice: await readFile(f('voice.wav')) };
}

test('a film renders end to end with ffmpeg', { skip: !HAS_FFMPEG && 'ffmpeg is not installed', timeout: 300000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'film-e2e-'));
  try {
    const m = await media(dir);
    const calls = [];
    let qcFirst = true;
    const engines = {
      still: async () => { calls.push('still'); return m.still; },
      clip: async () => { calls.push('clip'); return m.clip; },
      music: async () => { calls.push('music'); return { bytes: m.music, ext: 'wav', mime: 'audio/wav' }; },
      voice: async ({ text }) => { calls.push('voice'); return { wav: m.voice, durationS: 1.6, words: normWords(text).map((w, i) => ({ word: w, start: i * 0.3, end: i * 0.3 + 0.25 })) }; },
      image: (b) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(b).toString('base64') } }),
      think: async ({ system, content }) => {
        if (system.includes('storyboard artist')) return { text: JSON.stringify(STORYBOARD) };
        calls.push('qc');
        assert.ok(content.filter((c) => c.type === 'image').length >= 5, 'reference plus four frames');
        if (qcFirst) { qcFirst = false; return { text: '{"pass":false,"score":2,"issues":[{"type":"artifact","detail":"smear"}],"best_start_s":0.5,"description":"x"}' }; }
        return { text: '{"pass":true,"score":9,"issues":[],"best_start_s":0.5,"description":"Colour bars"}' };
      },
      transcribe: async () => ({ text: '', words: [] })
    };
    const db = await makeFilmDb();
    const vault = new Map();
    const store = createFilmStore({ supUrl: 'https://supabase.test', supKey: 'k', fetchImpl: routedFetch(filmDbRoutes(db, vault)) });
    let p = await store.createProject({ request: 'test reel', tier: 'draft', capUsd: 20, status: 'storyboarding' });
    await runStoryboard({ project: p, store, engines, ff, workdir: path.join(dir, 'sb') });
    p = await store.getProject(p.id);

    const preview = await runRender({ project: p, stage: 'preview', store, engines, ff, workdir: path.join(dir, 'pre') });
    const prevFile = path.join(dir, 'preview.mp4');
    await writeFile(prevFile, vault.get(preview.path));
    assert.ok(Math.abs((await ff.probeDuration(prevFile)) - preview.plan.totalS) < 0.2);

    const full = await runRender({ project: p, stage: 'full', store, engines, ff, workdir: path.join(dir, 'full') });
    assert.equal(calls.filter((c) => c === 'clip').length, 4, 'three shots plus one retry of the shot that failed its check');
    const out = path.join(dir, 'final.mp4');
    await writeFile(out, vault.get(full.path));
    const dur = await ff.probeDuration(out);
    assert.ok(Math.abs(dur - full.plan.totalS) < 0.2, `length ${dur} vs plan ${full.plan.totalS}`);
    const loud = await ff.measureLoudness(out);
    assert.ok(Math.abs(Number(loud.input_i) + 14) < 1, `loudness ${loud.input_i}`);
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'json', out]);
    assert.doesNotMatch(stdout, UPSTREAM_BRAND_RE);
    assert.doesNotMatch(stdout, /Lavf|Lavc/i);
    assert.match(stdout, /PG1 Studio/);
    assert.equal(full.qcReport.generated.retries, 1);
    assert.equal(full.qcReport.flagged.length, 0);
    assert.ok(full.plan.captions.some((c) => /first line/.test(c.text)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
