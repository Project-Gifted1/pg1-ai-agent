/**
 * The master spec shared by /film and /movie (lib/film/ffmpeg.mjs), and the
 * three faults of the 854x480, 69 kb/s film:
 *
 *  - the size table: no row below the sources; preview at 1080p; the frame
 *    from the probed sources (1920x1080 when they deliver it, never lower);
 *  - the encode: H.264 High, CRF 18, a bitrate floor (8 Mb/s at 1080p,
 *    scaled below it), 24 fps, AAC 256k stereo;
 *  - no freeze padding: a short clip is never held on its last frame;
 *  - audio covers the runtime: the mix pads from 0, a short bed is played
 *    again to cover its section, a missing bed is covered by its neighbour;
 *  - the QC gate (ffprobe, freezedetect, silencedetect, loudness) flags each.
 *
 * Run with: node --test tests/film-master.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import * as ff from '../lib/film/ffmpeg.mjs';
import { planCuts, coverMusic } from '../lib/film/cuts.mjs';
import { normaliseTimeline } from '../lib/film/storyboard.mjs';

const HAS_FFMPEG = await ff.hasFfmpeg();
const NO_FF = HAS_FFMPEG ? false : 'ffmpeg is not installed';
const fmpeg = (args) => ff.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

describe('the master spec', () => {
  test('no size row below 720p, the preview at 1080p; the frame follows the sources and is never lower', () => {
    for (const [k, s] of Object.entries(ff.FILM_SIZES)) {
      assert.ok(s.height >= 720 && s.width >= 1280, `${k} is ${s.width}x${s.height}`);
      assert.equal(s.crf, 18);
    }
    assert.deepEqual([ff.FILM_SIZES.preview.width, ff.FILM_SIZES.preview.height], [1920, 1080]);
    const size = (src) => { const s = ff.masterSizeFor(src); return `${s.width}x${s.height}`; };
    assert.equal(size([]), '1920x1080', 'stills and cards are 1080p sources');
    assert.equal(size([{ width: 1280, height: 720 }]), '1280x720', 'the source frame, never upscaled past what the engine gave');
    assert.equal(size([{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]), '1920x1080', 'never below any source');
    assert.equal(size([{ width: 3840, height: 2160 }]), '1920x1080');
    assert.equal(ff.minVideoKbps({ width: 1920, height: 1080 }), 8000);
    assert.equal(ff.minVideoKbps({ width: 1280, height: 720 }), 3556);
    const args = ff.masterVideoArgs({ width: 1920, height: 1080 }).join(' ');
    assert.match(args, /-profile:v high .*-crf 18 .*-r 24/);
    assert.match(ff.masterVideoArgs({ width: 1920, height: 1080 }, { floorKbps: 8400 }).join(' '), /-b:v 8400k -minrate 8400k .*nal-hrd=cbr/);
    assert.deepEqual([...ff.MASTER_AUDIO_ARGS], ['-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2']);
  });

  test('a quiet 1080p film still clears the bitrate floor; High profile, 24 fps, AAC 256k stereo', { skip: NO_FF }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'master-'));
    try {
      const v = path.join(dir, 'v.mp4');
      const a = path.join(dir, 'a.wav');
      // Low motion: CRF 18 alone would come in far under 8 Mb/s.
      await fmpeg(['-f', 'lavfi', '-i', `${ff.cardSource({ width: 1920, height: 1080 }, 3)}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', v]);
      await fmpeg(['-f', 'lavfi', '-i', 'sine=f=440:d=3', '-ac', '2', '-ar', '48000', a]);
      const out = await ff.finalEncode({ video: v, audio: a, out: path.join(dir, 'm.mp4'), size: { width: 1920, height: 1080 }, title: 'T', totalS: 3, cwd: dir });
      const p = await ff.probeMedia(out);
      assert.deepEqual([p.width, p.height, p.fps, p.codec, p.profile, p.audioCodec, p.sampleRate, p.channels], [1920, 1080, 24, 'h264', 'High', 'aac', 48000, 2]);
      assert.ok(p.videoKbps >= 8000, `${p.videoKbps} kb/s`);
      assert.ok(p.audioKbps >= 240, `${p.audioKbps} kb/s`);
      assert.deepEqual(ff.checkMasterSpec(p, { width: 1920, height: 1080 }), []);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('no freeze padding', () => {
  test('a clip shorter than its shot is cut short, never held on its last frame', { skip: NO_FF }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nopad-'));
    try {
      const clip = path.join(dir, 'c.mp4');
      await fmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip]);
      const seg = await ff.segmentFromClip(clip, { inS: 0, durationS: 5, clipS: 2, out: path.join(dir, 's.mp4'), size: { width: 640, height: 360, crf: 18, preset: 'medium' }, grade: 'neutral' });
      assert.ok(Math.abs((await ff.probeDuration(seg)) - 2) < 0.1, 'two seconds of picture, not five');
      assert.deepEqual(await ff.detectFreezes(seg), []);
      assert.equal(ff.clipSegmentSeconds({ inS: 1, durationS: 5, clipS: 4 }), 3);
      // The still path drifts, never holds: the "static" move still moves.
      assert.match(ff.kenBurns('static', 48, 640, 360), /z='1\.02\+0\.03\*on\/47'/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('the cut plan never makes a shot longer than its clip', () => {
    const t = normaliseTimeline({
      title: 'T', tier: 'standard', style: { look: 'x', grade: 'neutral' }, characters: [], captions: { enabled: false }, title_card: null, end_card: null,
      scenes: [{ id: 's1', music: { mood: 'm', bpm: 90 }, shots: [{ id: 'a', duration_s: 8, camera: 'static', description: 'a', visual_prompt: 'a', voiceover: '' }] }]
    });
    const plan = planCuts(t, { voice: {}, clips: { a: { durationS: 5, bestStartS: 0 } } });
    assert.equal(plan.segments[0].durationS, 5);
  });
});

describe('audio covers the runtime', () => {
  test('a short bed is played again to fill its section; a missing one is covered by its neighbour', () => {
    const f = ff.mixFilter({ voice: [], music: [{ file: 'm', startS: 0, endS: 20, bedS: 6 }], totalS: 20 });
    assert.match(f, /aloop=loop=4:size=288000,atrim=0:20\.000/);
    assert.match(f, /asetpts=N\/SR\/TB,apad=whole_dur=20\.000/);
    const cues = [{ sceneId: 's1', startS: 0, endS: 10 }, { sceneId: 's2', startS: 10, endS: 18 }, { sceneId: 's3', startS: 18, endS: 30 }];
    assert.deepEqual(coverMusic(cues, new Set(['s1', 's3'])), [{ sceneId: 's1', startS: 0, endS: 18 }, { sceneId: 's3', startS: 18, endS: 30 }]);
    assert.deepEqual(coverMusic(cues, new Set(['s2'])), [{ sceneId: 's2', startS: 0, endS: 30 }]);
  });

  test('a mix whose first sound comes late still runs to the end; a short bed plays to the end', { skip: NO_FF }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cover-'));
    try {
      const vo = path.join(dir, 'vo.wav');
      const bed = path.join(dir, 'bed.wav');
      await fmpeg(['-f', 'lavfi', '-i', 'sine=f=300:d=1.5', vo]);
      await fmpeg(['-f', 'lavfi', '-i', 'anoisesrc=d=4:c=pink:a=0.1', bed]);
      // A voice line at 3 s and nothing else (the old preview's shape): the
      // track is as long as the film.
      const only = await ff.mixAudio({ voice: [{ file: vo, atS: 3 }], music: [], totalS: 12, out: path.join(dir, 'm1.wav') });
      assert.ok(Math.abs((await ff.probeDuration(only)) - 12) < 0.02);
      const both = await ff.mixAudio({ voice: [{ file: vo, atS: 3 }], music: [{ file: bed, startS: 0, endS: 12, bedS: 4 }], totalS: 12, out: path.join(dir, 'm2.wav') });
      assert.deepEqual(await ff.detectSilences(both, { totalS: 12 }), [], 'the 4 s bed covers all 12 s');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('the QC gate', () => {
  test('it flags the old master: 854x480, a starved bitrate, a held frame and a silent end', { skip: NO_FF }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gate-'));
    try {
      const bad = path.join(dir, 'bad.mp4');
      // Two seconds of motion, then four held; the sound stops after two.
      await fmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=854x480:r=24:d=2', '-f', 'lavfi', '-i', 'sine=f=440:d=2',
        '-filter_complex', '[0:v]tpad=stop_mode=clone:stop_duration=4[v];[1:a]apad=whole_dur=6[a]', '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac', '-b:a', '64k', bad]);
      const g = await ff.qcGate(bad, { size: { width: 1920, height: 1080 } });
      assert.equal(g.pass, false);
      const checks = g.problems.map((p) => p.check);
      for (const c of ['spec', 'freeze', 'silence', 'loudness']) assert.ok(checks.includes(c), `${c}: ${JSON.stringify(g.problems)}`);
      assert.ok(g.problems.some((p) => /854x480, below 1920x1080/.test(p.detail)));
      assert.ok(g.problems.some((p) => /bitrate .* below 8000/.test(p.detail)));
      assert.ok(g.problems.some((p) => /audio bitrate/.test(p.detail)));
      assert.match(g.freezeLines[0], /^freeze_start: \d/);
      assert.match(g.silenceLines[0], /^silence_start: \d/);
      // A scripted hold is allowed.
      const ok = await ff.qcGate(bad, { size: { width: 854, height: 480 }, scripted: { freezes: [{ startS: 1.5, endS: 6.1 }], silences: [{ startS: 1.9, endS: 6.1 }] } });
      assert.ok(!ok.problems.some((p) => p.check === 'freeze' || p.check === 'silence'));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('freeze and silence logs read as spans; an open span runs to the end', () => {
    const f = ff.parseDetectSpans('[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 2.5\n[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 1.5\n[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 4\nlavfi.freezedetect.freeze_start: 9', 'freeze', 12);
    assert.deepEqual(f, [{ startS: 2.5, endS: 4, durationS: 1.5 }, { startS: 9, endS: 12, durationS: 3 }]);
    const s = ff.parseDetectSpans('[silencedetect @ 0x1] silence_start: -0.001\n[silencedetect @ 0x1] silence_end: 2.4 | silence_duration: 2.4', 'silence', 10);
    assert.deepEqual(s, [{ startS: 0, endS: 2.4, durationS: 2.4 }]);
    assert.deepEqual(ff.unscripted(f, [{ startS: 8.9, endS: 12 }]), [f[0]]);
    assert.match(ff.probeLine(ff.parseProbe(JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', profile: 'High', width: 1920, height: 1080, avg_frame_rate: '24/1', bit_rate: '9100000' }, { codec_type: 'audio', codec_name: 'aac', bit_rate: '256000', sample_rate: '48000', channels: 2 }], format: { duration: '61.5' } }))), /^h264 \(High\) 1920x1080 24 fps 9100 kb\/s; aac 256 kb\/s 48000 Hz stereo; 61\.5 s$/);
  });
});
