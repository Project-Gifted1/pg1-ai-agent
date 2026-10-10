/**
 * PG1 Studio: images attached to /film used as fixed brand assets
 * (lib/film/attachments.mjs). An attached image is checked and stored (vault
 * + pg1_film_assets, kind 'reference', meta.source 'attachment'), offered
 * to the storyboard, placed by a shot as it is (shot.asset), rendered by
 * ffmpeg letterboxed with no grade in the preview and the full render,
 * never sent to an image or video engine, checked against the source
 * instead of regenerated, and listed as "Your image". A /film with no
 * attachment is exactly as before.
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { UPSTREAM_BRAND_RE } from '../lib/upstreamFailure.mjs';
import {
  sniffImage, validateFilmAttachments, attachmentWording, wantsUnaltered, wantsEndCard, storeFilmAttachments, listFilmAttachments, MAX_FILM_ATTACHMENTS
} from '../lib/film/attachments.mjs';
import {
  normaliseTimeline, flatShots, placeAttachments, timelineSummary, storyboardUserPrompt, storyboardSystem, STORYBOARD_SYSTEM, STORYBOARD_ATTACHMENT_RULES
} from '../lib/film/storyboard.mjs';
import { applyTimelineEdits, assetFingerprints, missingAssets } from '../lib/film/timeline.mjs';
import { estimateStage } from '../lib/film/cost.mjs';
import { planCuts } from '../lib/film/cuts.mjs';
import { createFilmStore } from '../lib/film/store.mjs';
import { runStoryboard, runRender } from '../lib/film/pipeline.mjs';
import { filmCard } from '../lib/film/chat.mjs';
import * as realFf from '../lib/film/ffmpeg.mjs';
import { normWords } from '../lib/film/qc.mjs';
import { makeFilmDb, filmDbRoutes, routedFetch, json } from './helpers/filmDb.mjs';

const SUP_URL = 'https://supabase.test';
const SECRET = 'film-render-secret-0123456789abcdef';
const HAS_FFMPEG = await realFf.hasFfmpeg();

// --- image fixtures (real PNGs, readable by ffmpeg) -----------------------------------

function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// A PNG of width×height whose pixel colour is px(x, y) -> [r, g, b].
function png(width, height, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) raw.set(px(x, y), y * (width * 3 + 1) + 1 + x * 3);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const RED = [228, 0, 43];
const BLUE = [0, 87, 184];
const YELLOW = [255, 209, 0];
// A 3:1 "logo": red, with a blue block on the left and a yellow one on the right.
const LOGO = png(300, 100, (x, y) => (x >= 20 && x < 120 && y >= 20 && y < 80 ? BLUE : x >= 160 && x < 280 && y >= 30 && y < 70 ? YELLOW : RED));
const TALL = png(100, 200, (x, y) => (y < 100 ? BLUE : YELLOW));
function jpegHeader(w, h) {
  // SOI, an APP0 segment, then SOF0 with the size: enough for the header read.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
function webpHeader(w, h, flags = 0) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(22, 4); b.write('WEBP', 8, 'ascii'); b.write('VP8X', 12, 'ascii'); b.writeUInt32LE(10, 16);
  b[20] = flags;
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
}
const part = (bytes, mimeType, name) => ({ inlineData: { mimeType, data: Buffer.from(bytes).toString('base64') }, ...(name ? { name } : {}) });

// --- the storyboard the stand-in model writes ----------------------------------------

function storyboardJson({ withAsset = true, endCard = null } = {}) {
  return {
    title: 'Harbour Coffee', logline: 'Morning at the roastery.', tier: 'standard',
    style: { look: 'warm morning light, 35mm', grade: 'teal_orange', reference_prompt: 'a barista in a green apron' },
    characters: [{ id: 'c1', name: 'Ana', description: 'barista, green apron' }],
    captions: { enabled: true }, title_card: { text: 'Harbour Coffee', duration_s: 3 }, end_card: endCard,
    scenes: [
      { id: 's1', title: 'Roast', music: { mood: 'warm acoustic', bpm: 90 }, shots: [
        { id: 's1-sh1', duration_s: 6, camera: 'push_in', description: 'beans in the roaster', visual_prompt: 'Coffee beans tumbling in a drum roaster', voiceover: 'It starts with the bean.', transition: 'cut', characters: [] },
        { id: 's1-sh2', duration_s: 5, camera: 'tracking', description: 'Ana pours', visual_prompt: 'Ana pours a flat white', voiceover: '', transition: 'dissolve', characters: ['c1'] }
      ] },
      { id: 's2', title: 'Close', music: { mood: 'warm acoustic outro', bpm: 90 }, shots: [
        { id: 's2-sh1', duration_s: 5, camera: 'static', description: 'cup on the counter', visual_prompt: 'A cup on a wooden counter', voiceover: 'Harbour Coffee.', transition: 'dissolve', characters: [] },
        ...(withAsset ? [{ id: 's2-logo', duration_s: 4, description: 'your logo end card', visual_prompt: 'the Harbour Coffee logo', voiceover: '', transition: 'cut', continuous: true, asset: { attachment: 1, mode: 'hold' } }] : [])
      ] }
    ]
  };
}

const ATT = (extra = {}) => ({ index: 1, asset_id: '11111111-2222-4333-8444-555555555555', width: 300, height: 100, mime: 'image/png', note: 'Use the attached logo unaltered as the end card.', exact: true, end_card: true, ...extra });

// --- stand-ins -----------------------------------------------------------------------

function fakeFf(log = [], { match = true } = {}) {
  const touch = async (f, what) => { log.push(what); await writeFile(f, what); return f; };
  return {
    FILM_SIZES: realFf.FILM_SIZES, TARGET_LUFS: realFf.TARGET_LUFS, buildAss: realFf.buildAss, writeText: realFf.writeText,
    probeDuration: async () => 10,
    extractFrame: (i, t, out) => touch(out, 'frame'),
    extractLastFrame: (i, out) => touch(out, 'last'),
    thumbnail: (i, t, out) => touch(out, 'thumb'),
    segmentFromStill: (s, o) => touch(o.out, `still-seg ${o.camera} ${o.grade}`),
    segmentFromClip: (c, o) => touch(o.out, `clip-seg ${o.grade}`),
    segmentFromImage: (img, o) => touch(o.out, `image-seg ${path.basename(img)} ${o.mode} grade=${o.grade === undefined ? 'off' : o.grade}`),
    matchImageSegment: async (seg, img, o) => { log.push(`match ${path.basename(img)} ${o.mode}`); return { pass: match, similarity: match ? 0.99 : 0.6, frames: [] }; },
    segmentCard: (o) => touch(o.out, 'card'),
    joinSegments: (files, d, j, out) => touch(out, `join ${files.length}`),
    mixAudio: (o) => touch(o.out, `mix ${o.voice.length} ${o.music.length}`),
    normaliseLoudness: async (i, out) => { await touch(out, 'loud'); return { file: out, measured: { input_i: '-22' }, after: { input_i: '-14.0' } }; },
    finalEncode: (o) => touch(o.out, 'final'),
    extractAudioForCheck: (i, out) => touch(out, 'wav')
  };
}

// Every generation engine call is recorded with its prompt, so a test can
// show the attached image's shot never reached one.
function fakeEngines({ storyboard = storyboardJson(), calls = [], seen = {} } = {}) {
  return {
    calls,
    still: async ({ prompt }) => { calls.push(['still', prompt]); return Buffer.from('png'); },
    clip: async ({ prompt }) => { calls.push(['clip', prompt]); return Buffer.from('mp4'); },
    music: async ({ mood }) => { calls.push(['music', mood]); return { bytes: Buffer.from('wav'), ext: 'wav', mime: 'audio/wav' }; },
    voice: async ({ text }) => { calls.push(['voice', text]); return { wav: Buffer.from('wav'), durationS: 1.5, words: normWords(text).map((w, i) => ({ word: w, start: i * 0.3, end: i * 0.3 + 0.25 })) }; },
    image: (b) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(b).toString('base64') } }),
    think: async ({ system, content }) => {
      if (system.includes('storyboard artist')) { seen.system = system; seen.content = content; calls.push(['storyboard']); return { text: JSON.stringify(storyboard) }; }
      const text = content[content.length - 1].text;
      calls.push(['qc', /^Shot \d+\.\d+: (.+)$/m.exec(text)[1]]);
      return { text: '{"pass":true,"score":8,"issues":[],"best_start_s":0.5,"description":"ok"}' };
    },
    transcribe: async () => ({ text: '', words: [] })
  };
}

const workdir = () => path.join(os.tmpdir(), `film-att-${Math.random().toString(36).slice(2)}`);

// --- checking what was attached ------------------------------------------------------

describe('attachment checks', () => {
  test('PNG, JPEG and WebP are read from their own bytes, with their size', () => {
    assert.deepEqual(sniffImage(LOGO), { mime: 'image/png', width: 300, height: 100 });
    assert.deepEqual(sniffImage(jpegHeader(1920, 1080)), { mime: 'image/jpeg', width: 1920, height: 1080 });
    assert.deepEqual(sniffImage(webpHeader(640, 480)), { mime: 'image/webp', width: 640, height: 480 });
    assert.equal(sniffImage(Buffer.from('GIF89a......')), null);
    assert.equal(sniffImage(Buffer.from('%PDF-1.7')), null);
  });

  test('a good set is accepted in order; anything else is refused with a clear reason and nothing else happens', () => {
    const ok = validateFilmAttachments([part(LOGO, 'image/png', 'logo.png'), part(jpegHeader(800, 600), 'image/jpg'), part(webpHeader(400, 400), 'image/webp')]);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.images.map((i) => [i.n, i.mime, i.width, i.height]), [[1, 'image/png', 300, 100], [2, 'image/jpeg', 800, 600], [3, 'image/webp', 400, 400]]);
    assert.deepEqual(validateFilmAttachments([]), { ok: true, images: [] });

    const gif = validateFilmAttachments([part(Buffer.from('GIF89a'), 'image/gif', 'anim.gif')]);
    assert.equal(gif.ok, false);
    assert.match(gif.message, /"anim\.gif" is a image\/gif file, not a PNG, JPEG or WebP image\. .*Nothing was created or spent\./);
    assert.match(validateFilmAttachments([part(Buffer.from('%PDF-1.7'), 'application/pdf')]).message, /attachment 1 is a application\/pdf file/);
    assert.match(validateFilmAttachments([part(Buffer.from('not really a png'), 'image/png')]).message, /not a readable PNG, JPEG or WebP image/);
    const big = Buffer.concat([LOGO, Buffer.alloc(4.5 * 1024 * 1024)]);
    assert.match(validateFilmAttachments([part(big, 'image/png', 'huge.png')]).message, /"huge\.png" is larger than 4 MB/);
    assert.match(validateFilmAttachments([part(png(8, 8, () => RED), 'image/png')]).message, /8×8 px/);
    assert.match(validateFilmAttachments([part(webpHeader(400, 400, 0x02), 'image/webp', 'spin.webp')]).message, /"spin\.webp" is an animated image; attach a still\./);
    assert.match(validateFilmAttachments(Array.from({ length: MAX_FILM_ATTACHMENTS + 1 }, () => part(LOGO, 'image/png'))).message, /at most 4 per message/);
  });

  test('the operator\'s words about the images, and whether to use them as they are', () => {
    const req = 'A 60 second film about our roastery. Warm morning light. Use the attached logo unaltered as the end card.';
    assert.equal(attachmentWording(req), 'Use the attached logo unaltered as the end card.');
    assert.equal(wantsUnaltered(req), true);
    assert.equal(wantsEndCard(req), true);
    assert.equal(wantsUnaltered('a film about bees, in the style of the attached photo'), false);
    assert.equal(wantsUnaltered("put my logo at the end, don't change it"), true);
  });
});

// --- storyboard --------------------------------------------------------------------------

describe('storyboard with an attached image', () => {
  test('a shot can show the image: it has no prompt, is never continuous, and neither is the shot after it', () => {
    const raw = storyboardJson();
    raw.scenes[1].shots.push({ id: 's2-after', duration_s: 4, visual_prompt: 'steam', continuous: true });
    const t = normaliseTimeline({ ...raw, attachments: [ATT()] });
    const logo = flatShots(t).find((x) => x.shot.id === 's2-logo').shot;
    assert.deepEqual(logo.asset, { attachment: 1, mode: 'hold' });
    assert.equal(logo.visual_prompt, '', 'nothing to generate');
    assert.equal(logo.camera, 'static');
    assert.equal(logo.continuous, false);
    assert.equal(flatShots(t).find((x) => x.shot.id === 's2-after').shot.continuous, false);
    assert.equal(t.attachments.length, 1);
    assert.match(timelineSummary(t), /2\.2 your logo end card \(Your image 1, held, 4 s\)/);

    const warnings = [];
    const bad = normaliseTimeline({ ...storyboardJson(), attachments: [] }, { warnings });
    assert.equal(flatShots(bad).find((x) => x.shot.id === 's2-logo').shot.asset, undefined, 'no such image: an ordinary shot');
    assert.ok(warnings.some((w) => /attached image that does not exist/.test(w)));
  });

  test('the storyboard model is told which images exist, their size and the operator\'s words', () => {
    const atts = [ATT()];
    const system = storyboardSystem({ attachments: atts });
    assert.ok(system.startsWith(STORYBOARD_SYSTEM));
    assert.ok(system.endsWith(STORYBOARD_ATTACHMENT_RULES));
    assert.match(system, /"asset":\{"attachment":<index>,"mode":"hold"\|"push_in"\}/);
    assert.match(system, /you MUST place it with an asset shot. Never describe it in a visual_prompt/);
    const user = storyboardUserPrompt('a film', { attachments: atts });
    assert.match(user, /<attachments>\n\{"attachment":1,"width":300,"height":100,"type":"png","operator_words":"Use the attached logo unaltered as the end card\.","use_unaltered":true,"end_card":true\}\n<\/attachments>/);
    assert.match(user, /give each one an asset shot/);
  });

  test('an image the request says to use as it is always gets its own shot, in place of a text end card', () => {
    const t = normaliseTimeline({ ...storyboardJson({ withAsset: false, endCard: { text: 'Harbour Coffee' } }), attachments: [ATT()] });
    assert.equal(flatShots(t).some((x) => x.shot.asset), false, 'the model forgot it');
    const { timeline, placed } = placeAttachments(t);
    assert.deepEqual(placed, [1]);
    const last = flatShots(timeline).pop();
    assert.deepEqual(last.shot.asset, { attachment: 1, mode: 'hold' });
    assert.equal(last.shot.visual_prompt, '');
    assert.equal(timeline.end_card, null);
    assert.deepEqual(placeAttachments(timeline).placed, [], 'never twice');
    const loose = normaliseTimeline({ ...storyboardJson({ withAsset: false }), attachments: [ATT({ exact: false })] });
    assert.deepEqual(placeAttachments(loose).placed, [], 'not asked to be used as it is');
  });

  test('nothing is generated or charged for the image\'s shot', () => {
    const t = normaliseTimeline({ ...storyboardJson(), attachments: [ATT()] });
    const fp = assetFingerprints(t, { voiceKey: 'v' });
    assert.equal(fp.keyframes['s2-logo'], undefined);
    assert.equal(fp.clips['s2-logo'], undefined);
    const full = missingAssets(t, new Set(), { stage: 'full', voiceKey: 'v' });
    assert.ok(!full.keyframes.includes('s2-logo') && !full.clips.includes('s2-logo'));
    assert.equal(estimateStage(t, { stage: 'full' }).missing.clips.length, 3);
    const plan = planCuts(t, { voice: {}, clips: {} });
    assert.deepEqual(plan.segments.find((s) => s.shotId === 's2-logo').asset, { attachment: 1, mode: 'hold' });
  });

  test('edits can place an image, swap its mode, or generate the shot instead', () => {
    const t = normaliseTimeline({ ...storyboardJson({ withAsset: false }), attachments: [ATT()] });
    const a = applyTimelineEdits(t, [{ op: 'set_asset', shot: '2.1', attachment: 1, mode: 'push_in' }]);
    assert.deepEqual(a.timeline.scenes[1].shots[0].asset, { attachment: 1, mode: 'push_in' });
    assert.equal(a.timeline.scenes[1].shots[0].visual_prompt, '');
    assert.match(a.changes[0], /Your image 1, placed unaltered \(slow push-in\)/);
    const b = applyTimelineEdits(a.timeline, [{ op: 'set_asset', shot: '2.1', attachment: null, visual_prompt: 'A cup on a counter' }]);
    assert.equal(b.timeline.scenes[1].shots[0].asset, undefined);
    const c = applyTimelineEdits(t, [{ op: 'add_shot', scene: 2, shot: { description: 'logo', asset: { attachment: 1 } } }]);
    assert.deepEqual(flatShots(c.timeline).pop().shot.asset, { attachment: 1, mode: 'hold' });
    assert.throws(() => applyTimelineEdits(t, [{ op: 'set_asset', shot: '2.1', attachment: 7 }]), /no attached image 7/);
  });
});

// --- capture, storyboard and render against a real Postgres ---------------------------

describe('render worker with an attached image', () => {
  let db;
  let vault;
  let fetchImpl;
  let store;
  beforeEach(async () => {
    db = await makeFilmDb();
    vault = new Map();
    fetchImpl = routedFetch(filmDbRoutes(db, vault));
    store = createFilmStore({ supUrl: SUP_URL, supKey: 'service-key', fetchImpl });
  });

  async function filmWithLogo(request = 'A film about our roastery. Use the attached logo unaltered as the end card.') {
    const p = await store.createProject({ request, capUsd: 30, status: 'storyboarding' });
    const { images } = validateFilmAttachments([part(LOGO, 'image/png', 'logo.png')]);
    const stored = await storeFilmAttachments({ store, projectId: p.id, images, request });
    return { p, stored };
  }

  test('the attachment is stored in the vault and the media library as a reference with its index', async () => {
    const { p, stored } = await filmWithLogo();
    const rows = (await db.query('select * from pg1_film_assets where project_id = $1', [p.id])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'reference');
    assert.equal(rows[0].meta.source, 'attachment');
    assert.equal(rows[0].meta.index, 1);
    assert.equal(rows[0].meta.width, 300);
    assert.equal(rows[0].mime_type, 'image/png');
    assert.match(rows[0].storage_path, new RegExp(`^films/${p.id}/attachments/attachment-1-[0-9a-f]{12}\\.png$`));
    assert.deepEqual(vault.get(rows[0].storage_path), LOGO, 'the original bytes, unaltered');
    assert.equal(rows[0].fingerprint, null, 'never mistaken for a generated reference still');
    assert.deepEqual(stored.map((a) => [a.index, a.asset_id]), [[1, rows[0].id]]);
    assert.deepEqual(await listFilmAttachments(store, p.id), stored);
  });

  test('storyboard -> preview -> full: the image is a shot of its own, placed by ffmpeg, never sent to an engine, checked not regenerated', async () => {
    const { p: p0, stored } = await filmWithLogo();
    const seen = {};
    const engines = fakeEngines({ seen });
    await runStoryboard({ project: p0, store, engines, ff: fakeFf(), workdir: workdir(), attachments: stored });
    let p = await store.getProject(p0.id);
    assert.match(seen.content, /"attachment":1,"width":300,"height":100/, 'the storyboard step got the attachment');
    assert.match(seen.system, /asset shot/);
    const logo = flatShots(p.timeline).find((x) => x.shot.asset);
    assert.equal(logo.shot.id, 's2-logo');
    assert.equal(p.timeline.attachments[0].asset_id, stored[0].asset_id);

    // Preview.
    await store.updateProject(p.id, { status: 'preview_rendering' });
    p = await store.getProject(p.id);
    const preLog = [];
    const pre = await runRender({ project: p, stage: 'preview', store, engines, ff: fakeFf(preLog), workdir: workdir() });
    assert.deepEqual(preLog.filter((l) => l.startsWith('image-seg')), ['image-seg attachment-1.png hold grade=off'], 'the preview includes the image, with no grade');
    assert.ok(preLog.includes('match attachment-1.png hold'));
    assert.equal(preLog.filter((l) => l.startsWith('still-seg')).length, 3, 'the other shots are stills as before');
    assert.ok(preLog.filter((l) => l.startsWith('still-seg')).every((l) => l.endsWith('teal_orange')), 'the grade stays on for generated shots');
    assert.equal(engines.calls.filter((c) => c[0] === 'still').length, 1 + 3, 'reference + the three generated shots only');
    assert.ok(!engines.calls.some((c) => (c[0] === 'still' || c[0] === 'clip') && /logo/i.test(c[1])), 'the image was never described to an engine');
    assert.deepEqual(pre.qcReport.attachments.map((a) => [a.shotId, a.attachment, a.pass, a.label]), [['s2-logo', 1, true, 'Your image']]);

    // Full.
    engines.calls.length = 0;
    await store.updateProject(p.id, { status: 'full_rendering' });
    p = await store.getProject(p.id);
    const fullLog = [];
    const full = await runRender({ project: p, stage: 'full', store, engines, ff: fakeFf(fullLog), workdir: workdir() });
    assert.deepEqual(fullLog.filter((l) => l.startsWith('image-seg')), ['image-seg attachment-1.png hold grade=off'], 'the full render includes the image');
    assert.equal(fullLog.filter((l) => l.startsWith('clip-seg')).length, 3);
    assert.equal(engines.calls.filter((c) => c[0] === 'clip').length, 3, 'a clip for each generated shot, none for the image');
    assert.equal(engines.calls.filter((c) => c[0] === 'qc').length, 3, 'no generated-shot check for the image');
    const shotQc = full.qcReport.shots.find((s) => s.shotId === 's2-logo');
    assert.deepEqual([shotQc.engine, shotQc.attempts, shotQc.pass, shotQc.attachment], ['Your image', 0, true, 1]);
    assert.equal(full.qcReport.generated.retries, 0);
    assert.equal(full.qcReport.engines['Your image'], undefined, 'not counted as an engine');
    const clips = await store.listAssets(p.id, { kinds: ['clip'] });
    assert.ok(!clips.some((c) => c.shot_id === 's2-logo'));
  });

  test('a rendered image shot that does not match is flagged, never regenerated', async () => {
    const { p: p0 } = await filmWithLogo();
    const engines = fakeEngines();
    await runStoryboard({ project: p0, store, engines, ff: fakeFf(), workdir: workdir() });
    const p = await store.getProject(p0.id);
    engines.calls.length = 0;
    const log = [];
    const full = await runRender({ project: p, stage: 'full', store, engines, ff: fakeFf(log, { match: false }), workdir: workdir() });
    assert.deepEqual(full.qcReport.flagged, ['s2-logo']);
    assert.equal(log.filter((l) => l.startsWith('image-seg')).length, 1, 'placed once, not again');
    assert.equal(engines.calls.filter((c) => c[0] === 'clip').length, 3);
    assert.equal(engines.calls.filter((c) => c[0] === 'still').length, 1 + 3);
    assert.match(full.qcReport.shots.find((s) => s.shotId === 's2-logo').issues[0].detail, /differ from your image 1/);
  });

  test('when the model leaves the image out, it is placed anyway', async () => {
    const { p: p0 } = await filmWithLogo();
    const engines = fakeEngines({ storyboard: storyboardJson({ withAsset: false, endCard: { text: 'Harbour Coffee' } }) });
    const sb = await runStoryboard({ project: p0, store, engines, ff: fakeFf(), workdir: workdir() });
    const last = flatShots(sb.timeline).pop();
    assert.deepEqual(last.shot.asset, { attachment: 1, mode: 'hold' });
    assert.equal(sb.timeline.end_card, null);
    assert.ok(sb.warnings.some((w) => /Your image 1 was placed as its own shot at the end/.test(w)));
  });

  test('the card and status list the attachment as "Your image"', async () => {
    const { p: p0, stored } = await filmWithLogo();
    const before = await filmCard(store, { ...p0, status: 'storyboard_queued' });
    assert.deepEqual(before.yourImages.map((i) => [i.label, i.used]), [['Your image 1', null]]);
    const engines = fakeEngines();
    await runStoryboard({ project: p0, store, engines, ff: fakeFf(), workdir: workdir(), attachments: stored });
    const p = await store.getProject(p0.id);
    const full = await runRender({ project: p, stage: 'full', store, engines, ff: fakeFf(), workdir: workdir() });
    const card = await filmCard(store, { ...p, status: 'done', qc_report: full.qcReport });
    assert.deepEqual(card.yourImages, [{ index: 1, label: 'Your image 1', width: 300, height: 100, shots: ['2.2'], mode: 'hold', used: true, matched: true, similarity: 0.99 }]);
  });
});

// --- the chat ------------------------------------------------------------------------------

describe('/film with attachments in the chat', () => {
  let db;
  let vault;
  let calls;
  let ipSeq = 0;
  const ORIGINAL_ENV = { ...process.env };
  const ORIGINAL_FETCH = globalThis.fetch;
  const makeReq = (body) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.84.0.${++ipSeq}` }, body });
  const makeRes = () => ({
    statusCode: null, headers: {}, jsonBody: null,
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; },
    write() { return true; }, end() { return this; }, on() {}
  });
  const chat = async (body) => { const res = makeRes(); await chatHandler(makeReq(body), res); return res; };
  const authed = (extra) => ({ user: 'test-operator', pass: 'test-secret-pass', ...extra });

  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    process.env.USER_API_KEY = 'test-operator';
    process.env.USER_API_PASS = 'test-secret-pass';
    process.env.SUPABASE_URL = SUP_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-0123456789';
    process.env.PG1_VIDEO_ENABLED = '1';
    process.env.PG1_VIDEO_RENDER_SECRET = SECRET;
    process.env.GITHUB_TOKEN = 'gh-test-token';
    for (const k of ['GEMINI_API_KEY', 'GEMINI_API_KEY1', 'GEMINI_API_KEY2', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'CARTESIA_API_KEY', 'REPLICATE_API_TOKEN', 'PG1_FILM_MAX_USD']) delete process.env[k];
    __clearAuthRateLimitState();
    db = await makeFilmDb();
    vault = new Map();
    calls = [];
    globalThis.fetch = routedFetch([
      ['api.github.com', () => new Response(null, { status: 204 })],
      ['/rest/v1/messages', (u, o) => (o.method === 'POST' ? new Response('', { status: 201 }) : json([]))],
      ['/storage/v1/object/list/pg1-vault', () => json([])],
      ['/rest/v1/threat_indicators', () => json([])],
      ...filmDbRoutes(db, vault)
    ], calls);
  });

  after(() => {
    process.env = { ...ORIGINAL_ENV };
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test('/film with a logo stores it, passes it to the storyboard, and lists it as "Your image"', async () => {
    const res = await chat(authed({ prompt: '/film a 60 second film about our roastery. Use the attached logo unaltered as the end card.', multiFiles: [part(LOGO, 'image/png', 'logo.png')] }));
    const body = res.jsonBody;
    assert.match(body.reply, /PG1 Studio is writing the storyboard/);
    assert.match(body.reply, /Stored with it: Your image 1 \(300×100 PNG\)\. A shot that shows it places the image exactly as it is/);
    assert.doesNotMatch(body.reply, UPSTREAM_BRAND_RE);
    assert.deepEqual(body.filmProject.yourImages.map((i) => [i.label, i.width, i.height, i.used]), [['Your image 1', 300, 100, null]]);
    const id = body.filmProject.id;
    const row = (await db.query("select * from pg1_film_assets where project_id = $1 and kind = 'reference'", [id])).rows[0];
    assert.deepEqual([row.meta.source, row.meta.index, row.meta.exact, row.meta.end_card], ['attachment', 1, true, true]);
    assert.deepEqual(vault.get(row.storage_path), LOGO);
    assert.ok(calls.some((c) => c.method === 'POST' && c.url === `${SUP_URL}/storage/v1/object/pg1-vault/${row.storage_path}`), 'the private pg1-vault bucket');
    assert.equal(calls.find((c) => c.url.includes('api.github.com')).body.inputs.stage, 'storyboard');

    // The polled card still lists it while the storyboard is written.
    const st = await chat(authed({ action: 'FILM_STATUS', filmId: id }));
    assert.equal(st.jsonBody.filmProject.yourImages[0].label, 'Your image 1');

    // The media library lists it with a signed link, like every film file.
    const media = await chat(authed({ prompt: `/film media ${id.slice(0, 8)}` }));
    assert.match(media.jsonBody.reply, /- Your image 1 \(300×100\): Use the attached logo unaltered as the end card\. — \[open\]\(https:\/\/supabase\.test\/storage\/v1\/object\/sign\/pg1-vault\/films\/.+\/attachments\/attachment-1-[0-9a-f]{12}\.png\?token=signed\)/);
    const status = await chat(authed({ prompt: `/film status ${id.slice(0, 8)}` }));
    assert.match(status.jsonBody.reply, /Your image 1: stored, for the storyboard\./);
  });

  test('a bad attachment is refused with a clear message: no film, no upload, no dispatch', async () => {
    const res = await chat(authed({ prompt: '/film a film with my logo', multiFiles: [part(Buffer.from('%PDF-1.7 ...'), 'application/pdf', 'brief.pdf')] }));
    assert.match(res.jsonBody.reply, /PG1 Studio could not use the attachment: "brief\.pdf" is a application\/pdf file, not a PNG, JPEG or WebP image\. Attach PNG, JPEG or WebP images, up to 4 per message and 4 MB each\. Nothing was created or spent\./);
    assert.equal((await db.query('select count(*)::int as n from pg1_film_projects')).rows[0].n, 0);
    assert.equal(calls.filter((c) => c.url.includes('api.github.com') || c.url.includes('/object/pg1-vault/films')).length, 0);
  });

  test('/film edit with an image stores it and places it with the change', async () => {
    const store = createFilmStore({ supUrl: SUP_URL, supKey: 'k', fetchImpl: globalThis.fetch });
    const p0 = await store.createProject({ request: 'roastery', capUsd: 20, status: 'storyboarding' });
    await runStoryboard({ project: p0, store, engines: fakeEngines({ storyboard: storyboardJson({ withAsset: false }) }), ff: fakeFf(), workdir: workdir() });
    const res = await chat(authed({ prompt: `/film edit ${p0.id.slice(0, 8)} [{"op":"set_asset","shot":"2.1","attachment":1,"mode":"push_in"}]`, multiFiles: [part(LOGO, 'image/png')] }));
    assert.match(res.jsonBody.reply, /Stored with this change: Your image 1 \(300×100 PNG\)\./);
    assert.match(res.jsonBody.reply, /Shot 2\.1: Your image 1, placed unaltered \(slow push-in\)/);
    const plan = (await db.query('select plan from pending_actions where token = $1', [res.jsonBody.pendingApproval.token])).rows[0].plan;
    assert.deepEqual(plan.timeline.scenes[1].shots[0].asset, { attachment: 1, mode: 'push_in' });
    assert.equal(plan.timeline.attachments[0].index, 1);
  });

  test('a /film with no attachment behaves exactly as before', async () => {
    const res = await chat(authed({ prompt: '/film a one-minute film about a fisher at dawn' }));
    assert.equal(res.jsonBody.reply, 'PG1 Studio is writing the storyboard for film ' + res.jsonBody.filmProject.shortId + ' (about 0.15 USD). Its scenes, shots and cost estimate appear here for your approval before anything is generated. Spending cap for this film: 20.00 USD.');
    assert.equal(res.jsonBody.filmProject.yourImages, undefined);
    assert.equal((await db.query('select count(*)::int as n from pg1_film_assets')).rows[0].n, 0);
    assert.equal(calls.filter((c) => c.url.includes('/object/pg1-vault/films')).length, 0);
  });
});

// --- exactly as before without attachments --------------------------------------------------

test('without attachments the timeline, fingerprints, estimates, cuts, edits and prompts are unchanged', async () => {
  // The same inputs through the code before this change gave this digest.
  const raw = {
    title: 'Harbour at Dawn', logline: 'A fisher sets out before sunrise.', tier: 'standard',
    style: { look: 'cinematic, cold dawn light, 35mm', grade: 'teal_orange', reference_prompt: 'Mara' },
    characters: [{ id: 'c1', name: 'Mara', description: 'woman, yellow coat' }],
    captions: { enabled: true }, title_card: { text: 'Harbour at Dawn', duration_s: 3 }, end_card: { text: 'Fin', duration_s: 3 },
    scenes: [
      { id: 's1', title: 'The quay', title_card: true, music: { mood: 'piano', bpm: 80 }, shots: [
        { id: 's1-sh1', duration_s: 6, camera: 'drone_flyover', description: 'drone shot', visual_prompt: 'Aerial harbour', voiceover: 'Every morning starts in the dark.', transition: 'cut', characters: [] },
        { id: 's1-sh2', duration_s: 5, camera: 'push_in', description: 'quay', visual_prompt: 'Mara walks', voiceover: '', continuous: true, transition: 'dissolve', characters: ['c1'] }
      ] },
      { id: 's2', title: 'Sea', music: { mood: 'strings', bpm: 96 }, shots: [
        { id: 's2-sh1', duration_s: 7, camera: 'tracking', description: 'boat', visual_prompt: 'Boat leaves', voiceover: 'Twenty years.', transition: 'cut', characters: ['c1'], caption: 'cap' }
      ] }
    ]
  };
  const t = normaliseTimeline(raw);
  assert.equal('attachments' in t, false);
  assert.ok(flatShots(t).every((x) => !('asset' in x.shot)));
  const fp = assetFingerprints(t, { voiceKey: 'v' });
  const est = [estimateStage(t, { stage: 'preview' }), estimateStage(t, { stage: 'full', withStoryboard: true })];
  const plan = planCuts(t, { voice: { 's1-sh1': { durationS: 2.2, words: [] } }, clips: { 's1-sh1': { durationS: 10, bestStartS: 1 } } });
  const edited = applyTimelineEdits(t, [{ op: 'trim', shot: '1.1', duration_s: 4 }, { op: 'add_shot', scene: 2, shot: { visual_prompt: 'x', description: 'y' } }]).timeline;
  edited.scenes[1].shots[1].id = 'fixed';
  const prompts = [STORYBOARD_SYSTEM, storyboardUserPrompt('a film', { tier: 'pro' }), timelineSummary(t)];
  assert.equal(storyboardSystem({ attachments: [] }), STORYBOARD_SYSTEM);
  const digest = crypto.createHash('sha256').update(JSON.stringify({ t, fp, est, plan, edited, prompts })).digest('hex').slice(0, 16);
  assert.equal(digest, '327cc2265d2807c4');
});

// --- real ffmpeg -------------------------------------------------------------------------------

describe('placing an image with ffmpeg', { skip: !HAS_FFMPEG && 'ffmpeg is not installed' }, () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'film-img-')); });
  after(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  // One pixel of a video frame (or image) as [r, g, b].
  async function pixel(file, x, y, atS = 0) {
    const out = path.join(dir, `px-${x}-${y}-${Math.random().toString(36).slice(2)}.rgb`);
    await realFf.run('ffmpeg', ['-loglevel', 'error', '-y', '-ss', String(atS), '-i', file, '-frames:v', '1', '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', out]);
    return [...(await import('node:fs/promises').then((m) => m.readFile(out)))];
  }
  const near = (a, b, tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

  test('a wide logo is letterboxed: whole, centred, not stretched, brand colours kept, no grade', async () => {
    const img = path.join(dir, 'logo.png');
    await writeFile(img, LOGO);
    const size = realFf.FILM_SIZES.standard;
    const seg = path.join(dir, 'hold.mp4');
    await realFf.segmentFromImage(img, { mode: 'hold', durationS: 3, out: seg, size });
    assert.ok(Math.abs((await realFf.probeDuration(seg)) - 3) < 0.1);
    const fit = realFf.letterboxFit(300, 100, 1280, 720);
    assert.deepEqual(fit, { w: 1280, h: 426, x: 0, y: 147 }, '3:1 keeps 3:1 inside 16:9');
    assert.ok(near(await pixel(seg, 640, fit.y - 6, 1), [0, 0, 0]), 'black bar above');
    assert.ok(near(await pixel(seg, 640, fit.y + fit.h + 5, 1), [0, 0, 0]), 'black bar below');
    // Blue block (x 20–120, y 20–80 of 300×100) and yellow block, scaled by 1280/300.
    const k = 1280 / 300;
    assert.ok(near(await pixel(seg, Math.round(70 * k), fit.y + Math.round(50 * k), 1), BLUE), 'blue exact');
    assert.ok(near(await pixel(seg, Math.round(220 * k), fit.y + Math.round(50 * k), 1), YELLOW), 'yellow exact');
    assert.ok(near(await pixel(seg, Math.round(5 * k), fit.y + Math.round(5 * k), 1), RED), 'red exact, top-left corner not cropped');
    assert.ok(near(await pixel(seg, Math.round(295 * k), fit.y + Math.round(95 * k), 1), RED), 'bottom-right corner not cropped');
    const check = await realFf.matchImageSegment(seg, img, { mode: 'hold', durationS: 3, size, workdir: dir });
    assert.equal(check.pass, true);
    assert.ok(check.similarity >= realFf.IMAGE_MATCH_MIN, `similarity ${check.similarity}`);

    // The same image through the graded still path does not pass the check.
    const graded = path.join(dir, 'graded.mp4');
    await realFf.segmentFromStill(img, { camera: 'static', durationS: 3, out: graded, size, grade: 'noir' });
    assert.equal((await realFf.matchImageSegment(graded, img, { mode: 'hold', durationS: 3, size, workdir: dir, name: 'g' })).pass, false);
  });

  test('a tall image is pillarboxed; a push-in zooms at most 5%', async () => {
    const img = path.join(dir, 'tall.png');
    await writeFile(img, TALL);
    const size = realFf.FILM_SIZES.preview;
    const fit = realFf.letterboxFit(100, 200, size.width, size.height);
    assert.deepEqual(fit, { w: 240, h: 480, x: 307, y: 0 });
    const seg = path.join(dir, 'push.mp4');
    await realFf.segmentFromImage(img, { mode: 'push_in', durationS: 4, out: seg, size });
    assert.ok(near(await pixel(seg, 100, 240, 0.1), [0, 0, 0]), 'black bar to the left');
    assert.ok(near(await pixel(seg, 750, 240, 0.1), [0, 0, 0]), 'black bar to the right');
    assert.ok(near(await pixel(seg, 427, 100, 0.1), BLUE) && near(await pixel(seg, 427, 380, 0.1), YELLOW));
    // At the end the image is at most 5% larger: its left edge has moved in by
    // no more than 5% of half the frame's width.
    const end = 3.95;
    const edge = fit.x - Math.ceil((size.width / 2) * realFf.PUSH_IN_MAX_ZOOM) - 3;
    assert.ok(near(await pixel(seg, edge, 240, end), [0, 0, 0]), 'still inside the bar after a 5% zoom');
    assert.ok(!near(await pixel(seg, fit.x + 2, 240, end), [0, 0, 0]), 'the image is there');
    assert.match(realFf.imageShotGraph('push_in', 96, size), /zoompan=z='1\+0\.05\*on\/95'/);
    assert.deepEqual(realFf.imageMatchTimes(4, 'push_in').map((f) => f.zoom), [1.0011, 1.0253, 1.0484]);
    const check = await realFf.matchImageSegment(seg, img, { mode: 'push_in', durationS: 4, size, workdir: dir });
    assert.equal(check.pass, true, JSON.stringify(check));
  });

  test('the preview and the full film both show the image, matched against the source', { timeout: 300000 }, async () => {
    const still = path.join(dir, 'still.png');
    const clip = path.join(dir, 'clip.mp4');
    await realFf.run('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=1344x768', '-frames:v', '1', still]);
    await realFf.run('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=24:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
    const fsp = await import('node:fs/promises');
    const stillBytes = await fsp.readFile(still);
    const clipBytes = await fsp.readFile(clip);
    const sb = {
      title: 'Logo Test', tier: 'draft', style: { look: 'clean', grade: 'noir', reference_prompt: 'x' }, characters: [], captions: { enabled: false }, title_card: null, end_card: null,
      scenes: [{ id: 's1', title: 'One', music: { mood: 'tone', bpm: 120 }, shots: [
        { id: 's1-sh1', duration_s: 3, camera: 'static', description: 'bars', visual_prompt: 'colour bars', voiceover: '', transition: 'cut' },
        { id: 's1-logo', duration_s: 3, description: 'end card', visual_prompt: '', voiceover: '', transition: 'cut', asset: { attachment: 1, mode: 'hold' } }
      ] }]
    };
    const engines = {
      still: async () => stillBytes,
      clip: async () => clipBytes,
      music: async () => { const f = path.join(dir, 'm.wav'); await realFf.run('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=10:c=pink:a=0.1', '-ar', '48000', '-ac', '2', f]); return { bytes: await fsp.readFile(f), ext: 'wav', mime: 'audio/wav' }; },
      voice: async () => { throw new Error('no voice in this film'); },
      image: (b) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(b).toString('base64') } }),
      think: async ({ system }) => (system.includes('storyboard artist') ? { text: JSON.stringify(sb) } : { text: '{"pass":true,"score":9,"issues":[],"best_start_s":0,"description":"bars"}' }),
      transcribe: async () => ({ text: '', words: [] })
    };
    const db = await makeFilmDb();
    const vault = new Map();
    const store = createFilmStore({ supUrl: SUP_URL, supKey: 'k', fetchImpl: routedFetch(filmDbRoutes(db, vault)) });
    let p = await store.createProject({ request: 'Use the attached logo unaltered as the end card.', tier: 'draft', capUsd: 20, status: 'storyboarding' });
    const { images } = validateFilmAttachments([part(LOGO, 'image/png')]);
    const stored = await storeFilmAttachments({ store, projectId: p.id, images, request: p.request });
    await runStoryboard({ project: p, store, engines, ff: realFf, workdir: path.join(dir, 'sb'), attachments: stored });
    p = await store.getProject(p.id);
    const img = path.join(dir, 'src.png');
    await writeFile(img, LOGO);
    for (const stage of ['preview', 'full']) {
      const r = await runRender({ project: p, stage, store, engines, ff: realFf, workdir: path.join(dir, stage) });
      assert.deepEqual(r.qcReport.attachments.map((a) => [a.shotId, a.pass]), [['s1-logo', true]], stage);
      const out = path.join(dir, `${stage}.mp4`);
      await writeFile(out, vault.get(r.path));
      const seg = r.plan.segments.find((s) => s.shotId === 's1-logo');
      const size = r.size;
      const ref = await realFf.matchPixels(img, path.join(dir, `${stage}-ref.rgb`), { fitTo: size });
      const got = await realFf.matchPixels(out, path.join(dir, `${stage}-got.rgb`), { atS: seg.startS + seg.durationS / 2 });
      const sim = realFf.pixelSimilarity(ref, got);
      assert.ok(sim >= 0.95, `${stage}: the film shows the image (similarity ${sim})`);
      // The film's noir grade is off for the image: its red stays red.
      const fit = realFf.letterboxFit(300, 100, size.width, size.height);
      const red = await pixel(out, Math.round(140 * size.width / 300), fit.y + Math.round(50 * size.width / 300), seg.startS + seg.durationS / 2);
      assert.ok(near(red, RED, 12), `${stage}: brand red kept (${red})`);
    }
  });
});
