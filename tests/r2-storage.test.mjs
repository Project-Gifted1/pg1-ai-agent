// Large film files on Cloudflare R2 (lib/storage/r2.mjs): AWS SigV4 signing
// checked against AWS's own published examples, and the film store sending
// clips, masters, the 9:16 cut and stems to bucket pg1-storage while stills,
// frames and voice lines stay in Supabase Storage.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { presign, signedHeaders, r2Config, createR2, encodeKey, R2_DEFAULT_BUCKET } from '../lib/storage/r2.mjs';
import { createFilmStore, filmPath, isLargeFilePath, LARGE_FILE_KINDS } from '../lib/film/store.mjs';

const AWS = { host: 'examplebucket.s3.amazonaws.com', region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', now: Date.parse('2013-05-24T00:00:00Z') };
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const R2_ENV = { R2_ACCOUNT_ID: ACCOUNT, R2_ACCESS_KEY_ID: 'r2-access-key-id', R2_SECRET_ACCESS_KEY: 'r2-secret-access-key' };
const PROJECT = '11111111-2222-3333-4444-555555555555';

describe('SigV4, against AWS\'s published examples', () => {
  test('a presigned GET (AWS S3 docs: query string authentication)', () => {
    const url = presign({ ...AWS, method: 'GET', path: '/test.txt', expiresIn: 86400 });
    assert.equal(url.split('X-Amz-Signature=')[1], 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
    assert.match(url, /^https:\/\/examplebucket\.s3\.amazonaws\.com\/test\.txt\?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=/);
  });

  test('a header-signed GET (AWS S3 docs: GET object with a Range header)', () => {
    const h = signedHeaders({ ...AWS, method: 'GET', path: '/test.txt', extra: { Range: 'bytes=0-9' } });
    assert.equal(h.Authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    assert.equal(h['x-amz-content-sha256'], 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('keys are RFC 3986 encoded, slashes kept', () => {
    assert.equal(encodeKey("films/a b/clip/it's (1).mp4"), 'films/a%20b/clip/it%27s%20%281%29.mp4');
  });
});

describe('R2 settings', () => {
  test('needs the account id, access key id and secret; the bucket defaults to pg1-storage', () => {
    assert.equal(r2Config({}), null);
    assert.equal(r2Config({ ...R2_ENV, R2_ACCOUNT_ID: 'not-an-account' }), null);
    assert.equal(r2Config({ ...R2_ENV, R2_SECRET_ACCESS_KEY: '' }), null);
    const c = r2Config(R2_ENV);
    assert.equal(c.bucket, R2_DEFAULT_BUCKET);
    assert.equal(R2_DEFAULT_BUCKET, 'pg1-storage');
    assert.equal(c.host, `${ACCOUNT}.r2.cloudflarestorage.com`);
    assert.equal(c.region, 'auto');
    assert.equal(r2Config({ ...R2_ENV, R2_BUCKET: 'other' }).bucket, 'other');
  });

  test('which files are large: clips, masters, the 9:16 cut and stems', () => {
    assert.deepEqual([...LARGE_FILE_KINDS], ['clip', 'preview', 'final', 'social', 'stems']);
    for (const k of ['clip', 'preview', 'final', 'social', 'stems']) assert.equal(isLargeFilePath(filmPath(PROJECT, k, 'x.mp4')), true, k);
    for (const k of ['keyframe', 'reference', 'frames', 'thumbs', 'posters', 'voice', 'music', 'sfx', 'dialogue', 'notes', 'attachments']) assert.equal(isLargeFilePath(filmPath(PROJECT, k, 'x')), false, k);
  });
});

describe('the film store with R2', () => {
  function fakeServices() {
    const r2 = new Map();
    const vault = new Map();
    const calls = [];
    const fetchImpl = async (url, o = {}) => {
      const u = String(url);
      calls.push({ url: u, method: o.method || 'GET', headers: o.headers || {} });
      if (u.startsWith(`https://${ACCOUNT}.r2.cloudflarestorage.com/pg1-storage/`)) {
        const key = decodeURIComponent(new URL(u).pathname.slice('/pg1-storage/'.length));
        if (o.method === 'PUT') { r2.set(key, Buffer.from(o.body)); return new Response('', { status: 200 }); }
        return r2.has(key) ? new Response(r2.get(key), { status: 200 }) : new Response('NoSuchKey', { status: 404 });
      }
      if (u.includes('/storage/v1/object/sign/pg1-vault/')) return new Response(JSON.stringify({ signedURL: `/object/sign/pg1-vault/${u.split('/pg1-vault/')[1]}?token=t` }), { status: 200 });
      if (u.includes('/storage/v1/object/pg1-vault/')) {
        const p = u.split('/storage/v1/object/pg1-vault/')[1];
        if (o.method === 'POST') { vault.set(p, Buffer.from(o.body)); return new Response('{}', { status: 200 }); }
        return vault.has(p) ? new Response(vault.get(p), { status: 200 }) : new Response('', { status: 404 });
      }
      throw new Error(`unexpected call ${u}`);
    };
    return { r2, vault, calls, fetchImpl };
  }

  test('large files go to pg1-storage on R2, signed; small ones stay in Supabase Storage', async () => {
    const svc = fakeServices();
    const store = createFilmStore({ supUrl: 'https://sup.example', supKey: 'k', fetchImpl: svc.fetchImpl, r2: r2Config(R2_ENV) });
    const clip = await store.upload(filmPath(PROJECT, 'clip', 's1-sh1.mp4'), Buffer.from('clip'), 'video/mp4');
    const master = await store.upload(filmPath(PROJECT, 'final', 'v1.mp4'), Buffer.from('master'), 'video/mp4');
    const social = await store.upload(filmPath(PROJECT, 'social', 'v1-9x16.mp4'), Buffer.from('social'), 'video/mp4');
    const stem = await store.upload(filmPath(PROJECT, 'stems', 'v1-voice.wav'), Buffer.from('stem'), 'audio/wav');
    const still = await store.upload(filmPath(PROJECT, 'keyframe', 's1-sh1.png'), Buffer.from('png'), 'image/png');
    for (const p of [clip, master, social, stem]) assert.match(p, /^r2:films\//);
    assert.equal(still, filmPath(PROJECT, 'keyframe', 's1-sh1.png'), 'a still stays in Supabase Storage');
    assert.deepEqual([...svc.r2.keys()].sort(), [filmPath(PROJECT, 'clip', 's1-sh1.mp4'), filmPath(PROJECT, 'final', 'v1.mp4'), filmPath(PROJECT, 'social', 'v1-9x16.mp4'), filmPath(PROJECT, 'stems', 'v1-voice.wav')].sort());
    assert.deepEqual([...svc.vault.keys()], [filmPath(PROJECT, 'keyframe', 's1-sh1.png')]);
    const put = svc.calls.find((c) => c.method === 'PUT');
    assert.match(put.headers.Authorization, new RegExp(`^AWS4-HMAC-SHA256 Credential=r2-access-key-id/\\d{8}/auto/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$`));
    assert.equal(put.headers['content-type'], 'video/mp4');
    // Read back and linked the same way the film card and the render do.
    assert.equal((await store.download(master)).toString(), 'master');
    assert.equal((await store.download(still)).toString(), 'png');
    const link = await store.sign(master);
    assert.match(link, new RegExp(`^https://${ACCOUNT}\\.r2\\.cloudflarestorage\\.com/pg1-storage/films/${PROJECT}/final/v1\\.mp4\\?X-Amz-Algorithm=AWS4-HMAC-SHA256&`));
    assert.match(link, /X-Amz-Expires=604800&/, 'the 7-day film link, the longest SigV4 allows');
    assert.match(await store.sign(still), /^https:\/\/sup\.example\/storage\/v1\/object\/sign\/pg1-vault\//);
    // The secret never appears in a request or a link.
    assert.ok(!JSON.stringify(svc.calls).includes('r2-secret-access-key'));
    assert.ok(!link.includes('r2-secret-access-key'));
  });

  test('without R2 settings every file stays in Supabase Storage, as before', async () => {
    const svc = fakeServices();
    const store = createFilmStore({ supUrl: 'https://sup.example', supKey: 'k', fetchImpl: svc.fetchImpl, r2: null });
    const p = await store.upload(filmPath(PROJECT, 'final', 'v1.mp4'), Buffer.from('m'), 'video/mp4');
    assert.equal(p, filmPath(PROJECT, 'final', 'v1.mp4'));
    assert.equal(svc.r2.size, 0);
    await assert.rejects(store.download('r2:films/x/final/v1.mp4'), /large-file storage is not configured/);
  });

  test('an R2 error is a clear storage error (no provider name in it)', async () => {
    const r2 = createR2({ config: r2Config(R2_ENV), fetchImpl: async () => new Response('denied', { status: 403 }) });
    await assert.rejects(r2.upload('films/x/final/v1.mp4', Buffer.from('m'), 'video/mp4'), (e) => /large-file storage upload failed: 403/.test(e.message) && !/cloudflare|r2/i.test(e.message));
  });
});
