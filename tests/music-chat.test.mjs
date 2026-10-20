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

  test('declining a take through CONFIRM_PENDING_ACTION sends back the card with that take discarded', async () => {
    const t = (await db.query("insert into pg1_music_tracks (prompt, title, options, status, cap_usd) values ('x', 'X', '{}', 'awaiting_choice', 2) returning *")).rows[0];
    const t1 = '22222222-3333-4444-8555-666666666666';
    const t2 = '33333333-3333-4444-8555-666666666666';
    await db.query('update pg1_music_tracks set choices = $1 where id = $2', [JSON.stringify([{ variant: 1, token: t1 }, { variant: 2, token: t2 }]), t.id]);
    for (const [v, tok] of [[1, t1], [2, t2]]) {
      await db.query("insert into pg1_music_assets (track_id, kind, variant, storage_path, duration_s) values ($1, 'preview', $2, $3, 30.1)", [t.id, v, `music/${t.id}/preview/v1-take${v}.mp3`]);
      await db.query("insert into pending_actions (token, action_type, plan, diff_summary, status, created_at, expires_at) values ($1, $2, $3, 'take', 'pending', now(), now() + interval '1 day')", [tok, MUSIC_ACTIONS.final, JSON.stringify({ trackId: t.id, variant: v, version: 1, estimateUsd: 0.04 })]);
    }
    const res = await chat(authed({ action: 'CONFIRM_PENDING_ACTION', token: t1, decision: 'decline' }));
    assert.match(res.jsonBody.reply, /PG1 Sound: take 1 of [0-9a-f]{8} discarded\. Approve take 2/);
    assert.deepEqual(res.jsonBody.musicTrack.previews.map((p) => [p.variant, !!p.discarded, p.token || null]), [[1, true, null], [2, false, t2]]);
    assert.equal((await db.query('select status from pending_actions where token = $1', [t1])).rows[0].status, 'declined');
    assert.equal((await db.query('select status from pending_actions where token = $1', [t2])).rows[0].status, 'pending');
    assert.doesNotMatch(JSON.stringify(res.jsonBody), UPSTREAM_BRAND_RE);
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
    ...['escapeHTML', 'filmMoney', 'approvalLabels', 'renderApprovalActionsHtml', 'musicSafeUrl', 'musicSeconds', 'musicAudioHtml', 'musicDownloadsHtml', 'musicTakeHtml', 'musicTakesHtml', 'musicCardHtml', 'musicLibraryHtml'].map(extractFunction)
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

  test('a declined take: "Discarded", no player and no "Approve to render"; only the other take is approvable', () => {
    const out = page().musicCardHtml({
      id: ID, shortId: ID.slice(0, 8), title: 'Neon Drive', status: 'awaiting_choice', label: 'Previews ready: approve the take to finish', spec: 'instrumental · about 30 s',
      previews: [{ variant: 1, discarded: true }, { variant: 2, url: url('take2.mp3'), durationS: 30.2, token: T2 }], spentUsd: 0.08, capUsd: 2
    });
    assert.match(out, /<div class="music-take music-take-discarded" data-music-take="1" data-music-discarded="1"><span class="music-take-label">Take 1 · Discarded<\/span><\/div>/);
    assert.equal((out.match(/<audio controls/g) || []).length, 1);
    assert.equal((out.match(/Approve to render this take in full/g) || []).length, 1);
    assert.equal((out.match(/class="approval-actions"/g) || []).length, 1);
    assert.doesNotMatch(out, /aaaaaaaa-bbbb/, 'the declined take has no approval');
    assert.match(out, /data-music-take="2"[\s\S]*resolveApproval\('ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'approve'/);
    // A discarded take never shows a player, even if a link were sent.
    assert.doesNotMatch(page().musicCardHtml({ id: ID, title: 'x', status: 'awaiting_choice', previews: [{ variant: 1, discarded: true, url: url('t.mp3'), token: T1 }] }), /<audio|approval-actions|Approve to render/);
  });

  test('take lengths are the stored file\'s measured length, as a player shows it (61.9 s is 1:01, not 1:02)', () => {
    const p = page();
    assert.equal(p.musicSeconds(61.9), '1:01');
    assert.equal(p.musicSeconds(61.0), '1:01');
    assert.equal(p.musicSeconds(30.5), '0:30');
    assert.equal(p.musicSeconds(0.4), '');
    assert.equal(p.musicSeconds(null), '');
    const out = p.musicCardHtml({ id: ID, title: 'Neon Drive', status: 'awaiting_choice', previews: [{ variant: 1, url: url('1.mp3'), durationS: 62.04, token: T1 }, { variant: 2, url: url('2.mp3'), durationS: 61.9, token: T2 }] });
    assert.match(out, /Take 1 · 1:02/);
    assert.match(out, /Take 2 · 1:01/);
  });

  test('the status text has no leading " · " when nothing comes before it', () => {
    const p = page();
    const noTitle = p.musicCardHtml({ id: ID, title: '', status: 'awaiting_choice', label: 'Previews ready: approve the take to finish' });
    assert.match(noTitle, /<div class="music-card-head"><span class="video-job-engine">PG1 Sound<\/span><span class="film-card-status">Previews ready: approve the take to finish<\/span><\/div>/);
    assert.doesNotMatch(noTitle, />\s*·/, 'no text item starts with the separator');
    const titled = p.musicCardHtml({ id: ID, title: 'Neon Drive', status: 'done', label: 'Track ready' });
    assert.match(titled, /<span class="music-card-title">Neon Drive<\/span><span class="music-card-sep" aria-hidden="true">·<\/span><span class="film-card-status">Track ready<\/span>/);
    const noStatus = p.musicCardHtml({ id: ID, title: 'Neon Drive' });
    assert.doesNotMatch(noStatus, /music-card-sep/, 'no separator after the last item');
    // The library: only items that are there, joined.
    const lib = p.musicLibraryHtml([{ id: ID, shortId: ID.slice(0, 8), title: 'Neon Drive', label: '', durationS: 30 }]);
    assert.match(lib, /<span class="music-card-meta">\(11111111\) · 0:30<\/span>/);
    assert.doesNotMatch(lib, /· ·|>\s*·/);
  });

  test('the library: a track awaiting its choice lists its takes, a declined one as discarded', () => {
    const out = page().musicLibraryHtml([{
      id: ID, shortId: ID.slice(0, 8), title: 'Neon Drive', label: 'Previews ready: approve the take to finish',
      previews: [{ variant: 1, discarded: true }, { variant: 2, url: url('take2.mp3'), durationS: 30, token: T2 }]
    }]);
    assert.match(out, /Take 1 · Discarded/);
    assert.equal((out.match(/<audio controls/g) || []).length, 1);
    assert.equal((out.match(/Approve to render this take in full/g) || []).length, 1);
    assert.match(out, /resolveApproval\('ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'approve'/);
    assert.doesNotMatch(out, BRANDS_RE);
  });

  const DOWNLOADS = [
    { part: 'master', label: 'Master (FLAC)', url: url('master.flac') }, { part: 'drums', label: 'Drums stem (FLAC)', url: url('drums.flac') },
    { part: 'bass', label: 'Bass stem (FLAC)', url: url('bass.flac') }, { part: 'vocals', label: 'Vocals stem (FLAC)', url: url('vocals.flac') },
    { part: 'other', label: 'Other stem (FLAC)', url: url('other.flac') }, { part: 'midi', label: 'MIDI: bass', url: url('bass.mid') },
    { part: 'readme', label: 'README', url: url('README.md') }
  ];

  test('a finished track: the player, the download list (master, each stem, MIDI, README) and "Download all (zip)"; a busy one: the progress and the poll flag', () => {
    const p = page();
    const done = p.musicCardHtml({
      id: ID, title: 'Neon Drive', status: 'done', label: 'Track ready', active: false, masterUrl: url('master.mp3'), masterDownloadUrl: `${url('master.mp3')}&download=Neon_Drive.mp3`,
      downloads: DOWNLOADS, zipUrl: `${url('stems.zip')}&download=Neon_Drive_stems.zip`, durationS: 151, bpm: 103.9, key: 'F# minor', spentUsd: 0.24, capUsd: 2
    });
    assert.equal((done.match(/<audio controls/g) || []).length, 1);
    assert.match(done, /Download the track/);
    assert.match(done, /<a class="music-download-all" href="[^"]+stems\.zip[^"]*" download>Download all \(zip\)<\/a>/);
    const labels = [...done.matchAll(/data-music-part="([a-z]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(labels, DOWNLOADS.map((d) => [d.part, d.label]));
    assert.match(done, /2:31 · 104 BPM · F# minor/);
    assert.match(done, /data-music-active="0"/);
    assert.doesNotMatch(done, BRANDS_RE);
    // No zip (over the storage limit): the separate files only.
    const noZip = p.musicCardHtml({ id: ID, title: 'Neon Drive', status: 'done', masterUrl: url('master.mp3'), downloads: DOWNLOADS });
    assert.doesNotMatch(noZip, /Download all/);
    assert.equal((noZip.match(/data-music-part=/g) || []).length, DOWNLOADS.length);
    const busy = p.musicCardHtml({ id: ID, title: 'Neon Drive', status: 'exporting', label: 'Exporting stems, MIDI and WAV…', active: true, progress: { label: 'Separating stems', done: 0, total: 1 } });
    assert.match(busy, /data-music-active="1"/);
    assert.match(busy, /role="status"/);
    assert.doesNotMatch(busy, /music-downloads/);
    assert.equal(p.musicCardHtml({ id: 'not-an-id' }), '');
    // Only https links ever reach a player or a download.
    assert.doesNotMatch(p.musicCardHtml({ id: ID, status: 'done', masterUrl: 'javascript:alert(1)', downloads: [{ part: 'master', label: 'Master (FLAC)', url: 'javascript:alert(1)' }], zipUrl: 'http://x/y.zip' }), /<audio|<a /);
  });

  test('the library: one player per stored track, its downloads when exported', () => {
    const out = page().musicLibraryHtml([
      { id: ID, shortId: ID.slice(0, 8), title: 'Neon Drive', label: 'Track ready', url: url('a.mp3'), downloads: DOWNLOADS, zipUrl: url('a.zip'), durationS: 30, bpm: 104, key: 'F# minor' },
      { id: '22222222-2222-4333-8444-555555555555', shortId: '22222222', title: 'Rain <b>', label: 'Making two previews…', url: null }
    ]);
    assert.equal((out.match(/<li class="music-library-item"/g) || []).length, 2);
    assert.equal((out.match(/<audio controls/g) || []).length, 1);
    assert.match(out, /Download all \(zip\)/);
    assert.equal((out.match(/data-music-part=/g) || []).length, DOWNLOADS.length);
    assert.match(out, /Rain &lt;b&gt;/);
    assert.doesNotMatch(out, BRANDS_RE);
  });

  test('the page source names no music provider', () => {
    assert.doesNotMatch(html, /lyria|eleven\s*labs|elevenlabs|demucs|basic-pitch|synthid/i);
  });
});
