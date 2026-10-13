/**
 * PG1 Sound through /api/chat and in the page:
 *
 *  - guests get a 401 for /music and MUSIC_STATUS, and nothing is read or
 *    written; the operator's /music queues the previews and the card polls;
 *    a refused prompt is answered before the vault is touched; approving a
 *    take through CONFIRM_PENDING_ACTION queues the final render;
 *  - the page's track card and library (public/index.html musicCardHtml,
 *    musicLibraryHtml): an inline player per preview with its own
 *    Approve / Decline, the master's player and downloads, the stems zip,
 *    and no provider name or licence text anywhere in the markup.
 *
 * Run with: node --test tests/music-chat.test.mjs
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import chatHandler, { __clearAuthRateLimitState } from '../api/chat.mjs';
import { UPSTREAM_BRAND_RE } from '../lib/upstreamFailure.mjs';
import { SAFETY_REFUSALS } from '../lib/music/safety.mjs';
import { MUSIC_ACTIONS } from '../lib/music/text.mjs';
import { routedFetch, json } from './helpers/filmDb.mjs';
import { makeMusicDb, musicDbRoutes } from './helpers/musicDb.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const SUP_URL = 'https://supabase.test';
const SECRET = 'music-render-secret-0123456789abcdef';
const BRANDS_RE = new RegExp(`${UPSTREAM_BRAND_RE.source}|licen[cs]e|synthid|watermark`, 'i');

describe('/music in the chat', () => {
  let db;
  let calls;
  let ipSeq = 0;
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
    process.env.PG1_VIDEO_RENDER_SECRET = SECRET;
    process.env.GITHUB_TOKEN = 'gh-test-token';
    process.env.GEMINI_API_KEY_PAID = 'paid-key-0123456789';
    for (const k of ['GEMINI_API_KEY', 'GEMINI_API_KEY1', 'GEMINI_API_KEY2', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'CARTESIA_API_KEY', 'REPLICATE_API_TOKEN', 'ELEVENLABS_API_KEY', 'PG1_MUSIC_TRACK_CAP']) delete process.env[k];
    __clearAuthRateLimitState();
    db = await makeMusicDb();
    calls = [];
    globalThis.fetch = routedFetch([
      ['api.github.com', () => new Response(null, { status: 204 })],
      ['/rest/v1/messages', (u, o) => (o.method === 'POST' ? new Response('', { status: 201 }) : json([]))],
      ['/storage/v1/object/list/pg1-vault', () => json([])],
      ['/rest/v1/threat_indicators', () => json([])],
      ...musicDbRoutes(db)
    ], calls);
  });

  after(() => {
    process.env = { ...ORIGINAL_ENV };
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test('guests cannot use /music or read a track', async () => {
    const res = await chat({ prompt: '/music lo-fi beat --instrumental' });
    assert.equal(res.statusCode, 401);
    const st = await chat({ action: 'MUSIC_STATUS', trackId: '11111111-2222-4333-8444-555555555555' });
    assert.equal(st.statusCode, 401);
    assert.equal(calls.filter((c) => c.url.includes('pg1_music') || c.url.includes('api.github.com')).length, 0);
  });

  test('/music queues the previews, says only PG1 Sound, and the card polls MUSIC_STATUS', async () => {
    const res = await chat(authed({ prompt: '/music dreamy synthwave, neon, analog pads --instrumental --bpm 104' }));
    assert.equal(res.statusCode, 200);
    const body = res.jsonBody;
    assert.match(body.reply, /PG1 Sound is making 2 previews/);
    assert.match(body.reply, /Spending cap for this track: 2\.00 USD/);
    assert.doesNotMatch(body.reply, UPSTREAM_BRAND_RE);
    assert.equal(body.musicTrack.status, 'preview_queued');
    assert.equal(body.musicTrack.active, true);
    const dispatch = calls.find((c) => c.url.includes('api.github.com'));
    assert.match(dispatch.url, /\/actions\/workflows\/music-render\.yml\/dispatches$/);
    assert.equal(dispatch.body.inputs.stage, 'preview');
    assert.equal(dispatch.body.inputs.track_id, body.musicTrack.id);
    const st = await chat(authed({ action: 'MUSIC_STATUS', trackId: body.musicTrack.id }));
    assert.equal(st.jsonBody.musicTrack.label, 'Making two previews…');
    const help = await chat(authed({ prompt: '/music' }));
    assert.match(help.jsonBody.reply, /### \[ PG1 SOUND \]/);
    assert.doesNotMatch(help.jsonBody.reply, UPSTREAM_BRAND_RE);
  });

  test('a refused prompt is answered before the vault or the worker is touched', async () => {
    const res = await chat(authed({ prompt: '/music a ballad in the voice of Adele' }));
    assert.equal(res.jsonBody.reply, SAFETY_REFUSALS.voice_of);
    assert.equal(calls.filter((c) => c.url.includes('pg1_music') || c.url.includes('api.github.com')).length, 0);
  });

  test('approving a take through CONFIRM_PENDING_ACTION queues the final render', async () => {
    const t = (await db.query("insert into pg1_music_tracks (prompt, title, options, status, cap_usd, choices) values ('x', 'X', '{}', 'awaiting_choice', 2, '[]') returning *")).rows[0];
    const token = '22222222-3333-4444-8555-666666666666';
    await db.query("update pg1_music_tracks set choices = $1 where id = $2", [JSON.stringify([{ variant: 1, token }]), t.id]);
    await db.query("insert into pending_actions (token, action_type, plan, diff_summary, status, created_at, expires_at) values ($1, $2, $3, 'take 1', 'pending', now(), now() + interval '1 day')", [token, MUSIC_ACTIONS.final, JSON.stringify({ trackId: t.id, variant: 1, version: 1, estimateUsd: 0.08 })]);
    const res = await chat(authed({ action: 'CONFIRM_PENDING_ACTION', token, decision: 'approve' }));
    assert.match(res.jsonBody.reply, /PG1 Sound: rendering take 1 of "X"/);
    assert.equal(res.jsonBody.musicTrack.status, 'final_queued');
    assert.equal((await db.query('select status from pending_actions where token = $1', [token])).rows[0].status, 'approved');
    assert.equal((await db.query('select status, chosen_variant from pg1_music_tracks where id = $1', [t.id])).rows[0].chosen_variant, 1);
  });
});

// --- the page --------------------------------------------------------------------------------

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `function ${name} not found in public/index.html`);
  let depth = 0;
  let i = html.indexOf('{', html.indexOf(')', start));
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(start, i + 1);
}

function page() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext([
    html.match(/const VIDEO_JOB_ID_RE = [^\n]*;/)[0].replace(/^const/, 'var'),
    ...['escapeHTML', 'filmMoney', 'renderApprovalActionsHtml', 'musicSafeUrl', 'musicSeconds', 'musicAudioHtml', 'musicCardHtml', 'musicLibraryHtml'].map(extractFunction)
  ].join('\n'), ctx);
  return ctx;
}

describe('the page: track card and library', () => {
  const ID = '11111111-2222-4333-8444-555555555555';
  const T1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const T2 = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const url = (p) => `https://vault.example.test/storage/v1/object/sign/pg1-vault/music/${p}?token=t`;

  test('previews: a player and "use take N" Approve / Decline each', () => {
    const out = page().musicCardHtml({
      id: ID, shortId: ID.slice(0, 8), title: 'Neon Drive', status: 'awaiting_choice', label: 'Previews ready: approve the take to finish', active: false, spec: 'instrumental · 104 BPM · about 30 s',
      previews: [{ variant: 1, url: url('take1.mp3'), durationS: 30.2, token: T1 }, { variant: 2, url: url('take2.mp3'), durationS: 29.8, token: T2 }], spentUsd: 0.16, capUsd: 2
    });
    assert.equal((out.match(/<audio controls/g) || []).length, 2);
    assert.match(out, /data-music-take="1"[\s\S]*resolveApproval\('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'approve'/);
    assert.match(out, /data-music-take="2"[\s\S]*resolveApproval\('ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'approve'/);
    assert.match(out, /Take 1 · 0:30/);
    assert.match(out, /PG1 Sound/);
    assert.match(out, /spent 0\.16 of 2\.00 USD/);
    assert.doesNotMatch(out, BRANDS_RE);
  });

  test('a finished track: the player, the download, the stems; a busy one: the progress and the poll flag', () => {
    const p = page();
    const done = p.musicCardHtml({
      id: ID, title: 'Neon Drive', status: 'done', label: 'Track ready', active: false, masterUrl: url('master.mp3'), masterDownloadUrl: `${url('master.mp3')}&download=Neon_Drive.mp3`,
      stemsUrl: `${url('stems.zip')}&download=Neon_Drive_stems.zip`, durationS: 151, bpm: 103.9, key: 'F# minor', spentUsd: 0.24, capUsd: 2
    });
    assert.equal((done.match(/<audio controls/g) || []).length, 1);
    assert.match(done, /Download the track/);
    assert.match(done, /Download stems, MIDI and WAV \(zip\)/);
    assert.match(done, /2:31 · 104 BPM · F# minor/);
    assert.match(done, /data-music-active="0"/);
    assert.doesNotMatch(done, BRANDS_RE);
    const busy = p.musicCardHtml({ id: ID, title: 'Neon Drive', status: 'exporting', label: 'Exporting stems, MIDI and WAV…', active: true, progress: { label: 'Separating stems', done: 0, total: 1 } });
    assert.match(busy, /data-music-active="1"/);
    assert.match(busy, /role="status"/);
    assert.equal(p.musicCardHtml({ id: 'not-an-id' }), '');
    // Only https links ever reach a player.
    assert.doesNotMatch(p.musicCardHtml({ id: ID, status: 'done', masterUrl: 'javascript:alert(1)' }), /<audio/);
  });

  test('the library: one player per stored track, the stems link when exported', () => {
    const out = page().musicLibraryHtml([
      { id: ID, shortId: ID.slice(0, 8), title: 'Neon Drive', label: 'Track ready', url: url('a.mp3'), stemsUrl: url('a.zip'), durationS: 30, bpm: 104, key: 'F# minor' },
      { id: '22222222-2222-4333-8444-555555555555', shortId: '22222222', title: 'Rain <b>', label: 'Making two previews…', url: null }
    ]);
    assert.equal((out.match(/<li class="music-library-item"/g) || []).length, 2);
    assert.equal((out.match(/<audio controls/g) || []).length, 1);
    assert.match(out, /Stems zip/);
    assert.match(out, /Rain &lt;b&gt;/);
    assert.doesNotMatch(out, BRANDS_RE);
  });

  test('the page source names no music provider', () => {
    assert.doesNotMatch(html, /lyria|eleven\s*labs|elevenlabs|demucs|basic-pitch|synthid/i);
  });
});
