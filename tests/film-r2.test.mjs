// Large film files go to Cloudflare R2 (lib/storage/r2.mjs) when it is
// configured; small ones stay in Supabase storage. The SigV4 signer is
// checked against AWS's published test vectors.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sigV4, r2Config, r2SignedUrl, R2_DEFAULT_BUCKET } from '../lib/storage/r2.mjs';
import { createFilmStore, filmPath, R2_KINDS } from '../lib/film/store.mjs';

const AWS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const AT = Date.UTC(2013, 4, 24);

test('SigV4 matches the AWS S3 examples (presigned URL and header auth)', () => {
  const q = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': 'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request', 'X-Amz-Date': '20130524T000000Z', 'X-Amz-Expires': '86400', 'X-Amz-SignedHeaders': 'host' };
  const host = 'examplebucket.s3.amazonaws.com';
  assert.equal(sigV4({ method: 'GET', host, path: '/test.txt', query: q, payloadHash: 'UNSIGNED-PAYLOAD', ...AWS, now: AT, region: 'us-east-1' }).signature,
    'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  assert.equal(sigV4({ method: 'GET', host, path: '/test.txt', headers: { range: 'bytes=0-9', 'x-amz-content-sha256': empty, 'x-amz-date': '20130524T000000Z' }, payloadHash: empty, ...AWS, now: AT, region: 'us-east-1' }).signature,
    'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

const ENV = { R2_ACCOUNT_ID: 'a'.repeat(32), R2_ACCESS_KEY_ID: 'kid', R2_SECRET_ACCESS_KEY: 'secret' };

test('R2 is on only with all three credentials; the bucket defaults to pg1-storage', () => {
  assert.equal(r2Config({}), null);
  assert.equal(r2Config({ ...ENV, R2_SECRET_ACCESS_KEY: '' }), null);
  assert.equal(r2Config({ ...ENV, R2_ACCOUNT_ID: 'not-an-id' }), null);
  assert.equal(r2Config(ENV).bucket, R2_DEFAULT_BUCKET);
  assert.equal(R2_DEFAULT_BUCKET, 'pg1-storage');
  assert.equal(r2Config({ ...ENV, R2_BUCKET: 'other-bucket' }).bucket, 'other-bucket');
  assert.equal(r2Config(ENV).host, `${'a'.repeat(32)}.r2.cloudflarestorage.com`);
  const url = new URL(r2SignedUrl(r2Config(ENV), 'films/x/final/v1.mp4', { expiresIn: 10 ** 9, now: AT }));
  assert.equal(url.pathname, '/pg1-storage/films/x/final/v1.mp4');
  assert.equal(url.searchParams.get('X-Amz-Expires'), String(7 * 24 * 3600), 'at most 7 days');
  assert.match(url.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
});

function recorder() {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {} });
    if (String(url).includes('/storage/v1/object/sign/')) return new Response(JSON.stringify({ signedURL: '/object/sign/x?token=t' }), { status: 200 });
    return new Response(Buffer.from('bytes'), { status: 200 });
  };
  return { calls, fetchImpl };
}

test('clips, masters, previews, the 9:16 cut and stems go to R2; stills, voice and music stay in Supabase', async () => {
  assert.deepEqual([...R2_KINDS], ['clip', 'final', 'preview', 'social', 'stems']);
  const { calls, fetchImpl } = recorder();
  const store = createFilmStore({ supUrl: 'https://sup.example', supKey: 'k', fetchImpl, env: ENV, now: () => AT });
  for (const kind of R2_KINDS) {
    const path = await store.upload(filmPath('p1', kind, 'f.mp4'), Buffer.from('x'), 'video/mp4');
    assert.equal(path, `r2:films/p1/${kind}/f.mp4`);
    const c = calls.at(-1);
    assert.equal(c.method, 'PUT');
    assert.equal(c.url, `https://${'a'.repeat(32)}.r2.cloudflarestorage.com/pg1-storage/films/p1/${kind}/f.mp4`);
    assert.match(c.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=kid\/20130524\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  }
  for (const kind of ['keyframe', 'reference', 'voice', 'music', 'frames', 'posters', 'thumbs', 'notes', 'sfx', 'dialogue', 'attachments']) {
    const path = await store.upload(filmPath('p1', kind, 'f.bin'), Buffer.from('x'), 'application/octet-stream');
    assert.equal(path, `films/p1/${kind}/f.bin`, kind);
    assert.ok(calls.at(-1).url.startsWith('https://sup.example/storage/v1/object/'), kind);
  }
  // Reads and links follow the row's path.
  assert.equal(String(await store.download('r2:films/p1/clip/f.mp4')), 'bytes');
  assert.ok(calls.at(-1).url.includes('.r2.cloudflarestorage.com/pg1-storage/films/p1/clip/f.mp4'));
  assert.match(await store.sign('r2:films/p1/final/f.mp4'), /^https:\/\/a+\.r2\.cloudflarestorage\.com\/pg1-storage\/films\/p1\/final\/f\.mp4\?.*X-Amz-Signature=/);
  assert.match(await store.sign('films/p1/keyframe/f.png'), /^https:\/\/sup\.example\/storage\/v1\//);
});

test('without R2 every file stays in Supabase; an r2: row then says R2 is not configured', async () => {
  const { calls, fetchImpl } = recorder();
  const store = createFilmStore({ supUrl: 'https://sup.example', supKey: 'k', fetchImpl, env: {} });
  assert.equal(await store.upload(filmPath('p1', 'final', 'f.mp4'), Buffer.from('x'), 'video/mp4'), 'films/p1/final/f.mp4');
  assert.ok(calls.at(-1).url.startsWith('https://sup.example/'));
  await assert.rejects(store.sign('r2:films/p1/final/f.mp4'), /R2\) is not configured/);
});
