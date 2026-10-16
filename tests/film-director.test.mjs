/**
 * PG1 Studio Director Mode (lib/film/director.mjs; docs/director-mode.md
 * Part B), end to end on the real worker and engines, network mocked:
 *
 *  - brief -> treatment and script -> shot list (size, lens, lighting,
 *    blocking, continuity, intent, SFX, dialogue) -> storyboard stills
 *    checked against the script -> production through the router's chains
 *    -> dailies (weak shots regenerated, reasons logged) -> edit -> titles
 *    and credits (end crawl, logo end card held as it is) -> deliverables
 *    (master, 9:16 cut, stems, director's notes PDF) -> push to the operator;
 *  - a client film: licensed engines only, client credit, approval before
 *    delivery;
 *  - a stopped run resumes at its stage and pays for nothing twice;
 *  - /film director: one budget approval, then the worker alone;
 *  - craft rules: no named director's style; white label; no copyright line.
 *
 * Run with: node --test tests/film-director.test.mjs
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { __resetRouterState } from '../lib/aiRouter.mjs';
import { REPLICATE_API, GEMINI_API, ANTHROPIC_URL, CARTESIA_STT_URL, ELEVENLABS_TTS_URL, ELEVENLABS_SFX_URL, ELEVENLABS_DIALOGUE_URL, characterVoice, DEFAULT_CHARACTER_VOICES } from '../lib/film/providers.mjs';
import { INTERACTIONS_URL } from '../lib/videoJobs.mjs';
import { QC_SYSTEM, DAILIES_SYSTEM, STILL_CHECK_SYSTEM } from '../lib/film/qc.mjs';
import { WRITING_SYSTEM, creditLines, directorBrief, parseDirectorRequest, estimateDirector, DEFAULT_LOGO_FILE, DIRECTOR_CREDIT_LINES, directorNotesBlocks, creditsAreWhiteLabel } from '../lib/film/director.mjs';
import { withCredits } from '../lib/film/pipeline.mjs';
import { createFilmStore } from '../lib/film/store.mjs';
import { signFilmToken } from '../lib/film/dispatch.mjs';
import { FILM_ACTIONS, parseFilmCommand, FILM_FAILURE_TEXT, filmFailureText } from '../lib/film/text.mjs';
import { handleFilmCommand, handleFilmApproval, filmCard } from '../lib/film/chat.mjs';
import { main as workerMain, realEngines } from '../scripts/film-render.mjs';
import { createCapacityAlerts, __resetAlerts } from '../lib/router/alerts.mjs';
import { UPSTREAM_BRAND_RE } from '../lib/upstreamFailure.mjs';
import { namesProvider } from '../lib/whiteLabel.mjs';
import * as realFf from '../lib/film/ffmpeg.mjs';
import { makeFilmDb, filmDbRoutes, routedFetch, json } from './helpers/filmDb.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const SUP_URL = 'https://supabase.test';
const SECRET = 'film-render-secret-0123456789abcdef';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const KEYS = {
  REPLICATE_API_TOKEN: 'r8_dir_stub_0123456789abcdef', GEMINI_API_KEY_PAID: 'AQ.dir-paid-0123456789', ANTHROPIC_API_KEY: 'sk-ant-dir-0123456789',
  CARTESIA_API_KEY: 'sk_car_dir_0123456789', ELEVENLABS_API_KEY: 'sk_el_dir_0123456789', PG1_VIDEO_MODEL_REPLICATE_IMAGE: 'kwaivgi/kling-v2.1', PG1_FILM_VOICE_ID: 'brandVoice0123456789'
};

const SCRIPT = {
  title: 'First Light', logline: 'A baker opens before the town wakes.', treatment: 'Dawn, flour and quiet; a small ritual that starts a town\'s day.',
  look: 'soft window light, warm palette, 35mm', mood: 'tender, hopeful', runtime_s: 20,
  beats: [{ beat: 'Dark street', description: 'The town asleep', seconds: 5 }, { beat: 'The oven', description: 'Heat and flour', seconds: 10 }, { beat: 'First customer', description: 'A smile at the door', seconds: 5 }]
};
const dir = (size, intent) => ({ shot_size: size, lens: '35mm, shallow focus', lighting: 'soft window light', blocking: 'Mia at the bench', continuity: 'apron flour stays', intent });
const SHOTS = {
  title: 'First Light', logline: SCRIPT.logline, tier: 'standard',
  style: { look: SCRIPT.look, grade: 'warm', reference_prompt: 'Mia, a baker in a white apron' },
  characters: [{ id: 'c1', name: 'Mia', description: 'baker, white apron, dark curls' }, { id: 'c2', name: 'Tom', description: 'early customer, grey coat' }],
  captions: { enabled: true }, title_card: { text: 'First Light', duration_s: 3 }, end_card: { text: 'ignored' },
  scenes: [
    { id: 's1', title: 'Bakery', music: { mood: 'soft piano', bpm: 80 }, shots: [
      { id: 's1-sh1', duration_s: 5, camera: 'push_in', description: 'dark street', visual_prompt: 'A dark street before dawn', voiceover: 'Before the town wakes,', transition: 'cut', characters: [], direction: dir('wide', 'quiet before the day'), sfx: 'distant birdsong' },
      { id: 's1-sh2', duration_s: 5, camera: 'static', description: 'Mia at the oven', visual_prompt: 'Mia slides bread into the oven', voiceover: '', transition: 'cut', characters: ['c1'], direction: dir('medium_close', 'care in her hands'), sfx: 'oven door creak' }
    ] },
    { id: 's2', title: 'Door', music: { mood: 'warm strings', bpm: 92 }, shots: [
      { id: 's2-sh1', duration_s: 5, camera: 'tracking', description: 'Tom at the door', visual_prompt: 'Tom steps in out of the cold', voiceover: '', transition: 'cut', characters: ['c2'], direction: dir('medium', 'warmth meets cold'), dialogue: [{ character: 'c2', line: 'Am I too early?' }, { character: 'c1', line: 'Never.' }] },
      { id: 's2-sh2', duration_s: 5, camera: 'static', description: 'bread on the counter', visual_prompt: 'Fresh bread on the counter', voiceover: 'the day begins with bread.', transition: 'cut', characters: [], direction: dir('insert', 'the reward') }
    ] }
  ]
};

const segments = [];
let asses = [];
let mixes = [];
function fakeFf() {
  const touch = async (f, what) => { await writeFile(f, what); return f; };
  return {
    FILM_SIZES: realFf.FILM_SIZES, TARGET_LUFS: realFf.TARGET_LUFS, buildAss: realFf.buildAss,
    writeText: async (f, t) => { asses.push(t); return touch(f, t); },
    probeDuration: async () => 5,
    extractFrame: (i, t, out) => touch(out, 'frame'),
    extractLastFrame: (i, out) => touch(out, 'last'),
    thumbnail: (i, t, out) => touch(out, 'thumb'),
    segmentFromStill: (s, o) => touch(o.out, 'still-seg'),
    segmentFromClip: (c, o) => touch(o.out, 'clip-seg'),
    segmentFromImage: (img, o) => { segments.push({ kind: 'image', img, ...o }); return touch(o.out, 'img-seg'); },
    segmentCard: (o) => { segments.push({ kind: 'card', ...o }); return touch(o.out, 'card'); },
    joinSegments: (files, d, j, out) => touch(out, 'join'),
    mixAudio: async (o) => { mixes.push(o); return touch(o.out, 'mix'); },
    normaliseLoudness: async (i, out) => { await touch(out, 'loud'); return { file: out, measured: { input_i: '-22' }, after: { input_i: '-14.0' } }; },
    finalEncode: (o) => touch(o.out, 'final'),
    socialCut: (i, out) => touch(out, 'social'),
    extractAudioForCheck: (i, out) => touch(out, 'wav')
  };
}

const sse = (events) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });
function engineRoutes(trace, st) {
  // One text answer per Director step, from whichever text engine is asked
  // (a client film's text runs on the paid Gemini key alone, T1).
  const textReply = (sys, sent, provider) => {
    const step = sys === WRITING_SYSTEM ? 'writing' : sys.startsWith(STILL_CHECK_SYSTEM.slice(0, 40)) ? 'still check' : sys === DAILIES_SYSTEM ? 'dailies' : sys === QC_SYSTEM ? 'shot check' : 'shot list';
    trace.push({ step, provider, text: sent.slice(0, 4000) });
    if (step === 'writing') return JSON.stringify(SCRIPT);
    if (step === 'shot list') return JSON.stringify(SHOTS);
    if (step === 'still check') {
      const n = trace.filter((t) => t.step === 'still check').length;
      return n === 2 ? '{"pass":false,"score":3,"issues":[{"type":"composition","detail":"framed too wide for a medium close-up"}],"description":"x"}' : '{"pass":true,"score":8,"issues":[],"description":"ok"}';
    }
    const n = trace.filter((t) => t.step === 'dailies').length;
    return n === 1 ? '{"pass":false,"score":3,"issues":[{"type":"faces_hands","detail":"six fingers on the left hand"}],"best_start_s":0,"description":"x"}' : '{"pass":true,"score":8,"issues":[],"best_start_s":0.5,"description":"as intended"}';
  };
  return [
    ['api.github.com', (u, o, body) => { trace.push({ step: 'dispatch', body }); return new Response(null, { status: 204 }); }],
    [ANTHROPIC_URL, (u, o, body) => {
      const text = textReply(String(body.system), JSON.stringify(body.messages), 'anthropic');
      return json({ model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 800, output_tokens: 400 } });
    }],
    [`${REPLICATE_API}/models/`, (u) => {
      const model = u.split('/models/')[1].split('/predictions')[0];
      trace.push({ step: /kling/.test(model) ? 'clip' : 'still', provider: 'replicate', model });
      if (st.replicate) { const r = st.replicate(model); if (r) return r; }
      return json({ id: `p-${trace.length}`, status: 'succeeded', output: `https://replicate.delivery/o-${trace.length}.${/kling/.test(model) ? 'mp4' : 'png'}` }, 201);
    }],
    ['https://replicate.delivery/', () => new Response(Buffer.from('media'), { status: 200 })],
    [INTERACTIONS_URL, () => {
      trace.push({ step: 'clip', provider: 'gemini_paid' });
      if (st.omni) { const r = st.omni(); if (r) return r; }
      return json({ id: 'i', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', data: Buffer.from('mp4').toString('base64'), mime_type: 'video/mp4' }] }] });
    }],
    [`${GEMINI_API}/`, (u, o, body) => {
      const model = decodeURIComponent(u.split('/models/')[1].split(':')[0]);
      if (!/lyria|image/.test(model)) {
        const sys = body.systemInstruction ? body.systemInstruction.parts.map((x) => x.text).join('') : '';
        const text = textReply(sys, JSON.stringify(body.contents), 'gemini_paid');
        return json({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 400 } });
      }
      trace.push({ step: /lyria/.test(model) ? 'music' : 'still', provider: 'gemini_paid', model });
      if (/lyria/.test(model)) return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/mpeg', data: Buffer.from('mp3').toString('base64') } }] } }] });
      return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }] });
    }],
    [ELEVENLABS_SFX_URL, (u, o, body) => { trace.push({ step: 'sfx', provider: 'elevenlabs', text: body.text, seconds: body.duration_seconds }); return new Response(Buffer.from('sfx-mp3'), { status: 200 }); }],
    [ELEVENLABS_DIALOGUE_URL, (u, o, body) => { trace.push({ step: 'dialogue', provider: 'elevenlabs', inputs: body.inputs, model: body.model_id }); return new Response(Buffer.alloc(24000 * 2), { status: 200 }); }],
    [`${ELEVENLABS_TTS_URL}/`, (u, o, body) => {
      trace.push({ step: 'voice', provider: 'elevenlabs', text: body.text, voiceId: decodeURIComponent(new URL(u).pathname.split('/')[3]) });
      const chars = [...body.text];
      return json({ audio_base64: Buffer.alloc(2400 * 2).toString('base64'), alignment: { characters: chars, character_start_times_seconds: chars.map((c, i) => i * 0.05), character_end_times_seconds: chars.map((c, i) => i * 0.05 + 0.04) } });
    }],
    ['https://api.cartesia.ai/tts', (u, o, body) => { trace.push({ step: 'voice', provider: 'cartesia', text: body.transcript }); return sse([{ type: 'chunk', data: Buffer.alloc(2000).toString('base64') }, { type: 'done' }]); }],
    [CARTESIA_STT_URL, () => { trace.push({ step: 'transcript' }); return json({ text: 'Before the town wakes, Am I too early? Never. the day begins with bread.' }); }]
  ];
}

// Provider, company and model names a viewer, a client or a file may never carry.
const BANNED = /(?<![a-z0-9])(?:eleven[\s_-]*labs|google|gemini|veo|lyria|replicate|kling|kwaivgi|cartesia|flux|kontext|black-forest-labs|openrouter|openai|anthropic|claude|gpt|chatgpt|sonic|omni|imagen|eleven_v3|eleven_multilingual(?:_v2)?|eleven_text_to_sound(?:_v2)?|ink-whisper|whisper)(?![a-z0-9])/i;

beforeEach(() => { __resetRouterState(); __resetAlerts(); segments.length = 0; asses = []; mixes = []; });
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

describe('Director Mode, end to end', () => {
  let db;
  let store;
  let fetchImpl;
  let trace;
  let st;
  beforeEach(async () => {
    db = await makeFilmDb();
    trace = [];
    st = {};
    fetchImpl = routedFetch([...filmDbRoutes(db), ...engineRoutes(trace, st)]);
    store = createFilmStore({ supUrl: SUP_URL, supKey: 'service-key', fetchImpl });
    process.env = { ...ORIGINAL_ENV, SUPABASE_URL: SUP_URL, SUPABASE_SERVICE_ROLE_KEY: 'service-key' };
    globalThis.fetch = fetchImpl;
  });

  const newDirectorFilm = async ({ brief = 'A 20s film about a baker at dawn in the style of Wes Anderson', client = null, priceUsd = null } = {}) => {
    const p = await store.createProject({ request: directorBrief(brief).brief, capUsd: 20, status: 'director_queued' });
    await store.updateProject(p.id, { mode: 'director', client, price_usd: priceUsd, director: { stage: 'writing', done: [], seconds: 20, notes: directorBrief(brief).notes, regenerated: [] } });
    return p;
  };
  const runDirectorStage = async (p, { clientWork = false, notify = null } = {}) => {
    const env = { ...process.env, ...KEYS, PG1_VIDEO_RENDER_SECRET: SECRET, FILM_PROJECT_ID: p.id, FILM_STAGE: 'director' };
    env.FILM_TOKEN = signFilmToken(p.id, env);
    const logs = [];
    const engines = realEngines(env, { fetchImpl, log: (l) => logs.push(l), sleep: async () => {}, clientWork, alert: createCapacityAlerts({ env, log: (l) => logs.push(l) }) });
    const code = await workerMain(env, { engines, fetchImpl, ffImpl: fakeFf(), log: (l) => logs.push(l), ...(notify ? { notify } : {}) });
    return { code, logs, film: await store.getProject(p.id) };
  };

  test('every stage alone: script, shot list, checked storyboard, production, dailies, edit, credits, deliverables, push', async () => {
    const p = await newDirectorFilm();
    const r = await runDirectorStage(p);
    assert.equal(r.code, 0, r.logs.join('\n'));
    assert.equal(r.film.status, 'done', 'an operator film needs no delivery approval');
    const d = r.film.director;
    assert.deepEqual(d.done, ['writing', 'shot_list', 'storyboard', 'production', 'notes']);
    assert.equal(d.delivered, true);
    assert.equal(d.script.beats.length, 3);
    // The brief's named director was replaced before any model saw it.
    assert.match(d.notes[0], /never imitates a named director's signature style/);
    assert.ok(!trace.some((t) => t.provider === 'anthropic' && /Wes Anderson/.test(t.text)), 'the name never reaches a model');
    // Shot list with the craft fields.
    const shots = r.film.timeline.scenes.flatMap((s) => s.shots);
    assert.ok(shots.every((s) => s.direction && s.direction.shot_size && s.direction.lens && s.direction.intent));
    assert.equal(r.film.timeline.end_card, null, 'PG1 adds its own end credits');
    // Storyboard: every still checked once; the one that missed made once more.
    assert.equal(trace.filter((t) => t.step === 'still check').length, 4);
    assert.equal(r.film.director.storyboard.stillChecks.filter((c) => !c.pass).length, 1);
    // Dailies: the clip with six fingers regenerated, reason logged.
    assert.ok(trace.filter((t) => t.step === 'dailies').length >= 5);
    const regen = d.regenerated.map((x) => `${x.what}:${x.shotId}`);
    assert.ok(regen.includes('still:s1-sh2'), regen.join(','));
    assert.ok(d.regenerated.some((x) => x.what === 'clip' && /six fingers/.test(x.reason)), JSON.stringify(d.regenerated));
    // Production on the router's chains: Omni clips, brand voice, dialogue, SFX, Lyria.
    assert.ok(trace.filter((t) => t.step === 'clip').every((t) => t.provider === 'gemini_paid'));
    assert.ok(trace.filter((t) => t.step === 'voice').every((t) => t.provider === 'elevenlabs' && t.voiceId === KEYS.PG1_FILM_VOICE_ID));
    const dl = trace.find((t) => t.step === 'dialogue');
    assert.equal(dl.model, 'eleven_v3');
    assert.deepEqual(dl.inputs.map((i) => i.voice_id), [DEFAULT_CHARACTER_VOICES[1], DEFAULT_CHARACTER_VOICES[0]], 'Tom and Mia keep their own voices (cast order)');
    assert.deepEqual(trace.filter((t) => t.step === 'sfx').map((t) => t.text), ['distant birdsong', 'oven door creak']);
    assert.ok(trace.filter((t) => t.step === 'music').every((t) => /lyria/.test(t.model)));
    // Edit and titles: the crawl, then the logo held as it is.
    const crawl = asses.at(-1);
    for (const l of DIRECTOR_CREDIT_LINES) assert.ok(crawl.includes(l), l);
    assert.match(crawl, /\\move\(/);
    assert.doesNotMatch(crawl, /©|copyright/i);
    assert.equal(segments.filter((s) => s.kind === 'image').at(-1).img, DEFAULT_LOGO_FILE);
    assert.equal(segments.filter((s) => s.kind === 'image').at(-1).mode, 'hold');
    const last = mixes.filter((m) => /mix\.wav$/.test(m.out)).at(-1);
    assert.equal(last.sfx.length, 2, 'SFX in the mix');
    assert.ok(last.voice.length >= 3, 'voice-over and dialogue');
    // Deliverables.
    const assets = await store.listAssets(p.id);
    assert.ok(assets.some((a) => a.kind === 'final'));
    assert.equal(assets.filter((a) => a.kind === 'social').length, 1);
    assert.deepEqual(assets.filter((a) => a.kind === 'stem').map((a) => a.meta.stem).sort(), ['music', 'sfx', 'voice']);
    assert.equal(assets.filter((a) => a.kind === 'notes').length, 1);
    // White label everywhere a viewer or client looks.
    assert.doesNotMatch(JSON.stringify(r.film.qc_report), UPSTREAM_BRAND_RE);
    const card = await filmCard(store, r.film);
    assert.match(JSON.stringify(card.director), /"social":true/);
    // The operator hears at the end (logged here: no push keys in the test).
    assert.ok(r.logs.some((l) => /director done/.test(l)));
  });

  test('white label: the credits, the notes PDF, deliverable names, file metadata, error messages and the push name no provider or model', async () => {
    const pushes = [];
    const p = await newDirectorFilm();
    const r = await runDirectorStage(p, { notify: async (n) => { pushes.push(n); return 1; } });
    assert.equal(r.code, 0, r.logs.join('\n'));
    // The credits, exactly, then the held logo end card; no copyright line.
    assert.deepEqual([...DIRECTOR_CREDIT_LINES], ['Directed by PG1 Studio', 'Music and sound by PG1 Sound', 'A Project-Gifted1™ production']);
    assert.deepEqual(creditLines({ title: r.film.timeline.title }).slice(-3), [...DIRECTOR_CREDIT_LINES]);
    const crawl = asses.at(-1);
    let at = -1;
    for (const l of DIRECTOR_CREDIT_LINES) { const i = crawl.indexOf(l); assert.ok(i > at, `${l} in order`); at = i; }
    assert.doesNotMatch(crawl, /©|\(c\)|copyright/i);
    assert.equal(segments.at(-1).kind, 'image', 'the logo end card is the last thing on screen');
    assert.equal(segments.at(-1).img, DEFAULT_LOGO_FILE);
    assert.equal(segments.at(-1).mode, 'hold', 'held, never generated');
    // Every stored file: its name, description and metadata.
    const assets = await store.listAssets(p.id);
    const delivered = assets.filter((a) => ['final', 'social', 'stem', 'notes'].includes(a.kind));
    assert.deepEqual([...new Set(delivered.map((a) => a.kind))].sort(), ['final', 'notes', 'social', 'stem']);
    for (const a of assets) {
      assert.doesNotMatch(`${a.storage_path} ${a.thumb_path || ''}`, BANNED, `file name ${a.storage_path}`);
      assert.doesNotMatch(`${a.description || ''} ${a.mime_type || ''}`, BANNED, `description of ${a.storage_path}`);
      assert.doesNotMatch(JSON.stringify(a.meta || {}), BANNED, `metadata of ${a.storage_path}`);
    }
    // The director's notes PDF: its text blocks and its document metadata.
    const notes = assets.find((a) => a.kind === 'notes');
    assert.match(notes.storage_path, /\.pdf$/);
    const pdfBytes = await store.download(notes.storage_path);
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.load(pdfBytes, { updateMetadata: false });
    for (const v of [pdf.getTitle(), pdf.getAuthor(), pdf.getSubject(), pdf.getCreator(), pdf.getProducer(), pdf.getKeywords()]) assert.doesNotMatch(String(v || ''), BANNED, String(v));
    assert.doesNotMatch(Buffer.from(pdfBytes).toString('latin1'), BANNED, 'no provider or model name anywhere in the file');
    assert.doesNotMatch(JSON.stringify(directorNotesBlocks({ project: r.film, director: r.film.director, timeline: r.film.timeline, qcReport: r.film.qc_report, plan: { segments: [], joins: [], totalS: 0 } })), BANNED);
    // The film's report and card, and the push at the end (film, cost, shots made again).
    assert.doesNotMatch(JSON.stringify(r.film.qc_report), BANNED);
    assert.doesNotMatch(JSON.stringify(r.film.director), BANNED);
    assert.doesNotMatch(JSON.stringify(await filmCard(store, r.film)), BANNED);
    assert.equal(pushes.length, 1);
    assert.match(pushes[0].title, /is ready/);
    assert.match(pushes[0].body, /USD spent, \d+ shot\(s\) made again/);
    assert.doesNotMatch(`${pushes[0].title} ${pushes[0].body}`, BANNED);
    // Every reason a film can stop, as the operator and a client read it.
    for (const reason of [...Object.keys(FILM_FAILURE_TEXT), 'licence']) {
      const failed = { ...r.film, status: 'failed', error_reason: reason, error_detail: 'replicate kwaivgi/kling-v2.1 402: out of credit; gemini-omni-1.1-flash 429; elevenlabs eleven_v3 500', failure: { stage: 'director', step: 'clips', engine: 'replicate', fallback: { engine: 'gemini_paid', outcome: 'failed' }, licence: reason === 'licence' } };
      const card = await filmCard(store, failed);
      assert.doesNotMatch(String(card.message || ''), BANNED, `${reason}: ${card.message}`);
      assert.doesNotMatch(filmFailureText(reason), BANNED, reason);
    }
  });

  test('with R2 set up, the clips, master, 9:16 cut and stems go to pg1-storage; stills, voice and the notes stay in the vault', async () => {
    const account = '0123456789abcdef0123456789abcdef';
    const objects = new Map();
    const r2Route = [`https://${account}.r2.cloudflarestorage.com/pg1-storage/`, (u, o) => {
      const key = decodeURIComponent(new URL(u).pathname.slice('/pg1-storage/'.length));
      assert.match(String(o.headers.Authorization), /^AWS4-HMAC-SHA256 /);
      if (o.method === 'PUT') { objects.set(key, Buffer.from(o.body)); return new Response('', { status: 200 }); }
      return objects.has(key) ? new Response(objects.get(key), { status: 200 }) : new Response('', { status: 404 });
    }];
    fetchImpl = routedFetch([r2Route, ...filmDbRoutes(db), ...engineRoutes(trace, st)]);
    globalThis.fetch = fetchImpl;
    process.env = { ...process.env, R2_ACCOUNT_ID: account, R2_ACCESS_KEY_ID: 'r2-key-id', R2_SECRET_ACCESS_KEY: 'r2-secret' };
    const p = await newDirectorFilm();
    const r = await runDirectorStage(p);
    assert.equal(r.code, 0, r.logs.join('\n'));
    const assets = await store.listAssets(p.id);
    for (const a of assets) {
      const large = ['clip', 'final', 'preview', 'social', 'stem'].includes(a.kind);
      assert.equal(String(a.storage_path).startsWith('r2:films/'), large, `${a.kind} ${a.storage_path}`);
    }
    assert.ok(assets.some((a) => a.kind === 'final') && assets.some((a) => a.kind === 'social') && assets.filter((a) => a.kind === 'stem').length === 3);
    assert.ok([...objects.keys()].every((k) => k.startsWith(`films/${p.id}/`)));
    // The film card links the master on R2 (the chat side needs the same
    // R2 settings: a store without them cannot sign an R2 link).
    assert.equal((await filmCard(store, r.film)).finalUrl, null, 'no R2 settings: no link');
    const card = await filmCard(createFilmStore({ supUrl: SUP_URL, supKey: 'service-key', fetchImpl }), r.film);
    assert.match(JSON.stringify(card), new RegExp(`${account}\\.r2\\.cloudflarestorage\\.com/pg1-storage/films/${p.id}/final/`));
  });

  test('a client film: licensed engines only, the client credited, approval before delivery', async () => {
    const p = await newDirectorFilm({ brief: 'A 20s spot for a bakery', client: { name: 'Acme Bakery', credit: false } });
    const r = await runDirectorStage(p, { clientWork: true });
    assert.equal(r.code, 0, r.logs.join('\n'));
    assert.equal(r.film.status, 'awaiting_delivery_approval');
    assert.ok(!trace.some((t) => (t.step === 'clip' && t.provider === 'replicate') || t.provider === 'cartesia' && t.step === 'voice'), 'never Kling or Cartesia for a client');
    const crawl = asses.at(-1);
    assert.match(crawl, /Made for Acme Bakery/);
    assert.ok(!DIRECTOR_CREDIT_LINES.some((l) => crawl.includes(l)), 'PG1 credit off for this package');
    const row = (await db.query('select * from pending_actions where token = $1', [r.film.pending_token])).rows[0];
    assert.equal(row.action_type, FILM_ACTIONS.deliver);
    const cmdOpts = { env: { ...process.env, ...KEYS, PG1_VIDEO_ENABLED: '1' }, supUrl: SUP_URL, supKey: 'service-key', fetchImpl };
    assert.equal((await handleFilmApproval({ ...cmdOpts, row, decision: 'approve', isOperator: false })).resolution, null, 'operator only');
    const ok = await handleFilmApproval({ ...cmdOpts, row, decision: 'approve', isOperator: true });
    assert.equal(ok.resolution, 'approved');
    assert.match(ok.reply, /approved for delivery to Acme Bakery/);
    const film = await store.getProject(p.id);
    assert.equal(film.status, 'done');
    assert.equal(film.director.delivered, true);
  });

  test('a stopped run resumes at its stage: the script and shot list are not written or paid for again', async () => {
    const p = await newDirectorFilm();
    // Production: both clip engines out of credit.
    st.omni = () => new Response('{"error":{"code":402,"message":"insufficient credit"}}', { status: 402 });
    st.replicate = (model) => (/kling/.test(model) ? new Response('{"detail":"You have insufficient credit to run this model."}', { status: 402 }) : null);
    let r = await runDirectorStage(p);
    assert.equal(r.code, 1);
    assert.equal(r.film.status, 'failed');
    assert.equal(r.film.failure.stage, 'director');
    assert.deepEqual(r.film.director.done, ['writing', 'shot_list', 'storyboard']);
    const spentBefore = Number(r.film.spent_usd);
    // /film retry: Director Mode again, from where it stopped.
    const cmdOpts = { env: { ...process.env, ...KEYS, PG1_VIDEO_ENABLED: '1', PG1_VIDEO_RENDER_SECRET: SECRET, GITHUB_TOKEN: 'gh' }, supUrl: SUP_URL, supKey: 'service-key', fetchImpl };
    const proposed = await handleFilmCommand({ ...cmdOpts, text: `/film retry ${p.id.slice(0, 8)}`, isOperator: true });
    assert.match(proposed.reply, /from Director Mode, where it stopped/);
    const row = (await db.query('select * from pending_actions where token = $1', [proposed.pendingApproval.token])).rows[0];
    assert.equal((await handleFilmApproval({ ...cmdOpts, row, decision: 'approve', isOperator: true })).resolution, 'approved');
    assert.equal(trace.filter((t) => t.step === 'dispatch').at(-1).body.inputs.stage, 'director');
    st.omni = undefined;
    st.replicate = undefined;
    __resetRouterState();
    trace.length = 0;
    r = await runDirectorStage(p);
    assert.equal(r.code, 0, r.logs.join('\n'));
    assert.equal(r.film.status, 'done');
    assert.ok(!trace.some((t) => t.step === 'writing' || t.step === 'shot list'), 'not written again');
    assert.ok(!trace.some((t) => t.step === 'still'), 'stills reused');
    assert.ok(Number(r.film.spent_usd) > spentBefore);
  });

  test('/film director: client films wait for one approval, the operator\'s own start at once; operator only', async () => {
    const cmdOpts = { env: { ...process.env, ...KEYS, PG1_VIDEO_ENABLED: '1', PG1_VIDEO_RENDER_SECRET: SECRET, GITHUB_TOKEN: 'gh' }, supUrl: SUP_URL, supKey: 'service-key', fetchImpl };
    assert.deepEqual(parseFilmCommand('/film director a harbour at dawn --seconds 30'), { sub: 'director', id: null, rest: 'a harbour at dawn --seconds 30' });
    assert.match((await handleFilmCommand({ ...cmdOpts, text: '/film director a harbour at dawn', isOperator: false })).reply, /Only the signed-in operator/);
    const out = await handleFilmCommand({ ...cmdOpts, text: '/film director a 30s film about a harbour at dawn --client "Acme Coffee" --price 300', isOperator: true });
    assert.match(out.reply, /Director Mode, film [0-9a-f]{8}/);
    assert.match(out.reply, /Estimate: about [\d.]+ USD for a 30-second film/);
    assert.match(out.reply, /spend stops at 200\.00 USD \(1\.5x floor\)/);
    assert.match(out.reply, /waits for your approval before delivery/);
    assert.doesNotMatch(out.reply, UPSTREAM_BRAND_RE);
    assert.equal(trace.filter((t) => t.step === 'dispatch').length, 0, 'nothing starts before the approval');
    const row = (await db.query('select * from pending_actions where token = $1', [out.pendingApproval.token])).rows[0];
    assert.equal(row.action_type, FILM_ACTIONS.director);
    const film = await store.getProject(row.plan.projectId);
    assert.equal(film.mode, 'director');
    assert.deepEqual(film.client, { name: 'Acme Coffee', credit: true });
    assert.equal(Number(film.price_usd), 300);
    const ok = await handleFilmApproval({ ...cmdOpts, row, decision: 'approve', isOperator: true });
    assert.equal(ok.resolution, 'approved');
    assert.match(ok.reply, /Director Mode is directing the film/);
    assert.equal(trace.filter((t) => t.step === 'dispatch').at(-1).body.inputs.stage, 'director');
    assert.equal((await store.getProject(film.id)).status, 'director_queued');

    // The operator's own film starts at once: no proposal, straight to the worker.
    const before = trace.filter((t) => t.step === 'dispatch').length;
    const own = await handleFilmCommand({ ...cmdOpts, text: '/film director a 20s film about a lighthouse', isOperator: true });
    assert.equal(own.pendingApproval, undefined, 'no start approval for the operator\'s own film');
    assert.match(own.reply, /Started: Director Mode is directing the film\. It stops on its own only if the spending cap or the price floor would be passed or a safety check refuses/);
    assert.equal(trace.filter((t) => t.step === 'dispatch').length, before + 1);
    assert.equal(trace.filter((t) => t.step === 'dispatch').at(-1).body.inputs.stage, 'director');
    assert.equal((await store.getProject(own.filmProject.id)).status, 'director_queued');

    // PG1_DIRECTOR_START_APPROVAL=1 asks first; a client film always asks, whatever the setting.
    const asked = await handleFilmCommand({ ...cmdOpts, env: { ...cmdOpts.env, PG1_DIRECTOR_START_APPROVAL: '1' }, text: '/film director a 20s film about a lighthouse', isOperator: true });
    assert.ok(asked.pendingApproval && asked.pendingApproval.token);
    assert.match(asked.reply, /Approve to start \(PG1_DIRECTOR_START_APPROVAL=1\)/);
    const client = await handleFilmCommand({ ...cmdOpts, env: { ...cmdOpts.env, PG1_DIRECTOR_START_APPROVAL: '0' }, text: '/film director a 20s spot --client Acme', isOperator: true });
    assert.ok(client.pendingApproval && client.pendingApproval.token, 'a client film always waits for the operator');
    assert.match(client.reply, /A client film waits for your approval to start/);
    assert.equal(trace.filter((t) => t.step === 'dispatch').length, before + 1, 'neither of those started');
  });
});

describe('Director Mode rules', () => {
  test('never a named director\'s style; options parsed; credits white label with no copyright line', () => {
    assert.match(directorBrief('a short shot like Christopher Nolan would').brief, /distinctive, deliberate cinematic style/);
    assert.match(directorBrief('a Kubrick-esque corridor').brief, /distinctive corridor/);
    assert.equal(directorBrief('a harbour at dawn').notes.length, 0);
    assert.deepEqual(parseDirectorRequest('dawn --seconds 400').seconds, 300, '30 shots of 10 s at most');
    for (const lines of [creditLines({ title: 'X' }), creditLines({ client: { name: 'Acme', credit: true } }), creditLines({ client: { name: 'Acme', credit: false } })]) {
      assert.ok(creditsAreWhiteLabel(lines), lines.join(' | '));
    }
    assert.deepEqual(creditLines({ title: 'X' }), ['X', '', 'Directed by PG1 Studio', 'Music and sound by PG1 Sound', 'A Project-Gifted1™ production']);
    assert.equal(characterVoice({ PG1_DIRECTOR_VOICES: 'Mia=abcdefgh1234' }, 'mia'), 'abcdefgh1234');
  });

  test('the credits come after the last shot: crawl, then the held logo; the last cue plays on under them', () => {
    const plan = { segments: [{ kind: 'shot', startS: 0, durationS: 5 }], joins: [], totalS: 5, music: [{ sceneId: 's1', startS: 0, endS: 5 }] };
    const out = withCredits(plan, { lines: ['a', 'b'], logoFile: '/logo.png' });
    assert.deepEqual(out.segments.map((s) => s.kind), ['shot', 'crawl', 'logo']);
    assert.equal(out.crawl.lines.length, 2);
    assert.equal(out.music[0].endS, out.totalS);
    assert.equal(withCredits(plan, null), plan);
  });

  test('the director\'s notes name no provider or model', () => {
    const blocks = directorNotesBlocks({
      project: { client: null }, director: { script: SCRIPT, notes: ['Replicate was out of credit'] },
      timeline: { ...SHOTS, style: { look: 'x', grade: 'warm' }, scenes: SHOTS.scenes }, qcReport: { shots: [], regenerated: [{ shotId: 's1', what: 'clip', reason: 'made again on Kling' }], loudness: { after: -14, target: -14 }, sfx: { made: 2 } },
      plan: { segments: [{ kind: 'shot', scene: 1, shot: 1, startS: 0, durationS: 5 }], joins: [], totalS: 5 }
    });
    assert.equal(namesProvider(JSON.stringify(blocks)), false);
  });

  test('a 20- and a 30-second film\'s estimate', () => {
    const e20 = estimateDirector({ seconds: 20 });
    const e30 = estimateDirector({ seconds: 30 });
    assert.equal(e20.shots, 4);
    assert.equal(e30.shots, 6);
    assert.ok(e20.expectedUsd > 0 && e30.expectedUsd > e20.expectedUsd);
    assert.equal(e20.expectedUsd, Math.round((e20.lines.reduce((s, l) => s + l.usd, 0) + 1 * (0.5 + 0.04 + 0.04)) * 100) / 100);
  });
});
